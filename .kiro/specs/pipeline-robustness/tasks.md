# Implementation Plan: Pipeline Robustness

## Overview

Five surgical fixes to the image processing pipeline, each targeting a specific file with minimal blast radius. Changes are implemented incrementally: type fix first, then the new TempPathCache utility, then the three engine/route fixes that depend on it, with tests woven in alongside each change.

## Tasks

- [x] 1. Fix blur status type alignment in pythonAnalyzer.ts
  - [x] 1.1 Widen `PythonAnalyzeResult.blurStatus` type to include `'suspect'`
    - In `server/src/services/pythonAnalyzer.ts`, change the `blurStatus` field type from `'clear' | 'blurry' | 'unknown'` to `'clear' | 'suspect' | 'blurry' | 'unknown'`
    - No changes needed to `mapAnalyzeResult` — it already passes through the raw value
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 1.2 Write property test for blur status passthrough (Property 1)
    - **Property 1: Blur status passthrough preservation**
    - Use fast-check to generate random raw Python output objects with `blur_status` from `{'clear', 'suspect', 'blurry', 'unknown'}`
    - Assert `mapAnalyzeResult` produces a result whose `blurStatus` equals the input exactly
    - Test file: `server/src/services/pythonAnalyzer.test.ts`
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 1.3 Write unit test verifying suspect status handling in applyPythonAnalyzeResults
    - Verify that `applyPythonAnalyzeResults` treats `'suspect'` the same as `'clear'` — image stays active with blur score and status recorded
    - Test file: `server/src/routes/process.test.ts`
    - _Requirements: 1.4_

  - [ ]* 1.4 Write property test for only-blurry-trashed invariant (Property 2)
    - **Property 2: Only blurry images are trashed by applyPythonAnalyzeResults**
    - Use fast-check to generate random `PythonAnalyzeResult` arrays with mixed blur statuses
    - Assert only results with `blurStatus = 'blurry'` cause trashing
    - Test file: `server/src/routes/process.test.ts`
    - **Validates: Requirements 1.4**

