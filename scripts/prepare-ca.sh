#!/bin/sh
# Build a child-process CA bundle from the caller's existing extra CA file and
# the standard macOS system/login keychains. Scratch files are created with
# mktemp inside a private, owner-only state directory. The published bundle is
# atomically replaced only after every PEM certificate parses successfully.

CODEX_SWITCH_STATE_DIR="${CODEX_SWITCH_STATE_DIR:-$HOME/.codex-switch}"
CODEX_SWITCH_CA_BUNDLE="$CODEX_SWITCH_STATE_DIR/extra-ca.pem"
CODEX_SWITCH_SYSTEM_KEYCHAIN="${CODEX_SWITCH_SYSTEM_KEYCHAIN:-/System/Library/Keychains/SystemRootCertificates.keychain}"
if [ "${NODE_EXTRA_CA_CERTS+x}" = x ]; then
  CODEX_SWITCH_INHERITED_CA_SET=1
else
  CODEX_SWITCH_INHERITED_CA_SET=0
fi
CODEX_SWITCH_INHERITED_CA=${NODE_EXTRA_CA_CERTS-}

CODEX_SWITCH_CA_TMP=
CODEX_SWITCH_CA_PART=
CODEX_SWITCH_CA_CERT=
CODEX_SWITCH_CA_NORMALIZED=
CODEX_SWITCH_LOGIN_INFO=

codex_switch_is_regular_file() {
  [ -n "$1" ] && [ -f "$1" ] && [ ! -L "$1" ]
}

codex_switch_stat_owner() {
  CODEX_SWITCH_STAT_VALUE=$(/usr/bin/stat -f '%u' "$1" 2>/dev/null) || CODEX_SWITCH_STAT_VALUE=
  case "$CODEX_SWITCH_STAT_VALUE" in
    ''|*[!0-9]*)
      CODEX_SWITCH_STAT_VALUE=$(/usr/bin/stat -c '%u' "$1" 2>/dev/null) || return 1
      ;;
  esac
  case "$CODEX_SWITCH_STAT_VALUE" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "$CODEX_SWITCH_STAT_VALUE"
}

codex_switch_stat_mode() {
  CODEX_SWITCH_STAT_VALUE=$(/usr/bin/stat -f '%Lp' "$1" 2>/dev/null) || CODEX_SWITCH_STAT_VALUE=
  case "$CODEX_SWITCH_STAT_VALUE" in
    ''|*[!0-7]*)
      CODEX_SWITCH_STAT_VALUE=$(/usr/bin/stat -c '%a' "$1" 2>/dev/null) || return 1
      ;;
  esac
  case "$CODEX_SWITCH_STAT_VALUE" in
    ''|*[!0-7]*) return 1 ;;
  esac
  printf '%s' "$CODEX_SWITCH_STAT_VALUE"
}

codex_switch_is_owned_by_current_user() {
  CODEX_SWITCH_EXPECTED_UID=$(/usr/bin/id -u 2>/dev/null) || return 1
  CODEX_SWITCH_ACTUAL_UID=$(codex_switch_stat_owner "$1") || return 1
  [ "$CODEX_SWITCH_ACTUAL_UID" = "$CODEX_SWITCH_EXPECTED_UID" ]
}

codex_switch_prepare_state_dir() {
  [ ! -L "$CODEX_SWITCH_STATE_DIR" ] || return 1
  if [ ! -e "$CODEX_SWITCH_STATE_DIR" ]; then
    mkdir -p "$CODEX_SWITCH_STATE_DIR" >/dev/null 2>&1 || return 1
  fi
  [ -d "$CODEX_SWITCH_STATE_DIR" ] && [ ! -L "$CODEX_SWITCH_STATE_DIR" ] || return 1
  codex_switch_is_owned_by_current_user "$CODEX_SWITCH_STATE_DIR" || return 1
  chmod 700 "$CODEX_SWITCH_STATE_DIR" >/dev/null 2>&1 || return 1
  [ "$(codex_switch_stat_mode "$CODEX_SWITCH_STATE_DIR")" = 700 ] || return 1
}

codex_switch_is_safe_scratch() {
  codex_switch_is_regular_file "$1" || return 1
  [ "${1%/*}" = "$CODEX_SWITCH_STATE_DIR" ] || return 1
  codex_switch_is_owned_by_current_user "$1" || return 1
  [ "$(codex_switch_stat_mode "$1")" = 600 ] || return 1
}

codex_switch_make_scratch() {
  CODEX_SWITCH_NEW_SCRATCH=$(mktemp "$CODEX_SWITCH_STATE_DIR/.ca-$1.XXXXXX" 2>/dev/null) || return 1
  codex_switch_is_safe_scratch "$CODEX_SWITCH_NEW_SCRATCH" || return 1
  printf '%s' "$CODEX_SWITCH_NEW_SCRATCH"
}

