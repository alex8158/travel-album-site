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

  log "重启服务..."
  pm2 restart travel-album || pm2 start "$APP_DIR/server/dist/index.js" --name travel-album

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

echo ">> 重启服务..."
pm2 restart travel-album || pm2 start "$APP_DIR/server/dist/index.js" --name travel-album

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