- [x] 2. Implement TempPathCache class
  - [x] 2.1 Create `server/src/helpers/tempPathCache.ts` with `TempPathCache` class
    - Implement `get(relativePath)` that downloads on first access and returns cached path on subsequent calls
    - Implement `cleanup()` that removes all cached temp files (skipping original files for local provider)
    - Implement `size` getter
    - Handle re-download when cached file becomes inaccessible
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [ ]* 2.2 Write property test for download-once guarantee (Property 6)
    - **Property 6: TempPathCache download-once guarantee with re-download on disappearance**
    - Use fast-check to generate random sequences of `get()` calls with random paths
    - Mock `downloadToTemp` and assert it's called exactly once per unique path unless file disappears
    - Test file: `server/src/helpers/tempPathCache.test.ts`
    - **Validates: Requirements 5.2, 5.3, 5.6**

  - [ ]* 2.3 Write property test for cleanup completeness (Property 7)
    - **Property 7: TempPathCache cleanup completeness**
    - Use fast-check to generate random sets of cached paths
    - Assert `cleanup()` removes all temp files and resets cache to empty
    - Test file: `server/src/helpers/tempPathCache.test.ts`
    - **Validates: Requirements 5.4**

  - [ ]* 2.4 Write unit tests for TempPathCache edge cases
    - Test `get()` called twice with same path returns same result with single download
    - Test `cleanup()` with mix of local-provider paths (same as relative) and remote temp paths
    - Test re-download when cached file is deleted between calls
    - Test file: `server/src/helpers/tempPathCache.test.ts`
    - _Requirements: 5.2, 5.3, 5.4, 5.6_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Fix dedup transitivity — pass all indices from Layer 0 to Layer 1
  - [x] 4.1 Update `Layer0Result` interface and `runLayer0` in `hybridDedupEngine.ts`
    - Remove `remainingIndices` from `Layer0Result` interface
    - Remove the `remainingIndices` computation from `runLayer0`
    - _Requirements: 3.1, 3.2, 3.4_

  - [x] 4.2 Update `hybridDeduplicate` to pass all indices to Layer 1
    - Replace `layer0Result.remainingIndices` with `Array.from({ length: rows.length }, (_, i) => i)` when calling `runLayer1`
    - Update pHash/dHash recomputation loop to iterate over all indices instead of `remainingIndices`
    - Update log messages to reflect the change
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 4.3 Write property test for all-indices-to-Layer-1 invariant (Property 4)
    - **Property 4: All indices pass to Layer 1 regardless of Layer 0 results**
    - Use fast-check to generate random image counts and random Layer 0 confirmed pair sets
    - Assert the indices passed to Layer 1 always equal `{0, 1, ..., N-1}`
    - Test file: `server/src/services/hybridDedupEngine.test.ts`
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [x] 5. Implement active-over-trashed keeper priority in Layer 3
  - [x] 5.1 Modify `runLayer3` in `hybridDedupEngine.ts` to prefer active images
    - Partition each group into active and trashed indices
    - If any active images exist, only compute quality scores for active candidates
    - Select keeper from active candidates only; fall back to all-trashed quality comparison
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 5.2 Write property test for active-over-trashed keeper priority (Property 5)
    - **Property 5: Active-over-trashed keeper priority**
    - Use fast-check to generate random duplicate groups with mixed active/trashed statuses and quality scores
    - Assert keeper is always active when any active image exists; highest-quality trashed when all trashed
    - Test file: `server/src/services/hybridDedupEngine.test.ts`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [ ]* 5.3 Write unit tests for Layer 3 keeper selection edge cases
    - Test group with 1 active + 2 trashed → active is keeper
    - Test group with all trashed → highest quality is keeper
    - Test group with multiple active → highest quality active is keeper with tie-breakers
    - Test file: `server/src/services/hybridDedupEngine.test.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 6. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integrate per-image download failure handling and TempPathCache into process.ts
  - [x] 7.1 Add per-image try/catch in the download loop (POST endpoint)
    - Wrap each `downloadToTemp()` / `tempCache.get()` call in try/catch
    - On failure: record error in `processing_error` column with `[download]` prefix, skip the image
    - Track `successRows` and `tempPaths` arrays for only successfully downloaded images
    - Pass `successRows` (not `imageRows`) to `applyPythonAnalyzeResults`
    - If all downloads fail, skip Python analysis and continue to subsequent stages
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 7.2 Add per-image try/catch in the download loop (SSE streaming endpoint)
    - Apply the same per-image download failure handling to the SSE streaming endpoint
    - _Requirements: 2.5_

  - [x] 7.3 Wire TempPathCache into both endpoints
    - Create `TempPathCache` at the start of each processing run
    - Replace direct `storageProvider.downloadToTemp()` calls with `tempCache.get()` in the image download loop
    - Pass `tempCache` to `hybridDeduplicate` via the `HybridDedupOptions.tempCache` field
    - Add `tempCache.cleanup()` in a finally block at the end of each endpoint
    - Remove the manual temp file cleanup loops that are now handled by the cache
    - _Requirements: 5.1, 5.4, 5.5_

  - [x] 7.4 Update `HybridDedupOptions` and internal dedup stages to accept and use TempPathCache
    - Add optional `tempCache?: TempPathCache` to `HybridDedupOptions`
    - In `runLayer0`, `runLayer1`, and `runLayer3`: use `tempCache.get()` instead of `storageProvider.downloadToTemp()` when cache is provided
    - Remove manual temp file cleanup (`fs.unlinkSync`) in those functions when using cache
    - _Requirements: 5.5_

  - [ ]* 7.5 Write property test for download failure isolation (Property 3)
    - **Property 3: Download failure isolation and correct result mapping**
    - Use fast-check to generate random image row lists with random failure index subsets
    - Assert: exactly N−|F| paths passed to analyzeImages, errors recorded for each failed image, correct result-to-row mapping
    - Test file: `server/src/routes/process.test.ts`
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

  - [ ]* 7.6 Write unit tests for download failure edge cases
    - Test pipeline with one corrupted image → remaining images processed, error recorded
    - Test pipeline with all downloads failing → no crash, pipeline continues
    - Test SSE endpoint with download failures → error events sent correctly
    - Test file: `server/src/routes/process.test.ts`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties from the design document
- The implementation language is TypeScript throughout (matching the existing codebase)
- No database schema changes are required — all fixes use existing columns
- All five changes are backward-compatible
