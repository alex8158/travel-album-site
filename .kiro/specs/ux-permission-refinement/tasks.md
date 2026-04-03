# Implementation Plan: UX与权限展示优化

## Overview

将旅行相册系统的「公开浏览」与「编辑管理」在路由级别彻底分离。后端新增批量删除接口和 gallery API 重命名，前端将 GalleryPage 改为纯只读、新建 MyGalleryPage 承载编辑功能、NavHeader 按上下文渲染、HomePage 清理 unlisted 逻辑、UserSpacePage 增强管理功能、LoginPage 增加登录后跳转逻辑。

## Tasks

- [x] 1. Backend: batch trash API and gallery route rename
  - [x] 1.1 Add `PUT /api/trips/:id/media/trash` endpoint in `server/src/routes/trash.ts`
    - Accept `{ mediaIds: string[] }` body
    - Validate trip exists, user is owner or admin, mediaIds is non-empty array
    - Update all matching active media items to status='trashed', trashed_reason='manual'
    - Return `{ trashedCount: number }`
    - Handle errors: 404 NOT_FOUND, 403 FORBIDDEN, 400 INVALID_REQUEST
    - _Requirements: 4.5, 4.6, 8.5_

  - [x] 1.2 Create `server/src/routes/my.ts` with `GET /api/my/trips/:id/gallery` route
    - Move the gallery logic from `server/src/routes/users.ts` (`/me/trips/:id/gallery`) to new file
    - Mount as `/api/my` in `server/src/index.ts`
    - Keep the existing `/api/users/me/trips/:id/gallery` route as-is for backward compatibility
    - _Requirements: 7.1, 7.6_

  - [ ]* 1.3 Write property test for batch trash endpoint (Property 6)
    - **Property 6: Batch trash marks all selected media as trashed**
    - Generate random sets of active media IDs, verify all become trashed with reason 'manual'
    - **Validates: Requirements 4.5, 4.6, 8.5**

  - [x] 1.4 Checkpoint - Ensure backend tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 2. GalleryPage read-only conversion
  - [x] 2.1 Strip all edit functionality from `client/src/pages/GalleryPage.tsx`
    - Remove `canEdit` variable and all conditional rendering that depends on it
    - Remove edit button, append media button, change cover button
    - Remove edit modal, cover picker modal, default image picker modal
    - Remove trash zone section
    - Remove append media area and all append-related state/handlers
    - Remove duplicate group selector buttons (`🔄 N张`)
    - Remove imports for FileUploader, ProcessTrigger, ProcessingLog, authFetch
    - Keep: image grid + Lightbox, video grid + VideoPlayer, trip title/description, back link, unlisted notice
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 7.7_

  - [ ]* 2.2 Write property test for GalleryPage read-only (Property 2)
    - **Property 2: GalleryPage does not render any edit controls**
    - For random user states and gallery data, verify no edit/append/cover/trash controls exist
    - **Validates: Requirements 2.1, 2.2, 3.1, 7.7**

- [x] 3. Create MyGalleryPage with multi-select
  - [x] 3.1 Create `client/src/pages/MyGalleryPage.tsx`
    - Fetch data from `GET /api/my/trips/:id/gallery` using authFetch
    - Include all edit functionality removed from GalleryPage: edit modal, append media, cover picker, default image picker, trash zone, duplicate group selector
    - Add permission check: if user is not owner and not admin, show "无权访问此相册" message
    - _Requirements: 7.1, 7.4, 7.5, 7.6, 4.4_

  - [x] 3.2 Implement multi-select mode in MyGalleryPage
    - Add "选择" button in toolbar to enter multi-select mode
    - Show checkbox overlay on each image/video in multi-select mode
    - Show bottom action bar with selected count and "删除选中" button when items selected
    - "删除选中" shows confirmation dialog with count
    - On confirm, call `PUT /api/trips/:id/media/trash` with selected IDs
    - On complete, exit multi-select mode and refresh gallery
    - "取消" button clears selection and exits multi-select mode
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 3.3 Register `/my/trips/:id` route in `client/src/App.tsx`
    - Import MyGalleryPage
    - Add `<Route path="/my/trips/:id" element={<ProtectedRoute><MyGalleryPage /></ProtectedRoute>} />`
    - _Requirements: 7.1_

  - [ ]* 3.4 Write property test for MyGalleryPage access control (Property 7)
    - **Property 7: MyGalleryPage rejects non-owner non-admin users**
    - **Validates: Requirements 7.5**

  - [ ]* 3.5 Write property test for multi-select mode (Property 8)
    - **Property 8: Multi-select mode shows checkboxes and action bar**
    - **Validates: Requirements 8.2, 8.3**

