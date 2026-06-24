#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

TUNNEL_SCREEN_NAME="${TUNNEL_SCREEN_NAME:-${SCREEN_PREFIX:-unmc}-tunnel}"
REMOTE_BIND="${REMOTE_BIND:-0.0.0.0}"
REMOTE_FORWARD_PORT="${REMOTE_FORWARD_PORT:-${MC_PORT:-25565}}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-${MC_PORT:-25565}}"

screen -S "$TUNNEL_SCREEN_NAME" -X quit 2>/dev/null || true
pkill -f "$ROOT_DIR/scripts/tunnel-loop.sh" 2>/dev/null || true
pkill -f "ssh -NT .*${REMOTE_BIND}:${REMOTE_FORWARD_PORT}:${LOCAL_HOST}:${LOCAL_PORT}" 2>/dev/null || true
rm -rf "$ROOT_DIR/logs/tunnel-loop.lock"

echo "Stopped tunnel screen session and tunnel processes if they were running."
