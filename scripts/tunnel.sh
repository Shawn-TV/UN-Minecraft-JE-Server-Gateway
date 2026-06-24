#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"

KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/unmc_tunnel_ed25519}"
REMOTE_HOST="${REMOTE_HOST:-relay.example.com}"
REMOTE_USER="${REMOTE_USER:-minecraft_tunnel}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:-22}"
REMOTE_BIND="${REMOTE_BIND:-0.0.0.0}"
REMOTE_FORWARD_PORT="${REMOTE_FORWARD_PORT:-${MC_PORT:-25565}}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-${MC_PORT:-25565}}"
KNOWN_HOSTS_FILE="${SSH_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"

if [[ "$REMOTE_HOST" == "relay.example.com" ]]; then
  echo "REMOTE_HOST is still relay.example.com. Edit .env before starting the tunnel." >&2
  exit 1
fi

if [[ ! -f "$KEY_PATH" ]]; then
  echo "SSH key not found: $KEY_PATH" >&2
  echo "Create one with: ssh-keygen -t ed25519 -f \"$KEY_PATH\"" >&2
  exit 1
fi

exec /usr/bin/ssh \
  -NT \
  -i "$KEY_PATH" \
  -p "$REMOTE_SSH_PORT" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$KNOWN_HOSTS_FILE" \
  -R "${REMOTE_BIND}:${REMOTE_FORWARD_PORT}:${LOCAL_HOST}:${LOCAL_PORT}" \
  "${REMOTE_USER}@${REMOTE_HOST}"
