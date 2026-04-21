# 实现计划：智能视频剪辑

## 概述

基于现有 `videoAnalyzer.ts` 和 `videoEditor.ts` 增强实现智能视频剪辑功能。按照从阈值配置 → 分析增强 → 编辑增强 → 合并引擎 → API 路由 → 前端组件的顺序递进实现，每步构建在前一步基础上。

## Tasks

- [x] 1. 创建视频阈值配置文件 videoThresholds.ts
  - [x] 1.1 创建 `server/src/services/videoThresholds.ts`，定义 `VideoThresholds` 接口和 `VIDEO_THRESHOLDS` 冻结配置对象
    - 复用 `dedupThresholds.ts` 中的 `env()` helper 模式
    - 包含所有阈值字段：severeBlurThreshold、severeShakeThreshold、severeExposureLow/High、minSegmentDuration、shortVideoCutoff、mediumVideoCutoff、mediumTargetDuration、longTargetDuration、sceneDetectThreshold、defaultTransitionDuration、adjacencyGapThreshold、scoreProximityRatio、cutBufferDuration
    - 每个字段对应环境变量名和合理默认值
    - _需求：R10-AC1, R10-AC2, R10-AC3, R10-AC4, R10-AC5, R10-AC6, R10-AC7_

  - [ ]* 1.2 编写属性测试：阈值配置环境变量覆盖
    - **属性 11：阈值配置环境变量覆盖**
    - 使用 fast-check 生成随机有效数字字符串设置环境变量，验证 VIDEO_THRESHOLDS 对应字段值等于解析后的数值；未设置时等于默认值
    - **验证需求：R10-AC1, R10-AC2, R10-AC3, R10-AC4, R10-AC5, R10-AC6, R10-AC7**

- [x] 2. 增强 videoAnalyzer.ts：曝光评分与场景切点检测
  - [x] 2.1 在 `server/src/services/videoAnalyzer.ts` 中实现 `computeExposureScore` 函数
    - 使用 sharp 提取帧灰度直方图，计算平均亮度和标准差
    - 映射规则：亮度 [60,200] 且标准差 > 30 为理想曝光（100 分），过暗 (<30) 或过曝 (>230) 判定为严重曝光异常
    - 帧提取失败时默认返回 exposureScore=50
    - _需求：R2-AC1_

  - [x] 2.2 在 `server/src/services/videoAnalyzer.ts` 中实现 `detectSceneCuts` 函数
    - 使用 ffmpeg `select='gt(scene,THRESHOLD)'` 滤镜检测场景变化
    - 解析 ffmpeg 输出获取切点时间戳和变化强度
    - 阈值从 VIDEO_THRESHOLDS.sceneDetectThreshold 读取
    - 场景检测失败时回退到固定时长切分
    - _需求：R3-AC1, R3-AC2_

  - [x] 2.3 增强 `VideoSegment` 接口和 `analyzeVideo` 函数
    - VideoSegment 新增 exposureScore 字段和严重标签（severely_blurry、severely_shaky、severely_exposed）
    - analyzeVideo 中集成 computeExposureScore 和 detectSceneCuts
    - overallScore 重新计算：含曝光权重
    - 使用场景切点作为片段边界，保证切点前后有缓冲时间（cutBufferDuration）
    - _需求：R2-AC1, R3-AC1, R3-AC2, R3-AC5_

  - [x] 2.4 增强 `assignLabel` 函数，支持严重质量标签
    - 从 VIDEO_THRESHOLDS 读取阈值
    - sharpnessScore < severeBlurThreshold → "severely_blurry"
    - stabilityScore < severeShakeThreshold → "severely_shaky"
    - exposureScore < severeExposureLow 或 > severeExposureHigh → "severely_exposed"
    - 以上条件均不满足时保持现有逻辑
    - _需求：R2-AC2, R2-AC3, R2-AC4_

  - [ ]* 2.5 编写属性测试：质量标签分配正确性
    - **属性 4：质量标签分配正确性**
    - 使用 fast-check 生成随机 sharpnessScore、stabilityScore、exposureScore 组合，验证 assignLabel 输出符合阈值规则
    - **验证需求：R2-AC2, R2-AC3, R2-AC4**

  - [ ]* 2.6 编写单元测试：computeExposureScore 和 detectSceneCuts
    - computeExposureScore：全黑帧、全白帧、正常曝光帧的示例测试
    - detectSceneCuts：mock ffmpeg 输出的解析测试，场景检测失败回退测试
    - _需求：R2-AC1, R3-AC1_

