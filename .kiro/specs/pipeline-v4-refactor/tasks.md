# Implementation Plan: Pipeline V4 Refactor

## Overview

Refactor the image processing pipeline from "algorithm services write DB directly" to a three-phase "assess → reduce → write" architecture. Implementation follows a bottom-up order: types/config foundation → Python changes → pure assessment functions → reducer/writer → orchestrator → thin route layer → tests.

## Tasks

- [x] 1. Create pipeline types and unified thresholds config (foundation)
  - [x] 1.1 Create `server/src/services/pipeline/types.ts` with all pipeline type definitions
    - Define `ClassificationAssessment`, `BlurAssessment`, `DedupAssessment` types
    - `ImageProcessContext` must include: downloadOk, downloadError, processingErrors array, plus nullable assessment slots
    - `DedupAssessment` must include: skippedReasons map, capabilitiesUsed record, evidenceByPair array
    - `PerImageFinalDecision` must use `trashedReasons: Array<'blur' | 'duplicate'>` (not comma-joined string)
    - Define `PipelineStage`, `PipelineProgressCallback`, `PipelineOptions`, `PipelineResult` (with skippedCount, partialFailureCount, downloadFailedCount)
    - Export `ClassifySource`, `BlurSource` type aliases
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.2 Refactor `server/src/services/dedupThresholds.ts` to export unified `PROCESS_THRESHOLDS`
    - Add `ProcessThresholds` interface with blur thresholds (blurThreshold, clearThreshold, musiqBlurThreshold), dedup thresholds (hashHammingThreshold, clipConfirmedThreshold, clipGrayHighThreshold, clipGrayLowThreshold, clipStrictThreshold, clipTopK, grayLowSeqDistance, grayLowHashDistance), and dinov2DedupThreshold
    - Create `PROCESS_THRESHOLDS` frozen object reading each value from `process.env` with existing defaults
    - Preserve legacy named exports (`HASH_HAMMING_THRESHOLD`, `CLIP_CONFIRMED_THRESHOLD`, etc.) as aliases to `PROCESS_THRESHOLDS` fields for backward compatibility
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 2. Python analyze.py separate error fields + pythonAnalyzer adapter
  - [x] 2.1 Modify `server/python/analyze.py` `cmd_analyze` to output separate `classify_error` and `blur_error` fields
    - Wrap classification in its own try/catch, set `classify_error` to error message string on failure (null on success)
    - Wrap blur detection in its own try/catch, set `blur_error` to error message string on failure (null on success)
    - Remove the shared `error` boolean and `error_message` field from output — Python analyze output must NOT include any image-level shared error boolean. Errors must be capability-scoped only.
    - Ensure blur results are returned even when classification fails, and vice versa
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 2.2 Update `server/src/services/pythonAnalyzer.ts` `mapAnalyzeResult` to parse new fields
    - Map `classify_error` and `blur_error` from Python output to `PythonAnalyzeResult`
    - Add `classifyError` and `blurError` fields to `PythonAnalyzeResult` interface
    - Update `analyzeImages` callers to handle per-capability errors
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 3. Checkpoint - Ensure foundation and Python changes are correct
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Pure assessment functions for blur, classify, dedup
  - [x] 4.1 Add `assessBlur` pure function to `server/src/services/blurDetector.ts`
    - Export `assessBlur(imagePath: string): Promise<BlurAssessment>` — this is a Node.js Laplacian-only helper, NOT the fallback chain owner
    - Python blur is driven by orchestrator's `runBlurStage` via `pythonAnalyzer`; `assessBlur` is the Node fallback called when Python fails
    - The function must NOT import or call `getDb()`, `getStorageProvider()`, or any DB statements
    - On error, return `{ blurStatus: 'suspect', sharpnessScore: null, source: 'node', error: errorMessage }`
    - Read thresholds from `PROCESS_THRESHOLDS` instead of local constants
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 4.2 Add `assessClassification` pure function to `server/src/services/imageClassifier.ts`
    - Export `assessClassification(imageBytes: Buffer): Promise<ClassificationAssessment>` — this is a Rekognition-only helper, NOT the fallback chain owner
    - Python CLIP classification is driven by orchestrator's `runClassifyStage` via `pythonAnalyzer`; `assessClassification` is the Rekognition fallback called when Python fails
    - Export `assessFromLabels(labels: LabelWithConfidence[]): ClassificationAssessment` for mapping raw labels
    - The function must NOT import or call `getDb()` or execute any DB statements
    - _Requirements: 3.2, 3.4_

  - [x] 4.3 Add `assessDedup` pure function to `server/src/services/hybridDedupEngine.ts`
    - Export `assessDedup(rows: ImageRow[], tempCache: TempPathCache): Promise<DedupAssessment>` that runs the four-layer hybrid pipeline and returns a `DedupAssessment` with confirmedPairs, groups, kept, removed, skippedIndices, skippedReasons, capabilitiesUsed, evidenceByPair
    - Self-detect Python/ML availability internally via `isPythonAvailable()` and `isMLServiceAvailable()` — remove `pythonAvailable` option
    - assessDedup() must NOT implicitly read or write DB state to decide keep/remove — all decision inputs must come from function arguments or pure helper outputs
    - Track download failures in `skippedIndices` with reasons in `skippedReasons`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 5. Checkpoint - Ensure pure assessment functions work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. ResultReducer and ResultWriter
  - [x] 6.1 Create `server/src/services/pipeline/resultReducer.ts`
    - Export `reduce(contexts: ImageProcessContext[], dedupAssessment: DedupAssessment | null): PerImageFinalDecision[]`
    - Reducer does NOT do multi-source priority — fallback chains are resolved within stages
    - Reducer only handles: blur → add 'blur' to trashedReasons, dedup removed → add 'duplicate' to trashedReasons, empty reasons → active
    - When all assessments null → active, category=other, blurStatus=suspect
    - Return exactly one `PerImageFinalDecision` per context
    - _Requirements: 6.1, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 6.2 Create `server/src/services/pipeline/resultWriter.ts`
    - Export `writeDecisions(tripId: string, decisions: PerImageFinalDecision[]): WriteResult`
    - Use `getDb().transaction()` to wrap all updates in a single transaction
    - Update `blur_status`, `sharpness_score`, `category`, `status`, `trashed_reason`, `processing_error` on `media_items`
    - For `trashed_reason`: store first element of `trashedReasons` array (or comma-join for DB compat)
    - Delete old `category:*` tags and insert new category tag in `media_tags` within the same transaction
    - On transaction failure, roll back and return error in `WriteResult`
    - NOTE: Current version does NOT maintain duplicate_groups table — dedup results only update media_items
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7_

