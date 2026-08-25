#!/bin/sh
# codex-switch launcher. Node loads its bundled roots, the macOS system store,
# and any caller-provided NODE_EXTRA_CA_CERTS itself.

cd "$(dirname "$0")/.." || exit 1

DIR="$HOME/.codex-switch"

# 本地环境变量(如各 provider 的 API key)。文件由用户自行创建(chmod 600),
# 例如含一行 DASHSCOPE_API_KEY=sk-...;不存在则跳过。
ENV_FILE="$DIR/env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  echo "[codex-switch] loaded local env: $ENV_FILE"
fi

exec node --use-system-ca src/server.js "$@"
