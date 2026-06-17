# Requirements Document

## Introduction

Highlight Tier (精华) adds a second curation layer on top of the existing highlight evaluation (精选). After the highlight evaluation pipeline completes, the system automatically runs a category-aware VLM pass that selects the absolute best photos per category into a "highlight tier" subset. This tier drives a dedicated slideshow video and surfaces in both My Gallery and the public gallery as a premium view.

精华 is always a strict subset of 精选 — it never includes trashed photos or photos that were not already marked as highlights.

## Glossary

- **Highlight_Tier_Selector**: The service that runs after highlight evaluation and selects the top-tier photos from each category using VLM calls
- **Highlight_Result**: A row in the `highlight_results` table representing a photo's evaluation outcome, extended with an `is_highlight_tier` flag
- **Category**: A classification assigned to each media item (`people`, `animal`, `landscape`, `other`) stored in `media_items.category`
- **VLM**: Vision Language Model (DashScope qwen-vl-max or Anthropic Claude) used for photo evaluation
- **Slideshow_Generator**: The existing service that produces a slideshow video from a set of photos
- **My_Gallery**: The authenticated user's gallery page for managing their trip photos
- **Public_Gallery**: The publicly accessible gallery page showing a trip's curated photos
- **Highlight_Evaluation**: The existing Phase 1–3 pipeline that selects 精选 photos (is_highlight = 1)
- **Batch**: A group of photos sent in a single VLM call for evaluation
- **Category_Quota**: The minimum and maximum number of photos to select per category

## Requirements

### Requirement 1: Automatic Trigger After Highlight Evaluation

**User Story:** As a user, I want highlight tier selection to run automatically after my photos are evaluated, so that I get the premium tier without additional manual steps.

#### Acceptance Criteria

1. WHEN the existing highlight evaluation pipeline completes successfully for a trip, THE Highlight_Tier_Selector SHALL execute automatically as the final stage of that pipeline run.
2. THE Highlight_Tier_Selector SHALL operate only on photos where `highlight_results.is_highlight = 1` and `media_items.status = 'active'` for the given trip.
3. IF the highlight evaluation completes with zero highlight photos for the trip, THEN THE Highlight_Tier_Selector SHALL skip execution and log a message indicating no candidates are available.

### Requirement 2: Database Schema Extension

**User Story:** As a developer, I want the highlight tier flag stored in the existing results table, so that queries remain simple and consistent with the current data model.

#### Acceptance Criteria

1. THE system SHALL add an `is_highlight_tier INTEGER DEFAULT 0` column to the `highlight_results` table.
2. THE system SHALL add a `category TEXT` column to the `media_items` table to store the photo classification (`people`, `animal`, `landscape`, `other`).
3. WHEN the Highlight_Tier_Selector marks a photo as highlight tier, THE system SHALL set `highlight_results.is_highlight_tier = 1` for that photo's row.
4. THE system SHALL enforce that `is_highlight_tier = 1` can only exist on rows where `is_highlight = 1` (highlight tier is a subset of highlights).

### Requirement 3: Category-Based Quota Selection

**User Story:** As a content creator, I want the system to pick the best photos from each category with appropriate quotas, so that the highlight tier represents a balanced and diverse collection.

#### Acceptance Criteria

1. WHEN processing the `animal` category, THE Highlight_Tier_Selector SHALL select 6 to 9 photos where each shows a completely different animal subject, each photo is sharp, and none are overexposed.
2. WHEN processing the `landscape` category, THE Highlight_Tier_Selector SHALL select 3 to 9 of the most visually distinct and compelling landscape photos.
3. WHEN processing the `people` category, THE Highlight_Tier_Selector SHALL select 3 to 9 photos where each shows a completely different scene or setting.
4. IF a category contains fewer candidates than the minimum quota, THEN THE Highlight_Tier_Selector SHALL select all available candidates from that category.
5. THE Highlight_Tier_Selector SHALL skip any category that has zero highlight-eligible candidates.

### Requirement 4: VLM Batch Handling

**User Story:** As a system operator, I want VLM calls to stay within manageable batch sizes, so that the model produces reliable results and API costs remain controlled.

