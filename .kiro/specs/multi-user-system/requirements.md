# 需求文档：多用户系统

## 文档性质说明

本文档是**事后补写**（as-built）的需求文档。

多用户系统是本项目中唯一没有 spec 记录就已经实现的主要功能。主需求文档 `requirements.md` 第一部分曾把「多用户系统」列为"超出范围 / 后续版本规划"，但代码中实际已经落地。本文档的作用是把既有实现固化成可审查的验收标准，而不是描述一个待建的新功能。

因此：

- 下面每条验收标准描述的都是**当前代码已有的行为**，可以直接用来做回归测试的依据
- 文末「第二部分：已知缺口与不一致」记录的是实现中确实存在的问题，属于现状陈述，不是已批准的变更计划
- 与代码不符之处，以代码为准，并应回头修正本文档

事实来源（已逐一阅读）：

- 后端：`server/src/database.ts`、`server/src/types.ts`、`server/src/middleware/auth.ts`、`server/src/middleware/errorHandler.ts`、`server/src/services/authService.ts`、`server/src/services/userService.ts`、`server/src/routes/auth.ts`、`server/src/routes/admin.ts`、`server/src/routes/users.ts`、`server/src/routes/my.ts`、`server/src/routes/trips.ts`、`server/src/routes/gallery.ts`
- 前端：`client/src/App.tsx`、`client/src/contexts/AuthContext.tsx`、`client/src/components/ProtectedRoute.tsx`、`client/src/pages/LoginPage.tsx`、`client/src/pages/RegisterPage.tsx`、`client/src/pages/UserSpacePage.tsx`、`client/src/pages/AdminPage.tsx`

## 简介

多用户系统为旅行相册提供账户、会话、角色与资源归属能力。核心特征是**邀请/审批制**：任何人都可以提交注册申请，但账户默认处于待审批状态，必须由管理员批准后才能登录。系统内置一个用户名为 `admin` 的默认管理员账户，在数据库初始化时自动创建。

会话采用无状态 JWT。资源归属通过 `trips.user_id` 与 `media_items.user_id` 表达，所有写操作遵循"资源所有者或管理员"规则。未登录访问者可以浏览公开内容。

## 术语表

- **User**：`users` 表中的一条账户记录
- **Role**：账户角色，取值 `admin` 或 `regular`（注意：不是 `user`）
- **Status**：账户状态，取值 `pending`、`active`、`disabled`
- **Default_Admin**：数据库初始化时自动创建的用户名为 `admin` 的管理员账户
- **JWT_Token**：登录成功后签发的无状态令牌，载荷为 `{ userId, role }`
- **Auth_Middleware**：`authMiddleware`，解析令牌但不拒绝无令牌请求（可选登录）
- **Require_Auth**：`requireAuth`，强制要求已认证
- **Require_Admin**：`requireAdmin`，强制要求管理员角色
- **Require_Ownership**：`requireOwnership(getResourceUserId)`，工厂函数，生成"所有者或管理员"校验中间件
- **Owner_Or_Admin_Rule**：判定式 `role === 'admin' || userId === resource.user_id`
- **Personal_Scope**：`/api/my/*` 与 `/api/users/me/*` 前缀，表示当前登录用户自己的资源范围
- **Admin_Scope**：`/api/admin/*` 前缀，仅管理员可访问
- **Error_Envelope**：统一错误响应结构 `{ error: { code, message } }`
- **Orphan_Data_Migration**：`migrateOrphanedData()`，启动时把 `user_id` 为 NULL 的 trips 与 media_items 归属给 Default_Admin
- **Trip_Visibility**：`trips.visibility`，取值 `public` 或 `unlisted`。它是**可发现性（discovery）控制**，不是访问控制 —— 两个取值都允许持有直接链接的访问者访问，区别只在于是否出现在公开列表中。素材层面的访问控制由 `media_items.visibility` 独立负责（见需求 9 AC 4、AC 8），本术语不涉及其含义
- **Public_Trip**：`visibility = 'public'` 的旅行。出现在公开列表，且可通过直接链接访问
- **Unlisted_Trip**：`visibility = 'unlisted'` 的旅行。**不**出现在公开列表，但**仍可**通过直接链接访问。它不是 owner-only 或完全私有状态
- **Derived_Artifact**：由一个或多个 media 生成、且其内容已不可逆地烘入产物的文件。包括 tier slideshow 视频、photo slideshow 视频、merged 视频。判定要点是**不可逆**：产物生成后无法再按单条 source 的可见性过滤其内容。与之相对，`media_items.optimized_path` / `thumbnail_path` / `compiled_path` / `preview_proxy_path` **不是** Derived_Artifact —— 它们是同一 media 自身的不同表示，与 source 共享同一 `media_items` 行，可见性天然一致
- **Artifact_Provenance**：某个 Derived_Artifact 与其全部 source media 之间的持久化映射。`merged_video_sources` 是目前唯一已实现的例子；tier slideshow 没有（见 G-20）

---

# 第一部分：已实现行为

## 需求 1：用户数据模型

**用户故事：** 作为开发者，我需要一个明确的账户数据结构，以便账户状态与角色的判断在各处保持一致。

### 验收标准

1. THE 系统 SHALL 在 `users` 表中存储账户，字段为：`id TEXT PRIMARY KEY`、`username TEXT NOT NULL UNIQUE`、`password_hash TEXT NOT NULL`、`role TEXT NOT NULL DEFAULT 'regular'`、`status TEXT NOT NULL DEFAULT 'pending'`、`created_at TEXT NOT NULL`、`updated_at TEXT NOT NULL`
2. THE 系统 SHALL 限定 Role 取值为 `admin` 或 `regular`
3. THE 系统 SHALL 限定 Status 取值为 `pending`、`active` 或 `disabled`
4. THE 系统 SHALL 通过 `ALTER TABLE trips ADD COLUMN user_id TEXT REFERENCES users(id)` 表达旅行归属
5. THE 系统 SHALL 通过 `ALTER TABLE media_items ADD COLUMN user_id TEXT REFERENCES users(id)` 表达素材归属
6. THE 系统 SHALL 把用户级配置与用量记录关联到账户：`ai_usage_records.user_id`、`ai_budget_configs.user_id`（UNIQUE）、`audio_tracks.user_id`、`slideshow_jobs.user_id`（`ON DELETE CASCADE`）
7. THE 系统 SHALL 用 `audio_tracks.user_id = 'system'` 标识系统内置音频，而非关联到真实账户
8. THE 系统 SHALL 在 `database.ts` 的 `initTables()` 中以 `CREATE TABLE IF NOT EXISTS` 加 try/catch 包裹的 `ALTER TABLE` 方式完成建表与迁移，不使用独立迁移文件

## 需求 2：注册与管理员审批

**用户故事：** 作为站点管理员，我希望新用户注册后不能立即登录，以便我控制谁可以使用这个站点。

### 验收标准

