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
- **Global_Similarity_Candidate_Generation**: A post-preliminary-reducer stage (`globalSimilarity.ts`) that finds similar photo pairs across the entire trip using stored DINOv2 embeddings regardless of capture time proximity
- **DINOv2_Embeddings**: 384-dimensional feature vectors produced by DINOv2-small, stored in the database and reused by this stage for visual similarity
- **CLIP_Embeddings**: 512-dimensional feature vectors extracted by the CLIP model. Used by the separate `hybrid-dedup` pipeline, **not** by Global_Similarity_Candidate_Generation
- **Connected_Component_Analysis**: Image processing technique that identifies contiguous regions of pixels sharing a property (here: high brightness combined with low saturation in HSV, evaluated with 8-connectivity)

## Requirements

### Requirement 1: Subject-Level Overexposure Detection

**User Story:** As a dive photographer, I want overexposure detection to identify photos where the subject (nudibranch, diver equipment, coral) is blown out even when the overall image is dark, so that technically ruined underwater shots are automatically trashed.

#### Qualifying Region Definition

THE Subject_Overexposure_Detector SHALL treat a connected component of the HSV bright mask (8-connectivity) as a *qualifying region* only when **all four** of the following hold. These are labelled Q1–Q4 rather than numbered, so that traceability references of the form `1.N` unambiguously mean acceptance criterion N below.

- **Q1 — Brightness.** HSV V >= `overexposureSubjectVThreshold` (default 245)
- **Q2 — Low saturation.** HSV S <= `overexposureSubjectSThreshold` (default 45), i.e. near-white
- **Q3 — Detail lost.** The standard deviation of the Sobel gradient magnitude over the component's interior pixels < `overexposureTextureGradientThreshold` (default 5.0). THE detector SHALL derive interior pixels by eroding the component mask with a 3×3 rectangular kernel, and SHALL fall back to the un-eroded mask when erosion leaves fewer than 10 pixels.
- **Q4 — Minimum size.** Component area >= `overexposureMinComponentPixels` (default 300 pixels)

#### Acceptance Criteria

1. THE Subject_Overexposure_Detector SHALL apply center weighting: a qualifying region whose bounding box overlaps the central 60% of the image (x ∈ [0.2W, 0.8W], y ∈ [0.2H, 0.8H]) SHALL contribute its area multiplied by `center_weight` (default 1.5) to the aggregate area ratio; all other regions contribute their unweighted area.
2. THE Subject_Overexposure_Detector SHALL compute `totalBrightArea` as the sum of weighted qualifying-region areas divided by total image pixels, and `largestRegionRatio` as the largest single **unweighted** qualifying-region area divided by total image pixels.
3. WHEN `totalBrightArea` >= `overexposureSubjectSevereTotalAreaRatio` (default 0.012) OR any single unweighted qualifying region exceeds `overexposureSubjectMaxAreaRatio` (default 0.015) of total image area, THE Subject_Overexposure_Detector SHALL classify severity as `severe`
4. WHEN severity is not `severe` and `totalBrightArea` >= `overexposureSubjectMinAreaRatio` (default 0.006), THE Subject_Overexposure_Detector SHALL classify severity as `mild`
5. WHEN neither the `severe` nor the `mild` condition is met, THE Subject_Overexposure_Detector SHALL classify severity as `none`
6. THE Subject_Overexposure_Detector SHALL set `subjectOverexposed` to true when and only when severity is `mild` or `severe`
7. WHEN severity is `mild`, THE Subject_Overexposure_Detector SHALL emit a `qualityPenalty` of -0.15; WHEN severity is `none` or `severe`, THE Subject_Overexposure_Detector SHALL emit a `qualityPenalty` of 0.0
8. WHEN `subjectOverexposed` is true, THE Subject_Overexposure_Detector SHALL set `overexposureReason` to `subject_highlight_clipped`; otherwise it SHALL set `overexposureReason` to null
9. THE Subject_Overexposure_Detector SHALL return the fields `severity`, `subjectOverexposed`, `largestRegionRatio`, `totalBrightArea`, `numQualifyingRegions`, `overexposureReason` and `qualityPenalty`
10. WHEN zero qualifying regions are found, THE Subject_Overexposure_Detector SHALL return severity `none`, `subjectOverexposed` false, `largestRegionRatio` null, `totalBrightArea` 0.0 and `numQualifyingRegions` 0
11. THE global Overexposure_Detector SHALL independently compute the fraction of grayscale pixels with value > 240 and SHALL classify the image as `overexposed` when that fraction >= `overexposureGlobalRatio` (default 0.40), otherwise `normal`
12. IF OpenCV cannot decode the image during the global check, THEN THE Overexposure_Detector SHALL return status `unknown` with a null ratio
13. IF OpenCV or image decoding fails inside `detect_subject_overexposure`, THEN the Python function SHALL return severity `none` with `subjectOverexposed` false and SHALL log the failure with the image path to stderr
14. WHEN the Python result carries `overexposureError`, or `subjectOverexposure` is null, THE Pipeline SHALL fall back to a Node-side global brightness check implemented with `sharp` — grayscale raw buffer, count pixels with value > 240, compare the ratio against `overexposureGlobalRatio` — and SHALL log `[overexposure] OpenCV/decode failure for {mediaId}, falling back to sharp`
15. THE Pipeline SHALL map Python severity to `overexposureStatus` as follows: `severe` → `overexposed`; `mild` → `normal` carrying the quality penalty; `none` → `normal`
16. THE Pipeline SHALL pass every threshold in this requirement to `analyze.py` as an explicit CLI argument read from `PROCESS_THRESHOLDS`, using the flags `--subject-v-threshold`, `--subject-s-threshold`, `--min-area-ratio`, `--max-area-ratio`, `--severe-total-area-ratio`, `--min-component-pixels` and `--texture-gradient-threshold`