- [x] 4. Checkpoint - Ensure core pages work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. NavHeader context-switching
  - [x] 5.1 Refactor NavHeader in `client/src/App.tsx`
    - Add `isUserSpace` check: `pathname.startsWith('/my') || pathname === '/upload' || pathname === '/admin' || pathname === '/settings'`
    - Unauthenticated: show only Logo + 登录 + 注册 (hide 设置, 管理后台, 我的空间, 退出, 新建旅行)
    - Authenticated + public page: show Logo + username + 我的空间 + 退出 (hide 设置, 新建旅行, 管理后台)
    - Authenticated + user space: show Logo + username + 我的空间 + 设置 + 新建旅行 + 退出
    - Admin + user space: additionally show 会员管理 (replacing 管理后台)
    - Remove the unconditional 设置 link and the "← 返回首页" link from NavHeader
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 5.2 Write property test for NavHeader (Property 1)
    - **Property 1: NavHeader renders correct nav items based on auth state and route context**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

- [x] 6. HomePage cleanup
  - [x] 6.1 Simplify `client/src/pages/HomePage.tsx`
    - Remove `isUnlisted` check and all unlisted-specific rendering (opacity, badge, non-clickable div)
    - All cards use `<Link to={/trips/${trip.id}}>` uniformly
    - Remove `visibility` field usage from rendering logic (backend already only returns public)
    - Remove `useAuth` import and `isLoggedIn` usage if no longer needed
    - _Requirements: 7.3_

  - [ ]* 6.2 Write property test for HomePage card links (Property 11)
    - **Property 11: All HomePage cards link to /trips/:id**
    - **Validates: Requirements 7.3**

- [x] 7. UserSpacePage enhancements
  - [x] 7.1 Update `client/src/pages/UserSpacePage.tsx`
    - Change card links from `/trips/:id` to `/my/trips/:id`
    - Add visibility status label ("公开" / "不公开") on each card
    - Add Visibility_Toggle button on each card (calls `PUT /api/trips/:id/visibility` toggling between "public" and "unlisted")
    - Implement optimistic UI update with rollback on API failure
    - Add "删除相册" button on each card
    - Add "会员管理" button for admin users (links to /admin)
    - Add "新建相册" entry linking to /upload
    - _Requirements: 4.1, 4.2, 4.3, 7.2, 9.1, 9.2, 9.3, 9.4, 9.5, 5.1_

  - [ ]* 7.2 Write property test for UserSpacePage card controls (Property 4)
    - **Property 4: UserSpacePage cards include visibility label, toggle, delete button, and link to /my/trips/:id**
    - **Validates: Requirements 4.3, 7.2, 9.1, 9.2**

  - [ ]* 7.3 Write property test for UserSpacePage showing all trips (Property 5)
    - **Property 5: UserSpacePage shows all user trips (public + unlisted)**
    - **Validates: Requirements 4.1**

  - [ ]* 7.4 Write property test for visibility toggle (Property 9)
    - **Property 9: Visibility toggle calls API and updates UI label**
    - **Validates: Requirements 9.3, 9.4**

