#!/bin/sh
# codex-switch — macOS App 一键安装器(免 Gatekeeper)。
#
# 原理:macOS 的隔离属性 com.apple.quarantine 只会由浏览器/邮件/AirDrop 等
# "带隔离意识"的下载器打上;curl 下载不打。因此本脚本用 curl 拉取 DMG 并
# 安装到 /Applications,装完首次启动不会触发 Gatekeeper,无需 xattr / 右键打开。
#
# 用法:
#   sh scripts/install-app.sh                 # 自动从最新 Release 下载
#   sh scripts/install-app.sh <DMG URL或本地路径>  # 覆盖来源(测试/离线用)
#
# 幂等:重复执行 = 覆盖升级到目标版本。安装前会停掉正在运行的旧实例。
set -e
umask 077

APP_NAME="Codex Switch"
DEST="/Applications/$APP_NAME.app"
REPO="cnwenf/codex-switch"
SRC="${1:-}"
AUTO_RELEASE=false
POLL_DELAYS="${CODEX_SWITCH_RELEASE_POLL_DELAYS:-5 10 20 40 80 120 180 240}"

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] %s\n' "$*" >&2; exit 1; }

fetch_json() {
  url=$1
  curl -fsSL --retry 2 --max-time 20 "$url" 2>/dev/null \
    || curl -fsSL --retry 2 --max-time 20 --resolve api.github.com:443:140.82.112.6 "$url" 2>/dev/null
}

download_file() {
  url=$1
  output=$2
  curl -fL --retry 2 --max-time 600 --progress-bar -o "$output" "$url" \
    || { say "直连失败,改用固定 IP 重试(DNS 受限网络)…";
         curl -fL --retry 2 --max-time 600 --progress-bar --resolve github.com:443:140.82.112.3 -o "$output" "$url"; }
}

json_string_field() {
  field=$1
  json=$2
  printf '%s' "$json" \
    | tr '\n' ' ' \
    | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

release_has_asset_pair() {
  json=$1
  dmg_name=$2
  checksum_name=$3
  compact=$(printf '%s' "$json" | tr -d '[:space:]')
  printf '%s' "$compact" | grep -Fq "\"name\":\"$dmg_name\"" \
    && printf '%s' "$compact" | grep -Fq "\"name\":\"$checksum_name\""
}

urlencode() {
  value=$1
  encoded=
  while [ -n "$value" ]; do
    rest=${value#?}
    char=${value%"$rest"}
    value=$rest
    case "$char" in
      [A-Za-z0-9._~-]) encoded="$encoded$char" ;;
      *)
        hex=$(printf '%s' "$char" | od -An -tx1 | tr -d ' \n' | tr '[:lower:]' '[:upper:]')
        encoded="$encoded%$hex"
        ;;
    esac
  done
  printf '%s' "$encoded"
}

validate_poll_delays() {
  total=0
  count=0
  for delay in $POLL_DELAYS; do
    case "$delay" in
      ''|*[!0-9]*|0[0-9]*) die "CODEX_SWITCH_RELEASE_POLL_DELAYS 只能包含非负整数秒。" ;;
    esac
    [ "${#delay}" -le 3 ] || die "Release 轮询总时长不能超过 900 秒。"
    total=$((total + delay))
    [ "$total" -le 900 ] || die "Release 轮询总时长不能超过 900 秒。"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] || die "CODEX_SWITCH_RELEASE_POLL_DELAYS 不能为空。"
}

