#!/usr/bin/env bash
#
# Build GoatCAD's pdfium wasm module from a pinned upstream branch.
#
# The built artifacts (pdfium.js, pdfium.wasm, pdfium.version.json and
# pdfium.licenses.txt in src/main/wasm/) are committed, so this script only runs when bumping the
# pdfium branch or changing glue.cpp — app builds and CI never need it.
#
# Same shape as ../clipper2/build.sh: everything runs inside the pinned
# emscripten Docker image, so the toolchain is identical on every machine.
# Unlike Clipper2 this is not one tarball + one em++ call: pdfium is a
# Chromium-style checkout (depot_tools, gclient, gn, ninja), so the script
# fetches that toolchain into ./upstream/ (gitignored, several GB), applies
# the patches in ./patches/ that let gn target emscripten, and links our own
# flat C ABI (glue.cpp) over the resulting static library.
# Requires a running Docker daemon, nothing else.
set -euo pipefail

# A pdfium release branch. pdfium cuts one per Chromium milestone; the
# patches in ./patches/ are known to apply to this one.
PDFIUM_BRANCH="chromium/8044"
# Latest at the time of pinning. pdfium-binaries builds with 3.1.72; if the
# Chromium build/ tree's wasm toolchain rejects a newer emcc, that is the
# known-good fallback.
EMSDK_DOCKER_IMAGE="emscripten/emsdk:6.0.9"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${GOAT_IN_EMSDK:-}" ]; then
  REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
  exec docker run --rm -u "${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}" -e GOAT_IN_EMSDK=1 \
    -v "$REPO_ROOT:/repo" "$EMSDK_DOCKER_IMAGE" \
    bash /repo/electron/wasm/pdfium/build.sh "$@"
fi

# --- Container-side environment ---------------------------------------------

UPSTREAM="$HERE/upstream"
OUT_DIR="$(cd "$HERE/../.." && pwd)/src/main/wasm"
SRC="$UPSTREAM/pdfium"
BUILD="$SRC/out/wasm"
DEPOT_TOOLS="$UPSTREAM/depot_tools"

mkdir -p "$UPSTREAM/home" "$OUT_DIR"
# depot_tools, cipd and gclient all write under $HOME; the container user has
# no home of its own, so keep every cache inside the gitignored upstream dir.
export HOME="$UPSTREAM/home"
export DEPOT_TOOLS_UPDATE=0
export DEPOT_TOOLS_METRICS=0
export GCLIENT_SUPPRESS_GIT_VERSION_WARNING=1
# The worktree's .git file points at a path outside the container; stop git
# discovery from climbing past this directory into it.
export GIT_CEILING_DIRECTORIES="$HERE"
export PATH="$DEPOT_TOOLS:/emsdk/upstream/bin:$PATH"
# depot_tools' gn and ninja are wrappers that want its own bootstrapped
# python; the checkout carries the real binaries (DEPS: buildtools, ninja).
GN="$SRC/buildtools/linux64/gn"
NINJA="$SRC/third_party/ninja/ninja"

# Optional argument: the step to start from, for iterating on a failed run
# without re-syncing (checkout | patch | configure | build | link).
step_num() {
  case "$1" in
    checkout) echo 1 ;; patch) echo 2 ;; configure) echo 3 ;; build) echo 4 ;; link) echo 5 ;;
    *) echo "unknown step: $1" >&2; exit 1 ;;
  esac
}
START="$(step_num "${1:-checkout}")"
skip() { [ "$(step_num "$1")" -lt "$START" ]; }

# --- 1. depot_tools + pdfium checkout ---------------------------------------

if ! skip checkout; then
  if [ ! -d "$DEPOT_TOOLS" ]; then
    echo "Fetching depot_tools..."
    git clone -q --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS"
  fi
  cd "$UPSTREAM"
  # minimal: no v8, no skia, no test corpus — the datasheet reader needs none.
  gclient config --unmanaged https://pdfium.googlesource.com/pdfium.git \
    --custom-var checkout_configuration=minimal
  echo "target_os = [ 'emscripten' ]" >> .gclient
  # A re-run must start from pristine trees or the patches below fail to apply.
  for d in "$SRC" "$SRC/build"; do
    if [ -e "$d" ]; then git -C "$d" reset -q --hard && git -C "$d" clean -qdf; fi
  done
  echo "Syncing pdfium ${PDFIUM_BRANCH} (this fetches a few GB on first run)..."
  gclient sync -r "origin/${PDFIUM_BRANCH}" --no-history --shallow