1. THE 系统 SHALL 暴露 `POST /api/auth/register` 为公开接口，请求体为 `{ username, password }`
2. WHEN `username` 缺失、非字符串或去空格后为空字符串时, THE 系统 SHALL 返回 400，错误码 `VALIDATION_ERROR`
3. WHEN `password` 缺失、非字符串或长度小于 6 时, THE 系统 SHALL 返回 400，错误码 `VALIDATION_ERROR`
4. WHEN `username` 已存在时, THE 系统 SHALL 返回 409，错误码 `USERNAME_TAKEN`
5. THE 系统 SHALL 用 bcrypt 哈希密码，salt rounds 为 12
6. THE 系统 SHALL 以 `role = 'regular'`、`status = 'pending'` 写入新账户
7. THE 系统 SHALL 去除 `username` 首尾空格后再存储
8. WHEN 注册成功时, THE 系统 SHALL 返回 201 与 `{ message, user: { id, username, status: 'pending' } }`，且**不签发令牌、不自动登录**
9. THE 系统 SHALL NOT 提供任何"首个注册用户自动成为管理员"的逻辑
10. THE 前端 RegisterPage SHALL 在注册成功后展示"等待管理员审批"的提示界面，而非跳转到已登录状态

## 需求 3：登录与会话签发

**用户故事：** 作为已获批准的用户，我希望用用户名和密码登录并获得可用于后续请求的凭证。

### 验收标准

1. THE 系统 SHALL 暴露 `POST /api/auth/login` 为公开接口，请求体为 `{ username, password }`
2. WHEN 用户名不存在时, THE 系统 SHALL 返回 401，错误码 `INVALID_CREDENTIALS`
3. WHEN 账户 `status = 'pending'` 时, THE 系统 SHALL 返回 403，错误码 `ACCOUNT_PENDING`
4. WHEN 账户 `status = 'disabled'` 时, THE 系统 SHALL 返回 403，错误码 `ACCOUNT_DISABLED`
5. WHEN 密码比对失败时, THE 系统 SHALL 返回 401，错误码 `INVALID_CREDENTIALS`
6. WHEN 登录成功时, THE 系统 SHALL 返回 200 与 `{ token, user: { id, username, role } }`
7. THE 系统 SHALL 签发载荷为 `{ userId, role }` 的 JWT，有效期 7 天（`JWT_EXPIRES_IN = '7d'`）
8. THE 系统 SHALL 按以下优先级解析签名密钥：环境变量 `JWT_SECRET` 优先
9. IF `NODE_ENV = production` 且 `JWT_SECRET` 未设置, THEN THE 系统 SHALL 输出致命错误日志并以 `process.exit(1)` 终止启动
10. IF 非生产环境且 `JWT_SECRET` 未设置, THEN THE 系统 SHALL 读取 `server/data/.jwt-secret`；文件不存在时生成 32 字节随机密钥并以 `0600` 权限持久化
11. THE 系统 SHALL 仅在登录时校验账户 Status；令牌签发后其有效性不再受 Status 变化影响（见缺口 G-2）

## 需求 4：会话校验中间件

**用户故事：** 作为开发者，我需要可复用的中间件来区分"公开可读"、"必须登录"和"必须是管理员"三种路由。

### 验收标准

1. THE Auth_Middleware SHALL 从 `Authorization: Bearer <token>` 请求头解析令牌，校验通过后设置 `req.user = { userId, role }`
2. WHEN 请求头缺失或不以 `Bearer ` 开头时, THE Auth_Middleware SHALL 直接放行，`req.user` 保持未设置
3. WHEN 令牌校验失败时, THE Auth_Middleware SHALL 静默放行，`req.user` 保持未设置，不返回错误
4. WHEN `req.user` 未设置时, THE Require_Auth SHALL 返回 401 与 `{ error: { code: 'TOKEN_INVALID', message: '请先登录' } }`
5. WHEN `req.user` 未设置时, THE Require_Admin SHALL 返回 401，错误码 `TOKEN_INVALID`
6. WHEN `req.user.role !== 'admin'` 时, THE Require_Admin SHALL 返回 403 与 `{ error: { code: 'FORBIDDEN', message: '需要管理员权限' } }`
7. THE Require_Ownership SHALL 接收一个 `(req) => string | undefined` 取值函数，在 `role === 'admin'` 或 `userId === resourceUserId` 时放行
8. WHEN Require_Ownership 判定不通过时, THE 系统 SHALL 返回 403 与 `{ error: { code: 'FORBIDDEN', message: '无权操作此资源' } }`
9. THE 系统 SHALL 通过 Express 的 `Request` 类型扩展声明 `user?: { userId: string; role: 'admin' | 'regular' }`

## 需求 5：管理员用户管理

**用户故事：** 作为管理员，我需要审批注册申请并管理已有账户。

### 验收标准

1. THE 系统 SHALL 在 `/api/admin` 路由上统一应用 Auth_Middleware，并对每条路由单独应用 Require_Admin
2. THE 系统 SHALL 暴露 `GET /api/admin/users` 返回全部账户
3. THE 系统 SHALL 暴露 `GET /api/admin/users/pending` 返回 `status = 'pending'` 的账户
4. THE 系统 SHALL 暴露 `PUT /api/admin/users/:id/approve`，把账户 Status 置为 `active`
5. THE 系统 SHALL 暴露 `PUT /api/admin/users/:id/reject`，把账户 Status 置为 `disabled`
6. WHEN 审批或拒绝的目标账户 Status 不是 `pending` 时, THE 系统 SHALL 返回 400，错误码 `INVALID_STATUS`
7. WHEN 目标账户不存在时, THE 系统 SHALL 返回 404，错误码 `NOT_FOUND`
8. THE 系统 SHALL 暴露 `PUT /api/admin/users/:id/promote`，把账户 Role 置为 `admin`
9. THE 系统 SHALL 暴露 `PUT /api/admin/users/:id/password`，请求体 `{ password }`，用于重置任意账户密码（不需要旧密码）
10. THE 系统 SHALL 暴露 `DELETE /api/admin/users/:id`，其行为是把 Status 置为 `disabled`，**不删除数据行**
11. THE 系统 SHALL 暴露 `GET /api/admin/users/:id/trips`，返回指定用户的全部旅行及素材计数
12. THE 系统 SHALL 暴露 `GET /api/admin/storage/status` 与 `POST /api/admin/storage/migrate` 用于存储后端查看与迁移
13. THE 系统 SHALL 在所有涉密码的管理操作中沿用长度不少于 6 的校验规则

## 需求 6：启动期默认数据

**用户故事：** 作为部署者，我需要系统在空数据库上启动后就有一个可登录的管理员账户。

### 验收标准

