# Implementation Plan: 自动视频剪辑 (Auto Video Compilation)

## Overview

实现视频处理管线完成分片分析后，自动基于质量评分选择最佳片段并使用 FFmpeg 拼接生成精选视频摘要。系统采用纯质量评分策略（`editPlanner.ts` 中的 `fallbackSelection`）进行片段选择，支持前端预览和手动调整后重新生成。实现包括后端服务（片段选择器、FFmpeg 编译器、编译引擎）、API 路由、数据库迁移和前端组件。

## Tasks

- [x] 1. 数据库迁移与基础设施
  - [x] 1.1 创建 compile_jobs 表迁移脚本
    - 在 `server/src/database.ts` 或迁移目录中添加 `compile_jobs` 表的 CREATE TABLE 语句
    - 包含字段: id, media_id, status, percent, segment_indices, target_duration, result_path, error_message, created_at, started_at, finished_at
    - 创建索引: idx_compile_jobs_media 和 idx_compile_jobs_active（唯一索引，限制同一 media_id 只能有一个活跃任务）
    - 确保 media_items 表已有 compiled_path 和 processing_error 字段（如无则添加）
    - _Requirements: 1.7, 7.1, 7.7, 8.3_

  - [x] 1.2 添加 VIDEO_MEMORY_LIMIT_MB 环境变量配置
    - 在 `.env` 文件中添加 `VIDEO_MEMORY_LIMIT_MB=4096`
    - 在服务端配置模块中读取该环境变量，提供默认值 4096
    - _Requirements: 2.5_

- [x] 2. 片段选择器 (Segment Selector)
  - [x] 2.1 实现 `server/src/services/segmentSelector.ts` 核心选择逻辑
    - 实现 `selectSegments(segments, targetDuration)` 函数
    - 排除 label 为 "severely_blurry"、"severely_shaky"、"severely_exposed" 的片段
    - 排除 overallScore < 30 的片段
    - 按 overallScore 降序贪心选择，累计时长达到 targetDuration 后停止（最后一个片段允许超出）
    - 实现邻近片段优先逻辑：分差 ≤ 10 且 startTime 间隔 ≤ 5s 时优先选择能形成连续区间的片段
    - 最终按 startTime 升序排列输出
    - _Requirements: 1.2, 1.3, 1.5, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 2.2 实现 `calculateTargetDuration` 和验证函数
    - 实现 `calculateTargetDuration(originalDuration)`: <60s → null, 60-600s → 60, >600s → 300
    - 实现 `validateTargetDuration(value)`: 验证 [10, 600] 范围内的正整数
    - 实现 `validateSegmentIndices(indices, maxIndex)`: 验证索引有效性，空数组或无效索引返回错误
    - _Requirements: 1.3, 1.4, 3.5, 3.6, 7.4, 7.5, 7.9, 7.10_

  - [ ]* 2.3 Property 1: 贪心评分选择与时长目标
    - **Property 1: 贪心评分选择与时长目标**
    - 使用 fast-check 验证：对任意有效片段集合和目标时长 T，选择器按 overallScore 降序贪心选择直到累计时长 ≥ T；可用片段总时长不足 T 时选择全部符合条件的片段
    - **Validates: Requirements 1.2, 1.3, 6.3, 6.6, 3.2**

  - [ ]* 2.4 Property 2: 严重低质量标签排除
    - **Property 2: 严重低质量标签排除**
    - 使用 fast-check 验证：选择结果中不包含任何 severely_blurry/severely_shaky/severely_exposed 标签的片段
    - **Validates: Requirements 1.5**

  - [ ]* 2.5 Property 3: 低评分排除
    - **Property 3: 低评分排除**
    - 使用 fast-check 验证：选择结果中不包含任何 overallScore < 30 的片段
    - **Validates: Requirements 6.2**

  - [ ]* 2.6 Property 4: 时间顺序输出
    - **Property 4: 时间顺序输出**
    - 使用 fast-check 验证：最终输出的片段列表按 startTime 升序排列
    - **Validates: Requirements 1.6, 6.4**

  - [ ]* 2.7 Property 5: 短视频保留
    - **Property 5: 短视频保留**
    - 使用 fast-check 验证：原始时长 < 60s 且所有片段均非严重低质量时，不应生成 Compiled_Video
    - **Validates: Requirements 1.4, 3.3**

  - [ ]* 2.8 Property 6: 目标时长参数验证
    - **Property 6: 目标时长参数验证**
    - 使用 fast-check 验证：targetDuration 仅在 [10, 600] 范围内的正整数时被接受
    - **Validates: Requirements 3.5, 3.6, 7.5, 7.10**

  - [ ]* 2.9 Property 7: 邻近片段优先
    - **Property 7: 邻近片段优先**
    - 使用 fast-check 验证：分差 ≤ 10 且 startTime 间隔 ≤ 5s 的片段优先选择能形成连续区间的
    - **Validates: Requirements 6.5**

  - [ ]* 2.10 Property 8: 片段索引验证
    - **Property 8: 片段索引验证**
    - 使用 fast-check 验证：segmentIndices 中所有索引在 [0, 片段总数-1] 范围内；空数组或无效索引返回错误
    - **Validates: Requirements 7.4, 7.9**

  - [ ]* 2.11 Property 11: 输出时长约束
    - **Property 11: 输出时长约束**
    - 使用 fast-check 验证：自动编译结果的输出总时长不超过 Target_Duration 加上最后一个被选中片段的时长
    - **Validates: Requirements 3.7, 6.3**

