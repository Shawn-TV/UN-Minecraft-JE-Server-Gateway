#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
AGENT_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
JE_LABEL="com.unmc.minecraft-je-server-gateway.je"
TUNNEL_LABEL="com.unmc.minecraft-je-server-gateway.tunnel"

case "$ACTION" in
  install|install-server|install-tunnel)
    "$ROOT_DIR/scripts/install-launchd.sh"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$TUNNEL_LABEL" >/dev/null 2>&1 || true
    launchctl bootout "$DOMAIN/$JE_LABEL" >/dev/null 2>&1 || true
    ;;
  status)
    launchctl print "$DOMAIN/$JE_LABEL" 2>/dev/null | sed -n '1,30p' || true
    launchctl print "$DOMAIN/$TUNNEL_LABEL" 2>/dev/null | sed -n '1,30p' || true
    ;;
  *)
    echo "Usage: $0 {install|install-server|install-tunnel|stop|status}" >&2
    echo "LaunchAgents live in: $AGENT_DIR" >&2
    exit 2
    ;;
esac
