# 需求文档：V2 用户功能与素材存储介质

## 简介

V2 版本在现有旅行相册系统基础上新增两大核心功能模块：**用户系统**和**素材存储介质抽象**。用户系统引入管理员与普通用户角色，实现注册审批、权限控制、用户空间与主页空间分离。存储介质抽象将当前硬编码的本地文件系统操作替换为可插拔的存储提供者接口，支持本地存储、AWS S3、阿里 OSS、腾讯 COS，并提供从本地存储到对象存储的迁移能力。

## 术语表

- **System（系统）**：旅行相册应用的后端服务
- **Auth_Module（认证模块）**：负责用户登录、令牌签发与验证的模块
- **User_Manager（用户管理器）**：负责用户注册审批、角色管理、密码管理的模块
- **Permission_Guard（权限守卫）**：负责在路由层校验用户角色与资源归属的中间件
- **Storage_Provider（存储提供者）**：统一的文件存储抽象接口，封装读写删等操作
- **Migration_Tool（迁移工具）**：负责将文件从一个 Storage_Provider 迁移到另一个的工具
- **Tag_Generator（标签生成器）**：根据命名规则为上传素材自动生成标签的服务
- **Admin（管理员）**：拥有全部操作权限的用户角色
- **Regular_User（普通用户）**：经管理员审批后注册成功的用户角色
- **User_Space（用户空间）**：用户查看自己所有相册和素材（含未公开）的私有页面
- **Home_Page（主页）**：展示所有公开相册和素材的公共页面
- **Album（相册）**：即现有系统中的 Trip（旅行），V2 中由用户创建并拥有

## 需求

### 需求 1：用户注册与默认管理员

**用户故事：** 作为系统部署者，我希望系统初始化时自动创建默认管理员账户，以便首次使用时可以登录管理系统。

#### 验收标准

1. WHEN System 首次初始化数据库, THE User_Manager SHALL 创建一个用户名为 "admin"、角色为 Admin 的默认用户，密码使用 bcrypt 哈希存储
2. THE System SHALL 在 users 表中存储用户信息，包含字段：id、username、password_hash、role（admin/regular）、status（active/pending/disabled）、created_at、updated_at
3. IF 默认管理员账户已存在, THEN THE User_Manager SHALL 跳过创建操作，保持幂等性
4. THE System SHALL 使用 bcrypt 算法（cost factor 不低于 10）对所有密码进行哈希处理后存储

### 需求 2：用户注册审批

**用户故事：** 作为访客，我希望提交注册申请（用户名和密码），经管理员审批后成为普通用户。

#### 验收标准

1. WHEN 访客提交包含用户名和密码的注册请求, THE User_Manager SHALL 创建一个 status 为 "pending" 的用户记录
2. WHEN 访客提交的用户名已被占用, THE User_Manager SHALL 返回错误码 "USERNAME_TAKEN" 及描述信息
3. WHEN 访客提交的用户名为空或密码长度不足 6 个字符, THE User_Manager SHALL 返回参数校验错误
4. WHEN Admin 审批通过一个 pending 状态的注册申请, THE User_Manager SHALL 将该用户 status 更新为 "active"
5. WHEN Admin 拒绝一个 pending 状态的注册申请, THE User_Manager SHALL 将该用户 status 更新为 "disabled"
6. THE User_Manager SHALL 提供查询所有 pending 状态用户列表的接口，仅 Admin 可访问

### 需求 3：用户登录与会话管理

**用户故事：** 作为已注册用户，我希望通过用户名和密码登录系统，获取访问令牌以调用受保护的接口。

#### 验收标准