1. WHEN 数据库中不存在用户名为 `admin` 的账户时, THE `createDefaultAdmin()` SHALL 创建该账户，`role = 'admin'`、`status = 'active'`
2. THE 系统 SHALL 使用源码中的常量 `DEFAULT_ADMIN_PASSWORD`（位于 `server/src/services/userService.ts`）作为 Default_Admin 的初始密码
3. WHEN 用户名为 `admin` 的账户已存在时, THE `createDefaultAdmin()` SHALL 直接返回，不做任何修改
4. THE `migrateOrphanedData()` SHALL 把 `trips.user_id IS NULL` 与 `media_items.user_id IS NULL` 的记录归属给 Default_Admin
5. THE `initDefaultData()` SHALL 依次执行 `createDefaultAdmin()` 与 `migrateOrphanedData()`，并由 `getDb()` 在 `initTables()` 之后调用
6. THE 系统 SHALL NOT 强制 Default_Admin 在首次登录时修改密码（见缺口 G-4）

## 需求 7：资源归属与所有权校验

**用户故事：** 作为用户，我希望只有我自己（或管理员）能修改我的旅行和素材。

### 验收标准

1. WHEN 用户创建旅行（`POST /api/trips`）时, THE 系统 SHALL 要求已登录，并把 `trips.user_id` 设为 `req.user.userId`
2. THE 系统 SHALL 把新建旅行的 `visibility` 初始化为 `public`
3. THE 系统 SHALL 对 `PUT /api/trips/:id`、`PUT /api/trips/:id/visibility`、`PUT /api/trips/:id/cover`、`DELETE /api/trips/:id` 应用 Require_Auth 并执行 Owner_Or_Admin_Rule
4. WHEN Owner_Or_Admin_Rule 不通过时, THE 系统 SHALL 返回 403，错误码 `FORBIDDEN`
5. WHEN 目标旅行不存在时, THE 系统 SHALL 返回 404，错误码 `NOT_FOUND`
6. THE 系统 SHALL 在素材与回收站相关路由（`routes/media.ts`、`routes/trash.ts`）中同样执行 Owner_Or_Admin_Rule 并使用 `FORBIDDEN` 错误码
7. THE 系统 SHALL 统一以 `FORBIDDEN` 作为越权访问的错误码（不区分资源类型）

## 需求 8：个人空间接口

**用户故事：** 作为用户，我需要看到自己的全部旅行，包括未公开的内容。

### 验收标准

1. THE 系统 SHALL 在 `/api/users` 路由上统一应用 `authMiddleware` 与 `requireAuth`
2. THE 系统 SHALL 在 `/api/my` 路由上统一应用 `authMiddleware` 与 `requireAuth`
3. THE 系统 SHALL 暴露 `GET /api/users/me/trips` 返回当前用户的全部旅行（不按 visibility 过滤），按 `created_at DESC` 排序，并附带 active 素材计数
4. THE 系统 SHALL 暴露 `GET /api/users/me/trips/:id/gallery` 返回自有旅行的全部素材，**不应用任何可见性过滤**
5. WHEN 请求 `GET /api/users/me/trips/:id/gallery` 的用户既非所有者也非管理员时, THE 系统 SHALL 返回 403，错误码 `FORBIDDEN`
6. THE 系统 SHALL 在 `/api/my` 前缀下暴露 `GET /api/my/trips`、`GET /api/my/trips/:id/gallery`、`GET /api/my/trips/:id/tier-photos`、`GET /api/my/trips/:id/highlight-pool`、`PUT|DELETE /api/my/trips/:id/tier-photos/:photoId`、`POST /api/my/trips/:id/tier-slideshow/regenerate`
7. THE Personal_Scope 接口 SHALL 以 `req.user.userId` 而非请求参数确定数据范围

## 需求 9：公开访问与可见性过滤

**用户故事：** 作为未登录的访问者，我希望能浏览公开的旅行相册。

### 验收标准

1. THE 系统 SHALL 允许未登录访问者调用 `GET /api/trips`，并且 SQL 层固定过滤 `WHERE t.visibility = 'public'`
2. THE 系统 SHALL 对 `GET /api/trips` 应用 Auth_Middleware 但不因未登录而拒绝
3. THE 系统 SHALL 允许未登录访问者调用 `GET /api/trips/:id/gallery`
4. WHEN 请求者不是所有者也不是管理员时, THE 系统 SHALL 对素材查询追加 `AND m.visibility = 'public'`
5. WHEN 请求者是所有者或管理员时, THE 系统 SHALL 不追加素材可见性过滤
6. THE 系统 SHALL 在公开视频查询中额外要求 `compiled_path IS NOT NULL OR media_source = 'merged'`，即公开画廊只呈现剪辑后或合并后的视频
7. THE 系统 SHALL 限定 `trips.visibility` 的可写取值为 `public` 与 `unlisted`，非法值返回 400，错误码 `INVALID_VISIBILITY`
8. THE 系统 SHALL 限定 `media_items.visibility` 的可写取值为 `public` 与 `private`
9. THE 系统 SHALL 把 Trip_Visibility 视为可发现性控制而非访问控制：Public_Trip 既可从公开列表发现也可通过直接链接访问；Unlisted_Trip 不可从公开列表发现但可通过直接链接访问。公开列表的过滤由 AC 1 实现
10. WHEN 访问者持有 trip id 或直接链接时, THE 系统 SHALL 允许未认证访问该旅行的公开分享面，且 SHALL NOT 因 `trips.visibility = 'unlisted'` 而拒绝。公开分享面包含 `GET /api/trips/:id` 与 `GET /api/trips/:id/gallery`；后者对匿名与非所有者请求者暴露哪些素材，仍完全由 AC 4 与 AC 6 的既有策略决定，本条不改变之
11. WHEN 旅行的 `visibility` 由 `public` 改为 `unlisted` 时, THE 系统 SHALL 使其从公开列表消失，且 SHALL NOT 使既有直接链接失效

> **AC 9–11 的性质**：这三条是 2026-09-02 对 Trip_Visibility 语义的正式裁定，用于把既有实现固化为可测试契约，**不引入任何行为变更**。此前 `unlisted` 的访问语义在本文档中从未定义，只有 AC 7 约束了可写取值，导致 G-6 被误判为越权缺陷（见第二部分 G-6）。裁定依据是 AC 1、AC 3、AC 4 与 `routes/gallery.ts` 的既有行为：`GET /api/trips/:id/gallery` 一直对任意 trip 返回 trip metadata 并按素材可见性过滤素材，若 `unlisted` 意为完全私有，AC 3 这条 SHALL 将自相矛盾。

