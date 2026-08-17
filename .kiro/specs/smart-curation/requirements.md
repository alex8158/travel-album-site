# Requirements Document

## Introduction

Smart Curation replaces the existing `aiScreening` pipeline stage with an intelligent photo selection engine. It runs in **three phases**:

- **Phase 1 — Similarity-grouped curation** (`smartCuration` stage): groups visually similar photos with embedding/hash signals, then keeps the best representative(s) per group using technical quality scoring (exact duplicates) or VLM evaluation (near-duplicates).
- **Phase 2 — AI per-photo review** (`aiReview` stage): asks the VLM to make an independent keep/trash judgement on **every still-active photo** after Phase 1, catching blurry / cut-off / low-value shots that survived because they were ungrouped or won their group on technical scoring alone.
- **Phase 3 — AI cross-photo dedup** (`aiFinalDedup` stage): asks the VLM to compare batches of N already-good photos and remove redundant ones (same subject, same framing) that DINOv2 missed because their cosine similarity fell below the grouping threshold.

The system targets underwater/diving photography where blue-tinted, low-contrast images are common.

## Glossary

- **Smart_Curation_Engine**: The Phase 1 service (`runSmartCuration`) that orchestrates similarity grouping and VLM-based selection within similarity groups.
- **AI_Review_Engine**: The Phase 2 service (`runAIReview`) that runs a per-photo VLM judgement over every still-active photo after Phase 1.
- **Similarity_Grouper**: The component that computes DINOv2/CLIP embeddings and groups photos by cosine similarity using tiered thresholds
- **VLM_Selector**: The Phase 1 component that calls the Vision Language Model (DashScope qwen-vl-max) to evaluate grouped candidates and select the best photo(s) to keep
- **AI_Reviewer**: The Phase 2 component that calls the same VLM to evaluate individual photos in fixed-size batches and make per-photo keep/trash decisions
- **Curation_Group**: A set of photos determined to be visually similar, classified as either `exact_duplicate` (similarity >= EXACT threshold) or `near_duplicate_candidate` (NEAR threshold ≤ similarity < EXACT threshold)
- **Curation_Decision**: The keep/trash verdict for each photo, including the specific trash reason
- **Trash_Reason**: A machine-readable enum value explaining why a photo was trashed (e.g., `exact_duplicate`, `near_duplicate_worse`, `scene_redundant`, `blurry`, `low_subject_quality`, `low_aesthetic_quality`, `low_video_value`)
- **Debug_Report**: A JSON file containing per-photo curation metadata for inspection and debugging
- **Pipeline**: The `runTripProcessingPipeline` orchestrator that executes all processing stages in sequence
- **Soft_Delete**: Setting `media_items.status = 'trashed'` without physically removing the file from storage

## Requirements

### Requirement 1: Tiered Similarity Grouping

**User Story:** As a system operator, I want photos grouped by visual similarity using tiered thresholds, so that exact duplicates and near-duplicates are handled with appropriate strategies.

#### Acceptance Criteria

1. WHEN processing a trip's active images, THE Similarity_Grouper SHALL compute DINOv2 embeddings for all eligible photos and group them using Union-Find with cosine similarity
2. WHEN two photos have cosine similarity >= `EXACT_DUPLICATE_THRESHOLD` (default 0.98), THE Similarity_Grouper SHALL assign them to the same Curation_Group with type `exact_duplicate`
3. WHEN two photos have cosine similarity >= `NEAR_DUPLICATE_THRESHOLD` (default 0.80) and < `EXACT_DUPLICATE_THRESHOLD` (default 0.98), THE Similarity_Grouper SHALL assign them to the same Curation_Group with type `near_duplicate_candidate`
4. WHEN two photos have cosine similarity < `NEAR_DUPLICATE_THRESHOLD` (default 0.80), THE Similarity_Grouper SHALL treat them as unrelated and not group them together
5. IF the DINOv2 ML service is unavailable, THEN THE Similarity_Grouper SHALL fall back to pHash/dHash hamming distance for grouping and log a warning
6. THE Similarity_Grouper SHALL also use pHash and dHash as supplementary signals to confirm exact duplicates detected by embedding similarity

