# Requirements Document

## Introduction

Manual Photo Management (手动精华管理) enhances the existing highlight-tier (精华) feature by allowing users to manually curate their tier photo collection. Currently, tier selection is entirely AI-driven. This feature adds the ability to remove photos from the tier, add replacement photos from the highlight pool, and regenerate the tier slideshow video on demand. It also adds a dedicated "精华" tab to the Public Gallery for visitors to see tier photos and their slideshow video separately.

## Glossary

- **My_Gallery**: The authenticated user's gallery page (`MyGalleryPage.tsx`) for managing trip photos
- **Public_Gallery**: The publicly accessible gallery page (`GalleryPage.tsx`) showing a trip's curated photos to visitors
- **Tier_Photo**: A photo marked with `is_highlight_tier = 1` in the `highlight_results` table
- **Highlight_Pool**: All photos with `is_highlight = 1` and `media_items.status = 'active'` — the set of eligible photos for tier inclusion
- **Tier_API**: The backend API endpoints for manual tier management under `/api/my/trips/:id/tier-photos`
- **Photo_Picker**: A dialog UI component that displays available photos from the Highlight_Pool for selection
- **Tier_Slideshow**: The generated slideshow video(s) composed from the current set of Tier_Photos for a trip. Generation is **per category** — see `highlight-tier` Requirement 6. APIs return a `slideshowUrls` object keyed by category, not a single URL string.
- **Eligible_Category**: A category whose Tier_Photo count reaches `MIN_PHOTOS_FOR_VIDEO` (6), i.e. a category that is *not* skipped by `highlight-tier` Requirement 6.3. Eligibility is a precondition evaluated **before** generation is attempted; failing it is not a generation failure.
- **Empty_Slot**: A placeholder in the tier photo grid that appears when a photo is removed, showing a `+` icon to trigger the Photo_Picker
- **Category_Quota**: Soft limits on tier photos per category (animal: 6–9, landscape: 3–9, people: 3–9) — advisory rather than enforced
- **Trashed_Photo**: A photo with `media_items.status = 'trashed'`, residing in the "待删除" tab

## Requirements

### Requirement 1: Remove Photo from Tier

**User Story:** As a user, I want to remove a photo from my highlight tier, so that I can curate the tier to my personal preference.

#### Acceptance Criteria

1. WHEN the user views the "精华" tab in My_Gallery, THE My_Gallery SHALL display a "移除精华" button on each Tier_Photo.
2. WHEN the user clicks the "移除精华" button on a Tier_Photo, THE Tier_API SHALL set `is_highlight_tier = 0` for that photo's `highlight_results` row.
3. WHEN a photo is successfully removed from the tier, THE My_Gallery SHALL replace the removed photo with an Empty_Slot showing a `+` icon in the same position.
4. IF the Tier_API fails to remove a photo, THEN THE My_Gallery SHALL display an error message and retain the photo in its current position.

### Requirement 2: Add Photo to Tier via Picker

**User Story:** As a user, I want to add a photo from my highlight pool into the tier, so that I can fill empty slots with photos I prefer.

#### Acceptance Criteria

1. WHEN the user clicks an Empty_Slot `+` icon in the "精华" tab, THE My_Gallery SHALL open the Photo_Picker dialog.
2. THE Photo_Picker SHALL display only photos from the Highlight_Pool (photos where `is_highlight = 1` and `media_items.status = 'active'`) that are not already marked as Tier_Photos.
3. WHEN the user selects a photo in the Photo_Picker, THE Tier_API SHALL set `is_highlight_tier = 1` for that photo's `highlight_results` row.
4. WHEN a photo is successfully added to the tier, THE My_Gallery SHALL display the new photo in the Empty_Slot and close the Photo_Picker.
5. IF the selected photo does not meet the Highlight_Pool criteria (not a highlight or status is not active), THEN THE Tier_API SHALL reject the request with a 400 error and a descriptive message.
6. THE Photo_Picker SHALL not display Trashed_Photos — only photos with `media_items.status = 'active'` and `is_highlight = 1` are eligible.

### Requirement 3: Trashed Photo Restriction

**User Story:** As a user, I want clear guidance that trashed photos cannot be added to the tier, so that I understand the workflow requires restoring photos first.

#### Acceptance Criteria