- [x] 3. 增强 videoEditor.ts：时长分档、智能选择与过渡效果
  - [x] 3.1 更新 `calculateTargetDuration` 函数
    - 从 VIDEO_THRESHOLDS 读取分档边界和目标时长
    - < shortVideoCutoff → null
    - [shortVideoCutoff, mediumVideoCutoff] → mediumTargetDuration
    - > mediumVideoCutoff → longTargetDuration
    - _需求：R1-AC1, R1-AC3, R1-AC4_

  - [ ]* 3.2 编写属性测试：视频时长分档正确性
    - **属性 1：视频时长分档正确性**
    - 使用 fast-check 生成随机正数时长，验证 calculateTargetDuration 返回值符合分档规则
    - **验证需求：R1-AC1, R1-AC3, R1-AC4**

  - [x] 3.3 增强 `selectSegments` 函数
    - 排除 severely_blurry、severely_shaky、severely_exposed 标签的片段
    - 新增相邻片段优先逻辑：评分差距 ≤ scoreProximityRatio 且间隔 ≤ adjacencyGapThreshold 时优先选择
    - 保证每个片段 duration ≥ minSegmentDuration
    - 最终按 startTime 排序输出
    - _需求：R2-AC5, R3-AC3, R4-AC1, R4-AC2, R4-AC3, R4-AC4, R4-AC5, R4-AC6_

  - [ ]* 3.4 编写属性测试：selectSegments 核心不变量
    - **属性 2：短视频全片保留** — targetDuration 为 null 且全部 good 时输出等于输入
    - **属性 3：不填充不重复** — 有效片段不足时输出总时长等于有效片段总时长
    - **属性 5：严重低质量片段排除** — 输出不含任何严重标签片段
    - **属性 6：最小片段时长不变量** — 输出每个片段 duration ≥ minSegmentDuration
    - **属性 7：目标时长上限** — 输出累计时长不超过 targetDuration + 最后片段时长
    - **属性 8：时间顺序输出** — 输出按 startTime 严格递增
    - **属性 9：相邻片段优先选择** — 评分相近时优先选择相邻片段
    - **验证需求：R1-AC2, R1-AC5, R2-AC5, R3-AC3, R4-AC3, R4-AC4, R4-AC5, R4-AC6, R8-AC2**

  - [x] 3.5 增强 `EditOptions` 和 `EditResult` 接口，实现过渡效果
    - EditOptions 新增 transitionType 和 transitionDuration
    - EditResult 新增 segmentDetails 字段
    - 实现过渡效果 ffmpeg filter 构建：硬切（none）、淡入淡出（fade）、交叉淡化（crossfade）
    - 音频拼接处应用短时淡入淡出
    - 片段时长 < 2 × transitionDuration 时跳过过渡效果
    - _需求：R6-AC1, R6-AC2, R6-AC3, R6-AC4, R6-AC5, R6-AC6, R7-AC1, R7-AC2, R7-AC3_

  - [ ]* 3.6 编写属性测试：过渡效果跳过条件
    - **属性 10：过渡效果跳过条件**
    - 使用 fast-check 生成随机片段时长和过渡时长，验证 duration < 2 × transitionDuration 时返回空过渡
    - **验证需求：R6-AC6**

  - [x] 3.7 更新 `editVideo` 函数集成所有增强
    - 集成新的 calculateTargetDuration、selectSegments、过渡效果
    - 输出 MP4/H.264/AAC 格式，保持原始方向和帧率
    - 分辨率不放大，必要时压缩至 1080p
    - 支持无音频轨道视频
    - _需求：R7-AC1, R7-AC2, R7-AC3, R7-AC4, R7-AC5, R7-AC6, R8-AC1, R8-AC3, R8-AC4, R8-AC5_