#### Two-Layer Failure Handling

Criteria 13 and 14 describe two different layers and both are in force:

| Layer | On decode / OpenCV failure |
| --- | --- |
| `analyze.py` `detect_subject_overexposure` | Returns severity `none`; does **not** itself consult the global check |
| Pipeline overexposure stage (`runTripProcessingPipeline.ts`) | Detects the error signal and runs the `sharp`-based global brightness check as a fallback |

The net observable behaviour is therefore that a failed subject analysis still receives a global overexposure verdict — but the fallback lives in the Node stage, not in the Python detector.

#### Anti-False-Positive Rationale

The saturation and texture-gradient criteria exist to suppress specific underwater false positives, and SHALL be preserved if the thresholds are retuned:

- **Bright sand / seafloor** — retains texture, so gradient std exceeds the threshold and the region is excluded
- **Water-surface reflections** — typically small and scattered, so they fail the area threshold
- **Bubbles and specular highlights** — small components, so they fail the `overexposureMinComponentPixels` threshold

#### Not Implemented

The LAB colour space (L-channel) is **not** used. An earlier draft of this requirement specified `L > 230` in LAB as an alternative brightness test; `analyze.py` performs the brightness and saturation tests in HSV only.

### Requirement 2: Result Reducer Recognizes Overexposure Trash Reason

**User Story:** As a pipeline developer, I want the result reducer to recognize `overexposure` as a valid trash reason, so that photos trashed by the overexposure stage remain trashed after the reduce step.

#### Acceptance Criteria

1. THE `TrashReason` type SHALL comprise exactly four values: `blur`, `overexposure`, `duplicate` and `global_similarity`
2. WHEN an image has been marked as overexposed by the overexposure stage (status set to `trashed` with `trashed_reason` containing `overexposure`), THE Result_Reducer SHALL include `overexposure` in the `trashedReasons` array for that image
3. WHEN an image is both blurry and overexposed, THE Result_Reducer SHALL list `blur` first in the `trashedReasons` array, followed by `overexposure`
4. WHEN an image is overexposed but no other reason applies, THE Result_Reducer SHALL set `finalStatus` to `trashed` with `overexposure` as the sole trash reason
5. THE Result_Reducer SHALL apply priority ordering `blur` (highest) > `overexposure` > `duplicate` > `global_similarity` (lowest) when multiple reasons apply
6. WHEN an image is in the global similarity trashed set, THE Result_Reducer SHALL append `global_similarity` to `trashedReasons`
7. THE Result_Reducer SHALL accept a `globalSimilarityAssessment` parameter alongside the existing `dedupAssessment`
8. THE Result_Reducer SHALL set `finalStatus` to `trashed` if and only if `trashedReasons` is non-empty
9. THE Result_Reducer SHALL treat only overexposure severity `severe` as grounds for appending `overexposure`; severity `mild` SHALL contribute a quality penalty without trashing the image

