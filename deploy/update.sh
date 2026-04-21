#!/bin/bash
# 更新部署脚本：拉取最新代码，重新构建，重启服务
# 用法: ./deploy/update.sh [ec2-ip]
# 或者直接在服务器上运行: ./deploy/update.sh --local
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_FILE="$SCRIPT_DIR/travel-album-key.pem"
APP_DIR="/home/ec2-user/travel-album-site"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}>> $1${NC}"; }
warn() { echo -e "${YELLOW}>> $1${NC}"; }
err() { echo -e "${RED}>> $1${NC}"; exit 1; }

do_update() {
  log "拉取最新代码..."
  cd "$APP_DIR"
  git fetch origin main
  git reset --hard origin/main

  # 首次部署时自动创建 .env 配置文件
  if [ ! -f "$APP_DIR/server/.env" ]; then
    log "创建默认配置文件 server/.env ..."
    cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
    warn "请编辑 server/.env 配置存储方式和云存储凭证（默认使用本地存储）"
  fi

  log "安装服务端依赖..."
  cd "$APP_DIR/server"
  npm install

  log "编译服务端..."
  npx tsc

  log "安装客户端依赖..."
  cd "$APP_DIR/client"
  npm install

  log "构建客户端..."
  npm run build

  log "复制客户端构建产物到服务端..."
  rm -rf "$APP_DIR/server/public"
  cp -r "$APP_DIR/client/dist" "$APP_DIR/server/public"

  # Python 虚拟环境（使用 Python 3.11 如果可用，否则 python3）
  VENV_DIR="$APP_DIR/server/python/.venv"
  log "配置 Python 虚拟环境..."

  # 尝试找到最高版本的 Python
  PYTHON_BIN=""
  for py in python3.12 python3.11 python3.10 python3; do
    if command -v "$py" &>/dev/null; then
      PYTHON_BIN="$py"
      break
    fi
  done

  if [ -z "$PYTHON_BIN" ]; then
    warn "Python3 未安装，正在安装..."
    if command -v yum &>/dev/null; then
      sudo yum install -y python3.11 python3.11-pip 2>/dev/null || sudo yum install -y python3 python3-pip
    elif command -v apt-get &>/dev/null; then
      sudo apt-get update && sudo apt-get install -y python3.11 python3.11-venv 2>/dev/null || sudo apt-get install -y python3 python3-venv
    fi
    for py in python3.12 python3.11 python3.10 python3; do
      if command -v "$py" &>/dev/null; then
        PYTHON_BIN="$py"
        break
      fi
    done
  fi

  if [ -n "$PYTHON_BIN" ]; then
    log "使用 Python: $($PYTHON_BIN --version)"

    # 创建或复用虚拟环境
    if [ ! -f "$VENV_DIR/bin/python" ]; then
      log "创建虚拟环境: $VENV_DIR"
      $PYTHON_BIN -m venv "$VENV_DIR"
    fi

    VENV_PIP="$VENV_DIR/bin/pip"
    VENV_PYTHON="$VENV_DIR/bin/python"

    # 升级 pip
    $VENV_PYTHON -m pip install --upgrade pip --quiet

    # 基础依赖
    log "安装基础 Python 依赖..."
    $VENV_PIP install transformers optimum onnxruntime Pillow opencv-python-headless numpy --quiet

    # ML 依赖（CPU-only torch）
    log "安装 ML 依赖（CPU-only torch）..."
    if ! $VENV_PYTHON -c "import torch" 2>/dev/null; then
      log "首次安装 torch + torchvision (CPU-only)..."
      $VENV_PIP install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet
    else
      log "torch 已安装，跳过"
    fi
    $VENV_PIP install pyiqa faiss-cpu --quiet
    if ! $VENV_PYTHON -c "import clip" 2>/dev/null; then
      log "安装 OpenAI CLIP..."
      $VENV_PIP install git+https://github.com/openai/CLIP.git --quiet
    else
      log "CLIP 已安装，跳过"
    fi

    # CLIP ONNX 模型
    ONNX_DIR="$APP_DIR/server/python/models/clip-vit-base-patch32-onnx"
    if [ ! -d "$ONNX_DIR" ] || [ ! -f "$ONNX_DIR/config.json" ]; then
      log "首次部署：下载并导出 CLIP ONNX 模型..."
      $VENV_PYTHON "$APP_DIR/server/python/prepare_model.py"
    else
      log "CLIP ONNX 模型已存在，跳过下载"
    fi

    # 预热 ML 模型
    log "检测 ML 模型..."
    if $VENV_PYTHON -c "import torch; import pyiqa; import faiss" 2>/dev/null; then
      AESTHETIC_PATH="$APP_DIR/server/python/models/sac+logos+ava1-l14-linearMSE.pth"
      if [ ! -f "$AESTHETIC_PATH" ]; then
        log "首次部署：预下载 ML 模型..."
        $VENV_PYTHON -c "
import sys
sys.path.insert(0, '$APP_DIR/server/python')
from quality_service import _load_dinov2, _load_musiq, _load_aesthetic
_load_dinov2(); _load_musiq(); _load_aesthetic()
print('All ML models ready.', file=sys.stderr)
" 2>&1 | while read line; do log "$line"; done
      else
        log "ML 模型已缓存，跳过下载"
      fi
      log "ML 质量服务可用"
    else
      warn "ML 依赖不完整，将使用传统算法"
    fi
  else
    warn "Python3 不可用，将使用 Node.js 回退算法"
  fi

  # 更新 Nginx 配置（SSE 长连接需要更长超时）
  log "更新 Nginx 配置..."
  NGINX_CONF=""
  if [ -f /etc/nginx/sites-available/default ]; then
    NGINX_CONF="/etc/nginx/sites-available/default"
  elif [ -d /etc/nginx/conf.d ]; then
    NGINX_CONF="/etc/nginx/conf.d/travel-album.conf"
  fi
  if [ -n "$NGINX_CONF" ]; then
    sudo tee "$NGINX_CONF" > /dev/null << 'NGINX'
server {
    listen 80;
    server_name _;

    client_max_body_size 2g;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
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
    sudo nginx -t && sudo systemctl reload nginx
    log "Nginx 配置已更新（proxy_read_timeout=1800s）"
  fi

  log "重启服务..."
  pm2 delete travel-album 2>/dev/null || true
  pm2 start "$APP_DIR/server/dist/index.js" --name travel-album --cwd "$APP_DIR/server"

  log "部署完成！"
  pm2 status
}

if [ "$1" = "--local" ]; then
  # 直接在服务器上运行
  do_update
elif [ -n "$1" ]; then
  # 通过 SSH 远程执行
  EC2_IP="$1"

  if [ ! -f "$KEY_FILE" ]; then
    err "密钥文件不存在: $KEY_FILE"
  fi

  log "连接到 $EC2_IP 执行更新..."
  ssh -i "$KEY_FILE" -o StrictHostKeyChecking=no ec2-user@"$EC2_IP" "bash -s" << 'REMOTE'
set -e
APP_DIR="/home/ec2-user/travel-album-site"

echo ">> 拉取最新代码..."
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

# 首次部署时自动创建 .env 配置文件
if [ ! -f "$APP_DIR/server/.env" ]; then
  echo ">> 创建默认配置文件 server/.env ..."
  cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
  echo ">> 注意：请编辑 server/.env 配置存储方式和云存储凭证（默认使用本地存储）"
fi

echo ">> 安装服务端依赖..."
cd "$APP_DIR/server"
npm install

echo ">> 编译服务端..."
npx tsc

echo ">> 安装客户端依赖..."
cd "$APP_DIR/client"
npm install

echo ">> 构建客户端..."
npm run build

echo ">> 复制客户端构建产物..."
rm -rf "$APP_DIR/server/public"
cp -r "$APP_DIR/client/dist" "$APP_DIR/server/public"

# Python 虚拟环境
VENV_DIR="$APP_DIR/server/python/.venv"
echo ">> 配置 Python 虚拟环境..."

PYTHON_BIN=""
for py in python3.12 python3.11 python3.10 python3; do
  if command -v "$py" &>/dev/null; then
    PYTHON_BIN="$py"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo ">> Python3 未安装，正在安装..."
  if command -v yum &>/dev/null; then
    sudo yum install -y python3.11 python3.11-pip 2>/dev/null || sudo yum install -y python3 python3-pip
  elif command -v apt-get &>/dev/null; then
    sudo apt-get update && sudo apt-get install -y python3.11 python3.11-venv 2>/dev/null || sudo apt-get install -y python3 python3-venv
  fi
  for py in python3.12 python3.11 python3.10 python3; do
    if command -v "$py" &>/dev/null; then
      PYTHON_BIN="$py"
      break
    fi
  done
fi

if [ -n "$PYTHON_BIN" ]; then
  echo ">> 使用 Python: $($PYTHON_BIN --version)"

  if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo ">> 创建虚拟环境: $VENV_DIR"
    $PYTHON_BIN -m venv "$VENV_DIR"
  fi

  VENV_PIP="$VENV_DIR/bin/pip"
  VENV_PYTHON="$VENV_DIR/bin/python"

  $VENV_PYTHON -m pip install --upgrade pip --quiet

  echo ">> 安装基础 Python 依赖..."
  $VENV_PIP install transformers optimum onnxruntime Pillow opencv-python-headless numpy --quiet

  echo ">> 安装 ML 依赖（CPU-only torch）..."
  if ! $VENV_PYTHON -c "import torch" 2>/dev/null; then
    echo ">> 首次安装 torch + torchvision (CPU-only)..."
    $VENV_PIP install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet
  else
    echo ">> torch 已安装，跳过"
  fi
  $VENV_PIP install pyiqa faiss-cpu --quiet
  if ! $VENV_PYTHON -c "import clip" 2>/dev/null; then
    echo ">> 安装 OpenAI CLIP..."
    $VENV_PIP install git+https://github.com/openai/CLIP.git --quiet
  else
    echo ">> CLIP 已安装，跳过"
  fi

  ONNX_DIR="$APP_DIR/server/python/models/clip-vit-base-patch32-onnx"
  if [ ! -d "$ONNX_DIR" ] || [ ! -f "$ONNX_DIR/config.json" ]; then
    echo ">> 首次部署：下载并导出 CLIP ONNX 模型..."
    $VENV_PYTHON "$APP_DIR/server/python/prepare_model.py"
  else
    echo ">> CLIP ONNX 模型已存在，跳过下载"
  fi

  echo ">> 检测 ML 模型..."
  if $VENV_PYTHON -c "import torch; import pyiqa; import faiss" 2>/dev/null; then
    AESTHETIC_PATH="$APP_DIR/server/python/models/sac+logos+ava1-l14-linearMSE.pth"
    if [ ! -f "$AESTHETIC_PATH" ]; then
      echo ">> 首次部署：预下载 ML 模型..."
      $VENV_PYTHON -c "
import sys
sys.path.insert(0, '$APP_DIR/server/python')
from quality_service import _load_dinov2, _load_musiq, _load_aesthetic
_load_dinov2(); _load_musiq(); _load_aesthetic()
print('All ML models ready.', file=sys.stderr)
"
    else
      echo ">> ML 模型已缓存，跳过下载"
    fi
    echo ">> ML 质量服务可用"
  else
    echo ">> 警告：ML 依赖不完整，将使用传统算法"
  fi
else
  echo ">> 警告：Python3 不可用，将使用 Node.js 回退算法"
fi

echo ">> 更新 Nginx 配置..."
NGINX_CONF=""
if [ -f /etc/nginx/sites-available/default ]; then
  NGINX_CONF="/etc/nginx/sites-available/default"
elif [ -d /etc/nginx/conf.d ]; then
  NGINX_CONF="/etc/nginx/conf.d/travel-album.conf"
fi
if [ -n "$NGINX_CONF" ]; then
  sudo tee "$NGINX_CONF" > /dev/null << 'NGINX'
server {
    listen 80;
    server_name _;

    client_max_body_size 2g;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
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
  sudo nginx -t && sudo systemctl reload nginx
  echo ">> Nginx 配置已更新"
fi

echo ">> 重启服务..."
pm2 delete travel-album 2>/dev/null || true
pm2 start "$APP_DIR/server/dist/index.js" --name travel-album --cwd "$APP_DIR/server"

echo ">> 部署完成！"
pm2 status
REMOTE

  log "远程更新完成！"
else
  echo "用法:"
  echo "  远程部署: $0 <ec2-ip>"
  echo "  本地部署: $0 --local"
  exit 1
fi