### Requirement 2: Group-Size-Based Keep Quota

**User Story:** As a system operator, I want the number of photos kept from each group to scale with group size, so that larger groups retain more variety while small groups are aggressively curated.

#### Acceptance Criteria

1. WHEN a Curation_Group contains 2 to 3 photos, THE VLM_Selector SHALL keep exactly 1 photo from the group
2. WHEN a Curation_Group contains 4 to 8 photos, THE VLM_Selector SHALL keep 1 to 2 photos from the group
3. WHEN a Curation_Group contains 9 or more photos, THE VLM_Selector SHALL keep 2 to 3 photos from the group
4. WHEN a Curation_Group contains exactly 1 photo, THE Smart_Curation_Engine SHALL keep that photo without invoking the VLM_Selector

### Requirement 3: VLM-Based Best Photo Selection

**User Story:** As a content creator, I want the system to select the best photos for a travel slideshow video using visual quality criteria, so that the final output contains only the most compelling images.

#### Acceptance Criteria

1. WHEN evaluating candidates within a Curation_Group, THE VLM_Selector SHALL rank photos based on: subject size and completeness, subject sharpness and clarity, pose and gesture quality, composition suitability for video slideshow, color naturalness, occlusion level, background cleanliness, and information content
2. THE VLM_Selector SHALL use a prompt that explicitly instructs the model to select photos "best for travel slideshow video" rather than generic duplicate detection
3. WHEN a Curation_Group has more than 5 candidates, THE Smart_Curation_Engine SHALL pre-select the top 3 to 5 candidates by technical quality score before sending them to the VLM_Selector
4. THE VLM_Selector SHALL return a structured response containing the indices of photos to keep and a specific reason for each photo trashed
5. IF the VLM_Selector returns an unparseable response, THEN THE Smart_Curation_Engine SHALL fall back to technical quality scoring (sharpness, resolution, file size) to select the best photo

### Requirement 4: Specific Trash Reasons

**User Story:** As a system operator, I want each trashed photo to have a specific machine-readable reason, so that I can audit curation decisions and understand why photos were removed.

#### Acceptance Criteria

1. WHEN a photo is trashed due to being in an exact duplicate group (similarity >= `EXACT_DUPLICATE_THRESHOLD`) and not selected as best, THE Smart_Curation_Engine SHALL set the trash reason to `exact_duplicate`
2. WHEN a photo is trashed due to being in a near-duplicate group and the VLM determines it is worse, THE Smart_Curation_Engine SHALL set the trash reason to `near_duplicate_worse`
3. WHEN a photo is trashed because the VLM determines the scene is redundant with other kept photos, THE Smart_Curation_Engine SHALL set the trash reason to `scene_redundant`
4. WHEN a photo is trashed because the VLM determines it is blurry or out of focus, THE Smart_Curation_Engine SHALL set the trash reason to `blurry`
5. WHEN a photo is trashed because the VLM determines the subject quality is poor, THE Smart_Curation_Engine SHALL set the trash reason to `low_subject_quality`
6. WHEN a photo is trashed because the VLM determines the aesthetic quality is poor, THE Smart_Curation_Engine SHALL set the trash reason to `low_aesthetic_quality`
7. WHEN a photo is trashed because the VLM determines the photo has low value for video slideshow, THE Smart_Curation_Engine SHALL set the trash reason to `low_video_value`
8. THE Smart_Curation_Engine SHALL store the trash reason in the `trashed_reason` column of the `media_items` table

### Requirement 5: Soft Delete Only

**User Story:** As a user, I want trashed photos to remain recoverable, so that I can restore them if the curation decision was wrong.

#### Acceptance Criteria

