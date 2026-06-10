# Implementation Plan: Global Survivor Dedup

## Overview

Add a post-VLM embedding-based deduplication stage to `runHighlightEvaluation`. The stage detects cross-group near-duplicates among surviving active photos using stored DINOv2 embeddings, clusters eligible pairs via Union-Find, and keeps only the best photo per cluster. Implementation involves one new file (`survivorDedup.ts`), one modified file (`highlightService.ts`), and unit tests.

## Tasks

- [x] 1. Create the `survivorDedup.ts` module
  - [x] 1.1 Create `server/src/services/smartCuration/survivorDedup.ts` with interfaces and helper functions
    - Define `SurvivorPhoto`, `SurvivorDedupResult`, and `EligiblePair` interfaces
    - Implement `buildEligiblePairs()` — classify neighbor pairs into confirmed (>= 0.88) or gray-zone-eligible ([0.82, 0.88) + temporal <= 30s)
    - Import and reuse `computeTopKNeighbors`, `cosineSimilarity`, `selectBestByQuality`, `computeCompositeScore`, `CurationCandidate` from `globalSimilarity.ts`
    - Import and reuse `UnionFind` from `unionFind.ts`
    - Import `PROCESS_THRESHOLDS` for threshold constants
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 4.1, 4.2, 4.3_

  - [x] 1.2 Implement `clusterAndResolve()` function
    - Build Union-Find clusters from eligible pairs
    - For each cluster with size >= 2, select keeper by highest composite quality score
    - Implement tie-breaking: when scores are equal, keep earliest `created_at`
    - Return array of media IDs to trash
    - _Requirements: 5.1, 5.2, 5.3, 8.1, 8.2, 8.3_

  - [x] 1.3 Implement `runSurvivorDedup()` entry point
    - Query DB for active image media items with embeddings for the trip
    - Early exit when 0 or 1 survivors (return zero-result)
    - Filter out photos with null embeddings
    - Call `computeTopKNeighbors` with `globalSimilarityTopK` (default 10)
    - Call `buildEligiblePairs` and `clusterAndResolve`
    - Apply DB updates: set `status='trashed'`, append `trashed_reason='global_similarity_after_vlm'`
    - Log trashed count using pattern `[highlightService] Auto-trashed N global-survivor-dedup photos for trip {tripId}`
    - Wrap entire function in try/catch; on error, log and return zero-result
    - _Requirements: 1.2, 1.3, 2.4, 2.5, 6.1, 6.2, 6.3, 7.2, 9.1, 9.2, 9.3, 9.4_

- [x] 2. Integrate into `highlightService.ts`
  - [x] 2.1 Add `globalSimilarityAfterVlmDeletedCount` field to `HighlightEvaluation` interface and insert the stage call
    - Add optional `globalSimilarityAfterVlmDeletedCount?: number` field to `HighlightEvaluation` interface
    - Import `runSurvivorDedup` from `./smartCuration/survivorDedup`
    - Insert call between step 10 (similar-group trashing) and step 11 (overexposure trashing)
    - Include `globalSimilarityAfterVlmDeletedCount` in the returned result object
    - Wrap call in try/catch so failures don't break the pipeline
    - _Requirements: 1.1, 7.1, 9.3_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Write unit tests for `survivorDedup.ts`
  - [ ]* 4.1 Write property test for pair classification (Property 2: Threshold-Based Pair Classification)
    - **Property 2: Threshold-Based Pair Classification**
    - For any two photos with valid embeddings: similarity >= 0.88 → confirmed-eligible; [0.82, 0.88) → gray-zone; < 0.82 → not eligible
    - **Validates: Requirements 3.1, 4.1**

  - [ ]* 4.2 Write property test for temporal gate (Property 3: Gray-Zone Temporal Gate)
    - **Property 3: Gray-Zone Temporal Gate**
    - For any gray-zone pair: eligible iff |createdAt_i - createdAt_j| <= 30 seconds
    - **Validates: Requirements 4.2, 4.3**

  - [ ]* 4.3 Write property test for keeper selection (Property 4: Keeper Selection by Quality)
    - **Property 4: Keeper Selection by Quality**
    - For any eligible cluster, the photo with highest composite score survives; all others are trashed
    - **Validates: Requirements 3.2, 4.4, 5.1, 8.2**

  - [ ]* 4.4 Write property test for tie-breaking (Property 5: Tie-Breaking by Earliest Timestamp)
    - **Property 5: Tie-Breaking by Earliest Timestamp**
    - When two photos have identical quality scores, the one with earlier `created_at` is kept
    - **Validates: Requirements 5.3**

  - [ ]* 4.5 Write property test for cluster transitive closure (Property 8: Cluster Transitive Closure)
    - **Property 8: Cluster Transitive Closure**
    - Connected eligible pairs form a single cluster resolved together with exactly one keeper
    - **Validates: Requirements 8.1, 8.3**

  - [ ]* 4.6 Write unit tests for edge cases and early exits
    - Test: 0 survivors → immediate return with count 0
    - Test: 1 survivor → immediate return with count 0
    - Test: all null embeddings → no pairs found, count 0
    - Test: error during execution → returns zero-result, does not throw
    - **Validates: Requirements 1.3, 9.1, 9.2, 9.3**

- [x] 5. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The project uses **TypeScript** with **Vitest** test runner and **fast-check** for property-based tests
- Existing functions reused: `computeTopKNeighbors`, `cosineSimilarity`, `selectBestByQuality`, `computeCompositeScore` from `globalSimilarity.ts`; `UnionFind` from `unionFind.ts`
- Test file location: `server/src/services/smartCuration/__tests__/survivorDedup.test.ts`
- The `PROCESS_THRESHOLDS` object already contains `dinov2ConfirmedThreshold` (0.88), `dinov2DedupThreshold` (0.82), and `globalSimilarityTopK` (10)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"] }
  ]
}
```
