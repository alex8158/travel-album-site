# Implementation Plan: Manual Photo Management (手动精华管理)

## Overview

This plan implements manual curation of highlight-tier photos: backend API endpoints for add/remove/regenerate operations, a new highlight-photos public endpoint, highlight-removal cascade logic, and frontend enhancements for My Gallery and Public Gallery.

Implementation proceeds bottom-up: backend API → client API functions → frontend components/pages.

## Tasks

- [x] 1. Backend API — Tier Management Endpoints
  - [x] 1.1 Implement PUT /api/my/trips/:id/tier-photos/:photoId (add to tier)
    - Add route handler in `server/src/routes/my.ts`
    - Validate photo belongs to trip, `is_highlight = 1`, `media_items.status = 'active'`
    - Set `is_highlight_tier = 1` in `highlight_results`
    - Return 200 with TierPhotoItem on success; 400/403/404 on failure
    - _Requirements: 2.3, 2.5, 3.1, 3.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 10.1_

  - [x] 1.2 Implement DELETE /api/my/trips/:id/tier-photos/:photoId (remove from tier)
    - Add route handler in `server/src/routes/my.ts`
    - Validate photo belongs to trip, currently has `is_highlight_tier = 1`
    - Set `is_highlight_tier = 0` in `highlight_results`
    - Return 200 on success; 400/403/404 on failure
    - _Requirements: 1.2, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 1.3 Implement GET /api/my/trips/:id/highlight-pool (highlight pool for picker)
    - Add route handler in `server/src/routes/my.ts`
    - Query photos with `is_highlight = 1`, `status = 'active'`, `is_highlight_tier = 0`
    - Return array of TierPhotoItem objects
    - _Requirements: 2.2, 2.6, 3.3_

  - [x] 1.4 Implement POST /api/my/trips/:id/tier-slideshow/regenerate (regenerate slideshow)
    - Add route handler in `server/src/routes/my.ts`
    - Query current tier photos, call `generateSlideshow` synchronously
    - Write output to `uploads/:tripId/tier-slideshow/` directory
    - Return 200 with `{ slideshowUrl }` on success; 400/403/500 on failure
    - _Requirements: 5.2, 5.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 1.5 Write property tests for tier management endpoints
    - **Property 1: Remove clears tier flag**
    - **Property 3: Add enforces subset invariant**
    - **Property 4: Quotas are advisory (not enforced)**
    - **Validates: Requirements 1.2, 2.3, 2.5, 4.1, 4.2, 7.2, 7.3, 7.5, 8.2, 8.3, 10.1**

- [x] 2. Backend API — Public Highlight Photos Endpoint
  - [x] 2.1 Implement GET /api/trips/:id/highlight-photos (all highlights, public)
    - Add route handler in `server/src/routes/highlights.ts`
    - Auth optional; non-owners can only see public trips (same pattern as existing tier-photos)
    - Query all photos with `is_highlight = 1` and `status = 'active'` for the trip
    - Return `{ photos: TierPhotoItem[] }`
    - _Requirements: 6.3, 6.5_

  - [ ]* 2.2 Write property test for public highlight query
    - **Property 6: Public highlight query returns all active highlights**
    - **Validates: Requirements 6.3**

- [x] 3. Backend — Highlight-Removal Cascade
  - [x] 3.1 Add cascade logic: clearing `is_highlight` auto-clears `is_highlight_tier`
    - In `server/src/services/highlightTierSelector.ts` or relevant service
    - When `is_highlight` is set to 0 for a photo, also set `is_highlight_tier = 0`
    - Ensure existing trash cascade already handles `status = 'trashed'` → clear tier flag
    - _Requirements: 10.2, 10.3_

  - [ ]* 3.2 Write property tests for cascade behavior
    - **Property 7: Trash cascades tier flag**
    - **Property 8: Highlight removal cascades tier flag**
    - **Validates: Requirements 10.2, 10.3**