1. THE Smart_Curation_Engine SHALL mark trashed photos by setting `media_items.status = 'trashed'` and SHALL NOT physically delete any files from storage
2. WHEN a photo is trashed by the Smart_Curation_Engine, THE Smart_Curation_Engine SHALL preserve the original `file_path` value unchanged in the database

### Requirement 6: Debug Report Generation

**User Story:** As a developer, I want a detailed debug JSON report of all curation decisions, so that I can inspect grouping quality and VLM reasoning.

#### Acceptance Criteria

1. WHEN the Smart_Curation_Engine completes processing a trip, THE Smart_Curation_Engine SHALL generate a debug JSON report
2. THE Debug_Report SHALL contain an entry for each processed photo with the following fields: `mediaId`, `filename`, `groupId`, `groupType`, `similaritySource`, `similarityScore`, `decision` (keep or trash), and `reason`
3. THE Debug_Report SHALL include the `groupType` as either `exact_duplicate`, `near_duplicate_candidate`, or `ungrouped`
4. THE Debug_Report SHALL include the `similaritySource` as one of `dinov2`, `phash`, `dhash`, or `clip`
5. THE Smart_Curation_Engine SHALL write the Debug_Report to a predictable file path associated with the trip

### Requirement 7: Pipeline Integration

**User Story:** As a system operator, I want Smart Curation to replace the existing aiScreening stage seamlessly, so that the pipeline runs in a single pass without additional user interaction.

#### Acceptance Criteria

1. THE Pipeline SHALL execute the Smart_Curation_Engine in place of the existing `runAiScreening` stage after the dedup and write stages have completed
2. THE Smart_Curation_Engine SHALL operate on all photos with `status = 'active'` for the given trip at the time of execution
3. WHEN the Smart_Curation_Engine completes, THE Pipeline SHALL continue to subsequent stages (analyze, optimize, thumbnail) without requiring user interaction
4. IF the `DASHSCOPE_API_KEY` environment variable is not configured, THEN THE Smart_Curation_Engine SHALL skip VLM selection and fall back to technical quality scoring only
5. THE Smart_Curation_Engine SHALL report progress via the pipeline's `onProgress` callback with stage name `smartCuration`

### Requirement 8: VLM Call Efficiency

**User Story:** As a system operator, I want VLM API calls minimized, so that processing cost and latency remain acceptable for large photo sets.

#### Acceptance Criteria

1. THE Smart_Curation_Engine SHALL invoke the VLM_Selector only for Curation_Groups containing 2 or more photos
2. THE Smart_Curation_Engine SHALL send at most 5 candidate images per VLM call
3. WHEN a Curation_Group is classified as `exact_duplicate` (similarity >= `EXACT_DUPLICATE_THRESHOLD`), THE Smart_Curation_Engine SHALL select the best photo using technical quality scoring without invoking the VLM_Selector
4. THE Smart_Curation_Engine SHALL process VLM calls with a concurrency limit of 3 parallel requests
5. WHEN all photos in a trip are ungrouped (no similar pairs found), THE Smart_Curation_Engine SHALL complete without making any VLM calls

### Requirement 9: Underwater Photo Handling

**User Story:** As a diving photographer, I want the curation system to handle underwater photos correctly, so that blue-tinted and low-contrast images are evaluated fairly.

#### Acceptance Criteria

1. THE VLM_Selector prompt SHALL explicitly mention that photos may be underwater/diving images with blue tint and low contrast, and that these characteristics are normal and not defects
2. THE VLM_Selector SHALL evaluate underwater photos based on subject visibility and composition rather than penalizing color cast or reduced contrast
3. WHEN comparing burst shots of the same marine subject from different angles, THE VLM_Selector SHALL select the photo where the subject is most complete and clearly visible


### Requirement 10: AI Final Review (Phase 2)

