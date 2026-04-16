# Requirements Document

## Introduction

This spec addresses five critical robustness issues identified in the image processing pipeline of the travel photo album application. The issues span type safety, error handling, deduplication correctness, and performance. Fixing these ensures the pipeline processes trips reliably without crashes, data loss, or incorrect dedup groupings.

## Glossary

- **Pipeline**: The server-side image processing pipeline triggered by `POST /api/trips/:id/process` or the SSE streaming endpoint, encompassing blur detection, classification, deduplication, optimization, thumbnailing, and cover selection.
- **Python_Analyzer**: The TypeScript service (`pythonAnalyzer.ts`) that invokes the Python CLIP analysis script (`analyze.py`) for blur detection and image classification.
- **Blur_Detector**: The TypeScript service (`blurDetector.ts`) that performs Laplacian-variance-based blur detection with three-tier classification (clear, suspect, blurry).
- **Blur_Status**: A classification label for image sharpness. `blurDetector.ts` and `analyze.py` produce `'clear' | 'suspect' | 'blurry' | 'unknown'`. `pythonAnalyzer.ts` currently defines the type as `'clear' | 'blurry' | 'unknown'`, omitting `'suspect'`.
- **Hybrid_Dedup_Engine**: The four-layer deduplication engine (`hybridDedupEngine.ts`) that combines hash pre-filtering (Layer 0), CLIP neighbor search (Layer 1), LLM/strict-threshold review (Layer 2), and Union-Find grouping with quality selection (Layer 3).
- **Layer_0**: Hash pre-filter stage using file MD5 and pHash/dHash hamming distance to identify exact or near-exact duplicates.
- **Layer_1**: CLIP embedding neighbor search stage that identifies confirmed and gray-zone duplicate candidate pairs.
- **Layer_3**: Union-Find grouping and quality-based keeper selection stage that merges all confirmed pairs into clusters and selects the best image per cluster.
- **Quality_Selector**: The service (`qualitySelector.ts`) that computes six-dimension quality scores and selects the best image from a duplicate group.
- **Storage_Provider**: The abstraction (`StorageProvider` interface) for file storage, providing `downloadToTemp()` to obtain local file paths for processing.
- **Temp_Path_Cache**: A per-processing-run in-memory map from storage-relative file paths to local temporary file paths, ensuring each image is downloaded at most once per pipeline run.
- **Active_Image**: A media item with `status = 'active'` in the database.
- **Trashed_Image**: A media item with `status = 'trashed'` in the database, previously removed by blur detection, manual action, or other pipeline stages.

## Requirements

### Requirement 1: Align Blur Status Type Across TypeScript and Python

**User Story:** As a developer, I want the `blurStatus` type in `pythonAnalyzer.ts` to include `'suspect'` so that Python analysis results map correctly to the TypeScript type system without silent type mismatches at runtime.

#### Acceptance Criteria

1. THE Python_Analyzer `PythonAnalyzeResult.blurStatus` type SHALL include `'clear'`, `'suspect'`, `'blurry'`, and `'unknown'` as valid values.
2. THE Python_Analyzer `mapAnalyzeResult` function SHALL pass through the `blur_status` value from Python output without coercing or dropping unrecognized values.
3. WHEN the Python `analyze.py` script returns `blur_status = 'suspect'`, THE Python_Analyzer SHALL produce a `PythonAnalyzeResult` with `blurStatus = 'suspect'`.
4. THE `applyPythonAnalyzeResults` function in `process.ts` SHALL treat `'suspect'` blur status the same as `'clear'` — the image remains active with its blur score and status recorded.

### Requirement 2: Graceful Per-Image Download Failure Handling

**User Story:** As a user, I want the processing pipeline to continue processing remaining images when a single image download fails, so that one corrupted or missing file does not crash the entire batch.

#### Acceptance Criteria