- [x] 7. Pipeline orchestrator
  - [x] 7.1 Create `server/src/services/pipeline/runTripProcessingPipeline.ts`
    - Export `runTripProcessingPipeline(tripId: string, options?: PipelineOptions): Promise<PipelineResult>`
    - Implement `collectInputs`: query active images, download to temp via `TempPathCache`, build `ImageProcessContext[]`
    - Implement `runClassifyStage`: owns the fallback chain — for each context, try Python CLIP (via pythonAnalyzer) → Rekognition (`assessClassification`) → fallback, set `context.classification`. Per-image try/catch: one image failure does NOT null the entire stage.
    - Implement `runBlurStage`: owns the fallback chain — for each context, try Python blur (via pythonAnalyzer) → Node.js Laplacian (`assessBlur`), set `context.blur`. Per-image try/catch: one image failure does NOT null the entire stage.
    - Implement `runDedupStage`: call `assessDedup`, return `DedupAssessment`
    - Execute stages in order: collect → classify → blur → dedup → reduce → write
    - Each stage wrapped in independent try/catch; on failure, record error and continue
    - Support per-image partial failure: a single image failure only nulls that image's assessment, not the entire stage result
    - When all three assessments fail for an image, mark with processingError, retain as active with category=other
    - After write, continue with existing analyze → optimize → thumbnail → video → cover stages
    - Call `onProgress` callback at each stage start/complete
    - Return `PipelineResult` summary
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.3, 3.5_

