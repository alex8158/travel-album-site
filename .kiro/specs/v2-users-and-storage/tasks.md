# 实施计划：V2 用户功能与素材存储介质

## 概述

按照后端优先、渐进式集成的方式实施。先搭建数据库和认证基础，再逐步添加用户管理、权限控制、存储抽象、标签系统，最后完成前端界面。每个阶段结束后设置检查点确保质量。

## 任务

- [x] 1. 基础设施：数据库迁移与认证服务
  - [x] 1.1 安装后端依赖并更新类型定义
    - 安装 `jsonwebtoken`、`bcrypt`、`@types/jsonwebtoken`、`@types/bcrypt` 到 server
    - 更新 `server/src/types.ts`，新增 `User` 接口和 `JwtPayload` 类型
    - _需求: 1.1, 1.2, 1.4_

  - [x] 1.2 数据库迁移：新增 users 表、media_tags 表，扩展 trips 和 media_items 表
    - 在 `server/src/database.ts` 的 `initTables` 中新增 `users` 表（id, username, password_hash, role, status, created_at, updated_at）
    - 新增 `media_tags` 表（id, media_id, tag_name, created_at）及索引
    - 为 `trips` 表添加 `user_id` 列（nullable，REFERENCES users(id)）
    - 为 `media_items` 表添加 `user_id` 列和 `visibility` 列（默认 'public'）
    - 更新 `MediaItemRow` 和 `TripRow` 类型以包含新字段
    - _需求: 1.2, 7.1, 7.2, 8.1, 12.3_

  - [x] 1.3 实现 AuthService
    - 创建 `server/src/services/authService.ts`
    - 实现 `hashPassword(plain)`：使用 bcrypt（cost factor 12）
    - 实现 `verifyPassword(plain, hash)`：bcrypt compare
    - 实现 `signToken(payload)`：JWT 签名，有效期 7 天
    - 实现 `verifyToken(token)`：JWT 验证，返回 JwtPayload
    - _需求: 1.4, 3.1, 3.5_

  - [ ]* 1.4 AuthService 属性测试
    - **Property 1: 密码哈希往返一致性**
    - **验证: 需求 1.4**

  - [x] 1.5 实现默认管理员创建与数据迁移
    - 在 `server/src/services/userService.ts` 中实现 `createDefaultAdmin()`
    - 在数据库初始化流程中调用，创建 username="admin" 的管理员用户
    - 将所有 `user_id IS NULL` 的 trips 和 media_items 分配给默认管理员
    - _需求: 1.1, 1.3, 7.3_

  - [ ]* 1.6 默认管理员属性测试
    - **Property 2: 默认管理员创建幂等性**
    - **验证: 需求 1.3**

  - [x] 1.7 实现认证中间件
    - 创建 `server/src/middleware/auth.ts`
    - 实现 `authMiddleware`：解析 JWT，设置 `req.user`，不强制要求
    - 实现 `requireAuth`：要求已登录，否则 401
    - 实现 `requireAdmin`：要求管理员角色，否则 403
    - 实现 `requireOwnership(resourceUserId)`：要求资源所有者或管理员
    - 扩展 Express Request 类型声明
    - _需求: 3.5, 6.4, 8.3, 9.3, 11.5_

  - [ ]* 1.8 认证中间件属性测试
    - **Property 12: 无效 Token 返回 401**
    - **Property 17: 管理员专属接口拒绝非管理员**
    - **验证: 需求 3.5, 6.4**

  - [x] 1.9 实现认证路由
    - 创建 `server/src/routes/auth.ts`
    - `POST /api/auth/login`：验证用户名密码，检查用户状态，返回 JWT
    - `POST /api/auth/register`：创建 pending 用户
    - 在 `server/src/index.ts` 中注册路由
    - _需求: 2.1, 3.1, 3.2, 3.3, 3.4_

  - [ ]* 1.10 登录与注册属性测试
    - **Property 3: 注册创建 pending 用户**
    - **Property 4: 重复用户名拒绝**
    - **Property 5: 无效注册输入拒绝**
    - **Property 8: 活跃用户登录返回有效 JWT**
    - **Property 9: 无效凭证返回 401**
    - **Property 10: Pending 用户登录返回 403**
    - **Property 11: Disabled 用户登录返回 403**
    - **验证: 需求 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4**

