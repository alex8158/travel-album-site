# Implementation Plan: photo-curation-fix

## Overview

This plan implements six interconnected photo curation fixes in the travel album's server-side pipeline. Changes span Python (subject-level overexposure detection), TypeScript pipeline orchestrator (error labeling, threshold logging, VLM status reporting), result reducer (overexposure recognition), and smart curation engine (global similarity candidate generation). All changes are backend-only, preserve existing blur/hash dedup behavior, and maintain the "keep all on failure" policy.

## Tasks

- [x] 1. Threshold configuration and logging foundation
  - [x] 1.1 Extend `PROCESS_THRESHOLDS` in `dedupThresholds.ts` with new threshold fields
    - Add `overexposureGlobalRatio`, `overexposureSubjectVThreshold`, `overexposureSubjectSThreshold`, `overexposureSubjectMinAreaRatio`, `overexposureSubjectMaxAreaRatio`, `overexposureSubjectSevereTotalAreaRatio`, `overexposureMinComponentPixels`, `overexposureTextureGradientThreshold`
    - Add `dinov2ConfirmedThreshold`, `dinov2GrayLowThreshold`, `dinov2DedupThreshold`
    - Add `clipConfirmedThreshold`, `clipGrayHighThreshold`, `clipGrayLowThreshold`
    - Add `globalSimilarityTopK`
    - Include environment variable override parsing with validation (non-numeric / out-of-range → use default + log warning)
    - _Requirements: 5.1, 5.6_

  - [x] 1.2 Add structured threshold log at pipeline start
    - Log all active thresholds in a single structured line at pipeline entry in `runTripProcessingPipeline.ts`
    - Format: `[pipeline] thresholds: blur=${blurThreshold}, overexposureGlobal=${overexposureGlobalRatio}, ...`
    - Values MUST come from `PROCESS_THRESHOLDS` (not hardcoded literals)
    - _Requirements: 5.4, 5.7_

  - [ ]* 1.3 Write property test for threshold log consistency
    - **Property 8: Threshold log consistency**
    - Verify logged values exactly match `PROCESS_THRESHOLDS` runtime values for any configuration
    - **Validates: Requirement 5.4**

- [x] 2. Subject-level overexposure detection (Python)
  - [x] 2.1 Implement `detect_subject_overexposure` in `server/python/analyze.py`
    - Multi-criteria detection: HSV V ≥ v_threshold AND S ≤ s_threshold AND Sobel gradient std < texture_gradient_threshold AND component ≥ min_component_pixels
    - Connected component analysis on qualifying regions
    - Center weighting (1.5x for components in center 60%)
    - Severity classification: none / mild / severe based on area ratio thresholds
    - Anti-false-positive: textured bright regions (gradient ≥ threshold) excluded
    - Return `{ severity, subjectOverexposed, largestRegionRatio, totalBrightArea, numQualifyingRegions, overexposureReason, qualityPenalty }`
    - All thresholds received via CLI arguments from Node.js (never hardcoded in Python)
    - Log received thresholds at start: `[analyze] overexposure thresholds: V=${v}, S=${s}, ...`
    - _Requirements: 1.Q1-1.Q4, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.13, 5.5_

  - [x] 2.2 Integrate subject overexposure into pipeline's Python invocation
    - Pass overexposure thresholds from `PROCESS_THRESHOLDS` as CLI arguments to `analyze.py`
    - Parse Python output and map severity to `overexposureStatus` (`severe` → `overexposed`, `mild` → `normal` with quality penalty, `none` → `normal`)
    - Store `qualityPenalty` in `ImageProcessContext.overexposure.qualityPenalty`
    - On OpenCV/decode failure: fall back to global pixel brightness check via sharp, log warning
    - _Requirements: 1.11, 1.14, 1.15, 1.16, 5.5_

  - [ ]* 2.3 Write Python tests for subject overexposure detection
    - **Property 1: Subject overexposure classification**
    - **Property 2: Anti-false-positive for textured bright regions**
    - Test severity thresholds with synthetic images
    - Test that textured bright regions (sand/seafloor) are NOT flagged
    - **Validates: Requirements 1.Q1-1.Q4, 1.3, 1.4, 1.5**

