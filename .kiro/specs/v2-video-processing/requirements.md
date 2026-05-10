# Requirements Document

## Introduction

本 spec 覆盖 v2 智能媒体处理系统的第三阶段：视频处理增强。在第一阶段（v2-schema-foundation）完成数据库 schema 增强、第二阶段（v2-image-processing）完成色偏检测和 AI Provider 抽象的基础上，本阶段聚焦四个核心能力：

1. **黑帧检测（Black Frame Detection）** — 检测并标记以黑帧为主的片段（镜头盖未取下、录制意外开始/结束）
2. **垃圾片段识别（Junk Clip Identification）** — 检测"垃圾"片段（拍地面、误触、极端运动模糊、极短片段 < 1s）
3. **音频归一化（Audio Normalization）** — 在合成前对各片段音频电平进行归一化，确保一致的音量
4. **多版本输出（Multi-Version Output）** — 从同一源素材生成多个不同时长的输出版本（30s 精华、1min 摘要、5min 完整剪辑）

当前系统已有的视频处理能力：
- 视频上传（分块）、元数据提取（ffprobe）、代理视频生成
- 场景检测与分割、逐片段质量评分（清晰度/稳定性/曝光 三维度）
- 片段选择 + 合成、过渡效果（硬切 + 音频平滑）

本阶段在此基础上增加更智能的片段过滤（黑帧 + 垃圾片段）、音频一致性处理、以及多版本输出能力。

## Glossary

- **Black_Frame_Detector**: 黑帧检测服务，分析视频片段中黑帧占比并标记为黑帧片段
- **Junk_Clip_Detector**: 垃圾片段检测服务，综合分析运动模糊、拍摄方向、时长等特征识别无用片段
- **Audio_Normalizer**: 音频归一化服务，分析并调整各片段音频电平至统一目标响度
- **Multi_Version_Generator**: 多版本生成器，根据不同时长目标从源素材生成多个剪辑版本
- **Video_Segment**: 视频片段，由场景检测分割产生的基本处理单元
- **Black_Frame_Ratio**: 黑帧占比，片段中亮度低于阈值的帧数与总帧数之比
- **Loudness_LUFS**: 响度单位（Loudness Units Full Scale），音频响度的国际标准度量
- **Target_Loudness**: 目标响度，归一化后所有片段应达到的统一 LUFS 值
- **Version_Profile**: 版本配置，定义输出版本的目标时长、片段选择策略等参数
- **Media_Versions_Table**: media_versions 数据库表，存储生成的多版本输出记录
- **Media_Analysis_Table**: media_analysis 数据库表，存储黑帧检测和垃圾片段分析结果
- **Junk_Reason**: 垃圾片段原因枚举，包含 too_short、ground_shot、extreme_blur、accidental_touch
- **Overall_Brightness**: 帧整体亮度，灰度图像所有像素的平均值


## Requirements

### Requirement 1: 黑帧检测算法

**User Story:** As a developer, I want a black frame detection algorithm that identifies segments dominated by black frames, so that the system can automatically exclude lens-cap or accidental start/end recordings.

#### Acceptance Criteria

1. WHEN a video segment file path and time range are provided, THE Black_Frame_Detector SHALL extract sample frames at regular intervals and compute the Overall_Brightness of each frame
2. WHEN the Overall_Brightness of a frame is below the black frame threshold (default 10), THE Black_Frame_Detector SHALL classify that frame as a black frame
3. WHEN the Black_Frame_Ratio of a segment exceeds 0.8 (80% of sampled frames are black), THE Black_Frame_Detector SHALL mark the segment as a black frame segment
4. THE Black_Frame_Detector SHALL sample at least 5 frames per segment, evenly distributed across the segment duration
5. WHEN a segment is shorter than 0.5 seconds, THE Black_Frame_Detector SHALL sample a minimum of 2 frames (start and end)
6. THE Black_Frame_Detector SHALL produce a numeric black_frame_score in the range [0.0, 1.0] where 0.0 indicates all frames are black and 1.0 indicates no black frames detected
7. IF a frame cannot be extracted (ffmpeg error), THEN THE Black_Frame_Detector SHALL skip that frame and continue with remaining samples without failing the entire segment analysis

### Requirement 2: 黑帧检测结果持久化

**User Story:** As a developer, I want black frame detection results stored in the media_analysis table, so that downstream services can filter black frame segments without re-analysis.

#### Acceptance Criteria

1. WHEN black frame detection completes for a video segment, THE Black_Frame_Detector SHALL write the black_frame_score and Black_Frame_Ratio to the media_analysis table
2. WHEN black frame detection completes, THE Black_Frame_Detector SHALL store the detection details (sampled frame count, black frame count, threshold used) in the media_analysis table's reason column as structured JSON
3. IF a media_analysis record already exists for the segment, THEN THE Black_Frame_Detector SHALL update the existing record rather than creating a duplicate

