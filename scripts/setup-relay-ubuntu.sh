#!/usr/bin/env bash
set -euo pipefail

RELAY_USER="${RELAY_USER:-minecraft_tunnel}"
RELAY_PORT="${RELAY_PORT:-25565}"
SSH_PORT="${SSH_PORT:-22}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root on the relay VPS." >&2
  exit 1
fi

apt-get update
apt-get install -y openssh-server ufw

if ! id "$RELAY_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$RELAY_USER"
fi

mkdir -p "/home/$RELAY_USER/.ssh"
touch "/home/$RELAY_USER/.ssh/authorized_keys"
chown -R "$RELAY_USER:$RELAY_USER" "/home/$RELAY_USER/.ssh"
chmod 700 "/home/$RELAY_USER/.ssh"
chmod 600 "/home/$RELAY_USER/.ssh/authorized_keys"

cat >/etc/ssh/sshd_config.d/unmc-java-gateway.conf <<EOF
GatewayPorts clientspecified
AllowTcpForwarding yes
ClientAliveInterval 30
ClientAliveCountMax 3
EOF

systemctl reload ssh || systemctl reload sshd

ufw allow "$SSH_PORT"/tcp || true
ufw allow "$RELAY_PORT"/tcp || true

cat <<EOF

Relay server is prepared.

Next steps:
1. Add the Mac mini public key to:
   /home/$RELAY_USER/.ssh/authorized_keys

2. On the Mac mini .env, set:
   REMOTE_HOST=<this VPS public IP or domain>
   REMOTE_USER=$RELAY_USER
   REMOTE_FORWARD_PORT=$RELAY_PORT

3. Start the tunnel on the Mac mini:
   ./scripts/tunnel-loop.sh

EOF