- [x] 2. 检查点 - 基础认证功能验证
  - 确保所有测试通过，ask the user if questions arise.

- [x] 3. 用户管理
  - [x] 3.1 实现 UserService 完整功能
    - 在 `server/src/services/userService.ts` 中补充：
    - `register(username, password)`：创建 pending 用户，校验用户名非空、密码 ≥ 6
    - `approveUser(userId)`：pending → active
    - `rejectUser(userId)`：pending → disabled
    - `changePassword(userId, oldPassword, newPassword)`：验证旧密码后更新
    - `resetPassword(userId, newPassword)`：管理员直接重置
    - `disableUser(userId)`：设置 disabled
    - `promoteToAdmin(userId)`：regular → admin
    - `listUsers()` / `listPendingUsers()` / `getUserById(userId)`
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 5.1, 6.1, 6.2, 6.3_

  - [ ]* 3.2 UserService 属性测试
    - **Property 6: 审批通过设置 active**
    - **Property 7: 审批拒绝设置 disabled**
    - **Property 13: 密码修改往返一致性**
    - **Property 14: 旧密码错误拒绝**
    - **Property 15: 用户自注销设置 disabled**
    - **Property 18: 管理员提升角色**
    - **验证: 需求 2.4, 2.5, 4.1, 4.2, 4.3, 5.1, 6.3**

  - [x] 3.3 实现管理员用户管理路由
    - 创建 `server/src/routes/admin.ts`
    - `GET /api/admin/users`：所有用户列表（requireAdmin）
    - `GET /api/admin/users/pending`：待审批用户列表
    - `PUT /api/admin/users/:id/approve`：审批通过
    - `PUT /api/admin/users/:id/reject`：审批拒绝
    - `PUT /api/admin/users/:id/promote`：提升为管理员
    - `PUT /api/admin/users/:id/password`：重置密码
    - `DELETE /api/admin/users/:id`：删除用户（设为 disabled）
    - 在 `server/src/index.ts` 中注册路由
    - _需求: 2.4, 2.5, 2.6, 6.1, 6.2, 6.3, 6.5_

  - [x] 3.4 实现密码管理与账户注销路由
    - 在 `server/src/routes/auth.ts` 中新增：
    - `PUT /api/auth/password`：修改自己密码（requireAuth）
    - `DELETE /api/auth/account`：注销自己账户（requireAuth）
    - _需求: 4.1, 4.2, 4.4, 5.1, 5.2, 5.3_

  - [ ]* 3.5 用户注销属性测试
    - **Property 16: 注销用户的公开相册仍可见**
    - **验证: 需求 5.2**

- [x] 4. 检查点 - 用户管理功能验证
  - 确保所有测试通过，ask the user if questions arise.