### Requirement 3: 垃圾片段识别算法

**User Story:** As a developer, I want a junk clip detection algorithm that identifies useless video segments, so that the system can exclude them from the final composition.

#### Acceptance Criteria

1. WHEN a video segment duration is less than 1.0 second, THE Junk_Clip_Detector SHALL classify the segment as junk with reason "too_short"
2. WHEN the average motion vector magnitude of a segment exceeds the extreme motion threshold (default 80), THE Junk_Clip_Detector SHALL classify the segment as junk with reason "extreme_blur"
3. WHEN the dominant motion direction of a segment is consistently downward (pitch angle > 60 degrees from horizontal) across more than 70% of sampled frames, THE Junk_Clip_Detector SHALL classify the segment as junk with reason "ground_shot"
4. WHEN a segment exhibits sudden high-magnitude motion followed by immediate stillness within 0.5 seconds, THE Junk_Clip_Detector SHALL classify the segment as junk with reason "accidental_touch"
5. THE Junk_Clip_Detector SHALL produce a boolean is_junk flag and an optional Junk_Reason for each analyzed segment
6. WHEN multiple junk conditions are detected simultaneously, THE Junk_Clip_Detector SHALL report the first matching reason in priority order: too_short, extreme_blur, ground_shot, accidental_touch
7. THE Junk_Clip_Detector SHALL compute a junk_confidence score in the range [0.0, 1.0] indicating confidence in the junk classification


### Requirement 4: 垃圾片段检测结果持久化

**User Story:** As a developer, I want junk clip detection results stored in the media_analysis table, so that the editing pipeline can exclude junk clips during segment selection.

#### Acceptance Criteria

1. WHEN junk clip detection completes for a video segment, THE Junk_Clip_Detector SHALL write the is_junk flag, Junk_Reason, and junk_confidence to the media_analysis table
2. WHEN junk clip detection completes, THE Junk_Clip_Detector SHALL store the detection details (motion magnitude, pitch angle, duration) in the media_analysis table's reason column as structured JSON
3. IF a media_analysis record already exists for the segment, THEN THE Junk_Clip_Detector SHALL update the existing record rather than creating a duplicate

### Requirement 5: 片段选择集成黑帧和垃圾片段过滤

**User Story:** As a developer, I want the segment selection algorithm to automatically exclude black frame and junk segments, so that only meaningful content is included in the final composition.

#### Acceptance Criteria

1. WHEN selecting segments for composition, THE Video_Editor SHALL exclude all segments marked as black frame segments (Black_Frame_Ratio > 0.8)
2. WHEN selecting segments for composition, THE Video_Editor SHALL exclude all segments marked as junk (is_junk = true)
3. WHEN all segments are excluded by black frame and junk detection, THE Video_Editor SHALL return an error indicating no valid segments remain
4. THE Video_Editor SHALL apply black frame and junk filtering before the existing quality-based segment selection (sharpness/stability/exposure scoring)

### Requirement 6: 音频响度分析

**User Story:** As a developer, I want to analyze the loudness of each video segment, so that the system can normalize audio levels before composition.

#### Acceptance Criteria

1. WHEN a video segment file path is provided, THE Audio_Normalizer SHALL measure the integrated loudness in LUFS using ffmpeg loudnorm filter analysis
2. WHEN loudness analysis completes, THE Audio_Normalizer SHALL report the measured loudness (integrated LUFS), loudness range (LRA), and true peak (dBTP) for the segment
3. IF a segment has no audio stream, THEN THE Audio_Normalizer SHALL skip the segment and report it as "no_audio"
4. IF loudness measurement fails (corrupt audio, unsupported codec), THEN THE Audio_Normalizer SHALL log the error and assign a default loudness of -23 LUFS for that segment

### Requirement 7: 音频归一化处理

**User Story:** As a developer, I want audio levels normalized across all segments before composition, so that the final video has consistent volume throughout.

#### Acceptance Criteria

1. THE Audio_Normalizer SHALL use a Target_Loudness of -16 LUFS (configurable via environment variable AUDIO_TARGET_LUFS)
2. WHEN normalizing a segment, THE Audio_Normalizer SHALL apply the ffmpeg loudnorm filter in linear mode to adjust the segment to the Target_Loudness
3. WHEN normalizing a segment, THE Audio_Normalizer SHALL limit the true peak to -1.5 dBTP to prevent clipping
4. WHEN the measured loudness of a segment is within 1 LUFS of the Target_Loudness, THE Audio_Normalizer SHALL skip normalization for that segment to avoid unnecessary re-encoding
5. THE Audio_Normalizer SHALL preserve the original audio codec and sample rate when possible, falling back to AAC 48kHz when re-encoding is required
6. WHEN normalizing multiple segments for composition, THE Audio_Normalizer SHALL process all segments to the same Target_Loudness before concatenation

