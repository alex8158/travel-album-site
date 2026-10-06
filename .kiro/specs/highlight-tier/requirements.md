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

1. WHEN the Highlight_Tier_Selector completes and at least one photo is marked as highlight tier, THE system SHALL automatically trigger the Slideshow_Generator for the trip's highlight tier photos.
2. THE system SHALL group highlight tier photos by `media_items.category` and generate **one slideshow video per category** rather than a single combined video.
3. THE system SHALL skip any category whose highlight tier photo count is below `MIN_PHOTOS_FOR_VIDEO` (6) and SHALL log the skipped category together with its photo count.
4. THE system SHALL write each category's video to `uploads/{tripId}/tier-slideshow/{category}/` and expose it at `/api/trips/{tripId}/tier-slideshow/{category}/{filename}`, subject to the caller-scoped access rule in AC 9.
5. THE Tier_API SHALL return the generated videos as a `slideshowUrls` object keyed by category (for example `{ "animal": "...", "landscape": "..." }`), NOT as a single `slideshowUrl` string. Which entries appear for a given requester is governed by AC 9.
6. WHEN an mp4 file exists directly under `uploads/{tripId}/tier-slideshow/` rather than in a category subdirectory, THE Tier_API SHALL expose it under the reserved key `all` for backward compatibility with trips whose videos were produced before per-category generation existed, subject to AC 9.
7. WHEN a category's video generation fails, THE system SHALL record that category's error, continue generating the remaining categories, and SHALL NOT abort the whole regeneration.
8. IF the Highlight_Tier_Selector completes with zero photos selected, THEN THE system SHALL skip slideshow generation entirely.
9. AC 4–6 define storage location, URL shape and the `slideshowUrls` key scheme only; they do not grant access. Whether a video is enumerated in `slideshowUrls` for a requester, and whether its file is served to that requester, SHALL follow `multi-user-system` 需求 9:
   - The trip owner and admins keep their existing access (需求 9 AC 5).
   - For any other requester (需求 9 AC 4), a video SHALL be enumerated or served only when it passes 需求 9 AC 12–15. A file existing on disk SHALL NOT by itself entitle such a requester to its URL or its bytes.
   - The legacy `all` key (AC 6): no current generation path writes root-level files, and no root-level file carries Artifact_Provenance. Such a file SHALL therefore NOT be enumerated or served to a 需求 9 AC 4 requester; owner and admin continue to see it under `all`.

#### Correction Note

Criteria 1–3 previously described a **single** highlight tier video ("store the resulting slideshow video as the highlight tier video"). The implementation generates one video per category and returns a `slideshowUrls` map — see `getTierSlideshowUrls()` in `server/src/routes/highlights.ts` (L245) and the regeneration path in `server/src/routes/my.ts` (L460 onward).

This divergence went unnoticed because no spec covered per-category slideshows and the only test touching this area (`client/src/pages/GalleryPage.test.tsx`) still mocked the old singular `slideshowUrl` field. The test was corrected on 2026-08-05; this requirement was rewritten at the same time to match the implementation.

#### Correction Note (2026-09-21)

AC 4–6 were worded purely in terms of file existence ("WHEN an mp4 file exists … SHALL expose it"). Read literally, any requester would be entitled to any file on disk. That conflicts with `multi-user-system` 需求 9 AC 12–15, which bound Derived_Artifact exposure for non-owner, non-admin requesters.

Since B-β (2026-09-09) the implementation had already relied on reading AC 4–6 as an addressing contract — an `unlisted` trip returned `slideshowUrls: {}` to non-owners — but no requirement said so. AC 9 now states it. AC 4–6 gain only a pointer to AC 9; their path, URL and key-scheme content is unchanged, and owner/admin access is unchanged. The note above (2026-08-05) is kept as written.

### Requirement 7: My Gallery — Highlight Tier Tab

**User Story:** As a user, I want a dedicated "精华" tab in My Gallery, so that I can quickly view only my top-tier curated photos and their slideshow video.

#### Acceptance Criteria

1. THE My_Gallery SHALL display a "精华" tab alongside existing filter modes.
2. WHEN the user selects the "精华" tab, THE My_Gallery SHALL show only photos where `is_highlight_tier = 1` for the current trip.
3. WHEN the user selects the "精华" tab, THE My_Gallery SHALL display the available per-category highlight tier slideshow videos above or alongside the photos.
4. IF no highlight tier photos exist for the trip, THEN THE My_Gallery SHALL display a message indicating that highlight tier selection has not been performed.

