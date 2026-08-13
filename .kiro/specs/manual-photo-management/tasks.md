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
    - Terminal states per the truth table in `design.md` §Components 3:
      - 0 Tier_Photos → 400 `NO_TIER_PHOTOS`
      - 0 Eligible_Category (all below `MIN_PHOTOS_FOR_VIDEO`) → 400 `NO_ELIGIBLE_CATEGORIES`
      - >= 1 Eligible_Category with >= 1 success → 200 `{ slideshowUrls, errors? }`
      - >= 1 Eligible_Category with 0 successes → 500 `GENERATION_FAILED`
      - non-owner/non-admin → 403 `FORBIDDEN`; missing trip → 404 `NOT_FOUND`
    - Skipped categories are logged with their photo count and MUST NOT enter `errors[]`; failed Eligible_Categories record their error in `errors[]`
    - _Requirements: 5.2, 5.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

    > **完成记录（2026-08-07）**
    >
    > 实现已与 `design.md` §Components 3 的 terminal-state truth table 对齐（`server/src/routes/my.ts`：`eligibleCategories` 独立计数、`successfulGenerations` 三态分流、循环内无提前 return）。
    >
    > Route-level 回归测试：`server/src/routes/myRegenerate.test.ts`，20 个测试全部通过。
    >
    > | 验收项 | 证据 |
    > | --- | --- |
    > | 0 Tier_Photos → 400 `NO_TIER_PHOTOS` | `9.4: returns 400 NO_TIER_PHOTOS when the trip has zero Tier_Photos` |
    > | 0 Eligible_Category → 400 `NO_ELIGIBLE_CATEGORIES` | `9.7: returns 400 NO_ELIGIBLE_CATEGORIES when every category is below MIN_PHOTOS_FOR_VIDEO`；文案净化由 `9.7: the NO_ELIGIBLE_CATEGORIES message describes only the photo-count shortfall` 双哨兵断言 |
    > | >= 1 eligible 且 >= 1 成功 → 200 `{ slideshowUrls, errors? }` | `9.3: one category succeeds and one fails ...`、`9.3: a thrown generator error ...`、`9.3: errors is omitted entirely when no Eligible_Category failed` |
    > | >= 1 eligible 且 0 成功 → 500 `GENERATION_FAILED` | `9.6: returns 500 GENERATION_FAILED after attempting every Eligible_Category`、`9.6: a single Eligible_Category that fails yields 500, not 400` |
    > | skipped category 不进入 `errors[]` | `6.3: a skipped category does not enter errors[] alongside a successful eligible category`、`6.3 + 9.6: ... nor turns the 500 into a 400` |
    > | 失败的 Eligible_Category 进入 `errors[]` | `9.3: one category succeeds and one fails ...`、`9.3: an eligible category degraded below the threshold is recorded in errors[], not silently skipped` |
    > | 完整遍历、无 early abort | `9.6: three eligible categories all failing are all attempted before the 500`（3 次 generator 调用全部发生后才 500） |
    > | owner / admin 权限 | `9.5: returns 403 FORBIDDEN ...`、`9.5: allows an admin to regenerate a trip they do not own`；未认证由 `9.1: rejects an unauthenticated request` 覆盖 |
    >
    > 五次变异验证（Mutation A–E）分别破坏 zero-eligible 分流、all-failed 分流、partial success/完整遍历、下载降级记录、skip 语义，命中 3/5/3/1/5 个测试，恢复后 `my.ts` 与变异前逐字一致。
    >
    > 仅由代码举证、无专门测试断言的验收项：输出目录 `uploads/:tripId/tier-slideshow/{category}/`（`my.ts` 的 `path.join(uploadsBase, tripId, 'tier-slideshow', category)`）。测试因 mock 掉 `generateSlideshow` 只断言了该路径末段的 category 与对外 URL 前缀 `/api/trips/:id/tier-slideshow/{category}/`，未断言文件系统前缀。

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

    > **完成范围说明（2026-08-07）**
    >
    > 本任务的验收文本要求的是**服务层 cascade 原语**（"Add cascade logic … In … service"），不要求
    > 用户可调用的 unhighlight 能力。`[x]` 覆盖该层，且两条需求的交付程度不同：
    >
    > | 需求 | 原语 | 生产调用路径 | 测试 |
    > | --- | --- | --- | --- |
    > | 10.2（trash → 清 tier） | `clearHighlightTierForPhotos()` | ✅ 4 处：`trash.ts:57`、`highlightService.ts:1363/1402`、`survivorDedup.ts:298` | ✅ `my.test.ts` `B: trashing a tier photo clears is_highlight_tier but not is_highlight (Requirement 10.2 / Property 7)` 等 5 条 |
    > | 10.3（清 highlight → 级联清 tier） | `clearHighlightWithCascade()` | ⬜ 零调用点 —— 当前无任何生产路径执行 `is_highlight` 1 → 0 | ⬜ 无 |
    >
    > 10.3 属 dormant invariant，零调用点不是缺陷，详见 `design.md` Property 8 下的说明。
    > 不得为制造调用点而新增人工入口。`clearHighlightWithCascade()` 目前**完全没有单元测试**，
    > 这是已登记的测试缺口（任务 3.2 仍为 `[ ]*`），非本任务验收项。

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

  - [x]* 6.2 Write unit tests for PhotoPicker
    - Test rendering in open/closed states
    - Test loading and empty state rendering
    - Test onSelect callback and dialog close behavior
    - _Requirements: 2.1, 2.2, 2.4_

    > **完成记录（2026-08-07）**
    >
    > `client/src/components/PhotoPicker.test.tsx`，18 个 example-based 测试全部通过。
    >
    > | 验收 bullet | 覆盖 |
    > | --- | --- |
    > | open/closed 渲染 | `2.1: renders nothing when open is false`、`2.1: does not fetch the highlight pool while closed`、`2.1: renders an accessible modal dialog when open is true`、`2.1: fetches the highlight pool for the given trip once opened`、`2.1: re-fetches when the dialog is reopened` |
    > | loading 与 empty 状态 | `shows the loading indicator while the pool request is pending`、`shows the empty message when the highlight pool is exhausted` |
    > | onSelect 回调与关闭行为 | `2.4: clicking a photo calls onSelect with that photo and then closes the dialog`、`2.4: does not invoke onSelect for a photo the user did not click`、`calls onClose when the header close button is clicked, without selecting anything`、`calls onClose when the backdrop itself is clicked`、`does not close when a click originates inside the dialog panel` |
    >
    > 另覆盖需求 2.2 / 2.6 / 3.3 的组件侧义务（渲染集合等于 `getHighlightPool` 响应，不做客户端二次过滤）与当前真实的 error 态行为（`photo-picker-error`、`加载失败` 兜底）。
    >
    > 三次变异验证：移除选中后 `onClose`（1 failed）、移除 `open` 门控（1 failed）、移除 backdrop 的 `e.target === e.currentTarget` 守卫（4 failed）；恢复后 `PhotoPicker.tsx` 与变异前逐字一致。
    >
    > 范围说明：需求 2.1「点击 Empty_Slot `+` 打开对话框」的**触发侧**属 `MyGalleryPage`，2.2 / 2.6 / 3.3 的 Highlight_Pool 谓词由服务端 `highlight-pool` 端点强制（已由 `server/src/routes/my.test.ts` 覆盖），二者均不在本组件测试范围内。`MyGalleryPage` 目前仍无测试，属已登记的测试债务。

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
  - [x] 8.1 Add tab bar with "精选" and "精华" tabs to GalleryPage
    - "精选" is default active tab
    - Use same pill-tabs styling as existing category tabs
    - Only visible for trips with `visibility = 'public'`
    - _Requirements: 6.1, 6.2, 6.5_

  - [x] 8.2 Wire "精选" tab to display all highlight photos
    - Fetch from `getHighlightPhotos(tripId)`
    - Display in existing image grid layout
    - _Requirements: 6.3_

  - [x] 8.3 Wire "精华" tab to display tier photos and slideshow
    - Fetch from `getTierPhotos(tripId)` (existing API)
    - Show tier photos in grid + tier slideshow video player
    - _Requirements: 6.4_

  - [x] 8.4 Write unit tests for Public Gallery tabs
    - Test tab rendering and default selection
    - Test tab switching between "精选" and "精华"
    - Test data fetching for each tab
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

    > **完成记录（2026-08-05）**
    >
    > `client/src/pages/GalleryPage.test.tsx` 现有 26 个测试，三项验收条件覆盖情况：
    >
    > | 验收条件 | 状态 | 对应测试 |
    > | --- | --- | --- |
    > | 分栏渲染与默认选中 | ✅ | `shows gallery mode tabs for public trips`、`defaults to "全部" tab being active`、`uses pill-tabs styling for gallery mode tabs`、`does not show gallery mode tabs for unlisted trips` |
    > | 分栏切换 | ✅ | `shows tier photos and slideshow when "精华" tab is clicked, without re-fetching either API`、`hides highlight grid and shows tier content when switching to "精华" tab` |
    > | 各分栏的数据拉取 | ✅ | `fetches both tabs' data once trip data resolves, independent of which tab is active`（新增）+ 上一条测试内追加的调用次数断言 |
    >
    > **已确认的生产行为**（`GalleryPage.tsx`）：`getHighlightPhotos(id)` 与 `getTierPhotos(id)` 由同一组 `useEffect`（依赖 `[id, data]`）驱动，在 trip 数据到手且 `visibility !== 'unlisted'` 后各触发一次；两者均**不**依赖 `galleryTab`。这是挂载时对两个分栏的预取（eager prefetch），点击分栏切换只改变展示哪部分已加载数据，**不会**产生新请求。
    >
    > 因此"用户切换到另一个分栏时，调用该分栏对应的数据 API"这条验收描述，按当前实现的真实语义验证为：两个 API 分别有独立测试断言其被调用且参数正确（`toHaveBeenCalledWith('trip-1')`），并额外断言切换分栏前后两者的调用次数均不变。测试锁定的是生产代码的真实行为，没有为了字面吻合旧描述而断言一个不存在的"切换触发新请求"语义。
    >
    > 本次还确认新增了 4 个类别渲染测试（`renders one slideshow video per category...`、`renders an unknown category key verbatim...`、`renders no category heading for the legacy "all" key`、`does not render the slideshow section when slideshowUrls is empty`），覆盖此前完全空白的按类别多视频渲染场景。

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
