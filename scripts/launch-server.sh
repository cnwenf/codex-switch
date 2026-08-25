#!/bin/sh
# Load the optional local environment and CA setup, then replace this shell
# with the packaged Node server. All paths arrive as positional parameters so
# the caller never has to interpolate filesystem data into shell source text.

if [ "$#" -ne 4 ]; then
  echo "usage: launch-server.sh ENV_FILE PREPARE_CA NODE_BIN SERVER_JS" >&2
  exit 64
fi

if [ -f "$1" ]; then
  . "$1"
fi
if [ -f "$2" ]; then
  . "$2"
fi
exec "$3" "$4"