1. WHEN the user attempts to add a photo to the tier through the Tier_API, THE Tier_API SHALL verify that the photo has `is_highlight = 1` and `media_items.status = 'active'`.
2. IF a photo has `media_items.status = 'trashed'`, THEN THE Tier_API SHALL reject the add request with a 400 error indicating the photo must be restored to the highlight pool first.
3. THE Photo_Picker SHALL only query and display photos from the Highlight_Pool, ensuring Trashed_Photos never appear as selectable options.

### Requirement 4: Soft Category Quotas

**User Story:** As a user, I want category quotas to be advisory rather than enforced, so that I have full creative control over my tier composition.

#### Acceptance Criteria

1. THE Tier_API SHALL allow adding a photo to the tier even if the photo's category already has the maximum quota number of Tier_Photos.
2. THE Tier_API SHALL allow removing a photo from the tier even if the photo's category would drop below the minimum quota.
3. WHILE the user views the "精华" tab in My_Gallery, THE My_Gallery SHALL display the current count of Tier_Photos per category alongside the recommended quota range (e.g., "动物: 7/6-9").

### Requirement 5: Regenerate Tier Slideshow Video

**User Story:** As a user, I want to regenerate my tier slideshow video after making manual changes, so that the video reflects my updated tier selection.

#### Acceptance Criteria

1. WHILE the user views the "精华" tab in My_Gallery, THE My_Gallery SHALL display a "重新生成视频" button.
2. WHEN the user clicks the "重新生成视频" button, THE Tier_API SHALL trigger regeneration of the Tier_Slideshow using the current set of Tier_Photos for the trip.
3. WHILE the Tier_Slideshow is being generated, THE My_Gallery SHALL display a loading indicator on the "重新生成视频" button.
4. WHEN the Tier_Slideshow generation completes successfully, THE My_Gallery SHALL update the displayed videos to show the newly generated per-category videos.
5. IF the regeneration request returns a non-2xx response — including the zero-success generation failure of Requirement 9.6 and the no-eligible-category rejection of Requirement 9.7 — THEN THE My_Gallery SHALL display an error message and restore the "重新生成视频" button to its idle state. A partial success under Requirement 9.3 (at least one category generated) is a successful response and SHALL NOT be surfaced as a failure.
6. IF there are zero Tier_Photos for the trip, THEN THE Tier_API SHALL reject the regeneration request with a 400 error indicating no tier photos are available for slideshow generation.

### Requirement 6: Public Gallery Tabs

**User Story:** As a visitor, I want the public gallery to have separate tabs for all highlights and tier photos, so that I can choose between browsing all curated photos or just the premium tier.

#### Acceptance Criteria

1. THE Public_Gallery SHALL display two tabs: "精选" (all highlights) and "精华" (tier photos).
2. THE Public_Gallery SHALL display the "精选" tab as the default active tab.
3. WHEN the "精选" tab is active, THE Public_Gallery SHALL show all photos where `is_highlight = 1` for the trip.
4. WHEN the "精华" tab is active, THE Public_Gallery SHALL show only photos where `is_highlight_tier = 1` for the trip, plus every available per-category Tier_Slideshow video.
5. THE Public_Gallery tabs SHALL only be visible for trips with `visibility = 'public'`.

#### Correction Note

Criteria 1–3 previously named the first tab "全部". The shipped UI labels it **"精选"** — see `client/src/pages/GalleryPage.tsx` L243, and the existing test `defaults to "全部" tab being active` which asserts on `screen.getByText('精选')`. The wording was corrected to match the implemented and test-covered label; the tab's internal state value remains `'all'`.

Only the label is corrected here. Requirement numbering is unchanged, and no other criteria were rewritten. The same "全部" wording still appears in this spec's `design.md` and in tasks 8.1 / 8.2, which were outside the scope of this correction.

### Requirement 7: API — Add Photo to Tier

**User Story:** As a developer, I want a PUT endpoint to add a photo to the tier, so that the frontend can make manual tier additions.

#### Acceptance Criteria

1. THE Tier_API SHALL expose `PUT /api/my/trips/:id/tier-photos/:photoId` as an authenticated endpoint.
2. WHEN the endpoint receives a valid request, THE Tier_API SHALL verify that the photo belongs to the specified trip, has `is_highlight = 1`, and has `media_items.status = 'active'`.
3. WHEN all validations pass, THE Tier_API SHALL set `is_highlight_tier = 1` for the photo's `highlight_results` row and return HTTP 200 with the updated photo data.
4. IF the photo does not belong to the trip, THEN THE Tier_API SHALL return HTTP 404 with error code `NOT_FOUND`.
5. IF the photo is not in the Highlight_Pool, THEN THE Tier_API SHALL return HTTP 400 with error code `NOT_ELIGIBLE` and a message explaining the photo must be an active highlight.
6. IF the user does not own the trip and is not an admin, THEN THE Tier_API SHALL return HTTP 403 with error code `FORBIDDEN`.

