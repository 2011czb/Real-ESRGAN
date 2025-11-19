#!/bin/bash
# Real-ESRGAN 快速部署脚本

set -e

echo "=========================================="
echo "Real-ESRGAN 云端服务器部署脚本"
echo "=========================================="

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 Python3，请先安装 Python 3.7+"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f1,2)
echo "✓ Python 版本: $PYTHON_VERSION"

# 检查 CUDA（可选）
if command -v nvidia-smi &> /dev/null; then
    echo "✓ 检测到 NVIDIA GPU"
    nvidia-smi --query-gpu=name --format=csv,noheader | head -1
else
    echo "⚠ 未检测到 NVIDIA GPU，将使用 CPU（速度较慢）"
fi

# 安装依赖
echo ""
echo "正在安装依赖..."
pip3 install -r requirements.txt
pip3 install -r requirements_api.txt

# 创建必要的目录
echo ""
echo "创建必要的目录..."
mkdir -p weights
mkdir -p inputs
mkdir -p results

# 检查模型文件
echo ""
echo "检查模型文件..."
if [ ! -f "weights/RealESRGAN_x4plus.pth" ]; then
    echo "⚠ 模型文件不存在，将在首次使用时自动下载"
else
    echo "✓ 模型文件已存在"
fi

# 创建 systemd 服务文件（可选）
read -p "是否创建 systemd 服务？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    SERVICE_FILE="/etc/systemd/system/realesrgan-api.service"
    CURRENT_DIR=$(pwd)
    CURRENT_USER=$(whoami)
    
    sudo tee $SERVICE_FILE > /dev/null <<EOF
[Unit]
Description=Real-ESRGAN API Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/python3 $CURRENT_DIR/api_server.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    
    echo "✓ systemd 服务文件已创建: $SERVICE_FILE"
    echo ""
    echo "使用以下命令管理服务："
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl enable realesrgan-api"
    echo "  sudo systemctl start realesrgan-api"
    echo "  sudo systemctl status realesrgan-api"
fi

# 启动选项
echo ""
echo "=========================================="
echo "部署完成！"
echo "=========================================="
echo ""
echo "启动方式："
echo "  1. 直接运行: python3 api_server.py"
echo "  2. 后台运行: nohup python3 api_server.py > server.log 2>&1 &"
echo "  3. 使用 systemd: sudo systemctl start realesrgan-api"
echo ""
echo "服务地址: http://$(hostname -I | awk '{print $1}'):8000"
echo "健康检查: curl http://localhost:8000/api/health"
echo ""

