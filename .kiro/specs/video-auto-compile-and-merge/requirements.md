# Requirements Document

## Introduction

本功能实现视频处理流程的三项改进：（1）去掉环境变量开关，视频分析完成后始终自动编译精华视频；（2）我的相册页分栏展示原始视频和剪辑视频，公开画廊仅展示剪辑后的视频；（3）支持用户跨相册选择多个剪辑视频合并为一个新视频。

## Glossary

- **Pipeline**: 服务端视频处理管线，包含 videoAnalysis → autoCompile → videoEdit 等阶段
- **CompilationEngine**: 负责自动/手动编译视频片段的服务类，调用 segmentSelector 和 ffmpegCompiler
- **AutoCompile**: Pipeline 中视频分析完成后自动触发的编译阶段，生成精华剪辑视频
- **CompiledVideo**: 经过 CompilationEngine 编译后生成的精华剪辑视频，存储路径记录在 media_items.compiled_path
- **MergedVideo**: 由多个 CompiledVideo 合并生成的新视频，作为独立的 media_items 记录存在
- **MyGalleryPage**: 用户私有相册页面，展示用户自己的所有媒体内容
- **GalleryPage**: 公开画廊页面，展示对外可见的媒体内容
- **MergeEngine**: 负责将多个视频文件拼接合并为一个新视频的服务模块
- **MediaItem**: media_items 表中的一条记录，代表一个媒体文件（图片、视频、合并视频）

## Requirements

### Requirement 1: 自动编译始终启用

**User Story:** 作为用户，我希望视频上传分析完成后自动编译精华视频，无需手动触发"智能剪辑"按钮，以减少操作步骤。

#### Acceptance Criteria

1. WHEN videoAnalysis 阶段完成并成功写入 video_segments, THE Pipeline SHALL 立即触发 CompilationEngine.autoCompile 对该视频执行自动编译
2. THE Pipeline SHALL 移除 VIDEO_AUTO_COMPILE_ENGINE 环境变量检查，始终执行 autoCompile 阶段
3. IF autoCompile 执行失败, THEN THE Pipeline SHALL 记录错误日志并继续执行后续阶段，不中断整体处理流程
4. WHEN autoCompile 成功完成, THE Pipeline SHALL 将编译结果路径写入 media_items.compiled_path 字段

### Requirement 2: 我的相册页分栏展示

**User Story:** 作为用户，我希望在我的相册页中分别查看原始视频和剪辑视频，以便对比和管理不同版本。

#### Acceptance Criteria

1. THE MyGalleryPage SHALL 将视频内容分为"原始视频"和"剪辑视频"两栏展示
2. WHEN 视频存在 compiled_path, THE MyGalleryPage SHALL 在"剪辑视频"栏中展示该编译后的视频
3. THE MyGalleryPage SHALL 在"原始视频"栏中展示所有 media_type 为 video 的原始上传视频
4. WHEN media_source 为 merged, THE MyGalleryPage SHALL 在"剪辑视频"栏中展示该合并视频

### Requirement 3: 公开画廊仅展示剪辑视频

**User Story:** 作为访客，我希望在公开画廊中只看到经过剪辑的精华视频，获得更好的观看体验。

#### Acceptance Criteria

1. THE GalleryPage SHALL 仅展示具有 compiled_path 的视频的剪辑版本，不展示原始视频
2. WHEN 视频没有 compiled_path, THE GalleryPage SHALL 不展示该视频
3. WHEN media_source 为 merged, THE GalleryPage SHALL 将合并视频与其他剪辑视频一起展示
4. THE GalleryPage SHALL 使用 compiled_path 作为视频播放源地址

### Requirement 4: 多视频合并功能

**User Story:** 作为用户，我希望选择多个剪辑后的视频合并为一个新视频，以便创建完整的旅行回顾。

#### Acceptance Criteria

1. THE System SHALL 允许用户从多个相册中选择已编译的视频（具有 compiled_path 的视频）进行合并
2. WHEN 用户发起合并请求, THE MergeEngine SHALL 将选中的多个 CompiledVideo 按指定顺序拼接为一个新视频文件
3. WHEN 合并完成, THE System SHALL 创建一条新的 media_items 记录，media_source 字段设置为 merged
4. THE System SHALL 保留所有源视频不变，合并操作不修改或删除原始 MediaItem 记录

### Requirement 5: 合并视频命名

**User Story:** 作为用户，我希望为合并视频自定义名称，以便后续识别和管理。

#### Acceptance Criteria

1. THE System SHALL 允许用户在发起合并时指定视频名称
2. IF 用户未提供名称, THEN THE System SHALL 使用"相册名称+随机数"作为默认名称
3. THE System SHALL 将合并视频名称存储在 media_items.original_filename 字段中

### Requirement 6: 合并视频源关系记录

**User Story:** 作为用户，我希望系统记录合并视频的来源，以便追溯合并视频由哪些剪辑视频组成。

#### Acceptance Criteria

1. WHEN 合并视频创建成功, THE System SHALL 在关联表中记录该合并视频与所有源视频的对应关系
2. THE System SHALL 记录源视频在合并结果中的排列顺序
3. THE System SHALL 支持一个源视频被多个合并视频引用

### Requirement 7: 合并视频生命周期管理

**User Story:** 作为用户，我希望合并视频只能手动删除，不会被系统自动清理，以保证我的创作成果安全。

#### Acceptance Criteria

1. THE System SHALL 仅允许通过用户手动操作删除合并视频
2. THE Pipeline SHALL 在自动处理流程中跳过 media_source 为 merged 的 MediaItem，不对合并视频执行分析或重新编译
3. WHEN 源视频被删除, THE System SHALL 保留合并视频不受影响
