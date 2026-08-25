#!/bin/sh
# Build a child-process CA bundle from the caller's existing extra CA file and
# the standard macOS system/login keychains. The existing file is never
# modified, and the published bundle is atomically replaced only after every
# PEM certificate has been parsed successfully.

CODEX_SWITCH_STATE_DIR="${CODEX_SWITCH_STATE_DIR:-$HOME/.codex-switch}"
CODEX_SWITCH_CA_BUNDLE="$CODEX_SWITCH_STATE_DIR/extra-ca.pem"
CODEX_SWITCH_CA_TMP="$CODEX_SWITCH_STATE_DIR/.extra-ca.pem.$$"
CODEX_SWITCH_CA_PART="$CODEX_SWITCH_CA_TMP.part"
CODEX_SWITCH_CA_SPLIT="$CODEX_SWITCH_CA_TMP.certificate"
CODEX_SWITCH_CA_COUNT="$CODEX_SWITCH_CA_TMP.count"
CODEX_SWITCH_LOGIN_INFO="$CODEX_SWITCH_CA_TMP.login"
CODEX_SWITCH_SYSTEM_KEYCHAIN="${CODEX_SWITCH_SYSTEM_KEYCHAIN:-/System/Library/Keychains/SystemRootCertificates.keychain}"
if [ "${NODE_EXTRA_CA_CERTS+x}" = x ]; then
  CODEX_SWITCH_INHERITED_CA_SET=1
else
  CODEX_SWITCH_INHERITED_CA_SET=0
fi
CODEX_SWITCH_INHERITED_CA=${NODE_EXTRA_CA_CERTS-}

codex_switch_remove_ca_scratch() {
  rm -f "$CODEX_SWITCH_CA_TMP" "$CODEX_SWITCH_CA_PART" "$CODEX_SWITCH_CA_COUNT" "$CODEX_SWITCH_LOGIN_INFO" 2>/dev/null
  CODEX_SWITCH_REMOVE_INDEX=1
  while [ "$CODEX_SWITCH_REMOVE_INDEX" -le "${CODEX_SWITCH_MAX_CERT_COUNT:-0}" ]; do
    rm -f "$CODEX_SWITCH_CA_SPLIT.$CODEX_SWITCH_REMOVE_INDEX" 2>/dev/null
    CODEX_SWITCH_REMOVE_INDEX=$((CODEX_SWITCH_REMOVE_INDEX + 1))
  done
}

codex_switch_validate_ca_bundle() {
  CODEX_SWITCH_CERT_COUNT=0
  [ -f "$1" ] && [ -r "$1" ] || return 1
  rm -f "$CODEX_SWITCH_CA_COUNT" 2>/dev/null || return 1
  CODEX_SWITCH_AWK_STATUS=0
  awk -v prefix="$CODEX_SWITCH_CA_SPLIT" -v count_file="$CODEX_SWITCH_CA_COUNT" '
    BEGIN { inside = 0; count = 0; invalid = 0 }
    $0 == "-----BEGIN CERTIFICATE-----" {
      if (inside) { invalid = 1; exit }
      inside = 1
      count++
      output = prefix "." count
      print > output
      next
    }
    $0 == "-----END CERTIFICATE-----" {
      if (!inside) { invalid = 1; exit }
      print > output
      close(output)
      inside = 0
      next
    }
    {
      if (inside) print > output
      else if ($0 !~ /^[[:space:]]*$/) { invalid = 1; exit }
    }
    END {
      print count > count_file
      close(count_file)
      if (invalid || inside || count == 0) exit 2
    }
  ' "$1" >/dev/null 2>&1 || CODEX_SWITCH_AWK_STATUS=$?
  if ! IFS= read -r CODEX_SWITCH_CERT_COUNT < "$CODEX_SWITCH_CA_COUNT"; then
    CODEX_SWITCH_CERT_COUNT=0
  fi
  case "$CODEX_SWITCH_CERT_COUNT" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$CODEX_SWITCH_CERT_COUNT" -gt "${CODEX_SWITCH_MAX_CERT_COUNT:-0}" ]; then
    CODEX_SWITCH_MAX_CERT_COUNT=$CODEX_SWITCH_CERT_COUNT
  fi
  [ "$CODEX_SWITCH_AWK_STATUS" -eq 0 ] || return 1
  [ "$CODEX_SWITCH_CERT_COUNT" -gt 0 ] || return 1
  CODEX_SWITCH_VALIDATE_INDEX=1
  while [ "$CODEX_SWITCH_VALIDATE_INDEX" -le "$CODEX_SWITCH_CERT_COUNT" ]; do
    openssl x509 -in "$CODEX_SWITCH_CA_SPLIT.$CODEX_SWITCH_VALIDATE_INDEX" -noout >/dev/null 2>&1 || return 1
    CODEX_SWITCH_VALIDATE_INDEX=$((CODEX_SWITCH_VALIDATE_INDEX + 1))
  done
  return 0
}

codex_switch_append_ca_bundle() {
  codex_switch_validate_ca_bundle "$1" || return 1
  cat "$1" >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || return 1
  printf '\n' >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || return 1
  return 0
}