- [x] 4. 检查点 — 确保后端核心逻辑测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 5. 创建数据库表和片段持久化
  - [x] 5.1 在 `server/src/database.ts` 的 `initTables` 中新增 `video_segments` 表
    - 包含 id、media_id、segment_index、start_time、end_time、duration、sharpness_score、stability_score、exposure_score、overall_score、label、selected、created_at 字段
    - 创建 (media_id, segment_index) 唯一索引
    - 创建 media_id 索引
    - _需求：R5-AC1, R8-AC6_

  - [x] 5.2 实现片段持久化逻辑
    - 在 videoAnalyzer 或 videoEditor 中分析完成后将片段写入 video_segments 表
    - 实现按 media_id 查询片段列表的函数
    - 实现更新片段 selected 状态的函数
    - _需求：R5-AC1_

- [x] 6. 创建合并引擎 mergeEngine.ts
  - [x] 6.1 创建 `server/src/services/mergeEngine.ts`，实现 `mergeSegments` 函数
    - 定义 MergeRequest 和 MergeResult 接口
    - 按用户指定顺序提取并拼接所选片段
    - 支持过渡效果（复用 videoEditor 中的过渡逻辑）
    - 合并后视频保存至 StorageProvider
    - 空片段列表返回参数错误
    - 错误时清理临时文件并返回错误描述
    - _需求：R5-AC5, R5-AC6, R5-AC7, R5-AC8_

  - [ ]* 6.2 编写单元测试：mergeSegments
    - 空列表边界测试、单片段测试、错误处理测试
    - _需求：R5-AC7, R5-AC8_

- [x] 7. 创建 API 路由 routes/clips.ts
  - [x] 7.1 创建 `server/src/routes/clips.ts`，实现三个端点
    - GET /api/media/:mediaId/segments — 返回视频片段列表
    - POST /api/media/:mediaId/clips — 触发智能剪辑流程
    - POST /api/media/:mediaId/merge — 合并导出指定片段
    - 参数校验：合并请求片段列表为空时返回 400
    - _需求：R5-AC4, R5-AC5, R5-AC6, R5-AC7_

  - [x] 7.2 在 `server/src/index.ts` 中注册 clips 路由
    - 引入并挂载 clips 路由到 Express app
    - _需求：R5-AC4_

  - [ ]* 7.3 编写 API 路由集成测试
    - 参数校验测试、权限检查测试、异步任务状态查询测试
    - _需求：R5-AC7, R8-AC1_

- [x] 8. 检查点 — 确保后端全部功能和 API 测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 9. 创建前端 ClipEditor 组件
  - [x] 9.1 创建 `client/src/components/ClipEditor.tsx`
    - 从 API 加载片段列表并展示时间线
    - 每个片段显示缩略图、时长、评分标签
    - 点击片段预览播放
    - 勾选/取消勾选片段
    - 拖拽调整顺序
    - 合并导出按钮（调用 merge API）
    - 合并进度展示
    - 架构上预留片段入点/出点微调的扩展能力
    - _需求：R5-AC1, R5-AC2, R5-AC3, R5-AC4, R5-AC9_

  - [x] 9.2 将 ClipEditor 集成到现有页面
    - 在视频详情页或 GalleryPage 中集成 ClipEditor 入口
    - _需求：R5-AC1_

  - [ ]* 9.3 编写前端组件测试
    - 使用 vitest + React Testing Library
    - 测试片段渲染、删除、拖拽排序、合并触发
    - _需求：R5-AC1, R5-AC2, R5-AC3, R5-AC4_

- [x] 10. 最终检查点 — 确保全部测试通过
  - 确保所有测试通过，如有疑问请询问用户。

## 备注

- 标记 `*` 的子任务为可选，可跳过以加快 MVP 交付
- 每个任务引用具体需求条款以确保可追溯性
- 检查点确保增量验证
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
- 所有阈值通过 VIDEO_THRESHOLDS 配置对象读取，支持环境变量覆盖
