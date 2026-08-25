#!/bin/sh
# codex-switch — macOS App 一键安装器(免 Gatekeeper)。
#
# 原理:macOS 的隔离属性 com.apple.quarantine 只会由浏览器/邮件/AirDrop 等
# "带隔离意识"的下载器打上;curl 下载不打。因此本脚本用 curl 拉取 DMG 并
# 安装到 /Applications,装完首次启动不会触发 Gatekeeper,无需 xattr / 右键打开。
#
# 用法:
#   sh scripts/install-app.sh                 # 自动从最新 Release 下载
#   sh scripts/install-app.sh --release-tag v0.5.0  # 锁定 tag 并等待受校验资产
#   sh scripts/install-app.sh <DMG URL或本地路径>  # 覆盖来源(测试/离线用)
#
# 幂等:重复执行 = 覆盖升级到目标版本。安装前会停掉正在运行的旧实例。
set -e
umask 077

APP_NAME="Codex Switch"
DEST_OVERRIDE_SET=false
if [ "${CODEX_SWITCH_INSTALL_DEST+x}" = x ]; then
  DEST_OVERRIDE_SET=true
  DEST=$CODEX_SWITCH_INSTALL_DEST
else
  DEST="/Applications/$APP_NAME.app"
fi
REPO="cnwenf/codex-switch"
SRC=
RELEASE_TAG=
AUTO_RELEASE=false
POLL_DELAYS="${CODEX_SWITCH_RELEASE_POLL_DELAYS:-5 10 20 40 80 120 180 240}"
RELEASE_TIMEOUT_SECONDS="${CODEX_SWITCH_RELEASE_TIMEOUT_SECONDS:-900}"

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] %s\n' "$*" >&2; exit 1; }

validate_install_destination() {
  if [ "$DEST_OVERRIDE_SET" = true ] && [ -z "$DEST" ]; then
    die "安装目标无效：CODEX_SWITCH_INSTALL_DEST 不能为空。"
  fi
  case "$DEST" in
    /*) ;;
    *) die "安装目标无效：必须是规范化的绝对 .app 路径。" ;;
  esac
  case "$DEST" in
    /|//*|*//*|*/./*|*/../*|*/.|*/..)
      die "安装目标无效：拒绝根目录、重复分隔符或点路径。"
      ;;
  esac
  dest_basename=$(/usr/bin/basename "$DEST") || die "安装目标无效：无法解析应用名。"
  [ "$dest_basename" = "$APP_NAME.app" ] \
    || die "安装目标无效：应用名必须精确为 $APP_NAME.app。"
  [ ! -L "$DEST" ] || die "安装目标无效：目标不能是软链接。"

  dest_parent=$(/usr/bin/dirname "$DEST") || die "安装目标无效：无法解析父目录。"
  [ -d "$dest_parent" ] || die "安装目标无效：父目录不存在。"
  physical_parent=$(CDPATH= cd -P "$dest_parent" 2>/dev/null && pwd -P) \
    || die "安装目标无效：无法规范化父目录。"

  if [ "$DEST" = "/Applications/$APP_NAME.app" ]; then
    [ "$physical_parent" = "/Applications" ] \
      || die "安装目标无效：系统 Applications 目录不规范。"
    return 0
  fi

  # Test-only override stays confined to one exact Applications directory
  # immediately below a canonical temporary root. Production destinations
  # other than /Applications/Codex Switch.app are rejected.
  temp_root=${TMPDIR:-/tmp}
  [ -d "$temp_root" ] || die "安装目标无效：临时根目录不存在。"
  physical_temp_root=$(CDPATH= cd -P "$temp_root" 2>/dev/null && pwd -P) \
    || die "安装目标无效：无法规范化临时根目录。"
  case "$physical_temp_root" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;;
    *) die "安装目标无效：override 只能位于系统临时目录。" ;;
  esac
  [ "$physical_parent" = "$physical_temp_root/Applications" ] \
    || die "安装目标无效：override 必须是临时根目录下的 Applications/$APP_NAME.app。"
}

