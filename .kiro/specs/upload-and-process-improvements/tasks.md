# 实施计划：上传和处理流水线改进

## 概述

将上传路由从内存缓冲切换为磁盘存储，新增单视频即时处理端点，前端上传完成后自动触发视频处理，批量处理跳过已处理视频。按服务端→前端→集成的顺序递增实现。

## Tasks

- [x] 1. Multer 磁盘存储改造（server/src/routes/media.ts）
  - [x] 1.1 将 multer 从 `memoryStorage()` 切换为 `diskStorage()`，destination 使用 `getTempDir()`，filename 生成唯一名称
    - 替换 `req.file.buffer` 为 `req.file.path`
    - 替换 `file.buffer.length` 为 `fs.statSync(req.file.path).size`
    - 使用 `fs.createReadStream(req.file.path)` 传入 `storageProvider.save()`
    - 在 `finally` 块中 `fs.unlinkSync(req.file.path)` 清理临时文件（成功和失败都清理）
    - 分类时直接使用 `req.file.path`，移除 `storageProvider.downloadToTemp()` 调用
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 1.2 Write property test for upload file content integrity
    - **Property 1: 上传文件内容完整性（Round-Trip）**
    - 使用 fast-check 生成随机二进制内容，验证上传后从 StorageProvider 读取内容一致，DB file_size 匹配
    - **Validates: Requirements 1.2, 1.6**

  - [ ]* 1.3 Write property test for temp file cleanup
    - **Property 2: 临时文件必定清理**
    - 使用 fast-check 生成随机文件，模拟成功/失败场景，验证 getTempDir() 目录无残留
    - **Validates: Requirements 1.3, 1.4**

- [x] 2. Checkpoint - 确保磁盘存储改造测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. 单视频处理端点（server/src/routes/media.ts）
  - [x] 3.1 实现 `POST /api/media/:id/process` 端点
    - 验证媒体项存在（404）、media_type 为 video（400）、请求者为旅行所有者或管理员（403）
    - 从 StorageProvider 下载视频到临时文件
    - 依次执行 `analyzeVideo()` → `editVideo()` → `generateVideoThumbnail()`
    - 成功时更新 DB `compiled_path` 和 `thumbnail_path`，返回 `{ mediaId, compiledPath, thumbnailPath, status: 'success' }`
    - 失败时更新 DB `processing_error`，返回 `{ mediaId, status: 'error', error: message }`
    - 在路由文件中注册新端点
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ]* 3.2 Write property test for video process endpoint input validation
    - **Property 3: 视频处理端点输入验证**
    - 使用 fast-check 生成随机媒体项（存在/不存在、video/image/unknown），验证返回正确状态码
    - **Validates: Requirements 2.2, 2.3, 2.4**

  - [ ]* 3.3 Write unit tests for single video process endpoint
    - 测试成功处理后 DB 更新 compiled_path 和 thumbnail_path（Property 4）
    - 测试处理失败后 DB 更新 processing_error（Property 5）
    - **Validates: Requirements 2.6, 2.7, 2.8, 2.9**

- [x] 4. 批量处理跳过已处理视频（server/src/routes/process.ts）
  - [x] 4.1 修改批量处理流水线，过滤出未处理的视频（`compiled_path` 和 `thumbnail_path` 均为空）
    - 已处理视频直接计入 `compiledCount`，不重复下载和处理
    - 同时修改 SSE 流式处理路由中的视频分析和剪辑步骤
    - _Requirements: 3.6, 4.3_

  - [ ]* 4.2 Write property test for batch processing skip logic
    - **Property 8: 批量处理跳过已处理视频**
    - 使用 fast-check 生成随机视频列表（部分已有 compiled_path），验证已处理视频未被重复处理
    - **Validates: Requirements 3.6, 4.3**

- [x] 5. Checkpoint - 确保服务端所有改动测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. 前端 FileUploader 视频即时处理（client/src/components/FileUploader.tsx）
  - [x] 6.1 新增 `onVideoUploaded` 可选回调属性，上传成功后判断 mediaType 为 video 时 fire-and-forget 调用 `POST /api/media/:id/process`
    - 在 `uploadFile` 成功回调中读取响应的 `mediaType` 字段
    - 使用 `authFetch` 或 `fetch` + token 发起处理请求，`.catch()` 仅 console.error
    - 处理请求不阻塞后续文件上传
    - `onAllUploaded` 回调行为不变
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 6.2 Write unit tests for FileUploader video processing trigger
    - 验证视频上传后触发处理请求（Property 6）
    - 验证处理请求失败不影响上传流程（Property 7）
    - 验证 onVideoUploaded 回调被正确调用
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [x] 7. 上传页面和相册页面集成
  - [x] 7.1 修改 UploadPage（client/src/pages/UploadPage.tsx）传递 `onVideoUploaded` 回调给 FileUploader
    - _Requirements: 4.1_

  - [x] 7.2 修改 MyGalleryPage（client/src/pages/MyGalleryPage.tsx）追加素材流程中传递 `onVideoUploaded` 回调给 FileUploader
    - _Requirements: 4.2_

- [x] 8. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 服务端使用 TypeScript，前端使用 TypeScript + React
- 属性测试使用 fast-check 库，单元测试使用 vitest
- StorageProvider.save() 已支持 `Buffer | Readable` 参数，无需修改接口
- `generateVideoThumbnail()` 已存在于 thumbnailGenerator.ts，可直接复用
