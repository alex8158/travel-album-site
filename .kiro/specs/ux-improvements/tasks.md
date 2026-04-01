# 实施计划：UX 改进

## 概述

按照后端优先、前端跟进的顺序实施六项 UX 改进。后端先完成视频缩略图生成和进度事件扩展，前端再依次重构 FileUploader、扩展 ProcessTrigger、新建 ProcessingLog、改造 UploadPage 和 GalleryPage。

## 任务

- [x] 1. 后端：ThumbnailGenerator 支持视频缩略图生成
  - [x] 1.1 在 `server/src/services/thumbnailGenerator.ts` 中新增 `generateVideoThumbnail` 函数
    - 使用 fluent-ffmpeg 提取视频第一帧到临时 JPEG 文件
    - 使用 sharp 将帧缩放为 400x400 以内（保持宽高比），转为 WebP 格式
    - 保存到 `uploads/{tripId}/thumbnails/{mediaId}_thumb.webp`
    - 返回相对路径字符串
    - _需求：6.1, 6.2, 6.7_

  - [x] 1.2 扩展 `generateThumbnailsForTrip` 函数以同时处理视频
    - 修改查询条件，同时查询 `media_type = 'image'` 和 `media_type = 'video'` 的记录
    - 对图片调用 `generateThumbnail`，对视频调用 `generateVideoThumbnail`
    - 视频帧提取失败时记录错误日志并跳过，不中断其他文件处理
    - 更新 DB 的 `thumbnail_path` 字段
    - _需求：6.1, 6.6, 6.7_

  - [ ]* 1.3 编写 `generateVideoThumbnail` 的单元测试
    - 测试有效视频生成缩略图文件
    - 测试视频帧提取失败时记录错误并跳过
    - 测试 `generateThumbnailsForTrip` 同时处理图片和视频
    - _需求：6.1, 6.6_

  - [ ]* 1.4 编写属性测试：视频缩略图尺寸约束
    - **属性 4：视频缩略图尺寸约束**
    - 生成随机宽高值，验证缩放后的尺寸在 400x400 以内且保持宽高比
    - **验证需求：6.2**

- [ ] 2. 后端：ProgressReporter 扩展 SSE 事件
  - [x] 2.1 扩展 `server/src/services/progressReporter.ts` 中的 `ProgressEvent` 接口
    - 新增 `processed?: number` 和 `total?: number` 字段
    - 修改 `sendStepStart` 和 `sendStepComplete` 方法，支持传入 processed/total 参数
    - _需求：3.3_

  - [x] 2.2 扩展 `CompleteEvent` 接口，新增 `totalVideos` 字段
    - _需求：4.2_

  - [x] 2.3 修改 `server/src/routes/process.ts` 中的 SSE 流处理逻辑
    - 查询视频数量并传入 CompleteEvent
    - 在各处理步骤中传入 processed/total 计数
    - _需求：3.3, 4.2_

  - [ ]* 2.4 编写 ProgressReporter 扩展的单元测试
    - 测试 progress 事件包含 processed/total 字段
    - 测试 complete 事件包含 totalVideos 字段
    - _需求：3.3, 4.2_

- [x] 3. 后端：Gallery 路由为视频返回 thumbnailUrl
  - [x] 3.1 修改 `server/src/routes/gallery.ts`，为 videos 数组中每个元素添加 `thumbnailUrl` 字段
    - 如果 `thumbnail_path` 存在，返回 `/api/media/{id}/thumbnail`
    - 如果不存在，返回空字符串或占位图路径
    - _需求：6.3_

  - [ ]* 3.2 编写 Gallery 路由视频 thumbnailUrl 的单元测试
    - 测试视频有缩略图时返回正确 URL
    - 测试视频无缩略图时返回占位值
    - _需求：6.3_

- [x] 4. 后端：mediaServing 路由支持视频缩略图
  - [x] 4.1 修改 `server/src/routes/mediaServing.ts` 的 thumbnail 端点
    - 如果 `media_type` 为 `video` 且无缩略图，调用 `generateVideoThumbnail` 即时生成
    - 如果视频缩略图生成失败，返回 404
    - _需求：6.1, 6.6_

  - [ ]* 4.2 编写 mediaServing 视频缩略图的单元测试
    - 测试视频缩略图存在时直接返回
    - 测试视频缩略图不存在时即时生成
    - 测试视频缩略图生成失败时返回 404
    - _需求：6.1, 6.6_

