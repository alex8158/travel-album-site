# Implementation Plan: Smart Curation

## Overview

Replace the existing `aiScreening` pipeline stage with a two-phase Smart Curation engine. Phase 1 groups photos by DINOv2 embedding similarity using tiered thresholds (exact duplicate >= 0.94, near-duplicate >= 0.86). Phase 2 selects the best photo(s) from each group using technical quality scoring (exact duplicates) or VLM-based evaluation via DashScope qwen-vl-max (near-duplicates). The implementation reuses existing infrastructure (mlQualityService, bedrockClient, qualitySelector) and follows the same VLM call pattern as aiImageOptimizer.ts.

## Tasks

- [x] 1. Set up Smart Curation module structure and core types
  - [x] 1.1 Create the smartCuration directory and define core types/interfaces
    - Create `server/src/services/smartCuration/smartCurationEngine.ts` with all exported types: `TrashReason`, `GroupType`, `SimilaritySource`, `CurationCandidate`, `CurationGroup`, `CurationDecision`, `SmartCurationResult`, `SmartCurationOptions`
    - Export the `runSmartCuration` function signature (stub implementation returning empty result)
    - Create `server/src/services/smartCuration/index.ts` barrel export
    - _Requirements: 1.1, 4.1-4.8, 7.1_

- [x] 2. Implement Similarity Grouper
  - [x] 2.1 Implement the similarityGrouper module
    - Create `server/src/services/smartCuration/similarityGrouper.ts`
    - Export constants `EXACT_DUPLICATE_THRESHOLD = 0.94` and `NEAR_DUPLICATE_THRESHOLD = 0.86`
    - Implement `groupBySimilarity(candidates)` that: fetches DINOv2 embeddings via `mlQualityService.ts`, computes pairwise cosine similarity, builds Union-Find groups using tiered thresholds, classifies groups as `exact_duplicate` or `near_duplicate_candidate` based on max similarity within the group
    - Implement fallback to pHash/dHash when ML service is unavailable
    - Return groups of 2+ candidates and ungrouped singletons separately
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 2.2 Write property test: Tiered Grouping by Cosine Similarity
    - **Property 1: Tiered Grouping by Cosine Similarity**
    - **Validates: Requirements 1.2, 1.3, 1.4**
    - Create `server/src/services/smartCuration/smartCuration.property.test.ts`
    - Generate random embedding vectors and verify grouping thresholds are applied correctly

  - [ ]* 2.3 Write property test: Union-Find Grouping Transitivity
    - **Property 10: Union-Find Grouping Transitivity**
    - **Validates: Requirements 1.1**
    - Verify that if sim(A,B) >= threshold and sim(B,C) >= threshold, then A, B, C are all in the same group

- [x] 3. Implement Technical Quality Selector
  - [x] 3.1 Implement the technicalQualitySelector module
    - Create `server/src/services/smartCuration/technicalQualitySelector.ts`
    - Implement `selectBestByQuality(candidates)` using sharpness score, resolution (width*height), and file size as ranking criteria
    - Implement `preselectTopCandidates(candidates, maxCount)` to reduce large groups before VLM evaluation
    - Reuse scoring logic from existing `qualitySelector.ts` where applicable
    - _Requirements: 3.3, 3.5, 8.2, 8.3_

  - [ ]* 3.2 Write property test: Pre-selection Reduces Large Groups to At Most 5
    - **Property 3: Pre-selection Reduces Large Groups to At Most 5**
    - **Validates: Requirements 3.3, 8.2**
    - Verify that for any group with > 5 candidates, preselectTopCandidates returns at most 5 and they are the top-scoring ones

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement VLM Selector
  - [x] 5.1 Implement the vlmSelector module
    - Create `server/src/services/smartCuration/vlmSelector.ts`
    - Implement `getKeepQuota(groupSize)` with the tiered logic: 2-3 → keep 1, 4-8 → keep 1-2, 9+ → keep 2-3
    - Implement `buildCurationPrompt(candidateCount, keepQuota)` with the full VLM prompt including underwater photo handling instructions
    - Implement `parseVLMResponse(responseText, candidateCount, keepQuota)` to parse JSON from VLM output, returning null on failure
    - Implement `selectBestByVLM(candidates, keepQuota)` that: resizes images to 768px using `resizeForAnalysis` from bedrockClient, builds the prompt, calls DashScope qwen-vl-max via OpenAI-compatible client (same pattern as aiImageOptimizer.ts), parses the response
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.4, 9.1, 9.2, 9.3_

  - [ ]* 5.2 Write property test: Group Size Determines Keep Quota
    - **Property 2: Group Size Determines Keep Quota**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - Verify getKeepQuota returns correct min/max for all group size ranges

  - [ ]* 5.3 Write property test: VLM Response Parsing Round-Trip
    - **Property 4: VLM Response Parsing Round-Trip**
    - **Validates: Requirements 3.4**
    - Generate valid VLMSelectionResponse objects, serialize to JSON, parse back, verify equivalence

  - [ ]* 5.4 Write property test: Trash Reason Matches Group Type
    - **Property 5: Trash Reason Matches Group Type and Determination**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**
    - Verify exact_duplicate groups only produce `exact_duplicate` reason; near_duplicate groups produce one of the VLM-specific reasons

