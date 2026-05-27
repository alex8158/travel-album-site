# Requirements Document

## Introduction

Smart Curation replaces the existing `aiScreening` pipeline stage with an intelligent photo selection engine. Rather than simply detecting duplicates, the system groups similar photos using embedding-based similarity and then uses a Vision Language Model (VLM) to select the best photo(s) from each group — optimized for travel slideshow video output. The system targets underwater/diving photography where blue-tinted, low-contrast images are common.

## Glossary

- **Smart_Curation_Engine**: The server-side service that orchestrates similarity grouping and VLM-based photo selection within the trip processing pipeline
- **Similarity_Grouper**: The component that computes DINOv2/CLIP embeddings and groups photos by cosine similarity using tiered thresholds
- **VLM_Selector**: The component that calls the Vision Language Model (DashScope qwen-vl-max) to evaluate grouped candidates and select the best photo(s) to keep
- **Curation_Group**: A set of photos determined to be visually similar, classified as either `exact_duplicate` (similarity >= 0.94) or `near_duplicate_candidate` (0.86 <= similarity < 0.94)
- **Curation_Decision**: The keep/trash verdict for each photo in a group, including the specific trash reason
- **Trash_Reason**: A machine-readable enum value explaining why a photo was trashed (e.g., `exact_duplicate`, `near_duplicate_worse`, `scene_redundant`, `blurry`, `low_subject_quality`, `low_aesthetic_quality`, `low_video_value`)
- **Debug_Report**: A JSON file containing per-photo curation metadata for inspection and debugging
- **Pipeline**: The `runTripProcessingPipeline` orchestrator that executes all processing stages in sequence
- **Soft_Delete**: Setting `media_items.status = 'trashed'` without physically removing the file from storage

## Requirements

### Requirement 1: Tiered Similarity Grouping

**User Story:** As a system operator, I want photos grouped by visual similarity using tiered thresholds, so that exact duplicates and near-duplicates are handled with appropriate strategies.

#### Acceptance Criteria

1. WHEN processing a trip's active images, THE Similarity_Grouper SHALL compute DINOv2 embeddings for all eligible photos and group them using Union-Find with cosine similarity
2. WHEN two photos have cosine similarity >= 0.94, THE Similarity_Grouper SHALL assign them to the same Curation_Group with type `exact_duplicate`
3. WHEN two photos have cosine similarity >= 0.86 and < 0.94, THE Similarity_Grouper SHALL assign them to the same Curation_Group with type `near_duplicate_candidate`
4. WHEN two photos have cosine similarity < 0.86, THE Similarity_Grouper SHALL treat them as unrelated and not group them together
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

1. WHEN a photo is trashed due to being in an exact duplicate group (similarity >= 0.94) and not selected as best, THE Smart_Curation_Engine SHALL set the trash reason to `exact_duplicate`
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
3. WHEN a Curation_Group is classified as `exact_duplicate` (similarity >= 0.94), THE Smart_Curation_Engine SHALL select the best photo using technical quality scoring without invoking the VLM_Selector
4. THE Smart_Curation_Engine SHALL process VLM calls with a concurrency limit of 3 parallel requests
5. WHEN all photos in a trip are ungrouped (no similar pairs found), THE Smart_Curation_Engine SHALL complete without making any VLM calls

### Requirement 9: Underwater Photo Handling

**User Story:** As a diving photographer, I want the curation system to handle underwater photos correctly, so that blue-tinted and low-contrast images are evaluated fairly.

#### Acceptance Criteria

1. THE VLM_Selector prompt SHALL explicitly mention that photos may be underwater/diving images with blue tint and low contrast, and that these characteristics are normal and not defects
2. THE VLM_Selector SHALL evaluate underwater photos based on subject visibility and composition rather than penalizing color cast or reduced contrast
3. WHEN comparing burst shots of the same marine subject from different angles, THE VLM_Selector SHALL select the photo where the subject is most complete and clearly visible
