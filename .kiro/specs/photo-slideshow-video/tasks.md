# Implementation Plan: Photo Slideshow Video

## Overview

实现照片幻灯片视频生成功能：用户在 MyGalleryPage 多选照片后，通过后端 ffmpeg 将照片按顺序拼接为幻灯片视频（每张 2 秒），可选配背景音乐，输出可下载/预览的 MP4 文件。采用 SSE 流式进度报告，前端通过 SlideshowDialog 组件完成交互。

## Tasks

- [x] 1. Database migration and SlideshowGenerator service
  - [x] 1.1 Add slideshow_jobs table migration in `server/src/database.ts`
    - Add `CREATE TABLE IF NOT EXISTS slideshow_jobs` with all columns (id, trip_id, user_id, status, photo_ids, audio_track_id, output_path, total_duration, skipped_photos, error_message, percent, created_at, completed_at)
    - Add indexes on trip_id and user_id
    - _Requirements: 2.3, 6.1, 6.2_

  - [x] 1.2 Implement `SlideshowGenerator` service in `server/src/services/slideshowGenerator.ts`
    - Implement `calculateOutputResolution` — find max dimensions, cap at 1920x1080, ensure even numbers
    - Implement `buildSlideshowArgs` — construct ffmpeg filter_complex with scale+pad+concat per photo
    - Implement `buildAudioMixArgs` — handle loop vs truncate based on audio/video duration comparison
    - Implement `generateSlideshow` — validate photos, spawn ffmpeg, parse progress from stderr, handle timeout (5 min), mix audio if provided
    - Use `child_process.spawn` pattern consistent with existing `ffmpegCompiler.ts`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 7.1, 7.2, 7.3_

  - [ ]* 1.3 Write property test for photo order preservation
    - **Property 1: Photo order preservation**
    - **Validates: Requirements 3.1**

  - [ ]* 1.4 Write property test for total duration calculation
    - **Property 2: Total duration equals photo count times 2 seconds**
    - **Validates: Requirements 3.2**

  - [ ]* 1.5 Write property test for output resolution scaling and capping
    - **Property 3: Output resolution scaling and capping**
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 1.6 Write property test for audio duration matching
    - **Property 4: Audio duration matches video duration**
    - **Validates: Requirements 4.2, 4.3**

  - [ ]* 1.7 Write property test for missing photo graceful degradation
    - **Property 6: Missing photo graceful degradation**
    - **Validates: Requirements 7.2, 7.3**

- [x] 2. Slideshow API route with SSE progress
  - [x] 2.1 Implement slideshow route in `server/src/routes/slideshow.ts`
    - POST `/api/slideshow/generate` — validate auth, trip ownership, photoIds (>= 2, belong to trip, image type), optional audioTrackId
    - Establish SSE connection with proper headers (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive)
    - Create slideshow_jobs record, invoke SlideshowGenerator with onProgress callback
    - Send SSE events: progress (percent), complete (videoUrl, videoId, duration), error (message), heartbeat
    - Handle concurrent request rejection (409 if job already running for same trip)
    - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 6.1, 6.2, 6.3, 7.4_

  - [x] 2.2 Implement download endpoint in `server/src/routes/slideshow.ts`
    - GET `/api/slideshow/:jobId/download` — verify ownership, serve MP4 with Content-Disposition attachment header
    - Support Range requests for iOS Safari compatibility (same pattern as compile download)
    - _Requirements: 5.1, 5.3_

  - [x] 2.3 Register slideshow route in `server/src/index.ts`
    - Import and mount slideshow router at `/api/slideshow`
    - _Requirements: 2.3_

  - [ ]* 2.4 Write unit tests for slideshow route validation logic
    - Test photo count validation (< 2 returns 400)
    - Test invalid photo ID detection
    - Test trip ownership check (403 for non-owner)
    - Test concurrent job rejection (409)
    - _Requirements: 2.1, 2.2, 2.4, 7.4_

- [x] 3. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Frontend SlideshowDialog component
  - [x] 4.1 Create `SlideshowDialog` component in `client/src/components/SlideshowDialog.tsx`
    - Props: tripId, photoIds, onClose, onComplete
    - Step 1: Audio selection UI — reuse AudioLibraryPanel in selectable mode, plus "不加音乐" button
    - Step 2: Progress display — connect to SSE endpoint, show progress bar with percent
    - Step 3: Complete state — show video preview (HTML5 video element) and download button
    - Error state: show error message and retry button
    - _Requirements: 1.2, 1.4, 4.1, 4.4, 5.2, 5.4, 6.1, 6.2, 6.3, 7.4_

  - [x] 4.2 Add "生成幻灯片视频" button to MyGalleryPage multi-select toolbar
    - Show button in bottom action bar when `multiSelectMode && selectedIds.size >= 2`
    - Filter selectedIds to only include image-type media items
    - On click, open SlideshowDialog with tripId and filtered photo IDs
    - Disable button while slideshow is generating
    - _Requirements: 1.1, 1.3_

  - [x] 4.3 Wire SlideshowDialog completion to MyGalleryPage
    - On complete callback: close dialog, optionally show success toast
    - Handle download via browser download trigger (window.open or anchor click)
    - _Requirements: 5.2, 5.4_

  - [ ]* 4.4 Write unit tests for SlideshowDialog component
    - Test audio selection step renders correctly
    - Test progress display updates from SSE mock
    - Test complete state shows preview and download button
    - Test error state shows retry button
    - _Requirements: 1.2, 1.4, 5.2, 7.4_

- [x] 5. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses TypeScript throughout (Express backend + React/Vite frontend)
- ffmpeg interaction follows the existing `ffmpegCompiler.ts` / `compilationEngine.ts` pattern
- SSE pattern is new for this project (compile route uses polling); follow standard Express SSE setup
- AudioLibraryPanel already exists and supports selectable mode for audio picking

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5", "1.6", "1.7", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3"] },
    { "id": 6, "tasks": ["4.4"] }
  ]
}
```
