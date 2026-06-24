#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EULA_FILE="$ROOT_DIR/server/eula.txt"
EULA_URL="https://www.minecraft.net/en-us/eula"

cat <<EOF
Minecraft requires you to accept its EULA before the server can run.
Read it first: $EULA_URL

If you agree, type exactly: I AGREE
EOF

read -r -p "> " ANSWER
if [[ "$ANSWER" != "I AGREE" ]]; then
  echo "EULA was not accepted. Leaving $EULA_FILE unchanged."
  exit 1
fi

mkdir -p "$(dirname "$EULA_FILE")"
if [[ -f "$EULA_FILE" ]] && grep -q '^eula=' "$EULA_FILE"; then
  perl -0pi -e 's/^eula=.*$/eula=true/m' "$EULA_FILE"
else
  {
    echo "# Accepted by user via scripts/accept-eula.sh"
    echo "eula=true"
  } > "$EULA_FILE"
fi

echo "EULA accepted in $EULA_FILE"