**User Story:** As a content creator, I want the VLM to look at every photo that survives Phase 1 and remove the ones that are obviously bad (blurry, cut-off, boring), so that the final album never contains a defective photo just because it had no similar peer to compete with.

#### Acceptance Criteria

1. WHEN the AI_Review_Engine runs after Phase 1 completes, THE AI_Review_Engine SHALL load every photo with `status = 'active'` for the trip and split them into fixed-size batches.
2. THE AI_Review_Engine SHALL evaluate each batch independently with a single VLM call that judges each photo on its own merits (no group context, no cross-photo "best of" ranking).
3. WHEN the AI_Reviewer determines a photo is severely blurry or out of focus, THE AI_Review_Engine SHALL trash it with reason `blurry`.
4. WHEN the AI_Reviewer determines a photo's main subject is severely cut off, occluded, or has unrecoverable exposure, THE AI_Review_Engine SHALL trash it with reason `low_subject_quality`.
5. WHEN the AI_Reviewer determines a photo's composition is broken or has no discernible subject, THE AI_Review_Engine SHALL trash it with reason `low_aesthetic_quality`.
6. WHEN the AI_Reviewer determines a photo is technically acceptable but unsuitable filler for a slideshow, THE AI_Review_Engine SHALL trash it with reason `low_video_value`.
7. WHEN none of the trash conditions apply, THE AI_Review_Engine SHALL keep the photo.
8. THE AI_Review_Engine SHALL preserve the underwater-photo handling instruction in its prompt so blue-tinted dive shots are not penalized for color cast.
9. IF a single batch's VLM call fails, throws, or returns an unparseable response, THEN THE AI_Review_Engine SHALL keep every photo in that failed batch (conservative fallback) and increment a `vlmCallsFailed` counter.
10. IF `DASHSCOPE_API_KEY` is not configured, THEN THE AI_Review_Engine SHALL skip the entire Phase 2 stage without trashing any photos.
11. THE AI_Review_Engine SHALL persist trash decisions by setting `media_items.status = 'trashed'` and `trashed_reason` only; the `file_path` value SHALL remain unchanged (Soft_Delete invariant).
12. THE AI_Review_Engine SHALL write its own debug JSON report to `data/debug/ai-review-{tripId}-{timestamp}.json` with one entry per processed photo.
13. THE AI_Review_Engine SHALL run VLM batches with a bounded concurrency limit (default 3) so processing remains parallel without exhausting the DashScope rate limit.
14. THE Pipeline SHALL execute the AI_Review_Engine as a separate `aiReview` stage immediately after `smartCuration` and before `analyze`, with its own progress callbacks and stage-level error isolation.

### Requirement 11: Similarity Threshold Calibration for Burst Shots

**User Story:** As a system operator processing photos that include human subjects, I want burst shots of people (same scene, different pose / expression / closed eyes) to be evaluated by the VLM rather than collapsed by sharpness scoring, so that the kept photos reflect actual content quality and not just lens-resolved detail.

#### Acceptance Criteria

1. THE Similarity_Grouper SHALL use an `EXACT_DUPLICATE_THRESHOLD` default of 0.98 (raised from the original 0.94) so that DINOv2-similar burst shots in the 0.94–0.98 range are routed to the near-duplicate tier and evaluated by the VLM.
2. THE Similarity_Grouper SHALL allow operators to override the threshold via the `SMART_CURATION_EXACT_THRESHOLD` environment variable for trips where a stricter or looser policy is desired.
3. THE Similarity_Grouper SHALL use a `NEAR_DUPLICATE_THRESHOLD` default of 0.80 (lowered from the original 0.86) because DINOv2-small underrates near-duplicates in low-contrast underwater / diving photos.
4. THE Similarity_Grouper SHALL allow operators to override the near-duplicate threshold via the `SMART_CURATION_NEAR_THRESHOLD` environment variable.
5. WHEN `NEAR_DUPLICATE_THRESHOLD` is configured greater than `EXACT_DUPLICATE_THRESHOLD`, THE Similarity_Grouper SHALL log a warning stating that the near-duplicate tier will be empty, and SHALL NOT abort startup.
6. THE thresholds in this requirement are the authoritative values; the tier boundaries referenced in Requirement 1, Requirement 4 and Requirement 8 SHALL be read as `EXACT_DUPLICATE_THRESHOLD` and `NEAR_DUPLICATE_THRESHOLD` rather than as literal numbers.