- [x] 3. Stage error labeling fix
  - [x] 3.1 Fix overexposure stage error labeling in `runTripProcessingPipeline.ts`
    - Change error recording from `stage: 'blur'` to `stage: 'overexposure'` for overexposure stage errors
    - Ensure blur and overexposure stages record distinct error entries in `stageErrors`
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]* 3.2 Write property test for stage error labeling
    - **Property 9: Overexposure error labeling**
    - Verify overexposure errors always have `stage: 'overexposure'`, never `stage: 'blur'`
    - Verify blur and overexposure produce independent entries if both fail
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [x] 4. Result reducer updates
  - [x] 4.1 Update result reducer to recognize overexposure and global_similarity trash reasons
    - Add `'overexposure'` and `'global_similarity'` to `TrashReason` type
    - Implement priority ordering: blur > overexposure > duplicate > global_similarity
    - Accept `globalSimilarityAssessment` parameter alongside existing `dedupAssessment`
    - Check overexposure severity=severe → append `'overexposure'` to trashedReasons
    - Check global similarity trashed set → append `'global_similarity'`
    - Set `finalStatus = 'trashed'` if and only if `trashedReasons.length > 0`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ]* 4.2 Write property test for result reducer completeness and ordering
    - **Property 3: Result reducer completeness and ordering**
    - Generate arbitrary combinations of blur/overexposure/dedup/global_similarity
    - Verify trashedReasons contains exactly applicable reasons in priority order
    - Verify finalStatus is trashed iff trashedReasons is non-empty
    - **Validates: Requirements 2.1-2.9**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Global similarity candidate generation
  - [x] 6.1 Create `server/src/services/smartCuration/globalSimilarity.ts` with core types and interfaces
    - Define `ClusterDecision`, `GlobalSimilarityResult`, `SelectorSource` types
    - Define `selectBestByQuality` function signature (composite score: sharpness*0.4 + aesthetic*0.3 + exposure*0.3 + overexposureQualityPenalty)
    - _Requirements: 3.1, 3.14_

  - [x] 6.2 Implement DINOv2 embedding fetch and top-K nearest neighbor computation
    - Fetch DINOv2 embeddings only for `prelimActiveMediaIds` (images not trashed by blur/overexposure/dedup)
    - Compute top-K nearest neighbors (K = `globalSimilarityTopK`) using cosine similarity
    - Classify pairs: confirmed (≥ `dinov2ConfirmedThreshold`), gray-zone (between `dinov2GrayLowThreshold` and confirmed), skip (below gray low)
    - Handle ML service unavailable: skip entirely, log `[globalDedup] ML service unavailable — skipping global similarity detection`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.15_

  - [x] 6.3 Implement two-phase Union-Find clustering with chain-merge safeguards
    - Phase 1: Build clusters from confirmed pairs only via standard Union-Find
    - Phase 2: Gray-zone pairs — if both endpoints in same cluster → add evidence; if bridging two clusters → flag for VLM review, do NOT auto-merge
    - Enforce cluster size cap of 8 — split at weakest intra-cluster edge
    - Direct edge requirement: only trash if candidate has direct confirmed edge to selectedMediaId or medoid
    - _Requirements: 3.6, 3.7, 3.8, 3.9_

  - [x] 6.4 Implement tiered resolution (local quality vs VLM vs fallback)
    - Confirmed-only clusters → local quality selector (with direct-edge validation)
    - Mixed/gray-zone clusters → VLM selection
    - VLM failure on confirmed cluster → still use local quality
    - VLM failure on gray-zone cluster → `fallback_keep_all`, log warning
    - Track VLM calls via shared `VLMCallStats` tracker (real-time increment, not retroactive)
    - _Requirements: 3.10, 3.11, 3.12, 3.13, 3.17_

  - [x] 6.5 Wire global similarity into pipeline orchestration
    - Compute `prelimActiveMediaIds` from reducer's preliminary pass (blur + overexposure + dedup)
    - Execute global similarity BEFORE post-reducer AI stages
    - Pass `GlobalSimilarityAssessment` to the final reducer
    - Ensure global similarity runs before Scene_Dedup
    - _Requirements: 3.16_

  - [ ]* 6.6 Write property tests for global similarity
    - **Property 4: Global similarity tiered resolution** — confirmed clusters use local quality regardless of VLM; gray-zone with VLM failure → fallback_keep_all
    - **Property 5: DINOv2 pair classification respects split thresholds** — pairs classified correctly by threshold bands
    - **Property 6: Union-Find clustering with chain-merge safeguards** — gray-zone does not bridge clusters; size cap 8; direct edge requirement
    - **Validates: Requirements 3.3-3.9, 3.10-3.13**

