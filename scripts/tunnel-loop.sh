#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT_DIR/logs"
LOG_FILE="$ROOT_DIR/logs/tunnel-loop.log"
LOCK_DIR="$ROOT_DIR/logs/tunnel-loop.lock"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
    return
  fi

  existing_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel loop already running as pid $existing_pid; exiting" >> "$LOG_FILE"
    exit 0
  fi

  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel loop lock is busy; exiting" >> "$LOG_FILE"
    exit 0
  fi
  echo "$$" > "$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
}

acquire_lock

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting tunnel" >> "$LOG_FILE"
  if "$ROOT_DIR/scripts/tunnel.sh" >> "$LOG_FILE" 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel exited cleanly" >> "$LOG_FILE"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel exited with code $?" >> "$LOG_FILE"
  fi
  sleep 5
done