case "$#" in
  0) ;;
  1)
    [ "$1" != "--release-tag" ] || die "--release-tag 需要一个 tag，例如 v0.5.0。"
    case "$1" in --*) die "未知参数: $1" ;; esac
    SRC=$1
    ;;
  2)
    [ "$1" = "--release-tag" ] || die "用法: sh scripts/install-app.sh [--release-tag v0.5.0|DMG URL|本地路径]"
    RELEASE_TAG=$2
    ;;
  *) die "用法: sh scripts/install-app.sh [--release-tag v0.5.0|DMG URL|本地路径]" ;;
esac

# Fail closed before creating download state, mounting a DMG, stopping an old
# process, or invoking rm/cp with a caller-controlled destination.
validate_install_destination

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-switch.XXXXXX" 2>/dev/null) || die "无法创建安全的临时目录。"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

remaining_seconds() {
  remaining_now=$(date +%s) || return 1
  case "$remaining_now" in ''|*[!0-9]*) return 1 ;; esac
  remaining_value=$((RELEASE_DEADLINE_EPOCH - remaining_now))
  [ "$remaining_value" -gt 0 ] || return 1
  printf '%s' "$remaining_value"
}

metadata_curl() {
  metadata_url=$1
  metadata_output=$2
  metadata_timeout=$3
  : > "$metadata_output"
  set +e
  METADATA_HTTP_STATUS=$(curl -sSL \
    --max-time "$metadata_timeout" --connect-timeout "$metadata_timeout" \
    -o "$metadata_output" --write-out '%{http_code}' "$metadata_url" 2>/dev/null)
  METADATA_CURL_STATUS=$?
  set -e
}

fetch_json() {
  fetch_url=$1
  fetch_output=$2
  fetch_remaining=$(remaining_seconds) || return 124
  fetch_timeout=$fetch_remaining
  [ "$fetch_timeout" -le 20 ] || fetch_timeout=20

  metadata_curl "$fetch_url" "$fetch_output" "$fetch_timeout"
  remaining_seconds >/dev/null || return 124
  [ "$METADATA_CURL_STATUS" -eq 0 ] || return 74
  case "$METADATA_HTTP_STATUS" in
    200) return 0 ;;
    403|429) return 75 ;;
    *) return 76 ;;
  esac
}

download_file() {
  url=$1
  output=$2
  curl -fL --retry 2 --retry-delay 1 --retry-max-time 600 --max-time 600 --progress-bar -o "$output" "$url" \
    || { say "直连失败,改用固定 IP 重试(DNS 受限网络)…";
         curl -fL --retry 2 --retry-delay 1 --retry-max-time 600 --max-time 600 --progress-bar --resolve github.com:443:140.82.112.3 -o "$output" "$url"; }
}

json_to_plist() {
  json_input=$1
  plist_output=$2
  /usr/bin/plutil -convert xml1 -o "$plist_output" "$json_input" >/dev/null 2>&1
}

file_is_single_line_text() {
  text_file=$1
  LC_ALL=C /usr/bin/od -An -tu1 "$text_file" \
    | /usr/bin/awk '
      {
        for (i = 1; i <= NF; i++) {
          byte = $i + 0
          bytes++
          last = byte
          if (byte == 10) newlines++
          else if (byte < 32 || byte == 127) invalid = 1
        }
      }
      END { exit !(bytes > 1 && newlines == 1 && last == 10 && invalid != 1) }
    '
}

file_is_valid_tag() {
  tag_file=$1
  LC_ALL=C /usr/bin/od -An -tu1 "$tag_file" \
    | /usr/bin/awk '
      {
        for (i = 1; i <= NF; i++) {
          byte = $i + 0
          bytes++
          last = byte
          if (byte == 10) newlines++
          else {
            allowed = byte == 43 || byte == 45 || byte == 46 ||
              (byte >= 48 && byte <= 57) ||
              (byte >= 65 && byte <= 90) ||
              (byte >= 97 && byte <= 122)
            if (!allowed) invalid = 1
          }
        }
      }
      END { exit !(bytes > 2 && newlines == 1 && last == 10 && invalid != 1) }
    ' \
    && LC_ALL=C /usr/bin/grep -Eq '^v[0-9]+[0-9A-Za-z.+-]*$' "$tag_file"
}

extract_tag_file() {
  tag_json=$1
  tag_output=$2
  tag_plist="$WORK_DIR/latest.plist"
  json_to_plist "$tag_json" "$tag_plist" || return 1
  /usr/libexec/PlistBuddy -c 'Print :tag_name' "$tag_plist" > "$tag_output" 2>/dev/null \
    || return 1
  file_is_valid_tag "$tag_output"
}