- [x] 6. Implement Debug Report Writer
  - [x] 6.1 Implement the debugReportWriter module
    - Create `server/src/services/smartCuration/debugReportWriter.ts`
    - Implement `writeDebugReport(tripId, decisions, groups)` that writes JSON to `data/debug/smart-curation-{tripId}-{timestamp}.json`
    - Ensure the report contains one entry per processed photo with all required fields
    - Create the `data/debug/` directory if it doesn't exist
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 6.2 Write property test: Debug Report Completeness
    - **Property 7: Debug Report Completeness**
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - Verify that for any set of decisions, the report contains exactly one entry per photo with all required fields

- [x] 7. Implement Smart Curation Engine orchestrator
  - [x] 7.1 Implement the full runSmartCuration orchestrator logic
    - Complete the `runSmartCuration` function in `smartCurationEngine.ts`
    - Load active images from DB for the trip (`status = 'active'`)
    - Call `groupBySimilarity` to form groups
    - For `exact_duplicate` groups: use `selectBestByQuality` to pick the best, trash others with reason `exact_duplicate`
    - For `near_duplicate_candidate` groups: pre-select top 5 if group > 5, then call `selectBestByVLM`, fall back to quality scoring on failure
    - Apply decisions to DB: set `status = 'trashed'` and `trashed_reason` for trashed photos
    - Process VLM calls with concurrency limit of 3 using `Promise.allSettled` batching
    - Call `writeDebugReport` at the end
    - Report progress via `options.onProgress` callback
    - Handle graceful degradation: skip VLM if DASHSCOPE_API_KEY not set, fall back on unparseable responses
    - _Requirements: 2.4, 3.3, 3.5, 4.8, 5.1, 5.2, 7.2, 7.4, 8.1, 8.3, 8.4, 8.5_

  - [ ]* 7.2 Write property test: Soft Delete Invariant
    - **Property 6: Soft Delete Invariant**
    - **Validates: Requirements 5.1, 5.2**
    - Verify that trashing only modifies status and trashed_reason, never file_path

  - [ ]* 7.3 Write property test: VLM Invoked Only for Near-Duplicate Groups
    - **Property 8: VLM Invoked Only for Near-Duplicate Groups with 2+ Members**
    - **Validates: Requirements 8.1, 8.3, 8.5**
    - Verify VLM is never called for singletons, ungrouped photos, or exact_duplicate groups

  - [ ]* 7.4 Write property test: Curation Processes Only Active Photos
    - **Property 9: Curation Processes Only Active Photos**
    - **Validates: Requirements 7.2**
    - Verify only photos with status='active' are processed and no other-status photos are modified

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Pipeline integration
  - [x] 9.1 Replace aiScreening with smartCuration in the pipeline
    - Modify `server/src/services/pipeline/runTripProcessingPipeline.ts`
    - Replace the `aiScreening` stage block with a `smartCuration` stage that calls `runSmartCuration`
    - Remove the `AI_REVIEW_ENABLED` gate — smartCuration always runs (falls back to quality scoring if no API key)
    - Wire the pipeline's `onProgress` callback to the smartCuration options
    - Log curation results (totalTrashed, vlmCallsMade, timing)
    - Ensure subsequent stages (analyze, optimize, thumbnail) continue after smartCuration completes
    - _Requirements: 7.1, 7.3, 7.5_

  - [ ]* 9.2 Write unit tests for pipeline integration
    - Test that smartCuration stage is called after write stage
    - Test that pipeline continues to analyze/optimize/thumbnail after smartCuration
    - Test that smartCuration failure does not block subsequent stages
    - Test progress callback receives smartCuration stage events
    - _Requirements: 7.1, 7.3, 7.5_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation reuses existing infrastructure: `mlQualityService.ts` (DINOv2 embeddings), `bedrockClient.ts` (resizeForAnalysis), `qualitySelector.ts` (quality scoring), and the DashScope OpenAI-compatible client pattern from `aiImageOptimizer.ts`
- Database is better-sqlite3 with no new tables needed — reuses existing `media_items.trashed_reason` column
- VLM concurrency is limited to 3 parallel requests matching the existing aiImageScreener pattern

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "5.1", "6.2"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "7.1"] },
    { "id": 4, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
