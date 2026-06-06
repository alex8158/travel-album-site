# Requirements Document

## Introduction

This specification addresses six interconnected photo curation deficiencies in the travel album processing pipeline. The current system fails to detect subject-level overexposure in underwater photography, silently overwrites overexposure trash decisions in the result reducer, misses similar photos that span different capture-time batches, hides VLM processing failures from the user, logs threshold values that differ from those used in actual processing, and mislabels overexposure stage errors as blur errors.

These fixes target the server-side pipeline only (no frontend changes) and must preserve existing blur detection, hash-based dedup, and the conservative "keep all on failure" policy.

## Glossary

- **Pipeline**: The server-side `runTripProcessingPipeline.ts` orchestrating all image processing stages in sequence
- **Result_Reducer**: `server/src/services/pipeline/resultReducer.ts` — merges stage assessments into per-image final decisions (active/trashed + reasons)
- **Overexposure_Detector**: The combined Python (`analyze.py detect_overexposure`) and Node.js fallback logic that classifies images as overexposed based on pixel brightness analysis
- **Subject_Overexposure_Detector**: A new detection mode analyzing connected bright regions in HSV/LAB color space to identify blown-out subjects against dark backgrounds
- **Scene_Dedup**: `server/src/services/smartCuration/sceneDedup.ts` — cross-photo scene redundancy detection using VLM evaluation with smart batching
- **VLM_Client**: `server/src/services/smartCuration/vlmClient.ts` — unified provider-agnostic interface for calling vision-language models
- **Job_Summary**: The `PipelineResult` object returned upon pipeline completion, consumed by the API response layer
- **Trash_Reason**: A string enum identifying why a photo was moved to trash status (e.g., `blur`, `duplicate`, `overexposure`, `scene_redundant`)
- **Boundary_Merging**: The mechanism in Scene_Dedup that uses embedding cosine similarity to merge adjacent similar photos into the same VLM evaluation batch
- **Global_Similarity_Candidate_Generation**: A pre-dedup stage that finds similar photo pairs across the entire trip using CLIP/DINOv2 embeddings regardless of capture time proximity
- **CLIP_Embeddings**: 512-dimensional feature vectors extracted by the CLIP model used for measuring visual similarity between photos
- **Connected_Component_Analysis**: Image processing technique that identifies contiguous regions of pixels sharing a property (here: high brightness in HSV V-channel or LAB L-channel)

## Requirements

### Requirement 1: Subject-Level Overexposure Detection

**User Story:** As a dive photographer, I want overexposure detection to identify photos where the subject (nudibranch, diver equipment, coral) is blown out even when the overall image is dark, so that technically ruined underwater shots are automatically trashed.

#### Acceptance Criteria

1. WHEN an image contains one or more connected bright regions (V-channel > 220 in HSV or L > 230 in LAB) covering at least 5% of total image area, THE Subject_Overexposure_Detector SHALL classify the image as `overexposed` regardless of the global brightness ratio
2. WHEN the existing global overexposure check (>40% of pixels above 240) classifies an image as `overexposed`, THE Overexposure_Detector SHALL retain that classification without requiring subject-level analysis
3. WHEN neither the global check nor the subject-level check triggers, THE Overexposure_Detector SHALL classify the image as `normal`
4. THE Subject_Overexposure_Detector SHALL use a minimum connected component size of 500 pixels to filter noise from subject detection
5. WHEN the subject-level analysis detects overexposure, THE Overexposure_Detector SHALL record the largest connected bright region area ratio as the `overexposureRatio` value
6. IF OpenCV or image decoding fails during subject-level analysis, THEN THE Overexposure_Detector SHALL fall back to the global pixel brightness check and log the failure with the image identifier

### Requirement 2: Result Reducer Recognizes Overexposure Trash Reason

**User Story:** As a pipeline developer, I want the result reducer to recognize `overexposure` as a valid trash reason, so that photos trashed by the overexposure stage remain trashed after the reduce step.

#### Acceptance Criteria

1. THE Result_Reducer SHALL recognize `overexposure` as a valid trash reason in addition to `blur` and `duplicate`
2. WHEN an image has been marked as overexposed by the overexposure stage (status set to `trashed` with `trashed_reason` containing `overexposure`), THE Result_Reducer SHALL include `overexposure` in the `trashedReasons` array for that image
3. WHEN an image is both blurry and overexposed, THE Result_Reducer SHALL list `blur` first in the `trashedReasons` array, followed by `overexposure`
4. WHEN an image is overexposed but not blurry and not a dedup duplicate, THE Result_Reducer SHALL set `finalStatus` to `trashed` with `overexposure` as the sole trash reason
5. THE Result_Reducer SHALL apply priority ordering: blur (highest) > overexposure > duplicate (lowest) when multiple reasons apply

### Requirement 3: Global Similarity Candidate Generation Across Batches