- [x] 3. FFmpeg 编译器 (FFmpeg Compiler)
  - [x] 3.1 实现 `server/src/services/ffmpegCompiler.ts`
    - 实现 `compileSegments(videoPath, segments, outputDir, options)` 函数
    - 使用 ffmpeg concat demuxer 或 filter_complex 拼接多个片段
    - 输出格式: MP4 容器 + H.264 视频 + AAC 音频
    - 分辨率限制: 不超过 1080p（1920×1080），不放大低于 1080p 的原始分辨率
    - 从 VIDEO_MEMORY_LIMIT_MB 环境变量读取内存限制
    - 实现 300 秒超时机制：超时后强制终止 ffmpeg 进程
    - 拼接前验证所有源片段文件存在且可读
    - 部分片段缺失时跳过缺失片段继续拼接（至少 1 个可用）
    - 全部缺失时返回错误不执行拼接
    - 空片段列表返回参数错误
    - 确保临时文件在任何情况下都被清理（使用 try/finally）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 8.1, 8.2, 8.4, 8.5, 8.6_

  - [ ]* 3.2 编写 FFmpeg 编译器单元测试
    - 测试空片段列表返回参数错误
    - 测试超时机制（mock ffmpeg 进程）
    - 测试部分片段缺失时的跳过逻辑
    - 测试全部片段缺失时的错误返回
    - 测试临时文件清理
    - _Requirements: 2.6, 2.8, 8.1, 8.2, 8.4, 8.5, 8.6_

- [x] 4. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，ask the user if questions arise.

- [x] 5. 编译引擎 (Compilation Engine)
  - [x] 5.1 实现 `server/src/services/compilationEngine.ts`
    - 实现 `CompilationEngine` 类，包含 `autoCompile`、`manualCompile`、`getJobStatus` 方法
    - `autoCompile`: 从 DB 读取 video_segments → 调用 segmentSelector → 调用 ffmpegCompiler → 更新 compiled_path
    - `manualCompile`: 按用户指定片段和顺序调用 ffmpegCompiler → 更新 compiled_path
    - 实现任务状态管理：创建 compile_jobs 记录，更新 status/percent/error_message
    - 实现错误处理：FFmpeg 失败时记录 processing_error（截断至 500 字符）
    - 实现重新生成逻辑：失败时保留原有 compiled_path 不变
    - 短视频逻辑：原始时长 < 60s 且无严重低质量片段时跳过编译
    - 无有效片段时设置 processing_error 为"无有效片段"
    - _Requirements: 1.1, 1.6, 1.7, 1.8, 1.9, 3.1, 3.2, 3.3, 3.4, 3.7, 5.5, 5.6, 5.7, 5.8, 5.9, 8.3_

  - [ ]* 5.2 Property 9: 最大选择数量限制
    - **Property 9: 最大选择数量限制**
    - 使用 fast-check 验证：用户片段选择操作中选中片段数量不超过 50 个
    - **Validates: Requirements 5.3**

  - [ ]* 5.3 Property 10: 错误信息截断
    - **Property 10: 错误信息截断**
    - 使用 fast-check 验证：写入 processing_error 字段的内容长度不超过 500 字符
    - **Validates: Requirements 8.3**

  - [ ]* 5.4 编写编译引擎集成测试
    - 测试 autoCompile 完整流程（mock ffmpeg）
    - 测试 manualCompile 按指定顺序拼接
    - 测试并发冲突检测
    - 测试重新生成失败时保留原文件
    - 测试短视频跳过逻辑
    - _Requirements: 1.1, 1.8, 3.3, 5.6, 5.8, 7.7_

