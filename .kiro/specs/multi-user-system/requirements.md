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

**G-6 `GET /api/trips/:id` 完全没有鉴权**
该路由既未挂载 `authMiddleware` 也不检查 `visibility`，任何人凭 id 就能读取任意旅行的元数据（含 `unlisted`）。

**G-7 `/settings` 前端路由未受保护**
`App.tsx` 中 `/settings` 没有包在 ProtectedRoute 里，未登录也能进入 SettingsPage。

**G-8 无管理操作审计日志**
审批、拒绝、提权、重置密码、禁用账户都没有留痕记录。

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
| P0 | G-12 | 纯前端修复，无安全风险，直接改善错误提示 |
| P0 | G-6、G-7 | 越权读取与未保护路由，改动面小 |
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
| GET | `/api/trips/:id` | **无中间件** | 公开（无可见性检查，见 G-6） |
| PUT | `/api/trips/:id` | 是 | 所有者或 admin |
| PUT | `/api/trips/:id/visibility` | 是 | 所有者或 admin |
| PUT | `/api/trips/:id/cover` | 是 | 所有者或 admin |
| DELETE | `/api/trips/:id` | 是 | 所有者或 admin |
| GET | `/api/trips/:id/gallery` | 可选 | 公开（非所有者仅见 public 素材） |

## 附录：涉及的环境变量名

仅列名称，不涉及取值：`JWT_SECRET`、`NODE_ENV`、`PORT`。

`JWT_SECRET` 在 `NODE_ENV=production` 下为必填项，缺失会导致服务启动失败。
