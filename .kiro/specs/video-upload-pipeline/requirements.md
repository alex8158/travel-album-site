# 需求文档：视频上传链路重构

## 简介

重构视频上传链路，支持大文件（10–20GB）稳定上传，兼容所有存储后端（本地、S3、OSS、COS）。上传完成后异步生成预览版和剪辑代理版代理文件。图片上传保持现有 multer 流程不变。

## 术语表

- **Upload_API**：后端 Express 路由层，负责处理上传初始化、分片签名、上传完成等 HTTP 请求
- **StorageProvider**：存储抽象接口，封装本地磁盘、S3、OSS、COS 的统一操作
- **Multipart_Upload**：将大文件拆分为多个分片（part）分别上传，最后合并的上传方式
- **Presigned_URL**：由后端签发的带有临时授权的 URL，允许前端直接向对象存储写入数据
- **Upload_Client**：前端上传模块，负责分片切割、并发上传、进度追踪、断点续传
- **Proxy_Generator**：后端异步服务，负责在上传完成后使用 ffmpeg/ffprobe 生成预览版和剪辑代理版
- **Preview_Proxy**：MP4/H.264/AAC 格式的预览版文件，最大 1080p，中等码率，供前端播放
- **Edit_Proxy**：MP4/H.264/AAC 格式的剪辑代理版文件，720p–1080p，稳定码率，seek 更快，供片段分析和手动合并
- **Part**：Multipart_Upload 中的单个分片
- **ETag**：对象存储返回的分片校验标识，用于 complete 阶段验证

## 需求

### 需求 1：上传初始化

**用户故事：** 作为前端开发者，我希望通过统一的初始化接口启动上传，以便前端不感知存储后端差异。

#### 验收标准

1. WHEN 前端发送 POST /api/uploads/init 请求并携带文件名、文件大小和 tripId，THE Upload_API SHALL 返回 mediaId、storageKey 和上传模式（simple 或 multipart）
2. WHEN 文件大小超过 100MB，THE Upload_API SHALL 将上传模式设为 multipart 并返回 uploadId
3. WHEN 文件大小不超过 100MB，THE Upload_API SHALL 将上传模式设为 simple 并返回单个 Presigned_URL（对象存储）或服务器中转端点（本地存储）
4. WHEN 文件格式不在支持列表（MP4、MOV、AVI、MKV）中，THE Upload_API SHALL 返回 400 错误码和格式不支持的提示信息
5. THE Upload_API SHALL 在 media_items 表中创建一条状态为 uploading 的记录

### 需求 2：分片签名

**用户故事：** 作为前端开发者，我希望批量获取分片的 Presigned_URL，以便高效并发上传分片。

#### 验收标准

1. WHEN 前端发送 POST /api/uploads/:mediaId/parts/presign 请求并携带 partNumber 列表，THE Upload_API SHALL 返回每个 partNumber 对应的 Presigned_URL
2. WHILE 存储后端为本地存储，THE Upload_API SHALL 返回服务器中转端点地址（格式为 /api/uploads/:mediaId/parts/:partNumber）替代 Presigned_URL
3. IF 请求的 mediaId 不存在或上传已完成，THEN THE Upload_API SHALL 返回 404 错误码

### 需求 3：分片上传（对象存储）

**用户故事：** 作为前端开发者，我希望通过 Presigned_URL 直传分片到对象存储，以便绕过服务器中转提升上传速度。

#### 验收标准

1. WHEN Upload_Client 使用 Presigned_URL 上传单个 Part 成功，THE 对象存储 SHALL 返回该 Part 的 ETag
2. WHEN 单个 Part 上传失败，THE Upload_Client SHALL 在 3 秒后自动重试，最多重试 3 次
3. THE Upload_Client SHALL 同时并发上传 3 到 5 个 Part
4. THE Upload_Client SHALL 使用 16MB 到 64MB 的分片大小；WHEN 文件大小超过 10GB，THE Upload_Client SHALL 使用 128MB 的分片大小

### 需求 4：分片上传（本地存储）

**用户故事：** 作为前端开发者，我希望本地存储场景下也能分片上传，以便获得与对象存储一致的上传体验。

#### 验收标准