- [x] 8. Checkpoint - Ensure orchestrator works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Thin route layer (process.ts refactor)
  - [x] 9.1 Refactor `server/src/routes/process.ts` POST handler
    - Remove all direct calls to `detectBlurry`, `classifyTrip`, `hybridDeduplicate`, `analyzeImages`, `applyPythonAnalyzeResults`
    - Remove `getCategoryStats` helper and all inline DB queries for building the response
    - process.ts must NOT contain any classify/blur/dedup fallback logic, per-image apply logic, or direct DB update logic — all processing logic must live under server/src/services/pipeline/
    - Validate trip exists, check not already processing, call `runTripProcessingPipeline(tripId)`, return result as JSON
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 9.2 Refactor `server/src/routes/process.ts` SSE streaming handler
    - Remove all direct algorithm service calls and inline DB queries
    - Setup SSE, call `runTripProcessingPipeline(tripId, { onProgress })`, forward progress events via SSE
    - Handle client disconnect and heartbeat as before
    - _Requirements: 8.4_

  - [x] 9.3 Verify `blurDetector`, `imageClassifier`, and `hybridDedupEngine` contain zero DB import statements in their pure assessment paths
    - Ensure the new `assessBlur`, `assessClassification`, `assessDedup` functions have no `getDb` calls
    - Existing legacy functions (`detectBlurry`, `classifyTrip`, `hybridDeduplicate`) may retain DB access for backward compatibility
    - _Requirements: 7.6_

- [x] 10. Checkpoint - Ensure route refactor works
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Tests
  - [ ]* 11.1 Write property tests for ResultReducer (`server/src/services/pipeline/resultReducer.test.ts`)
    - **Property 3: Reducer completeness** — generate random null/non-null assessment combos, verify one decision per context with valid fields
    - **Property 4: Fallback chain in stages** — mock runClassifyStage with Python failure, verify Rekognition attempted then fallback
    - **Property 5: Blur fallback chain in stages** — mock runBlurStage with Python failure, verify Node.js attempted then suspect
    - **Property 6: TrashedReason derivation** — generate all combos of blurry × dedup-removed × all-null, verify trashedReasons array
    - **Validates: Requirements 6.1, 6.4, 6.5, 6.6, 6.7, 6.8**

  - [ ]* 11.2 Write property tests for ResultWriter (`server/src/services/pipeline/resultWriter.test.ts`)
    - **Property 7: Transaction atomicity** — generate random decisions, inject DB failures, verify all-or-nothing
    - **Property 8: ResultWriter field coverage** — generate random decisions, verify all six fields + tags updated
    - **Validates: Requirements 7.2, 7.3, 7.4, 7.5**

  - [ ]* 11.3 Write property tests for PROCESS_THRESHOLDS (`server/src/services/dedupThresholds.test.ts`)
    - **Property 9: Environment variable threshold overrides** — generate random threshold keys and numeric values, set env vars, verify PROCESS_THRESHOLDS reflects them
    - **Validates: Requirements 10.2**

  - [ ]* 11.4 Write unit tests for orchestrator stage ordering (`server/src/services/pipeline/runTripProcessingPipeline.test.ts`)
    - **Property 2: Stage failure independence** — mock stages to throw, verify subsequent stages still execute
    - Test that classify failure doesn't prevent blur/dedup from running
    - Test that all-null assessments produce active/other/suspect result
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.6**

  - [ ]* 11.5 Write property tests for blur failure fallback (`server/src/services/blurDetector.test.ts`)
    - **Property 10: Blur failure fallback** — generate random errors, verify suspect/null/error-message result
    - **Validates: Requirements 4.4**

  - [ ]* 11.6 Write integration test for full pipeline (`server/src/services/pipeline/pipeline.integration.test.ts`)
    - Test full pipeline with mocked algorithm services, verify DB state after completion
    - Test Python fallback chain (Python available → unavailable)
    - Test SSE progress event sequence
    - **Validates: Requirements 2.1, 8.1, 8.2, 8.3, 8.4**

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Legacy functions (`detectBlurry`, `classifyTrip`, `hybridDeduplicate`) are preserved for backward compatibility but are no longer called by the pipeline
- Property tests use `fast-check` library
- All new pipeline files go in `server/src/services/pipeline/` directory
