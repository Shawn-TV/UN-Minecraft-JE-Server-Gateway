#!/usr/bin/env bash
set -euo pipefail

SCREEN_NAME="${SCREEN_NAME:-unmc-panel}"
PANEL_PORT="${PANEL_PORT:-8765}"

screen -S "$SCREEN_NAME" -X quit 2>/dev/null || true
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" == *"/panel/server.py"* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
done < <(lsof -tiTCP:"$PANEL_PORT" -sTCP:LISTEN 2>/dev/null || true)

echo "Stopped panel screen session if it was running."
