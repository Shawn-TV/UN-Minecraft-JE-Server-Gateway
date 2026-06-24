#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/load-env.sh"
SERVER_DIR="$ROOT_DIR/server"
LOCAL_JAVA="$ROOT_DIR/.runtime/java/bin/java"

if [[ -x "$LOCAL_JAVA" ]]; then
  JAVA_BIN="$LOCAL_JAVA"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
else
  echo "Java is not installed. Run: ./scripts/install-java.sh" >&2
  exit 1
fi

SERVER_JAR_PATTERN="${SERVER_JAR_PATTERN:-*.jar}"
JAR_PATH="$(find "$SERVER_DIR" -maxdepth 1 -type f -name "$SERVER_JAR_PATTERN" -print | sort | head -n 1)"
if [[ -z "$JAR_PATH" ]]; then
  echo "No server jar matching '$SERVER_JAR_PATTERN' found in $SERVER_DIR" >&2
  echo "Run ./scripts/download-server.sh or set SERVER_JAR_PATTERN in .env." >&2
  exit 1
fi

if [[ ! -f "$SERVER_DIR/eula.txt" ]] || ! grep -qi '^eula=true' "$SERVER_DIR/eula.txt"; then
  echo "EULA is not accepted in $SERVER_DIR/eula.txt" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/logs"
cd "$SERVER_DIR"

MIN_RAM="${MC_MIN_RAM:-1G}"
MAX_RAM="${MC_MAX_RAM:-3G}"
LANGUAGE="${JAVA_USER_LANGUAGE:-en}"
COUNTRY="${JAVA_USER_COUNTRY:-US}"

exec "$JAVA_BIN" \
  --sun-misc-unsafe-memory-access=allow \
  --enable-native-access=ALL-UNNAMED \
  "-Xms$MIN_RAM" \
  "-Xmx$MAX_RAM" \
  -Dfile.encoding=UTF-8 \
  -Duser.language="$LANGUAGE" \
  -Duser.country="$COUNTRY" \
  -Dterminal.jline=false \
  -Dterminal.ansi=false \
  -jar "$JAR_PATH" --nogui
