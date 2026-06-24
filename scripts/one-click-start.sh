#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/one-click-start.log"
PANEL_URL="${PANEL_URL:-http://127.0.0.1:8765}"

mkdir -p "$LOG_DIR"

{
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] one-click launcher started"
} >> "$LOG_FILE" 2>&1

status=0
"$ROOT_DIR/scripts/start-all.sh" >> "$LOG_FILE" 2>&1 || status=$?

if [[ "$status" -eq 0 ]]; then
  /usr/bin/open "$PANEL_URL" >> "$LOG_FILE" 2>&1 || true
  /usr/bin/osascript -e 'display notification "JE、内网穿透和面板已经启动。" with title "Minecraft 控制面板"' >/dev/null 2>&1 || true
else
  /usr/bin/open "$LOG_FILE" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display notification "启动时遇到问题，已打开日志。" with title "Minecraft 控制面板"' >/dev/null 2>&1 || true
fi

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] one-click launcher finished with code $status"
} >> "$LOG_FILE" 2>&1

exit "$status"
