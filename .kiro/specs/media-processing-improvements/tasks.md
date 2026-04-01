# 实施计划：媒体处理增强（media-processing-improvements）

## 概述

按照后端优先、前端跟进的顺序实施。先完成数据库迁移和类型更新，再逐步实现各处理服务，最后更新路由层和前端界面。每个任务增量构建，确保无孤立代码。

## 任务

- [x] 1. 数据库迁移与类型定义更新
  - [x] 1.1 在 `server/src/database.ts` 的 `initTables` 中添加 ALTER TABLE 迁移，为 media_items 表新增 5 个字段：`status`（默认 'active'）、`trashed_reason`、`processing_error`、`optimized_path`、`compiled_path`
    - 使用 try-catch 包裹每个 ALTER TABLE 语句以保证幂等性（与现有 visibility 迁移模式一致）
    - _需求: 1.1, 2.2, 4.4, 6.9, 8.2_

  - [x] 1.2 更新 `server/src/types.ts` 中的 `MediaItem` 接口，新增 `status`、`trashedReason`、`processingError`、`optimizedPath`、`compiledPath` 字段
    - 新增 `ProcessResult` 接口，包含 `blurryCount`、`trashedDuplicateCount`、`optimizedCount`、`compiledCount`、`failedCount` 字段
    - 新增 `ProcessOptions` 接口，包含 `blurThreshold` 和 `outputConfig` 字段
    - _需求: 1.1, 2.4, 3.4, 4.4, 6.9, 7.5, 8.3_

  - [x] 1.3 更新 `server/src/routes/gallery.ts` 中的 `MediaItemRow` 接口和 `rowToMediaItem` 函数，映射新增的 5 个字段
    - 更新所有查询 media_items 的 SQL，添加 `AND status = 'active'` 过滤条件
    - _需求: 1.3_

  - [x] 1.4 更新 `server/src/routes/process.ts` 中的 `MediaItemRow` 接口和 `rowToMediaItem` 函数，映射新增字段
    - _需求: 1.1_

  - [ ]* 1.5 编写单元测试验证数据库迁移的幂等性（多次执行不报错）和 gallery 查询过滤
    - _需求: 1.1, 1.3_

- [x] 2. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 3. 实现 blurDetector 模糊检测服务
  - [x] 3.1 创建 `server/src/services/blurDetector.ts`
    - 实现 `computeSharpness(imagePath: string): Promise<number>` 函数，提取自现有 `qualitySelector.ts` 中的 Laplacian 方差计算逻辑
    - 实现 `detectAndTrashBlurry(tripId: string, threshold?: number): Promise<{ blurryCount: number; results: BlurResult[] }>` 函数
    - 仅处理 `status = 'active'` 且 `media_type = 'image'` 的记录
    - 低于阈值的图片执行 `UPDATE media_items SET status = 'trashed', trashed_reason = 'blur'`
    - _需求: 2.1, 2.2, 2.3_

  - [ ]* 3.2 编写属性测试 `server/src/services/blurDetector.property.test.ts`
    - **Property 5: 模糊检测阈值决定淘汰**
    - **验证: 需求 2.1, 2.2**

  - [ ]* 3.3 编写属性测试验证模糊计数报告准确性
    - **Property 6: 模糊计数报告准确性**
    - **验证: 需求 2.4**

  - [ ]* 3.4 编写单元测试 `server/src/services/blurDetector.test.ts`
    - 测试 computeSharpness 对已知图片的分数
    - 测试阈值边界情况
    - 测试所有图片都模糊的情况
    - _需求: 2.1, 2.2, 2.3_

- [x] 4. 更新 dedupEngine/qualitySelector 实现重复淘汰
  - [x] 4.1 更新 `server/src/services/qualitySelector.ts` 的 `selectBest` 函数
    - 在选出最佳图片后，将其余图片的 status 设为 `trashed`，trashed_reason 设为 `duplicate`
    - `UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE id = ? AND id != ?`
    - _需求: 3.1, 3.2_

  - [ ]* 4.2 编写属性测试 `server/src/services/qualitySelector.property.test.ts`
    - **Property 7: 重复组最优保留不变量**
    - **验证: 需求 3.1, 3.2**

  - [ ]* 4.3 编写属性测试验证重复淘汰计数
    - **Property 8: 重复淘汰计数报告准确性**
    - **验证: 需求 3.4**

- [x] 5. 实现 imageOptimizer 图片优化服务
  - [x] 5.1 创建 `server/src/services/imageOptimizer.ts`
    - 实现 `optimizeImage(imagePath, tripId, mediaId, options?): Promise<string>` 函数
    - 优化链：`sharp(input).normalize().modulate({ brightness: 1.0 }).sharpen({ sigma: 1.0 }).toFile(output)`
    - 输出路径：`uploads/{tripId}/optimized/{mediaId}_opt.{ext}`
    - 支持 `maxResolution` 和 `jpegQuality` 配置
    - 实现 `optimizeTrip(tripId, options?): Promise<OptimizeResult[]>` 函数，批量优化所有 active 图片
    - 失败时记录 `processing_error`，不影响其他图片
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.6, 7.2, 7.4_

  - [ ]* 5.2 编写属性测试 `server/src/services/imageOptimizer.property.test.ts`
    - **Property 9: 图片优化保留原始并创建新文件**
    - **验证: 需求 4.3, 4.4**

  - [ ]* 5.3 编写单元测试 `server/src/services/imageOptimizer.test.ts`
    - 测试优化输出文件存在性、原始文件保留、失败回退
    - _需求: 4.1, 4.3, 4.6_