codex_switch_remove_one_scratch() {
  if codex_switch_is_safe_scratch "$1"; then
    rm -f "$1" >/dev/null 2>&1 || :
  fi
}

codex_switch_remove_ca_scratch() {
  codex_switch_remove_one_scratch "$CODEX_SWITCH_CA_TMP"
  codex_switch_remove_one_scratch "$CODEX_SWITCH_CA_PART"
  codex_switch_remove_one_scratch "$CODEX_SWITCH_CA_CERT"
  codex_switch_remove_one_scratch "$CODEX_SWITCH_CA_NORMALIZED"
  codex_switch_remove_one_scratch "$CODEX_SWITCH_LOGIN_INFO"
}

codex_switch_truncate_scratch() {
  codex_switch_is_safe_scratch "$1" || return 1
  : > "$1" 2>/dev/null || return 1
  codex_switch_is_safe_scratch "$1"
}

# Parse a PEM bundle without passing any path through awk variables. A single
# terminal CR is normalized on each line so valid CRLF PEM works; embedded CR
# bytes and all non-whitespace block-external content remain invalid.
codex_switch_normalize_ca_bundle() {
  CODEX_SWITCH_CA_SOURCE=$1
  CODEX_SWITCH_CA_OUTPUT=$2
  codex_switch_is_regular_file "$CODEX_SWITCH_CA_SOURCE" && [ -r "$CODEX_SWITCH_CA_SOURCE" ] || return 1
  codex_switch_truncate_scratch "$CODEX_SWITCH_CA_OUTPUT" || return 1
  codex_switch_truncate_scratch "$CODEX_SWITCH_CA_CERT" || return 1
  CODEX_SWITCH_CA_INSIDE=0
  CODEX_SWITCH_CA_COUNT=0
  CODEX_SWITCH_CR=$(printf '\r') || return 1
  while IFS= read -r CODEX_SWITCH_CA_LINE || [ -n "$CODEX_SWITCH_CA_LINE" ]; do
    case "$CODEX_SWITCH_CA_LINE" in
      *"$CODEX_SWITCH_CR") CODEX_SWITCH_CA_LINE=${CODEX_SWITCH_CA_LINE%"$CODEX_SWITCH_CR"} ;;
    esac
    case "$CODEX_SWITCH_CA_LINE" in
      '-----BEGIN CERTIFICATE-----')
        [ "$CODEX_SWITCH_CA_INSIDE" -eq 0 ] || return 1
        codex_switch_truncate_scratch "$CODEX_SWITCH_CA_CERT" || return 1
        CODEX_SWITCH_CA_INSIDE=1
        CODEX_SWITCH_CA_COUNT=$((CODEX_SWITCH_CA_COUNT + 1))
        printf '%s\n' "$CODEX_SWITCH_CA_LINE" >> "$CODEX_SWITCH_CA_CERT" 2>/dev/null || return 1
        ;;
      '-----END CERTIFICATE-----')
        [ "$CODEX_SWITCH_CA_INSIDE" -eq 1 ] || return 1
        printf '%s' "$CODEX_SWITCH_CA_LINE" >> "$CODEX_SWITCH_CA_CERT" 2>/dev/null || return 1
        openssl x509 -in "$CODEX_SWITCH_CA_CERT" -noout >/dev/null 2>&1 || return 1
        cat "$CODEX_SWITCH_CA_CERT" >> "$CODEX_SWITCH_CA_OUTPUT" 2>/dev/null || return 1
        printf '\n' >> "$CODEX_SWITCH_CA_OUTPUT" 2>/dev/null || return 1
        CODEX_SWITCH_CA_INSIDE=0
        ;;
      *)
        if [ "$CODEX_SWITCH_CA_INSIDE" -eq 1 ]; then
          printf '%s\n' "$CODEX_SWITCH_CA_LINE" >> "$CODEX_SWITCH_CA_CERT" 2>/dev/null || return 1
        else
          case "$CODEX_SWITCH_CA_LINE" in
            *[![:space:]]*) return 1 ;;
          esac
        fi
        ;;
    esac
  done < "$CODEX_SWITCH_CA_SOURCE"
  [ "$CODEX_SWITCH_CA_INSIDE" -eq 0 ] && [ "$CODEX_SWITCH_CA_COUNT" -gt 0 ]
}

codex_switch_validate_ca_bundle() {
  codex_switch_normalize_ca_bundle "$1" "$CODEX_SWITCH_CA_NORMALIZED"
}

