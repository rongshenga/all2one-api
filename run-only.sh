#!/bin/bash

set -euo pipefail

# 设置中文环境
export LC_ALL=zh_CN.UTF-8
export LANG=zh_CN.UTF-8

APP_PORT="${SERVER_PORT:-3123}"
EXTRA_ARGS=()

print_help() {
    echo "用法: ./run-only.sh [--port <端口>] [额外参数...]"
    echo
    echo "说明:"
    echo "  只启动服务，不执行依赖安装。"
    echo "  默认端口来自 SERVER_PORT 环境变量或 3123。"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)
            if [[ -z "${2:-}" ]]; then
                echo "[错误] --port 需要提供端口值"
                exit 1
            fi
            APP_PORT="$2"
            shift 2
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

echo "========================================"
echo "  AI Client 2 API 快速启动脚本(免安装)"
echo "========================================"
echo

echo "[检查] 正在检查 Node.js..."
if ! command -v node > /dev/null 2>&1; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js"
    exit 1
fi
echo "[成功] Node.js 版本: $(node --version)"

if [[ ! -f "package.json" ]]; then
    echo "[错误] 未找到 package.json，请在项目根目录执行"
    exit 1
fi

if [[ ! -d "node_modules" ]]; then
    echo "[错误] 未检测到 node_modules，当前脚本不会自动安装依赖"
    echo "请先执行: ./install-and-run.sh 或 npm install"
    exit 1
fi

if [[ ! -f "src/core/master.js" ]]; then
    echo "[错误] 未找到 src/core/master.js"
    exit 1
fi

echo
echo "========================================"
echo "  启动 AIClient2API 服务器..."
echo "========================================"
echo
echo "服务器将在 http://localhost:${APP_PORT} 启动"
echo "访问 http://localhost:${APP_PORT} 查看管理界面"
echo "按 Ctrl+C 停止服务器"
echo

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    node src/core/master.js --port "${APP_PORT}" "${EXTRA_ARGS[@]}"
else
    node src/core/master.js --port "${APP_PORT}"
fi