- [x] 5. 所有权与权限控制
  - [x] 5.1 改造 trips.ts 路由添加认证和所有权
    - `POST /api/trips`：添加 `requireAuth`，写入 `req.user.userId` 到 `user_id`
    - `PUT /api/trips/:id`：添加 `requireAuth`，校验所有者或管理员
    - `PUT /api/trips/:id/visibility`：添加 `requireAuth`，校验所有者或管理员
    - `PUT /api/trips/:id/cover`：添加 `requireAuth`，校验所有者或管理员
    - `GET /api/trips`（主页列表）：添加 `authMiddleware`，仅返回 visibility='public' 的相册
    - _需求: 7.1, 10.1, 10.3, 11.3_

  - [ ]* 5.2 所有权记录属性测试
    - **Property 19: 资源创建记录所有者**
    - **Property 26: 主页仅展示公开相册**
    - **验证: 需求 7.1, 10.1**

  - [x] 5.3 改造 media.ts 路由添加认证和所有权
    - `POST /api/trips/:id/media`：添加 `requireAuth`，写入 `req.user.userId` 到 `user_id`，设置默认 visibility='public'
    - _需求: 7.2, 8.1_

  - [ ]* 5.4 素材默认可见性属性测试
    - **Property 20: 素材默认可见性为 public**
    - **验证: 需求 8.1**

  - [x] 5.5 改造 gallery.ts 路由实现可见性过滤
    - `GET /api/trips/:id/gallery`：添加 `authMiddleware`
    - 公开访问：仅返回 visibility='public' 的素材
    - 所有者或管理员：返回所有素材
    - _需求: 10.2, 9.2, 9.4_

  - [ ]* 5.6 公开相册可见性过滤属性测试
    - **Property 27: 公开相册仅展示公开素材**
    - **验证: 需求 10.2**

  - [x] 5.7 改造 trash.ts 路由添加所有权检查
    - 所有 trash 操作添加 `requireAuth`
    - 删除操作校验所有者或管理员
    - _需求: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 5.8 删除权限属性测试
    - **Property 28: 授权删除相册级联 trash**
    - **Property 29: 授权删除素材设置 trashed**
    - **验证: 需求 11.1, 11.2, 11.3, 11.4**

  - [x] 5.9 新增素材可见性修改路由
    - 在 media 路由中新增 `PUT /api/media/:id/visibility`（requireAuth + 所有者/Admin）
    - 新增 `PUT /api/trips/:id/media/visibility`（批量修改，requireAuth + 所有者/Admin）
    - _需求: 8.2, 8.3, 8.4_

  - [ ]* 5.10 可见性修改属性测试
    - **Property 21: 所有者可修改素材可见性**
    - **Property 22: 批量修改可见性**
    - **验证: 需求 8.2, 8.4**

  - [x] 5.11 实现用户空间路由
    - 在 `server/src/routes/auth.ts` 或新建路由文件中新增：
    - `GET /api/users/me/trips`：返回当前用户所有相册（requireAuth）
    - `GET /api/users/me/trips/:id/gallery`：返回用户自己相册的所有素材
    - 管理员可通过 `GET /api/admin/users/:id/trips` 访问任意用户空间
    - _需求: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 5.12 用户空间属性测试
    - **Property 23: 用户空间返回所有个人相册**
    - **Property 24: 用户空间相册返回所有素材**
    - **Property 25: 管理员可访问任意用户空间**
    - **验证: 需求 9.1, 9.2, 9.4**

- [x] 6. 检查点 - 所有权与权限验证
  - 确保所有测试通过，ask the user if questions arise.