- [x] 4. Checkpoint — Backend Complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Client API Functions
  - [x] 5.1 Add tier management API functions to `client/src/api.ts`
    - `addToTier(tripId, photoId)` → PUT /api/my/trips/:id/tier-photos/:photoId
    - `removeFromTier(tripId, photoId)` → DELETE /api/my/trips/:id/tier-photos/:photoId
    - `regenerateTierSlideshow(tripId)` → POST /api/my/trips/:id/tier-slideshow/regenerate
    - `getHighlightPool(tripId)` → GET /api/my/trips/:id/highlight-pool
    - `getHighlightPhotos(tripId)` → GET /api/trips/:id/highlight-photos
    - All functions use `authFetch` and throw `HighlightsApiError` on failure
    - _Requirements: 2.3, 5.2, 6.3, 7.1, 8.1, 9.1_

- [x] 6. Frontend — PhotoPicker Component
  - [x] 6.1 Create `client/src/components/PhotoPicker.tsx`
    - Implement modal dialog with `open`, `onClose`, `onSelect`, `tripId` props
    - On open: fetch photos from `getHighlightPool(tripId)`
    - Display photos in a thumbnail grid
    - On photo click: call `onSelect(photo)` and close dialog
    - Show loading spinner while fetching, empty state when no eligible photos remain
    - _Requirements: 2.1, 2.2, 2.4, 2.6, 3.3_

  - [ ]* 6.2 Write unit tests for PhotoPicker
    - Test rendering in open/closed states
    - Test loading and empty state rendering
    - Test onSelect callback and dialog close behavior
    - _Requirements: 2.1, 2.2, 2.4_

- [x] 7. Frontend — Enhanced "精华" Tab in MyGalleryPage
  - [x] 7.1 Add "移除精华" button overlay to each tier photo card
    - On click: call `removeFromTier`, optimistically replace card with Empty_Slot
    - On API failure: show toast error, restore photo
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 7.2 Add Empty_Slot with `+` icon that opens PhotoPicker
    - On photo selection: call `addToTier`, display new photo in the slot
    - On API failure: show toast error, keep empty slot
    - _Requirements: 2.1, 2.3, 2.4_

  - [x] 7.3 Add category quota labels above the tier grid
    - Display format: "动物: 7/6-9", "风景: 5/3-9", "人物: 4/3-9"
    - Compute from current tier photos grouped by category
    - _Requirements: 4.3_

  - [x] 7.4 Add "重新生成视频" button below slideshow video
    - On click: call `regenerateTierSlideshow`, show spinner during generation
    - On success: update displayed slideshow URL
    - On failure: show error message, restore button to idle
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 8. Frontend — Public Gallery Tabs (GalleryPage)
  - [x] 8.1 Add tab bar with "全部" and "精华" tabs to GalleryPage
    - "全部" is default active tab
    - Use same pill-tabs styling as existing category tabs
    - Only visible for trips with `visibility = 'public'`
    - _Requirements: 6.1, 6.2, 6.5_

  - [x] 8.2 Wire "全部" tab to display all highlight photos
    - Fetch from `getHighlightPhotos(tripId)`
    - Display in existing image grid layout
    - _Requirements: 6.3_

  - [x] 8.3 Wire "精华" tab to display tier photos and slideshow
    - Fetch from `getTierPhotos(tripId)` (existing API)
    - Show tier photos in grid + tier slideshow video player
    - _Requirements: 6.4_

  - [ ]* 8.4 Write unit tests for Public Gallery tabs
    - Test tab rendering and default selection
    - Test tab switching between "全部" and "精华"
    - Test data fetching for each tab
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 9. Final Checkpoint — All Features Integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The project uses TypeScript throughout (Express backend, React frontend)
- Existing `generateSlideshow` utility and `getStorageProvider` are reused for slideshow regeneration
- The subset invariant (`is_highlight_tier = 1` ⟹ `is_highlight = 1` AND `status = 'active'`) is enforced server-side
- Category quotas from `CATEGORY_QUOTAS` in `highlightTierSelector.ts` are reused for display labels
- Property tests use `fast-check` (already present in the project)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.4", "1.5", "2.2", "3.2"] },
    { "id": 2, "tasks": ["5.1"] },
    { "id": 3, "tasks": ["6.1", "8.1"] },
    { "id": 4, "tasks": ["6.2", "7.1", "7.2", "7.3", "7.4", "8.2", "8.3"] },
    { "id": 5, "tasks": ["8.4"] }
  ]
}
```
