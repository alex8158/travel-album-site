# Implementation Plan: 视频处理增强 V3

## Overview

本实现计划将视频处理增强 V3 的设计分解为可执行的编码任务。核心实现路径为：内存管理基础设施 → 并发控制 → 流式处理 → 检测增强 → 多版本生成优化 → 管线集成。每个任务包含对应的 property-based test 以验证正确性属性。

## Tasks

- [x] 1. 基础设施：MemoryManager 实现
  - [x] 1.1 实现 MemoryManager 核心模块
    - 创建 `server/src/services/memoryManager.ts`
    - 实现 `MemoryManagerConfig` 接口和环境变量解析函数（含范围校验和默认值回退）
    - 实现 `getCurrentStatus()`、`getPressureLevel()`、`getRssMB()` 方法
    - 实现压力等级计算逻辑：normal / warning / critical 三级判定
    - 实现 5 秒防抖机制：级别切换需持续 5 秒确认
    - 实现 `startMonitoring()` / `stopMonitoring()` 生命周期管理（5 秒定时器）
    - 实现 `checkBetweenStages()` 阶段间阻塞等待（critical 时轮询等待最多 60 秒）
    - 实现降级参数方法：`getFrameSampleCount()`、`getMaxConcurrency()`
    - 实现 `shouldPauseTasks()` / `waitForRecovery()` 任务暂停/恢复
    - 实现 critical 超时后触发 `global.gc()` 和任务取消逻辑
    - 实现 `MemorySummary` 输出（峰值 RSS、各阶段平均 RSS、GC 触发次数、跳过视频列表）
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_

  - [ ]* 1.2 Property test: 内存压力等级计算正确性
    - **Property 1: 内存压力等级计算正确性**
    - 使用 `fc.float({min:0, max:100000})` 生成 RSS 值
    - 使用 `fc.record` 生成有效配置参数（memoryLimitMB, warningRatio, criticalRatio）
    - 验证计算结果严格匹配阈值规则
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5**

  - [ ]* 1.3 Property test: 环境变量配置解析健壮性
    - **Property 2: 环境变量配置解析健壮性**
    - 使用 `fc.string()` / `fc.float()` / `fc.integer()` 生成任意环境变量输入
    - 验证返回值始终在有效范围内，无效输入回退到默认值
    - **Validates: Requirements 1.6, 1.7, 1.8, 1.9**

  - [ ]* 1.4 Property test: 降级策略映射一致性
    - **Property 3: 降级策略映射一致性**
    - 使用 `fc.constantFrom('normal', 'warning', 'critical')` 生成压力等级
    - 验证各等级对应的帧采样数和最大并发数严格匹配策略表
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ]* 1.5 Property test: 内存压力等级防抖
    - **Property 14: 内存压力等级防抖**
    - 使用 `fc.array(fc.float())` 生成短时间 RSS 序列
    - 验证波动不足 5 秒时级别不切换
    - **Validates: Requirements 2.10**

- [x] 2. 基础设施：ConcurrencyController 实现
  - [x] 2.1 实现 ConcurrencyController 模块
    - 创建 `server/src/services/concurrencyController.ts`
    - 实现基于信号量的 `acquire()` / `release()` 方法
    - 实现 FIFO 等待队列（Promise 链式排队）
    - 实现 `setMaxConcurrency()` 动态调整并发上限
    - 实现 `getCurrentCount()` / `getQueueLength()` 状态查询
    - 环境变量 `VIDEO_MAX_CONCURRENT_SEGMENTS` 解析（默认 3，范围 1-16）
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 2.2 Property test: 信号量并发不变量
    - **Property 4: 信号量并发不变量**
    - 使用 `fc.integer({min:1, max:16})` 生成 maxConcurrency
    - 使用 `fc.integer({min:1, max:100})` 生成并发请求数
    - 验证任意时刻已获得信号量的任务数 ≤ maxConcurrency
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

  - [ ]* 2.3 Property test: 信号量 FIFO 顺序保证
    - **Property 5: 信号量 FIFO 顺序保证**
    - 使用 `fc.array(fc.nat())` 生成请求序列
    - 验证等待中的请求按提交顺序获得执行机会
    - **Validates: Requirements 2.5, 4.5**