### Requirement 8: Public Gallery — Highlight Tier Display

**User Story:** As a visitor, I want the public gallery to showcase both the curated photos and the premium highlight tier video, so that I see the best content the trip has to offer.

#### Acceptance Criteria

1. THE Public_Gallery SHALL display 精选 photos as the default photo view — every photo that has `is_highlight = 1` and that the media visibility policy exposes to the current requester.
2. THE Public_Gallery SHALL display the highlight tier (精华) slideshow videos prominently within the gallery, one per available category — "available" meaning enumerated to the current requester under Requirement 6 AC 9.
3. THE Public_Gallery SHALL treat `trips.visibility` as a discovery control only: an `unlisted` trip SHALL NOT appear on any public discovery surface, and a requester holding its direct link SHALL NOT be refused solely because the trip is `unlisted`. Which media the Public_Gallery then returns SHALL remain governed by the media visibility policy owned by `multi-user-system` 需求 9 AC 4/AC 5.

#### Correction Note (2026-09-21)

No acceptance criterion in this requirement changes. The 2026-09-09 note below records that tier slideshow **file** access was left refused on non-public trips "pending a separate decision". That decision has now been made, and it is owned by `multi-user-system` 需求 9 AC 15, not by this spec:

- For a requester who is neither owner nor admin, `public` and `unlisted` trips use the same provenance-based rule.
- An `unlisted` trip's slideshow is reachable by direct link once that rule passes, and its URL stays off every public discovery surface.

The existing refusal on `unlisted` trips is a transitional gate. It stays in place until the provenance in `multi-user-system` G-20 is implemented; it is not the final behaviour. The 2026-09-09 note is kept as written.

Status 2026-10-06 (C1): the transitional gate now covers **public trips too**. For a non-owner, non-admin requester on any trip, `slideshowUrls` is `{}` and both `/api` file routes return 404. This is stricter than the target, and it still is not the target. The gate covers the `/api` routes only; the `/uploads` static route is tracked separately as `multi-user-system` G-22.

#### Correction Note (2026-09-09)

AC 3 previously read *"THE Public_Gallery SHALL only show photos and videos from trips with `visibility = 'public'`."* Written before `unlisted` had a defined access semantic, it used the trip-level flag as an access control.

`multi-user-system` 需求 9 AC 9–11 subsequently established that `trips.visibility` controls **discovery**, not direct-link access: an `unlisted` trip stays reachable by its link and only disappears from public listings. AC 3 now states that split, and delegates media exposure to 需求 9 AC 4/AC 5 rather than restating it.

Scope: this changes the trip-level condition only. AC 1 (media-scoped completeness, reconciled 2026-09-07) and AC 2 are untouched, and tier slideshow **file** access is deliberately unchanged — those artifacts carry no source-media provenance, so anonymous exposure on a non-public trip remains refused pending a separate decision.

#### Correction Note (2026-09-07)

AC 1 previously read *"…display 精选 photos **(all `is_highlight = 1` photos)** as the default photo view."* That parenthetical predates the media-level exposure policy, so it stated completeness over a universe that ignored `media_items.visibility`.

`multi-user-system` 需求 9 AC 4/AC 5 owns media exposure: non-owners get `AND m.visibility = 'public'`, owner and admin get no filter. Highlight membership does not override it — see `multi-user-system` G-19. AC 1 now scopes its completeness requirement to the media the current requester is permitted to see, so the two documents agree.

Wording reconciliation only: no production behaviour changed, and AC 3 (trip-level visibility) is deliberately left as-is.

### Requirement 9: Subset Invariant Enforcement

**User Story:** As a system operator, I want the highlight tier to always be a valid subset of highlights, so that data integrity is maintained and no trashed photo ever appears in the premium tier.

#### Acceptance Criteria

1. THE Highlight_Tier_Selector SHALL verify that every candidate photo has `is_highlight = 1` and `media_items.status = 'active'` before including it in VLM evaluation.
2. WHEN a photo is trashed after being marked as highlight tier, THE system SHALL set `is_highlight_tier = 0` for that photo's highlight result row.
3. THE system SHALL exclude photos with `media_items.status = 'trashed'` from all highlight tier queries and displays.
