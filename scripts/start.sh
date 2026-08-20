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
BUNDLE="$DIR/extra-ca.pem"

if [ -d /System/Library/Keychains ] && command -v security >/dev/null 2>&1; then
  mkdir -p "$DIR"
  : > "$BUNDLE"
  [ -n "$NODE_EXTRA_CA_CERTS" ] && cat "$NODE_EXTRA_CA_CERTS" >> "$BUNDLE" 2>/dev/null
  security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> "$BUNDLE" 2>/dev/null
  LK=$(security login-keychain 2>/dev/null | sed -n 's/.*"\([^"]*\.keychain[^"]*\)".*/\1/p')
  [ -n "$LK" ] && security find-certificate -a -p "$LK" >> "$BUNDLE" 2>/dev/null
  if [ -s "$BUNDLE" ]; then
    export NODE_EXTRA_CA_CERTS="$BUNDLE"
    echo "[codex-switch] extra CA bundle -> $BUNDLE (env value + macOS keychains)"
  fi
fi

exec node src/server.js "$@"