- [x] 3. Checkpoint - 确保内存管理基础设施测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. 基础设施：StreamProcessor 实现
  - [x] 4.1 实现 StreamProcessor 模块
    - 创建 `server/src/services/streamProcessor.ts`
    - 实现 `transferToStorage()` 方法：createReadStream → pipeline → storage.save(stream)
    - 实现 300 秒超时机制（AbortController 或 setTimeout）
    - 实现传输成功后删除临时文件逻辑
    - 实现错误处理：stream 销毁、临时文件清理、错误包装
    - 实现 `verifyCleanup()` 方法：检查临时目录残留文件并强制清理
    - 实现文件不存在/不可读的前置检查
    - 实现删除失败时记录警告但仍返回成功的逻辑
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 5.5, 5.6, 5.7_

  - [ ]* 4.2 编写 StreamProcessor 单元测试
    - 测试正常流式传输和临时文件删除
    - 测试超时场景
    - 测试文件不存在的错误处理
    - 测试删除失败的警告日志
    - 测试 verifyCleanup 残留文件清理
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 5. 检测增强：BlackFrameDetector 近黑帧支持
  - [x] 5.1 增强 BlackFrameDetector 支持近黑帧检测
    - 修改 `server/src/services/blackFrameDetector.ts`
    - 扩展 `BlackFrameResult` 接口：新增 `nearBlackRatio`、`nearBlackFrameCount`、`isNearBlackSegment`、`nearBlackThresholdUsed` 字段
    - 扩展 `BlackFrameDetectionOptions` 接口：新增 `nearBlackThreshold`、`nearBlackRatioThreshold` 选项
    - 实现近黑帧判定逻辑：亮度 < nearBlackThreshold（默认 20）
    - 实现近黑帧片段标记：nearBlackRatio > nearBlackRatioThreshold（默认 0.9）
    - 实现优先级：纯黑帧判定优先于近黑帧判定
    - 添加环境变量解析：`VIDEO_NEAR_BLACK_THRESHOLD`、`VIDEO_NEAR_BLACK_RATIO`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 5.2 Property test: 近黑帧分类正确性
    - **Property 6: 近黑帧分类正确性**
    - 使用 `fc.array(fc.integer({min:0, max:255}))` 生成帧亮度值数组
    - 生成有效阈值参数（blackThreshold < nearBlackThreshold）
    - 验证 blackFrameRatio 和 nearBlackRatio 计算正确
    - 验证优先级：纯黑帧优先于近黑帧
    - 验证标记为近黑帧/纯黑帧的片段不出现在版本选择中
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.6**

- [x] 6. 检测增强：JunkClipDetector 镜头遮挡支持
  - [x] 6.1 增强 JunkClipDetector 支持镜头遮挡检测
    - 修改 `server/src/services/junkClipDetector.ts`
    - 扩展 `JunkReason` 类型：新增 `'lens_occlusion'`
    - 扩展 `JunkDetectionOptions` 接口：新增 `occlusionVarianceThreshold`、`occlusionEdgeThreshold`、`occlusionFrameRatio`
    - 实现 `detectLensOcclusion()` 函数：
      - 均匀采样 5 帧
      - 每帧缩放至 64x64 灰度图像
      - 计算颜色方差和边缘密度（Sobel 算子）
      - 方差 < 阈值 且 边缘密度 < 阈值 → 遮挡帧
      - 遮挡帧占比 > 70% → 标记为 lens_occlusion
    - 实现废片优先级排序：too_short > extreme_blur > ground_shot > lens_occlusion > accidental_touch
    - 添加环境变量解析：`VIDEO_OCCLUSION_VARIANCE_THRESHOLD`、`VIDEO_OCCLUSION_EDGE_THRESHOLD`
    - 实现帧提取失败时跳过该帧继续分析的容错逻辑
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 6.2 Property test: 废片分类优先级正确性
    - **Property 7: 废片分类优先级正确性**
    - 使用 `fc.record({duration, motionMagnitude, pitchAngle, hasAccidentalPattern, occlusionRatio})` 生成片段特征
    - 验证当多个条件同时满足时，返回优先级最高的 reason
    - 验证优先级顺序：too_short > extreme_blur > ground_shot > lens_occlusion > accidental_touch
    - **Validates: Requirements 7.1, 7.2, 7.6**

