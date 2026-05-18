# Implementation Plan: Audio Library

## Overview

为旅行相册项目添加音频库功能，允许用户管理背景音乐并将其应用到自动剪辑的视频中。实现采用后处理混音策略：先完成视频编译（静音原始音频），再作为独立步骤将背景音乐混入。实现涵盖数据库扩展、后端服务（AudioService + AudioMixer）、API 路由、以及前端组件（AudioLibraryPanel、AudioPicker、WaveformTrimmer）。

## Tasks

- [x] 1. Database Schema — audio_tracks 表和 media_items 扩展
  - [x] 1.1 Create audio_tracks table and media_items extensions
    - 在 `server/src/database.ts` 的 `initTables` 函数中添加 `audio_tracks` 表创建语句（含 id, user_id, title, file_path, format, duration, file_size, source, source_url, created_at 字段、CHECK 约束和 user_id 索引）
    - 为 `media_items` 表添加 `audio_track_id`, `audio_trim_start`, `audio_trim_end` 列（使用 ALTER TABLE ADD COLUMN IF NOT EXISTS 模式）
    - _Requirements: 2.3, 4.1, 5.2_

  - [x] 1.2 Create AudioTrackRow interface and conversion helper
    - 创建 `server/src/helpers/audioTrackRow.ts`，定义 AudioTrackRow 接口和 rowToAudioTrack 转换函数
    - _Requirements: 4.2_

- [x] 2. Audio Service — 音频上传、下载、管理
  - [x] 2.1 Implement audio file validation
    - 创建 `server/src/services/audioService.ts`，实现 `validateAudioFile` 函数
    - 检查格式（MP3/AAC/WAV/OGG MIME types）和大小（≤ 52,428,800 bytes）
    - 使用 ffprobe 验证文件确实是有效音频
    - _Requirements: 2.1, 2.2, 2.5, 3.2, 3.4_

  - [x]* 2.2 Write property tests for audio validation
    - **Property 2: File size validation**
    - **Property 3: Invalid file rejection**
    - **Validates: Requirements 2.2, 2.5, 3.4**

  - [x] 2.3 Implement audio metadata extraction
    - 实现 `extractAudioMetadata` 函数，使用 ffprobe 提取音频时长、格式、标题
    - 标题提取逻辑：优先 ID3 tags/Vorbis comments，回退到文件名（去扩展名）
    - _Requirements: 2.4, 3.5_

  - [x] 2.4 Implement saveAudioTrack and downloadAudioFromUrl
    - 实现 `saveAudioTrack`：保存文件到 StorageProvider（路径 `audio/{userId}/{trackId}.{ext}`），创建数据库记录
    - 实现 `downloadAudioFromUrl`：下载 URL 内容，验证格式和大小，提取标题，保存
    - _Requirements: 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.5 Implement deleteAudioTrack, listUserTracks, getTrackById
    - 实现删除（移除 StorageProvider 文件 + 数据库记录）
    - 实现列表查询（按 user_id 过滤）和单条查询
    - _Requirements: 4.1, 4.2, 4.3_

  - [x]* 2.6 Write property test for user track isolation
    - **Property 5: User track isolation**
    - **Validates: Requirements 4.1, 4.2**

  - [x] 2.7 Implement generateWaveformData
    - 使用 ffmpeg 生成约200个归一化振幅值（0-1）
    - _Requirements: 7.6_

- [x] 3. Audio Mixer — 音频混音服务
  - [x] 3.1 Implement AudioMixer with auto-trim mode
    - 创建 `server/src/services/audioMixer.ts`，定义 AudioMixOptions 接口
    - 实现 `mixAudioToVideo` 自动裁剪：音频 ≥ 视频时截断，音频 < 视频时循环（-stream_loop -1）
    - 应用1秒淡入 + 2秒淡出
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 3.2 Implement manual trim mode and calculateTrimWindow
    - 实现 `calculateTrimWindow`：根据 startPoint/endPoint 计算裁剪窗口
    - 设置 start → end = start + videoDuration；设置 end → start = end - videoDuration
    - 约束：start ≥ 0, end ≤ audioDuration, duration = videoDuration
    - 实现手动裁剪模式的 ffmpeg 命令构建
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 3.3 Write property tests for AudioMixer
    - **Property 1: Volume level constraint**
    - **Property 6: Auto-trim output duration matches video**
    - **Property 7: Fade effects always applied**
    - **Property 9: Manual trim window calculation and constraints**
    - **Validates: Requirements 1.2, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5**

  - [x] 3.4 Implement original audio volume control
    - 支持 originalAudioVolume 参数（0-0.2），默认为0（静音）
    - 构建 ffmpeg filter chain：amix 混合原始音频和背景音乐
    - _Requirements: 1.2_

- [x] 4. Checkpoint — Database and services verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Video Compiler 修改 — 默认静音原始音频
  - [x] 5.1 Modify concatenateSegments to mute original audio
    - 修改 `server/src/services/videoEditor.ts` 中 `concatenateSegments` 函数
    - 在 outputOptions 中添加 `-af volume=0` 使原始音频默认静音
    - 处理无音频流时的兼容情况
    - _Requirements: 1.1, 1.3_

  - [x] 5.2 Modify concatenateWithTransitions to mute original audio
    - 修改 `concatenateWithTransitions` 函数中的音频处理，同样默认静音
    - _Requirements: 1.1, 1.3_