12. WHEN 请求者既不是所有者也不是管理员时（即 AC 4 所指的请求者）, THE 系统 SHALL 仅在 Derived_Artifact 的**每一条** source media 均满足 AC 4 曝光条件时才向其曝光该产物：单条 source 为 `private` 即足以使整个产物对该请求者不可曝光。`is_highlight` / `is_highlight_tier` / 产物文件已存在于磁盘，均不构成对本条的 override。所有者与管理员按 AC 5 不受本条限制；本条不改变其既有访问
13. WHEN 某条 source media 的 `visibility` 由 `public` 改为 `private`，或其 `status` 变为 `trashed`，或该 media 被永久删除时, THE 系统 SHALL 使依赖它的既有 Derived_Artifact 不再向 AC 12 所指的请求者曝光。本条规定的是结果，不规定机制：重新生成、删除、标记失效，或在每次请求时按当前状态拒绝，均可满足本条
14. THE 系统 SHALL 使 AC 12 与 AC 13 可被验证地成立：
    - 向 AC 12 所指请求者的曝光判定 SHALL 依据完整、可验证的 Artifact_Provenance 与各 source 的**当前**状态
    - provenance 缺失、不完整、任一 source 已不存在，或删除映射后剩下空 source 集合，SHALL 一律视为**不可曝光**，不得解释为可曝光
    - source 状态变更后，依赖它的既有产物 SHALL 停止任何不再被 AC 12 允许的曝光

    职责划分：**判定**（给定请求与当前状态，产物此刻是否可曝光）由每次请求的 runtime access check 承担；**生命周期处理**（产物在 source 变更后是否重新生成、删除或标记失效）属实现方案，本条不强制。只要上述三项结果成立，单一机制即可满足本条，本条不要求设立两套独立机制。AC 12/13 的可判定性以 Artifact_Provenance 存在为前置条件

> **AC 12–14 的性质**：这三条是 2026-09-10 对 Derived_Artifact 可见性的正式裁定，**与 AC 9–11 不同，它们描述的是目标契约而非既有行为**。当前实现不满足：tier slideshow 没有 Artifact_Provenance，因而 AC 12/13 对它在技术上不可判定（G-20）；`mergeEngine` 把 merged 视频的 `visibility` 硬编码为 `'public'` 且不校验 source 可见性，直接违反 AC 12（G-20 附注）；`mediaServing` 三条路由不执行任何 access control，使 AC 12 在该表面被完全绕过（G-21）。登记这些偏差正是本次裁定的目的：在此之前「派生产物应继承什么」在全仓没有任何 owner，缺陷因此无法被表述为缺陷。本裁定不授权任何实现改动，AC 12–14 的落地需先满足 G-20 的 provenance 前置项。
>
> 本裁定的范围边界：AC 12 约束的是**曝光**，不是生成。生成时是否应排除 private source 属产品决策，未在此裁定。tier slideshow **文件读取**当前依赖 trip-level gate，那是在 provenance 缺失下的粗粒度代理，不是本 AC 的实现，亦不满足本 AC。
>
> AC 12–14 只裁定 **media 维度**。产物读取的 **trip visibility 维度**未在此裁定：本需求 AC 9 把 Trip_Visibility 定为可发现性而非访问控制，但 `highlight-tier` 需求 8 AC 3 的 2026-09-09 更正说明与 design Property 10b 明确把 tier slideshow 文件服务排除在直链放开之外，并写明「pending a separate decision」。因此 provenance 落地后，`unlisted` trip 的 tier slideshow 能否向持直链的匿名或非所有者请求者曝光，仍是一项**独立的待裁定事项**，AC 12–14 不得被引用为其依据。
>
> **2026-09-21 更新**：上述待裁定事项已由 AC 15 裁定。上段保留为裁定前的记录，不改写。

15. WHEN AC 4 所指的请求者请求某 trip 的 tier slideshow 时（无论是通过列表响应中的 URL，还是直接请求文件）, THE 系统 SHALL 对 `public` 与 `unlisted` 两种 Trip_Visibility 适用**同一**判定，仅当以下条件全部成立时才曝光该产物：
    - 该产物具有完整且非空的 Artifact_Provenance
    - 每一条 source media 当前存在、属于该 trip，且满足 AC 12–14
    - 产物文件存在

    任一条件不成立时，列表响应 SHALL NOT 包含该产物的 URL，直接文件请求 SHALL 返回 404。列表与文件请求**各自独立**执行上述判定：文件请求 SHALL NOT 以「该 URL 曾由列表返回」作为放行依据。`unlisted` trip 的产物可经直链取得，但其 URL SHALL NOT 出现在任何公开发现面（AC 1、AC 9）。匿名请求者与已登录的普通非所有者适用同一规则；所有者与管理员按 AC 5 保持既有权限。本条只对 AC 7 允许的两个 Trip_Visibility 取值授予曝光 —— `trips.visibility` 不存在 `private` 取值；若数据中出现 AC 7 以外的取值（数据库无 CHECK 约束，见 G-13），本条不授予任何曝光

> **AC 15 的性质**：2026-09-21 对 tier slideshow 读取的 trip visibility 维度所作的正式裁定，与 AC 12–14 同属**目标契约**，当前实现不满足。不满足的方向因 trip 而异：
>
> - **unlisted trip**：现状**比目标更严**。非所有者拿到的 `slideshowUrls` 恒为 `{}`，两条文件路由恒为 404。这是 provenance 缺失期间的**过渡 gate**，不是本条的最终行为。在 G-20 的 provenance 落地并通过本条判定之前，SHALL NOT 移除该 gate。
> - **public trip**：现状**比目标更宽**。文件只经 trip-level gate 即可曝光，未做任何 provenance 判定（G-20 的 stale exposure 路径即出于此）。
>
> 本条不授权任何实现改动。
>
> **2026-10-06 状态更新（C1）**：上面两条描述的是 C1 之前的现状，保留不改。C1 之后，对 AC 4 请求者，public 与 unlisted 两种 trip 都处于**同一个 fail-closed 过渡状态**：`GET /api/trips/:id/tier-photos` 返回 `slideshowUrls: {}`，`/api/trips/:id/tier-slideshow/:category/:filename` 与 legacy `/api/trips/:id/tier-slideshow/:filename` 都返回 404。所有者与管理员不变（AC 5），客户端改为携带 Authorization 取回文件字节后播放。这个状态比本条更严，仍不是本条的实现：G-20 的 provenance 落地并通过本条判定之前，SHALL NOT 放开。
>
> 这一过渡状态**只覆盖 `/api` 路由**。同一批文件仍可经 `/uploads` 静态路由按路径匿名读取（G-22），因此不得据此声称 tier slideshow 文件已对 AC 4 请求者不可读。
>
> **2026-10-06 更新（G-22）**：应用层的 `/uploads` 现已对所有人拒绝 `tier-slideshow/` 路径，上段所说的按路径读取在应用层已关闭。线上部署配置未核实，G-20 仍未完成。

## 需求 10：密码与账户自服务

**用户故事：** 作为用户，我希望能修改自己的密码，也能注销账户。

### 验收标准

1. THE 系统 SHALL 暴露 `PUT /api/auth/password`（需登录），请求体 `{ oldPassword, newPassword }`
2. WHEN `newPassword` 长度小于 6 时, THE 系统 SHALL 返回 400，错误码 `VALIDATION_ERROR`
3. WHEN `oldPassword` 与现有哈希不匹配时, THE 系统 SHALL 返回 400，错误码 `WRONG_PASSWORD`
4. WHEN 修改成功时, THE 系统 SHALL 更新 `password_hash` 与 `updated_at`
5. THE 系统 SHALL 暴露 `DELETE /api/auth/account`（需登录），其行为是调用 `disableUser()` 把自身 Status 置为 `disabled`
6. THE 系统 SHALL NOT 在账户注销时删除该用户的账户行、旅行或素材
7. THE 系统 SHALL NOT 提供任何基于邮箱的密码找回途径；忘记密码只能由管理员通过 `PUT /api/admin/users/:id/password` 重置