- [x] 6. API 路由
  - [x] 6.1 实现 `server/src/routes/compile.ts` 路由
    - POST `/api/media/:mediaId/compile`: 启动剪辑任务，支持 segmentIndices 和 targetDuration 参数
    - GET `/api/media/:mediaId/compile/status`: 返回任务状态（queued/running/completed/failed）、进度百分比、错误信息
    - GET `/api/media/:mediaId/compile/download`: 以 MP4 文件流返回 Compiled_Video
    - 参数验证: mediaId 存在性、segments 数据可用性、targetDuration 范围、segmentIndices 有效性
    - 错误响应: 404（不存在）、409（并发冲突）、400（参数无效）
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

  - [x] 6.2 在 `server/src/routes/` 中注册 compile 路由
    - 在主路由文件中引入并挂载 compile 路由
    - _Requirements: 7.1_

  - [ ]* 6.3 编写 API 路由测试
    - 测试 POST /compile 正常启动任务
    - 测试 POST /compile 参数验证（无效 targetDuration、无效 segmentIndices）
    - 测试 GET /status 各状态返回
    - 测试 GET /download 文件流返回
    - 测试 404、409、400 错误场景
    - _Requirements: 7.1-7.10_

- [x] 7. Pipeline 集成
  - [x] 7.1 在视频处理管线完成后自动触发编译
    - 修改 `server/src/services/pipeline/runTripProcessingPipeline.ts` 或相关管线文件
    - 在视频分析完成（video_segments 写入 DB）后调用 `CompilationEngine.autoCompile`
    - 确保自动编译失败不影响管线整体结果（catch 错误并记录）
    - _Requirements: 1.1_

- [x] 8. Checkpoint - 确保后端所有测试通过
  - 确保所有测试通过，ask the user if questions arise.

- [x] 9. 前端组件
  - [x] 9.1 实现 `client/src/components/CompilationPreview.tsx`
    - 根据状态展示不同 UI：
      - 有 compiledPath → "剪辑预览"按钮，点击使用 VideoPlayer 播放
      - 无 compiledPath + 有 segments → "生成剪辑"按钮
      - 无 compiledPath + 无 segments → 不展示
      - 正在处理 → 进度指示器（百分比 + 状态文字）
      - 失败 → 错误提示 + "重试"按钮
    - 实现 2 秒轮询任务状态接口
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 9.2 实现片段调整模式 UI
    - 在 CompilationPreview 或独立组件中实现"重新生成"按钮
    - 展示所有 Segment 列表：时间范围、时长、质量评分、低质量标记
    - 支持勾选/取消勾选片段（最多 50 个）
    - 支持拖拽调整选中片段排列顺序
    - 提交时调用 POST /compile 接口（带 segmentIndices 参数）
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 9.3 集成 CompilationPreview 到视频详情页
    - 在现有视频详情页中引入 CompilationPreview 组件
    - 从媒体详情接口获取 compiledPath 和 segments 数据
    - _Requirements: 4.1, 4.2_

  - [ ]* 9.4 编写前端组件测试
    - 测试各状态下的条件渲染逻辑
    - 测试轮询机制
    - 测试片段选择和拖拽交互
    - _Requirements: 4.1-4.8, 5.1-5.5_

- [x] 10. Final checkpoint - 确保所有测试通过
  - 确保所有测试通过，ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- `editPlanner.ts` 中的 `fallbackSelection` 函数已存在，`segmentSelector.ts` 将复用其核心逻辑并增加排除规则和邻近优先逻辑
- FFmpeg 编译器使用 `fluent-ffmpeg` 库（项目已有依赖）或直接 spawn ffmpeg 进程
- 前端拖拽排序可使用 `@dnd-kit/core` 或类似库

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "3.2"] },
    { "id": 3, "tasks": ["5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3", "9.4"] }
  ]
}
```