### Requirement 3: Global Similarity Candidate Generation Across Batches

**User Story:** As a travel photographer, I want similar photos taken at different times during my trip to be identified and compared, so that redundant shots of the same subject taken hours apart are not all kept in the final album.

#### Acceptance Criteria

1. WHEN the pipeline reaches the similarity detection phase, THE Pipeline SHALL fetch stored **DINOv2** embeddings for `prelimActiveMediaIds` — the images that survived the reducer's preliminary blur / overexposure / hash-dedup pass — regardless of capture time
2. WHEN embeddings are available, THE Pipeline SHALL compute top-K nearest neighbors (K configurable via `GLOBAL_SIMILARITY_TOP_K`, default 10, exposed as `PROCESS_THRESHOLDS.globalSimilarityTopK`) for each image using cosine similarity
3. WHEN a pair has cosine similarity >= `dinov2ConfirmedThreshold` (default 0.88), THE Pipeline SHALL classify the pair as `confirmed`
4. WHEN a pair has cosine similarity >= `dinov2GrayLowThreshold` (default 0.75) and < `dinov2ConfirmedThreshold`, THE Pipeline SHALL classify the pair as `gray_zone`
5. WHEN a pair has cosine similarity < `dinov2GrayLowThreshold`, THE Pipeline SHALL discard the pair entirely
6. THE Pipeline SHALL build clusters in two phases: phase 1 applies Union-Find over `confirmed` pairs only; phase 2 attaches `gray_zone` pairs as evidence when both endpoints already share a cluster, and flags them for VLM review when they would bridge two clusters
7. THE Pipeline SHALL NOT allow a `gray_zone` pair to merge two otherwise separate clusters
8. THE Pipeline SHALL enforce a cluster size cap of `CLUSTER_SIZE_CAP` (8) by iteratively removing the weakest intra-cluster edge until every component is within the cap
9. THE Pipeline SHALL trash a cluster member only when that member has a direct confirmed edge to the selected keeper or to the cluster medoid, and SHALL log skipped members as `[globalSimilarity] Skipped trash for {ids}: no direct edge to selected/medoid`
10. WHEN a cluster contains only `confirmed` pairs, THE Pipeline SHALL resolve it with the local quality selector and SHALL NOT invoke the VLM
11. WHEN a cluster contains `gray_zone` pairs, THE Pipeline SHALL resolve it by VLM selection
12. IF the VLM fails on a confirmed-only cluster, THEN THE Pipeline SHALL still resolve it using the local quality selector
13. IF the VLM fails on a cluster containing `gray_zone` pairs, THEN THE Pipeline SHALL keep every member (`fallback_keep_all`) and SHALL log `[globalSimilarity] VLM failed on gray-zone cluster {clusterId} ({n} members) — keeping all` with warning code `vlm_failed_on_gray_zone_cluster`
14. THE local quality selector SHALL rank candidates by the composite score `sharpness * 0.4 + aesthetic * 0.3 + exposure * 0.3 + overexposureQualityPenalty`
15. WHEN the ML embedding service is unavailable, THE Pipeline SHALL skip global similarity candidate generation entirely and log `[globalDedup] ML service unavailable — skipping global similarity detection`
16. THE Pipeline SHALL execute global similarity candidate generation after the preliminary reducer pass and before Scene_Dedup, so that cross-batch duplicates are resolved before within-batch scene dedup runs
17. THE Pipeline SHALL report per-run counts of `localQualityResolved`, `vlmResolved` and `fallbackKeptAll` clusters

#### Correction Note

Criteria 1, 3 and 4 previously specified **CLIP** embeddings with `CLIP_CONFIRMED_THRESHOLD` (0.93) and `CLIP_GRAY_LOW_THRESHOLD`. That was wrong on all three counts. `globalSimilarity.ts` uses DINOv2 embeddings and the `dinov2*` threshold family (0.88 / 0.75). The CLIP threshold family still exists in `PROCESS_THRESHOLDS` but serves the separate `hybrid-dedup` pipeline, not this stage.

### Requirement 4: VLM Status Reporting in Job Summary

**User Story:** As a system operator, I want to see whether AI curation stages actually ran successfully, so that I can distinguish between "AI found nothing to trash" and "AI was never called due to failure."

#### Acceptance Criteria

