# 🌍 旅行相册

批量上传旅行素材（图片和视频），系统自动去重、删除模糊照片、优化画质，生成按旅行维度组织的响应式相册网站。支持多用户、权限控制和可插拔存储后端。

## 功能概览

- 相册管理：创建旅行相册，批量并发上传图片/视频
- 智能处理流水线：
  - 去重：DINOv2 embedding + FAISS 聚类（ML 可用时），CLIP + pHash/dHash 回退
  - 模糊检测：Laplacian + MUSIQ 双条件判定，防止暗图/夜景误删
  - 质量评分：MUSIQ (IQA) + LAION aesthetic + 分辨率/曝光/文件大小加权
  - 自动优化：亮度/对比度/锐度保守调整，保留原始分辨率
  - 缩略图生成、视频分析与剪辑、封面自动选择
- 用户系统：注册审批、JWT 认证、管理员/普通用户角色
- 权限控制：资源所有权、素材公开/私有可见性
- 存储抽象：支持本地存储、AWS S3、阿里 OSS、腾讯 COS，可在线迁移
- 手动编辑：大图查看 + 手动调整亮度/对比度/锐度/伽马，支持从自动优化结果继续微调

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite (better-sqlite3)
- 认证：JWT + bcrypt
- 图片处理：sharp（Node.js）+ Python ML 模型
- 视频处理：fluent-ffmpeg
- 存储：本地 / AWS S3 / 阿里 OSS / 腾讯 COS

### ML 模型（可选，自动回退）

| 模型 | 用途 | 大小 |
|------|------|------|
| DINOv2-small | 图片 embedding 去重 | ~80MB |
| MUSIQ | 无参考图像质量评估 (IQA) | ~100MB |
| LAION aesthetic | 审美评分 | ~3MB |
| CLIP ViT-L/14 | 审美评分特征提取 | ~900MB |
| CLIP ViT-B/32 ONNX | 语义相似度（回退路径） | ~350MB |

ML 模型不可用时自动回退到传统算法（pHash/dHash + 六维评分 + Laplacian），无需额外配置。

## 快速开始

### 前置要求

- Node.js >= 18
- Python >= 3.10（ML 功能需要，可选）
- ffmpeg（视频处理需要）

```bash
# macOS
brew install ffmpeg python@3.11

# Amazon Linux 2023
sudo yum install -y ffmpeg python3.11 python3.11-pip
```

### 本地开发

```bash
git clone https://github.com/alex8158/travel-album-site.git
cd travel-album-site

# 后端
cd server
npm install
npm run dev

# 前端（另一个终端）
cd client
npm install
npm run dev
```

前端：http://localhost:5173 ，后端：http://localhost:3001

首次启动自动创建管理员：用户名 `admin`，密码 `P8ssw2rd`，登录后请立即修改。

### Python ML 环境（可选）

```bash
cd server/python

# 创建虚拟环境（推荐 Python 3.11+）
python3.11 -m venv .venv
source .venv/bin/activate

# 安装依赖
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install pyiqa faiss-cpu transformers Pillow opencv-python-headless numpy
pip install git+https://github.com/openai/CLIP.git

# 验证
python -c "import torch; import pyiqa; import faiss; print('ML OK')"
```

Node.js 会自动检测 `server/python/.venv/bin/python`，找到就用 venv，找不到就用系统 `python3`。

### 运行测试

```bash
cd server && npm test    # 后端
cd client && npm test    # 前端
```

## 处理流水线

上传完成后自动触发 9 步处理流水线（SSE 实时进度推送）：

```
1. 模糊检测 → 2. 去重 → 3. 图像分析 → 4. 自动优化
→ 5. 分类 → 6. 缩略图 → 7. 视频分析 → 8. 视频剪辑 → 9. 封面选择
```

### 去重引擎（四层混合）

| 层级 | 方法 | 说明 |
|------|------|------|
| Layer 0 | MD5 + pHash + dHash | 精确匹配 + 低距离哈希 |
| Layer 1 | DINOv2 + FAISS / CLIP | 语义相似度聚类（ML 优先） |
| Layer 2 | Strict Threshold | 灰区对回退判定（similarity ≥ 0.955） |
| Layer 3 | Union-Find + 质量选择 | 分组后保留最佳，其余移入回收站 |