json_has_one_top_level_tag_name() {
  tag_json=$1
  # plutil accepts duplicate JSON keys and keeps the last one. Count semantic
  # top-level tag_name keys first (including JSON Unicode escapes), then let
  # plutil validate and decode the complete document below.
  LC_ALL=C /usr/bin/awk '
    function expected_hex(character) {
      if (character == "t") return "0074"
      if (character == "a") return "0061"
      if (character == "g") return "0067"
      if (character == "_") return "005f"
      if (character == "n") return "006e"
      if (character == "m") return "006d"
      if (character == "e") return "0065"
      return ""
    }
    function is_tag_name(value,    wanted, position, wanted_index, character, escaped_hex) {
      wanted = "tag_name"
      position = 1
      for (wanted_index = 1; wanted_index <= length(wanted); wanted_index++) {
        character = substr(wanted, wanted_index, 1)
        if (substr(value, position, 1) == character) {
          position++
        } else if (substr(value, position, 2) == "\\u") {
          escaped_hex = tolower(substr(value, position + 2, 4))
          if (escaped_hex != expected_hex(character)) return 0
          position += 6
        } else {
          return 0
        }
      }
      return position == length(value) + 1
    }
    {
      line = $0
      for (position = 1; position <= length(line); position++) {
        character = substr(line, position, 1)
        if (inside_string) {
          if (escaped) {
            string_value = string_value character
            escaped = 0
          } else if (character == "\\") {
            string_value = string_value character
            escaped = 1
          } else if (character == "\"") {
            inside_string = 0
            if (depth == 1) pending_top_level_string = 1
          } else {
            string_value = string_value character
          }
          continue
        }

        if (pending_top_level_string) {
          if (character == " " || character == "\t" || character == "\r") continue
          if (character == ":" && is_tag_name(string_value)) tag_name_count++
          pending_top_level_string = 0
        }

        if (character == "\"") {
          inside_string = 1
          escaped = 0
          string_value = ""
        } else if (character == "{" || character == "[") {
          depth++
        } else if (character == "}" || character == "]") {
          depth--
        }
      }
      if (inside_string) invalid = 1
    }
    END { exit !(invalid != 1 && inside_string != 1 && tag_name_count == 1) }
  ' "$tag_json"
}

release_has_expected_tag() {
  tag_json=$1
  expected_tag=$2
  tag_plist="$WORK_DIR/release-tag.plist"
  actual_tag_file="$WORK_DIR/release-tag-name"
  expected_tag_file="$WORK_DIR/expected-release-tag-name"

  json_has_one_top_level_tag_name "$tag_json" || return 1
  json_to_plist "$tag_json" "$tag_plist" || return 1
  /usr/libexec/PlistBuddy -c 'Print :tag_name' "$tag_plist" > "$actual_tag_file" 2>/dev/null \
    || return 1
  printf '%s\n' "$expected_tag" > "$expected_tag_file"
  /usr/bin/cmp -s "$actual_tag_file" "$expected_tag_file"
}

