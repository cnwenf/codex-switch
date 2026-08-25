#!/bin/sh
# Build a child-process CA bundle from the caller's existing extra CA file and
# the standard macOS system/login keychains. The existing file is never
# modified, and a temporary file avoids truncating a bundle inherited from a
# previous launch.

CODEX_SWITCH_STATE_DIR="${CODEX_SWITCH_STATE_DIR:-$HOME/.codex-switch}"
CODEX_SWITCH_CA_BUNDLE="$CODEX_SWITCH_STATE_DIR/extra-ca.pem"
CODEX_SWITCH_CA_TMP="$CODEX_SWITCH_STATE_DIR/.extra-ca.pem.$$"
CODEX_SWITCH_SYSTEM_KEYCHAIN="${CODEX_SWITCH_SYSTEM_KEYCHAIN:-/System/Library/Keychains/SystemRootCertificates.keychain}"

if [ "${NODE_EXTRA_CA_CERTS:-}" = "$CODEX_SWITCH_CA_BUNDLE" ] && [ -s "$CODEX_SWITCH_CA_BUNDLE" ]; then
  export NODE_EXTRA_CA_CERTS="$CODEX_SWITCH_CA_BUNDLE"
elif command -v security >/dev/null 2>&1 && [ -f "$CODEX_SWITCH_SYSTEM_KEYCHAIN" ]; then
  mkdir -p "$CODEX_SWITCH_STATE_DIR"
  umask 077
  : > "$CODEX_SWITCH_CA_TMP"
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
    cat "$NODE_EXTRA_CA_CERTS" >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || true
  fi
  security find-certificate -a -p "$CODEX_SWITCH_SYSTEM_KEYCHAIN" >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || true
  CODEX_SWITCH_LOGIN_KEYCHAIN=$(security login-keychain 2>/dev/null | sed -n 's/.*"\([^"]*\.keychain[^" ]*\)".*/\1/p')
  if [ -n "$CODEX_SWITCH_LOGIN_KEYCHAIN" ]; then
    security find-certificate -a -p "$CODEX_SWITCH_LOGIN_KEYCHAIN" >> "$CODEX_SWITCH_CA_TMP" 2>/dev/null || true
  fi
  if [ -s "$CODEX_SWITCH_CA_TMP" ]; then
    mv -f "$CODEX_SWITCH_CA_TMP" "$CODEX_SWITCH_CA_BUNDLE"
    export NODE_EXTRA_CA_CERTS="$CODEX_SWITCH_CA_BUNDLE"
  else
    rm -f "$CODEX_SWITCH_CA_TMP"
  fi
fi

unset CODEX_SWITCH_CA_TMP CODEX_SWITCH_LOGIN_KEYCHAIN CODEX_SWITCH_SYSTEM_KEYCHAIN
unset CODEX_SWITCH_CA_BUNDLE CODEX_SWITCH_STATE_DIR
