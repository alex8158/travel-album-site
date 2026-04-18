#!/bin/bash
# EC2 user-data script: installs Node.js, ffmpeg, nginx, clones repo and starts the app
set -e

# Update system
yum update -y

# Install Node.js 18
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Install ffmpeg
yum install -y ffmpeg || {
  # Amazon Linux 2023 may need EPEL or manual install
  cd /tmp
  curl -L -o ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar xf ffmpeg.tar.xz
  cp ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/
  cp ffmpeg-*-amd64-static/ffprobe /usr/local/bin/
  chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
}

# Install nginx and git
yum install -y nginx git

# Install Python3 and pip
yum install -y python3 python3-pip || {
  echo "Python3 安装失败，ML 功能将不可用"
}

# Install pm2
npm install -g pm2

# Clone repo
cd /home/ec2-user
git clone https://github.com/alex8158/travel-album-site.git
cd travel-album-site

# Set permissions
chown -R ec2-user:ec2-user /home/ec2-user/travel-album-site

# Build client
cd client
npm install
npm run build
cd ..

# Build server and copy client build
cd server
npm install
npx tsc
cp -r ../client/dist public
cd ..

# Create uploads directory
mkdir -p server/uploads/frames
chown -R ec2-user:ec2-user /home/ec2-user/travel-album-site

# Create .env from example (首次部署)
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo ">> 已创建 server/.env（默认 AI_REVIEW_ENABLED=false，不调用 LLM）"
fi

# Python 依赖安装
if command -v python3 &>/dev/null; then
  echo ">> Python 版本: $(python3 --version)"

  # 确保 pip 可用
  python3 -m pip --version &>/dev/null || python3 -m ensurepip --upgrade 2>/dev/null || curl -sS https://bootstrap.pypa.io/get-pip.py | python3

  # 基础 Python 依赖
  echo ">> 安装基础 Python 依赖..."
  python3 -m pip install transformers optimum onnxruntime Pillow opencv-python-headless numpy --quiet

  # ML 依赖（CPU-only torch）
  echo ">> 安装 ML 依赖（CPU-only torch）..."
  python3 -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet
  python3 -m pip install pyiqa faiss-cpu --quiet
  python3 -m pip install git+https://github.com/openai/CLIP.git --quiet

  # CLIP ONNX 模型
  ONNX_DIR="/home/ec2-user/travel-album-site/server/python/models/clip-vit-base-patch32-onnx"
  if [ ! -d "$ONNX_DIR" ] || [ ! -f "$ONNX_DIR/config.json" ]; then
    echo ">> 下载 CLIP ONNX 模型..."
    python3 /home/ec2-user/travel-album-site/server/python/prepare_model.py
  fi

  # 预热 ML 模型（DINOv2、MUSIQ、LAION aesthetic）
  if python3 -c "import torch; import pyiqa; import faiss" 2>/dev/null; then
    echo ">> 预下载 ML 模型..."
    python3 -c "
import sys
sys.path.insert(0, '/home/ec2-user/travel-album-site/server/python')
from quality_service import _load_dinov2, _load_musiq, _load_aesthetic
_load_dinov2()
_load_musiq()
_load_aesthetic()
print('All ML models ready.')
" 2>&1
    echo ">> ML 质量服务就绪"
  else
    echo ">> 警告：ML 依赖不完整，将使用传统算法"
  fi
else
  echo ">> 警告：Python3 不可用，将使用 Node.js 回退算法"
fi

# Start server with pm2
su - ec2-user -c "cd /home/ec2-user/travel-album-site/server && PORT=3001 pm2 start dist/index.js --name travel-album --cwd /home/ec2-user/travel-album-site/server"
su - ec2-user -c "pm2 save"
su - ec2-user -c "pm2 startup systemd -u ec2-user --hp /home/ec2-user | tail -1 | bash"

# Configure nginx
cat > /etc/nginx/conf.d/travel-album.conf << 'NGINX'
server {
    listen 80;
    server_name _;

    client_max_body_size 500M;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX

# Remove default nginx config if it conflicts
rm -f /etc/nginx/conf.d/default.conf

# Start nginx
systemctl enable nginx
systemctl start nginx

echo "Deployment complete!" > /home/ec2-user/deploy-status.txt