release_has_asset_pair() {
  json_file=$1
  dmg_name=$2
  checksum_name=$3
  assets_plist="$WORK_DIR/release-assets.plist"
  assets_dump="$WORK_DIR/assets.dump"
  assets_head="$WORK_DIR/assets.head"
  expected_array_head="$WORK_DIR/expected-array.head"
  asset_name_file="$WORK_DIR/asset-name"
  asset_state_file="$WORK_DIR/asset-state"
  asset_url_file="$WORK_DIR/asset-url"
  expected_dmg_name="$WORK_DIR/expected-dmg-name"
  expected_checksum_name="$WORK_DIR/expected-checksum-name"
  expected_uploaded="$WORK_DIR/expected-uploaded"
  expected_dmg_url="$WORK_DIR/expected-dmg-url"
  expected_checksum_url="$WORK_DIR/expected-checksum-url"

  json_to_plist "$json_file" "$assets_plist" || return 2
  /usr/libexec/PlistBuddy -c 'Print :assets' "$assets_plist" > "$assets_dump" 2>/dev/null \
    || return 2
  /usr/bin/head -n 1 "$assets_dump" > "$assets_head"
  printf 'Array {\n' > "$expected_array_head"
  /usr/bin/cmp -s "$assets_head" "$expected_array_head" || return 2

  printf '%s\n' "$dmg_name" > "$expected_dmg_name"
  printf '%s\n' "$checksum_name" > "$expected_checksum_name"
  printf 'uploaded\n' > "$expected_uploaded"
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$REPO" "$TAG" "$dmg_name" > "$expected_dmg_url"
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$REPO" "$TAG" "$checksum_name" > "$expected_checksum_url"

  dmg_matches=0
  dmg_uploaded=0
  checksum_matches=0
  checksum_uploaded=0
  asset_index=0
  while /usr/libexec/PlistBuddy -c "Print :assets:$asset_index" "$assets_plist" >/dev/null 2>&1; do
    [ "$asset_index" -lt 1000 ] || return 2
    /usr/libexec/PlistBuddy -c "Print :assets:$asset_index:name" "$assets_plist" > "$asset_name_file" 2>/dev/null \
      || return 2
    /usr/libexec/PlistBuddy -c "Print :assets:$asset_index:state" "$assets_plist" > "$asset_state_file" 2>/dev/null \
      || return 2
    /usr/libexec/PlistBuddy -c "Print :assets:$asset_index:browser_download_url" "$assets_plist" > "$asset_url_file" 2>/dev/null \
      || return 2
    file_is_single_line_text "$asset_url_file" || return 2

    if /usr/bin/cmp -s "$asset_name_file" "$expected_dmg_name"; then
      dmg_matches=$((dmg_matches + 1))
      if /usr/bin/cmp -s "$asset_state_file" "$expected_uploaded" \
        && /usr/bin/cmp -s "$asset_url_file" "$expected_dmg_url"; then
        dmg_uploaded=$((dmg_uploaded + 1))
      fi
    elif /usr/bin/cmp -s "$asset_name_file" "$expected_checksum_name"; then
      checksum_matches=$((checksum_matches + 1))
      if /usr/bin/cmp -s "$asset_state_file" "$expected_uploaded" \
        && /usr/bin/cmp -s "$asset_url_file" "$expected_checksum_url"; then
        checksum_uploaded=$((checksum_uploaded + 1))
      fi
    fi
    asset_index=$((asset_index + 1))
  done

  [ "$dmg_matches" -eq 1 ] \
    && [ "$dmg_uploaded" -eq 1 ] \
    && [ "$checksum_matches" -eq 1 ] \
    && [ "$checksum_uploaded" -eq 1 ]
}

metadata_asset_pair_ready() {
  release_has_expected_tag "$1" "$TAG" \
    || die "Release tag_name 元数据无效，已停止安装: $RELEASE_URL"
  release_has_asset_pair "$1" "$2" "$3" && asset_status=0 || asset_status=$?
  case "$asset_status" in
    0) return 0 ;;
    1) return 1 ;;
    *) die "Release 资产元数据无效，已停止安装: $RELEASE_URL" ;;
  esac
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

start_release_deadline() {
  case "$RELEASE_TIMEOUT_SECONDS" in
    ''|*[!0-9]*|0|0[0-9]*) die "CODEX_SWITCH_RELEASE_TIMEOUT_SECONDS 必须是 1 到 900 的整数秒。" ;;
  esac
  [ "${#RELEASE_TIMEOUT_SECONDS}" -le 3 ] \
    && [ "$RELEASE_TIMEOUT_SECONDS" -le 900 ] \
    || die "CODEX_SWITCH_RELEASE_TIMEOUT_SECONDS 必须是 1 到 900 的整数秒。"
  RELEASE_START_EPOCH=$(date +%s) || die "无法读取系统时间，已停止安装。"
  case "$RELEASE_START_EPOCH" in ''|*[!0-9]*) die "无法读取系统时间，已停止安装。" ;; esac
  RELEASE_DEADLINE_EPOCH=$((RELEASE_START_EPOCH + RELEASE_TIMEOUT_SECONDS))
}

