#!/usr/bin/env bash
# Runs the moo2v2 game server (lobbylink lobby linked in as a library + the
# /pbm/ play-by-mail endpoints) for development and e2e tests.
# Requires Go and a checkout of https://github.com/danielrh/lobbylink as a
# SIBLING of this repo (default: ~/dev/lobbylink; the server/go.mod replace
# directive points at ../../lobbylink — override with LOBBYLINK_DIR only if
# you also adjust that).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/../server"
LOBBYLINK_DIR="${LOBBYLINK_DIR:-$HOME/dev/lobbylink}"
if [ ! -d "$LOBBYLINK_DIR/lobbyserver" ]; then
  echo "lobbylink checkout (with the lobbyserver package) not found at $LOBBYLINK_DIR" >&2
  exit 1
fi

# Play-by-mail endpoints (/pbm/): dev password "moo2", saves under /tmp.
PBM_CONFIG="${PBM_CONFIG:-$SCRIPT_DIR/pbm-config.dev.json}"

cd "$SERVER_DIR"
exec go run ./cmd/moo2v2-server \
  --listen-http 127.0.0.1:8787 \
  --allowed-origin "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:8787,http://127.0.0.1:8787" \
  --public-url http://127.0.0.1:8787 \
  --pbm-config "$PBM_CONFIG" \
  "$@"