1. WHEN Upload_Client 发送 PUT /api/uploads/:mediaId/parts/:partNumber 请求并携带分片数据，THE Upload_API SHALL 将分片流式写入临时目录
2. THE Upload_API SHALL 为每个 Part 返回一个 ETag（基于分片内容的 MD5 哈希值）
3. IF 分片写入磁盘失败，THEN THE Upload_API SHALL 返回 500 错误码并记录错误日志

### 需求 5：上传完成

**用户故事：** 作为前端开发者，我希望提交所有分片信息来完成上传，以便触发后续处理流程。

#### 验收标准

1. WHEN 前端发送 POST /api/uploads/:mediaId/complete 请求并携带 partNumber 和 ETag 列表，THE Upload_API SHALL 调用 StorageProvider 的 completeMultipartUpload 方法合并分片
2. WHEN 合并成功，THE Upload_API SHALL 将 media_items 记录状态更新为 uploaded 并创建 processing_jobs 记录
3. IF 提交的 Part 列表与实际上传的 Part 不一致，THEN THE Upload_API SHALL 返回 400 错误码和详细的不一致信息
4. WHILE 存储后端为本地存储，THE Upload_API SHALL 将临时目录中的分片按 partNumber 顺序合并为完整文件

### 需求 6：上传进度与断点续传

**用户故事：** 作为用户，我希望看到上传进度并在中断后恢复上传，以便大文件上传更可靠。

#### 验收标准

1. THE Upload_Client SHALL 显示每个文件的上传进度百分比
2. THE Upload_Client SHALL 在本地（localStorage）记录每个上传任务的 mediaId、uploadId 和已完成的 Part 列表
3. WHEN 上传中断后用户重新打开页面，THE Upload_Client SHALL 检测未完成的上传任务并提示用户恢复
4. WHEN 用户选择恢复上传，THE Upload_Client SHALL 跳过已完成的 Part 并继续上传剩余 Part
5. WHEN 用户点击取消按钮，THE Upload_Client SHALL 中止所有进行中的请求并将上传状态标记为已取消

### 需求 7：StorageProvider 接口扩展

**用户故事：** 作为后端开发者，我希望 StorageProvider 接口支持 multipart 操作，以便所有存储后端统一处理分片上传。

#### 验收标准

1. THE StorageProvider SHALL 提供 initMultipartUpload(relativePath: string) 方法，返回 uploadId
2. THE StorageProvider SHALL 提供 getPresignedPartUrl(relativePath: string, uploadId: string, partNumber: number) 方法，返回该分片的 Presigned_URL
3. THE StorageProvider SHALL 提供 completeMultipartUpload(relativePath: string, uploadId: string, parts: Array<{partNumber: number, etag: string}>) 方法，合并所有分片
4. THE StorageProvider SHALL 提供 abortMultipartUpload(relativePath: string, uploadId: string) 方法，清理已上传的分片
5. THE StorageProvider SHALL 提供 getPresignedUploadUrl(relativePath: string) 方法，返回用于简单上传的 Presigned_URL

### 需求 8：本地存储 Multipart 实现

**用户故事：** 作为后端开发者，我希望本地存储模拟 multipart 上传流程，以便与对象存储行为一致。

#### 验收标准

1. WHEN initMultipartUpload 被调用，THE LocalStorageProvider SHALL 创建临时目录并返回唯一的 uploadId
2. WHEN 分片数据写入时，THE LocalStorageProvider SHALL 将每个 Part 流式写入临时目录中以 partNumber 命名的文件
3. WHEN completeMultipartUpload 被调用，THE LocalStorageProvider SHALL 按 partNumber 顺序合并所有分片文件到目标路径并删除临时目录
4. WHEN abortMultipartUpload 被调用，THE LocalStorageProvider SHALL 删除临时目录及其中所有分片文件
5. THE LocalStorageProvider SHALL 为 getPresignedPartUrl 返回服务器中转端点路径（非真正的 Presigned_URL）
6. THE LocalStorageProvider SHALL 为 getPresignedUploadUrl 返回服务器中转端点路径

### 需求 9：S3 存储 Multipart 实现

**用户故事：** 作为后端开发者，我希望 S3 存储使用原生 multipart upload API，以便高效处理大文件上传。

#### 验收标准

