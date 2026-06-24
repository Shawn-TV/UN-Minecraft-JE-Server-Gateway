#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
SCREEN_NAME="${SERVER_SCREEN_NAME:-${SCREEN_PREFIX:-unmc}-je}"

if ! screen -ls | grep -q "[.]${SCREEN_NAME}[[:space:]]"; then
  echo "Screen session $SCREEN_NAME is not running."
  exit 0
fi

screen -S "$SCREEN_NAME" -X stuff $'stop\r'
echo "Sent stop to JE server screen session: $SCREEN_NAME"