1. WHEN 用户提交正确的用户名和密码且用户 status 为 "active", THE Auth_Module SHALL 签发一个包含 userId 和 role 的 JWT 令牌，有效期为 7 天
2. WHEN 用户提交的用户名不存在或密码不匹配, THE Auth_Module SHALL 返回 401 状态码及错误码 "INVALID_CREDENTIALS"，不区分用户名错误还是密码错误
3. WHEN 用户 status 为 "pending", THE Auth_Module SHALL 返回 403 状态码及错误码 "ACCOUNT_PENDING"
4. WHEN 用户 status 为 "disabled", THE Auth_Module SHALL 返回 403 状态码及错误码 "ACCOUNT_DISABLED"
5. WHEN 请求携带的 JWT 令牌过期或签名无效, THE Auth_Module SHALL 返回 401 状态码及错误码 "TOKEN_INVALID"

### 需求 4：密码管理

**用户故事：** 作为普通用户，我希望能修改自己的密码；当忘记密码时，管理员可以帮我重置密码。

#### 验收标准

1. WHEN Regular_User 提交旧密码和新密码的修改请求, THE User_Manager SHALL 验证旧密码正确后将密码更新为新密码的 bcrypt 哈希值
2. WHEN Regular_User 提交的旧密码不正确, THE User_Manager SHALL 返回错误码 "WRONG_PASSWORD"
3. WHEN Admin 提交重置指定用户密码的请求, THE User_Manager SHALL 将该用户密码更新为 Admin 指定的新密码的 bcrypt 哈希值
4. THE User_Manager SHALL 要求新密码长度不少于 6 个字符

### 需求 5：用户注销

**用户故事：** 作为普通用户，我希望能注销自己的账户，注销后无法再登录。

#### 验收标准

1. WHEN Regular_User 提交注销自己账户的请求, THE User_Manager SHALL 将该用户 status 更新为 "disabled"
2. WHEN Regular_User 注销账户后, THE System SHALL 保留该用户创建的公开相册和素材在主页可见
3. WHILE 用户 status 为 "disabled", THE Auth_Module SHALL 拒绝该用户的登录请求

### 需求 6：管理员用户管理

**用户故事：** 作为管理员，我希望能管理所有用户，包括删除用户、修改用户密码、提升用户为管理员。

#### 验收标准

1. WHEN Admin 删除一个 Regular_User, THE User_Manager SHALL 将该用户 status 更新为 "disabled"
2. WHEN Admin 修改指定用户的密码, THE User_Manager SHALL 将该用户密码更新为新密码的 bcrypt 哈希值
3. WHEN Admin 将一个 Regular_User 提升为 Admin, THE User_Manager SHALL 将该用户 role 更新为 "admin"
4. IF Regular_User 尝试执行管理员专属操作, THEN THE Permission_Guard SHALL 返回 403 状态码及错误码 "FORBIDDEN"
5. THE User_Manager SHALL 提供查询所有用户列表的接口（含 role 和 status），仅 Admin 可访问


### 需求 7：相册与素材的所有权

**用户故事：** 作为已登录用户，我希望创建的相册和上传的素材归属于我，以便系统按所有权进行权限控制。

#### 验收标准

1. WHEN 已登录用户创建相册, THE System SHALL 在 trips 表中记录该用户的 user_id 作为相册所有者
2. WHEN 已登录用户上传素材, THE System SHALL 在 media_items 表中记录该用户的 user_id 作为素材所有者
3. THE System SHALL 为现有无 user_id 的相册和素材分配给默认管理员用户

### 需求 8：素材公开性控制

**用户故事：** 作为普通用户，我希望能设置自己上传的素材是否公开，未公开的素材仅在我的用户空间可见。

#### 验收标准

1. WHEN 用户上传素材时, THE System SHALL 默认将素材的 visibility 设置为 "public"
2. WHEN 素材所有者修改素材的 visibility, THE System SHALL 将 visibility 更新为 "public" 或 "private"
3. IF 非素材所有者且非 Admin 尝试修改素材 visibility, THEN THE Permission_Guard SHALL 返回 403 状态码
4. THE System SHALL 支持批量修改同一相册下所有素材的 visibility

