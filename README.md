# 🌍 旅行相册

批量上传旅行素材（图片和视频），系统自动识别文件类型、去重聚合、选择最佳质量图片，生成按旅行维度组织的响应式相册网站。支持多用户、权限控制和可插拔存储后端。

## 功能概览

- 相册管理：创建旅行相册，批量上传图片/视频
- 智能处理：自动去重、模糊检测、质量评分、缩略图生成、视频剪辑
- 用户系统：注册审批、JWT 认证、管理员/普通用户角色
- 权限控制：资源所有权、素材公开/私有可见性
- 存储抽象：支持本地存储、AWS S3、阿里 OSS、腾讯 COS，可在线迁移
- 自动标签：上传时自动生成标签，支持按标签筛选

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite (better-sqlite3)
- 认证：JWT (jsonwebtoken) + bcrypt
- 图片处理：sharp
- 视频处理：fluent-ffmpeg
- 存储：本地 / AWS S3 / 阿里 OSS / 腾讯 COS

## 快速开始

### 前置要求

- Node.js >= 18
- ffmpeg（视频处理需要）

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### 本地开发

```bash
# 克隆项目
git clone https://github.com/alex8158/travel-album-site.git
cd travel-album-site

# 启动后端
cd server
npm install
npm run dev

# 启动前端（另一个终端）
cd client
npm install
npm run dev
```

前端：http://localhost:5173 ，后端：http://localhost:3001

首次启动会自动创建默认管理员账户：
- 用户名：`admin`
- 密码：`P8ssw2rd`
- 登录后请立即修改密码

### 运行测试

```bash
# 后端测试（313 tests）
cd server && npm test

# 前端测试（130 tests）
cd client && npm test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3001` |
| `JWT_SECRET` | JWT 签名密钥 | `travel-album-secret-key` |
| `STORAGE_TYPE` | 存储类型：`local` / `s3` / `oss` / `cos` | `local` |
| `LOCAL_STORAGE_PATH` | 本地存储路径 | `./uploads` |
| `S3_BUCKET` | AWS S3 桶名 | - |
| `S3_REGION` | AWS S3 区域 | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS 访问密钥 | - |
| `AWS_SECRET_ACCESS_KEY` | AWS 密钥 | - |
| `OSS_BUCKET` | 阿里 OSS 桶名 | - |
| `OSS_REGION` | 阿里 OSS 区域 | `oss-cn-hangzhou` |
| `OSS_ACCESS_KEY_ID` | 阿里云访问密钥 | - |
| `OSS_ACCESS_KEY_SECRET` | 阿里云密钥 | - |
| `COS_BUCKET` | 腾讯 COS 桶名 | - |
| `COS_REGION` | 腾讯 COS 区域 | `ap-guangzhou` |
| `COS_SECRET_ID` | 腾讯云密钥 ID | - |
| `COS_SECRET_KEY` | 腾讯云密钥 | - |

生产环境务必修改 `JWT_SECRET`。

## 生产部署

### 服务器配置建议

| 规模 | CPU | 内存 | 磁盘 | 参考实例 |
|------|-----|------|------|----------|
| 个人使用（~50 次旅行） | 1 核 | 1 GB | 40 GB SSD | 轻量云 1C1G |
| 小团队（~200 次旅行） | 2 核 | 2 GB | 100 GB SSD | ECS 2C2G / t3.small |
| 中等规模（~1000 次旅行） | 2 核 | 4 GB | 200+ GB SSD | ECS 2C4G / t3.medium |

### 方式一：直接部署

```bash
# 构建前端
cd client
npm install
npm run build

# 构建后端并复制前端产物
cd ../server
npm install
npx tsc
cp -r ../client/dist public

# 启动
npm install -g pm2
JWT_SECRET=your-secret PORT=3001 pm2 start dist/index.js --name travel-album
```

nginx 反向代理配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }
}
```

### 方式二：Docker 部署

```bash
docker build -t travel-album .
docker run -d \
  -p 3001:3001 \
  -e JWT_SECRET=your-secret \
  -e STORAGE_TYPE=local \
  -v travel-data:/app/server/uploads \
  travel-album
