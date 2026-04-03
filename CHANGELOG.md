# 变更日志

本文件记录旅行相册系统的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [v2.1.0] - 2026-04-03

### 导航栏变更

- 未登录用户仅显示「登录」和「注册」按钮
- 已登录用户在公开页面显示「我的空间」和「退出」，隐藏「设置」「新建旅行」
- 已登录用户在用户空间显示「设置」「新建旅行」「退出」
- 管理员在用户空间额外显示「会员管理」（替代原「管理后台」）
- 移除全局无条件显示的「设置」链接
- 登录链接在公开页面携带 `returnTo` 参数

### 公开相册页变更

- GalleryPage（/trips/:id）改为纯只读浏览模式，移除所有编辑控件
- 移除编辑按钮、追加素材按钮、更换封面图按钮、重复组选择器、待删除区
- HomePage 移除 unlisted 相册渲染逻辑（半透明、未公开标记、不可点击）
- HomePage 所有卡片统一使用 `<Link>` 链接到 `/trips/:id`

### 用户空间变更

- 新增 MyGalleryPage（/my/trips/:id）承载所有编辑功能
- MyGalleryPage 支持多选模式批量删除素材
- UserSpacePage 相册卡片链接改为 `/my/trips/:id`
- UserSpacePage 每个卡片显示可见性状态标签（公开/不公开）
- UserSpacePage 每个卡片提供可见性切换按钮（乐观更新 + 失败回滚）
- UserSpacePage 每个卡片提供「删除相册」按钮
- UserSpacePage 新增「新建相册」入口
- 登录后根据相册所有权自动跳转编辑模式（/my/trips/:id）

### 管理员权限变更

- 新增 AdminUserTripsPage（/admin/users/:userId/trips）查看任意用户相册列表
- AdminPage 用户表格新增「查看相册」链接
- 管理员可通过 /my/trips/:id 编辑任意用户相册

### 后端接口变更

- 新增 `PUT /api/trips/:id/media/trash` 批量标记删除接口
- 新增 `GET /api/my/trips/:id/gallery` 管理视图 gallery 接口
- 保留 `GET /api/users/me/trips/:id/gallery` 向后兼容
