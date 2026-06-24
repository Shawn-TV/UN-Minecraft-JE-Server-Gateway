#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
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
  /usr/bin/osascript -e 'display notification "Java server, tunnel, and panel are running." with title "UNMC Java Server Stack"' >/dev/null 2>&1 || true
else
  /usr/bin/open "$LOG_FILE" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display notification "Startup hit an error. The log has been opened." with title "UNMC Java Server Stack"' >/dev/null 2>&1 || true
fi

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] one-click launcher finished with code $status"
} >> "$LOG_FILE" 2>&1

exit "$status"