# ---------- 1. 定位 DMG ----------
if [ -z "$SRC" ]; then
  start_release_deadline
  TAG_FILE="$WORK_DIR/release-tag"
  if [ -n "$RELEASE_TAG" ]; then
    printf '%s\n' "$RELEASE_TAG" > "$TAG_FILE"
    file_is_valid_tag "$TAG_FILE" || die "指定 Release tag 无效，已停止安装。"
    IFS= read -r TAG < "$TAG_FILE" || die "指定 Release tag 无效，已停止安装。"
    say "使用指定 Release $TAG…"
  else
    say "查询最新 Release…"
    API="https://api.github.com/repos/$REPO/releases/latest"
    fetch_json "$API" "$WORK_DIR/latest.json" && latest_status=0 || latest_status=$?
    case "$latest_status" in
      0) ;;
      75) die "GitHub API latest 查询受到限流；请在限制恢复后重跑安装命令。" ;;
      124) die "查询 latest Release 已达到 ${RELEASE_TIMEOUT_SECONDS}s 安全时限；请稍后重跑安装命令。" ;;
      *) die "无法读取 GitHub latest Release；请检查网络后重跑安装命令。" ;;
    esac
    extract_tag_file "$WORK_DIR/latest.json" "$TAG_FILE" \
      || die "latest Release 返回了无效 tag 或元数据，已停止安装。"
    IFS= read -r TAG < "$TAG_FILE" \
      || die "latest Release 返回了无效 tag 或元数据，已停止安装。"
  fi

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
  ready=false
  fetch_json "$TAG_API" "$WORK_DIR/release.json" && metadata_status=0 || metadata_status=$?
  case "$metadata_status" in
    0)
      metadata_asset_pair_ready "$WORK_DIR/release.json" "$DMG_NAME" "$CHECKSUM_NAME" && ready=true || true
      ;;
    75) say "GitHub API 返回速率限制；将在安全时限内继续等待 ${TAG}…" ;;
    124) ;;
    *) say "GitHub API 暂时不可用；将在安全时限内继续等待 ${TAG}…" ;;
  esac

  if [ "$ready" != true ]; then
    for delay in $POLL_DELAYS; do
      poll_remaining=$(remaining_seconds) || break
      poll_wait=$delay
      [ "$poll_wait" -le "$poll_remaining" ] || poll_wait=$poll_remaining
      say "DMG 与 checksum 尚未同时就绪；${poll_wait}s 后重试 ${TAG}…"
      sleep "$poll_wait"
      remaining_seconds >/dev/null || break

      fetch_json "$TAG_API" "$WORK_DIR/release.json" && metadata_status=0 || metadata_status=$?
      case "$metadata_status" in
        0)
          if metadata_asset_pair_ready "$WORK_DIR/release.json" "$DMG_NAME" "$CHECKSUM_NAME"; then
            ready=true
            break
          fi
          ;;
        75) say "GitHub API 返回速率限制；将在安全时限内继续等待 ${TAG}…" ;;
        124) break ;;
        *) say "GitHub API 暂时不可用；将在安全时限内继续等待 ${TAG}…" ;;
      esac
    done
  fi
  if [ "$ready" != true ]; then
    die "等待 Release 资产超时；GitHub Actions 可能仍在构建。Release: ${RELEASE_URL}；稍后重跑: sh scripts/install-app.sh --release-tag '$TAG'"
  fi
  AUTO_RELEASE=true
fi
say "安装来源: $SRC"

# ---------- 2. 下载到临时目录 ----------
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
validate_install_destination
say "挂载 DMG…"
MOUNT_OUT=$(hdiutil attach "$DMG" -nobrowse -readonly -noverify -noautoopen 2>/dev/null | tail -1 | awk '{for(i=3;i<=NF;i++)printf "%s ",$i; print ""}' | sed 's/ *$//')
[ -n "$MOUNT_OUT" ] || die "挂载失败。"
MOUNT="$MOUNT_OUT"
say "已挂载: $MOUNT"

SRC_APP="$MOUNT/$APP_NAME.app"
[ -d "$SRC_APP" ] || die "DMG 中未找到 $APP_NAME.app"

say "安装到 $DEST…"
validate_install_destination
rm -rf "$DEST"
cp -R "$SRC_APP" "$DEST"
hdiutil detach "$MOUNT" >/dev/null 2>&1 || true

# ---------- 5. 收尾:防御性清理隔离属性 + 放行 ----------
xattr -cr "$DEST" 2>/dev/null || true
say "完成:$DEST"
say "启动…"
open "$DEST" 2>/dev/null || say "已安装;请手动打开 $APP_NAME。"
say "配置页稍后可用: http://127.0.0.1:8787/"
