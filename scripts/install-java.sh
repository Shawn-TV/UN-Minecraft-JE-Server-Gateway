#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
JAVA_MAJOR="${JAVA_MAJOR:-25}"

case "$(uname -m)" in
  arm64|aarch64)
    API_ARCH="aarch64"
    ;;
  x86_64|amd64)
    API_ARCH="x64"
    ;;
  *)
    echo "Unsupported macOS CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$RUNTIME_DIR"
ARCHIVE="$RUNTIME_DIR/OpenJDK${JAVA_MAJOR}-jre-mac-${API_ARCH}.tar.gz"
URL="https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/mac/${API_ARCH}/jre/hotspot/normal/eclipse"

echo "Downloading Java ${JAVA_MAJOR} runtime for macOS ${API_ARCH}..."
curl -fL --progress-bar "$URL" -o "$ARCHIVE"

echo "Extracting runtime..."
rm -rf "$RUNTIME_DIR"/jdk-* "$RUNTIME_DIR/java"
tar -xzf "$ARCHIVE" -C "$RUNTIME_DIR"

JAVA_HOME_DIR="$(find "$RUNTIME_DIR" -maxdepth 6 -type f -path '*/Contents/Home/bin/java' -print -quit)"
if [[ -z "$JAVA_HOME_DIR" ]]; then
  echo "Could not find java in extracted runtime." >&2
  exit 1
fi

JAVA_HOME_DIR="$(cd "$(dirname "$JAVA_HOME_DIR")/.." && pwd)"
ln -sfn "$JAVA_HOME_DIR" "$RUNTIME_DIR/java"

"$RUNTIME_DIR/java/bin/java" -version
echo "Java runtime is ready at $RUNTIME_DIR/java"