CODEX_SWITCH_CA_READY=0
CODEX_SWITCH_MAX_CERT_COUNT=0
if command -v openssl >/dev/null 2>&1; then
  if [ "$CODEX_SWITCH_INHERITED_CA" = "$CODEX_SWITCH_CA_BUNDLE" ] && codex_switch_validate_ca_bundle "$CODEX_SWITCH_CA_BUNDLE"; then
    CODEX_SWITCH_CA_READY=1
  elif command -v security >/dev/null 2>&1 && [ -f "$CODEX_SWITCH_SYSTEM_KEYCHAIN" ]; then
    umask 077
    CODEX_SWITCH_CA_BUILD_OK=1
    if ! mkdir -p "$CODEX_SWITCH_STATE_DIR" || ! : > "$CODEX_SWITCH_CA_TMP"; then
      CODEX_SWITCH_CA_BUILD_OK=0
      echo "[codex-switch] failed to create temporary extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ] && [ -n "$CODEX_SWITCH_INHERITED_CA" ] && [ "$CODEX_SWITCH_INHERITED_CA" != "$CODEX_SWITCH_CA_BUNDLE" ]; then
      if ! codex_switch_append_ca_bundle "$CODEX_SWITCH_INHERITED_CA"; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] invalid inherited extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      if ! security find-certificate -a -p "$CODEX_SWITCH_SYSTEM_KEYCHAIN" > "$CODEX_SWITCH_CA_PART" 2>/dev/null || ! codex_switch_append_ca_bundle "$CODEX_SWITCH_CA_PART"; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] failed to read a valid system CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      if ! security login-keychain > "$CODEX_SWITCH_LOGIN_INFO" 2>/dev/null; then
        CODEX_SWITCH_CA_BUILD_OK=0
        echo "[codex-switch] failed to inspect the login keychain; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      else
        CODEX_SWITCH_LOGIN_KEYCHAIN=$(sed -n 's/.*"\([^"]*\.keychain[^" ]*\)".*/\1/p' "$CODEX_SWITCH_LOGIN_INFO")
        if [ -s "$CODEX_SWITCH_LOGIN_INFO" ] && [ -z "$CODEX_SWITCH_LOGIN_KEYCHAIN" ]; then
          CODEX_SWITCH_CA_BUILD_OK=0
          echo "[codex-switch] received invalid login keychain metadata; preserving inherited NODE_EXTRA_CA_CERTS" >&2
        elif [ -n "$CODEX_SWITCH_LOGIN_KEYCHAIN" ]; then
          if ! security find-certificate -a -p "$CODEX_SWITCH_LOGIN_KEYCHAIN" > "$CODEX_SWITCH_CA_PART" 2>/dev/null || ! codex_switch_append_ca_bundle "$CODEX_SWITCH_CA_PART"; then
            CODEX_SWITCH_CA_BUILD_OK=0
            echo "[codex-switch] failed to read a valid login CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
          fi
        fi
      fi
    fi

    if [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ] && codex_switch_validate_ca_bundle "$CODEX_SWITCH_CA_TMP"; then
      if mv -f "$CODEX_SWITCH_CA_TMP" "$CODEX_SWITCH_CA_BUNDLE"; then
        CODEX_SWITCH_CA_READY=1
      else
        echo "[codex-switch] failed to publish extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
      fi
    elif [ "$CODEX_SWITCH_CA_BUILD_OK" -eq 1 ]; then
      echo "[codex-switch] generated invalid extra CA bundle; preserving inherited NODE_EXTRA_CA_CERTS" >&2
    fi
  fi
fi

if [ "$CODEX_SWITCH_CA_READY" -eq 1 ]; then
  export NODE_EXTRA_CA_CERTS="$CODEX_SWITCH_CA_BUNDLE"
else
  if [ "$CODEX_SWITCH_INHERITED_CA_SET" -eq 1 ]; then
    NODE_EXTRA_CA_CERTS=$CODEX_SWITCH_INHERITED_CA
    export NODE_EXTRA_CA_CERTS
  else
    unset NODE_EXTRA_CA_CERTS
  fi
fi

codex_switch_remove_ca_scratch
unset CODEX_SWITCH_CA_TMP CODEX_SWITCH_CA_PART CODEX_SWITCH_CA_SPLIT CODEX_SWITCH_CA_COUNT
unset CODEX_SWITCH_LOGIN_INFO CODEX_SWITCH_LOGIN_KEYCHAIN CODEX_SWITCH_SYSTEM_KEYCHAIN
unset CODEX_SWITCH_CA_BUNDLE CODEX_SWITCH_STATE_DIR CODEX_SWITCH_INHERITED_CA CODEX_SWITCH_INHERITED_CA_SET
unset CODEX_SWITCH_CA_READY CODEX_SWITCH_CA_BUILD_OK CODEX_SWITCH_CERT_COUNT CODEX_SWITCH_MAX_CERT_COUNT
unset CODEX_SWITCH_REMOVE_INDEX CODEX_SWITCH_VALIDATE_INDEX CODEX_SWITCH_AWK_STATUS