### 需求 9：用户空间

**用户故事：** 作为已登录用户，我希望在用户空间中查看自己创建的所有相册和素材，包括未公开的内容。

#### 验收标准

1. WHEN 已登录用户访问用户空间, THE System SHALL 返回该用户创建的所有相册列表（含 public 和 private）
2. WHEN 已登录用户在用户空间查看某个相册, THE System SHALL 返回该相册下所有素材（含 public 和 private）
3. IF 用户尝试访问其他用户的用户空间, THEN THE Permission_Guard SHALL 返回 403 状态码
4. WHEN Admin 访问任意用户的用户空间, THE System SHALL 返回该用户的所有相册和素材

### 需求 10：主页空间

**用户故事：** 作为任意访问者（含未登录），我希望在主页看到所有公开的相册和素材。

#### 验收标准

1. THE Home_Page SHALL 仅展示 visibility 为 "public" 的相册
2. WHEN 访问者查看某个公开相册, THE System SHALL 仅返回该相册下 visibility 为 "public" 的素材
3. THE Home_Page SHALL 无需登录即可访问
4. WHILE 用户未登录, THE System SHALL 隐藏所有需要认证的操作入口（如创建相册、上传素材）

### 需求 11：管理员对相册和素材的管理权限

**用户故事：** 作为管理员，我希望能删除任意普通用户创建的相册和素材，以维护平台内容。

#### 验收标准

1. WHEN Admin 删除 Regular_User 创建的相册, THE System SHALL 将该相册及其下所有素材标记为 "trashed" 状态
2. WHEN Admin 删除 Regular_User 上传的素材, THE System SHALL 将该素材标记为 "trashed" 状态
3. WHEN Regular_User 删除自己的相册, THE System SHALL 将该相册及其下所有素材标记为 "trashed" 状态
4. WHEN Regular_User 删除自己上传的素材, THE System SHALL 将该素材标记为 "trashed" 状态
5. IF Regular_User 尝试删除其他用户的相册或素材, THEN THE Permission_Guard SHALL 返回 403 状态码

### 需求 12：素材自动标签

**用户故事：** 作为用户，我希望上传的素材能自动打上标签，方便后续检索和分类。

#### 验收标准

1. WHEN 用户上传素材, THE Tag_Generator SHALL 根据命名规则自动生成标签并存储到 media_tags 表
2. THE Tag_Generator SHALL 按以下规则生成标签：相册名称作为标签、上传日期（YYYY-MM）作为标签、媒体类型（image/video）作为标签、原始文件扩展名作为标签
3. THE System SHALL 在 media_tags 表中存储标签信息，包含字段：id、media_id、tag_name、created_at
4. WHEN 用户查询素材时, THE System SHALL 支持按标签名称筛选素材
5. THE Tag_Generator SHALL 对标签名称进行小写化和去空格处理以保持一致性

### 需求 13：存储提供者抽象接口

**用户故事：** 作为开发者，我希望系统通过统一的存储接口访问文件，以便在不修改业务逻辑的情况下切换存储后端。

#### 验收标准

1. THE Storage_Provider SHALL 定义统一接口，包含方法：save（保存文件）、read（读取文件流）、delete（删除文件）、exists（检查文件是否存在）、getUrl（获取文件访问 URL）
2. THE System SHALL 提供 LocalStorageProvider 实现，使用本地文件系统存储文件，行为与当前系统一致
3. THE System SHALL 提供 S3StorageProvider 实现，使用 AWS S3 SDK 存储文件
4. THE System SHALL 提供 OSSStorageProvider 实现，使用阿里云 OSS SDK 存储文件
5. THE System SHALL 提供 COSStorageProvider 实现，使用腾讯云 COS SDK 存储文件
6. THE System SHALL 通过环境变量 STORAGE_TYPE 配置当前使用的存储提供者，默认值为 "local"
7. WHEN STORAGE_TYPE 设置为不支持的值, THE System SHALL 在启动时抛出明确的配置错误信息

