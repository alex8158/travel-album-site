# Implementation Plan: 视频自动编译与合并

## Overview

本实现计划涵盖三项核心改动：（1）Pipeline 移除环境变量开关，始终自动编译；（2）数据库新增 `media_source` 字段和 `merged_video_sources` 关联表；（3）新增 MergeEngine 服务和合并 API；（4）前端 MyGalleryPage 分栏展示、GalleryPage 过滤逻辑。

## Tasks

- [x] 1. 数据库 Schema 扩展
  - [x] 1.1 在 `database.ts` 中添加 `media_source` 列迁移和 `merged_video_sources` 表
    - 添加 `ALTER TABLE media_items ADD COLUMN media_source TEXT DEFAULT 'upload'` 迁移（try/catch 幂等模式）
    - 创建 `merged_video_sources` 表（id, merged_media_id, source_media_id, sort_order, created_at）
    - 创建索引 `idx_merged_sources_merged` 和 `idx_merged_sources_source`
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 1.2 扩展 `MediaItemRow` 类型和 `rowToMediaItem` 转换函数
    - 在 `server/src/helpers/mediaItemRow.ts` 的 `MediaItemRow` 接口中添加 `media_source: string | null`
    - 在 `rowToMediaItem` 函数中添加 `mediaSource` 字段映射
    - 在 `server/src/types.ts` 的 `MediaItem` 接口中添加 `mediaSource?: 'upload' | 'merged'`
    - _Requirements: 4.3, 6.1_

- [x] 2. Pipeline autoCompile 始终启用
  - [x] 2.1 修改 `runTripProcessingPipeline.ts` 移除环境变量检查
    - 删除 `const autoCompileEnabled = process.env.VIDEO_AUTO_COMPILE_ENGINE === 'true'` 及其 `if` 条件
    - autoCompile 阶段始终执行，不再受环境变量控制
    - 在 autoCompile 循环中添加 `if (videoRow.media_source === 'merged') continue;` 跳过合并视频
    - 确保 autoCompile 失败时记录错误日志但不中断 pipeline
    - _Requirements: 1.1, 1.2, 1.3, 7.2_

  - [ ]* 2.2 编写 Pipeline autoCompile 错误隔离单元测试
    - 验证 autoCompile 抛出异常时 pipeline 继续执行后续视频
    - 验证 `media_source = 'merged'` 的视频被跳过
    - **Property 1: Pipeline autoCompile 错误隔离**
    - **Property 8: Pipeline 跳过合并视频**
    - **Validates: Requirements 1.3, 7.2**

- [x] 3. Checkpoint - 确保数据库和 Pipeline 改动正确
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. MergeEngine 服务实现
  - [x] 4.1 创建 `server/src/services/mergeEngine.ts`
    - 实现 `MergeRequest` 和 `MergeResult` 接口
    - 实现 `MergeEngine.merge()` 方法：验证源视频 → 下载 compiled 文件 → ffmpeg 拼接 → 上传存储 → 创建 media_items 记录 → 写入 merged_video_sources 关联
    - 使用 `videoEditor.ts` 中已有的 `concatenateSegments` 函数进行拼接
    - 新建 media_items 记录设置 `media_source = 'merged'`
    - 实现 `generateDefaultName()` 方法：相册标题 + 4位随机数
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3_

  - [ ]* 4.2 编写 MergeEngine 单元测试
    - 验证源视频缺少 compiled_path 时拒绝合并
    - 验证合并后源视频记录不变
    - 验证 merged_video_sources 记录完整性和排序
    - **Property 4: 合并选择验证**
    - **Property 5: 合并操作保留源视频不变性**
    - **Property 6: 合并记录创建正确性**
    - **Property 7: 合并源关系记录完整性**
    - **Validates: Requirements 4.1, 4.3, 4.4, 6.1, 6.2, 6.3**

- [x] 5. 合并 API 端点
  - [x] 5.1 创建 `server/src/routes/merge.ts` 并注册路由
    - 实现 `POST /api/media/merge` 端点
    - 验证用户已登录、sourceMediaIds 至少 2 个、所有源视频有 compiled_path
    - 验证用户对所有源视频所属相册有权限
    - 调用 MergeEngine.merge() 执行合并
    - 返回 `{ mediaId, filePath, name }` 响应
    - 在 `server/src/index.ts` 或主路由文件中注册 merge 路由
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3_

  - [ ]* 5.2 编写合并 API 集成测试
    - 测试正常合并流程返回 200
    - 测试源视频不足 2 个返回 400
    - 测试源视频无 compiled_path 返回 400
    - 测试未登录返回 401
    - 测试无权限返回 403
    - _Requirements: 4.1, 5.1_

