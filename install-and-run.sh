#!/bin/bash

# 设置中文环境
export LC_ALL=zh_CN.UTF-8
export LANG=zh_CN.UTF-8

echo "========================================"
echo "  All2One API 快速安装启动脚本"
echo "========================================"
echo

# 处理参数
FORCE_PULL=0
APP_PORT="${SERVER_PORT:-3123}"

for arg in "$@"; do
    if [ "$arg" == "--pull" ]; then
        FORCE_PULL=1
    fi
done

# 检查Git并尝试pull
if [ $FORCE_PULL -eq 1 ]; then
    echo "[更新] 正在从远程仓库拉取最新代码..."
    if command -v git > /dev/null 2>&1; then
        git pull
        if [ $? -ne 0 ]; then
            echo "[警告] Git pull 失败，请检查网络或手动处理冲突。"
        else
            echo "[成功] 代码已更新。"
        fi
    else
        echo "[警告] 未检测到 Git，跳过代码拉取。"
    fi
fi

# 检查Node.js是否已安装
echo "[检查] 正在检查Node.js是否已安装..."
node --version > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[错误] 未检测到Node.js，请先安装Node.js"
    echo "下载地址：https://nodejs.org/"
    echo "提示：推荐安装LTS版本"
    exit 1
fi

# 获取Node.js版本
NODE_VERSION=$(node --version 2>/dev/null)
echo "[成功] Node.js已安装，版本: $NODE_VERSION"

# 检查package.json是否存在
if [ ! -f "package.json" ]; then
    echo "[错误] 未找到package.json文件"
    echo "请确保在项目根目录下运行此脚本"
    exit 1
fi

echo "[成功] 找到package.json文件"

# 检查 pnpm 是否可用
echo "[检查] 正在检查pnpm是否可用..."
if command -v pnpm > /dev/null 2>&1; then
    INSTALL_CMD="pnpm install --frozen-lockfile"
elif command -v corepack > /dev/null 2>&1; then
    echo "[提示] 未检测到pnpm，正在通过corepack调用项目声明版本..."
    INSTALL_CMD="corepack pnpm install --frozen-lockfile"
else
    echo "[错误] 未检测到pnpm或corepack，请先安装Node.js自带的corepack或手动安装pnpm"
    exit 1
fi

echo "[安装] 正在使用pnpm安装/更新依赖..."
echo "这可能需要几分钟时间，请耐心等待..."
echo "正在执行: $INSTALL_CMD"

sh -c "$INSTALL_CMD"
if [ $? -ne 0 ]; then
    echo "[错误] 依赖安装失败"
    echo "请检查网络连接或手动运行 'pnpm install --frozen-lockfile'"
    exit 1
fi
echo "[成功] 依赖安装/更新完成"

# 检查src目录和master.js是否存在
if [ ! -f "src/core/master.js" ]; then
    echo "[错误] 未找到src/core/master.js文件"
    exit 1
fi

echo "[成功] 项目文件检查完成"

# 启动应用程序
echo
echo "========================================"
echo "  启动 All2One API 服务器..."
echo "========================================"
echo
echo "服务器将在 http://localhost:${APP_PORT} 启动"
echo "访问 http://localhost:${APP_PORT} 查看管理界面"
echo "按 Ctrl+C 停止服务器"
echo

# 启动服务器
node src/core/master.js --port "${APP_PORT}"
