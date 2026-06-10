# Requirements Document

## Introduction

Global Survivor Dedup adds a post-VLM deduplication stage to the highlight evaluation flow (`runHighlightEvaluation`). After VLM-based similar-group trashing removes duplicates within similarity groups, near-duplicate photos that ended up in *different* similarity groups may still survive. This stage performs a pure embedding-based (DINOv2) sweep across all remaining active photos to catch those cross-group near-duplicates before overexposure trashing runs.

The stage reuses existing DINOv2 embeddings (already stored in the database), existing threshold constants, and existing utility functions from `globalSimilarity.ts`. It makes zero VLM calls — resolution is purely quality-score-based with temporal proximity as gray-zone evidence.

## Glossary

- **Global_Survivor_Dedup_Stage**: The new processing step in `runHighlightEvaluation` that runs after similar-group trashing (step 10) and before overexposure trashing (step 11), performing cross-group near-duplicate detection on surviving active photos
- **Highlight_Evaluation_Flow**: The `runHighlightEvaluation` function in `highlightService.ts` that orchestrates highlight detection, similar-group trashing, and overexposure trashing for a trip
- **Survivor**: A photo with `status = 'active'` that remains after VLM similar-group trashing has completed
- **DINOv2_Embedding**: A 384-dimensional vector representation of a photo computed by the DINOv2-small model, already stored in the database
- **Gray_Zone**: The similarity range between `dinov2DedupThreshold` (0.82) and `dinov2ConfirmedThreshold` (0.88) where temporal proximity evidence is required to confirm a near-duplicate relationship
- **Confirmed_Pair**: Two photos with DINOv2 cosine similarity >= `dinov2ConfirmedThreshold` (0.88), considered near-duplicates without additional evidence
- **Temporal_Proximity_Window**: A 30-second window applied to `created_at` timestamps; photos within this window that also fall in the Gray_Zone are eligible for elimination
- **Composite_Quality_Score**: The existing formula `sharpness * 0.4 + aesthetic * 0.3 + exposure * 0.3 + overexposurePenalty` used to rank photos for keeper selection
- **Top_K_Neighbors**: The K nearest neighbors computed per photo using cosine similarity on DINOv2 embeddings, controlled by `PROCESS_THRESHOLDS.globalSimilarityTopK` (default 10)

## Requirements

### Requirement 1: Stage Insertion Point

**User Story:** As a system operator, I want the global survivor dedup to run at the correct point in the highlight evaluation flow, so that it catches cross-group duplicates before overexposure trashing further reduces the photo set.

#### Acceptance Criteria

1. THE Highlight_Evaluation_Flow SHALL execute the Global_Survivor_Dedup_Stage after similar-group trashing (step 10) completes and before overexposure trashing (step 11) begins.
2. THE Global_Survivor_Dedup_Stage SHALL operate exclusively on photos with `status = 'active'` for the given trip at the time the stage executes.
3. WHEN similar-group trashing produces zero survivors (all photos trashed), THE Global_Survivor_Dedup_Stage SHALL complete immediately without performing any computation.

### Requirement 2: Embedding-Based Neighbor Discovery

**User Story:** As a system operator, I want the stage to find near-duplicate candidates using stored DINOv2 embeddings, so that cross-group duplicates are detected without recomputing embeddings or calling VLM.

#### Acceptance Criteria

1. THE Global_Survivor_Dedup_Stage SHALL load pre-computed DINOv2 embeddings from the database for all Survivors.
2. THE Global_Survivor_Dedup_Stage SHALL compute pairwise cosine similarity using the existing `computeTopKNeighbors` function with `PROCESS_THRESHOLDS.globalSimilarityTopK` (default 10) as the K parameter.
3. THE Global_Survivor_Dedup_Stage SHALL use the existing `cosineSimilarity` function for all similarity computations.
4. THE Global_Survivor_Dedup_Stage SHALL NOT invoke any VLM or external AI service.
5. THE Global_Survivor_Dedup_Stage SHALL NOT recompute DINOv2 embeddings for any photo.

### Requirement 3: Confirmed Near-Duplicate Detection

**User Story:** As a system operator, I want photo pairs with very high embedding similarity to be treated as confirmed near-duplicates, so that obvious cross-group duplicates are resolved without additional evidence.

#### Acceptance Criteria

1. WHEN two Survivors have DINOv2 cosine similarity >= `dinov2ConfirmedThreshold` (0.88), THE Global_Survivor_Dedup_Stage SHALL classify the pair as a Confirmed_Pair eligible for elimination.
2. WHEN a Confirmed_Pair is identified, THE Global_Survivor_Dedup_Stage SHALL select the photo with the higher Composite_Quality_Score as the keeper using the existing `selectBestByQuality` function.
3. WHEN a Confirmed_Pair is identified, THE Global_Survivor_Dedup_Stage SHALL trash the photo with the lower Composite_Quality_Score.

### Requirement 4: Gray-Zone Detection with Temporal Evidence

