# Implementation Plan

- [x] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Video Editing Multi-Bug Exploration
  - **CRITICAL**: These tests MUST FAIL on unfixed code - failure confirms the bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior - they will validate the fixes when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate each bug exists
  - Create `server/src/services/videoEditor.test.ts`
  - **Bug 1 - Scale Filter 语法**: Test that `concatenateWithTransitions` generates correct scale filter string `scale='min(1080,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease` (not the broken `min'(...)':` syntax). Mock ffmpeg and inspect the filter string passed to complexFilter/outputOptions.
  - **Bug 2 - selectSegments break→continue**: Test with segments `[{duration:10, score:90}, {duration:8, score:80}, {duration:3, score:70}, {duration:2, score:60}]` and `targetDuration=15`. Assert selected total duration ≥ 15 (should select 10+3+2=15, not just 10). On unfixed code, `break` causes only 10s to be selected.
  - **Bug 3 - 'none' 模式音频路径**: Test that `editVideo` with default `transitionType: 'none'`, multiple segments, and audio present calls `concatenateWithTransitions` (filter graph path) instead of `concatenateSegments`. Mock both functions and verify the correct one is called.
  - **Bug 4 - buildTransitionFilters 'none' afade 时长**: Test that `buildTransitionFilters` with `transitionType: 'none'` generates afade with ~0.1s duration, not the default 0.5s `transitionDuration`.
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found to understand root cause
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs, then write tests asserting observed behavior
  - **Preservation 1 - 手动剪辑 fade/crossfade**: Test that `buildTransitionFilters` with `transitionType: 'fade'` and `transitionType: 'crossfade'` generates correct video+audio filter strings. For all segment arrays with `transitionType !== 'none'`, output should match current behavior.
  - **Preservation 2 - 短视频不裁剪**: Test that `selectSegments` with `targetDuration === null` returns all candidates that pass quality filter. For all segment arrays where all segments are good and duration < 60s, all segments are returned.
  - **Preservation 3 - 无音频视频**: Test that `buildTransitionFilters` with `withAudio: false` returns `audioFilter: null` for all transitionType values.
  - **Preservation 4 - 图片上传不触发视频处理**: Test that `FileUploader` does NOT call `/api/media/:id/process` when uploading image files (mediaType !== 'video').
  - **Preservation 5 - selectSegments targetDuration=null**: Test that when `targetDuration` is null, `selectSegments` returns all filtered candidates regardless of duration sum.
  - Property-based: generate random segment arrays and verify preservation properties hold
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix video editing bugs

  - [x] 3.1 Fix scale filter quote syntax in `concatenateWithTransitions`
    - In `server/src/services/videoEditor.ts`, function `concatenateWithTransitions`
    - Change `scale='min(${maxRes},iw)':min'(${maxRes},ih)':force_original_aspect_ratio=decrease` to `scale='min(${maxRes},iw)':'min(${maxRes},ih)':force_original_aspect_ratio=decrease`
    - _Bug_Condition: isBugCondition where functionName == 'concatenateWithTransitions' AND videoResolution IS NOT NULL_
    - _Expected_Behavior: ffmpeg scale filter string is syntactically correct_
    - _Requirements: 2.1_

  - [x] 3.2 Fix `selectSegments` break→continue
    - In `server/src/services/videoEditor.ts`, function `selectSegments`
    - Change `if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) break;` to `if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) continue;`
    - _Bug_Condition: isBugCondition where functionName == 'selectSegments' AND targetDuration IS NOT NULL AND a large segment triggers break before shorter segments are evaluated_
    - _Expected_Behavior: all candidate segments are evaluated, shorter segments fill remaining capacity_
    - _Requirements: 2.4_

  - [x] 3.3 Fix `editVideo` 'none' mode to use filter graph for audio
    - In `server/src/services/videoEditor.ts`, function `editVideo`
    - Change the condition `if (transitionType !== 'none' && segmentPaths.length > 1)` so that when `transitionType === 'none'` AND `withAudio === true` AND `segmentPaths.length > 1`, it still calls `buildTransitionFilters` and `concatenateWithTransitions` to apply audio afade
    - Only fall through to `concatenateSegments` when single segment or no audio
    - _Bug_Condition: isBugCondition where transitionType == 'none' AND segmentCount > 1 AND videoHasAudio == TRUE_
    - _Expected_Behavior: audio splice points get afade treatment via filter graph path_
    - _Preservation: fade/crossfade paths unchanged, no-audio videos unchanged_
    - _Requirements: 2.2, 2.3_

  - [x] 3.4 Adjust `buildTransitionFilters` afade duration for 'none' mode
    - In `server/src/services/videoEditor.ts`, function `buildTransitionFilters`
    - When `transitionType === 'none'`, use a fixed afade duration of ~0.1s (100ms) instead of the passed `transitionDuration` (default 0.5s)
    - This ensures audio fades are imperceptible while still eliminating pops/clicks
    - _Bug_Condition: isBugCondition where transitionType == 'none' AND withAudio == TRUE_
    - _Expected_Behavior: afade duration is ~0.1s for 'none' mode_
    - _Requirements: 2.2, 2.3_

  - [x] 3.5 Remove `transitionType: 'fade'` from `proxyGenerator.ts`
    - In `server/src/services/proxyGenerator.ts`, function `processVideoAfterProxy`
    - Change `editVideo(videoPath, analysis, tripId, mediaId, { transitionType: 'fade' })` to `editVideo(videoPath, analysis, tripId, mediaId, {})` or `editVideo(videoPath, analysis, tripId, mediaId)` to use default 'none'
    - _Bug_Condition: isBugCondition where callerContext == 'proxyGenerator' AND transitionType == 'fade'_
    - _Expected_Behavior: auto-editing uses 'none' (hard cut video + short audio afade)_
    - _Requirements: 2.2_

  - [x] 3.6 Add video processing progress display in `FileUploader.tsx`
    - In `client/src/components/FileUploader.tsx`
    - Add `processingStatus?: 'processing' | 'processed' | 'process_failed'` field to `UploadFileEntry` interface
    - After video upload completes, set `processingStatus: 'processing'` and await the `apiPost('/api/media/${id}/process')` response
    - On success: update `processingStatus: 'processed'`; on failure: update `processingStatus: 'process_failed'`
    - Display processing status label in UI for video files (e.g., "处理中…", "处理完成", "处理失败")
    - _Bug_Condition: isBugCondition where callerContext == 'FileUploader' AND mediaType == 'video'_
    - _Expected_Behavior: UI shows processing progress for video files_
    - _Preservation: image upload flow unchanged_
    - _Requirements: 2.5_

  - [x] 3.7 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Video Editing Multi-Bug Fixes Verified
    - **IMPORTANT**: Re-run the SAME tests from task 1 - do NOT write new tests
    - The tests from task 1 encode the expected behavior
    - When these tests pass, it confirms the expected behavior is satisfied
    - Run bug condition exploration tests from step 1
    - **EXPECTED OUTCOME**: Tests PASS (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing Behavior Still Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx vitest --run` in both `server/` and `client/`
  - Ensure all bug condition tests (task 1) pass after fixes
  - Ensure all preservation tests (task 2) still pass after fixes
  - Ensure existing tests (FileUploader.test.tsx, etc.) are not broken
  - Ask the user if questions arise