- [x] 6. Gallery API 改造
  - [x] 6.1 修改 `server/src/routes/my.ts` 添加 originalVideos 和 compiledVideos 分栏数据
    - 在 `GET /api/my/trips/:id/gallery` 响应中新增 `originalVideos` 和 `compiledVideos` 字段
    - `originalVideos`：所有 `media_type = 'video'` 且 `media_source != 'merged'` 的原始视频
    - `compiledVideos`：具有 `compiled_path` 的视频（展示编译版）+ `media_source = 'merged'` 的视频
    - 保留原有 `videos` 字段以保持向后兼容
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 6.2 修改 `server/src/routes/gallery.ts` 公开画廊视频过滤
    - 修改视频查询 SQL，仅返回 `compiled_path IS NOT NULL OR media_source = 'merged'` 的视频
    - 对于有 `compiled_path` 的视频，在响应中包含 `compiledUrl` 字段
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 6.3 编写 Gallery API 视频过滤测试
    - 验证公开画廊不返回无 compiled_path 的原始视频
    - 验证公开画廊返回 media_source='merged' 的视频
    - 验证 MyGallery 正确分栏
    - **Property 2: MyGalleryPage 视频分类正确性**
    - **Property 3: GalleryPage 视频过滤正确性**
    - **Validates: Requirements 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4**

- [x] 7. Checkpoint - 确保后端 API 全部正确
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. 前端 MyGalleryPage 分栏展示
  - [x] 8.1 修改 `client/src/pages/MyGalleryPage.tsx` 视频区域分栏
    - 将视频区域分为"原始视频"和"剪辑视频"两个 Tab
    - 使用 API 返回的 `originalVideos` 和 `compiledVideos` 数据
    - 原始视频栏展示所有上传的视频
    - 剪辑视频栏展示 compiled 版本和 merged 视频
    - 更新 `GalleryData` 类型定义以包含新字段
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 9. 前端 GalleryPage 过滤逻辑
  - [x] 9.1 修改 `client/src/pages/GalleryPage.tsx` 仅展示剪辑视频
    - 视频播放地址优先使用 compiledPath 对应的 URL（`/api/media/${id}/compiled`）
    - 后端已过滤，前端只需正确使用 compiledUrl 或 compiledPath
    - 更新 `GalleryVideo` 接口添加 `compiledUrl` 和 `mediaSource` 字段
    - _Requirements: 3.1, 3.4_

- [x] 10. 合并视频生命周期管理
  - [x] 10.1 确保 Pipeline 中 videoAnalysis 阶段也跳过 merged 视频
    - 在 `runTripProcessingPipeline.ts` 的 videoAnalysis 循环中添加 `media_source = 'merged'` 过滤
    - 确保 videoEdit 和 videoEnhance 阶段也跳过 merged 视频
    - _Requirements: 7.2_

  - [x] 10.2 确保源视频删除不影响合并视频
    - `merged_video_sources` 表的 `source_media_id` 外键使用 `ON DELETE SET NULL`
    - 验证删除源视频后合并视频仍可正常播放
    - _Requirements: 7.1, 7.3_

  - [ ]* 10.3 编写生命周期管理测试
    - 验证 merged 视频不被 pipeline 处理
    - 验证源视频删除后合并视频不受影响
    - **Property 8: Pipeline 跳过合并视频**
    - **Property 9: 源视频删除不级联到合并视频**
    - **Validates: Requirements 7.2, 7.3**

- [x] 11. Final checkpoint - 确保所有功能正确集成
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- 合并功能使用已有的 `concatenateSegments` 函数，无需重新实现 ffmpeg 拼接逻辑
- `media_source` 字段默认值为 `'upload'`，确保向后兼容现有数据

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "10.1"] },
    { "id": 2, "tasks": ["2.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1", "6.1", "6.2"] },
    { "id": 4, "tasks": ["5.2", "6.3", "10.2"] },
    { "id": 5, "tasks": ["8.1", "9.1", "10.3"] }
  ]
}
```