## 需求 11：前端登录态与路由保护

**用户故事：** 作为用户，我希望刷新页面后仍保持登录，并且未登录时访问受限页面会被引导到登录页。

### 验收标准

1. THE AuthContext SHALL 把令牌存入 `localStorage` 的 `auth_token` 键，用户名存入 `auth_username` 键
2. THE AuthContext SHALL 在客户端用 `atob` 解码 JWT 载荷以取得 `userId` 与 `role`，**不校验签名**
3. WHEN 解码失败或 `payload.exp * 1000 < Date.now()` 时, THE AuthContext SHALL 清除 localStorage 中的凭证并置为未登录
4. THE AuthContext SHALL 导出 `authFetch()`，自动附加 `Authorization: Bearer <token>` 请求头
5. THE AuthContext 的 `logout()` SHALL 仅清除 localStorage 与内存状态，不调用任何后端接口
6. WHEN 用户未登录时, THE ProtectedRoute SHALL 重定向到 `/login`
7. WHEN `requireAdmin` 为真且 `user.role !== 'admin'` 时, THE ProtectedRoute SHALL 重定向到 `/`
8. THE App SHALL 用 ProtectedRoute 包裹 `/upload`、`/my`、`/my/trips/:id`，并用 `ProtectedRoute requireAdmin` 包裹 `/admin`、`/admin/users/:userId/trips`
9. THE App SHALL 保持 `/`、`/trips/:id`、`/login`、`/register` 为公开路由
10. THE 前端角色判断 SHALL 仅用于界面呈现；真正的权限边界由后端 Require_Admin 保证
11. THE LoginPage SHALL 支持 `?returnTo=` 参数；当 `returnTo` 形如 `/trips/:id` 且当前用户是该旅行的所有者或管理员时，SHALL 改为跳转 `/my/trips/:id`

## 需求 12：统一错误响应约定

**用户故事：** 作为前端开发者，我需要一致的错误结构以便统一处理。

### 验收标准

1. THE 系统 SHALL 以 `{ error: { code, message } }` 作为所有错误响应的结构
2. THE 系统 SHALL 通过 `AppError(status, code, message)` 与 `globalErrorHandler` 产出该结构
3. WHEN 抛出未预期的异常时, THE 系统 SHALL 返回 500 与错误码 `INTERNAL_SERVER_ERROR`
4. THE 系统 SHALL 使用以下认证与权限相关错误码：`VALIDATION_ERROR`、`USERNAME_TAKEN`、`INVALID_CREDENTIALS`、`ACCOUNT_PENDING`、`ACCOUNT_DISABLED`、`TOKEN_INVALID`、`FORBIDDEN`、`NOT_FOUND`、`INVALID_STATUS`、`WRONG_PASSWORD`

## 需求 13：现有测试覆盖

**用户故事：** 作为维护者，我需要知道这套系统目前哪些行为已被测试固定。

### 验收标准

1. THE 系统 SHALL 在 `server/src/routes/auth.test.ts` 覆盖登录、注册、改密码、注销账户
2. THE 系统 SHALL 在 `server/src/middleware/auth.test.ts` 覆盖 `authMiddleware`、`requireAuth`、`requireAdmin`、`requireOwnership`
3. THE 系统 SHALL 在 `server/src/services/userService.test.ts` 覆盖 register、approveUser、rejectUser、changePassword、resetPassword、disableUser、promoteToAdmin、listUsers、listPendingUsers、getUserById
4. THE 系统 SHALL 在 `server/src/routes/users.test.ts` 覆盖 `GET /api/users/me/trips`、`GET /api/users/me/trips/:id/gallery`、`GET /api/admin/users/:id/trips`
5. THE 系统 SHALL 在 `routes/trips.test.ts`、`media.test.ts`、`trash.test.ts`、`gallery.test.ts` 中附带覆盖越权 403 行为
6. THE 客户端 SHALL 目前**没有**针对 AuthContext 与 ProtectedRoute 的专门测试
7. THE 系统 SHALL 在 `routes/trips.test.ts` 与 `routes/gallery.test.ts` 中覆盖需求 9 AC 9–11 的 Trip_Visibility 契约：Unlisted_Trip 对匿名访问者仍可经直接 id 读取元数据与画廊、公开列表不含 Unlisted_Trip、`public → unlisted` 切换后直链仍有效、且 Unlisted_Trip 的素材暴露仍只由素材可见性策略决定

---

# 第二部分：已知缺口与不一致

以下条目是阅读代码时确认的现状问题，**不是**已批准的变更计划。修改任何一条都涉及认证、权限或数据库行为，属于高风险改动，需要单独立项并获得批准。

## 安全相关

**G-1 客户端不校验令牌签名**
`AuthContext.decodeJwtPayload()` 用 `atob` 解码载荷并信任其中的 `role`。这只影响界面呈现，后端 `requireAdmin` 仍是真实边界，但意味着本地伪造令牌可以让前端显示管理员入口。

**G-2 令牌无法撤销，Status 变更不即时生效**
JWT 有效期 7 天，没有刷新机制、黑名单或版本号。账户被 `disabled`、被 `reject`、或用户主动注销后，已签发的令牌在到期前仍然可用，因为 Status 只在登录时检查。

**G-3 没有服务端登出接口**
`logout()` 只清 localStorage。同一令牌若已被复制到别处仍然有效。

**G-4 默认管理员密码硬编码在源码中且不强制修改**
`DEFAULT_ADMIN_PASSWORD` 是 `server/src/services/userService.ts` 里的字符串常量，会进入版本库与构建产物；首次登录后也没有强制改密流程。

**G-5 登录无速率限制与失败锁定**
`POST /api/auth/login` 没有任何节流、验证码或连续失败锁定，可被暴力枚举。

**G-6 `GET /api/trips/:id` 完全没有鉴权 —— 已裁定：非缺陷（ADJUDICATED / NOT A DEFECT，2026-09-02）**

**原观察（保留原文）**：该路由既未挂载 `authMiddleware` 也不检查 `visibility`，任何人凭 id 就能读取任意旅行的元数据（含 `unlisted`）。

**为何此前看起来像风险**：本文档当时没有任何条款定义 `unlisted` 的访问语义（AC 7 只约束可写取值），而前端可见性开关的文案是「公开 / **不公开**」（`client/src/pages/UploadPage.tsx`），容易读成"仅自己可访问"。在这个空缺下，「匿名可读 unlisted 元数据」被记为越权读取，并列入 P0。

**本次裁定**：`unlisted` 的正式语义是 **link-accessible** —— 不可从公开列表发现，但持有直接链接者可访问。据此，匿名读取 Unlisted_Trip 的元数据是**预期设计**，不是越权。裁定已固化为需求 9 AC 9–11 与术语表的 Trip_Visibility / Public_Trip / Unlisted_Trip 条目。

