# Requirements Document

## Introduction

旅行相册项目的"音频库"功能。当前自动剪辑生成的视频由多个2秒片段拼接而成，原始音频在片段切换时产生突兀的断裂感。本功能引入音频库管理和背景音乐替换机制，让用户可以为编辑后的视频选择合适的背景音乐，自动或手动裁剪音频以匹配视频长度，从而产出音画协调的成品视频。

## Glossary

- **Audio_Library**: 音频库，用户管理背景音乐文件的集合，包含从网络下载和本地上传的音频
- **Audio_Track**: 音频轨道，单个音频文件在音频库中的记录，包含元数据（标题、时长、文件路径等）
- **Video_Compiler**: 视频编译器，负责将选定片段拼接为成品视频的服务模块（现有 videoEditor.ts）
- **Audio_Trimmer**: 音频裁剪器，负责将音频裁剪至匹配视频长度并添加淡入淡出效果的处理模块
- **Fade_Effect**: 淡入淡出效果，音频开头渐强（fade-in）和结尾渐弱（fade-out）的过渡处理
- **Storage_Provider**: 存储提供者，项目中已有的 S3 存储抽象层，用于持久化音频文件
- **Original_Audio**: 原始音频，视频片段中自带的环境声音
- **Compilation**: 编译成品，由多个视频片段拼接并配上背景音乐后生成的最终视频文件

## Requirements

### Requirement 1: 自动剪辑时静音原始音频

**User Story:** As a 用户, I want 自动剪辑生成的视频将原始音频静音或降至极低音量, so that 片段切换时不会产生突兀的音频断裂

#### Acceptance Criteria

1. WHEN the Video_Compiler concatenates segments into a Compilation, THE Video_Compiler SHALL mute the Original_Audio of each segment by default
2. WHERE a user has selected a volume level for Original_Audio, THE Video_Compiler SHALL mix the Original_Audio at the specified volume level (range 0% to 20%)
3. WHEN no background music is selected, THE Video_Compiler SHALL still mute the Original_Audio in the Compilation

### Requirement 2: 音频文件上传

**User Story:** As a 用户, I want 上传本地音频文件到音频库, so that 我可以使用自己的音乐作为视频背景音乐

#### Acceptance Criteria

1. WHEN a user uploads an audio file, THE Audio_Library SHALL accept files in MP3, AAC, WAV, and OGG formats
2. WHEN a user uploads an audio file, THE Audio_Library SHALL validate that the file size does not exceed 50MB
3. WHEN a user uploads an audio file, THE Audio_Library SHALL store the file via the Storage_Provider and create an Audio_Track record
4. WHEN a user uploads an audio file, THE Audio_Library SHALL extract and store metadata including title, duration, and file format
5. IF an uploaded file is not a valid audio file, THEN THE Audio_Library SHALL reject the upload and return a descriptive error message

### Requirement 3: 从网络下载背景音乐

**User Story:** As a 用户, I want 通过提供URL从网络下载背景音乐到音频库, so that 我可以方便地获取在线音乐资源

#### Acceptance Criteria

1. WHEN a user provides a valid audio URL, THE Audio_Library SHALL download the file and create an Audio_Track record
2. WHEN a user provides a URL, THE Audio_Library SHALL validate that the downloaded content is a supported audio format (MP3, AAC, WAV, OGG)
3. IF the download fails or the URL is unreachable, THEN THE Audio_Library SHALL return a descriptive error message indicating the failure reason
4. IF the downloaded file exceeds 50MB, THEN THE Audio_Library SHALL reject the download and inform the user of the size limit
5. WHEN downloading from a URL, THE Audio_Library SHALL extract the audio title from the file metadata or the URL filename

### Requirement 4: 音频库管理

**User Story:** As a 用户, I want 查看和管理我的音频库, so that 我可以浏览已有音频并删除不需要的文件

#### Acceptance Criteria

1. THE Audio_Library SHALL display a list of all Audio_Track records belonging to the current user
2. WHEN displaying an Audio_Track, THE Audio_Library SHALL show the title, duration, format, and upload date
3. WHEN a user requests deletion of an Audio_Track, THE Audio_Library SHALL remove the file from the Storage_Provider and delete the database record
4. THE Audio_Library SHALL support audio preview playback directly in the library interface

### Requirement 5: 为视频选择背景音乐

**User Story:** As a 用户, I want 在编辑视频时从音频库选择一首背景音乐, so that 我的视频成品有合适的配乐

#### Acceptance Criteria

1. WHEN a user is editing a video compilation, THE Audio_Library SHALL present the list of available Audio_Track records for selection
2. WHEN a user selects an Audio_Track for a video, THE Video_Compiler SHALL replace the Original_Audio with the selected Audio_Track in the Compilation
3. WHEN a user changes the selected Audio_Track, THE Video_Compiler SHALL regenerate the Compilation with the new audio
4. THE Audio_Library SHALL allow the user to deselect background music and revert to muted Original_Audio

### Requirement 6: 音频自动裁剪

**User Story:** As a 用户, I want 背景音乐自动裁剪以匹配视频长度, so that 音乐和视频时长完美同步

#### Acceptance Criteria

1. WHEN an Audio_Track is applied to a Compilation, THE Audio_Trimmer SHALL automatically trim the audio to match the video duration
2. WHEN the Audio_Track duration exceeds the video duration, THE Audio_Trimmer SHALL truncate the audio at the video end point
3. WHEN the Audio_Track duration is shorter than the video duration, THE Audio_Trimmer SHALL loop the audio to fill the video duration
4. THE Audio_Trimmer SHALL apply a Fade_Effect with a 1-second fade-in at the start and a 2-second fade-out at the end of the trimmed audio
5. WHEN auto-trimming is applied, THE Audio_Trimmer SHALL preserve the original Audio_Track file without modification

### Requirement 7: 音频手动裁剪

**User Story:** As a 用户, I want 手动设置音频的起始点来选择音乐片段, so that 我可以选择音乐中最合适的部分作为背景音乐

#### Acceptance Criteria

1. WHEN a user sets a start point for an Audio_Track, THE Audio_Trimmer SHALL automatically calculate the end point as start point plus the video duration
2. WHEN a user sets an end point for an Audio_Track, THE Audio_Trimmer SHALL automatically calculate the start point as end point minus the video duration
3. THE Audio_Trimmer SHALL constrain the trim range so that the start point is not less than zero and the end point does not exceed the Audio_Track total duration
4. THE Audio_Trimmer SHALL fix the trim duration to equal the Compilation video duration
5. WHEN manual trim points are set, THE Audio_Trimmer SHALL apply the Fade_Effect to the selected portion
6. THE Audio_Trimmer SHALL display a waveform visualization to assist the user in selecting the start point
