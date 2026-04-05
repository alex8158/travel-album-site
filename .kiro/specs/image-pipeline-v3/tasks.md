# Implementation Plan: 图片处理流水线 V3

## Overview

对现有图片处理流水线进行全面重构，按照设计文档中的新流水线顺序实现：原图保存 → 模糊检测（永久删除）→ 滑动窗口去重 → 图片分析 → 自适应修图 → AWS Rekognition 分类 → 缩略图生成 → 封面选择。涉及新增 ImageAnalyzer、ImageClassifier 服务，重构 BlurDetector、DedupEngine、ImageOptimizer，更新 ProgressReporter、process.ts 流水线编排，以及前端分类标签页。

## Tasks

- [x] 1. 数据库迁移：新增 media_items 字段
  - [x] 1.1 在 `server/src/database.ts` 的 `initTables` 中添加 migration，新增 `avg_brightness REAL`、`contrast_level REAL`、`color_cast_r REAL`、`color_cast_g REAL`、`color_cast_b REAL`、`noise_level REAL`、`category TEXT` 七个字段
    - 使用现有的 try/catch ALTER TABLE 模式保持幂等
    - _Requirements: 4.2, 6.8_
  - [x] 1.2 更新 `server/src/helpers/mediaItemRow.ts` 的 `MediaItemRow` 接口和 `rowToMediaItem` 函数，映射新增的七个字段
    - _Requirements: 4.2, 6.8_
  - [x] 1.3 更新 `server/src/types.ts` 的 `MediaItem` 接口，添加 `avgBrightness`、`contrastLevel`、`colorCastR`、`colorCastG`、`colorCastB`、`noiseLevel`、`category` 字段
    - _Requirements: 4.2, 6.8_

- [x] 2. 重构 BlurDetector：永久删除模糊图片
  - [x] 2.1 重构 `server/src/services/blurDetector.ts`
    - 移除 soft/hard 双阈值，改为单一阈值（默认 50）
    - 模糊图片不再 `status = 'trashed'`，改为先 `DELETE FROM media_items`，再 `storageProvider.delete()` 删除存储文件
    - 新增 `BlurDeleteLog` 接口和 `deleteLogs` 数组，记录每张被删除图片的 mediaId、filename、sharpnessScore、reason、deletedAt
    - 检测出错时标记为 suspect，以追加方式写入 `processing_error`（格式：`[blurDetect] 错误消息`）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [ ]* 2.2 Write property test for BlurDetector 分类与删除一致性
    - **Property 2: 模糊检测分类与删除一致性**
    - **Validates: Requirements 2.2, 2.5**
  - [ ]* 2.3 Write unit tests for BlurDetector
    - 测试单一阈值判定、永久删除行为（DB + 存储）、删除日志格式、suspect 错误处理、processing_error 追加格式
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. 重构 DedupEngine：滑动窗口去重
  - [x] 3.1 重构 `server/src/services/dedupEngine.ts`
    - 替换现有的 exemplar clustering 为滑动窗口算法
    - 按 `created_at` 排序获取存活图片，为每张计算 pHash
    - 每张图片仅与后续 windowSize（默认 10）张比较汉明距离
    - 汉明距离 ≤ hammingThreshold（默认 5）判定为重复
    - 保留规则：① 清晰度分数更高 ② 差值 < 10 则保留分辨率更高 ③ 保留序列靠前
    - 被淘汰图片永久删除：先 DELETE FROM media_items，再 storageProvider.delete()
    - 返回 `DedupResult`（kept、removed、removedCount）
    - 接受 `SlidingWindowDedupOptions`（windowSize、hammingThreshold）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
  - [ ]* 3.2 Write property test for 滑动窗口比较范围约束
    - **Property 3: 滑动窗口比较范围约束**
    - **Validates: Requirements 3.2**
  - [ ]* 3.3 Write property test for 去重保留优先级
    - **Property 4: 去重保留优先级**
    - **Validates: Requirements 3.3, 3.7**
  - [ ]* 3.4 Write unit tests for DedupEngine
    - 测试滑动窗口范围、汉明距离计算、保留优先级、空序列/单图片边界、永久删除行为
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 4. Checkpoint - 确保模糊检测和去重测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 新增 ImageAnalyzer 服务
  - [x] 5.1 创建 `server/src/services/imageAnalyzer.ts`
    - 实现 `analyzeImage(imagePath): Promise<ImageAnalysis>` 函数
    - 使用 `sharp.stats()` 计算 avgBrightness（RGB 通道均值的平均）、contrastLevel（标准差）、colorCastR/G/B（各通道均值与总均值的偏差）
    - 使用拉普拉斯方差比率方法计算 noiseLevel
    - 实现 `analyzeTrip(tripId): Promise<void>` 批量分析并写入 DB
    - 分析失败时以追加方式写入 processing_error（格式：`[analyze] 错误消息`）
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [ ]* 5.2 Write property test for 图片分析结果存储往返
    - **Property 5: 图片分析结果存储往返**
    - **Validates: Requirements 4.1, 4.2**
  - [ ]* 5.3 Write unit tests for ImageAnalyzer
    - 测试分析结果字段完整性、DB 存储、分析失败错误记录
    - _Requirements: 4.1, 4.2, 4.4_