- [x] 7. 存储抽象层
  - [x] 7.1 定义 StorageProvider 接口与类型
    - 创建 `server/src/storage/types.ts`
    - 定义 `StorageProvider` 接口（save, read, delete, exists, getUrl, downloadToTemp）
    - 定义 `StorageType` 类型
    - _需求: 13.1_

  - [x] 7.2 实现 LocalStorageProvider
    - 创建 `server/src/storage/localProvider.ts`
    - 基于 `fs` 模块实现所有接口方法
    - `downloadToTemp` 对本地存储直接返回绝对路径（无需复制）
    - _需求: 13.2_

  - [ ]* 7.3 LocalStorageProvider 属性测试
    - **Property 33: LocalStorageProvider 存取往返一致性**
    - **验证: 需求 13.2**

  - [x] 7.4 实现 S3StorageProvider
    - 创建 `server/src/storage/s3Provider.ts`
    - 使用 `@aws-sdk/client-s3` SDK
    - 从环境变量读取 S3_BUCKET, S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
    - _需求: 13.3_

  - [x] 7.5 实现 OSSStorageProvider
    - 创建 `server/src/storage/ossProvider.ts`
    - 使用 `ali-oss` SDK
    - 从环境变量读取 OSS_BUCKET, OSS_REGION, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET
    - _需求: 13.4_

  - [x] 7.6 实现 COSStorageProvider
    - 创建 `server/src/storage/cosProvider.ts`
    - 使用 `cos-nodejs-sdk-v5` SDK
    - 从环境变量读取 COS_BUCKET, COS_REGION, COS_SECRET_ID, COS_SECRET_KEY
    - _需求: 13.5_

  - [x] 7.7 实现存储工厂
    - 创建 `server/src/storage/factory.ts`
    - 根据 `process.env.STORAGE_TYPE` 返回对应 Provider 实例
    - 默认 'local'，不支持的类型抛出明确错误
    - _需求: 13.6, 13.7_

  - [ ]* 7.8 存储工厂属性测试
    - **Property 34: 存储工厂正确性**
    - **验证: 需求 13.6, 13.7**

  - [x] 7.9 重构现有服务使用 StorageProvider
    - 修改 `media.ts`：文件上传使用 `storageProvider.save()`
    - 修改 `mediaServing.ts`：文件读取使用 `storageProvider.read()` / `downloadToTemp()`
    - 修改 `thumbnailGenerator.ts`：缩略图生成使用 `downloadToTemp()` + `save()`
    - 修改 `imageOptimizer.ts`：优化图片使用 `downloadToTemp()` + `save()`
    - 修改 `videoEditor.ts`：视频编辑使用 `downloadToTemp()` + `save()`
    - 修改 `videoAnalyzer.ts`：视频分析使用 `downloadToTemp()`
    - 修改 `coverSelector.ts`：封面提取使用 `downloadToTemp()`
    - 修改 `blurDetector.ts`：模糊检测使用 `downloadToTemp()`
    - 修改 `trash.ts`：文件删除使用 `storageProvider.delete()`
    - 确保数据库中存储的路径为存储提供者无关的相对路径
    - _需求: 14.1, 14.2, 14.3_

  - [ ]* 7.10 存储路径属性测试
    - **Property 35: 数据库存储提供者无关路径**
    - **验证: 需求 14.3**

- [x] 8. 检查点 - 存储抽象验证
  - 确保所有测试通过，ask the user if questions arise.

- [x] 9. 标签系统与存储迁移
  - [x] 9.1 实现 TagGenerator 服务
    - 创建 `server/src/services/tagGenerator.ts`
    - 实现 `generateTags(mediaId, tripTitle, mediaType, originalFilename, uploadDate)`
    - 生成标签：相册名称、YYYY-MM 日期、媒体类型、文件扩展名
    - 实现 `normalizeTagName(name)`：小写化 + 去空格
    - _需求: 12.1, 12.2, 12.5_

  - [ ]* 9.2 标签生成属性测试
    - **Property 30: 标签生成规则完整性**
    - **Property 31: 标签名称标准化**
    - **验证: 需求 12.1, 12.2, 12.5**

  - [x] 9.3 集成标签到素材上传流程
    - 在 `media.ts` 的上传路由中，上传成功后调用 `generateTags` 并写入 `media_tags` 表
    - _需求: 12.1_

  - [x] 9.4 实现标签筛选查询
    - 在 `gallery.ts` 中支持 `?tag=xxx` 查询参数
    - 通过 JOIN media_tags 表筛选素材
    - _需求: 12.4_

  - [ ]* 9.5 标签筛选属性测试
    - **Property 32: 标签筛选准确性**
    - **验证: 需求 12.4**

  - [x] 9.6 实现 MigrationTool 服务
    - 创建 `server/src/services/migrationTool.ts`
    - 实现 `migrateStorage(sourceProvider, targetProvider)`
    - 逐文件迁移，单个失败不影响整体
    - 返回 MigrationResult（successCount, failedCount, failedFiles）
    - _需求: 15.2, 15.3, 15.4, 15.5_

  - [ ]* 9.7 迁移工具属性测试
    - **Property 36: 迁移错误隔离与摘要不变量**
    - **Property 37: 相同存储类型迁移拒绝**
    - **验证: 需求 15.3, 15.4, 15.6**

  - [x] 9.8 实现迁移 API 路由
    - 在 `server/src/routes/admin.ts` 中新增：
    - `POST /api/admin/storage/migrate`：触发存储迁移（requireAdmin）
    - 校验目标类型与当前类型不同
    - _需求: 15.1, 15.6_