1. WHEN `downloadToTemp()` fails for a single image during the Python analysis download loop, THE Pipeline SHALL skip that image, log the error, and continue downloading remaining images.
2. WHEN `downloadToTemp()` fails for a single image, THE Pipeline SHALL record the error in the `processing_error` column of the failed media item.
3. WHEN one or more image downloads fail, THE Pipeline SHALL pass only the successfully downloaded images to `analyzeImages()` and correctly map results back to the original image rows.
4. IF all image downloads fail for a trip, THEN THE Pipeline SHALL skip the Python analysis step and proceed to subsequent pipeline stages without crashing.
5. THE SSE streaming endpoint SHALL exhibit the same per-image download failure resilience as the non-streaming endpoint.

### Requirement 3: Preserve Dedup Transitivity Across Layers

**User Story:** As a user, I want the deduplication engine to correctly group all related duplicates together, so that images connected through a chain (A-B confirmed by hash, B-C needing CLIP) end up in the same cluster rather than being split.

#### Acceptance Criteria

1. WHEN Layer 0 confirms a pair of images as duplicates, THE Hybrid_Dedup_Engine SHALL retain both images in the `remainingIndices` list passed to Layer 1 so that CLIP can discover transitive relationships.
2. THE Hybrid_Dedup_Engine SHALL pass all image indices to Layer 1 regardless of Layer 0 confirmation status, while still recording Layer 0 confirmed pairs for Union-Find merging in Layer 3.
3. WHEN images A-B are confirmed by Layer 0 and images B-C are confirmed by Layer 1, THE Layer_3 Union-Find SHALL merge A, B, and C into a single duplicate group.
4. THE Hybrid_Dedup_Engine SHALL not remove any image index from processing until the final Layer 3 grouping and quality selection stage.

### Requirement 4: Active Images Take Priority Over Trashed in Dedup Keeper Selection

**User Story:** As a user, I want the dedup keeper selection to always prefer an active image over a trashed image, so that a blurry trashed photo is never chosen as the representative of a duplicate group while a sharp active photo is discarded.

#### Acceptance Criteria

1. WHEN Layer 3 selects the keeper for a duplicate group, THE Quality_Selector logic SHALL prefer any Active_Image over any Trashed_Image regardless of quality score.
2. WHEN a duplicate group contains only Trashed_Images, THE Layer_3 keeper selection SHALL fall back to quality score comparison among the trashed images.
3. WHEN a duplicate group contains multiple Active_Images, THE Layer_3 keeper selection SHALL use the existing quality score comparison (with resolution and file size tie-breakers) to choose among them.
4. WHEN a duplicate group contains exactly one Active_Image and one or more Trashed_Images, THE Layer_3 SHALL select the Active_Image as keeper without computing quality scores for the Trashed_Images.

### Requirement 5: Per-Run Temp Path Cache to Eliminate Redundant Downloads

**User Story:** As a developer, I want each processing run to download each image file at most once and reuse the local temp path across all pipeline stages, so that processing time is reduced and temporary disk usage is minimized.

#### Acceptance Criteria

1. THE Pipeline SHALL create a Temp_Path_Cache at the start of each processing run (both POST and SSE endpoints).
2. WHEN a pipeline stage needs a local file path for an image, THE Temp_Path_Cache SHALL return the previously downloaded path if the image was already downloaded during the current run, without calling `downloadToTemp()` again.
3. WHEN a pipeline stage needs a local file path for an image not yet in the cache, THE Temp_Path_Cache SHALL call `downloadToTemp()`, store the result, and return the local path.
4. WHEN the processing run completes (success or failure), THE Pipeline SHALL clean up all cached temp files in a single pass.
5. THE Temp_Path_Cache SHALL be used by the Python analysis stage, Layer 0 hash computation, Layer 1 CLIP neighbor search, Layer 2 LLM pair review, and Layer 3 quality scoring.
6. IF a cached temp file is deleted or becomes inaccessible mid-run, THEN THE Temp_Path_Cache SHALL re-download the file and update the cache entry.