- [x] 6. 重构 ImageOptimizer：自适应修图
  - [x] 6.1 重构 `server/src/services/imageOptimizer.ts`
    - 新增 `computeOptimizeParams(analysis: ImageAnalysis): OptimizeParams` 纯函数
    - 自适应规则：亮度 < 90 → gamma(1.1)，亮度 < 90 且对比度 < 40 → 额外 clahe(maxSlope:1.5)；亮度 > 170 → gamma(0.9)；亮度 90-170 → 跳过
    - 对比度 < 40 且亮度正常 → clahe(maxSlope:1.5)；对比度 > 80 → 轻微降低；40-80 → 跳过
    - 色偏偏差 ≥ 10 → tint 矫正；< 10 → 跳过
    - 噪点 ≥ 0.3 且 < 0.6 → median(3) + sharpen(sigma:0.3)；噪点 ≥ 0.6 → median(3) 无锐化；噪点 < 0.3 → sharpen(sigma:0.45)
    - 重构 `optimizeImage` 接受 `OptimizeParams` 参数，不再使用固定参数
    - 重构 `optimizeTrip` 先调用 ImageAnalyzer 获取分析结果，再生成参数并优化
    - 优化失败时以追加方式写入 processing_error（格式：`[optimize] 错误消息`），且该图跳过后续的分类和缩略图生成
    - 保持原始分辨率不变（不传 maxResolution）
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10_
  - [ ]* 6.2 Write property test for 自适应优化参数跳过规则
    - **Property 6: 自适应优化参数跳过规则**
    - **Validates: Requirements 5.1, 5.5, 5.6, 5.7, 5.8**
  - [ ]* 6.3 Write property test for 优化保持分辨率不变量
    - **Property 7: 优化保持分辨率不变量**
    - **Validates: Requirements 5.3**
  - [ ]* 6.4 Write unit tests for ImageOptimizer
    - 测试 computeOptimizeParams 各条件分支、跳过规则、输出路径格式、错误处理
    - _Requirements: 5.1, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10_

- [x] 7. Checkpoint - 确保分析和修图测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. 新增 ImageClassifier 服务
  - [x] 8.1 安装 `@aws-sdk/client-rekognition` 依赖
    - 在 server/package.json 中添加依赖
    - _Requirements: 6.1_
  - [x] 8.2 创建 `server/src/services/imageClassifier.ts`
    - 定义 `ImageCategory` 类型（'people' | 'animal' | 'landscape' | 'other'）
    - 定义 PEOPLE_LABELS、ANIMAL_LABELS、LANDSCAPE_LABELS 常量数组
    - 实现 `mapLabelsToCategory(labels: string[]): ClassifyResult` 纯函数，优先级 people > animal > landscape > other
    - 实现 `classifyImage(imageBuffer: Buffer): Promise<ClassifyResult>` 调用 Rekognition detectLabels API
    - 实现 `classifyTrip(tripId: string): Promise<void>` 批量分类
    - 分类前先删除该 media_id 下所有 `category:*` 和 `rekognition:*` 前缀的旧标签（delete-then-insert）
    - 将主分类写入 `media_items.category`，所有匹配分类写入 `media_tags`（`category:xxx` 格式），Rekognition 原始标签写入 `media_tags`（`rekognition:xxx` 格式）
    - API 失败时分类为 other，以追加方式写入 processing_error（格式：`[classify] 错误消息`）
    - 支持 ThrottlingException 指数退避重试（最多 3 次）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_
  - [ ]* 8.3 Write property test for 标签到分类映射优先级
    - **Property 8: 标签到分类映射优先级**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7**
  - [ ]* 8.4 Write property test for 分类结果存储一致性
    - **Property 9: 分类结果存储一致性**
    - **Validates: Requirements 6.8**
  - [ ]* 8.5 Write unit tests for ImageClassifier
    - 测试标签映射、优先级规则、API 失败降级为 other、delete-then-insert 去重、processing_error 追加格式
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

