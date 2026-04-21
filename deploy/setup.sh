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

# Install Python 3.11+ and pip
yum install -y python3.11 python3.11-pip 2>/dev/null || yum install -y python3 python3-pip || {
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

# Python 虚拟环境
APP_DIR="/home/ec2-user/travel-album-site"
VENV_DIR="$APP_DIR/server/python/.venv"

PYTHON_BIN=""
for py in python3.12 python3.11 python3.10 python3; do
  if command -v "$py" &>/dev/null; then
    PYTHON_BIN="$py"
    break
  fi
done

if [ -n "$PYTHON_BIN" ]; then
  echo ">> 使用 Python: $($PYTHON_BIN --version)"
  $PYTHON_BIN -m venv "$VENV_DIR"
  VENV_PIP="$VENV_DIR/bin/pip"
  VENV_PYTHON="$VENV_DIR/bin/python"

  $VENV_PYTHON -m pip install --upgrade pip --quiet

  echo ">> 安装基础 Python 依赖..."
  $VENV_PIP install transformers optimum onnxruntime Pillow opencv-python-headless numpy --quiet

  echo ">> 安装 ML 依赖（CPU-only torch）..."
  $VENV_PIP install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet
  $VENV_PIP install pyiqa faiss-cpu --quiet
  $VENV_PIP install git+https://github.com/openai/CLIP.git --quiet

  ONNX_DIR="$APP_DIR/server/python/models/clip-vit-base-patch32-onnx"
  if [ ! -d "$ONNX_DIR" ] || [ ! -f "$ONNX_DIR/config.json" ]; then
    echo ">> 下载 CLIP ONNX 模型..."
    $VENV_PYTHON "$APP_DIR/server/python/prepare_model.py"
  fi

  if $VENV_PYTHON -c "import torch; import pyiqa; import faiss" 2>/dev/null; then
    echo ">> 预下载 ML 模型..."
    $VENV_PYTHON -c "
import sys
sys.path.insert(0, '$APP_DIR/server/python')
from quality_service import _load_dinov2, _load_musiq, _load_aesthetic
_load_dinov2(); _load_musiq(); _load_aesthetic()
print('All ML models ready.')
" 2>&1
    echo ">> ML 质量服务就绪"
  else
    echo ">> 警告：ML 依赖不完整，将使用传统算法"
  fi

  chown -R ec2-user:ec2-user "$VENV_DIR"
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

    client_max_body_size 2g;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        proxy_buffering off;
        proxy_cache off;
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