1. THE Job_Summary SHALL include a `vlmStatus` field whose value is one of exactly six: `not_configured`, `disabled`, `skipped`, `success`, `partial_failure`, `failed`
2. THE `deriveVLMStatus(stats, vlmEnabled, vlmAvailable)` function SHALL evaluate in this priority order and return the first match:
   1. `vlmEnabled` is false → `disabled`
   2. `vlmAvailable` is false → `not_configured`
   3. `stats.totalCalls === 0` → `skipped`
   4. `failedCalls === 0` and `successfulCalls > 0` → `success`
   5. `successfulCalls > 0` and `failedCalls > 0` → `partial_failure`
   6. `failedCalls > 0` and `successfulCalls === 0` → `failed`
   7. otherwise → `skipped`
3. WHEN `AI_REVIEW_ENABLED` is false, THE Pipeline SHALL set `vlmStatus` to `disabled`
4. WHEN no VLM provider credentials are configured, THE Pipeline SHALL set `vlmStatus` to `not_configured`
5. WHEN the VLM is available but no call was made (for example a stage had fewer than 2 photos), THE Pipeline SHALL set `vlmStatus` to `skipped`
6. WHEN VLM calls were attempted and all of them failed, THE Pipeline SHALL set `vlmStatus` to `failed`
7. THE Job_Summary SHALL include a `vlmCallStats` object containing `totalCalls`, `successfulCalls`, `failedCalls`, `parseFailures`, `timeoutFailures`, `providerAuthFailures`, `skippedStages`, `stageStats` and `diagnostic`
8. THE Pipeline SHALL create one shared `VLMCallStats` tracker per run via `createVLMCallStatsTracker()`, pass it to aiReview, sceneDedup, aiRefinement and global similarity, and have each VLM call increment it in real time; stage-level result objects SHALL be used for debug logging only and SHALL NOT be re-added to the shared tracker
9. THE shared tracker SHALL be the sole authority for deriving the final `vlmStatus`
10. WHEN `vlmStatus` is not `success`, THE Job_Summary SHALL carry a human-readable `diagnostic` string describing the reason (e.g. "No VLM provider configured", "3/5 batch calls timed out", "Auth error on provider=openai")
11. THE `PipelineResult` SHALL additionally report the per-stage trash counters `blurryDeletedCount`, `overexposureDeletedCount`, `dedupDeletedCount`, `globalSimilarityTrashedCount`, `aiReviewTrashedCount`, `sceneDedupTrashedCount` and `aiRefinementTrashedCount`

#### Correction Note

Criteria 1, 4 and 5 previously described a four-value enum including `unavailable`, and mapped "all calls failed" to `skipped`. `VLMStatus` in `server/src/services/pipeline/types.ts` has six values and no `unavailable`; unconfigured providers yield `not_configured` and total failure yields `failed`. The `skipped` value means the opposite of the old text: the VLM was available but never called.

### Requirement 5: Threshold and Log Consistency

**User Story:** As a developer debugging curation results, I want logged threshold values to match the actual values used in processing, so that I can trust diagnostic logs when investigating unexpected curation outcomes.

#### Scope Note

An earlier draft of this requirement demanded that **all** processing thresholds live in a single registry (`PROCESS_THRESHOLDS`). That absolute rule was never achieved and is not the current intent. The requirement now defines `PROCESS_THRESHOLDS` as the **primary** registry, enumerates the permitted secondary locations, and holds every location to the same discoverability and logging standard. Consolidating the secondary locations into `PROCESS_THRESHOLDS` is a possible future refactor, not an obligation of this spec.

#### Acceptance Criteria

