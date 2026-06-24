#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCREEN_NAME="${SCREEN_NAME:-unmc-je}"

if { screen -ls 2>/dev/null || true; } | grep -q "[.]${SCREEN_NAME}[[:space:]]"; then
  if pgrep -f 'purpur-.*[.]jar' >/dev/null 2>&1; then
    echo "Screen session $SCREEN_NAME is already running."
    exit 0
  fi
  echo "Found stale $SCREEN_NAME screen without Java; closing it before start."
  screen -S "$SCREEN_NAME" -X quit 2>/dev/null || true
  sleep 1
fi

mkdir -p "$ROOT_DIR/logs"
screen -dmS "$SCREEN_NAME" "$ROOT_DIR/scripts/start-je.sh"

echo "Started JE server in screen session: $SCREEN_NAME"
echo "Attach with: screen -r $SCREEN_NAME"
echo "Detach with: Ctrl-A then D"
