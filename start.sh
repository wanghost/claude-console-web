#!/usr/bin/env bash
# Claude Console 一键启动脚本（Linux / macOS）
# 首次运行自动创建虚拟环境并安装依赖，然后以 0.0.0.0 启动服务。
set -e

# 切到脚本所在目录
cd "$(dirname "$0")"

echo
echo " ============================================"
echo "   Claude Console 一键启动"
echo " ============================================"
echo

# ---- 1. 检查 Python ----
if ! command -v python3 >/dev/null 2>&1; then
    echo "[错误] 未检测到 python3，请先安装 Python 3.9+"
    exit 1
fi

# ---- 2. 创建虚拟环境（首次）----
if [ ! -x "venv/bin/python" ]; then
    echo "[首次运行] 正在创建虚拟环境..."
    python3 -m venv venv
    echo "[首次运行] 正在安装依赖，请稍候..."
    venv/bin/python -m pip install -r requirements.txt -q
fi

# ---- 3. 获取本机局域网 IP ----
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="127.0.0.1"

# ---- 4. 启动服务 ----
echo
echo "   服务已启动！"
echo
echo "   本机访问:   http://127.0.0.1:8080"
echo "   局域网访问: http://${LOCAL_IP}:8080   （手机同一 WiFi 下）"
echo
echo "   默认账号: admin   默认密码: admin123"
echo "   （首次登录后请到「系统」页修改密码！）"
echo
echo "   按 Ctrl+C 停止服务"
echo

exec venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8080 --reload
