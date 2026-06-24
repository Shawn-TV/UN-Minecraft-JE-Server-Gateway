#!/usr/bin/env bash
set -euo pipefail

SCREEN_NAME="${SCREEN_NAME:-unmc-je}"

if ! screen -ls | grep -q "[.]${SCREEN_NAME}[[:space:]]"; then
  echo "Screen session $SCREEN_NAME is not running."
  exit 0
fi

screen -S "$SCREEN_NAME" -X stuff $'stop\r'
echo "Sent stop to JE server screen session: $SCREEN_NAME"
