# Implementation Plan: Manual Photo Management

## Overview

Add manual photo management to MyGalleryPage: single delete, category change (single + batch), and restore from trash. Backend adds one new route (`PUT /api/media/:id/category`), frontend adds UI controls to existing page.

## Tasks

- [x] 1. Add backend category update API
  - [x] 1.1 Add `PUT /api/media/:id/category` route in `server/src/routes/trash.ts`
    - Validate `category` is one of `people`, `animal`, `landscape`, `other` — return 400 if invalid
    - Look up media item by id — return 404 if not found
    - Check ownership (media owner / trip owner / admin) — return 403 if unauthorized
    - Update `category` column in `media_items` table
    - Return updated MediaItem as JSON
    - Follow the same pattern as the existing `PUT /api/media/:id/visibility` route
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 1.2 Write unit tests for category update API in `server/src/routes/trash.test.ts`
    - Test valid category update returns 200 with updated MediaItem
    - Test invalid category returns 400
    - Test non-existent media returns 404
    - Test unauthorized user returns 403
    - Test media owner, trip owner, and admin can all update
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 1.3 Write property test: Category update round trip
    - **Property 1: Category update round trip**
    - **Validates: Requirements 2.2, 4.2**

  - [ ]* 1.4 Write property test: Invalid category rejection
    - **Property 2: Invalid category rejection**
    - **Validates: Requirements 2.4, 4.4**

  - [ ]* 1.5 Write property test: Authorization enforcement on category update
    - **Property 3: Authorization enforcement on category update**
    - **Validates: Requirements 4.3, 4.6**

- [x] 2. Checkpoint - Ensure backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Add frontend API client and single-item UI controls
  - [x] 3.1 Add `updateCategory` function in `client/src/api.ts`
    - Call `PUT /api/media/:id/category` with `{ category }` body using `authFetch`
    - _Requirements: 2.2, 4.1_

  - [x] 3.2 Add single delete button to image cards in `client/src/pages/MyGalleryPage.tsx`
    - Show a delete button on each image card when not in multi-select mode
    - On click, show `window.confirm` dialog; on confirm, call existing `PUT /api/trips/:id/media/trash` with single mediaId
    - On success, refetch gallery and trash data
    - On failure, keep image in place (user can retry)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 3.3 Add category picker to image cards in `client/src/pages/MyGalleryPage.tsx`
    - Add a clickable category label on each image card (non-multi-select mode)
    - On click, show inline dropdown with four category options (people, animal, landscape, other)
    - On selection, call `PUT /api/media/:id/category`; on success, update local `data` state (optimistic update)
    - Skip API call if selected category matches current category
    - On failure, revert to original category display
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 4. Add batch category change in multi-select mode
  - [x] 4.1 Add "更换分类" button to multi-select action bar in `client/src/pages/MyGalleryPage.tsx`
    - Show button alongside existing "删除选中" button when items are selected
    - On click, show category picker dropdown
    - On category selection, call `PUT /api/media/:id/category` for each selected item using `Promise.allSettled`
    - On all success: update local state, exit multi-select mode
    - On partial failure: show failure count, keep multi-select mode active
    - Add `batchCategoryPickerOpen` and `batchCategoryChanging` state variables
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 4.2 Write property test: Category filtering correctness
    - **Property 6: Category filtering correctness**
    - **Validates: Requirements 2.3, 3.3**

- [x] 5. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- No database schema changes needed — `media_items.category` column already exists
- The category API follows the same ownership/auth pattern as the existing visibility route in `trash.ts`
- Frontend uses `authFetch` (not axios) consistent with existing MyGalleryPage patterns
- Property tests use `fast-check` library
