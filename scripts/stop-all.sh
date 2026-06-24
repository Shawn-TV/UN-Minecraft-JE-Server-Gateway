#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/stop-je-screen.sh"
"$ROOT_DIR/scripts/stop-tunnel.sh"
"$ROOT_DIR/scripts/stop-panel-screen.sh"
