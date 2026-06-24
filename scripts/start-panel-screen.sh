#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCREEN_NAME="${SCREEN_NAME:-unmc-panel}"
PANEL_PORT="${PANEL_PORT:-8765}"

if { screen -ls 2>/dev/null || true; } | grep -q "[.]${SCREEN_NAME}[[:space:]]"; then
  echo "Screen session $SCREEN_NAME is already running."
else
  if lsof -tiTCP:"$PANEL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    PANEL_PID="$(lsof -tiTCP:"$PANEL_PORT" -sTCP:LISTEN | head -n 1)"
    PANEL_COMMAND="$(ps -p "$PANEL_PID" -o command= 2>/dev/null || true)"
    if [[ "$PANEL_COMMAND" == *"/panel/server.py"* ]]; then
      echo "Panel is already running on port $PANEL_PORT."
    else
      echo "Panel port $PANEL_PORT is already in use by another process."
      echo "Run: lsof -nP -iTCP:$PANEL_PORT -sTCP:LISTEN"
      exit 1
    fi
  else
    screen -dmS "$SCREEN_NAME" "$ROOT_DIR/scripts/start-panel.sh"
    echo "Started panel in screen session: $SCREEN_NAME"
  fi
fi

echo "Open: http://127.0.0.1:$PANEL_PORT"
