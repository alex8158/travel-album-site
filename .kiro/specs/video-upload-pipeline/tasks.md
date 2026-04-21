# Implementation Plan: 视频上传链路重构

## Overview

Incrementally build the video upload pipeline: extend StorageProvider with multipart methods, implement local and S3 providers, add database schema, create upload routes, build proxy generator and cleanup services, then wire the frontend VideoUploader component into the existing upload flow.

## Tasks

- [x] 1. Extend StorageProvider interface and add database schema
  - [x] 1.1 Add multipart methods to StorageProvider interface in `server/src/storage/types.ts`
    - Add `initMultipartUpload`, `getPresignedPartUrl`, `completeMultipartUpload`, `abortMultipartUpload`, `listParts`, `getPresignedUploadUrl` method signatures
    - _Requirements: R7-AC1, R7-AC2, R7-AC3, R7-AC4, R7-AC5_

  - [x] 1.2 Add database migration for `upload_sessions` table and `media_items` columns
    - Create `upload_sessions` table with id, media_id, trip_id, storage_key, mode, status, total_parts, part_size, file_size, created_at, updated_at
    - Add columns to `media_items`: upload_id, upload_mode, storage_key, video_duration, video_width, video_height, video_codec, video_bitrate, preview_proxy_path, edit_proxy_path
    - Add indexes on upload_sessions(media_id) and upload_sessions(status)
    - _Requirements: R1-AC5, R10-AC2, R10-AC6_

  - [x] 1.3 Add `calculatePartSize` utility function in `server/src/services/uploadUtils.ts`
    - Implement part size logic: ≤10GB → 16–64MB range, >10GB → 128MB
    - _Requirements: R3-AC4_

  - [ ]* 1.4 Write property test for `calculatePartSize` (Property 5)
    - **Property 5: 分片大小计算在合法范围内**
    - Generate random file sizes, verify part size is within spec range
    - **Validates: R3-AC4**

- [x] 2. Implement LocalStorageProvider multipart methods
  - [x] 2.1 Implement `initMultipartUpload` in `server/src/storage/localProvider.ts`
    - Create `.tmp/uploads/{uploadId}/` directory, return uuid
    - _Requirements: R8-AC1_

  - [x] 2.2 Implement `getPresignedPartUrl` and `getPresignedUploadUrl` in LocalStorageProvider
    - Return server relay endpoint paths (not real presigned URLs)
    - `getPresignedPartUrl` → `/api/uploads/{mediaId}/parts/{partNumber}?uploadId={uploadId}`
    - `getPresignedUploadUrl` → `/api/uploads/{mediaId}/simple`
    - _Requirements: R8-AC5, R8-AC6_

  - [x] 2.3 Implement `completeMultipartUpload` in LocalStorageProvider
    - Read part files in partNumber order, stream-merge to target path, delete temp directory
    - _Requirements: R8-AC3, R5-AC4_

  - [x] 2.4 Implement `abortMultipartUpload` and `listParts` in LocalStorageProvider
    - `abortMultipartUpload`: delete `.tmp/uploads/{uploadId}/` directory and all part files
    - `listParts`: scan temp directory, return part file list with MD5 etag and size
    - _Requirements: R8-AC4, R16-AC3_

  - [ ]* 2.5 Write property test for LocalStorageProvider initMultipartUpload uniqueness (Property 10)
    - **Property 10: initMultipartUpload 返回唯一 uploadId**
    - Call multiple times, verify all uploadIds are unique and temp dirs exist
    - **Validates: R8-AC1**

  - [ ]* 2.6 Write property test for local part ETag = MD5 (Property 6)
    - **Property 6: 本地存储分片 ETag 等于内容 MD5**
    - Generate random binary data, write as part, verify returned ETag matches MD5
    - **Validates: R4-AC2**

  - [ ]* 2.7 Write property test for local part merge order (Property 7)
    - **Property 7: 本地存储分片合并保持顺序**
    - Generate random parts in random write order, complete, verify merged file equals ordered concatenation
    - **Validates: R5-AC4, R8-AC3**

- [x] 3. Checkpoint — LocalStorageProvider multipart
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement S3StorageProvider multipart methods and streaming save
  - [x] 4.1 Implement multipart methods in `server/src/storage/s3Provider.ts`
    - `initMultipartUpload`: CreateMultipartUploadCommand → return UploadId
    - `getPresignedPartUrl`: UploadPartCommand + getSignedUrl → presigned URL
    - `completeMultipartUpload`: CompleteMultipartUploadCommand with ETags
    - `abortMultipartUpload`: AbortMultipartUploadCommand
    - `listParts`: ListPartsCommand → return uploaded parts list
    - `getPresignedUploadUrl`: PutObjectCommand + getSignedUrl → presigned URL
    - _Requirements: R9-AC1, R9-AC2, R9-AC3, R9-AC4, R9-AC5_

  - [x] 4.2 Refactor S3StorageProvider `save()` to use `Upload` class from `@aws-sdk/lib-storage`
    - Replace buffering entire Readable into memory with streaming upload
    - _Requirements: R13-AC1, R13-AC3_

  - [ ]* 4.3 Write unit tests for S3StorageProvider multipart methods (mock AWS SDK)
    - Test init, presign, complete, abort, listParts with mocked S3Client
    - _Requirements: R9-AC1, R9-AC2, R9-AC3, R9-AC4, R9-AC5_

