#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

screen -S unmc-tunnel -X quit 2>/dev/null || true
pkill -f "$ROOT_DIR/scripts/tunnel-loop.sh" 2>/dev/null || true
pkill -f "ssh -NT .*0.0.0.0:43027:127.0.0.1:43027" 2>/dev/null || true
rm -rf "$ROOT_DIR/logs/tunnel-loop.lock"

echo "Stopped tunnel screen session and tunnel processes if they were running."