- [x] 9. 更新 ProgressReporter 步骤名
  - [x] 9.1 更新 `server/src/services/progressReporter.ts`
    - 将 StepName 改为 `'blurDetect' | 'dedup' | 'analyze' | 'optimize' | 'classify' | 'thumbnail' | 'videoAnalysis' | 'videoEdit' | 'cover'`
    - 更新 STEPS 数组和 TOTAL_STEPS 为 9
    - 移除旧的 'quality' 和 'imageOptimize' 步骤名
    - _Requirements: 8.3_

- [x] 10. 重构 process.ts 流水线编排
  - [x] 10.1 重构 `server/src/routes/process.ts` 的 POST 和 SSE 两个路由
    - 新流水线顺序：模糊检测 → 去重 → 图片分析 → 自动修图 → 自动分类 → 缩略图生成 → 视频处理 → 封面选择
    - 移除 qualitySelector 的 processTrip 调用，改用 ImageAnalyzer + ImageOptimizer + ImageClassifier
    - 模糊检测调用新的 detectBlurry（单阈值）
    - 去重调用新的滑动窗口 deduplicate
    - 优化失败的图片跳过 classify 和 thumbnail 步骤
    - processing_error 以追加方式写入，每条带步骤前缀
    - 更新 SSE 步骤名匹配新的 ProgressReporter StepName
    - 更新 ProcessResult 返回结构（blurryDeletedCount、dedupDeletedCount、analyzedCount、classifiedCount、categoryStats）
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 10.2 更新 `server/src/types.ts` 的 `ProcessResult` 接口
    - 新增 blurryDeletedCount、dedupDeletedCount、analyzedCount、classifiedCount、categoryStats 字段
    - 移除旧的 duplicateGroups、totalGroups、blurryCount、suspectCount、trashedDuplicateCount 字段
    - _Requirements: 8.5_

- [x] 11. Checkpoint - 确保流水线编排测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. 更新 Gallery API 支持 category 筛选
  - [x] 12.1 更新 `server/src/routes/gallery.ts`
    - 支持 `?category=landscape|animal|people|other` 查询参数
    - 当传入 category 时，在 SQL 查询中添加 `AND m.category = ?` 条件
    - 不传 category 时返回全部图片（现有行为不变）
    - _Requirements: 7.1, 7.3_

- [x] 13. 前端 GalleryPage 和 MyGalleryPage 添加分类标签页
  - [x] 13.1 更新 `client/src/pages/GalleryPage.tsx`
    - 新增分类标签页 UI：全部 | 风景 | 动物 | 人物 | 其他
    - 每个标签页标题旁显示该分类下的图片数量
    - 点击标签页筛选图片（前端本地过滤，基于 item.category 字段）
    - 默认选中"全部"标签页
    - 空分类显示空状态提示
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 13.2 更新 `client/src/pages/MyGalleryPage.tsx`
    - 同 GalleryPage 添加相同的分类标签页 UI
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 13.3 更新 `client/src/pages/GalleryPage.tsx` 的 `GalleryImageItem` 接口，添加 `category` 字段
    - _Requirements: 7.1_
  - [ ]* 13.4 Write property test for 分类筛选正确性
    - **Property 10: 分类筛选正确性**
    - **Validates: Requirements 7.2, 7.3**
  - [ ]* 13.5 Write unit tests for GalleryPage 分类标签页
    - 测试标签页渲染、筛选行为、数量显示、空状态、默认选中"全部"
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 14. 更新前端 ProcessTrigger/ProcessingLog 适配新 ProcessResult
  - [x] 14.1 更新 `client/src/components/ProcessTrigger.tsx` 和 `client/src/components/ProcessingLog.tsx`
    - 适配新的 ProcessResult 字段（blurryDeletedCount、dedupDeletedCount、analyzedCount、classifiedCount、categoryStats）
    - 更新 SSE 步骤名显示
    - _Requirements: 8.3, 8.5_

- [x] 15. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 永久删除顺序：先删 DB 记录，再删存储文件（设计文档决策）
- processing_error 采用追加模式，格式 `[步骤名] 错误消息`，多条用换行符分隔
- 优化失败的图片跳过后续的 classify + thumbnail 步骤
- media_tags 分类标签采用 delete-then-insert 策略，重跑不产生重复
- Property tests use `fast-check` library with minimum 100 iterations