- [x] 6. 实现 videoAnalyzer 视频分析服务
  - [x] 6.1 创建 `server/src/services/videoAnalyzer.ts`
    - 实现 `analyzeVideo(videoPath, mediaId, segmentDuration?): Promise<VideoAnalysisResult>` 函数
    - 按 segmentDuration（默认 2 秒）等分视频为片段
    - 对每个片段中间帧用 ffmpeg 抽帧，再用 sharp 计算 Laplacian 方差作为清晰度分数
    - 使用 `ffmpeg -vf "mestimate=epzs"` 提取运动向量计算稳定性分数
    - 综合评分：`sharpnessScore * 0.6 + stabilityScore * 0.4`
    - 标签判定：blurry / shaky / slightly_shaky / good
    - _需求: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 6.2 编写属性测试 `server/src/services/videoAnalyzer.property.test.ts`
    - **Property 11: 视频片段评分不变量**
    - **验证: 需求 5.2, 5.3, 5.7**

  - [ ]* 6.3 编写属性测试验证标签判定
    - **Property 12: 视频片段标签由阈值决定**
    - **验证: 需求 5.4, 5.5, 5.6**

  - [ ]* 6.4 编写单元测试 `server/src/services/videoAnalyzer.test.ts`
    - 测试片段分割数量、评分计算、标签判定
    - _需求: 5.1, 5.2, 5.7_

- [x] 7. 实现 videoEditor 视频剪辑服务
  - [x] 7.1 创建 `server/src/services/videoEditor.ts`
    - 实现 `editVideo(videoPath, analysis, tripId, mediaId, options?): Promise<EditResult>` 函数
    - 目标时长计算：≤60s 不剪辑仅剔除坏片段，60s-600s 目标 120s，≥600s 目标 300s
    - 按 overallScore 降序选取片段，跳过 blurry 和 shaky 片段
    - slightly_shaky 片段使用 vidstab 两遍防抖
    - 使用 ffmpeg concat demuxer 拼接片段
    - 输出路径：`uploads/{tripId}/compiled/{mediaId}_compiled.mp4`
    - _需求: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 7.3_

  - [ ]* 7.2 编写属性测试 `server/src/services/videoEditor.property.test.ts`
    - **Property 13: 视频目标时长由原始时长决定**
    - **验证: 需求 6.1, 6.2, 6.3**

  - [ ]* 7.3 编写属性测试验证片段选取
    - **Property 14: 视频片段选取不变量**
    - **验证: 需求 6.4, 6.5**

  - [ ]* 7.4 编写单元测试 `server/src/services/videoEditor.test.ts`
    - 测试目标时长计算、片段选取逻辑、concat 文件生成
    - _需求: 6.1, 6.4, 6.8_

- [x] 8. 更新 progressReporter 支持新步骤
  - [x] 8.1 更新 `server/src/services/progressReporter.ts`
    - 扩展 `StepName` 类型为 9 个步骤：`dedup | quality | blurDetect | trashDuplicates | imageOptimize | thumbnail | videoAnalysis | videoEdit | cover`
    - 更新 `STEPS` 数组和 `TOTAL_STEPS` 为 9
    - 更新 `CompleteEvent` 接口，新增 `blurryCount`、`trashedDuplicateCount`、`optimizedCount`、`compiledCount`、`failedCount` 字段
    - _需求: 2.4, 3.4, 8.3_

  - [ ]* 8.2 更新 `server/src/services/progressReporter.test.ts` 验证新步骤名称和进度百分比计算
    - _需求: 2.4_

- [x] 9. 更新 process.ts 流水线集成所有新步骤
  - [x] 9.1 更新 `server/src/routes/process.ts` 的 SSE 流式处理端点
    - 接受可选的 `blurThreshold` 和 `outputConfig` 查询参数
    - 按 9 步顺序执行：dedup → quality → blurDetect → trashDuplicates → imageOptimize → thumbnail → videoAnalysis → videoEdit → cover
    - 每步完成后发送进度事件
    - 在 trashDuplicates 步骤中，对重复组中非最优图片设置 `status = 'trashed'`
    - 汇总 blurryCount、trashedDuplicateCount、optimizedCount、compiledCount、failedCount 到 CompleteEvent
    - 每个文件的处理步骤包裹在 try-catch 中，失败时记录 processing_error 并继续
    - _需求: 1.2, 2.4, 3.4, 7.5, 8.1, 8.2, 8.3_

  - [ ]* 9.2 编写属性测试 `server/src/routes/process.property.test.ts`
    - **Property 17: 错误隔离与报告**
    - **验证: 需求 8.1, 8.2, 8.3**

