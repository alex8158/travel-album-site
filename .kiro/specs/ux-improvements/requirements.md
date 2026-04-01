# 需求文档

## 简介

本功能对现有的上传和处理体验进行六项优化：支持文件夹上传、简化上传进度展示、上传完成后自动触发处理、处理完成后展示日志窗口、确认追加素材的处理流程、以及视频缩略图展示。目标是减少用户操作步骤、提升进度反馈的清晰度、并让视频素材在 Gallery 中以缩略图形式直观展示。

## 术语表

- **File_Uploader**：负责文件选择和上传的前端组件，当前支持多文件选择和逐个上传
- **Upload_Page**：创建旅行时的上传页面，包含旅行创建、文件上传和素材处理三个步骤
- **Gallery_Page**：展示某次旅行相册中所有已处理素材（图片和视频）的页面
- **Processing_Pipeline**：素材处理流水线，包含去重、缩略图生成、质量评分和封面选择步骤
- **Progress_Bar**：展示处理进度的进度条组件
- **Process_Trigger**：触发素材处理并通过 SSE 展示进度的前端组件
- **Processing_Log**：处理完成后展示的日志窗口，包含上传和处理的统计信息
- **Video_Thumbnail**：从视频文件中提取的帧图片，用于在 Gallery 中作为视频的缩略图展示
- **Thumbnail_Generator**：负责为图片和视频生成缩略图的后端服务
- **Video_Player**：视频播放组件，支持点击缩略图后放大播放视频

## 需求

### 需求 1：支持选择文件夹

**用户故事：** 作为旅行者，我想要在选择文件时也能选择文件夹，以便我不需要手动逐个选择文件夹中的照片和视频。

#### 验收标准

1. THE File_Uploader SHALL 在现有文件选择器的基础上，增加对文件夹选择的支持，使用 HTML input 元素的 webkitdirectory 属性实现
2. WHEN 用户选择了一个文件夹时, THE File_Uploader SHALL 自动读取文件夹中所有文件并筛选出支持格式的文件（JPEG、PNG、WebP、HEIC、MP4、MOV、AVI、MKV）
3. THE File_Uploader SHALL 提供一个切换方式（如按钮或开关），让用户在"选择文件"和"选择文件夹"模式之间切换
4. WHEN 选择的文件夹中包含不支持格式的文件时, THE File_Uploader SHALL 跳过这些文件并显示被跳过文件数量的警告信息
5. WHEN 选择的文件夹中没有任何支持格式的文件时, THE File_Uploader SHALL 显示"未找到支持格式的文件"的提示信息

### 需求 2：上传进度简化

**用户故事：** 作为旅行者，我想要看到一个简洁的整体上传进度，而不是每个文件的详细上传列表，以便我能快速了解上传的整体进展。

#### 验收标准

1. WHILE 文件上传过程中, THE File_Uploader SHALL 隐藏逐个文件的上传列表
2. WHILE 文件上传过程中, THE File_Uploader SHALL 显示一个整体上传进度条，展示上传进度百分比
3. WHILE 文件上传过程中, THE File_Uploader SHALL 在进度条附近显示"已上传数/总上传数"的文本（例如"3/10"）
4. THE File_Uploader SHALL 根据已完成上传的文件数量占总文件数量的比例计算整体上传进度百分比
5. IF 某个文件上传失败, THEN THE File_Uploader SHALL 在进度条下方显示失败文件的名称和重试按钮

### 需求 3：上传完成后自动处理

**用户故事：** 作为旅行者，我想要在所有文件上传完成后自动开始素材处理，以便我不需要手动点击"开始处理"按钮。

#### 验收标准

1. WHEN 所有文件上传成功完成后, THE Upload_Page SHALL 自动触发 Processing_Pipeline，无需用户手动点击"开始处理"按钮
2. WHILE Processing_Pipeline 执行过程中, THE Upload_Page SHALL 显示处理进度条和当前处理步骤名称
3. WHILE Processing_Pipeline 执行过程中, THE Upload_Page SHALL 在进度信息中显示"已处理数/总处理数"的文本
4. IF Processing_Pipeline 执行过程中发生错误, THEN THE Upload_Page SHALL 显示错误信息并提供"重新处理"按钮
5. WHEN 追加素材场景下所有文件上传成功完成后, THE Gallery_Page SHALL 自动触发 Processing_Pipeline，无需用户手动点击"开始处理"按钮

### 需求 4：处理完成日志窗口

**用户故事：** 作为旅行者，我想要在素材处理完成后看到一个处理日志窗口，以便我能了解本次上传和处理的统计信息。

#### 验收标准

1. WHEN Processing_Pipeline 执行完成后, THE Processing_Log SHALL 以模态窗口或内嵌面板的形式展示处理结果
2. THE Processing_Log SHALL 展示以下统计信息：本次上传文件数量、处理的图片数量、检测到的重复组数量、最终保留的图片数量
3. WHEN Processing_Log 展示时, THE Processing_Log SHALL 提供关闭按钮，允许用户关闭日志窗口
4. THE Processing_Log SHALL 在追加素材场景和新建旅行场景中均可使用

### 需求 5：追加素材处理确认

**用户故事：** 作为旅行者，我想要确认追加的素材同样经过完整的处理流程后才在 Gallery 中展示，以便相册中的所有素材都经过去重和质量评分。

#### 验收标准

1. WHEN 追加素材上传完成并经过 Processing_Pipeline 处理后, THE Gallery_Page SHALL 刷新素材列表，展示包含新追加素材在内的所有已处理素材
2. THE Processing_Pipeline SHALL 对追加素材执行与新建旅行时完全相同的处理步骤（去重、缩略图生成、质量评分、封面选择）

### 需求 6：视频缩略图展示

**用户故事：** 作为旅行者，我想要视频在 Gallery 页面以缩略图形式展示，而不是仅显示文件名列表，以便我能直观地浏览视频内容。

#### 验收标准

1. WHEN Processing_Pipeline 执行缩略图生成步骤时, THE Thumbnail_Generator SHALL 使用 ffmpeg 从每个视频文件中提取一帧画面作为 Video_Thumbnail
2. THE Thumbnail_Generator SHALL 将提取的视频帧缩放为与图片缩略图一致的尺寸规格（400x400 以内，保持宽高比）
3. THE Gallery_Page SHALL 将视频素材以缩略图网格形式展示，与图片素材使用相同的网格布局
4. THE Gallery_Page SHALL 在视频缩略图上显示一个播放图标标识，以便用户区分视频和图片
5. WHEN 用户点击视频缩略图时, THE Gallery_Page SHALL 打开 Video_Player 组件放大播放该视频
6. IF 视频帧提取失败, THEN THE Thumbnail_Generator SHALL 记录错误日志，THE Gallery_Page SHALL 使用默认的视频占位图展示该视频
7. THE Thumbnail_Generator SHALL 将视频缩略图路径存储到对应 media_item 的 thumbnail_path 字段中
