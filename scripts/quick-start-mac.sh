#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need curl
need python3
need ssh
need screen

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

mkdir -p server logs backups/world

if [[ ! -x .runtime/java/bin/java ]]; then
  ./scripts/install-java.sh
fi

if ! find server -maxdepth 1 -type f -name '*.jar' | grep -q .; then
  ./scripts/download-server.sh
fi

if [[ ! -f server/server.properties ]]; then
  cp templates/server.properties.example server/server.properties
  echo "Created server/server.properties from template."
fi

if [[ ! -f server/eula.txt ]] || ! grep -qi '^eula=true' server/eula.txt; then
  ./scripts/accept-eula.sh
fi

cat <<'EOF'

Mac mini side is ready.

Before starting the public tunnel:
1. Edit .env.
2. Set REMOTE_HOST to your relay server.
3. Add your SSH public key to the relay user's authorized_keys.
4. Point your DNS record to the relay server.

Start everything:
  ./scripts/start-all.sh

Open panel:
  http://127.0.0.1:8765

EOF
