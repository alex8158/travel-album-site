# 需求文档

## 简介

本功能对上传和处理流水线进行两项关键改进：

1. **磁盘存储上传**：将 multer 从 `memoryStorage()` 切换为 `diskStorage()`，避免大视频文件（10GB+）在 Node.js 内存中完整缓冲导致 OOM 崩溃。上传文件先写入磁盘临时目录，再从磁盘读取流式上传至对象存储。
2. **视频即时处理**：视频上传完成后立即触发单个视频的处理（分析、剪辑、缩略图生成），无需等待所有文件上传完毕。图片仍保持现有的批量处理流程（去重需要所有图片就绪）。

## 术语表

- **Upload_Router**: 服务端媒体上传路由（`server/src/routes/media.ts`），负责接收文件并保存至存储
- **Storage_Provider**: 存储抽象层（`StorageProvider` 接口），支持 S3、本地等多种后端
- **Temp_Directory**: 由 `getTempDir()` 提供的临时文件目录（`server/.tmp`），用于中间文件处理
- **FileUploader**: 前端文件上传组件（`client/src/components/FileUploader.tsx`），逐个上传文件并跟踪进度
- **ProcessTrigger**: 前端处理触发组件，通过 SSE 连接批量处理流水线
- **Batch_Processor**: 服务端批量处理路由（`server/src/routes/process.ts`），对整个旅行的所有媒体执行去重、模糊检测、质量评分、优化、缩略图、视频分析/剪辑、封面选择
- **Single_Video_Processor**: 新增的单视频处理端点，对单个视频执行分析、剪辑和缩略图生成
- **Video_Analyzer**: 视频分析服务（`videoAnalyzer.ts`），将视频分段并计算质量评分
- **Video_Editor**: 视频剪辑服务（`videoEditor.ts`），根据分析结果选择片段并拼接
- **Thumbnail_Generator**: 缩略图生成服务（`thumbnailGenerator.ts`），为图片和视频生成 WebP 缩略图

## 需求

### 需求 1：Multer 磁盘存储

**用户故事：** 作为服务端运维人员，我希望上传的文件先写入磁盘而非内存缓冲，以便服务器在处理大视频文件（10GB+）时不会因内存溢出而崩溃。

#### 验收标准

1. THE Upload_Router SHALL 使用 `multer.diskStorage()` 并将上传文件写入 Temp_Directory 提供的临时目录
2. WHEN 文件上传完成时，THE Upload_Router SHALL 从磁盘读取文件流并通过 Storage_Provider 保存至目标存储路径
3. WHEN 文件成功保存至 Storage_Provider 后，THE Upload_Router SHALL 删除 Temp_Directory 中的临时文件
4. IF 文件保存至 Storage_Provider 失败，THEN THE Upload_Router SHALL 删除 Temp_Directory 中的临时文件并返回错误响应
5. THE Upload_Router SHALL 使用 `fs.createReadStream()` 从磁盘读取文件，避免将整个文件加载到内存中
6. THE Upload_Router SHALL 使用临时文件的大小（通过 `fs.stat` 获取）作为数据库中 `file_size` 字段的值

### 需求 2：单视频处理端点

**用户故事：** 作为开发者，我希望有一个单视频处理 API 端点，以便前端可以在每个视频上传完成后立即触发该视频的处理，而无需等待所有文件上传完毕。

#### 验收标准

1. THE Single_Video_Processor SHALL 提供 `POST /api/media/:id/process` 端点，接受单个媒体项 ID 作为参数
2. WHEN 收到处理请求时，THE Single_Video_Processor SHALL 验证该媒体项存在且 `media_type` 为 `video`
3. IF 媒体项不存在，THEN THE Single_Video_Processor SHALL 返回 404 错误
4. IF 媒体项的 `media_type` 不是 `video`，THEN THE Single_Video_Processor SHALL 返回 400 错误，提示仅支持视频处理
5. WHEN 处理视频时，THE Single_Video_Processor SHALL 依次执行 Video_Analyzer 分析、Video_Editor 剪辑和 Thumbnail_Generator 缩略图生成
6. WHEN 视频分析和剪辑成功完成时，THE Single_Video_Processor SHALL 将 `compiled_path` 更新至数据库
7. WHEN 缩略图生成成功完成时，THE Single_Video_Processor SHALL 将 `thumbnail_path` 更新至数据库
8. IF 处理过程中发生错误，THEN THE Single_Video_Processor SHALL 将错误信息写入数据库 `processing_error` 字段并返回包含错误详情的响应
9. WHEN 处理成功完成时，THE Single_Video_Processor SHALL 返回包含 `compiledPath`、`thumbnailPath` 和处理状态的 JSON 响应

### 需求 3：前端视频即时处理

**用户故事：** 作为用户，我希望每个视频上传完成后立即开始处理，以便减少整体等待时间，不必等所有文件都上传完才开始处理视频。

#### 验收标准

1. WHEN 单个视频文件上传成功完成时，THE FileUploader SHALL 立即在后台调用 Single_Video_Processor 端点触发该视频的处理
2. THE FileUploader SHALL 接受一个可选的回调属性 `onVideoUploaded`，在每个视频上传成功后调用，传递该媒体项的 ID 和文件类型信息
3. WHILE 视频在后台处理时，THE FileUploader SHALL 继续上传队列中的下一个文件，处理与上传并行执行
4. IF 视频后台处理请求失败，THEN THE FileUploader SHALL 在控制台记录错误但不阻塞上传流程
5. WHEN 所有文件上传完成后，THE FileUploader SHALL 仍然调用 `onAllUploaded` 回调，触发图片的批量处理流程
6. THE Batch_Processor SHALL 在批量处理流水线中跳过已经通过 Single_Video_Processor 完成处理的视频（检查 `compiled_path` 或 `thumbnail_path` 是否已存在）

### 需求 4：上传页面和相册页面集成

**用户故事：** 作为用户，我希望在上传页面和追加素材流程中，视频即时处理能够无缝集成，处理体验与现有流程保持一致。

#### 验收标准

1. THE UploadPage SHALL 将视频即时处理回调传递给 FileUploader 组件
2. THE MyGalleryPage SHALL 在追加素材流程中将视频即时处理回调传递给 FileUploader 组件
3. WHEN 批量处理完成后显示处理摘要时，THE ProcessTrigger SHALL 正确反映已通过即时处理完成的视频数量