1. WHEN initMultipartUpload 被调用，THE S3StorageProvider SHALL 调用 CreateMultipartUploadCommand 并返回 UploadId
2. WHEN getPresignedPartUrl 被调用，THE S3StorageProvider SHALL 使用 UploadPartCommand 生成带签名的 URL
3. WHEN completeMultipartUpload 被调用，THE S3StorageProvider SHALL 调用 CompleteMultipartUploadCommand 并传入所有 Part 的 ETag
4. WHEN abortMultipartUpload 被调用，THE S3StorageProvider SHALL 调用 AbortMultipartUploadCommand 清理已上传的分片
5. THE S3StorageProvider SHALL 为 getPresignedUploadUrl 使用 PutObjectCommand 生成带签名的上传 URL


### 需求 10：代理文件生成

**用户故事：** 作为用户，我希望上传完成后自动生成预览版和剪辑代理版，以便快速在前端播放和进行片段分析。

#### 验收标准

1. WHEN media_items 记录状态变为 uploaded，THE Proxy_Generator SHALL 异步启动代理文件生成流程
2. THE Proxy_Generator SHALL 使用 ffprobe 提取视频元数据（时长、分辨率、编码格式、码率）并写入 media_items 记录
3. THE Proxy_Generator SHALL 从视频中抽取一帧作为封面图并存储到 {tripId}/thumbnails/{mediaId}.jpg
4. THE Proxy_Generator SHALL 生成 Preview_Proxy 文件：MP4 容器、H.264 编码、AAC 音频、最大分辨率 1080p、中等码率，存储到 {tripId}/proxies/{mediaId}_preview.mp4
5. THE Proxy_Generator SHALL 生成 Edit_Proxy 文件：MP4 容器、H.264 编码、AAC 音频、720p–1080p 分辨率、稳定码率（CBR 或受限 VBR），存储到 {tripId}/proxies/{mediaId}_edit.mp4
6. WHEN 代理文件生成完成，THE Proxy_Generator SHALL 将 media_items 记录状态更新为 ready 并记录代理文件路径
7. IF 代理文件生成失败，THEN THE Proxy_Generator SHALL 将 media_items 记录状态更新为 proxy_failed 并记录错误信息
8. THE Proxy_Generator SHALL 保留原始上传文件，代理文件另存到独立路径

### 需求 11：异常处理与清理

**用户故事：** 作为用户，我希望上传异常时得到明确提示，并且系统能自动清理残留数据。

#### 验收标准

1. WHEN 单个 Part 上传超时（超过 60 秒无响应），THE Upload_Client SHALL 自动重试该 Part
2. IF 单个 Part 重试 3 次仍失败，THEN THE Upload_Client SHALL 将该文件标记为上传失败并显示错误信息
3. WHEN 上传失败或用户取消上传，THE Upload_API SHALL 调用 StorageProvider 的 abortMultipartUpload 方法清理已上传的分片
4. WHEN 文件大小超过 10GB，THE Upload_Client SHALL 显示提示信息建议用户使用稳定网络
5. WHEN 文件大小超过 20GB，THE Upload_Client SHALL 显示提示信息建议用户在桌面端上传
6. IF 存储写入失败，THEN THE Upload_API SHALL 返回 500 错误码并清理已上传的 Part 数据

### 需求 12：Nginx 配置更新

**用户故事：** 作为运维人员，我希望 Nginx 配置支持大文件上传场景，以便兼容不走 Presigned_URL 的本地存储上传。

#### 验收标准

1. THE Nginx 配置 SHALL 将 client_max_body_size 设置为 2G
2. WHILE 前端通过 Presigned_URL 直传对象存储，THE Nginx SHALL 不参与数据传输（请求不经过 Nginx）

### 需求 13：save() 方法流式化改造

**用户故事：** 作为后端开发者，我希望 StorageProvider 的 save() 方法支持流式写入，以便避免将整个大文件读入内存。

#### 验收标准

1. THE S3StorageProvider 的 save() 方法 SHALL 使用 Upload 类（@aws-sdk/lib-storage）进行流式上传，替代将整个 Readable 读入 Buffer 的方式
2. THE LocalStorageProvider 的 save() 方法 SHALL 继续使用 stream pipeline 进行流式写入（当前已满足）
3. THE StorageProvider 的 save() 方法 SHALL 接受 Buffer 或 Readable 类型的数据参数

### 需求 14：第一版范围约束

**用户故事：** 作为产品经理，我希望明确第一版的功能边界，以便团队聚焦核心功能交付。

#### 验收标准

