# Implementation Plan: Image Processing V2

## Overview

Upgrade the four core image processing services (BlurDetector, DedupEngine, QualitySelector, ImageOptimizer), add new database columns, reorder the pipeline orchestrator, and update types/row mappings. All changes are backend TypeScript in `server/src/`.

## Tasks

- [x] 1. Database migrations and type foundations
  - [x] 1.1 Add new columns to `media_items` via ALTER TABLE migrations in `server/src/database.ts`
    - Add `blur_status TEXT` (values: 'clear', 'suspect', 'blurry')
    - Add `exposure_score REAL` (nullable)
    - Add `contrast_score REAL` (nullable)
    - Add `noise_score REAL` (nullable)
    - Add `phash TEXT` (nullable, 16-char hex pHash string)
    - Use try/catch pattern matching existing migrations for idempotency
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 1.2 Update `MediaItem` interface in `server/src/types.ts`
    - Add optional fields: `blurStatus`, `exposureScore`, `contrastScore`, `noiseScore`, `phash`
    - Update `QualityScore` interface to six-dimension shape (sharpness, exposure, contrast, resolution, noiseArtifact, fileSize, overall)
    - Add `suspectCount` to `ProcessResult` interface
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 3.1, 6.3_

  - [x] 1.3 Update `MediaItemRow` interface and `rowToMediaItem` in `server/src/helpers/mediaItemRow.ts`
    - Add row fields: `blur_status`, `exposure_score`, `contrast_score`, `noise_score`, `phash`
    - Map snake_case DB columns to camelCase TypeScript fields
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 2. Checkpoint — Ensure migrations and types compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. BlurDetector upgrade — dual threshold tri-state classification
  - [x] 3.1 Rewrite `server/src/services/blurDetector.ts`
    - Export `BlurStatus` type ('clear' | 'suspect' | 'blurry'), `BlurDetectOptions`, `BlurResult`, `BlurDetectResult` interfaces
    - Rename `detectAndTrashBlurry` to `detectBlurry` (or update export name)
    - Accept `BlurDetectOptions` with `hardThreshold` (default 50) and `softThreshold` (default 150)
    - Validate `hardThreshold < softThreshold`, throw on violation
    - Classify: `variance < hard` → blurry (trash), `hard ≤ variance < soft` → suspect (keep active), `variance ≥ soft` → clear
    - On computation error: set `blur_status = 'suspect'`, record `processing_error` (not default to 0)
    - Write `sharpness_score` and `blur_status` to DB for each image
    - Return `{ blurryCount, suspectCount, results }` 
    - `computeSharpness` function remains unchanged
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 3.2 Write property tests for BlurDetector (`server/src/services/blurDetector.test.ts`)
    - **Property 1: Blur classification is deterministic and correct**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.5**
    - Test pure classification logic: for random variance, hardThreshold, softThreshold, verify correct blur_status

  - [ ]* 3.3 Write property test for invalid threshold rejection
    - **Property 2: Invalid threshold pairs are rejected**
    - **Validates: Requirements 1.6**
    - For random pairs where hard ≥ soft, verify error is thrown

  - [ ]* 3.4 Write unit tests for BlurDetector
    - Test exact boundary values (variance = hardThreshold, variance = softThreshold - epsilon)
    - Test error path when sharp throws (should classify as 'suspect', not 'blurry')
    - Test default threshold values
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 4. DedupEngine upgrade — pHash, exemplar clustering, pre-bucketing
  - [x] 4.1 Implement `computePHash` function in `server/src/services/dedupEngine.ts`
    - Resize to 32×32 grayscale using `sharp.resize(32, 32, { fit: 'cover' }).grayscale().raw()`
    - Compute mean of all 1024 pixel values
    - For first 64 pixels (8×8 top-left block): bit = 1 if pixel > mean, else 0
    - Pack 64 bits into 16-char hex string
    - _Requirements: 2.3, 2.5_

  - [x] 4.2 Update `computeHash` (dHash) to use `fit: 'cover'` instead of `fit: 'fill'`
    - _Requirements: 2.1_

  - [x] 4.3 Rewrite `deduplicate` function with exemplar clustering and pre-bucketing
    - Accept `DedupOptions` with `dHashThreshold` (default 5) and `pHashThreshold` (default 8)
    - Remove `UnionFind` class entirely
    - Compute both dHash and pHash for all images
    - Implement pre-bucketing: group images by aspect ratio bucket (`round(w/h * 10) / 10`) and resolution tier (`floor(log2(w * h))`)
    - Only compare pairs within the same bucket
    - Require both dHash AND pHash distances within thresholds for a match
    - Build groups using exemplar model: each member must match the exemplar, no cross-group merging
    - Store both `perceptual_hash` (dHash) and `phash` (pHash) in DB
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 4.4 Write property tests for DedupEngine
    - **Property 3: Dual-hash matching requires both hashes**
    - **Validates: Requirements 2.3**
    - For random hash pairs and thresholds, verify match requires both distances within thresholds

  - [ ]* 4.5 Write property test for exemplar clustering invariant
    - **Property 4: Exemplar clustering invariant**
    - **Validates: Requirements 2.4**
    - For random candidate match lists, verify every group member matches the exemplar

  - [ ]* 4.6 Write unit tests for DedupEngine
    - Test `computePHash` returns 16-char hex string
    - Test `computeHash` with `fit: 'cover'` produces valid hash
    - Test pre-bucketing separates images with different aspect ratios
    - Test that identical images are grouped, different images are not
    - Test empty input returns empty array
    - Test both hashes stored in DB after dedup
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 5. Checkpoint — Ensure BlurDetector and DedupEngine tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. QualitySelector upgrade — six-dimension weighted scoring
  - [x] 6.1 Rewrite `computeQualityScore` in `server/src/services/qualitySelector.ts`
    - Compute six dimensions: sharpness (reuse from DB), exposure, contrast, resolution, noiseArtifact, fileSize
    - Exposure: `sharp(path).stats()` → average channel means → `1.0 - Math.abs(mean - 128) / 128`
    - Contrast: `sharp(path).stats()` → average channel stddevs → `Math.exp(-0.5 * ((stddev - 60) / 20) ** 2)`
    - Noise: resize to 256×256, Laplacian variance vs original variance → `1.0 - min(highFreqRatio, 1.0)`
    - Sharpness: read `sharpness_score` from DB, normalize `min(v / 500, 1.0)`, fallback to fresh computation
    - Resolution: `min(w * h / 12_000_000, 1.0)`
    - FileSize: `min(fileSize / 5_000_000, 1.0)`
    - Weights: sharpness 40%, exposure 10%, contrast 10%, resolution 20%, noise 10%, fileSize 10%
    - On dimension failure: set to null, re-normalize remaining weights
    - Store `exposure_score`, `contrast_score`, `noise_score`, `quality_score` in DB
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 6.2 Update `selectBest` and `processTrip` to use new scoring
    - Use new `computeQualityScore` that returns six-dimension `QualityScore`
    - Update DB update statements to write new dimension columns
    - Update comparison logic to use `overall` weighted score
    - _Requirements: 3.2, 3.7_

  - [ ]* 6.3 Write property tests for QualitySelector
    - **Property 6: Weighted quality score formula**
    - **Validates: Requirements 3.2, 3.7**
    - For random normalized scores (some null), verify overall = weighted sum with re-normalized weights

  - [ ]* 6.4 Write property tests for normalization formulas
    - **Property 7: Normalization formulas produce correct values**
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.8**
    - For random non-negative inputs, verify each normalization formula output

  - [ ]* 6.5 Write property test for score bounds
    - **Property 8: All normalized scores are bounded in [0.0, 1.0]**
    - **Validates: Requirements 3.8**
    - For random non-negative inputs, verify all normalization outputs ∈ [0.0, 1.0]

  - [ ]* 6.6 Write unit tests for QualitySelector
    - Test with all-null dimensions (overall = 0)
    - Test with single non-null dimension
    - Test perfectly exposed image (mean = 128 → exposure = 1.0)
    - Test sharpness reuse from DB vs fresh computation fallback
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 7. ImageOptimizer upgrade — new pipeline order
  - [x] 7.1 Update `optimizeImage` in `server/src/services/imageOptimizer.ts`
    - Replace pipeline: remove `normalize()` and `modulate({ brightness: 1.0 })`
    - New chain: `median(3)` → `gamma().clahe({ width: 3, height: 3 })` → `sharpen({ sigma: 0.7 })` → `withMetadata()`
    - Keep existing resize logic and JPEG quality handling unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 7.2 Write property test for EXIF metadata preservation
    - **Property 10: EXIF metadata preservation**
    - **Validates: Requirements 4.5**
    - Generate test images with EXIF, verify EXIF present after optimization

  - [ ]* 7.3 Write unit tests for ImageOptimizer
    - Test output file exists and is valid image
    - Test JPEG quality parameter is respected
    - Test that normalize() and modulate() are no longer called (verify pipeline via output characteristics)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [x] 8. Checkpoint — Ensure all service tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Pipeline orchestrator integration
  - [x] 9.1 Update `server/src/routes/process.ts` POST handler
    - Reorder steps: dedup → blur detection → quality scoring → optimize → thumbnails → cover
    - Import updated `detectBlurry` (renamed from `detectAndTrashBlurry`)
    - Pass `hardThreshold` and `softThreshold` query params to BlurDetector
    - Parse new query params: `hardThreshold`, `softThreshold`
    - Include `suspectCount` in response JSON
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 9.2 Update SSE streaming handler in `server/src/routes/process.ts`
    - Reorder SSE steps to match new pipeline order
    - Pass threshold params to BlurDetector
    - Report `blurryCount` and `suspectCount` in step complete events and final summary
    - Remove separate `trashDuplicates` step (computed inline during quality scoring)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 9.3 Write unit tests for pipeline orchestrator
    - Test step ordering via mocked services
    - Test response shape includes `suspectCount`
    - Test SSE events contain both blurry and suspect counts
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 10. Update existing test files
  - [x] 10.1 Update `server/src/services/dedupEngine.test.ts`
    - Update DB schema in test setup to include new columns (`blur_status`, `exposure_score`, `contrast_score`, `noise_score`, `phash`)
    - Update `deduplicate` call signatures to use new `DedupOptions` format
    - Add tests for `computePHash`
    - Update "transitive grouping" test — exemplar clustering no longer merges transitively
    - Verify both `perceptual_hash` and `phash` are stored after dedup
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 10.2 Update `server/src/services/qualitySelector.test.ts`
    - Update DB schema in test setup to include new columns
    - Update `computeQualityScore` tests for new six-dimension return shape
    - Update `selectBest` tests to verify new weighted overall score
    - Update `processTrip` tests to verify new dimension columns are written
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The blur detector change (task 3) is the highest-impact fix and should be prioritized
- DedupEngine changes (task 4) are the most complex due to new hash function and clustering algorithm
- QualitySelector (task 6) depends on BlurDetector writing `sharpness_score` to DB first (pipeline order dependency)
- All changes are backend-only — no frontend modifications needed