- [x] 7. VLM status reporting
  - [x] 7.1 Define VLM types and implement status derivation
    - Add `VLMStatus` and `VLMCallStats` types to `server/src/services/pipeline/types.ts`
    - Implement `deriveVLMStatus()` with priority: disabled > not_configured > skipped > success > partial_failure > failed
    - Create shared `VLMCallStats` tracker object that AI stages increment in real-time
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 7.2 Integrate VLM stats tracking across all AI stages
    - Pass shared `VLMCallStats` tracker to aiReview, sceneDedup, aiRefinement, and global similarity
    - Each VLM call increments tracker immediately (success/failure/parse/timeout/auth)
    - Stage-level result objects are for debug logging only (not re-added to shared tracker)
    - At pipeline end: derive `vlmStatus`, populate `vlmDiagnostic` string
    - _Requirements: 4.7, 4.8, 4.9, 4.10_

  - [x] 7.3 Update `PipelineResult` with VLM fields and statistics counting
    - Add `vlmStatus`, `vlmCallStats`, `overexposureDeletedCount`, `globalSimilarityTrashedCount` to `PipelineResult`
    - Implement statistics counting per Constraint 6 (primary trash reason for pre-reducer, trashed_stage for post-reducer)
    - Add completion summary log per Constraint 7
    - _Requirements: 4.1, 4.7, 4.10, 4.11_

  - [ ]* 7.4 Write property test for VLM status derivation
    - **Property 7: VLM status derivation**
    - Generate arbitrary combinations of vlmEnabled, vlmAvailable, and VLMCallStats
    - Verify correct VLMStatus is derived following priority rules
    - **Validates: Requirements 4.2-4.6**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integration and regression testing
  - [x] 9.1 Wire full pipeline end-to-end with all new stages
    - Ensure pipeline order: analyzeImages → blur → overexposure (with subject detection) → hash dedup → global similarity → reducer → writeDecisions → aiReview → sceneDedup → aiRefinement → compute final stats → log summary
    - Verify post-reducer stages only append trash, never un-trash
    - Verify `writeDecisions` called exactly once
    - Verify final counts query DB after all stages complete
    - _Requirements: 2.1-2.9, 3.16, 5.7_

  - [ ]* 9.2 Create underwater regression test suite
    - Create `server/src/services/pipeline/__tests__/underwaterRegression.integration.test.ts`
    - Gate with `RUN_UNDERWATER_REGRESSION=1` environment variable
    - Use fixtures from `server/test/fixtures/underwater/`
    - Validate: overexposed nudibranch → trashed, bright sand → NOT trashed, same-subject shots → clustered
    - Validate: VLM unavailable → confirmed clusters still resolve, gray-zone → fallback_keep_all
    - Output structured regression results per design spec
    - _Requirements: 1.3, 1.4, 3.3, 3.6-3.9_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The Python subject overexposure detector and TypeScript pipeline changes can be developed in parallel (tasks 2.1 and 1.x/3.x/4.x)
- Global similarity (task 6) depends on threshold config (task 1) and reducer updates (task 4) being complete
- VLM status reporting (task 7) depends on global similarity (task 6) being wired
- Regression tests (task 9.2) depend on all stages being integrated

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3", "3.2"] },
    { "id": 2, "tasks": ["4.1"] },
    { "id": 3, "tasks": ["4.2", "6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3"] },
    { "id": 5, "tasks": ["6.4", "6.5"] },
    { "id": 6, "tasks": ["6.6", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4", "9.1"] },
    { "id": 9, "tasks": ["9.2"] }
  ]
}
```
