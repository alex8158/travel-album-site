# 实现计划：相册可见性控制

## 概述

为旅行相册网站增加公开/不公开状态管理能力。实现路径：先完成后端数据模型和 API 变更，再逐步修改前端各页面，最后新增设置页面。每个步骤在前一步基础上递增构建，确保无孤立代码。

## 任务

- [x] 1. 后端数据模型与类型定义变更
  - [x] 1.1 更新 `server/src/types.ts`，新增 `TripVisibility` 类型，在 `Trip` 和 `TripSummary` 接口中增加 `visibility` 字段
    - 新增 `export type TripVisibility = 'public' | 'unlisted'`
    - `Trip` 接口增加 `visibility: TripVisibility`
    - `TripSummary` 接口增加 `visibility: TripVisibility`
    - _需求: 1.2_

  - [x] 1.2 更新 `server/src/database.ts`，在 `trips` 表中新增 `visibility` 列
    - `CREATE TABLE` 语句增加 `visibility TEXT NOT NULL DEFAULT 'public'`
    - 在 `initTables` 中增加 `ALTER TABLE` 迁移逻辑，使用 `try-catch` 确保幂等性
    - _需求: 1.2_

  - [x] 1.3 更新 `server/src/routes/trips.ts`，修改 `TripRow` 接口和 `rowToTrip` 函数以包含 `visibility` 字段
    - `TripRow` 增加 `visibility: string`
    - `rowToTrip` 映射 `visibility` 字段
    - 修改 `POST /api/trips` 的 INSERT 语句，显式设置 `visibility = 'public'`
    - 修改 `GET /api/trips` 返回的 `TripSummary` 包含 `visibility` 字段
    - _需求: 1.1, 3.1_

- [x] 2. 新增可见性更新 API
  - [x] 2.1 在 `server/src/routes/trips.ts` 中实现 `PUT /api/trips/:id/visibility` 端点
    - 接受 `{ visibility: 'public' | 'unlisted' }` 请求体
    - 验证 `visibility` 值，无效时返回 400（`INVALID_VISIBILITY`）
    - 验证 Trip 存在，不存在时返回 404（`NOT_FOUND`）
    - 更新数据库中的 `visibility` 和 `updated_at` 字段
    - 返回更新后的 Trip 对象
    - _需求: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 2.2 编写属性测试：新建 Trip 默认可见性为公开
    - **Property 1: 新建 Trip 默认可见性为公开**
    - **验证: 需求 1.1**

  - [ ]* 2.3 编写属性测试：可见性更新的往返一致性
    - **Property 2: 可见性更新的往返一致性**
    - **验证: 需求 2.2, 2.3, 4.1, 4.2**

  - [ ]* 2.4 编写属性测试：无效可见性值被拒绝
    - **Property 3: 无效可见性值被拒绝**
    - **验证: 需求 1.2, 4.4**

  - [ ]* 2.5 编写后端 API 单元测试
    - 测试 `PUT /api/trips/:id/visibility` 成功更新场景
    - 测试 Trip 不存在时返回 404（需求 4.3）
    - 测试创建 Trip 后数据库中 visibility 为 'public'
    - 测试 `GET /api/trips` 返回的 TripSummary 包含 visibility 字段
    - _需求: 4.1, 4.2, 4.3, 4.4_

- [x] 3. 检查点 - 后端变更验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 4. 前端 HomePage 变更
  - [x] 4.1 更新 `client/src/pages/HomePage.tsx`，在 `TripSummary` 接口中增加 `visibility` 字段
    - 接口增加 `visibility: 'public' | 'unlisted'`
    - 不公开相册卡片显示"未公开"标签
    - 不公开相册卡片禁用点击跳转（将 `Link` 替换为 `div`，移除链接行为）
    - 降低不公开相册卡片的不透明度以区分状态
    - _需求: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 4.2 编写属性测试：首页卡片行为由可见性决定
    - **Property 5: 首页卡片行为由可见性决定**
    - **验证: 需求 3.2, 3.3, 3.4**

  - [ ]* 4.3 编写 HomePage 单元测试
    - 测试不公开相册显示"未公开"标签
    - 测试不公开相册卡片不可点击
    - 测试公开相册卡片正常可点击
    - _需求: 3.2, 3.3, 3.4_

