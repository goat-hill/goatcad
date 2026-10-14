#!/usr/bin/env bash
#
# Build GoatCAD's Clipper2 wasm module from a pinned upstream release.
#
# The built artifacts (clipper2.js, clipper2.wasm, clipper2.version.json and
# clipper2.licenses.txt) are committed to the repo, so this script only runs when bumping the
# Clipper2 version or changing glue.cpp — app builds and CI never need it.
#
# Always builds inside the pinned emscripten Docker image, so the toolchain
# is byte-for-byte the same on every machine: same source hash + same image
# tag = same artifacts. Requires a running Docker daemon, nothing else.
set -euo pipefail

CLIPPER2_VERSION="2.0.1"
CLIPPER2_SHA256="2a3693aceab4aed3e39b743e038d87701acc53cf05ed7b2013aab3e0aec5287e"
EMSDK_DOCKER_IMAGE="emscripten/emsdk:6.0.9"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Everything below the re-exec runs inside the container. When the script is
# run via sudo (docker without a docker group), SUDO_UID/GID keep the emitted
# artifacts owned by the invoking user rather than root.
if [ -z "${GOAT_IN_EMSDK:-}" ]; then
  REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
  exec docker run --rm -u "${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}" -e GOAT_IN_EMSDK=1 \
    -v "$REPO_ROOT:/repo" "$EMSDK_DOCKER_IMAGE" \
    bash /repo/electron/wasm/clipper2/build.sh
fi

UPSTREAM="$HERE/upstream"
SRC="$UPSTREAM/Clipper2-Clipper2_${CLIPPER2_VERSION}/CPP/Clipper2Lib"
OUT_DIR="$(cd "$HERE/../.." && pwd)/src/renderer/src/lib/geometry/wasm"
TARBALL="$UPSTREAM/Clipper2_${CLIPPER2_VERSION}.tar.gz"
URL="https://github.com/AngusJohnson/Clipper2/archive/refs/tags/Clipper2_${CLIPPER2_VERSION}.tar.gz"

# --- Fetch and verify the pinned source ------------------------------------

mkdir -p "$UPSTREAM"
if [ ! -f "$TARBALL" ]; then
  echo "Fetching Clipper2 ${CLIPPER2_VERSION}..."
  curl -sSfL -o "$TARBALL" "$URL"
fi
echo "${CLIPPER2_SHA256}  ${TARBALL}" | sha256sum -c - >/dev/null || {
  echo "sha256 mismatch for ${TARBALL} — refusing to build" >&2
  exit 1
}
[ -d "$SRC" ] || tar xzf "$TARBALL" -C "$UPSTREAM"

# --- Compile ----------------------------------------------------------------

echo "Building with $(em++ --version | head -1)..."
mkdir -p "$OUT_DIR"
em++ -O3 -std=c++17 -fwasm-exceptions \
  -I "$SRC/include" \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createClipper2 \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sFILESYSTEM=0 \
  -sDYNAMIC_EXECUTION=0 \
  -sEXPORTED_FUNCTIONS=_goat_clip,_goat_offset,_goat_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAP32 \
  "$SRC/src/clipper.engine.cpp" \
  "$SRC/src/clipper.offset.cpp" \
  "$SRC/src/clipper.rectclip.cpp" \
  "$HERE/glue.cpp" \
  -o "$OUT_DIR/clipper2.js"

# --- Provenance -------------------------------------------------------------

cat > "$OUT_DIR/clipper2.version.json" <<EOF
{
  "clipper2": "${CLIPPER2_VERSION}",
  "tarballSha256": "${CLIPPER2_SHA256}",
  "toolchain": "${EMSDK_DOCKER_IMAGE} ($(em++ --version | head -1))",
  "builtBy": "electron/wasm/clipper2/build.sh"
}
EOF
"$HERE/../licenses.sh" "$OUT_DIR/clipper2.licenses.txt" "$(dirname "$(command -v emcc)")" \
  "Clipper2 ${CLIPPER2_VERSION}|$UPSTREAM/Clipper2-Clipper2_${CLIPPER2_VERSION}/LICENSE"

echo "Done:"
ls -la "$OUT_DIR"
