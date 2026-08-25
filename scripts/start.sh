#!/bin/sh
# codex-switch launcher.
#
# In corporate networks with transparent HTTPS interception (self-signed /
# enterprise CA in the macOS keychain), Node's bundled CA list plus any
# pre-existing NODE_EXTRA_CA_CERTS file may still miss the intercepting CA,
# and fetch() fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY (curl works).
#
# On macOS this script builds one combined bundle: the content of a
# pre-existing NODE_EXTRA_CA_CERTS file (if any) + all system and login
# keychain certificates, and points NODE_EXTRA_CA_CERTS at it. Nothing is
# removed; pre-existing certs are folded in.

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

# Apply this after the local env so an env-file NODE_EXTRA_CA_CERTS value is
# preserved in the combined bundle too.
. ./scripts/prepare-ca.sh
if [ "${NODE_EXTRA_CA_CERTS:-}" = "$DIR/extra-ca.pem" ]; then
  echo "[codex-switch] extra CA bundle -> $NODE_EXTRA_CA_CERTS (env value + macOS keychains)"
fi

exec node src/server.js "$@"
