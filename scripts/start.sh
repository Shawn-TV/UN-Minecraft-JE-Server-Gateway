#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
SERVER_JAR="$SERVER_DIR/server.jar"
LOCAL_JAVA="$ROOT_DIR/.runtime/java/bin/java"

if [[ -x "$LOCAL_JAVA" ]]; then
  JAVA_BIN="$LOCAL_JAVA"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
else
  echo "Java is not installed. Run: ./scripts/install-java.sh" >&2
  exit 1
fi

if [[ ! -f "$SERVER_JAR" ]]; then
  echo "server.jar is missing. Run: ./scripts/download-server.sh" >&2
  exit 1
fi

MIN_RAM="${MC_MIN_RAM:-1G}"
MAX_RAM="${MC_MAX_RAM:-3G}"

cd "$SERVER_DIR"
exec "$JAVA_BIN" \
  --sun-misc-unsafe-memory-access=allow \
  --enable-native-access=ALL-UNNAMED \
  "-Xms$MIN_RAM" \
  "-Xmx$MAX_RAM" \
  -XX:+UseZGC \
  -XX:+UseStringDeduplication \
  -jar "$SERVER_JAR" nogui