### Requirement 8: 音频归一化集成到编辑流水线

**User Story:** As a developer, I want audio normalization integrated into the video editing pipeline, so that it happens automatically during composition without manual intervention.

#### Acceptance Criteria

1. WHEN the video editor composes selected segments, THE Audio_Normalizer SHALL normalize all segments with audio before concatenation
2. WHEN audio normalization is applied, THE Video_Editor SHALL use the normalized audio files in place of the original segment audio during composition
3. IF audio normalization fails for a segment, THEN THE Video_Editor SHALL use the original audio for that segment and continue composition
4. THE Video_Editor SHALL report which segments were normalized and which used original audio in the edit result metadata


### Requirement 9: 多版本输出配置

**User Story:** As a developer, I want to define multiple output version profiles with different target durations, so that the system can generate highlight reels and summaries from the same source material.

#### Acceptance Criteria

1. THE Multi_Version_Generator SHALL support three predefined Version_Profile types: "highlight" (30s), "summary" (60s), "full_edit" (300s)
2. WHEN a Version_Profile target duration exceeds the source video duration, THE Multi_Version_Generator SHALL skip that profile and not generate that version
3. THE Multi_Version_Generator SHALL allow custom Version_Profile definitions with arbitrary target durations via API parameters
4. WHEN generating a version, THE Multi_Version_Generator SHALL use the same segment quality scoring and selection algorithm as the existing editor, parameterized by the profile's target duration
5. THE Multi_Version_Generator SHALL select segments independently for each version profile, allowing different segments to appear in different versions

### Requirement 10: 多版本输出生成

**User Story:** As a developer, I want the system to generate multiple output versions from the same analyzed source video, so that users get different length options without re-uploading or re-analyzing.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/media/:mediaId/versions with a list of Version_Profile types, THE Multi_Version_Generator SHALL generate one output file per requested profile
2. WHEN a version is generated, THE Multi_Version_Generator SHALL create a media_versions record with version_type set to the profile name (e.g., "highlight", "summary", "full_edit")
3. WHEN generating multiple versions, THE Multi_Version_Generator SHALL apply black frame filtering, junk clip filtering, and audio normalization to all versions
4. WHEN all requested versions are generated, THE Multi_Version_Generator SHALL return a summary including each version's file path, duration, segment count, and file size
5. IF a version generation fails, THEN THE Multi_Version_Generator SHALL continue generating remaining versions and include the failure in the result summary
6. WHILE a multi-version generation is in progress for a media item, THE Multi_Version_Generator SHALL reject additional generation requests for the same media item with status 409

### Requirement 11: 多版本输出片段选择策略

**User Story:** As a developer, I want each version profile to use an appropriate segment selection strategy, so that shorter versions contain the best highlights while longer versions provide more comprehensive coverage.

#### Acceptance Criteria

1. WHEN generating a "highlight" version (30s), THE Multi_Version_Generator SHALL select segments strictly by highest overall quality score, prioritizing visual impact
2. WHEN generating a "summary" version (60s), THE Multi_Version_Generator SHALL balance quality score with temporal coverage, ensuring segments are distributed across the video timeline
3. WHEN generating a "full_edit" version (300s), THE Multi_Version_Generator SHALL include all non-junk, non-black-frame segments that pass minimum quality thresholds
4. FOR ALL version profiles, THE Multi_Version_Generator SHALL maintain chronological order of selected segments in the output
5. FOR ALL version profiles, THE Multi_Version_Generator SHALL apply the existing adjacency-aware selection logic when choosing between segments of similar quality

### Requirement 12: 批量视频增强处理

**User Story:** As a developer, I want to run the complete video enhancement pipeline (black frame detection, junk detection, audio normalization, multi-version output) on all videos in a trip, so that the entire album is processed consistently.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/trips/:tripId/video-enhance, THE system SHALL run the full enhancement pipeline on all video media items in the trip
2. WHEN batch processing is triggered, THE system SHALL execute the pipeline stages in order: black frame detection, junk clip detection, audio normalization, multi-version generation
3. WHEN batch processing completes, THE system SHALL return a summary including total videos processed, versions generated per video, and any errors encountered
4. WHEN an individual video fails during batch processing, THE system SHALL continue processing remaining videos and include the failure in the error summary
5. THE system SHALL report progress updates during batch processing via the existing progress reporting infrastructure