- [x] 10. 检查点 - 后端服务集成验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 11. 实现待删除区 API 路由
  - [x] 11.1 创建 `server/src/routes/trash.ts`
    - `GET /api/trips/:id/trash`：返回该旅行中所有 `status = 'trashed'` 的媒体文件列表
    - `DELETE /api/trips/:id/trash`：批量永久删除所有 trashed 文件（更新 status 为 deleted，物理删除原始文件、缩略图、优化文件）
    - `PUT /api/media/:id/restore`：将单个文件从 trashed 恢复为 active（清除 trashed_reason）
    - `DELETE /api/media/:id`：永久删除单个 trashed 文件
    - 使用现有 AppError 模式处理错误（非 trashed 状态的文件操作返回 400）
    - _需求: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x] 11.2 在 `server/src/index.ts` 中注册 trash 路由
    - _需求: 1.6_

  - [ ]* 11.3 编写属性测试 `server/src/routes/trash.property.test.ts`
    - **Property 1: 状态字段不变量**
    - **验证: 需求 1.1, 1.2**

  - [ ]* 11.4 编写属性测试验证查询过滤
    - **Property 2: 基于状态的查询过滤**
    - **验证: 需求 1.3, 1.6**

  - [ ]* 11.5 编写属性测试验证恢复往返
    - **Property 3: 待删除区恢复往返**
    - **验证: 需求 1.5, 1.8**

  - [ ]* 11.6 编写属性测试验证永久删除
    - **Property 4: 永久删除移除文件**
    - **验证: 需求 1.4, 1.7, 1.9**

  - [ ]* 11.7 编写单元测试 `server/src/routes/trash.test.ts`
    - 测试各 API 端点的 CRUD 操作、状态转换、错误响应
    - _需求: 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

- [x] 12. 更新 mediaServing 支持优化版本和成片
  - [x] 12.1 更新 `server/src/routes/mediaServing.ts`
    - `GET /api/media/:id/original`：如果 `optimized_path` 存在且文件有效，返回优化版本；否则返回原始文件
    - 新增 `GET /api/media/:id/raw`：始终返回原始文件
    - 视频：如果 `compiled_path` 存在，默认返回成片；提供 `?original=true` 参数访问原始视频
    - _需求: 4.5, 6.10_

  - [ ]* 12.2 编写属性测试 `server/src/routes/mediaServing.property.test.ts`
    - **Property 10: 媒体服务优先返回处理后版本**
    - **验证: 需求 4.5, 6.10**

  - [ ]* 12.3 更新 `server/src/routes/mediaServing.test.ts` 单元测试
    - 测试优化版本优先返回、原始版本回退、raw 端点
    - _需求: 4.5, 6.10_

- [x] 13. 检查点 - 后端全部完成验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 14. 更新前端类型和组件
  - [x] 14.1 更新 `client/src/components/ProcessTrigger.tsx` 中的 `ProcessResult` 接口
    - 新增 `blurryCount`、`trashedDuplicateCount`、`optimizedCount`、`compiledCount`、`failedCount` 字段
    - 更新 `totalSteps` 默认值为 9
    - _需求: 2.4, 3.4, 8.3_

  - [x] 14.2 更新 `client/src/components/ProcessingLog.tsx`
    - 展示模糊图片数量、重复淘汰数量、优化成功数量、成片数量、失败数量
    - _需求: 2.4, 3.4, 8.3_

  - [x] 14.3 更新 `client/src/pages/GalleryPage.tsx` 中的 `GalleryImageItem` 接口
    - 新增 `status`、`trashedReason`、`processingError` 字段
    - 视频播放器 URL 更新：默认使用 `/api/media/${id}/original`（后端已处理优先返回成片逻辑）
    - _需求: 1.1, 8.4_

- [x] 15. 实现前端待删除区 UI
  - [x] 15.1 在 `client/src/pages/GalleryPage.tsx` 中添加待删除区板块
    - 在图片和视频区域下方展示"待删除区"板块
    - 调用 `GET /api/trips/:id/trash` 获取 trashed 文件列表
    - 待删除区为空时隐藏该板块
    - 每个文件展示缩略图、文件名和移入原因（模糊、重复等）
    - 每个文件提供"恢复"按钮，调用 `PUT /api/media/:id/restore`
    - 提供"清空待删除区"按钮，点击后弹出确认对话框，确认后调用 `DELETE /api/trips/:id/trash`
    - 操作完成后自动刷新相册数据
    - _需求: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 15.2 编写属性测试验证待删除区展示
    - **Property 18: 待删除区展示移入原因**
    - **验证: 需求 9.3**

  - [ ]* 15.3 编写单元测试 `client/src/pages/GalleryPage.test.tsx` 补充待删除区相关测试
    - 测试待删除区板块的显示/隐藏、恢复按钮、清空按钮
    - _需求: 9.1, 9.2, 9.4, 9.5, 9.6_

- [x] 16. 最终检查点 - 全部完成验证
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加快 MVP 进度
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点确保增量验证，避免问题累积
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
- 所有新服务遵循现有代码模式：纯函数 + DB 操作分离，try-catch 错误隔离