- [x] 10. 检查点 - 标签与迁移验证
  - 确保所有测试通过，ask the user if questions arise.

- [x] 11. 前端认证与用户界面
  - [x] 11.1 创建 AuthContext
    - 创建 `client/src/contexts/AuthContext.tsx`
    - 管理 token、user 状态，提供 login/logout/register 方法
    - 从 localStorage 恢复登录状态
    - 在 axios 请求拦截器中自动添加 Authorization 头
    - _需求: 16.3, 16.4_

  - [ ]* 11.2 AuthContext 属性测试
    - **Property 38: 登录/登出 Token 生命周期**
    - **验证: 需求 16.3, 16.4**

  - [x] 11.3 创建 ProtectedRoute 组件
    - 创建 `client/src/components/ProtectedRoute.tsx`
    - 未登录跳转 `/login`
    - 非 Admin 访问 admin 路由跳转 `/`
    - _需求: 17.4_

  - [ ]* 11.4 ProtectedRoute 属性测试
    - **Property 39: 非管理员无法访问管理后台**
    - **验证: 需求 17.4**

  - [x] 11.5 创建 LoginPage
    - 创建 `client/src/pages/LoginPage.tsx`
    - 包含用户名输入框、密码输入框、登录按钮
    - 登录成功后跳转主页
    - 显示错误信息（凭证错误、账户待审批、账户已禁用）
    - _需求: 16.1_

  - [x] 11.6 创建 RegisterPage
    - 创建 `client/src/pages/RegisterPage.tsx`
    - 包含用户名输入框、密码输入框、确认密码输入框、提交按钮
    - 注册成功后显示"等待管理员审批"提示
    - _需求: 16.2_

  - [x] 11.7 创建 UserSpacePage
    - 创建 `client/src/pages/UserSpacePage.tsx`
    - 展示当前用户的所有相册列表（含 public 和 private）
    - _需求: 16.7_

  - [x] 11.8 创建 AdminPage
    - 创建 `client/src/pages/AdminPage.tsx`
    - 用户管理区：用户列表、审批 pending 用户、删除用户、重置密码、提升管理员
    - 存储管理区：显示当前存储类型、迁移操作入口
    - _需求: 17.1, 17.2, 17.3_

  - [x] 11.9 改造 NavHeader 和路由配置
    - 修改 `client/src/App.tsx` 中的 `NavHeader`：
    - 未登录：显示「登录」「注册」按钮，隐藏「新建旅行」
    - 已登录普通用户：显示用户名、「我的空间」、「退出」、「新建旅行」
    - 已登录管理员：额外显示「管理后台」入口
    - 添加新路由：`/login`、`/register`、`/my`、`/admin`
    - 使用 ProtectedRoute 包装需要认证的路由
    - _需求: 10.4, 16.5, 16.6, 16.8_

  - [x] 11.10 改造 HomePage 仅展示公开相册
    - 修改 `client/src/pages/HomePage.tsx`
    - 确保主页请求不携带认证信息（或后端已过滤）
    - 未登录时隐藏创建相册等操作入口
    - _需求: 10.1, 10.3, 10.4_

  - [x] 11.11 改造 GalleryPage 适配所有权显示
    - 修改 `client/src/pages/GalleryPage.tsx`
    - 所有者或管理员可见编辑、追加素材、可见性切换等操作
    - 非所有者仅可查看公开素材
    - _需求: 9.2, 10.2_

  - [x] 11.12 改造 UploadPage 要求登录
    - 修改 `client/src/pages/UploadPage.tsx`
    - 使用 ProtectedRoute 包装，未登录跳转登录页
    - _需求: 10.4_

- [x] 12. 最终检查点 - 全功能验证
  - 确保所有测试通过，ask the user if questions arise.

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点确保每个阶段的增量验证
- 属性测试验证设计文档中定义的正确性属性
- 单元测试验证具体示例和边界情况