**User Story:** As a travel photographer, I want similar photos taken at different times during my trip to be identified and compared, so that redundant shots of the same subject taken hours apart are not all kept in the final album.

#### Acceptance Criteria

1. WHEN the pipeline reaches the similarity detection phase, THE Pipeline SHALL generate CLIP embedding vectors for all active images in the trip regardless of capture time
2. WHEN embeddings are available, THE Pipeline SHALL compute top-K nearest neighbors (K configurable via `GLOBAL_DEDUP_TOP_K`, default 10) for each image using cosine similarity
3. WHEN a pair of images has cosine similarity at or above the confirmed threshold (`CLIP_CONFIRMED_THRESHOLD`, default 0.93), THE Pipeline SHALL include that pair as a confirmed similar candidate for VLM evaluation
4. WHEN a pair of images has cosine similarity in the gray zone (between `CLIP_GRAY_LOW_THRESHOLD` and `CLIP_CONFIRMED_THRESHOLD`), THE Pipeline SHALL include that pair as a gray-zone candidate for VLM evaluation only if additional hash or sequence-distance criteria are met
5. THE Pipeline SHALL group confirmed and gray-zone candidate pairs into connected clusters using union-find before sending each cluster to the VLM for selection
6. WHEN the ML embedding service is unavailable, THE Pipeline SHALL skip global similarity candidate generation and log `[globalDedup] ML service unavailable — skipping global similarity detection`
7. THE Pipeline SHALL execute global similarity candidate generation before Scene_Dedup so that cross-batch duplicates are resolved before within-batch scene dedup runs

### Requirement 4: VLM Status Reporting in Job Summary

**User Story:** As a system operator, I want to see whether AI curation stages actually ran successfully, so that I can distinguish between "AI found nothing to trash" and "AI was never called due to failure."

#### Acceptance Criteria

1. THE Job_Summary SHALL include a `vlmStatus` field with one of the following values: `success`, `partial_failure`, `skipped`, `unavailable`
2. WHEN all VLM calls across all AI stages (aiReview, sceneDedup, global similarity) complete without error, THE Pipeline SHALL set `vlmStatus` to `success`
3. WHEN at least one VLM call fails but others succeed, THE Pipeline SHALL set `vlmStatus` to `partial_failure`
4. WHEN `isVLMAvailable()` returns `false` and AI stages are skipped, THE Pipeline SHALL set `vlmStatus` to `unavailable`
5. WHEN VLM calls are attempted but all fail (timeout, auth error, parse failure), THE Pipeline SHALL set `vlmStatus` to `skipped`
6. THE Job_Summary SHALL include a `vlmCallStats` object containing `totalCalls`, `successfulCalls`, `failedCalls`, and `skippedStages` (array of stage names that were skipped)
7. WHEN `vlmStatus` is not `success`, THE Job_Summary SHALL include a `vlmDiagnostic` string describing the reason (e.g., "No VLM provider configured", "3/5 batch calls timed out", "Auth error on provider=openai")

### Requirement 5: Threshold and Log Consistency

**User Story:** As a developer debugging curation results, I want logged threshold values to match the actual values used in processing, so that I can trust diagnostic logs when investigating unexpected curation outcomes.

#### Acceptance Criteria

1. THE Pipeline SHALL read all processing thresholds from the single source of truth (`PROCESS_THRESHOLDS` in `dedupThresholds.ts`) at the start of each stage
2. WHEN a stage logs a threshold value, THE Pipeline SHALL log the exact value read from `PROCESS_THRESHOLDS` (not a hardcoded literal that may diverge from the actual runtime value)
3. WHEN Python analysis is invoked with threshold arguments, THE Pipeline SHALL pass the values from `PROCESS_THRESHOLDS` as CLI arguments and log the passed values at debug level
4. IF a threshold environment variable override is malformed (non-numeric or out of valid range), THEN THE Pipeline SHALL use the default value and log a warning including the variable name, invalid value, valid range, and the default being used
5. THE Pipeline SHALL log all active threshold values at pipeline start in a single structured log line formatted as `[pipeline] thresholds: blur=${blurThreshold}, clear=${clearThreshold}, overexposure=${overexposureThreshold}, ...`

### Requirement 6: Correct Stage Error Labeling

**User Story:** As a developer reviewing pipeline error logs, I want overexposure stage errors to be attributed to the `overexposure` stage, so that error diagnostics correctly identify which processing stage failed.

#### Acceptance Criteria

1. WHEN the overexposure stage throws an error, THE Pipeline SHALL record the error with `stage: 'overexposure'` in the `stageErrors` array
2. THE Pipeline SHALL NOT label overexposure stage errors with `stage: 'blur'`
3. WHEN querying stage errors for diagnostic purposes, THE Pipeline SHALL return distinct error entries for blur and overexposure stages if both fail independently
