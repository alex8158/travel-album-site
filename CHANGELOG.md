# 变更日志

本文件记录旅行相册系统的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [v1.0.0] - 2026-04-21

初步完成图片去重、去模糊和自动优化处理流水线。

### 异步处理

- 处理流水线从 SSE 长连接改为异步后台任务模式
- 新增 processing_jobs / processing_job_events 数据库表，进度持久化
- 前端通过轮询获取结构化进度数据，连接断开不影响后端处理
- 支持页面刷新后自动恢复进度轮询
- 服务重启自动清理僵尸任务

### 模糊检测

- 改为纯 CPU 双区域 Laplacian 方差检测（整图 + 中心 50% 裁剪）
- 取两个区域的最小值作为最终清晰度分数，减少背景纹理干扰
- MUSIQ 不再参与删图判定，仅用于质量评分和去重选图
- 阈值可通过环境变量或 options 参数传入

### 去重

- DINOv2 路径改为直接返回 pair 列表（含 similarity），不再做 BFS 分组 + 全 pair 展开
- 小图集（≤500）使用全量相似度矩阵，大图集使用 FAISS top-50 + 阈值过滤
- 去重 blur gate 放宽：suspect 照片也参与去重，只排除确认模糊的
- DINOv2 阈值统一从 PROCESS_THRESHOLDS 读取（默认 0.90）
- CLIP 阈值收紧：confirmed 0.93, gray high 0.90, gray low 0.86, strict 0.92

### 质量评分（去重选图）

- Laplacian 清晰度加入 ML 评分权重（0.30），成为主要信号
- 权重分配：清晰度 0.30 + MUSIQ 0.25 + 审美 0.20 + 分辨率 0.10 + 曝光 0.10 + 文件大小 0.05
- MUSIQ < 15 / < 20 仍作为硬性 veto

### 已知局限

- 模糊检测对主体不在中心的图片效果有限
- 水下/暗光场景的去重和去模糊仍需进一步优化
- CLIP 回退路径仍使用 top-k 截断候选，大图集可能漏检

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