#### Acceptance Criteria

1. THE Highlight_Tier_Selector SHALL send 10 to 15 photos per VLM batch call.
2. WHEN a category contains more than 15 highlight-eligible candidates, THE Highlight_Tier_Selector SHALL split them into sub-batches of 10 to 15 photos each.
3. WHEN a category is split into sub-batches, THE Highlight_Tier_Selector SHALL pick the top N candidates from each sub-batch, then run a final VLM round on the combined sub-batch winners to select the category quota.
4. IF a VLM batch call fails or returns an unparseable response, THEN THE Highlight_Tier_Selector SHALL skip that batch and log the failure without crashing the overall tier selection.

### Requirement 5: VLM Prompt Requirements

**User Story:** As a content curator, I want the VLM to receive category-specific instructions, so that the selection criteria match what makes each category compelling.

#### Acceptance Criteria

1. WHEN evaluating `animal` category photos, THE Highlight_Tier_Selector SHALL use a prompt instructing the model to pick 6 to 9 photos where each shows a completely different animal subject, each photo is sharp, and well-exposed.
2. WHEN evaluating `people` category photos, THE Highlight_Tier_Selector SHALL use a prompt instructing the model to pick 3 to 9 photos where each shows a completely different scene or setting.
3. WHEN evaluating `landscape` category photos, THE Highlight_Tier_Selector SHALL use a prompt instructing the model to pick 3 to 9 of the most visually distinct and compelling landscapes.
4. THE Highlight_Tier_Selector SHALL include the underwater-photo handling instruction in all prompts so blue-tinted dive shots are evaluated fairly.

### Requirement 6: Slideshow Auto-Generation

**User Story:** As a user, I want a slideshow video created automatically from my highlight tier photos, so that I have a ready-to-share premium video without additional steps.

#### Acceptance Criteria

1. WHEN the Highlight_Tier_Selector completes and at least one photo is marked as highlight tier, THE system SHALL automatically trigger the Slideshow_Generator using all highlight tier photos for the trip.
2. THE system SHALL store the resulting slideshow video as the highlight tier video associated with the trip.
3. IF the Highlight_Tier_Selector completes with zero photos selected, THEN THE system SHALL skip slideshow generation.

### Requirement 7: My Gallery — Highlight Tier Tab

**User Story:** As a user, I want a dedicated "精华" tab in My Gallery, so that I can quickly view only my top-tier curated photos and their slideshow video.

#### Acceptance Criteria

1. THE My_Gallery SHALL display a "精华" tab alongside existing filter modes.
2. WHEN the user selects the "精华" tab, THE My_Gallery SHALL show only photos where `is_highlight_tier = 1` for the current trip.
3. WHEN the user selects the "精华" tab, THE My_Gallery SHALL display the highlight tier slideshow video above or alongside the photos.
4. IF no highlight tier photos exist for the trip, THEN THE My_Gallery SHALL display a message indicating that highlight tier selection has not been performed.

### Requirement 8: Public Gallery — Highlight Tier Display

**User Story:** As a visitor, I want the public gallery to showcase both the curated photos and the premium highlight tier video, so that I see the best content the trip has to offer.

#### Acceptance Criteria

1. THE Public_Gallery SHALL display 精选 photos (all `is_highlight = 1` photos) as the default photo view.
2. THE Public_Gallery SHALL display the highlight tier (精华) slideshow video prominently within the gallery.
3. THE Public_Gallery SHALL only show photos and videos from trips with `visibility = 'public'`.

### Requirement 9: Subset Invariant Enforcement

**User Story:** As a system operator, I want the highlight tier to always be a valid subset of highlights, so that data integrity is maintained and no trashed photo ever appears in the premium tier.

#### Acceptance Criteria

1. THE Highlight_Tier_Selector SHALL verify that every candidate photo has `is_highlight = 1` and `media_items.status = 'active'` before including it in VLM evaluation.
2. WHEN a photo is trashed after being marked as highlight tier, THE system SHALL set `is_highlight_tier = 0` for that photo's highlight result row.
3. THE system SHALL exclude photos with `media_items.status = 'trashed'` from all highlight tier queries and displays.
