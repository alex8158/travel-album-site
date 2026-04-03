# 需求文档：UX与权限展示优化

## 简介

对旅行相册系统的前端界面进行权限展示优化，明确区分公开页面（主页、公开相册页）与登录后用户空间的功能边界。公开页面仅展示公开内容和登录/注册入口，去除所有需要认证的操作；用户空间集中承载相册管理、素材管理、重复组选择等编辑功能；管理员在用户空间额外获得会员管理入口和全局编辑权限。新增用户空间相册详情独立路由（/my/trips/:id）实现编辑模式与公开浏览模式的路由级分离，支持多选删除交互、相册可见性快捷切换，以及登录后自动跳转编辑模式。同时创建变更日志文档记录本次修改。

## 术语表

- **NavHeader（导航栏）**：App.tsx 中的全局顶部导航组件，根据认证状态和当前页面上下文渲染不同的操作入口
- **Public_Page（公开页面）**：无需登录即可访问的页面，包括 HomePage 和公开相册的 GalleryPage
- **User_Space（用户空间）**：登录后用户管理自己相册和素材的私有页面（/my 路由及其子功能）
- **Duplicate_Group_Selector（重复组选择器）**：GalleryPage 中展示同一重复组内多张相似图片并允许用户选择默认展示图的 UI 组件
- **Gallery_Page（相册详情页）**：展示单个相册内所有素材的页面（/trips/:id 路由）
- **Home_Page（主页）**：展示所有公开相册列表的首页（/ 路由）
- **Admin（管理员）**：role 为 "admin" 的用户
- **Regular_User（普通用户）**：role 为 "regular" 的已登录用户
- **Changelog（变更日志）**：记录本次 UX 与权限优化所有修改内容的文档
- **My_Gallery_Page（用户相册详情页）**：用户空间下的相册编辑管理页面（/my/trips/:id 路由），需要登录且仅所有者或管理员可访问，区别于公开浏览模式的 Gallery_Page（/trips/:id）
- **Multi_Select_Mode（多选模式）**：My_Gallery_Page 中的交互模式，允许用户通过勾选框批量选择素材并执行删除操作
- **Visibility_Toggle（可见性切换）**：User_Space 相册卡片上的切换控件，用于在 public 和 unlisted 之间切换相册可见性

## 需求

### 需求 1：公开页面导航栏精简

**用户故事：** 作为未登录的访客，我希望在公开页面的导航栏只看到登录和注册按钮，以获得简洁清晰的浏览体验。

#### 验收标准

1. WHILE 用户未登录, THE NavHeader SHALL 仅显示「登录」和「注册」两个操作按钮，以及站点 Logo/标题
2. WHILE 用户未登录, THE NavHeader SHALL 隐藏「设置」「管理后台」「我的空间」「退出」「新建旅行」链接
3. WHILE 用户已登录且当前页面为 Public_Page, THE NavHeader SHALL 显示用户名/头像、「我的空间」链接和「退出」按钮，隐藏「设置」「新建旅行」「管理后台」链接
4. WHILE 用户已登录且当前页面为 User_Space 或其子页面, THE NavHeader SHALL 显示用户名/头像、「我的空间」「设置」「新建旅行」「退出」链接
5. WHEN Admin 已登录且当前页面为 User_Space 或其子页面, THE NavHeader SHALL 额外显示「会员管理」链接（替代原「管理后台」入口）

### 需求 2：公开相册页面只读化

**用户故事：** 作为访客或非所有者用户，我希望在公开相册页面只看到公开素材和基本浏览功能，不看到任何编辑操作。

#### 验收标准

1. WHILE 当前用户不是相册所有者且不是 Admin, THE Gallery_Page SHALL 隐藏「编辑」按钮、「追加素材」按钮、「更换封面图」按钮和待删除区
2. WHILE 当前用户未登录, THE Gallery_Page SHALL 隐藏所有编辑操作按钮
3. THE Gallery_Page SHALL 在公开访问模式下仅展示 visibility 为 "public" 的素材

### 需求 3：公开相册页面隐藏重复组选择器

**用户故事：** 作为访客，我希望在公开相册页面每组重复图片只看到最佳的一张，不看到重复组选择按钮，以获得干净的浏览体验。

#### 验收标准

1. WHILE 当前用户不是相册所有者且不是 Admin, THE Gallery_Page SHALL 隐藏每张图片上的重复组选择器按钮（「🔄 N张」按钮）
2. WHILE 当前用户不是相册所有者且不是 Admin, THE Gallery_Page SHALL 对每个重复组仅展示 default_image_id 对应的图片
3. WHILE 当前用户是相册所有者或 Admin, THE Gallery_Page SHALL 显示重复组选择器按钮，允许用户选择公开展示哪张图片

### 需求 4：用户空间功能集中

**用户故事：** 作为已登录用户，我希望在用户空间中集中管理我的相册和素材，包括新建、删除、编辑等操作。

#### 验收标准

1. WHEN 已登录用户访问 User_Space, THE User_Space SHALL 展示该用户创建的所有相册列表（含 public 和 unlisted）
2. THE User_Space SHALL 提供「新建相册」入口，链接到上传页面（/upload）
3. THE User_Space SHALL 为每个相册提供「删除相册」操作按钮
4. WHEN 已登录用户从 User_Space 进入自己的相册详情页, THE Gallery_Page SHALL 显示编辑、追加素材、更换封面图、重复组选择器和待删除区等完整管理功能
5. THE User_Space SHALL 支持对素材进行多选删除操作
6. WHEN 用户在 User_Space 的相册详情页中选择多个素材并点击删除, THE Gallery_Page SHALL 将选中的素材批量标记为 "trashed" 状态

