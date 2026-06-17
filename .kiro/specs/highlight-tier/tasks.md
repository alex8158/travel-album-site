# Implementation Plan: Highlight Tier Selection (精华)

## Overview

Implement a second curation pass that selects the absolute best photos per category from highlight results, persists tier flags, auto-generates a slideshow video, and surfaces the tier in both My Gallery and Public Gallery. The implementation proceeds bottom-up: schema → core logic → integration → API → frontend.

## Tasks

- [x] 1. Database schema migration
  - [x] 1.1 Add `is_highlight_tier` column to `highlight_results` table
    - Add migration in `server/src/database.ts` `initTables`: `ALTER TABLE highlight_results ADD COLUMN is_highlight_tier INTEGER DEFAULT 0`
    - Use the existing pattern of conditional ALTER (try/catch or IF NOT EXISTS check)
    - _Requirements: 2.1_

- [x] 2. Implement core tier selector module
  - [x] 2.1 Create `server/src/services/highlightTierSelector.ts` with types and constants
    - Define `TierCategory`, `CategoryQuota`, `CATEGORY_QUOTAS`, `TIER_BATCH_MIN`, `TIER_BATCH_MAX`
    - Define `TierCandidate`, `TierPick`, `TierSelectionResult` interfaces
    - Export the candidate query function that fetches highlight photos grouped by category
    - _Requirements: 1.2, 3.1, 3.2, 3.3, 9.1_

  - [x] 2.2 Implement `buildCategoryPrompt` function
    - Generate category-specific VLM prompts for animal, landscape, people
    - Include underwater-photo handling instruction in all prompts
    - Include quota bounds and JSON response format instruction
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 2.3 Implement `createTierBatches` function
    - Split photos into sub-batches of 10–15 when category has >15 candidates
    - Return single batch when ≤15 candidates
    - _Requirements: 4.1, 4.2_

  - [x] 2.4 Implement `parseTierResponse` function
    - Extract JSON from VLM response text (reuse `extractJSON` from highlightService)
    - Validate `selected` array structure
    - Map indices to photo IDs, filter out-of-range entries
    - Truncate reason strings
    - _Requirements: 4.4_

  - [x] 2.5 Implement `runTierSelection` orchestrator
    - Query candidates grouped by category
    - For each category: batch → VLM call(s) → parse → multi-round if >15
    - Collect all picks across categories
    - Call persistence and slideshow generation
    - Handle errors per-batch without crashing the overall flow
    - _Requirements: 1.1, 1.2, 1.3, 3.4, 3.5, 4.3, 4.4_

  - [x] 2.6 Implement `persistTierResults` function
    - Reset all `is_highlight_tier = 0` for the trip in a transaction
    - Set `is_highlight_tier = 1` for selected photo IDs
    - _Requirements: 2.3, 2.4_

  - [ ]* 2.7 Write property tests for `createTierBatches` (batch size bounds)
    - **Property 4: Batch Size Bounds**
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 2.8 Write property test for `buildCategoryPrompt` (underwater instruction inclusion)
    - **Property 5: Underwater Prompt Inclusion**
    - **Validates: Requirements 5.4**

  - [ ]* 2.9 Write property test for candidate filtering invariant
    - **Property 1: Candidate Filtering Invariant**
    - **Validates: Requirements 1.2, 9.1**

  - [ ]* 2.10 Write property test for category quota bounds
    - **Property 3: Category Quota Bounds**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Integrate tier selector into highlight pipeline
  - [x] 4.1 Modify `server/src/services/highlightService.ts` to call tier selection
    - After `persistResults` completes successfully, call `runTierSelection(tripId)`
    - Wrap in try/catch so tier failure does not invalidate highlight evaluation results
    - Log tier selection result or error
    - _Requirements: 1.1, 1.3_

  - [x] 4.2 Implement trash cascade for tier flag
    - In the trash operation handler (`server/src/routes/trash.ts` or media status update logic), add `UPDATE highlight_results SET is_highlight_tier = 0 WHERE photo_id = ?` when a photo is trashed
    - _Requirements: 9.2_

  - [ ]* 4.3 Write property test for subset invariant
    - **Property 2: Subset Invariant (Database Level)**
    - **Validates: Requirements 2.4**

  - [ ]* 4.4 Write property test for trash cascade
    - **Property 7: Trash Cascades Tier Flag**
    - **Validates: Requirements 9.2**

- [x] 5. Add slideshow generation trigger
  - [x] 5.1 Wire slideshow generation after tier persistence
    - After `persistTierResults` succeeds with ≥1 picks, collect file paths and call existing `generateSlideshow` service
    - Store the resulting video associated with the trip (tier slideshow)
    - Skip if zero tier photos selected
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 6. Implement API endpoints for tier photos
  - [x] 6.1 Add tier photos route in `server/src/routes/highlights.ts` (or new file)
    - `GET /api/trips/:id/tier-photos` — public endpoint (respects trip visibility)
    - `GET /api/my/trips/:id/tier-photos` — authenticated endpoint for My Gallery
    - Return `{ photos: TierPhotoItem[], slideshowUrl: string | null }`
    - Exclude trashed photos from results
    - _Requirements: 7.2, 8.1, 8.2, 8.3, 9.3_

  - [ ]* 6.2 Write unit tests for tier photos API endpoints
    - Test that trashed photos are excluded
    - Test that non-public trips are not exposed on public endpoint
    - _Requirements: 9.3, 8.3_

- [x] 7. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Frontend: Add tier API client functions
  - [x] 8.1 Add `getTierPhotos` and `getMyTierPhotos` functions to `client/src/api.ts`
    - Define `TierPhotoItem` interface
    - Call authenticated and public endpoints respectively
    - Handle errors with existing `HighlightsApiError` pattern
    - _Requirements: 7.2, 8.2_

- [x] 9. Frontend: Add "精华" tab to My Gallery
  - [x] 9.1 Extend `FilterMode` type and add "精华" tab in `client/src/pages/MyGalleryPage.tsx`
    - Add `'tier'` to the `FilterMode` union type
    - Add "精华" tab button alongside existing filter modes
    - When tab is active, fetch tier photos via `getMyTierPhotos`
    - Display tier slideshow video above or alongside the photo grid
    - Show empty state message if no tier photos exist
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 10. Frontend: Display tier slideshow in Public Gallery
  - [x] 10.1 Update `client/src/pages/GalleryPage.tsx` to show tier video
    - Fetch tier slideshow URL from public tier photos endpoint
    - Display the tier slideshow video prominently in the gallery layout
    - Only show for trips with `visibility = 'public'`
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The tier selector reuses existing VLM invocation patterns from `highlightService.ts`
- The slideshow generation reuses the existing `slideshowGenerator.ts` service

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "2.8"] },
    { "id": 4, "tasks": ["2.9", "2.10", "4.1", "4.2"] },
    { "id": 5, "tasks": ["4.3", "4.4", "5.1"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["6.2", "8.1"] },
    { "id": 8, "tasks": ["9.1", "10.1"] }
  ]
}
```