codex_switch_append_ca_bundle() {
  codex_switch_normalize_ca_bundle "$1" "$CODEX_SWITCH_CA_NORMALIZED" || return 1
  codex_switch_is_safe_scratch "$CODEX_SWITCH_CA_TMP" || return 1
  cat "$CODEX_SWITCH_CA_NORMALIZED" >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || return 1
}

codex_switch_create_ca_scratch() {
  CODEX_SWITCH_CA_TMP=$(codex_switch_make_scratch build) || return 1
  CODEX_SWITCH_CA_PART=$(codex_switch_make_scratch part) || return 1
  CODEX_SWITCH_CA_CERT=$(codex_switch_make_scratch cert) || return 1
  CODEX_SWITCH_CA_NORMALIZED=$(codex_switch_make_scratch normalized) || return 1
  CODEX_SWITCH_LOGIN_INFO=$(codex_switch_make_scratch login) || return 1
}

CODEX_SWITCH_CA_READY=0
CODEX_SWITCH_CA_BUILD_OK=0
CODEX_SWITCH_CA_CAN_INSPECT=0
CODEX_SWITCH_CA_STATE_SAFE=0
if command -v openssl >/dev/null 2>&1; then
  if command -v security >/dev/null 2>&1 && [ -f "$CODEX_SWITCH_SYSTEM_KEYCHAIN" ]; then
    CODEX_SWITCH_CA_CAN_INSPECT=1
  fi

  if [ "$CODEX_SWITCH_INHERITED_CA" = "$CODEX_SWITCH_CA_BUNDLE" ] || [ "$CODEX_SWITCH_CA_CAN_INSPECT" -eq 1 ]; then
    umask 077
    if ! codex_switch_prepare_state_dir; then
      echo "[codex-switch] unsafe CA state directory; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    else
      CODEX_SWITCH_CA_STATE_SAFE=1
      trap 'codex_switch_remove_ca_scratch' 0
      trap 'codex_switch_remove_ca_scratch; trap - 1; kill -HUP "$$"' 1
      trap 'codex_switch_remove_ca_scratch; trap - 2; kill -INT "$$"' 2
      trap 'codex_switch_remove_ca_scratch; trap - 15; kill -TERM "$$"' 15
    fi
    if [ "$CODEX_SWITCH_CA_STATE_SAFE" -eq 1 ] && { [ -e "$CODEX_SWITCH_CA_BUNDLE" ] || [ -L "$CODEX_SWITCH_CA_BUNDLE" ]; }; then
      if ! codex_switch_is_regular_file "$CODEX_SWITCH_CA_BUNDLE" || ! codex_switch_is_owned_by_current_user "$CODEX_SWITCH_CA_BUNDLE"; then
        echo "[codex-switch] unsafe existing extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      elif ! codex_switch_create_ca_scratch; then
        echo "[codex-switch] failed to create secure CA scratch files; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      else
        if [ "$CODEX_SWITCH_INHERITED_CA" = "$CODEX_SWITCH_CA_BUNDLE" ] && codex_switch_validate_ca_bundle "$CODEX_SWITCH_CA_BUNDLE"; then
          CODEX_SWITCH_CA_READY=1
        elif [ "$CODEX_SWITCH_CA_CAN_INSPECT" -eq 1 ]; then
          CODEX_SWITCH_CA_BUILD_OK=1
        fi
      fi
    elif [ "$CODEX_SWITCH_CA_STATE_SAFE" -eq 1 ] && ! codex_switch_create_ca_scratch; then
      echo "[codex-switch] failed to create secure CA scratch files; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    elif [ "$CODEX_SWITCH_CA_STATE_SAFE" -eq 1 ]; then
      [ "$CODEX_SWITCH_CA_CAN_INSPECT" -eq 1 ] && CODEX_SWITCH_CA_BUILD_OK=1
    fi
  fi

  if [ "$CODEX_SWITCH_CA_READY" -eq 0 ] && [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
    if ! codex_switch_truncate_scratch "$CODEX_SWITCH_CA_TMP"; then
      CODEX_SWITCH_CA_BUILD_OK=0
      echo "[codex-switch] failed to initialize extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ] && [ -n "$CODEX_SWITCH_INHERITED_CA" ] && [ "$CODEX_SWITCH_INHERITED_CA" != "$CODEX_SWITCH_CA_BUNDLE" ]; then
      if ! codex_switch_append_ca_bundle "$CODEX_SWITCH_INHERITED_CA"; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] invalid inherited extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      if ! codex_switch_is_safe_scratch "$CODEX_SWITCH_CA_PART" || ! security find-certificate -a -p "$CODEX_SWITCH_SYSTEM_KEYCHAIN" > "$CODEX_SWITCH_CA_PART" 2>/dev/null || ! codex_switch_append_ca_bundle "$CODEX_SWITCH_CA_PART"; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] failed to read a valid system CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      if ! codex_switch_is_safe_scratch "$CODEX_SWITCH_LOGIN_INFO" || ! security login-keychain > "$CODEX_SWITCH_LOGIN_INFO" 2>/dev/null; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] failed to inspect the login keychain; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      else
        CODEX_SWITCH_LOGIN_KEYCHAIN=$(sed -n 's/.*"\([^"]*\.keychain[^" ]*\)".*/\1/p' "$CODEX_SWITCH_LOGIN_INFO" 2>/dev/null) || CODEX_SWITCH_CA_BUILD_OK=0
        if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 0 ]; then
          echo "[codex-switch] failed to parse login keychain metadata; preserving inherited NODE_EXTRA_CA_CERTS" >&2
        elif [ -s "$CODEX_SWITCH_LOGIN_INFO" ] && [ -z "$CODEX_SWITCH_LOGIN_KEYCHAIN" ]; then
          CODEX_SWITCH_CA_BUILD_OK=0
          echo "[codex-switch] received invalid login keychain metadata; preserving inherited NODE_EXTRA_CA_CERTS" >&2
        elif [ -n "$CODEX_SWITCH_LOGIN_KEYCHAIN" ]; then
          if ! codex_switch_is_safe_scratch "$CODEX_SWITCH_CA_PART" || ! security find-certificate -a -p "$CODEX_SWITCH_LOGIN_KEYCHAIN" > "$CODEX_SWITCH_CA_PART" 2>/dev/null || ! codex_switch_append_ca_bundle "$CODEX_SWITCH_CA_PART"; then
            CODEX_SWITCH_CA_BUILD_OK=0
            echo "[codex-switch] failed to read a valid login CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
          fi
        fi
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ] && codex_switch_validate_ca_bundle "$CODEX_SWITCH_CA_TMP"; then
      if { [ ! -e "$CODEX_SWITCH_CA_BUNDLE" ] && [ ! -L "$CODEX_SWITCH_CA_BUNDLE" ]; } || codex_switch_is_regular_file "$CODEX_SWITCH_CA_BUNDLE"; then
        if mv -f "$CODEX_SWITCH_CA_TMP" "$CODEX_SWITCH_CA_BUNDLE" >/dev/null 2>&1 && codex_switch_is_regular_file "$CODEX_SWITCH_CA_BUNDLE" && codex_switch_is_owned_by_current_user "$CODEX_SWITCH_CA_BUNDLE" && [ "$(codex_switch_stat_mode "$CODEX_SWITCH_CA_BUNDLE")" = 600 ]; then
          CODEX_SWITCH_CA_TMP=
          CODEX_SWITCH_CA_READY=1
        else
          echo "[codex-switch] failed to publish extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
        fi
      else
        echo "[codex-switch] unsafe existing extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    elif [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      echo "[codex-switch] generated invalid extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    fi
  fi