- [x] 5. Implement upload routes — `server/src/routes/uploads.ts`
  - [x] 5.1 Create `POST /api/uploads/init` endpoint
    - Validate video format (MP4, MOV, AVI, MKV only), return 400 for unsupported
    - Determine mode (simple ≤100MB, multipart >100MB)
    - Create media_items record (status=uploading) and upload_sessions record
    - Call StorageProvider initMultipartUpload or getPresignedUploadUrl based on mode
    - Return mediaId, storageKey, mode, uploadId, and presignedUrl or partSize/totalParts
    - _Requirements: R1-AC1, R1-AC2, R1-AC3, R1-AC4, R1-AC5, R14-AC1, R14-AC2_

  - [x] 5.2 Create `POST /api/uploads/:mediaId/parts/presign` endpoint
    - Validate uploadId matches DB record (409 if mismatch)
    - Return presigned URLs for each requested partNumber
    - Return 404 if mediaId not found or upload completed
    - _Requirements: R2-AC1, R2-AC2, R2-AC3, R18-AC1_

  - [x] 5.3 Create `PUT /api/uploads/:mediaId/parts/:partNumber` endpoint (local storage relay)
    - Stream part data to temp directory as `part_{partNumber}`
    - Return ETag (MD5 hash of part content)
    - Return 500 on disk write failure
    - Validate uploadId from query param (409 if mismatch)
    - _Requirements: R4-AC1, R4-AC2, R4-AC3, R18-AC4_

  - [ ] 5.3b Create `PUT /api/uploads/:mediaId/simple` endpoint (local storage simple relay)
    - Stream complete file to target path via StorageProvider.save()
    - Return ETag on success
    - _Requirements: R8-AC6_

  - [x] 5.4 Create `POST /api/uploads/:mediaId/complete` endpoint
    - Validate uploadId matches (409 if mismatch)
    - Validate parts list consistency (400 if mismatch)
    - Call StorageProvider completeMultipartUpload
    - Update media_items status to uploaded, create processing_jobs record
    - _Requirements: R5-AC1, R5-AC2, R5-AC3, R18-AC2_

  - [x] 5.5 Create `POST /api/uploads/:mediaId/finalize` endpoint
    - Validate uploadId matches, validate status is uploading (409 if not)
    - Update media_items status to uploaded, create processing_jobs record
    - Return 404 if mediaId not found
    - _Requirements: R15-AC1, R15-AC2, R15-AC3, R15-AC4_

  - [x] 5.6 Create `GET /api/uploads/:mediaId/status` endpoint
    - Return uploadId, mode, status, uploadedParts
    - For S3/OSS/COS: call ListParts API; for local: scan temp directory
    - _Requirements: R16-AC1, R16-AC2, R16-AC3_

  - [x] 5.7 Create `POST /api/uploads/:mediaId/abort` endpoint
    - Validate uploadId matches (409 if mismatch)
    - Call StorageProvider abortMultipartUpload
    - Update media_items status to cancelled
    - Return 404 if mediaId not found
    - _Requirements: R17-AC1, R17-AC2, R17-AC3, R18-AC3_

  - [x] 5.8 Register upload routes in `server/src/index.ts`
    - Mount uploads router at `/api/uploads`
    - _Requirements: R1-AC1_

  - [ ]* 5.9 Write property test for upload mode threshold (Property 1)
    - **Property 1: 上传模式由文件大小阈值决定**
    - Generate random file sizes, call init logic, verify mode matches threshold
    - **Validates: R1-AC1, R1-AC2, R1-AC3**

  - [ ]* 5.10 Write property test for unsupported format rejection (Property 2)
    - **Property 2: 不支持的文件格式被拒绝**
    - Generate random non-video extensions, verify 400 response
    - **Validates: R1-AC4**

  - [ ]* 5.11 Write property test for uploadId mismatch rejection (Property 12)
    - **Property 12: uploadId 不匹配时拒绝请求**
    - Generate mismatched uploadId pairs, verify 409 on presign/complete/abort
    - **Validates: R18-AC1, R18-AC2, R18-AC3, R18-AC4, R18-AC5**

  - [ ]* 5.12 Write unit tests for upload routes
    - Test init, presign, complete, finalize, status, abort endpoints
    - Test auth/permission checks, error responses
    - _Requirements: R1-AC1 through R5-AC4, R15-AC1 through R18-AC5_