- [x] 8. LoginPage redirect logic
  - [x] 8.1 Update `client/src/pages/LoginPage.tsx` with returnTo support
    - Read `returnTo` query parameter from URL
    - After successful login, if returnTo matches `/trips/:id`, check trip ownership via API
    - Owner or admin → redirect to `/my/trips/:id`
    - Non-owner → redirect back to `/trips/:id` (stay on public page, not home)
    - API check failure → redirect back to returnTo path
    - No returnTo → redirect to `/`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 8.2 Update GalleryPage login link to include returnTo parameter
    - NavHeader login link should carry `?returnTo={currentPath}` when on GalleryPage
    - _Requirements: 10.1_

  - [ ]* 8.3 Write property test for login redirect (Property 10)
    - **Property 10: Login redirect based on trip ownership**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

- [x] 9. Checkpoint - Ensure all navigation and redirect flows work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. AdminUserTripsPage
  - [x] 10.1 Create `client/src/pages/AdminUserTripsPage.tsx`
    - Route: `/admin/users/:userId/trips`
    - Fetch trips via `GET /api/admin/users/:userId/trips` (existing backend endpoint)
    - Display trip cards linking to `/my/trips/:id` (admin has edit access)
    - Requires admin (ProtectedRoute requireAdmin)
    - _Requirements: 5.1, 5.2_

  - [x] 10.2 Register admin user trips route in `client/src/App.tsx`
    - Add `<Route path="/admin/users/:userId/trips" element={<ProtectedRoute requireAdmin><AdminUserTripsPage /></ProtectedRoute>} />`
    - _Requirements: 5.1_

  - [x] 10.3 Add "查看相册" link in AdminPage user table
    - Add a link to `/admin/users/:userId/trips` for each user row
    - _Requirements: 5.2_

- [x] 11. CHANGELOG.md
  - [x] 11.1 Create or append to `CHANGELOG.md` in project root
    - Use Keep a Changelog format, in Chinese
    - Include date, version identifier, and change summary
    - Categorize changes: 导航栏变更, 公开相册页变更, 用户空间变更, 管理员权限变更, 后端接口变更
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 12. Test updates
  - [x] 12.1 Update `client/src/pages/GalleryPage.test.tsx`
    - Remove tests for edit controls, append media, cover picker, default picker, trash zone
    - Add tests verifying no edit controls are rendered for any user state
    - Verify read-only behavior: image grid, video grid, lightbox, unlisted notice
    - _Requirements: 2.1, 2.2, 7.7_

  - [x] 12.2 Update `client/src/pages/HomePage.test.tsx`
    - Remove tests for unlisted card rendering (opacity, badge, non-clickable)
    - Verify all cards are clickable links to `/trips/:id`
    - _Requirements: 7.3_

  - [x] 12.3 Update `client/src/App.test.tsx`
    - Add route tests for `/my/trips/:id` rendering MyGalleryPage
    - Add route tests for `/admin/users/:userId/trips` rendering AdminUserTripsPage
    - _Requirements: 7.1_

  - [x] 12.4 Update `server/src/routes/trash.test.ts`
    - Add tests for `PUT /api/trips/:id/media/trash` endpoint
    - Test: valid batch trash, empty mediaIds (400), non-owner (403), trip not found (404)
    - _Requirements: 4.5, 4.6, 8.5_

  - [ ]* 12.5 Write property test for public gallery API (Property 3)
    - **Property 3: Public gallery API returns only public default images**
    - **Validates: Requirements 2.3, 3.2**

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- GalleryPage refactoring (task 2) is the core change — strips all edit functionality
- MyGalleryPage (task 3) takes over all edit functionality from GalleryPage
- Backend changes are minimal: 1 new endpoint + 1 route rename
- The gallery API rename preserves backward compatibility via the existing `/api/users/me/trips/:id/gallery` route
- Property tests use `fast-check` with vitest, minimum 100 iterations each