- [x] 5. 检查点 - 后端变更验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 6. 前端：FileUploader 重构支持文件夹上传和聚合进度
  - [x] 6.1 添加文件/文件夹模式切换
    - 新增 `mode: 'file' | 'folder'` 内部状态
    - 渲染 "选择文件" 和 "选择文件夹" 两个按钮
    - 文件夹模式下 input 设置 `webkitdirectory` 属性
    - 选择文件后自动开始上传
    - _需求：1.1, 1.3_

  - [x] 6.2 实现文件夹模式下的格式筛选
    - 使用现有 `isFormatSupported()` 筛选文件
    - 跳过不支持格式文件，显示 "已跳过 N 个不支持格式的文件" 警告
    - 全部不支持时显示 "未找到支持格式的文件" 提示
    - _需求：1.2, 1.4, 1.5_

  - [x] 6.3 将上传 UI 从逐文件列表改为聚合进度条
    - 隐藏逐文件上传列表
    - 显示整体进度条，百分比 = completedCount / totalCount * 100
    - 进度条旁显示 "已上传数/总上传数" 文本
    - 失败文件在进度条下方显示文件名和重试按钮
    - _需求：2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 6.4 编写 FileUploader 重构的单元测试
    - 测试模式切换按钮渲染和切换
    - 测试文件夹模式下 input 具有 webkitdirectory 属性
    - 测试不支持格式文件被跳过并显示警告
    - 测试聚合进度条和计数文本显示
    - 测试失败文件显示文件名和重试按钮
    - _需求：1.1, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 6.5 编写属性测试：文件格式筛选正确分区
    - **属性 1：文件格式筛选正确分区**
    - 生成随机文件名和 MIME 类型组合，验证 `isFormatSupported` 的分区结果正确且完整
    - **验证需求：1.2, 1.4**

  - [ ]* 6.6 编写属性测试：上传进度百分比计算
    - **属性 2：上传进度百分比计算**
    - 生成随机 completedCount/totalCount 对，验证百分比计算结果正确且在 [0, 100] 范围内
    - **验证需求：2.4**

- [x] 7. 前端：ProcessTrigger 扩展 autoStart 和进度计数
  - [x] 7.1 为 ProcessTrigger 添加 `autoStart` prop
    - 当 `autoStart={true}` 时，组件挂载后自动调用 `handleProcess()`
    - 自动模式下不渲染 "开始处理" 按钮
    - _需求：3.1, 3.5_

  - [x] 7.2 在进度展示中添加 "已处理数/总处理数" 文本
    - 解析 SSE progress 事件中的 `processed` 和 `total` 字段
    - 在 ProgressBar 旁显示计数文本
    - _需求：3.3_

  - [x] 7.3 扩展 `ProcessResult` 接口，新增 `totalVideos` 字段
    - _需求：4.2_

  - [ ]* 7.4 编写 ProcessTrigger 扩展的单元测试
    - 测试 `autoStart={true}` 时自动开始处理
    - 测试进度中显示 "已处理数/总处理数"
    - 测试 ProcessResult 包含 totalVideos
    - _需求：3.1, 3.3, 3.5_

- [x] 8. 前端：新建 ProcessingLog 组件
  - [x] 8.1 创建 `client/src/components/ProcessingLog.tsx`
    - 接收 `uploadCount`、`result: ProcessResult`、`onClose` props
    - 以模态窗口形式展示：上传文件数量、处理图片数量、处理视频数量、重复组数量、最终保留图片数量
    - 提供关闭按钮
    - _需求：4.1, 4.2, 4.3, 4.4_

  - [ ]* 8.2 编写 ProcessingLog 组件的单元测试
    - 测试渲染所有必需统计信息
    - 测试关闭按钮触发 onClose
    - _需求：4.1, 4.2, 4.3_

  - [ ]* 8.3 编写属性测试：处理日志展示所有必需统计信息
    - **属性 3：处理日志展示所有必需统计信息**
    - 生成随机 ProcessResult 对象，验证 ProcessingLog 渲染输出包含所有必需字段
    - **验证需求：4.2**

- [x] 9. 前端：UploadPage 上传完成后自动处理
  - [x] 9.1 修改 `client/src/pages/UploadPage.tsx` 实现自动处理流程
    - `onAllUploaded` 回调中自动切换到 `process` 步骤
    - ProcessTrigger 使用 `autoStart={true}`
    - 处理完成后展示 ProcessingLog 模态窗口
    - 关闭 ProcessingLog 后进入 `done` 步骤
    - 记录上传文件数量用于 ProcessingLog 展示
    - _需求：3.1, 3.2, 3.4, 4.1, 4.4_

  - [ ]* 9.2 编写 UploadPage 自动处理流程的单元测试
    - 测试上传完成后自动进入处理步骤
    - 测试处理完成后展示 ProcessingLog
    - 测试关闭 ProcessingLog 后进入 done 步骤
    - _需求：3.1, 3.2, 3.4, 4.1_

- [x] 10. 检查点 - 前端基础组件验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 11. 前端：GalleryPage 视频缩略图网格和自动处理
  - [x] 11.1 将视频区域从文本列表改为缩略图网格
    - 使用与图片相同的网格布局展示视频缩略图
    - 视频缩略图上叠加播放图标（▶）以区分视频和图片
    - 无缩略图时使用默认占位图
    - 点击视频缩略图打开 VideoPlayer 组件
    - 更新 `GalleryVideo` 接口，新增 `thumbnailUrl` 字段
    - _需求：6.3, 6.4, 6.5, 6.6_

  - [x] 11.2 修改追加素材流程为自动处理
    - 移除 `uploaded` 中间状态，上传完成后直接进入 `processing`
    - ProcessTrigger 使用 `autoStart={true}`
    - 处理完成后展示 ProcessingLog，关闭后刷新 gallery 数据
    - _需求：3.5, 5.1, 5.2_

  - [ ]* 11.3 编写 GalleryPage 视频缩略图和自动处理的单元测试
    - 测试视频以缩略图网格展示
    - 测试视频缩略图上有播放图标
    - 测试点击视频缩略图打开 VideoPlayer
    - 测试追加素材上传完成后自动触发处理
    - _需求：6.3, 6.4, 6.5, 3.5, 5.1_

- [x] 12. 最终检查点 - 全部测试通过
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加快 MVP 进度
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点确保增量验证
- 属性测试验证通用正确性属性
- 单元测试验证具体示例和边界情况