1. THE Upload_API SHALL 仅处理视频文件的新上传流程；图片上传 SHALL 保持现有 multer 流程不变
2. THE Upload_Client SHALL 对超过 100MB 的视频文件强制使用 Multipart_Upload
3. THE Proxy_Generator SHALL 在上传完成后生成 Preview_Proxy 和 Edit_Proxy 两种代理文件
4. THE Upload_Client SHALL 支持断点续传、上传进度条和取消上传功能

### 需求 15：Simple 上传完成确认

**用户故事：** 作为前端开发者，我希望 simple 模式上传完成后也能通知后端更新状态并触发后续处理，以便 simple 上传链路闭环。

#### 验收标准

1. WHEN 前端通过 Presigned_URL 或服务器中转完成 simple 上传后，THE Upload_Client SHALL 发送 POST /api/uploads/:mediaId/finalize 请求
2. WHEN finalize 请求到达，THE Upload_API SHALL 将 media_items 记录状态从 uploading 更新为 uploaded
3. WHEN finalize 成功，THE Upload_API SHALL 创建 processing_jobs 记录并触发异步代理文件生成
4. IF mediaId 不存在或状态不是 uploading，THEN THE Upload_API SHALL 返回 404 或 409 错误码

### 需求 16：服务端上传状态查询

**用户故事：** 作为前端开发者，我希望能从服务端查询上传任务的真实状态，以便断点续传时以服务端状态为准而非仅依赖 localStorage。

#### 验收标准

1. WHEN 前端发送 GET /api/uploads/:mediaId/status 请求，THE Upload_API SHALL 返回该上传任务的 uploadId、mode、status 和 uploadedParts 列表
2. WHEN 存储后端为 S3/OSS/COS，THE Upload_API SHALL 调用 ListParts API 获取已上传的 Part 列表
3. WHEN 存储后端为本地存储，THE Upload_API SHALL 扫描临时目录获取已存在的分片文件列表
4. THE Upload_Client SHALL 在恢复上传时优先使用服务端返回的 uploadedParts，localStorage 记录仅作为辅助加速

### 需求 17：取消上传接口

**用户故事：** 作为用户，我希望取消上传时后端也能清理残留分片，以便不浪费存储空间。

#### 验收标准

1. WHEN 前端发送 POST /api/uploads/:mediaId/abort 请求，THE Upload_API SHALL 调用 StorageProvider 的 abortMultipartUpload 方法清理已上传的分片
2. WHEN abort 成功，THE Upload_API SHALL 将 media_items 记录状态更新为 cancelled
3. IF mediaId 不存在，THEN THE Upload_API SHALL 返回 404 错误码
4. THE Upload_Client SHALL 在用户点击取消按钮后调用此接口

### 需求 18：分片接口携带 uploadId

**用户故事：** 作为后端开发者，我希望分片相关接口都显式携带 uploadId，以便同一 mediaId 下多次上传会话不会混淆。

#### 验收标准

1. THE Upload_API 的 parts/presign 接口 SHALL 要求请求体中包含 uploadId 参数
2. THE Upload_API 的 complete 接口 SHALL 要求请求体中包含 uploadId 参数
3. THE Upload_API 的 abort 接口 SHALL 要求请求体中包含 uploadId 参数
4. THE Upload_API 的本地存储分片上传端点 SHALL 在 URL 或请求体中包含 uploadId 参数
5. IF 请求中的 uploadId 与 media_items 记录中的 uploadId 不匹配，THEN THE Upload_API SHALL 返回 409 错误码

### 需求 19：过期上传自动清理

**用户故事：** 作为运维人员，我希望系统自动清理长时间未完成的上传残留，以便防止存储空间被废弃分片占满。

#### 验收标准

1. THE Upload_API SHALL 在服务启动时检查所有状态为 uploading 且创建时间超过 72 小时的 media_items 记录
2. WHEN 发现过期上传记录，THE Upload_API SHALL 调用 StorageProvider 的 abortMultipartUpload 方法清理残留分片
3. WHEN 清理完成，THE Upload_API SHALL 将过期 media_items 记录状态更新为 expired
4. WHILE 存储后端为本地存储，THE Upload_API SHALL 删除对应的临时分片目录
5. THE 清理逻辑 SHALL 可通过环境变量 UPLOAD_EXPIRE_HOURS 配置过期时间（默认 72 小时）
