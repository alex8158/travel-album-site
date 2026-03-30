# 🌍 旅行相册展示网站

批量上传旅行素材（图片和视频），系统自动识别文件类型、去重聚合、选择最佳质量图片，生成按旅行维度组织的响应式相册网站。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite (better-sqlite3)
- 图片处理：sharp (缩略图、感知哈希、质量评分)
- 视频处理：fluent-ffmpeg (帧提取)

## 本地开发

### 前置要求

- Node.js >= 18
- ffmpeg（视频帧提取需要）

macOS 安装 ffmpeg：
```bash
brew install ffmpeg
```

### 启动

```bash
# 后端
cd server
npm install
npm run dev

# 前端（另一个终端）
cd client
npm install
npm run dev
```

前端运行在 http://localhost:5173，后端运行在 http://localhost:3001。

### 运行测试

```bash
# 后端测试
cd server && npm test

# 前端测试
cd client && npm test
```

## 生产部署

### 方式一：直接部署

```bash
# 1. 构建前端
cd client
npm install
npm run build

# 2. 构建后端
cd ../server
npm install
npm run build

# 3. 启动（使用 pm2）
npm install -g pm2
PORT=3001 pm2 start dist/index.js --name travel-album
```

用 nginx 反向代理：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 500M;

    location / {
        root /path/to/travel-album-site/client/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 方式二：Docker 部署

```bash
docker build -t travel-album .
docker run -d -p 3001:3001 -v travel-data:/app/server/uploads travel-album
```

然后用 nginx 反向代理 3001 端口即可。

## 项目结构

```
├── client/          # React 前端
│   └── src/
│       ├── components/  # 通用组件（表单、上传、灯箱、播放器）
│       └── pages/       # 页面（首页、相册页、上传页）
├── server/          # Express 后端
│   └── src/
│       ├── routes/      # API 路由
│       ├── services/    # 业务逻辑（去重、质量评分、缩略图等）
│       └── middleware/  # 错误处理、日志
└── .kiro/specs/     # 需求、设计、任务文档
```