- [x] 6. Checkpoint — Upload routes complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement Proxy Generator service — `server/src/services/proxyGenerator.ts`
  - [x] 7.1 Implement proxy generator core logic
    - Use ffprobe to extract video metadata (duration, resolution, codec, bitrate) → write to media_items
    - Extract thumbnail frame → store to `{tripId}/thumbnails/{mediaId}.jpg`
    - Generate Preview Proxy (H.264, AAC, max 1080p, CRF 23) → `{tripId}/proxies/{mediaId}_preview.mp4`
    - Generate Edit Proxy (H.264, AAC, 720p, CBR 4Mbps, keyint=1s) → `{tripId}/proxies/{mediaId}_edit.mp4`
    - Update media_items: status=ready, record proxy paths
    - On failure: status=proxy_failed, record error
    - _Requirements: R10-AC1, R10-AC2, R10-AC3, R10-AC4, R10-AC5, R10-AC6, R10-AC7, R10-AC8_

  - [x] 7.2 Wire proxy generator into upload complete/finalize flow
    - After status changes to uploaded, async-trigger proxy generation
    - _Requirements: R10-AC1, R14-AC3_

  - [ ]* 7.3 Write unit tests for proxy generator
    - Test metadata extraction, thumbnail generation, proxy generation, error handling
    - Mock ffmpeg/ffprobe and StorageProvider
    - _Requirements: R10-AC1 through R10-AC8_

- [x] 8. Implement upload cleanup service — `server/src/services/uploadCleanup.ts`
  - [x] 8.1 Implement expired upload cleanup logic
    - Query upload_sessions WHERE status = 'active' AND updated_at < NOW - UPLOAD_EXPIRE_HOURS
    - Call storageProvider.abortMultipartUpload for each expired session
    - Update upload_sessions.status to 'expired'
    -联动更新对应 media_items.processing_status to 'expired'
    - Support UPLOAD_EXPIRE_HOURS env var (default 72)
    - _Requirements: R19-AC1, R19-AC2, R19-AC3, R19-AC4, R19-AC5_

  - [x] 8.2 Call cleanup on server startup in `server/src/index.ts`
    - _Requirements: R19-AC1_

  - [ ]* 8.3 Write property test for expired upload cleanup (Property 13)
    - **Property 13: 过期上传自动清理**
    - Create records with various ages, run cleanup, verify only expired ones are cleaned
    - **Validates: R19-AC1, R19-AC2, R19-AC3**

  - [ ]* 8.4 Write unit tests for upload cleanup service
    - Test expiry threshold, status updates, storage cleanup calls
    - _Requirements: R19-AC1 through R19-AC5_

- [x] 9. Checkpoint — Backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement frontend VideoUploader component
  - [x] 10.1 Create `client/src/components/VideoUploader.tsx`
    - File selection with video format validation
    - Call `/api/uploads/init` to start upload
    - Simple mode: PUT to presignedUrl → POST /finalize
    - Multipart mode: slice file → batch presign → concurrent upload (3–5) → POST /complete
    - Display per-file upload progress (completed parts / total parts)
    - Cancel button: abort in-flight requests + POST /abort
    - Size warnings: >10GB suggest stable network, >20GB suggest desktop
    - Part retry: 3s delay, max 3 retries, 60s timeout
    - _Requirements: R3-AC1, R3-AC2, R3-AC3, R6-AC1, R6-AC5, R11-AC1, R11-AC2, R11-AC4, R11-AC5, R14-AC4_

  - [x] 10.2 Implement localStorage-based resume tracking
    - Save `upload_resume_${mediaId}` with mediaId, uploadId, completedParts, etc.
    - On page load, detect incomplete uploads and prompt user to resume
    - On resume: GET /status to verify server state, skip completed parts
    - _Requirements: R6-AC2, R6-AC3, R6-AC4, R16-AC4_

  - [x] 10.3 Integrate VideoUploader into existing upload flow
    - Update `FileUploader.tsx` or `UploadPage.tsx` to use VideoUploader for video files
    - Keep existing multer flow for image files
    - _Requirements: R14-AC1_

  - [ ]* 10.4 Write unit tests for VideoUploader component
    - Test rendering, progress display, cancel interaction, resume prompt
    - _Requirements: R6-AC1, R6-AC5, R11-AC4, R11-AC5_

- [x] 11. Update Nginx configuration
  - [x] 11.1 Update `deploy/setup.sh` or Nginx config to set `client_max_body_size 2g`
    - Document that presigned URL uploads bypass Nginx
    - _Requirements: R12-AC1, R12-AC2_

- [x] 12. Final checkpoint — All components wired together
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements (R{N}-AC{M} format) for traceability
- Checkpoints ensure incremental validation after major milestones
- Property tests validate universal correctness properties from the design document
- Image upload flow remains unchanged (existing multer pipeline)