**决定性依据**：`GET /api/trips/:id/gallery`（需求 9 AC 3 明文 SHALL 允许未登录调用）在 `routes/gallery.ts` 中对 trip visibility 零门槛，一直向匿名调用者返回与 `GET /api/trips/:id` **完全相同**的 `rowToTrip()` 字段集。因此单独给 `GET /api/trips/:id` 加鉴权既无法消除所谓泄露，又会与 AC 3 冲突；而"完全私有"解读会使 AC 3 自相矛盾。

**当前状态**：无需修改生产代码。`GET /api/trips/:id` 与 `GET /api/trips/:id/gallery` 均**不应**因 `visibility = 'unlisted'` 拒绝匿名访问。已补契约测试防止未来误把 `unlisted` 当作私有（见需求 13 AC 7）。

**衍生的独立事项**：本次审计中发现匿名响应包含 `userId`，超出 `GET /api/trips` 的 `TripSummary` 契约字段集。这与 `unlisted` 是否允许匿名访问是两个不同问题，单独登记为 G-18，未在本次处理。

**G-7 `/settings` 前端路由未受保护**
`App.tsx` 中 `/settings` 没有包在 ProtectedRoute 里，未登录也能进入 SettingsPage。

**G-8 无管理操作审计日志**
审批、拒绝、提权、重置密码、禁用账户都没有留痕记录。

**G-19 精选/精华照片端点缺失 media-level visibility 过滤（安全缺陷，2026-09-04 已修复）**

`GET /api/trips/:id/highlight-photos` 与 `GET /api/trips/:id/tier-photos` 当时的 SQL 仅过滤 highlight/tier membership 与 `mi.status='active'`，未按调用者身份执行 `media_items.visibility` 曝光策略。

因此，当可匿名访问的 trip 中存在 `visibility='private'` 且同时属于 highlight/tier 的 media 时，匿名或非所有者调用者可从上述列表响应取得其 media id 及 mediaServing URL；而 mediaServing 不执行独立 visibility 鉴权，形成 private media 的实际暴露链。

highlight/tier membership 不构成 visibility override。修复复用 `routes/gallery.ts` 已有的 owner/admin + `mi.visibility='public'` media-level policy，未创建第二套曝光规则 —— 见 `routes/highlights.ts` 的 `queryTierPhotos()` 与 highlight-photos 查询，回归测试见 `routes/highlights.test.ts`。owner/admin 的既有完整访问不变。

本条只涉及**照片列表的 media 级曝光**。这两个端点的 trip-level gate 未在此修复中改动（后于 2026-09-09 按需求 9 AC 9–11 放开为直链可访问，见 `highlight-tier` design Property 10a/10b），tier slideshow 文件服务的 gate 亦未改动。

上文提到的「mediaServing 不执行独立 visibility 鉴权」在本条中仅作为暴露链的一环被描述，其自身从未单独登记。现已独立登记为 **G-21**：G-19 关闭的是列表层的 id 泄露，G-21 才是文件层可被直取的通道，二者需分别处置。

**G-20 Derived_Artifact 缺少 Artifact_Provenance，AC 12/13 不可判定（待批准 schema 前置项，2026-09-10 登记）**

tier slideshow 视频由 `highlightTierSelector.triggerTierSlideshow()` 自动生成，或由 `POST /api/my/trips/:id/tier-slideshow/regenerate` 手动生成，落盘到 `uploads/{tripId}/tier-slideshow/{category}/`。两条路径都**不持久化参与生成的 media id 集合**：不写 `slideshow_jobs`（该表属 photo-slideshow-video 功能），也没有任何 sidecar / manifest。产物的唯一记录就是磁盘上的 mp4，`getTierSlideshowUrls()` 靠 `fs.readdirSync` 扫目录发现它。

因此需求 9 AC 12 与 AC 13 对 tier slideshow **在技术上不可判定**：给定一个 mp4，无法查出它由哪些 media 生成，也无法查出生成时各 source 的 visibility。两条生成查询本身也不含 visibility 过滤（`getTierCandidates()` 只过滤 `is_highlight = 1 AND status = 'active' AND category IN (...)`；regenerate 的查询只过滤 `is_highlight_tier = 1 AND status = 'active'`），所以 private media 本来就可能被烘入产物。

可证明的后果（AC 13 违反，纯代码路径可推，无需实跑）：public trip 生成含照片 X 的 tier 视频后，owner 调 `PUT /api/media/X/visibility` 置为 private —— `routes/trash.ts` 只执行 `UPDATE media_items SET visibility = ?`，随后即返回；批量路径 `routes/media.ts` 同理。全仓针对 `tier-slideshow` 目录的删除或失效逻辑命中为 0，`helpers/deleteMediaItem.ts` 亦不涉及该目录。此后匿名请求 `GET /api/trips/:id/tier-photos` 已不再返回 X 的 media id（G-19 生效），但 `slideshowUrls` 仍返回，且 tier slideshow 文件路由因 trip 仍为 `public` 而放行，**X 的画面照常播放**。

2026-10-06（C1）：上段在 `/api` 上的那两步已关闭。AC 4 请求者在任何 trip 上都拿不到 `slideshowUrls`，两条 `/api` 文件路由都返回 404。但文件本身仍在磁盘上，且可经 `/uploads` 静态路由按路径匿名读取（G-22），所以这条 stale exposure 路径**尚未完全关闭**。本条仍未完成。

2026-10-06（G-22）：`/uploads` 在应用层已对所有人拒绝 tier slideshow 路径，上段所说的按路径读取在应用层已关闭（部署配置未核实）。provenance 仍不存在，AC 12/13 仍不可判定，本条仍未完成。

附注（同一规则下的第二处违反）：`services/mergeEngine.ts` 的 `merge()` 在 INSERT 时把 merged 视频的 `visibility` 写成硬编码字面量 `'public'`，而 `validateSources()` 只校验 `status = 'active'` 与 `compiled_path IS NOT NULL`，不校验 source 的 visibility。合并若干 private 视频，产物为 public，直接违反 AC 12。但 merged 视频**有** provenance（`merged_video_sources`），所以它缺的是继承逻辑，而非可判定性 —— 与 tier slideshow 的缺口性质不同，修复成本也低得多。

裁定前置项：AC 12/13 的落地需要先为 tier slideshow 建立 Artifact_Provenance（可照 `merged_video_sources` 的形状）。这属 schema 变更，风险等级为高，**需显式批准后另行立项**。在此之前 tier slideshow 文件路由保留现有 trip-level gate 作为粗粒度代理 —— 它不满足 AC 12，仅用于避免在无 provenance 的情况下扩大曝光面。读取的目标行为（public 与 unlisted 同一判定）见需求 9 AC 15（2026-09-21）；该 gate 对 unlisted 的拒绝属于过渡状态。

独立的低风险缺陷（不属本条，另计）：`generateSlideshow()` 用 `mkdirSync(recursive)` 但不清空输出目录，重复 regenerate 会在同目录堆积多个 mp4；而 `getTierSlideshowUrls()` 取的是 `readdirSync` 结果中第一个 `.mp4`，并非 mtime 最新。故「用 regenerate 当作 invalidation 手段」亦不可靠。

