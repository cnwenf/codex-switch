#!/bin/sh
# codex-switch 一键安装:装依赖 → 启动服务 → 打印 HTML 配置页链接。
# 幂等:重复执行 = 升级 + 重启。
set -e
cd "$(dirname "$0")"

# ---- 环境检查:Node >= 20 ----
if ! command -v node >/dev/null 2>&1; then
  echo "[codex-switch] 需要 Node.js >= 20,请先安装: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[codex-switch] Node.js >= 20 才能运行(当前 $(node -v))"
  exit 1
fi

# ---- 配置优先级与服务端点(与 src/server.js 的 resolveConfigPath 一致)----
CFG=config.toml
[ -f config.local.toml ] && CFG=config.local.toml
[ -n "$CODEXSWITCH_CONFIG" ] && CFG="$CODEXSWITCH_CONFIG"
HOST=$(sed -n 's/^listen *= *"\([0-9.]*\):[0-9]*"/\1/p' "$CFG" | head -1); HOST=${HOST:-127.0.0.1}
PORT=$(sed -n 's/^listen *= *"[0-9.]*:\([0-9]*\)"/\1/p' "$CFG" | head -1); PORT=${PORT:-8787}

# ---- 安装依赖 ----
echo "[codex-switch] installing dependencies (node $(node -v))..."
npm install --no-fund --no-audit --loglevel=error

mkdir -p "$HOME/.codex-switch"

# ---- 停旧实例:先按 pid 文件停,端口仍被占且是 node 进程才补刀 ----
node src/server.js stop >/dev/null 2>&1 || true
OLD_PID=$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$OLD_PID" ]; then
  OLD_CMD=$(ps -p "$OLD_PID" -o comm= 2>/dev/null)
  if [ "$OLD_CMD" = "node" ]; then
    echo "[codex-switch] stopping old node instance (pid $OLD_PID) on port $PORT"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  else
    echo "[codex-switch] 端口 $PORT 被其他程序占用 ($OLD_CMD, pid $OLD_PID)"
    echo "              请改 $CFG 里的 listen 端口,或先停掉该程序"
    exit 1
  fi
fi

# ---- 启动(脱离终端,日志写 ~/.codex-switch/run.log)----
echo "[codex-switch] starting service..."
DAEMON="nohup sh scripts/start.sh > \"\$HOME/.codex-switch/run.log\" 2>&1 </dev/null &"
eval "$DAEMON"
sleep 2

if ! lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[codex-switch] 启动失败,日志: $HOME/.codex-switch/run.log"
  cat "$HOME/.codex-switch/run.log"
  exit 1
fi

# ---- 完成提示 ----
echo
echo "======================================================"
echo "  codex-switch 已启动"
echo "  配置页面(浏览器打开):  http://$HOST:$PORT/"
echo "======================================================"
echo "  页面里配置 providers → 保存 → 点「应用并备份」→ 重启 Codex 即用。"
echo
echo "  安全说明:本地极薄代理。只读 body.model 做路由,请求/响应字节级原样"
echo "  转发不改写;仅按 provider 配置注入/剥离认证头;只监听 127.0.0.1。"
echo
if [ ! -f "$HOME/.codex-switch/env" ]; then
  echo "  API key 走环境变量(如 DASHSCOPE_API_KEY),创建后重启一次即可:"
  echo "    printf 'DASHSCOPE_API_KEY=sk-xxx\\\\n' > $HOME/.codex-switch/env"
  echo "    chmod 600 $HOME/.codex-switch/env && ./install.sh"
  echo "  (key 只在这一个文件里,不进仓库、不进命令行历史)"
fi
echo