- [x] 6. Audio API Routes
  - [x] 6.1 Create audio routes with upload endpoint
    - 创建 `server/src/routes/audio.ts`，配置 multer 中间件
    - 实现 `POST /api/audio/upload`：接收 multipart/form-data，调用 audioService.saveAudioTrack
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 6.2 Implement download, list, stream, delete, and waveform endpoints
    - `POST /api/audio/download`：接收 URL，调用 downloadAudioFromUrl
    - `GET /api/audio`：返回当前用户所有音频列表
    - `GET /api/audio/:id/stream`：流式返回音频文件用于预览
    - `DELETE /api/audio/:id`：验证所有权后删除
    - `POST /api/audio/:id/waveform`：返回波形数据数组
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.3, 4.4, 7.6_

  - [x] 6.3 Implement apply-audio and remove-audio endpoints
    - `POST /api/media/:id/apply-audio`：下载音频和视频到临时文件，调用 audioMixer.mixAudioToVideo，上传结果，更新 media_items
    - `DELETE /api/media/:id/applied-audio`：移除背景音乐，清除 audio_track_id/trim 字段
    - _Requirements: 5.2, 5.3, 5.4, 6.1, 6.5_

  - [x] 6.4 Register audio routes in server entry point
    - 在 `server/src/index.ts` 中注册 audio 路由
    - _Requirements: 2.3, 3.1_

  - [x]* 6.5 Write unit tests for audio API routes
    - Test request validation, auth checks, error responses with mocked services
    - _Requirements: 2.5, 3.3_

- [x] 7. Checkpoint — Backend complete verification
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Frontend — AudioLibraryPanel 组件
  - [x] 8.1 Create AudioLibraryPanel component
    - 创建 `client/src/components/AudioLibraryPanel.tsx`
    - 实现音频列表展示（标题、时长、格式、日期）
    - 实现音频预览播放（HTML5 Audio 元素，播放/暂停控制）
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 8.2 Implement upload and URL download in AudioLibraryPanel
    - 文件选择器：支持 .mp3/.aac/.wav/.ogg，max 50MB
    - URL 下载：输入框 + 下载按钮
    - 删除功能：确认对话框 + API 调用
    - _Requirements: 2.1, 2.2, 3.1, 4.3_

- [x] 9. Frontend — AudioPicker 和 WaveformTrimmer 组件
  - [x] 9.1 Create AudioPicker component
    - 创建 `client/src/components/AudioPicker.tsx`
    - 在视频编辑界面展示音频选择列表
    - "Apply" 按钮调用 POST /api/media/:id/apply-audio
    - "Remove" 按钮调用 DELETE /api/media/:id/applied-audio
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 9.2 Create WaveformTrimmer component
    - 创建 `client/src/components/WaveformTrimmer.tsx`
    - 使用 Canvas 渲染波形数据（200个振幅条）
    - 可拖动起始点标记，自动计算结束点（start + videoDuration）
    - 高亮选中区间，约束 start ≥ 0, end ≤ audioDuration
    - _Requirements: 7.1, 7.2, 7.3, 7.6_

  - [x] 9.3 Integrate WaveformTrimmer into AudioPicker
    - 手动裁剪模式时显示 WaveformTrimmer
    - 将 trim 参数传递给 apply-audio API
    - _Requirements: 7.1, 7.5_

- [x] 10. Frontend — 集成到 MyGalleryPage
  - [x] 10.1 Add AudioPicker to video detail view
    - 在 `client/src/pages/MyGalleryPage.tsx` 的视频详情视图中添加 AudioPicker 组件
    - 显示当前背景音乐状态（已选择/未选择）
    - _Requirements: 5.1, 5.2_

  - [x] 10.2 Add AudioLibraryPanel entry point
    - 添加"音频库"标签页或侧边栏入口，展示 AudioLibraryPanel
    - 处理音频应用后的视频刷新（重新加载 compiledPath）
    - _Requirements: 4.1, 5.3_

- [x] 11. Final checkpoint — Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses a post-processing mix strategy: video compilation happens first (with muted audio), then background music is mixed in as a separate step
- All file operations use temp files + atomic rename pattern to prevent corruption
- ffmpeg/ffprobe are required runtime dependencies

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.5", "2.7"] },
    { "id": 3, "tasks": ["2.6", "3.1"] },
    { "id": 4, "tasks": ["3.2", "3.4", "5.1", "5.2"] },
    { "id": 5, "tasks": ["3.3", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4"] },
    { "id": 7, "tasks": ["6.5"] },
    { "id": 8, "tasks": ["8.1", "8.2"] },
    { "id": 9, "tasks": ["9.1", "9.2"] },
    { "id": 10, "tasks": ["9.3", "10.1"] },
    { "id": 11, "tasks": ["10.2"] }
  ]
}
```