fi

# --- 2. Patches --------------------------------------------------------------

# Idempotent, so a resumed run can re-apply after a new patch is added.
apply_once() {
  local repo="$1" patch="$2"
  if git -C "$repo" apply --reverse --check "$patch" 2>/dev/null; then
    echo "  already applied: $(basename "$patch")"
  else
    git -C "$repo" apply "$patch" && echo "  applied: $(basename "$patch")"
  fi
}

if ! skip patch; then
  echo "Applying patches..."
  apply_once "$SRC/build" "$HERE/patches/build-default-toolchain.patch"
  apply_once "$SRC" "$HERE/patches/pdfium-fxge-platform.patch"
  apply_once "$SRC" "$HERE/patches/pdfium-openjpeg-posix.patch"
fi

# --- 3. Configure --------------------------------------------------------------

if ! skip configure; then
  mkdir -p "$BUILD"
  cat > "$BUILD/args.gn" <<GN
target_os = "emscripten"
target_cpu = "wasm"
# build/toolchain/wasm/BUILD.gn defaults this to a copy inside the checkout;
# the image's emsdk is the pinned toolchain.
emscripten_path = "/emsdk/upstream/emscripten/"
is_debug = false
is_component_build = false
# One archive carrying freetype, libjpeg, openjpeg, lcms2, zlib with pdfium.
pdf_is_complete_lib = true
pdf_is_standalone = true
pdf_enable_v8 = false
pdf_enable_xfa = false
# PartitionAlloc has no wasm port; plain malloc.
pdf_use_partition_alloc = false
# The tree's warning set targets its own pinned clang, not the image's emcc.
treat_warnings_as_errors = false
# build/toolchain/wasm/BUILD.gn sets these in toolchain_args, which gn only
# honors for a secondary toolchain; as the default toolchain they must be
# build args. Chromium's clang plugins do not exist in emcc, and its bundled
# libc++ conflicts with the one emscripten ships.
clang_use_chrome_plugins = false
clang_use_raw_ptr_plugin = false
clang_use_unsafe_buffers_plugin = false
use_custom_libcxx = false
use_custom_libcxx_for_host = false
use_debug_fission = false
GN
  echo "Configuring..."
  cd "$SRC"
  "$GN" gen "$BUILD"
fi

# --- 4. Build the static library ---------------------------------------------

if ! skip build; then
  echo "Building libpdfium.a..."
  "$NINJA" -C "$BUILD" pdfium
fi

# --- 5. Link the wasm module -------------------------------------------------

if ! skip link; then
  LIB="$BUILD/obj/libpdfium.a"
  echo "Linking with $(em++ --version | head -1)..."
  # Exports are exactly the glue's goat_pdf_* surface; everything unreachable
  # from it is dropped. STACK_SIZE: emscripten's 64 KB default is thin for a
  # parser with pdfium's recursion depth.
  # EXPORT_ES6: the consumer is an ES module bundled by rollup, which has no
  # default export to take from a script-style loader; vitest and the CJS main
  # bundle both handle the ES6 shape (Clipper2 is built the same way).
  em++ -O3 --no-entry -std=c++17 \
    -I "$SRC/public" \
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createPdfium \
    -sENVIRONMENT=node,worker,web \
    -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=4MB \
    -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
    -sEXPORTED_FUNCTIONS=_goat_pdf_open,_goat_pdf_error,_goat_pdf_close,_goat_pdf_page_count,_goat_pdf_page_size,_goat_pdf_page_text,_goat_pdf_page_chars,_goat_pdf_render,_goat_pdf_outline,_goat_pdf_free,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAP32,HEAPU32,HEAPF32 \
    "$HERE/glue.cpp" "$LIB" -o "$OUT_DIR/pdfium.js"

  cat > "$OUT_DIR/pdfium.version.json" <<JSON
{
  "pdfium": "${PDFIUM_BRANCH}",
  "pdfiumCommit": "$(git -C "$SRC" rev-parse HEAD)",
  "toolchain": "${EMSDK_DOCKER_IMAGE} ($(em++ --version | head -1))",
  "builtBy": "electron/wasm/pdfium/build.sh"
}
JSON
  "$HERE/licenses.sh" "$OUT_DIR/pdfium.licenses.txt" "$SRC" "$(dirname "$(command -v emcc)")" "${PDFIUM_BRANCH}"
  echo "Done:"
  ls -la "$OUT_DIR"
fi
