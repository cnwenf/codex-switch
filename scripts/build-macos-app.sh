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
cp package.json package-lock.json config.toml "$RES/app/"
mkdir -p "$RES/app/src"
cp src/*.js "$RES/app/src/"
mkdir -p "$RES/app/scripts"
cp scripts/launch-server.sh "$RES/app/scripts/"
cp scripts/install-app.sh scripts/install-app-bundle.cjs "$RES/app/scripts/"
# App 图标(assets/logo.svg → assets/app.icns,iconutil 编译产物)
[ -f assets/app.icns ] && cp assets/app.icns "$RES/app.icns"
( cd "$RES/app" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit --loglevel=error )

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

# ---------- 5. 原生 AppKit + WebKit 窗口，编译失败时不发布降级产物 ----------

LAUNCHER_SWIFT=assets/launcher/CodexSwitchLauncher.swift
if [ -f "$LAUNCHER_SWIFT" ] && command -v swiftc >/dev/null 2>&1; then
  if swiftc -O -framework AppKit -framework WebKit "$LAUNCHER_SWIFT" -o "$MACOS_DIR/codex-switch-launcher"; then
    chmod +x "$MACOS_DIR/codex-switch-launcher"
    echo "[build] launcher built: Swift AppKit (Dock 图标不弹跳)"
  else
    echo "[build] ERROR: 原生窗口启动器编译失败" >&2
    exit 1
  fi
else
  echo "[build] ERROR: 构建原生 App 需要 swiftc" >&2
  exit 1
fi

# ---------- 5.5 菜单栏小程序(可选;无 swiftc 时跳过,App 其余功能不受影响) ----------
# 打成独立 LSUIElement=true 的 .app(自己的 bundle id):启动器用 open 拉起,
# 拥有独立 LaunchServices ASN,其 accessory 策略不会把主 App 拖成 UIElement(Dock 可见)。
MB_SRC=assets/menubar/CodexSwitchMenuBar.swift
MB_APP="$RES/CodexSwitchMenuBar.app"
if [ -f "$MB_SRC" ] && command -v swiftc >/dev/null 2>&1; then
  if swiftc -O -framework AppKit "$MB_SRC" -o "$DIST/mb-bin" 2>/dev/null; then
    mkdir -p "$MB_APP/Contents/MacOS"
    mv "$DIST/mb-bin" "$MB_APP/Contents/MacOS/CodexSwitchMenuBar"
    chmod +x "$MB_APP/Contents/MacOS/CodexSwitchMenuBar"
    cat > "$MB_APP/Contents/Info.plist" <<'MBPLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>CodexSwitchMenuBar</string>
  <key>CFBundleDisplayName</key><string>CodexSwitchMenuBar</string>
  <key>CFBundleIdentifier</key><string>com.cnwenf.codex-switch.menubar</string>
  <key>CFBundleExecutable</key><string>CodexSwitchMenuBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
MBPLIST
    codesign --force --sign - "$MB_APP" 2>/dev/null || true
    echo "[build] menubar app built: CodexSwitchMenuBar.app (LSUIElement)"
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