- [x] 7. Checkpoint - 确保检测增强模块测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. 音频归一化流式优化
  - [x] 8.1 优化 AudioNormalizer 为串行流式处理
    - 修改 `server/src/services/audioNormalizer.ts`
    - 重构 `normalizeSegments()` 为严格串行执行（逐个片段处理）
    - 确保任意时刻最多 1 个 ffmpeg 子进程运行
    - 实现 ffmpeg 子进程 RSS 监控（每 5 秒轮询，超 512MB 记录警告）
    - 确保子进程退出后关闭所有文件描述符
    - 确保不将音频文件内容读入 Node.js Buffer
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 8.2 编写 AudioNormalizer 单元测试
    - 测试串行执行保证（并发调用不会产生多个子进程）
    - 测试子进程 RSS 监控和警告日志
    - 测试文件描述符释放
    - _Requirements: 8.1, 8.2, 8.5, 8.6_

- [x] 9. 多版本生成器增强
  - [x] 9.1 实现 MultiVersionGenerator 版本选择策略
    - 修改 `server/src/services/multiVersionGenerator.ts`
    - 更新 `DEFAULT_PROFILES` 配置：highlight(30s) / summary(60s) / extended(300s)
    - 实现 `quality_first` 策略：按 overallScore 降序贪心选择
    - 实现 `balanced` 策略：时间线等分 3 段，每段至少 1 个片段
    - 实现 `comprehensive` 策略：所有 overallScore ≥ 30 的非废片/非黑帧片段
    - 实现版本跳过逻辑：源视频时长 < 目标时长时跳过
    - 实现时间顺序保持：选中片段按 startTime 非递减排序
    - 实现时长约束：输出时长在 [targetDuration × 0.8, targetDuration] 范围内
    - 添加环境变量解析：`VIDEO_HIGHLIGHT_DURATION`、`VIDEO_SUMMARY_DURATION`、`VIDEO_EXTENDED_DURATION`
    - 扩展 `VersionResult` 接口：新增 `status` 和 `skipReason` 字段
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [ ]* 9.2 Property test: Highlight 版本质量优先选择
    - **Property 8: Highlight 版本质量优先选择**
    - 使用 `fc.array(fc.record({score, duration, startTime}))` 生成片段列表
    - 验证选中片段的 overallScore ≥ 所有未选中片段的 overallScore
    - 验证累计时长 ≤ targetDuration × 1.1
    - **Validates: Requirements 9.3**

  - [ ]* 9.3 Property test: Summary 版本均衡选择
    - **Property 9: Summary 版本均衡选择**
    - 使用 `fc.array(fc.record({score, duration, startTime}))` 生成覆盖多时间区间的片段
    - 验证每个时间段至少贡献 1 个片段
    - 验证每段选择的是该段内 overallScore 最高的片段
    - **Validates: Requirements 9.4**

  - [ ]* 9.4 Property test: Extended 版本完整选择
    - **Property 10: Extended 版本完整选择**
    - 使用 `fc.array(fc.record({score, isJunk, isBlack}))` 生成片段列表
    - 验证结果等于所有 overallScore ≥ 30 的非废片/非黑帧片段集合
    - **Validates: Requirements 9.5**

  - [ ]* 9.5 Property test: 版本输出时间顺序保持
    - **Property 11: 版本输出时间顺序保持**
    - 复用 Property 8/9/10 的输出结果
    - 验证选中片段按 startTime 严格非递减排序
    - **Validates: Requirements 9.6**

  - [ ]* 9.6 Property test: 版本输出时长约束
    - **Property 12: 版本输出时长约束**
    - 使用 `fc.array(fc.record({duration}))` 生成充足片段
    - 验证输出时长在 [targetDuration × 0.8, targetDuration] 范围内
    - **Validates: Requirements 9.9**

  - [ ]* 9.7 Property test: 版本跳过逻辑
    - **Property 13: 版本跳过逻辑**
    - 使用 `fc.float({min:0})` 生成 sourceDuration 和 targetDuration
    - 验证 sourceDuration < targetDuration 时版本被跳过
    - **Validates: Requirements 9.2**

