#!/bin/sh
# Load the optional local environment, then replace this shell with the
# packaged Node server using Node's native macOS system CA support. All paths
# arrive as positional parameters so the caller never has to interpolate
# filesystem data into shell source text.

if [ "$#" -ne 3 ]; then
  echo "usage: launch-server.sh ENV_FILE NODE_BIN SERVER_JS" >&2
  exit 64
fi

if [ -f "$1" ]; then
  . "$1"
fi
exec "$2" --use-system-ca "$3"
