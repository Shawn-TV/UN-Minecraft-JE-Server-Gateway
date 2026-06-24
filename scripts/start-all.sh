#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
TUNNEL_SCREEN_NAME="${TUNNEL_SCREEN_NAME:-${SCREEN_PREFIX:-unmc}-tunnel}"

"$ROOT_DIR/scripts/start-je-screen.sh"

if { screen -ls 2>/dev/null || true; } | grep -q "[.]${TUNNEL_SCREEN_NAME}[[:space:]]"; then
  echo "Screen session $TUNNEL_SCREEN_NAME is already running."
else
  screen -dmS "$TUNNEL_SCREEN_NAME" "$ROOT_DIR/scripts/tunnel-loop.sh"
  echo "Started tunnel loop in screen session: $TUNNEL_SCREEN_NAME"
fi

"$ROOT_DIR/scripts/start-panel-screen.sh"

screen -ls || true