### Requirement 8: API — Remove Photo from Tier

**User Story:** As a developer, I want a DELETE endpoint to remove a photo from the tier, so that the frontend can make manual tier removals.

#### Acceptance Criteria

1. THE Tier_API SHALL expose `DELETE /api/my/trips/:id/tier-photos/:photoId` as an authenticated endpoint.
2. WHEN the endpoint receives a valid request, THE Tier_API SHALL verify that the photo belongs to the specified trip and currently has `is_highlight_tier = 1`.
3. WHEN all validations pass, THE Tier_API SHALL set `is_highlight_tier = 0` for the photo's `highlight_results` row and return HTTP 200.
4. IF the photo does not belong to the trip, THEN THE Tier_API SHALL return HTTP 404 with error code `NOT_FOUND`.
5. IF the photo is not currently in the tier, THEN THE Tier_API SHALL return HTTP 400 with error code `NOT_IN_TIER` and a message indicating the photo is not a tier photo.
6. IF the user does not own the trip and is not an admin, THEN THE Tier_API SHALL return HTTP 403 with error code `FORBIDDEN`.

### Requirement 9: API — Regenerate Tier Slideshow

**User Story:** As a developer, I want a POST endpoint to trigger tier slideshow regeneration, so that the frontend can request video updates after manual changes.

#### Acceptance Criteria

1. THE Tier_API SHALL expose `POST /api/my/trips/:id/tier-slideshow/regenerate` as an authenticated endpoint.
2. WHEN the endpoint receives a valid request, THE Tier_API SHALL query all current Tier_Photos for the trip and trigger the Slideshow_Generator with those photos.
3. WHEN at least one Eligible_Category successfully generates a video, THE Tier_API SHALL return HTTP 200 with a `slideshowUrls` object keyed by category. Categories skipped for having fewer than `MIN_PHOTOS_FOR_VIDEO` (6) photos, and Eligible_Categories whose generation failed, SHALL be absent from that object. The errors of failed Eligible_Categories SHALL be reported in `errors[]`; categories skipped for insufficient photos SHALL NOT be added to `errors[]` and are instead logged per `highlight-tier` Requirement 6.3. Per-category failures SHALL NOT fail the whole request. This criterion governs the partial-success case only — the zero-success case is governed by Requirement 9.6.
4. IF no Tier_Photos exist for the trip, THEN THE Tier_API SHALL return HTTP 400 with error code `NO_TIER_PHOTOS` and a message indicating tier photos are required.
5. IF the user does not own the trip and is not an admin, THEN THE Tier_API SHALL return HTTP 403 with error code `FORBIDDEN`.
6. IF at least one Eligible_Category exists but every Eligible_Category's generation fails, so that zero videos are produced, THEN THE Tier_API SHALL return HTTP 500 with error code `GENERATION_FAILED` and a descriptive error message. THE Tier_API SHALL attempt every Eligible_Category and record each failure before responding, per `highlight-tier` Requirement 6.7; returning 500 after a complete traversal does not constitute aborting the regeneration. Categories skipped for insufficient photos SHALL NOT be counted as generation failures.
7. IF Tier_Photos exist but no category reaches `MIN_PHOTOS_FOR_VIDEO` (6) photos — that is, there is no Eligible_Category — THEN THE Tier_API SHALL return HTTP 400 with error code `NO_ELIGIBLE_CATEGORIES`. This is an eligibility precondition failure, not a generation failure: THE Tier_API SHALL NOT use `GENERATION_FAILED` for this case, and SHALL NOT splice Slideshow_Generator error detail into the `NO_ELIGIBLE_CATEGORIES` message.

### Requirement 10: Subset Invariant Preservation

**User Story:** As a system operator, I want manual tier operations to preserve the highlight-tier subset invariant, so that data integrity is maintained.

#### Acceptance Criteria

1. THE Tier_API SHALL only allow adding photos to the tier that satisfy `is_highlight = 1` and `media_items.status = 'active'`.
2. WHEN a photo currently in the tier is trashed by the user, THE system SHALL automatically set `is_highlight_tier = 0` for that photo (existing trash cascade behavior).
3. WHEN a photo currently in the tier has its highlight status removed (`is_highlight` set to 0), THE system SHALL automatically set `is_highlight_tier = 0` for that photo.