fi

if [ "$CODEX_SWITCH_CA_READY" -eq 1 ]; then
  export NODE_EXTRA_CA_CERTS="$CODEX_SWITCH_CA_BUNDLE"
elif [ "$CODEX_SWITCH_INHERITED_CA_SET" -eq 1 ]; then
  NODE_EXTRA_CA_CERTS=$CODEX_SWITCH_INHERITED_CA
  export NODE_EXTRA_CA_CERTS
else
  unset NODE_EXTRA_CA_CERTS
fi

codex_switch_remove_ca_scratch
trap - 0 1 2 15
unset CODEX_SWITCH_CA_TMP CODEX_SWITCH_CA_PART CODEX_SWITCH_CA_CERT CODEX_SWITCH_CA_NORMALIZED
unset CODEX_SWITCH_LOGIN_INFO CODEX_SWITCH_LOGIN_KEYCHAIN CODEX_SWITCH_SYSTEM_KEYCHAIN
unset CODEX_SWITCH_CA_BUNDLE CODEX_SWITCH_STATE_DIR CODEX_SWITCH_INHERITED_CA CODEX_SWITCH_INHERITED_CA_SET
unset CODEX_SWITCH_CA_READY CODEX_SWITCH_CA_BUILD_OK CODEX_SWITCH_CA_CAN_INSPECT CODEX_SWITCH_CA_STATE_SAFE CODEX_SWITCH_CA_SOURCE
unset CODEX_SWITCH_CA_OUTPUT CODEX_SWITCH_CA_INSIDE CODEX_SWITCH_CA_COUNT CODEX_SWITCH_CA_LINE CODEX_SWITCH_CR
unset CODEX_SWITCH_NEW_SCRATCH CODEX_SWITCH_EXPECTED_UID CODEX_SWITCH_ACTUAL_UID CODEX_SWITCH_STAT_VALUE
