# 更新说明 — v2-smart-media 分支

本文档记录 `v2-smart-media` 分支相对于 `main` 的所有变更，包括新功能、配置变更和部署注意事项。

## 新增功能

### 1. 视频自动编译

上传视频后，处理 Pipeline 自动执行以下流程：

- **场景分段**：ffmpeg 检测自然场景边界，将视频切分为多个片段
- **质量评分**：对每个片段计算清晰度、稳定性、曝光三维分数
- **自动编译**：根据评分选择最佳片段，拼接生成精华剪辑视频
- **错误隔离**：单个视频编译失败不影响其他视频和整体 Pipeline

之前需要设置 `VIDEO_AUTO_COMPILE_ENGINE=true` 环境变量才能启用，现在**始终自动执行**，无需任何配置。

### 2. 多视频合并

用户可以跨相册选择多个已编译的视频，合并为一个新视频：

- **API 端点**：`POST /api/media/merge`
- **请求参数**：`{ tripId, sourceMediaIds: [...], name? }`
- **限制**：至少 2 个源视频，所有源视频必须已完成编译（有 compiled_path）
- **权限**：需要登录，且对所有源视频所属相册有所有权

### 3. 我的相册页视频分栏

MyGalleryPage 视频区域分为两个 Tab：

- **原始视频**：所有上传的原始视频
- **剪辑视频**：编译后的精华视频 + 合并生成的视频

合并视频带有"合并"标签，方便区分。

### 4. 公开画廊视频过滤

GalleryPage（公开画廊）仅展示经过编译的视频：

- 没有 compiled_path 的原始视频不会出现在公开画廊
- 合并视频（media_source='merged'）也会展示
- 播放地址优先使用编译版本

### 5. 音频库与背景音乐

- 用户可上传/管理音频文件
- 为编译后的视频添加背景音乐
- 支持音频裁剪（trim start/end）

### 6. 安全修复

修复了 4 个高危安全漏洞：

| 问题 | 严重程度 | 修复方式 |
|------|----------|----------|
| JWT Secret 提交到仓库 | Critical | 删除文件，生产环境强制要求 `JWT_SECRET` 环境变量 |
| AI 编辑路由缺少所有权检查 | High | 添加 trip 所有权验证 |
| 处理 Pipeline 无需认证 | High | 添加 authMiddleware + requireAuth + 所有权检查 |
| Upload Session 劫持 | Medium | 添加会话所有权验证 |

## 数据库变更

本次更新会自动执行以下迁移（幂等，重复运行安全）：

```sql
-- 新增 media_source 字段
ALTER TABLE media_items ADD COLUMN media_source TEXT DEFAULT 'upload';

-- 新增合并视频源关系表
CREATE TABLE IF NOT EXISTS merged_video_sources (
  id TEXT PRIMARY KEY,
  merged_media_id TEXT NOT NULL,
  source_media_id TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (merged_media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_media_id) REFERENCES media_items(id) ON DELETE SET NULL
);
```

**无需手动执行 SQL**，应用启动时自动迁移。

## 环境变量变更

### 新增（必须）

| 变量 | 说明 | 何时需要 |
|------|------|----------|
| `JWT_SECRET` | JWT 签名密钥（至少 32 字符） | **生产环境必须设置**，否则启动失败 |

生成方式：
```bash
openssl rand -base64 32
```

### 已移除

| 变量 | 说明 |
|------|------|
| `VIDEO_AUTO_COMPILE_ENGINE` | 不再需要，autoCompile 始终执行 |

### 现有变量（无变化）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STORAGE_TYPE` | 存储类型 | `local` |
| `VIDEO_EDIT_AUTO` | 视频编辑阶段开关 | `false` |
| `VIDEO_ENHANCE_AUTO` | 视频增强阶段开关 | `false` |
| `AI_REVIEW_ENABLED` | LLM 去重审查开关 | `false` |

## AI 配置说明

项目支持两类 AI 功能，均为**可选**：

### 1. LLM 去重审查（Pipeline 内）

在去重阶段用 LLM 判断两张相似图片是否真的重复。

```env
AI_REVIEW_ENABLED=true
AI_PROVIDER=qwen                    # 或 openai
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL=qwen-vl-max
```

设置 `AI_REVIEW_ENABLED=false`（默认）则完全不调用 LLM，去重仅靠算法。

### 2. AI 智能编辑（用户手动触发）

通过前端 AI 编辑按钮触发，用于视频内容分析、剪辑方案生成、文本描述生成。

```env
AI_PROVIDER=qwen
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL=qwen-vl-max
```

如果未配置 AI provider，相关 API 返回 503，不影响其他功能。

### 支持的 AI Provider

| Provider | BASE_URL | 说明 |
|----------|----------|------|
| OpenAI | 默认（不设置） | 需要 OpenAI API key |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云 DashScope |
| 其他兼容 | 任意 OpenAI 兼容端点 | 如 DeepSeek、Moonshot 等 |

## 部署更新步骤

### 已有部署更新

```bash
# SSH 到服务器
ssh ec2-user@<your-ip>

# 进入项目目录
cd travel-album-site

# 拉取最新代码
git pull origin v2-smart-media

# 添加 JWT_SECRET 到 .env（重要！）
echo "JWT_SECRET=$(openssl rand -base64 32)" >> server/.env

# 重新构建
cd server && npm install && npm run build
cd ../client && npm install && npm run build

# 重启服务
pm2 restart all
```

### deploy/update.sh 变更

`update.sh` 已修改为拉取 `v2-smart-media` 分支（而非 main）。直接运行即可：

```bash
./deploy/update.sh <ec2-ip>
# 或在服务器上
./deploy/update.sh --local
```

**注意**：更新后需要手动添加 `JWT_SECRET` 环境变量到 `server/.env`，否则生产环境启动会失败。

### 安装脚本是否需要变更

- `deploy/setup.sh`：**无需变更**，现有脚本已包含 Node.js、ffmpeg、Python 环境安装
- `deploy/update.sh`：**已变更**（拉取 v2-smart-media 分支）
- `Dockerfile`：**无需变更**，但建议在 docker run 时传入 `-e JWT_SECRET=xxx`

### 新增系统依赖

**无**。本次更新不引入新的系统级依赖，ffmpeg 和 Node.js 仍是唯一必需项。

## 前端变更摘要

| 页面 | 变更 |
|------|------|
| MyGalleryPage | 视频区域分为"原始视频"/"剪辑视频"两个 Tab |
| GalleryPage | 仅展示编译/合并视频，使用 compiledUrl 播放 |
| GalleryPage | 视频下载使用编译版本 |

## API 变更摘要

### 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/media/merge` | 合并多个已编译视频 |

### 变更端点

| 方法 | 路径 | 变更 |
|------|------|------|
| POST | `/api/trips/:id/process` | **新增认证要求**（之前无需登录） |
| GET | `/api/trips/:id/process/stream` | **新增认证要求** |
| GET | `/api/my/trips/:id/gallery` | 响应新增 `originalVideos` 和 `compiledVideos` 字段 |
| GET | `/api/trips/:id/gallery` | 视频列表仅返回已编译/合并视频，新增 `compiledUrl` 字段 |

### 破坏性变更

⚠️ `POST /api/trips/:id/process` 现在需要认证。如果你有外部脚本直接调用此端点，需要添加 Bearer token。

## 回滚方案

如需回滚到 main 分支：

```bash
git checkout main
cd server && npm install && npm run build
cd ../client && npm install && npm run build
pm2 restart all
```

数据库新增的列和表不会影响旧版本运行（旧代码不读取这些字段）。
