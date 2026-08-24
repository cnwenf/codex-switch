#!/bin/sh
# codex-switch — 打包 macOS arm64 App + DMG(产物在 dist/)。
# 流程:官方 Node LTS arm64(SHA256 校验) + 源码 + npm 生产依赖 → .app → ad-hoc 签名 → UDZO DMG。
# 安全:绝不打包 ~/.codex-switch/env(密钥)与 config.local.toml(私有端点)。
set -e
cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./package.json").version')
NODE_VERSION="${NODE_VERSION:-v22.23.2}"   # 官方 Node LTS(darwin-arm64),可用环境变量覆盖
APP_NAME="Codex Switch"
DIST=dist
DL="$DIST/downloads"
DMG_ROOT="$DIST/dmg-root"
STAGE="$DIST/staging"
APP="$STAGE/$APP_NAME.app"
MACOS_DIR="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
TARBALL="node-$NODE_VERSION-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION"

echo "[build] codex-switch $VERSION · bundling node $NODE_VERSION (darwin-arm64)"

# ---------- 1. 下载官方 Node 并校验 SHA256 ----------
mkdir -p "$DL"
[ -f "$DL/$TARBALL" ] || curl -fSL --retry 3 -o "$DL/$TARBALL" "$NODE_URL/$TARBALL"
[ -f "$DL/SHASUMS256-$NODE_VERSION.txt" ] || curl -fSL --retry 3 -o "$DL/SHASUMS256-$NODE_VERSION.txt" "$NODE_URL/SHASUMS256.txt"
EXPECT=$(grep " $TARBALL\$" "$DL/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')
ACTUAL=$(shasum -a 256 "$DL/$TARBALL" | awk '{print $1}')
if [ -z "$EXPECT" ] || [ "$EXPECT" != "$ACTUAL" ]; then
  echo "[build] SHA256 mismatch for $TARBALL: expect '$EXPECT' got '$ACTUAL'" >&2
  exit 1
fi
echo "[build] node tarball SHA256 verified"

# ---------- 2. .app 骨架 + Node 运行时 ----------
rm -rf "$STAGE" "$DMG_ROOT"
mkdir -p "$MACOS_DIR" "$RES/app"
tar -xzf "$DL/$TARBALL" -C "$DL" "node-$NODE_VERSION-darwin-arm64/bin/node"
cp "$DL/node-$NODE_VERSION-darwin-arm64/bin/node" "$MACOS_DIR/node"
chmod +x "$MACOS_DIR/node"

# ---------- 3. 应用源码 + 生产依赖(不含 config.local.toml / 密钥文件) ----------
cp package.json config.toml "$RES/app/"
mkdir -p "$RES/app/src"
cp src/*.js "$RES/app/src/"
# App 图标(assets/logo.svg → assets/app.icns,iconutil 编译产物)
[ -f assets/app.icns ] && cp assets/app.icns "$RES/app.icns"
( cd "$RES/app" && npm install --omit=dev --no-fund --no-audit --loglevel=error )

# ---------- 4. Info.plist ----------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Codex Switch</string>
  <key>CFBundleDisplayName</key><string>Codex Switch</string>
  <key>CFBundleIdentifier</key><string>com.cnwenf.codex-switch</string>
  <key>CFBundleExecutable</key><string>codex-switch-launcher</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ---------- 5. 启动器:端口被占(已有实例)就只开页面;否则拉起内嵌 node 并开页面 ----------
cat > "$MACOS_DIR/codex-switch-launcher" <<'LAUNCHER'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node"
APP="$DIR/../Resources/app"
CFG="$APP/config.toml"
PORT=$(sed -n 's/^listen *= *"[0-9.]*:\([0-9]*\)"/\1/p' "$CFG" 2>/dev/null | head -1)
PORT="${PORT:-8787}"
URL="http://127.0.0.1:$PORT/"
mkdir -p "$HOME/.codex-switch"
MB_SRC="$DIR/../Resources/CodexSwitchMenuBar"
MB_BIN="$HOME/.codex-switch/CodexSwitchMenuBar"
start_menubar() {
  # 先拷贝到用户目录再启动:菜单栏进程若从 .app 包内启动,其
  # setActivationPolicy(.accessory) 会把整个 App 降级为 UIElement,
  # 导致 Dock/⌘Tab 里看不到本应用。从包外启动则互不影响。
  [ -x "$MB_SRC" ] || return 0
  cp -f "$MB_SRC" "$MB_BIN" 2>/dev/null || return 0
  chmod +x "$MB_BIN" 2>/dev/null || return 0
  "$MB_BIN" --port "$PORT" >/dev/null 2>&1 &
  MB_PID=$!
}
if lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "$URL"   # 已有实例在跑(源码安装或另一个 App 实例),直接打开管理页
  exit 0
fi
[ -f "$HOME/.codex-switch/env" ] && . "$HOME/.codex-switch/env"
"$NODE" "$APP/src/server.js" >> "$HOME/.codex-switch/run.log" 2>&1 &
SERVER_PID=$!
start_menubar
stop_all() {
  # 退出前先还原官方 Codex 配置(撤销本应用注入的代理设置)
  curl -fsS -m 8 -X POST "http://127.0.0.1:$PORT/__admin/codex-restore" >> "$HOME/.codex-switch/run.log" 2>&1 || true
  kill $SERVER_PID 2>/dev/null
  [ -n "${MB_PID:-}" ] && kill $MB_PID 2>/dev/null
  exit 0
}
trap stop_all TERM INT
i=0
while [ $i -lt 20 ]; do
  if lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  kill -0 $SERVER_PID 2>/dev/null || break   # 进程已退出(启动失败,看 run.log)
  sleep 0.4
  i=$((i+1))
done
open "$URL"
wait $SERVER_PID
LAUNCHER
chmod +x "$MACOS_DIR/codex-switch-launcher"

# ---------- 5.5 菜单栏小程序(可选;无 swiftc 时跳过,App 其余功能不受影响) ----------
MB_SRC=assets/menubar/CodexSwitchMenuBar.swift
MB_BIN="$RES/CodexSwitchMenuBar"
if [ -f "$MB_SRC" ] && command -v swiftc >/dev/null 2>&1; then
  if swiftc -O -framework AppKit "$MB_SRC" -o "$MB_BIN" 2>/dev/null; then
    chmod +x "$MB_BIN"
    codesign --force --sign - "$MB_BIN" 2>/dev/null || true
    echo "[build] menubar app built: CodexSwitchMenuBar"
  else
    echo "[build] WARN: menubar app build failed(App 仍可用,只是没有状态栏图标)" >&2
  fi
else
  echo "[build] skip menubar app(swiftc 不存在或源码缺失)"
fi

# ---------- 6. ad-hoc 签名 ----------
codesign --force --sign - "$MACOS_DIR/node"
codesign --force --sign - "$APP"
codesign --verify --verbose=1 "$APP" >/dev/null

# ---------- 7. DMG(含 /Applications 软链,拖进去即装) ----------
mkdir -p "$DMG_ROOT"
cp -R "$APP" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
DMG="$DIST/CodexSwitch-$VERSION-macos-arm64.dmg"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$DMG_ROOT" -fs HFS+ -format UDZO "$DMG" >/dev/null
echo "[build] done: $DMG ($(du -h "$DMG" | awk '{print $1}'))"
rm -rf "$STAGE" "$DMG_ROOT"
echo "[build] 已清理中间产物:$STAGE、$DMG_ROOT"
echo "[build] 首次打开提示:下载自网络的 App 带隔离属性,若 Gatekeeper 拦截,"
echo "        右键「打开」或执行: xattr -cr \"/Applications/$APP_NAME.app\""
