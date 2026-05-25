# Requirements Document

## Introduction

照片幻灯片视频生成功能允许用户在 MyGalleryPage 中多选照片，通过后端 ffmpeg 将选中照片按顺序拼接为幻灯片视频（每张照片固定显示 2 秒），可选配背景音乐，最终输出可下载/预览的 MP4 文件。

## Glossary

- **Slideshow_Generator**: 后端服务，负责接收照片列表和音频配置，调用 ffmpeg 生成幻灯片视频
- **Slideshow_API**: Express 路由端点，处理幻灯片视频生成请求并通过 SSE 报告进度
- **Gallery_UI**: MyGalleryPage 前端页面，提供多选照片和触发视频生成的交互界面
- **Audio_Picker**: 音频选择组件，允许用户从音频库中选择背景音乐
- **Slideshow_Video**: 由照片序列生成的 MP4 格式幻灯片视频文件

## Requirements

### Requirement 1: 触发幻灯片视频生成

**User Story:** As a 用户, I want 在多选照片后点击按钮生成幻灯片视频, so that 我可以将精选照片快速制作成视频回忆。

#### Acceptance Criteria

1. WHILE Gallery_UI 处于多选模式且已选中至少 2 张照片, THE Gallery_UI SHALL 在底部操作栏显示"生成幻灯片视频"按钮
2. WHEN 用户点击"生成幻灯片视频"按钮, THE Gallery_UI SHALL 弹出音频选择对话框供用户选择背景音乐或跳过
3. WHEN 用户在音频选择对话框中确认选择（含选择不加音乐）, THE Gallery_UI SHALL 向 Slideshow_API 发送生成请求，包含选中照片 ID 列表和可选音频 ID
4. WHILE 幻灯片视频生成请求正在处理中, THE Gallery_UI SHALL 显示进度指示器并禁用重复提交

### Requirement 2: 幻灯片视频生成 API

**User Story:** As a 系统, I want 提供幻灯片视频生成的 API 端点, so that 前端可以请求生成并获取进度反馈。

#### Acceptance Criteria

1. WHEN Slideshow_API 收到生成请求, THE Slideshow_API SHALL 验证请求用户对所选照片所属旅行拥有访问权限
2. WHEN Slideshow_API 收到包含少于 2 张照片的请求, THE Slideshow_API SHALL 返回 400 错误码和明确的错误信息
3. WHEN Slideshow_API 收到有效的生成请求, THE Slideshow_API SHALL 创建异步任务并通过 SSE 流式返回处理进度
4. IF Slideshow_API 收到的照片 ID 中存在无效或不属于该旅行的项, THEN THE Slideshow_API SHALL 返回 400 错误码并指明无效的照片 ID

### Requirement 3: ffmpeg 幻灯片视频拼接

**User Story:** As a 系统, I want 使用 ffmpeg 将照片序列拼接为视频, so that 用户获得标准 MP4 格式的幻灯片视频。

#### Acceptance Criteria

1. THE Slideshow_Generator SHALL 按照用户选择的照片顺序依次拼接每张照片
2. THE Slideshow_Generator SHALL 为每张照片设置固定 2 秒的显示时长
3. THE Slideshow_Generator SHALL 输出 H.264 编码的 MP4 格式视频文件
4. WHEN 照片分辨率不一致时, THE Slideshow_Generator SHALL 将所有照片缩放至统一分辨率（以最大宽高为基准，保持比例，黑边填充）
5. THE Slideshow_Generator SHALL 输出分辨率不超过 1920x1080 的视频

### Requirement 4: 背景音乐混合

**User Story:** As a 用户, I want 为幻灯片视频添加背景音乐, so that 视频观看体验更丰富。

#### Acceptance Criteria

1. WHEN 用户选择了背景音乐, THE Slideshow_Generator SHALL 将音频混合到生成的视频中
2. WHEN 音频时长超过视频总时长, THE Slideshow_Generator SHALL 在视频结束时截断音频
3. WHEN 音频时长短于视频总时长, THE Slideshow_Generator SHALL 循环播放音频直至视频结束
4. WHEN 用户未选择背景音乐, THE Slideshow_Generator SHALL 生成无音频轨道的静音视频

### Requirement 5: 视频输出与访问

**User Story:** As a 用户, I want 下载或预览生成的幻灯片视频, so that 我可以保存或分享视频。

#### Acceptance Criteria

1. WHEN Slideshow_Generator 成功生成视频, THE Slideshow_API SHALL 将视频文件存储到旅行对应的存储目录中
2. WHEN 视频生成完成, THE Gallery_UI SHALL 显示视频预览播放器和下载按钮
3. THE Slideshow_API SHALL 提供视频文件的下载端点，支持浏览器直接下载
4. WHEN 用户点击下载按钮, THE Gallery_UI SHALL 触发浏览器下载生成的 MP4 文件

### Requirement 6: 进度报告

**User Story:** As a 用户, I want 看到视频生成的实时进度, so that 我知道还需要等待多久。

#### Acceptance Criteria

1. WHILE Slideshow_Generator 正在处理, THE Slideshow_API SHALL 通过 SSE 每秒至少报告一次当前进度百分比
2. WHEN 视频生成完成, THE Slideshow_API SHALL 通过 SSE 发送 complete 事件，包含生成视频的访问路径
3. IF Slideshow_Generator 处理过程中发生错误, THEN THE Slideshow_API SHALL 通过 SSE 发送 error 事件，包含错误描述信息

### Requirement 7: 错误处理

**User Story:** As a 用户, I want 在生成失败时获得清晰的错误提示, so that 我知道问题所在并可以重试。

#### Acceptance Criteria

1. IF ffmpeg 进程执行超时（超过 5 分钟）, THEN THE Slideshow_Generator SHALL 终止进程并返回超时错误
2. IF 照片文件在存储中不存在或无法读取, THEN THE Slideshow_Generator SHALL 跳过该照片并在结果中报告警告
3. IF 所有照片均无法读取, THEN THE Slideshow_Generator SHALL 返回失败结果并附带明确错误信息
4. WHEN 视频生成失败, THE Gallery_UI SHALL 显示错误信息并提供重试按钮
