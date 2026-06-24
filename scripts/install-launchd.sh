#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENT_DIR" "$ROOT_DIR/logs"

render_plist() {
  local template="$1"
  local target="$2"
  sed "s#__REPO_PATH__#$ROOT_DIR#g" "$template" > "$target"
}

render_plist "$ROOT_DIR/templates/launchd.je-server.plist.example" "$AGENT_DIR/com.unmc.java-server-stack.je.plist"
render_plist "$ROOT_DIR/templates/launchd.tunnel.plist.example" "$AGENT_DIR/com.unmc.java-server-stack.tunnel.plist"

launchctl unload "$AGENT_DIR/com.unmc.java-server-stack.je.plist" >/dev/null 2>&1 || true
launchctl unload "$AGENT_DIR/com.unmc.java-server-stack.tunnel.plist" >/dev/null 2>&1 || true
launchctl load "$AGENT_DIR/com.unmc.java-server-stack.je.plist"
launchctl load "$AGENT_DIR/com.unmc.java-server-stack.tunnel.plist"

echo "Installed launchd agents:"
echo "  $AGENT_DIR/com.unmc.java-server-stack.je.plist"
echo "  $AGENT_DIR/com.unmc.java-server-stack.tunnel.plist"