**G-21 `mediaServing` 三条路由无 auth / visibility / status access control（安全缺陷，2026-09-10 登记，未修）**

`routes/mediaServing.ts` 挂载于 `/api/media`（`index.ts`），提供 `GET /:id/thumbnail`、`GET /:id/original`、`GET /:id/raw`。三条路由**均未挂 `authMiddleware` 或 `requireAuth`**，且 `visibility` 一词在该文件出现 0 次 —— 三个 SELECT 的字段列表里根本不含 `visibility`，也不检查所属 trip 的 visibility，连 `status = 'trashed'` 都不拦。

后果：需求 9 AC 4 的 media 级曝光策略在该表面被完全绕过。凡持有 media id 者即可取得原图/原始文件，无论该 media 是 `private`、已 `trashed`，还是属于他人 trip。G-19 修复的是「非所有者能否从列表响应**取得** private media 的 id」，本条是「拿到 id 之后能否**取到文件**」—— 前者是遮挡，后者是实际访问控制，G-19 并未也无法覆盖本条。

附带副作用：`/:id/thumbnail` 在缩略图缺失时会即时生成并执行 `UPDATE media_items SET thumbnail_path = ?`，即**未认证请求可触发写操作**。`STORAGE_TYPE === 's3'` 时该路由 302 跳转到 presigned URL，绕过服务端的范围更大。

本条的暴露面比 G-20 更广：它不限于 tier 场景，作用于全部 media。裁定前需回答：公开画廊页面当前依赖这些 URL 匿名可取（`TierPhotoItem.thumbnailUrl` / `originalUrl` 即指向此处），因此直接加鉴权会破坏公开分享面，须先确定「匿名可读 public media、但拒绝 private/trashed」的判定点与缓存策略。**本轮只登记，不改实现。**

**G-22 `/uploads` 静态路由无任何 access control，可按路径读取上传目录下的全部文件（安全缺陷，2026-10-06 登记，未修）**

`server/src/index.ts` 中 `app.use('/uploads', express.static(uploadsBase))` 把 `server/uploads/` 整个目录对外提供，不经过 `authMiddleware`，也不查任何 visibility 或 status。该目录包含原图（`${tripId}/originals/${mediaId}${ext}`）、tier slideshow 视频（`${tripId}/tier-slideshow/...`）等全部本地存储文件；`storage/localProvider.ts` 的 `getUrl()` 也生成 `/uploads/...` 形式的路径。

已实测（2026-10-06，隔离副本，与仓库数据库和 uploads 无关）：在 C1 生效的前提下，匿名 `GET /uploads/<tripId>/tier-slideshow/<category>/<file>.mp4` 对 public 与 unlisted trip 均返回 200，字节与原文件一致。C2 probe 另证 express 4.22.1 的静态服务默认不会忽略点号目录下的文件。

后果：
- C1 关闭的只是 `/api` 上的两条 tier slideshow 文件路由，本路由可以绕过它们。tripId 本身可公开取得，legacy 文件名 `slideshow_<13 位毫秒时间戳>.mp4` 在已知大致生成时间时可被猜出。
- 与 G-21 同类但暴露面更大：G-21 需要 media id，本条只需要路径；G-21 限于 media 行登记的文件，本条覆盖整个上传目录。
- 删除 trip 只删数据库行、不删文件，所以已删除 trip 的文件依然可经本路由读取。

未核实：生产环境前置的 nginx 是否拦截或另行提供 `/uploads`（仓库内没有被跟踪的 nginx 配置）。

修复会改变全部本地媒体的服务方式，可能影响依赖 `/uploads/...` 路径的现有消费方，属高风险访问控制变更，需单独批准。**本轮只登记，不改实现。**

**2026-10-06 状态更新：应用层已修复，部署配置未核实。** 上文保留为登记时的记录。其中「仓库内没有被跟踪的 nginx 配置」一句不准确：`deploy/setup.sh` 与 `deploy/update.sh` 会写入 nginx server block，只有 `location /api/` 与 `location /` 两段，都 `proxy_pass` 到 Node，没有任何 `/uploads` 的 location、alias 或 root。所以按仓库脚本部署时，nginx 不拦截 `/uploads`，Node 是唯一的 gate。

消费者追踪结论：
- 本地存储模式下没有任何 API 响应或客户端代码通过 `/uploads` 加载文件。`localProvider.getUrl()` 只在 S3 模式的 `mediaServing.ts` 分支里被调用。
- 图片、视频、音频分别走 `/api/media/*`、tier slideshow 的 `/api` 路由（经 `AuthorizedVideo`）、`/api/audio/:id/stream`、`/api/slideshow/:jobId/download`。
- 因此修复无需改动客户端。

修复：`index.ts` 把匿名静态挂载换成 `authMiddleware` + `routes/uploadsAccess.ts`。规则：
- 文件必须恰好是某个现存 trip 下 `media_items` 行的 `file_path`、`thumbnail_path`、`optimized_path`、`compiled_path` 或 `preview_proxy_path`，且路径中的 trip 与该行一致。
- 所有者、管理员：放行（AC 5）。
- AC 4 请求者：要求 `status = 'active'`、`visibility = 'public'`、不是 merged 视频（Derived_Artifact）、视频必须已编译（AC 6），且 trip visibility 属于 AC 7 允许的两个值。视频必须已编译这一条比字面规则更严，依据是公开画廊从不展示未编译视频。
- `tier-slideshow/` 与 `slideshow/` 目录对所有人拒绝；这些文件改走各自已鉴权的 `/api` 路由。
- 无登记文件、已删除 trip 的残留、`frames/`、`audio/`、点号目录、编码穿越路径、指向 uploads 之外的符号链接：一律 404 JSON，不落入 SPA catch-all，也不转到 `/api/media`。
- 允许的响应带 `Cache-Control: private, no-cache` 与 `Vary: Authorization`。

未核实：线上主机实际的 nginx 文件（可能被手工改过）、CDN 或负载均衡、生产是否运行在 `STORAGE_TYPE=s3`（S3 模式下 `/api/media` 会 302 到 presigned URL，bucket ACL 未查）。应用层修复只在部署后生效，需要对线上主机复核。

本条不关闭 G-21：`/api/media/:id/*` 仍按 id 匿名提供任意 media，媒体文件仍可经该路由读取。

**G-18 匿名 trip 响应包含 `userId`（待审计，TBD）**
`rowToTrip()` 返回 8 个字段：`id`、`title`、`description`、`coverImageId`、`visibility`、`userId`、`createdAt`、`updatedAt`。其中 `userId`（所有者账户 id）在 `GET /api/trips` 的 `TripSummary` 契约中**不存在**，却经由 `GET /api/trips/:id` 与 `GET /api/trips/:id/gallery` 暴露给匿名调用者。

