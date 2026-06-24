#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
VERSION="${MC_VERSION:-latest}"
MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

mkdir -p "$SERVER_DIR"

echo "Resolving Minecraft server version..."
VERSION_INFO="$(VERSION="$VERSION" MANIFEST_URL="$MANIFEST_URL" /usr/bin/python3 - <<'PY'
import json
import os
import sys
import urllib.request

version = os.environ["VERSION"]
manifest_url = os.environ["MANIFEST_URL"]

with urllib.request.urlopen(manifest_url) as response:
    manifest = json.load(response)

target = manifest["latest"]["release"] if version == "latest" else version
try:
    version_url = next(item["url"] for item in manifest["versions"] if item["id"] == target)
except StopIteration:
    print(f"Version not found: {target}", file=sys.stderr)
    sys.exit(1)

with urllib.request.urlopen(version_url) as response:
    meta = json.load(response)

server = meta.get("downloads", {}).get("server")
if not server:
    print(f"No server download is available for {target}", file=sys.stderr)
    sys.exit(1)

print(meta["id"])
print(meta["javaVersion"]["majorVersion"])
print(server["url"])
print(server["sha1"])
PY
)"

MC_RESOLVED_VERSION="$(printf '%s\n' "$VERSION_INFO" | sed -n '1p')"
JAVA_MAJOR="$(printf '%s\n' "$VERSION_INFO" | sed -n '2p')"
SERVER_URL="$(printf '%s\n' "$VERSION_INFO" | sed -n '3p')"
SERVER_SHA1="$(printf '%s\n' "$VERSION_INFO" | sed -n '4p')"

echo "Downloading Minecraft Java server $MC_RESOLVED_VERSION..."
curl -fL --progress-bar "$SERVER_URL" -o "$SERVER_DIR/server.jar"

ACTUAL_SHA1="$(shasum -a 1 "$SERVER_DIR/server.jar" | awk '{print $1}')"
if [[ "$ACTUAL_SHA1" != "$SERVER_SHA1" ]]; then
  echo "SHA-1 mismatch for server.jar" >&2
  echo "Expected: $SERVER_SHA1" >&2
  echo "Actual:   $ACTUAL_SHA1" >&2
  exit 1
fi

cat > "$SERVER_DIR/version.txt" <<EOF
version=$MC_RESOLVED_VERSION
java_major=$JAVA_MAJOR
server_sha1=$SERVER_SHA1
server_url=$SERVER_URL
downloaded_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "Server jar is ready at $SERVER_DIR/server.jar"
echo "Minecraft $MC_RESOLVED_VERSION requires Java $JAVA_MAJOR."