### 需求 5：管理员增强权限

**用户故事：** 作为管理员，我希望在用户空间中额外看到会员管理入口，并对所有用户的相册拥有编辑权限。

#### 验收标准

1. WHEN Admin 访问 User_Space, THE User_Space SHALL 额外显示「会员管理」按钮，点击跳转到管理后台页面（/admin）
2. WHEN Admin 访问任意用户的公开相册详情页, THE Gallery_Page SHALL 显示编辑、追加素材、更换封面图、重复组选择器和待删除区等完整管理功能
3. WHEN Admin 在 Gallery_Page 执行编辑操作, THE System SHALL 允许 Admin 修改任意用户的相册信息和素材

### 需求 6：变更日志文档

**用户故事：** 作为开发者，我希望有一份变更日志文档记录本次 UX 与权限优化的所有修改，以便追踪变更历史。

#### 验收标准

1. THE System SHALL 在项目根目录创建 CHANGELOG.md 文件（如已存在则追加条目）
2. THE Changelog SHALL 包含本次变更的日期、版本标识和变更摘要
3. THE Changelog SHALL 按功能模块分类列出所有修改项：导航栏变更、公开相册页变更、用户空间变更、管理员权限变更
4. THE Changelog SHALL 使用中文撰写，格式遵循 Keep a Changelog 规范

### 需求 7：用户空间相册详情独立路由

**用户故事：** 作为已登录用户，我希望从用户空间进入相册时使用独立的编辑路由（/my/trips/:id），与公开浏览路由（/trips/:id）明确区分，以便在编辑模式下获得完整管理功能。

#### 验收标准

1. THE System SHALL 注册 /my/trips/:id 路由，渲染 My_Gallery_Page 组件
2. WHEN 已登录用户从 User_Space 点击相册卡片, THE User_Space SHALL 导航到 /my/trips/:id（编辑模式），而非 /trips/:id
3. WHEN 未登录用户从 Home_Page 点击相册卡片, THE Home_Page SHALL 导航到 /trips/:id（只读模式）
4. THE My_Gallery_Page SHALL 要求用户已登录，未登录用户访问 /my/trips/:id 时重定向到登录页面
5. WHILE 当前用户不是相册所有者且不是 Admin, THE My_Gallery_Page SHALL 拒绝访问并显示无权限提示
6. WHILE 当前用户是相册所有者或 Admin, THE My_Gallery_Page SHALL 显示编辑、追加素材、更换封面图、重复组选择器和待删除区等完整管理功能
7. THE Gallery_Page（/trips/:id）SHALL 保持为纯只读公开浏览模式，对所有用户隐藏编辑操作

### 需求 8：多选删除交互

**用户故事：** 作为已登录用户，我希望在用户空间的相册详情页中通过多选模式批量删除素材，以便高效管理相册内容。

#### 验收标准

1. THE My_Gallery_Page SHALL 在工具栏中提供「选择」按钮，点击后进入 Multi_Select_Mode
2. WHILE Multi_Select_Mode 激活, THE My_Gallery_Page SHALL 在每张图片和视频的左上角显示勾选框
3. WHILE Multi_Select_Mode 激活且有素材被选中, THE My_Gallery_Page SHALL 在页面底部显示操作栏，包含已选数量文本和「删除选中」按钮
4. WHEN 用户在 Multi_Select_Mode 中点击「删除选中」按钮, THE My_Gallery_Page SHALL 弹出确认对话框，显示即将删除的素材数量
5. WHEN 用户在确认对话框中点击确认, THE System SHALL 将所有选中的素材批量标记为 "trashed" 状态，trashedReason 设为 "manual"
6. WHEN 批量删除操作完成, THE My_Gallery_Page SHALL 退出 Multi_Select_Mode 并刷新素材列表
7. WHEN 用户在 Multi_Select_Mode 中点击「取消」按钮, THE My_Gallery_Page SHALL 清除所有选中状态并退出 Multi_Select_Mode

### 需求 9：用户空间相册可见性切换

**用户故事：** 作为已登录用户，我希望在用户空间的相册列表中直接切换相册的可见性状态，无需进入相册详情页即可控制相册是否公开。

#### 验收标准

1. THE User_Space SHALL 在每个相册卡片上显示当前可见性状态标签（「公开」或「不公开」）
2. THE User_Space SHALL 在每个相册卡片上提供 Visibility_Toggle 按钮
3. WHEN 用户点击 Visibility_Toggle 按钮, THE System SHALL 调用 PUT /api/trips/:id/visibility 接口，在 "public" 和 "unlisted" 之间切换可见性
4. WHEN 可见性切换 API 调用成功, THE User_Space SHALL 立即更新该相册卡片的可见性状态标签，无需刷新页面
5. IF 可见性切换 API 调用失败, THEN THE User_Space SHALL 显示错误提示并恢复原可见性状态

### 需求 10：登录后跳转到编辑模式

**用户故事：** 作为相册所有者，我希望在公开相册页面登录后自动跳转到编辑模式，以便立即开始管理自己的相册。

#### 验收标准

1. WHEN 用户在 Gallery_Page（/trips/:id）点击登录并成功登录, THE System SHALL 检查该相册是否属于当前登录用户
2. WHEN 登录成功且相册属于当前用户, THE System SHALL 自动将页面跳转到 /my/trips/:id（编辑模式）
3. WHEN 登录成功且相册不属于当前用户, THE System SHALL 保持在当前 Gallery_Page（/trips/:id）公开浏览页面
4. WHEN Admin 在 Gallery_Page 登录成功, THE System SHALL 自动将页面跳转到 /my/trips/:id（编辑模式），因为 Admin 对所有相册拥有编辑权限
