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

APP_NAME="Codex Switch"
DEST="/Applications/$APP_NAME.app"
REPO="cnwenf/codex-switch"
SRC="${1:-}"

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] %s\n' "$*" >&2; exit 1; }

# ---------- 1. 定位 DMG ----------
if [ -z "$SRC" ]; then
  say "查询最新 Release…"
  API="https://api.github.com/repos/$REPO/releases/latest"
  META=$(curl -fsSL --retry 2 --max-time 20 "$API" 2>/dev/null \
      || curl -fsSL --retry 2 --max-time 20 --resolve api.github.com:443:140.82.112.6 "$API" 2>/dev/null) \
      || die "无法访问 api.github.com(网络或 DNS 问题)。可手动指定:sh scripts/install-app.sh <DMG URL或本地路径>"
  SRC=$(printf '%s' "$META" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*: *"//; s/"$//')
  [ -n "$SRC" ] || die "最新 Release 中未找到 .dmg 资产。"
fi
say "安装来源: $SRC"

# ---------- 2. 下载到临时目录 ----------
TMPDIR=$(mktemp -d 2>/dev/null || echo "/tmp/codex-switch-install.$$")
mkdir -p "$TMPDIR"
DMG="$TMPDIR/$APP_NAME.dmg"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

case "$SRC" in
  http://*|https://*)
    say "下载 DMG(curl,不附带隔离属性)…"
    curl -fL --retry 3 --max-time 600 --progress-bar -o "$DMG" "$SRC" \
      || die "下载失败。若在受限网络,可先手动下载,再:sh scripts/install-app.sh /path/to/xxx.dmg"
    ;;
  *)
    [ -f "$SRC" ] || die "本地文件不存在: $SRC"
    cp "$SRC" "$DMG"
    ;;
esac

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