LLM 逐对审查（Layer 2 可选）支持 OpenAI / Bedrock / DashScope，通过 `AI_REVIEW_ENABLED` 控制开关。

## 环境变量

复制 `server/.env.example` 为 `server/.env`，按需修改。主要配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3001` |
| `STORAGE_TYPE` | 存储类型：`local` / `s3` / `oss` / `cos` | `local` |
| `AI_REVIEW_ENABLED` | LLM 去重审查开关 | `false` |
| `DINOV2_DEDUP_THRESHOLD` | DINOv2 去重相似度阈值 | `0.92` |
| `MUSIQ_BLUR_THRESHOLD` | MUSIQ 模糊判定阈值 | `30` |

完整配置见 `server/.env.example`。

## 生产部署

### 服务器配置建议

| 规模 | CPU | 内存 | 磁盘 | 参考实例 |
|------|-----|------|------|----------|
| 个人使用（~50 次旅行） | 2 核 | 2 GB | 40 GB SSD | t3.small |
| 小团队（~200 次旅行） | 2 核 | 4 GB | 100 GB SSD | t3.medium |
| ML 模型启用 | 2 核 | 4 GB+ | 50 GB+ SSD | t3.medium |

ML 模型首次加载需要约 4-5GB 磁盘空间（模型权重缓存）。

### AWS EC2 一键部署

```bash
./deploy/create-ec2.sh
```

### 更新部署

```bash
# 远程更新
./deploy/update.sh <ec2-ip>

# 或 SSH 到服务器后
./deploy/update.sh --local
```

`update.sh` 自动执行：拉代码 → 编译 → 构建前端 → 创建 Python venv → 安装 ML 依赖 → 预热模型 → 重启 pm2。

### Docker 部署

```bash
docker build -t travel-album .
docker run -d -p 3001:3001 -v travel-data:/app/server/uploads travel-album
```

## 项目结构

```
├── client/                  # React 前端
│   └── src/
│       ├── components/      # FileUploader, Lightbox, ImageEditor, VideoPlayer...
│       ├── contexts/        # AuthContext
│       └── pages/           # HomePage, GalleryPage, UploadPage, AdminPage...
├── server/                  # Express 后端
│   ├── src/
│   │   ├── routes/          # auth, trips, media, process, gallery, trash...
│   │   ├── services/        # hybridDedupEngine, qualitySelector, blurDetector,
│   │   │                    # imageOptimizer, mlQualityService, llmPairReviewer...
│   │   ├── storage/         # localProvider, s3Provider, ossProvider, cosProvider
│   │   ├── middleware/      # auth, errorHandler, logger
│   │   └── helpers/         # pythonPath, tempPathCache, mediaItemRow...
│   └── python/              # ML 质量服务
│       ├── quality_service.py  # DINOv2 + MUSIQ + LAION aesthetic
│       ├── analyze.py          # CLIP ONNX 分析 + 模糊检测 + 分类
│       └── .venv/              # Python 虚拟环境（自动创建）
├── deploy/                  # 部署脚本
│   ├── setup.sh             # EC2 初始化（含 Python venv + ML 模型）
│   ├── update.sh            # 更新部署
│   └── create-ec2.sh        # EC2 创建
└── Dockerfile
```

## API 概览

### 公开接口
- `POST /api/auth/login` — 登录
- `POST /api/auth/register` — 注册
- `GET /api/trips` — 公开相册列表
- `GET /api/trips/:id/gallery` — 相册详情

### 需认证接口
- `POST /api/trips` — 创建相册
- `POST /api/trips/:id/media` — 上传素材（并发 3）
- `GET /api/trips/:id/process/stream` — SSE 处理进度
- `POST /api/media/:id/edit` — 手动编辑图片
- `PUT /api/media/:id/visibility` — 修改可见性

### 管理员接口
- `GET /api/admin/users` — 用户管理
- `POST /api/admin/storage/migrate` — 存储迁移