# ---------- 1. 定位 DMG ----------
if [ -z "$SRC" ]; then
  say "查询最新 Release…"
  API="https://api.github.com/repos/$REPO/releases/latest"
  LATEST=$(fetch_json "$API") \
      || die "无法访问 api.github.com(网络或 DNS 问题)。可手动指定:sh scripts/install-app.sh <DMG URL或本地路径>"
  TAG=$(json_string_field tag_name "$LATEST")
  printf '%s' "$TAG" | grep -Eq '^v[0-9]+[0-9A-Za-z.+-]*$' \
    || die "latest Release 返回了无效 tag，已停止安装。"

  VERSION=${TAG#v}
  DMG_NAME="CodexSwitch-$VERSION-macos-arm64.dmg"
  CHECKSUM_NAME="$DMG_NAME.sha256"
  TAG_ENCODED=$(urlencode "$TAG")
  DMG_NAME_ENCODED=$(urlencode "$DMG_NAME")
  CHECKSUM_NAME_ENCODED=$(urlencode "$CHECKSUM_NAME")
  TAG_API="https://api.github.com/repos/$REPO/releases/tags/$TAG_ENCODED"
  RELEASE_URL="https://github.com/$REPO/releases/tag/$TAG_ENCODED"
  SRC="https://github.com/$REPO/releases/download/$TAG_ENCODED/$DMG_NAME_ENCODED"
  CHECKSUM_SRC="https://github.com/$REPO/releases/download/$TAG_ENCODED/$CHECKSUM_NAME_ENCODED"

  validate_poll_delays
  say "已锁定 Release ${TAG}；等待 $DMG_NAME 与 checksum…"
  META=$(fetch_json "$TAG_API") \
    || die "无法读取已锁定 Release: $RELEASE_URL"
  ready=false
  if release_has_asset_pair "$META" "$DMG_NAME" "$CHECKSUM_NAME"; then
    ready=true
  else
    for delay in $POLL_DELAYS; do
      say "DMG 与 checksum 尚未同时就绪；${delay}s 后重试 ${TAG}…"
      sleep "$delay"
      META=$(fetch_json "$TAG_API") \
        || die "轮询已锁定 Release 失败: $RELEASE_URL"
      if release_has_asset_pair "$META" "$DMG_NAME" "$CHECKSUM_NAME"; then
        ready=true
        break
      fi
    done
  fi
  if [ "$ready" != true ]; then
    die "等待 Release 资产超时；GitHub Actions 可能仍在构建。Release: ${RELEASE_URL}；稍后重跑: sh scripts/install-app.sh '$SRC'"
  fi
  AUTO_RELEASE=true
fi
say "安装来源: $SRC"

# ---------- 2. 下载到临时目录 ----------
WORK_DIR=$(mktemp -d 2>/dev/null) || die "无法创建安全的临时目录。"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

if [ "$AUTO_RELEASE" = true ]; then
  DMG="$WORK_DIR/$DMG_NAME"
  CHECKSUM="$WORK_DIR/$CHECKSUM_NAME"
else
  DMG="$WORK_DIR/$APP_NAME.dmg"
fi

case "$SRC" in
  http://*|https://*)
    say "下载 DMG(curl,不附带隔离属性)…"
    download_file "$SRC" "$DMG" \
      || die "下载失败。若在受限网络,可先手动下载,再:sh scripts/install-app.sh /path/to/xxx.dmg"
    if [ "$AUTO_RELEASE" = true ]; then
      say "下载 checksum…"
      download_file "$CHECKSUM_SRC" "$CHECKSUM" \
        || die "checksum 下载失败，已停止安装。"
    else
      say "显式 URL 不查询 GitHub Release checksum；请自行确认来源。"
    fi
    ;;
  *)
    [ -f "$SRC" ] || die "本地文件不存在: $SRC"
    cp "$SRC" "$DMG"
    say "本地 DMG 不强制远端 checksum；请自行确认来源。"
    ;;
esac

if [ "$AUTO_RELEASE" = true ]; then
  awk -v expected="$DMG_NAME" '
    { lines++ }
    NF == 2 && length($1) == 64 && $1 ~ /^[0-9A-Fa-f]+$/ && $2 == expected { valid++ }
    END { exit !(lines == 1 && valid == 1) }
  ' "$CHECKSUM" || die "checksum 格式无效：必须是 64 位十六进制摘要和精确文件名 ${DMG_NAME}。"
  (
    cd "$WORK_DIR"
    shasum -a 256 -c "$CHECKSUM_NAME" >/dev/null 2>&1
  ) || die "SHA-256 校验失败，已停止安装。"
  say "SHA-256 校验通过。"
fi

# ---------- 3. 停掉旧实例(升级场景) ----------
if [ -f "$HOME/.codex-switch/run.pid" ]; then
  OLD_PID=$(cat "$HOME/.codex-switch/run.pid" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    say "停止运行中的旧实例 (pid $OLD_PID)…"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# ---------- 4. 挂载并安装 ----------
say "挂载 DMG…"
MOUNT_OUT=$(hdiutil attach "$DMG" -nobrowse -readonly -noverify -noautoopen 2>/dev/null | tail -1 | awk '{for(i=3;i<=NF;i++)printf "%s ",$i; print ""}' | sed 's/ *$//')
[ -n "$MOUNT_OUT" ] || die "挂载失败。"
MOUNT="$MOUNT_OUT"
say "已挂载: $MOUNT"

SRC_APP="$MOUNT/$APP_NAME.app"
[ -d "$SRC_APP" ] || die "DMG 中未找到 $APP_NAME.app"

say "安装到 $DEST…"
rm -rf "$DEST"
cp -R "$SRC_APP" "$DEST"
hdiutil detach "$MOUNT" >/dev/null 2>&1 || true

# ---------- 5. 收尾:防御性清理隔离属性 + 放行 ----------
xattr -cr "$DEST" 2>/dev/null || true
say "完成:$DEST"
say "启动…"
open "$DEST" 2>/dev/null || say "已安装;请手动打开 $APP_NAME。"
say "配置页稍后可用: http://127.0.0.1:8787/"
