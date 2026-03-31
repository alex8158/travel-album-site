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

# Start server with pm2
su - ec2-user -c "cd /home/ec2-user/travel-album-site/server && PORT=3001 pm2 start dist/index.js --name travel-album"
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
