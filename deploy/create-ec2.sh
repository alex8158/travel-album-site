#!/bin/bash
# Creates an EC2 t3.medium instance in us-east-1 with security group and deploys the app

PROFILE="default"
REGION="us-east-1"
INSTANCE_TYPE="t3.medium"
KEY_NAME="travel-album-key"
SG_NAME="travel-album-sg"
SUBNET_ID="subnet-018e3ecde367abbaa"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== 旅行相册网站 EC2 部署 ==="

# 1. Verify key pair exists
echo ">> 检查密钥对..."
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" \
  --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "   密钥对已就绪: $KEY_NAME"
else
  echo "   错误: 密钥对 $KEY_NAME 不存在，请先创建"
  echo "   aws ec2 create-key-pair --key-name $KEY_NAME --query KeyMaterial --output text --profile $PROFILE --region $REGION > $SCRIPT_DIR/$KEY_NAME.pem"
  exit 1
fi

# 2. Get VPC from subnet
echo ">> 获取子网所属 VPC..."
VPC_ID=$(aws ec2 describe-subnets --subnet-ids "$SUBNET_ID" \
  --query 'Subnets[0].VpcId' --output text \
  --profile "$PROFILE" --region "$REGION")

if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "   错误: 未找到子网 $SUBNET_ID 对应的 VPC"
  exit 1
fi
echo "   VPC: $VPC_ID (子网: $SUBNET_ID)"

# 3. Create security group (if not exists)
echo ">> 创建安全组..."
SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text \
  --profile "$PROFILE" --region "$REGION" 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "Travel album website security group" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text \
    --profile "$PROFILE" --region "$REGION")

  if [ -z "$SG_ID" ]; then
    echo "   错误: 创建安全组失败"
    exit 1
  fi

  # Allow SSH
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0 \
    --profile "$PROFILE" --region "$REGION" 2>/dev/null

  # Allow HTTP
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 \
    --profile "$PROFILE" --region "$REGION" 2>/dev/null

  # Allow HTTPS
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 \
    --profile "$PROFILE" --region "$REGION" 2>/dev/null

  echo "   安全组已创建: $SG_ID"
else
  echo "   安全组已存在: $SG_ID"
fi

# 4. Get latest Amazon Linux 2023 AMI
echo ">> 获取最新 AMI..."
AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text \
  --profile "$PROFILE" --region "$REGION")

if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
  echo "   错误: 未找到 AMI"
  exit 1
fi
echo "   AMI: $AMI_ID"

# 5. Launch instance
echo ">> 启动 EC2 实例 ($INSTANCE_TYPE)..."
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]' \
  --user-data "file://$SCRIPT_DIR/setup.sh" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=travel-album-site}]" \
  --query 'Instances[0].InstanceId' --output text \
  --profile "$PROFILE" --region "$REGION")

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "   错误: 启动实例失败"
  exit 1
fi
echo "   实例 ID: $INSTANCE_ID"

# 6. Wait for instance to be running
echo ">> 等待实例启动..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" \
  --profile "$PROFILE" --region "$REGION"

# 7. Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text \
  --profile "$PROFILE" --region "$REGION")

echo ""
echo "=== 部署完成 ==="
echo "实例 ID:  $INSTANCE_ID"
echo "公网 IP:  $PUBLIC_IP"
echo "SSH 连接: ssh -i $SCRIPT_DIR/$KEY_NAME.pem ec2-user@$PUBLIC_IP"
echo "网站地址: http://$PUBLIC_IP"
echo ""
echo "注意: user-data 脚本正在后台安装环境和部署应用，大约需要 5-10 分钟。"
echo "可以通过 SSH 登录后查看进度: tail -f /var/log/cloud-init-output.log"
echo "部署完成后会生成 /home/ec2-user/deploy-status.txt 文件。"