### 需求 14：存储提供者集成

**用户故事：** 作为开发者，我希望所有涉及文件操作的服务都通过 Storage_Provider 接口访问文件，而非直接调用 fs 模块。

#### 验收标准

1. THE System SHALL 将以下服务中的直接文件系统调用替换为 Storage_Provider 接口调用：media.ts（文件上传）、mediaServing.ts（文件读取）、thumbnailGenerator.ts（缩略图生成与存储）、imageOptimizer.ts（优化图片存储）、videoEditor.ts（视频编辑输出存储）、coverSelector.ts（封面帧提取）、blurDetector.ts（模糊检测读取）、trash.ts（文件删除）
2. WHEN Storage_Provider 为对象存储类型, THE System SHALL 在需要本地处理（如 sharp、ffmpeg）时先将文件下载到临时目录，处理完成后上传结果并清理临时文件
3. THE System SHALL 在数据库中存储存储提供者无关的相对路径（如 "{tripId}/originals/{filename}"），由 Storage_Provider 在运行时解析为实际存储路径

### 需求 15：存储迁移工具

**用户故事：** 作为系统管理员，我希望能将现有本地存储的文件迁移到对象存储，以便扩展存储容量。

#### 验收标准

1. THE Migration_Tool SHALL 提供 API 接口，接受目标存储类型和配置参数，仅 Admin 可调用
2. WHEN Admin 触发迁移操作, THE Migration_Tool SHALL 遍历所有本地存储的文件，逐个上传到目标 Storage_Provider
3. WHEN 单个文件迁移失败, THE Migration_Tool SHALL 记录失败文件信息并继续迁移其余文件
4. WHEN 迁移完成, THE Migration_Tool SHALL 返回迁移结果摘要，包含：成功文件数、失败文件数、失败文件列表
5. THE Migration_Tool SHALL 在迁移过程中不中断正常的文件读写服务
6. IF 迁移目标与当前存储类型相同, THEN THE Migration_Tool SHALL 返回错误码 "SAME_STORAGE_TYPE"

### 需求 16：前端认证界面

**用户故事：** 作为用户，我希望在前端有登录页面、注册页面和用户空间页面，以便完成认证和管理个人内容。

#### 验收标准

1. THE System SHALL 提供登录页面，包含用户名输入框、密码输入框和登录按钮
2. THE System SHALL 提供注册页面，包含用户名输入框、密码输入框、确认密码输入框和提交注册按钮
3. WHEN 用户登录成功, THE System SHALL 将 JWT 令牌存储在 localStorage 中，并在后续请求的 Authorization 头中携带
4. WHEN 用户点击退出登录, THE System SHALL 清除本地存储的 JWT 令牌并跳转到主页
5. WHILE 用户已登录, THE System SHALL 在导航栏显示用户名和退出登录按钮
6. WHILE 用户未登录, THE System SHALL 在导航栏显示登录和注册入口
7. THE System SHALL 提供用户空间页面，展示当前用户的所有相册列表（含公开和未公开）
8. WHEN Admin 登录后, THE System SHALL 在导航栏显示管理后台入口

### 需求 17：管理后台界面

**用户故事：** 作为管理员，我希望有一个管理后台页面，集中处理用户审批、用户管理和存储迁移操作。

#### 验收标准

1. THE System SHALL 提供管理后台页面，包含用户管理和存储管理两个功能区
2. WHEN Admin 访问用户管理区, THE System SHALL 展示所有用户列表，支持审批 pending 用户、删除用户、重置密码、提升为管理员
3. WHEN Admin 访问存储管理区, THE System SHALL 展示当前存储类型，并提供迁移到其他存储类型的操作入口
4. IF Regular_User 尝试访问管理后台页面, THEN THE System SHALL 跳转到主页