- [x] 5. 前端 GalleryPage 变更
  - [x] 5.1 更新 `client/src/pages/GalleryPage.tsx`，增加不公开相册访问拦截
    - 在 `GalleryTrip` 接口中增加 `visibility` 字段
    - 当 `trip.visibility === 'unlisted'` 时，不渲染图片/视频内容
    - 显示"该相册未公开"提示信息和返回首页链接
    - _需求: 3.5_

  - [ ]* 5.2 编写属性测试：Gallery 页面阻止不公开相册内容展示
    - **Property 6: Gallery 页面阻止不公开相册内容展示**
    - **验证: 需求 3.5**

  - [ ]* 5.3 编写 GalleryPage 单元测试
    - 测试不公开相册显示提示信息
    - 测试不公开相册不渲染图片和视频
    - _需求: 3.5_

- [x] 6. 前端 UploadPage 变更
  - [x] 6.1 更新 `client/src/pages/UploadPage.tsx`，在完成步骤增加可见性选择控件
    - 在 `step === 'done'` 阶段增加两个单选按钮：公开/不公开
    - 默认选中"公开"
    - 用户选择"不公开"后调用 `PUT /api/trips/:id/visibility` 更新状态
    - 用户不做选择直接离开时保持默认公开状态
    - _需求: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 6.2 编写 UploadPage 单元测试
    - 测试完成步骤渲染可见性选择控件（需求 2.1）
    - 测试选择"不公开"后调用 API 更新（需求 2.2）
    - 测试默认选中"公开"（需求 2.4）
    - _需求: 2.1, 2.2, 2.4_

- [x] 7. 检查点 - 前端页面变更验证
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 8. 新增设置页面与导航入口
  - [x] 8.1 创建 `client/src/pages/SettingsPage.tsx`
    - 调用 `GET /api/trips` 获取所有旅行列表
    - 以列表形式展示每个 Trip 的标题、创建时间和可见性状态
    - 每个 Trip 提供一个开关按钮（toggle switch）切换可见性
    - 切换时立即调用 `PUT /api/trips/:id/visibility`
    - 成功后更新本地状态；失败时回滚切换控件并显示错误提示
    - _需求: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 8.2 更新 `client/src/App.tsx`
    - 导入 `SettingsPage` 组件
    - 添加 `/settings` 路由
    - 在 `NavHeader` 中增加"设置"链接
    - _需求: 5.6_

  - [ ]* 8.3 编写属性测试：设置页面展示所有 Trip 及必要信息
    - **Property 7: 设置页面展示所有 Trip 及必要信息**
    - **验证: 需求 5.1, 5.2**

  - [ ]* 8.4 编写 SettingsPage 单元测试
    - 测试切换控件触发 API 调用（需求 5.3）
    - 测试 API 成功后 UI 状态更新（需求 5.4）
    - 测试 API 失败后切换控件回滚并显示错误（需求 5.5）
    - 测试导航栏包含设置页入口（需求 5.6）
    - _需求: 5.3, 5.4, 5.5, 5.6_

- [x] 9. 属性测试：旅行列表完整性
  - [ ]* 9.1 编写属性测试：旅行列表包含所有 Trip
    - **Property 4: 旅行列表包含所有 Trip**
    - **验证: 需求 3.1**

- [x] 10. 最终检查点 - 全部功能验证
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 交付
- 每个任务引用了具体需求编号以确保可追溯性
- 检查点任务用于阶段性验证，确保增量开发的正确性
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