```

### 方式三：AWS EC2 一键部署

```bash
# 创建 EC2 实例并自动部署
./deploy/create-ec2.sh
```

### 更新部署

从本地通过 SSH 远程更新：

```bash
./deploy/update.sh <ec2-ip>
```

或 SSH 到服务器后本地执行：

```bash
cd /home/ec2-user/travel-album-site
./deploy/update.sh --local
```

首次更新（服务器上还没有 update.sh 时），需要先手动拉取代码：

```bash
cd /home/ec2-user/travel-album-site
git fetch origin main
git reset --hard origin/main
./deploy/update.sh --local
```

update.sh 会自动执行：git fetch + reset → npm install → 编译后端 → 构建前端 → 复制产物 → 重启 pm2。数据库迁移在服务启动时自动完成。

### 配置存储

部署时会自动从 `.env.example` 创建 `server/.env` 配置文件。默认使用本地存储，无需修改。

如需使用云存储，编辑 `server/.env`，取消对应存储的注释并填写凭证：

```bash
# SSH 到服务器
vi /home/ec2-user/travel-album-site/server/.env

# 例如启用 S3，修改以下行：
STORAGE_TYPE=s3
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# 保存后重启服务
pm2 restart travel-album
```

修改后在管理后台「存储管理」区域可以看到对应存储显示为「已配置」。

### 从本地存储迁移到云存储

如果已经在本地存储了相册数据，想迁移到云存储：

1. 在 `server/.env` 中配置好目标云存储的凭证（但先不要改 `STORAGE_TYPE`）
2. 重启服务：`pm2 restart travel-album`
3. 用管理员账户登录管理后台，在「存储管理」区域确认目标存储显示「已配置」
4. 选择目标存储，点击「开始迁移」，等待迁移完成
5. 迁移成功后，修改 `server/.env` 中的 `STORAGE_TYPE` 为目标类型
6. 再次重启服务：`pm2 restart travel-album`

迁移过程中服务不会中断，单个文件失败不影响其他文件。迁移完成后会显示成功/失败数量。

## 项目结构

```
├── client/                # React 前端
│   └── src/
│       ├── components/    # 通用组件
│       ├── contexts/      # AuthContext（认证状态管理）
│       └── pages/         # 页面（首页、相册、登录、注册、用户空间、管理后台）
├── server/                # Express 后端
│   └── src/
│       ├── routes/        # API 路由（auth、admin、trips、media、gallery、trash、users）
│       ├── services/      # 业务逻辑（认证、用户、去重、标签、迁移等）
│       ├── storage/       # 存储抽象层（local、S3、OSS、COS）
│       ├── middleware/     # 认证中间件、错误处理
│       └── helpers/       # 数据转换
├── deploy/                # 部署脚本
│   ├── setup.sh           # EC2 初始化脚本
│   ├── update.sh          # 更新部署脚本
│   └── create-ec2.sh      # EC2 创建脚本
└── Dockerfile             # Docker 构建文件
```

## API 概览

### 公开接口
- `POST /api/auth/login` — 登录
- `POST /api/auth/register` — 注册（需管理员审批）
- `GET /api/trips` — 公开相册列表
- `GET /api/trips/:id/gallery` — 相册详情（公开素材）

### 需认证接口
- `PUT /api/auth/password` — 修改密码
- `DELETE /api/auth/account` — 注销账户
- `POST /api/trips` — 创建相册
- `POST /api/trips/:id/media` — 上传素材
- `GET /api/users/me/trips` — 我的相册
- `PUT /api/media/:id/visibility` — 修改素材可见性

### 管理员接口
- `GET /api/admin/users` — 用户列表
- `PUT /api/admin/users/:id/approve` — 审批用户
- `PUT /api/admin/users/:id/promote` — 提升管理员
- `POST /api/admin/storage/migrate` — 存储迁移