#### Implementation Note

These two thresholds are defined in `server/src/services/smartCuration/similarityGrouper.ts` via its own `readThresholdEnv()` helper, **not** in `PROCESS_THRESHOLDS` (`dedupThresholds.ts`). This placement is explicitly permitted — see the Permitted Secondary Locations table in `photo-curation-fix` Requirement 5, which records this requirement as the authoritative owner of both values.


### Requirement 12: AI Cross-Photo Dedup (Phase 3)

**User Story:** As a content creator, I want the VLM to spot near-duplicate photos that the cosine-similarity grouper missed (subject and framing nearly identical but DINOv2 rated them just below the grouping threshold), so that the final album does not contain two photos of the same shot.

#### Acceptance Criteria

1. WHEN the AI Cross-Photo Dedup stage runs after Phase 2, THE stage SHALL load every photo with `status = 'active'` for the trip and split them into fixed-size batches ordered by `created_at` ascending so temporally adjacent photos are evaluated together.
2. THE stage SHALL evaluate each batch with one VLM call that decides, for every photo in that batch, whether it is redundant with another photo in the same batch.
3. THE stage SHALL emit `scene_redundant` (or `near_duplicate_worse` if the VLM uses that synonym) as the only acceptable trash reason; any other reason value SHALL cause the batch's response to be treated as unparseable.
4. WHEN the VLM determines two or more photos in a batch are redundant, THE stage SHALL keep one (the model's pick) and trash the rest with reason `scene_redundant`.
5. WHEN the VLM determines no photos in a batch are redundant, THE stage SHALL keep all photos in the batch.
6. THE stage prompt SHALL explicitly instruct the model to be conservative ("when in doubt, keep") because Phase 1 and Phase 2 already filtered aggressively.
7. THE stage prompt SHALL preserve the underwater-photo handling instruction so blue-tinted dive shots are not penalized for color cast.
8. IF a batch contains fewer than 2 photos, THE stage SHALL skip the VLM call and keep that single photo without consuming a VLM quota slot.
9. IF a batch's VLM call fails, throws, or returns an unparseable response, THEN THE stage SHALL keep every photo in that batch (conservative fallback) and increment a `vlmCallsFailed` counter.
10. IF `DASHSCOPE_API_KEY` is not configured, THEN THE stage SHALL skip Phase 3 entirely without trashing any photos.
11. THE stage SHALL persist trash decisions by setting `media_items.status = 'trashed'` and `trashed_reason` only; the `file_path` value SHALL remain unchanged (Soft_Delete invariant).
12. THE stage SHALL write its own debug JSON report to `data/debug/ai-final-dedup-{tripId}-{timestamp}.json`.
13. THE stage SHALL run VLM batches with a bounded concurrency limit (default 3).
14. THE Pipeline SHALL execute Phase 3 as a separate `aiFinalDedup` stage immediately after `aiReview` and before `analyze`, with its own progress callbacks and stage-level error isolation.
15. THE batch size SHALL default to 12 photos per VLM call and be configurable via the `SMART_CURATION_DEDUP_BATCH_SIZE` environment variable, accepting integers in the range [2, 12].

#### Acknowledged Limitation

Photos in different batches are never compared against each other in Phase 3. Two near-duplicates that happen to fall on either side of a batch boundary will both survive. This is an explicit cost-vs-coverage trade-off: full pairwise comparison would scale O(N²) in VLM calls. Batching by `created_at` order captures the dominant case (temporally adjacent burst shots).
