# Implementation Plan: AI Photo Highlights

## Overview

Implement AI-powered photo highlight selection and similar group identification for travel albums. The system batches technically-qualified photos, sends them to a Vision LLM via provider cascade, persists results to SQLite, and displays highlights/similar groups in the frontend gallery.

## Tasks

- [x] 1. Database schema and migration
  - [x] 1.1 Add highlight database tables and indexes
    - Add `highlight_results`, `similar_groups`, `similar_group_members`, and `highlight_jobs` tables to the database migration in `server/src/database.ts`
    - Include all indexes defined in the design (trip, photo, unique constraints, partial index for active jobs)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 2. Core HighlightService implementation
  - [x] 2.1 Create HighlightService interfaces and batching logic
    - Create `server/src/services/highlightService.ts` with all TypeScript interfaces (`HighlightEvaluation`, `HighlightPhoto`, `SimilarGroup`, `BatchResult`, `HighlightServiceOptions`)
    - Implement `createBatches()` function with batch size 4-8, merging small trailing batches
    - _Requirements: 1.1_

  - [ ]* 2.2 Write property test for batching (Property 1)
    - **Property 1: Batching preserves all photos with valid batch sizes**
    - Generate random photo arrays (1-200 items), verify every batch has 4-8 photos and union equals original list
    - **Validates: Requirements 1.1**

  - [x] 2.3 Implement provider cascade and batch evaluation
    - Import `detectConfiguredProviders` from `llmPairReviewer.ts` and `resizeForAnalysis`, `extractJSON` from `bedrockClient.ts`
    - Implement `evaluateBatch()` that resizes photos to 768x768, sends to Vision LLM with `HIGHLIGHT_BATCH_PROMPT`, cascades through providers on failure
    - Implement single retry on invalid/unparseable response before cascading
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 2.4 Write property test for response parsing (Property 2)
    - **Property 2: Response parsing round-trip**
    - Generate random BatchResult JSON objects, serialize with random wrapping/preamble, verify `extractJSON()` parses back correctly
    - **Validates: Requirements 1.3**

  - [x] 2.5 Implement reason truncation and highlight ratio logic
    - Ensure reason strings are truncated to max 100 characters before persistence
    - Track highlight selection ratio across batches (target 30-40%)
    - _Requirements: 2.2, 2.4_

  - [ ]* 2.6 Write property test for reason truncation (Property 4)
    - **Property 4: Reason field length invariant**
    - Generate random strings (0-500 chars), verify truncation to exactly 100 characters
    - **Validates: Requirements 2.4**

  - [ ]* 2.7 Write property test for similar group best-photo membership (Property 5)
    - **Property 5: Similar group best-photo membership invariant**
    - Generate random similar groups, verify `bestPhotoId` is always a member of `memberPhotoIds`
    - **Validates: Requirements 3.2**

- [x] 3. Result persistence layer
  - [x] 3.1 Implement result persistence with atomic transactions
    - Implement `persistResults()` that deletes existing results for the trip and inserts new highlight_results, similar_groups, and similar_group_members in a single SQLite transaction
    - Implement rollback on failure without corrupting existing data
    - Assign unique group identifiers to each SimilarGroup within a trip
    - _Requirements: 3.3, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 3.2 Write property test for highlight persistence round-trip (Property 3)
    - **Property 3: Highlight persistence round-trip**
    - Generate random highlight records, persist to in-memory SQLite, query back, verify equality
    - **Validates: Requirements 2.3, 5.2**

  - [ ]* 3.3 Write property test for similar group persistence round-trip (Property 6)
    - **Property 6: Similar group persistence round-trip**
    - Generate random similar groups, persist to in-memory SQLite, query back, verify member lists and best photo IDs match
    - **Validates: Requirements 3.3, 5.3**

  - [ ]* 3.4 Write property test for atomic replacement on re-evaluation (Property 7)
    - **Property 7: Atomic replacement on re-evaluation**
    - Generate two sets of results for same trip, persist sequentially, verify only latest exists in database
    - **Validates: Requirements 5.1, 5.4**

  - [x] 3.5 Implement query functions
    - Implement `getHighlightsForTrip(tripId)` joining highlight_results with media_items
    - Implement `getSimilarGroupsForTrip(tripId)` joining similar_groups with similar_group_members
    - _Requirements: 5.2, 5.3_