- [x] 10. Checkpoint - 确保多版本生成器测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. 多版本生成内存优化
  - [x] 11.1 实现 MultiVersionGenerator 串行生成与内存保护
    - 修改 `server/src/services/multiVersionGenerator.ts`
    - 重构 `generateVersions()` 为串行生成（highlight → summary → extended）
    - 集成 MemoryManager：每版本开始前检查 Memory_Pressure_Level
    - 实现 critical 时等待最多 60 秒恢复逻辑
    - 实现超时后跳过当前版本（status: 'skipped'，记录原因）
    - 集成 StreamProcessor：替代 fs.readFileSync + storage.save
    - 实现片段文件复用：避免重复提取相同片段
    - 实现版本失败时清理临时文件后继续下一版本
    - 实现所有版本完成后删除共享临时片段文件
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [ ]* 11.2 编写多版本生成内存优化集成测试
    - 测试串行生成顺序
    - 测试 critical 时暂停等待和超时跳过
    - 测试临时文件清理（成功和失败场景）
    - 测试片段文件复用
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.8_

- [ ] 12. 帧提取内存优化
  - [ ] 12.1 优化 VideoAnalyzer 帧提取内存管理
    - 修改 `server/src/services/videoAnalyzer.ts`
    - 重构为逐帧顺序提取、分析、释放模式
    - 确保任意时刻内存中最多保留 1 帧像素数据（稳定性比较时最多 2 帧）
    - 在获取 sharp 分析结果后立即将 Buffer 引用置为不可达
    - 单帧分析完成后立即删除临时文件
    - 稳定性估计完成后将两帧 Buffer 引用置为不可达
    - 像素级计算统一缩放至 64x64 灰度
    - 集成 ConcurrencyController：限制并发帧提取
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 12.2 编写帧提取内存优化单元测试
    - 测试逐帧处理模式（验证不并行提取）
    - 测试临时文件即时清理
    - 测试 Buffer 引用释放（通过 mock 验证）
    - 测试帧删除失败的容错
    - _Requirements: 11.1, 11.3, 11.6_

- [ ] 13. 处理管线整体集成
  - [~] 13.1 集成内存保护到处理管线
    - 修改视频处理管线入口（集成 MemoryManager 生命周期）
    - 实现管线启动时注册内存监控定时器
    - 实现批量处理时同一时间只有一个视频进行完整管线
    - 实现 OOM 错误捕获和恢复（ENOMEM、allocation failed）
    - 实现阶段间 Memory_Pressure_Level 检查
    - 实现管线完成时输出 MemorySummary 日志
    - 实现视频跳过时记录标识、失败阶段和原因
    - 集成 ConcurrencyController 到 VideoAnalyzer、BlackFrameDetector、JunkClipDetector
    - 集成近黑帧排除到版本选择逻辑
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 5.1, 5.2, 5.3, 5.4_

  - [ ]* 13.2 编写管线集成测试
    - 测试完整管线的内存保护流程（使用小视频文件）
    - 测试 OOM 错误恢复和继续处理
    - 测试阶段间内存检查和等待
    - 测试 MemorySummary 输出内容
    - _Requirements: 12.1, 12.3, 12.5, 12.6_

- [~] 14. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design document
- Unit tests validate specific examples and edge cases
- 测试文件放置在 `server/src/services/__tests__/` 目录下
- Property test 文件命名格式：`{moduleName}.property.test.ts`
- 所有环境变量配置通过 `server/src/services/videoThresholds.ts` 统一管理

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.2", "2.3"] },
    { "id": 2, "tasks": ["4.1", "5.1", "6.1"] },
    { "id": 3, "tasks": ["4.2", "5.2", "6.2", "8.1"] },
    { "id": 4, "tasks": ["8.2", "9.1"] },
    { "id": 5, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6", "9.7"] },
    { "id": 6, "tasks": ["11.1", "12.1"] },
    { "id": 7, "tasks": ["11.2", "12.2"] },
    { "id": 8, "tasks": ["13.1"] },
    { "id": 9, "tasks": ["13.2"] }
  ]
}
```