**User Story:** As a system operator, I want photos in the gray zone of similarity to require temporal proximity evidence before elimination, so that genuinely different photos with moderately similar embeddings are not accidentally removed.

#### Acceptance Criteria

1. WHEN two Survivors have DINOv2 cosine similarity >= `dinov2DedupThreshold` (0.82) and < `dinov2ConfirmedThreshold` (0.88), THE Global_Survivor_Dedup_Stage SHALL classify the pair as a Gray_Zone pair.
2. WHEN a Gray_Zone pair's `created_at` timestamps differ by 30 seconds or less, THE Global_Survivor_Dedup_Stage SHALL treat the pair as eligible for elimination.
3. WHEN a Gray_Zone pair's `created_at` timestamps differ by more than 30 seconds, THE Global_Survivor_Dedup_Stage SHALL keep both photos and not treat them as duplicates.
4. WHEN a Gray_Zone pair is eligible for elimination, THE Global_Survivor_Dedup_Stage SHALL select the photo with the higher Composite_Quality_Score as the keeper using the existing `selectBestByQuality` function.

### Requirement 5: Quality-Based Keeper Selection

**User Story:** As a content creator, I want the best photo from each duplicate pair to be kept based on objective quality metrics, so that the highest quality version survives.

#### Acceptance Criteria

1. THE Global_Survivor_Dedup_Stage SHALL compute the Composite_Quality_Score using the existing formula: `sharpness * 0.4 + aesthetic * 0.3 + exposure * 0.3 + overexposurePenalty`.
2. THE Global_Survivor_Dedup_Stage SHALL use the existing `computeCompositeScore` function for all quality score computations.
3. WHEN two photos in an eligible pair have identical Composite_Quality_Scores, THE Global_Survivor_Dedup_Stage SHALL keep the photo with the earlier `created_at` timestamp.

### Requirement 6: Trash Reason and Soft Delete

**User Story:** As a system operator, I want trashed photos to carry a specific reason and remain recoverable, so that I can audit global dedup decisions and restore photos if needed.

#### Acceptance Criteria

1. WHEN the Global_Survivor_Dedup_Stage trashes a photo, THE Global_Survivor_Dedup_Stage SHALL set the `trashed_reason` column to `'global_similarity_after_vlm'`.
2. THE Global_Survivor_Dedup_Stage SHALL trash photos by setting `media_items.status = 'trashed'` only; the `file_path` value SHALL remain unchanged.
3. WHEN a photo already has a `trashed_reason` value, THE Global_Survivor_Dedup_Stage SHALL append `',global_similarity_after_vlm'` to the existing value.

### Requirement 7: Statistics Reporting

**User Story:** As a system operator, I want the stage to report how many photos it removed, so that I can monitor the effectiveness of global survivor dedup.

#### Acceptance Criteria

1. WHEN the Global_Survivor_Dedup_Stage completes, THE Highlight_Evaluation_Flow SHALL include a `globalSimilarityAfterVlmDeletedCount` field in the evaluation result containing the number of photos trashed by this stage.
2. THE Global_Survivor_Dedup_Stage SHALL log the count of trashed photos to the console using the existing logging pattern (e.g., `[highlightService] Auto-trashed N global-survivor-dedup photos for trip {tripId}`).

### Requirement 8: Cluster Resolution for Multi-Way Duplicates

**User Story:** As a system operator, I want the stage to handle cases where more than two photos form a duplicate cluster, so that only the single best photo survives from each cluster.

#### Acceptance Criteria

1. WHEN multiple Survivors form a connected set of eligible pairs (transitive closure), THE Global_Survivor_Dedup_Stage SHALL treat the entire connected set as a single cluster.
2. WHEN resolving a cluster, THE Global_Survivor_Dedup_Stage SHALL select the single photo with the highest Composite_Quality_Score as the keeper.
3. WHEN resolving a cluster, THE Global_Survivor_Dedup_Stage SHALL trash all other photos in the cluster with reason `'global_similarity_after_vlm'`.

### Requirement 9: Edge Cases and Safety

**User Story:** As a system operator, I want the stage to handle edge cases gracefully, so that it never crashes the highlight evaluation flow or produces incorrect results.

#### Acceptance Criteria

1. IF a Survivor has no stored DINOv2 embedding (null embedding), THEN THE Global_Survivor_Dedup_Stage SHALL skip that photo and not consider it for dedup.
2. WHEN only one Survivor remains after similar-group trashing, THE Global_Survivor_Dedup_Stage SHALL complete immediately without trashing any photos.
3. WHEN the Global_Survivor_Dedup_Stage encounters an unexpected error, THE Global_Survivor_Dedup_Stage SHALL log the error and allow the Highlight_Evaluation_Flow to continue to overexposure trashing with zero photos trashed by this stage.
4. THE Global_Survivor_Dedup_Stage SHALL NOT trash a photo that has already been trashed (status != 'active') by a prior step in the same evaluation run.
