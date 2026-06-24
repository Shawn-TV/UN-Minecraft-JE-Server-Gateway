#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/start-je-screen.sh"

if { screen -ls 2>/dev/null || true; } | grep -q '[.]unmc-tunnel[[:space:]]'; then
  echo "Screen session unmc-tunnel is already running."
else
  screen -dmS unmc-tunnel "$ROOT_DIR/scripts/tunnel-loop.sh"
  echo "Started tunnel loop in screen session: unmc-tunnel"
fi

"$ROOT_DIR/scripts/start-panel-screen.sh"

screen -ls || true