这与 G-6 是不同问题：G-6 问的是"匿名能否访问 unlisted trip"（已裁定：能），本条问的是"公开分享面应当暴露哪些字段"。

裁定前需要回答：公开画廊/分享 UI 是否需要 owner identity；其他匿名端点是否已暴露 `userId`；是否存在正式的 response schema 可依；移除该字段是否破坏 `client/src/pages/LoginPage.tsx`（它读 `tripData.userId` 判断是否改跳 `/my/trips/:id`，实现需求 11 AC 11）或其他消费者。

在有正式 authority 之前不改代码。

## 一致性与实现质量

**G-9 `requireAuth` 的错误码语义不准确**
未携带令牌与令牌无效都返回 `TOKEN_INVALID`，缺少 `TOKEN_MISSING` / `UNAUTHORIZED` 之类的区分。

**G-10 所有权判定重复实现**
`requireOwnership` 已存在，但至少 9 处路由改为内联同一段 `if (req.user!.role !== 'admin' && row.user_id !== req.user!.userId)`（`routes/trips.ts` 四处、`routes/media.ts`、`routes/trash.ts` 四处、`routes/users.ts`）。任何规则调整都要改多处。

**G-11 注册逻辑重复**
`routes/auth.ts` 内联了一份注册实现，`services/userService.register()` 是另一份等价实现，路由并不调用它，该服务函数目前只被测试覆盖。

**G-12 前端读错误码的路径与后端不一致**
后端返回 `{ error: { code, message } }`，而 LoginPage / RegisterPage / AuthContext 读的是 `body.code` 与 `body.message`。结果是 `ACCOUNT_PENDING`、`USERNAME_TAKEN` 等分支基本不会命中，用户只看到兜底的通用错误文案。这是**实际影响用户体验**的缺陷。

**G-13 可见性词表分裂**
`trips.visibility` 取 `public | unlisted`，`media_items.visibility` 取 `public | private`，两套词表语义不同且都没有数据库 CHECK 约束。`GET /api/trips` 按旅行可见性过滤，`GET /api/trips/:id/gallery` 只按素材可见性过滤，两处口径不一致。

**G-14 `trips.user_id` 可为空**
该列由 `ALTER TABLE` 添加，没有 NOT NULL 约束，靠启动时 `migrateOrphanedData()` 兜底把孤儿数据划给 `admin`。

**G-15 缺少降权与真实删除**
有 `promote` 没有 `demote`；`DELETE /api/admin/users/:id` 与 `DELETE /api/auth/account` 都只是置为 `disabled`，没有定义账户及其数据的留存与清理策略。

**G-16 用户名唯一性区分大小写**
没有归一化处理，`Alice` 与 `alice` 可以同时存在。

**G-17 无邮箱字段**
`users` 表没有 email 列，因此没有邮箱验证，也无法做自助密码找回（见需求 10.7）。

## 优先级建议

若后续要处理，建议按此顺序，且每项单独立项：

| 优先级 | 条目 | 理由 |
| --- | --- | --- |
| P0 | G-22 | 应用层已于 2026-10-06 修复；剩余项是核实线上 nginx、CDN 与存储模式，并在部署后复测 |
| P0 | G-21 | 需求 9 AC 4 在文件服务表面被完全绕过，影响全部 media；但需先确定匿名可读 public media 的判定点，否则会破坏公开分享面 |
| P1 | G-20 | 需求 9 AC 12/13 目前不可判定；需先批准 Artifact_Provenance schema。merged 视频的继承缺陷（同条附注）可先单独修，成本远低于 provenance |
| P0 | G-12 | 纯前端修复，无安全风险，直接改善错误提示 |
| P0 | G-7 | 未保护的前端路由，改动面小（原与 G-6 同列，G-6 已于 2026-09-02 裁定为非缺陷，见上） |
| P1 | G-4 | 凭证进版本库，建议改为环境变量注入 + 首登强制改密 |
| P1 | G-2、G-3 | 需要引入令牌版本或短期令牌 + 刷新，属于会话机制变更 |
| P1 | G-5 | 登录节流 |
| P2 | G-10、G-11 | 内部重构，收敛重复逻辑 |
| P2 | G-13、G-14 | 涉及数据库约束与数据回填，需迁移方案 |
| P3 | G-1、G-8、G-15、G-16、G-17 | 需要产品决策或较大改动 |

---

## 附录：路由权限总表

| 方法 | 路径 | 认证 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 否 | 公开 |
| POST | `/api/auth/login` | 否 | 公开 |
| PUT | `/api/auth/password` | 是 | 本人 |
| DELETE | `/api/auth/account` | 是 | 本人 |
| GET | `/api/admin/users` | 是 | admin |
| GET | `/api/admin/users/pending` | 是 | admin |
| PUT | `/api/admin/users/:id/approve` | 是 | admin |
| PUT | `/api/admin/users/:id/reject` | 是 | admin |
| PUT | `/api/admin/users/:id/promote` | 是 | admin |
| PUT | `/api/admin/users/:id/password` | 是 | admin |
| DELETE | `/api/admin/users/:id` | 是 | admin（实为禁用） |
| GET | `/api/admin/users/:id/trips` | 是 | admin |
| GET | `/api/admin/storage/status` | 是 | admin |
| POST | `/api/admin/storage/migrate` | 是 | admin |
| GET | `/api/users/me/trips` | 是 | 本人 |
| GET | `/api/users/me/trips/:id/gallery` | 是 | 所有者或 admin |
| GET | `/api/my/trips` | 是 | 本人 |
| GET | `/api/my/trips/:id/gallery` | 是 | 本人 |
| GET | `/api/my/trips/:id/tier-photos` | 是 | 本人 |
| GET | `/api/my/trips/:id/highlight-pool` | 是 | 本人 |
| PUT | `/api/my/trips/:id/tier-photos/:photoId` | 是 | 本人 |
| DELETE | `/api/my/trips/:id/tier-photos/:photoId` | 是 | 本人 |
| POST | `/api/my/trips/:id/tier-slideshow/regenerate` | 是 | 本人 |
| POST | `/api/trips` | 是 | 任意登录用户 |
| GET | `/api/trips` | 可选 | 公开（仅 `visibility = 'public'`） |
| GET | `/api/trips/:id` | **无中间件** | 公开（`public` 与 `unlisted` 均可匿名访问，见需求 9 AC 9–11；G-6 已裁定为非缺陷） |
| PUT | `/api/trips/:id` | 是 | 所有者或 admin |
| PUT | `/api/trips/:id/visibility` | 是 | 所有者或 admin |
| PUT | `/api/trips/:id/cover` | 是 | 所有者或 admin |
| DELETE | `/api/trips/:id` | 是 | 所有者或 admin |
| GET | `/api/trips/:id/gallery` | 可选 | 公开（非所有者仅见 public 素材） |

## 附录：涉及的环境变量名

仅列名称，不涉及取值：`JWT_SECRET`、`NODE_ENV`、`PORT`。

`JWT_SECRET` 在 `NODE_ENV=production` 下为必填项，缺失会导致服务启动失败。
