#!/usr/bin/env bash
#
# The license notices for the pdfium module: pdfium itself, then every
# third_party library its static lib links for our build (pdf_enable_v8 and
# pdf_enable_xfa off). Name and version come from each README.chromium or
# README.pdfium. FreeType is dual-licensed FTL / GPLv2; we take the FTL.
#
# Usage: licenses.sh OUT PDFIUM_SRC EMSCRIPTEN_ROOT PDFIUM_BRANCH
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$1"
SRC="$2"
EM_ROOT="$3"
BRANCH="$4"
TP="$SRC/third_party"

# "Name Version" from a third_party README, as the heading for its licenses.
title() {
  local readme
  readme="$(ls "$TP/$1"/README.chromium "$TP/$1"/README.pdfium 2>/dev/null | head -1)"
  local name version
  name="$(sed -n 's/^Name: //p' "$readme" | head -1)"
  version="$(sed -n 's/^Version: //p' "$readme" | head -1)"
  if [ -n "$version" ] && [ "$version" != "N/A" ]; then echo "$name $version"; else echo "$name"; fi
}

component() {
  local dir="$1"
  shift
  local entry
  entry="$(title "$dir")"
  for file in "$@"; do entry="$entry|$TP/$dir/$file"; done
  echo "$entry"
}

"$HERE/../licenses.sh" "$OUT" "$EM_ROOT" \
  "PDFium ${BRANCH}|$SRC/LICENSE" \
  "$(component abseil-cpp LICENSE)" \
  "$(component agg23 copying)" \
  "$(component bigint LICENSE)" \
  "$(component dragonbox src/LICENSE-Apache2-LLVM src/LICENSE-Boost)" \
  "$(component fast_float src/LICENSE-MIT)" \
  "$(component freetype FTL.TXT)" \
  "$(component harfbuzz src/COPYING)" \
  "$(component icu LICENSE)" \
  "$(component lcms LICENSE)" \
  "$(component libjpeg_turbo LICENSE.md.chromium README.ijg)" \
  "$(component libopenjpeg LICENSE)" \
  "$(component libpng LICENSE)" \
  "$(component simdutf LICENSE)" \
  "$(component zlib LICENSE)"