1. THE Pipeline SHALL treat `PROCESS_THRESHOLDS` (`server/src/services/dedupThresholds.ts`) as the primary registry for image-processing detection thresholds — blur, clarity, hash hamming distance, overexposure, DINOv2 similarity, CLIP similarity, and top-K neighbour counts — and SHALL read those values from it rather than from inline literals
2. THE Pipeline SHALL confine threshold definitions outside `PROCESS_THRESHOLDS` to the locations enumerated in the Permitted Secondary Locations table below
3. WHEN a new image-curation detection threshold is introduced, THE Pipeline SHALL define it in `PROCESS_THRESHOLDS` unless it belongs to one of the permitted secondary categories (per-stage VLM batch size, per-stage concurrency limit, or VLM transport setting)
4. WHEN a stage logs a threshold value, THE Pipeline SHALL log the exact value read from its defining registry, not a hardcoded literal that may diverge from the runtime value
5. WHEN Python analysis is invoked with threshold arguments, THE Pipeline SHALL pass the values from `PROCESS_THRESHOLDS` as explicit CLI arguments and SHALL log the passed values
6. IF a threshold environment variable override is malformed (non-numeric, or outside the declared valid range), THEN the defining module SHALL fall back to the documented default and SHALL log a warning naming the variable, the rejected value, the valid range, and the default in use
7. THE Pipeline SHALL log the active values of the primary-registry thresholds once at pipeline start, in a single structured line beginning `[pipeline] thresholds:` and including at minimum `blur`, `overexposureGlobal`, `overexposureSubjectV`, `overexposureSubjectS`, `overexposureSevereTotalArea`, `dinov2Confirmed`, `dinov2GrayLow`, `dinov2Dedup`, `clipConfirmed` and `globalSimilarityTopK`
8. THE overexposure stage SHALL log the exact threshold set handed to `analyze.py` in a `[pythonAnalyzer] passing overexposure thresholds:` line covering V, S, minArea, maxArea, severeTotalArea, minComponentPixels and textureGradient
9. THE Pipeline SHALL NOT be considered in violation of this requirement solely because a threshold is defined in a permitted secondary location

#### Permitted Secondary Locations

Each entry below is a threshold or limit that is intentionally **not** in `PROCESS_THRESHOLDS`. Any change to this table is a change to this requirement.

| Location | Values defined | Env override | Rationale |
| --- | --- | --- | --- |
| `smartCuration/similarityGrouper.ts` | `EXACT_DUPLICATE_THRESHOLD` (0.98), `NEAR_DUPLICATE_THRESHOLD` (0.80) | `SMART_CURATION_EXACT_THRESHOLD`, `SMART_CURATION_NEAR_THRESHOLD` | Tuned against DINOv2-small behaviour on burst shots and low-contrast dive photos; tracked as authoritative in `smart-curation` Requirement 11 |
| `smartCuration/aiFinalDedup.ts` | batch size (default 12, valid range 2–12), `VLM_CONCURRENCY` (3), `PER_BATCH_IMAGE_CONCURRENCY` (5) | `SMART_CURATION_DEDUP_BATCH_SIZE` | Per-stage VLM batching policy, not a detection threshold |
| `smartCuration/aiReview.ts` | `BATCH_SIZE` (5), `VLM_CONCURRENCY` (3), `PER_BATCH_IMAGE_CONCURRENCY` (5) | none | Per-stage VLM batching policy |
| `smartCuration/sceneDedup.ts` | `DEFAULT_BATCH_SIZE` (15), `PER_BATCH_IMAGE_CONCURRENCY` (5) | none | Per-stage VLM batching policy |
| `smartCuration/vlmClient.ts` | request timeout (60000 ms), max tokens (2048), provider selection, per-provider model defaults | `SMART_CURATION_VLM_TIMEOUT_MS`, `SMART_CURATION_VLM_PROVIDER`, provider/model variables | VLM transport and provider configuration, unrelated to image analysis |
| `smartCuration/unionFind.ts` | `CLUSTER_SIZE_CAP` (8) | none | Clustering safeguard rather than a detection threshold; owned by Requirement 3 criterion 8 |
| `server/python/analyze.py` | `center_weight` (1.5) | none | Known gap: this is the only subject-overexposure parameter not passed as a CLI argument, so it cannot currently be tuned without editing Python. See Requirement 1 |

#### Out of Scope

`server/src/services/videoThresholds.ts` is a separate registry serving the video pipeline and declares itself the single source of truth for video thresholds. This requirement governs the image-processing pipeline only and makes no claim over it.

### Requirement 6: Correct Stage Error Labeling

**User Story:** As a developer reviewing pipeline error logs, I want overexposure stage errors to be attributed to the `overexposure` stage, so that error diagnostics correctly identify which processing stage failed.

#### Acceptance Criteria

1. WHEN the overexposure stage throws an error, THE Pipeline SHALL record the error with `stage: 'overexposure'` in the `stageErrors` array
2. THE Pipeline SHALL NOT label overexposure stage errors with `stage: 'blur'`
3. WHEN querying stage errors for diagnostic purposes, THE Pipeline SHALL return distinct error entries for blur and overexposure stages if both fail independently
