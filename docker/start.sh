#!/bin/bash

# All2One API Docker 快速启动脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo -e "${RED}错误: Docker 未安装${NC}"
    exit 1
fi

# 检查 Docker Compose 是否安装
if ! command -v docker compose &> /dev/null; then
    echo -e "${RED}错误: Docker Compose 未安装${NC}"
    exit 1
fi

# 切换到 docker 目录
cd "$(dirname "$0")"

# 检查配置文件是否存在
if [ ! -f "../configs/config.json" ]; then
    echo -e "${YELLOW}警告: 未找到配置文件 configs/config.json${NC}"
    echo -e "${YELLOW}请确保配置文件存在后再启动${NC}"
    exit 1
fi

# 创建 .env 文件（如果不存在）
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}创建 .env 文件...${NC}"
    cp .env.example .env
fi

# 显示菜单
echo -e "${GREEN}=== All2One API Docker 部署 ===${NC}"
echo ""
echo "请选择部署模式："
echo "1) 生产环境（推荐）"
echo "2) 开发环境"
echo "3) 停止服务"
echo "4) 查看日志"
echo "5) 重新构建"
echo ""
read -p "请输入选项 [1-5]: " choice

case $choice in
    1)
        echo -e "${GREEN}启动生产环境...${NC}"
        docker compose up -d --build
        echo -e "${GREEN}服务已启动！${NC}"
        echo -e "访问地址: http://localhost:3000"
        ;;
    2)
        echo -e "${GREEN}启动开发环境...${NC}"
        docker compose -f docker-compose.build.yml up -d --build
        echo -e "${GREEN}服务已启动！${NC}"
        echo -e "访问地址: http://localhost:3000"
        ;;
    3)
        echo -e "${YELLOW}停止服务...${NC}"
        docker compose down
        docker compose -f docker-compose.build.yml down 2>/dev/null || true
        echo -e "${GREEN}服务已停止${NC}"
        ;;
    4)
        echo -e "${GREEN}查看日志（Ctrl+C 退出）...${NC}"
        docker compose logs -f
        ;;
    5)
        echo -e "${YELLOW}重新构建镜像...${NC}"
        docker compose down
        docker compose build --no-cache
        docker compose up -d
        echo -e "${GREEN}重新构建完成！${NC}"
        ;;
    *)
        echo -e "${RED}无效选项${NC}"
        exit 1
        ;;
esac