- [x] 4. Orchestration and job management
  - [x] 4.1 Implement runHighlightEvaluation orchestrator
    - Implement `runHighlightEvaluation()` that creates a highlight_jobs record, collects technical-qualified photos, creates batches, evaluates each batch with progress callback, persists results, and updates job status
    - Handle concurrent evaluation prevention via unique partial index on highlight_jobs
    - Handle error cases: skip missing photos, mark failed batches, continue processing
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.3, 6.3_

- [x] 5. Checkpoint - Ensure all backend service tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. API routes
  - [x] 6.1 Create highlights router with trigger and query endpoints
    - Create `server/src/routes/highlights.ts` with Express Router
    - Implement `POST /api/trips/:id/highlights` — trigger evaluation, return 409 if already running, verify trip ownership
    - Implement `GET /api/trips/:id/highlights` — return highlight photos for trip
    - Implement `GET /api/trips/:id/similar-groups` — return similar groups for trip
    - Apply `authMiddleware` and `requireAuth` to all routes
    - _Requirements: 6.1, 6.2, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 6.2 Register highlights router in the Express app
    - Import and mount the highlights router at the appropriate path in the main app/server setup
    - _Requirements: 8.1_

  - [ ]* 6.3 Write unit tests for API routes
    - Test 404 for non-existent trip, 403 for non-owner, 409 for concurrent evaluation
    - Test successful trigger returns evaluation summary
    - Test GET endpoints return correct data
    - _Requirements: 8.4, 8.5_

- [x] 7. Frontend integration
  - [x] 7.1 Add API client functions for highlights
    - Add functions in `client/src/api.ts` for triggering evaluation, fetching highlights, and fetching similar groups
    - _Requirements: 6.2, 8.1, 8.2, 8.3_

  - [x] 7.2 Implement HighlightBadge component
    - Create `client/src/components/HighlightBadge.tsx` — star icon overlay on photo thumbnails with tooltip showing reason text on hover
    - _Requirements: 7.1, 7.4_

  - [x] 7.3 Implement SimilarGroupPanel component
    - Create `client/src/components/SimilarGroupPanel.tsx` — modal showing group member thumbnails with best-photo indicator
    - _Requirements: 7.3_

  - [x] 7.4 Implement highlight trigger and filter in MyGalleryPage
    - Add trigger button to initiate AI highlight evaluation on the trip gallery page
    - Add progress indicator showing current batch / total batches during evaluation
    - Add "精华" filter toggle to show only highlighted photos
    - Add "相似组" filter toggle to show only photos in similar groups
    - Refresh gallery view after evaluation completes
    - Display error message on evaluation failure
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.2, 7.5_

  - [ ]* 7.5 Write property test for highlight filter (Property 8)
    - **Property 8: Highlight filter shows only highlighted photos**
    - Generate random photo lists with mixed highlight status, apply filter, verify only highlighted photos returned and none missing
    - **Validates: Requirements 7.2**

  - [ ]* 7.6 Write property test for similar group filter (Property 9)
    - **Property 9: Similar group filter shows only grouped photos**
    - Generate random photo lists with mixed group membership, apply filter, verify only grouped photos returned and none missing
    - **Validates: Requirements 7.5**

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript throughout (Express backend + React/Vite frontend)
- Existing infrastructure is reused: `bedrockClient.ts` for image resizing, `llmPairReviewer.ts` for provider detection
- Database: better-sqlite3 with migrations in `server/src/database.ts`
- Test framework: vitest with fast-check for property-based tests

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.5", "3.1", "3.5"] },
    { "id": 3, "tasks": ["2.4", "2.6", "2.7", "3.2", "3.3", "3.4"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 8, "tasks": ["7.5", "7.6"] }
  ]
}
```
