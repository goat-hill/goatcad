#!/usr/bin/env bash
#
# Write the license notices for one committed wasm build: each component's
# license text under a heading, then Emscripten's, whose runtime and musl libc
# are linked into every module. The app's THIRD_PARTY_NOTICES.txt (bin/notices)
# collects these files, so a rebuild that adds a component must list it here.
#
# Usage: licenses.sh OUT EMSCRIPTEN_ROOT "Title|license file[|license file...]"...
set -euo pipefail

OUT="$1"
EM_ROOT="$2"
shift 2

section() {
  local title="$1"
  shift
  printf '%s\n%s\n%s\n\n' "$(printf '=%.0s' {1..80})" "$title" "$(printf '=%.0s' {1..80})"
  for file in "$@"; do
    [ -f "$file" ] || { echo "licenses.sh: missing $file" >&2; exit 1; }
    cat "$file"
    printf '\n'
  done
}

{
  for entry in "$@"; do
    IFS='|' read -r -a parts <<<"$entry"
    section "${parts[@]}"
  done
  section "Emscripten runtime (MIT / NCSA) and musl libc (MIT)" \
    "$EM_ROOT/LICENSE" "$EM_ROOT/system/lib/libc/musl/COPYRIGHT"
} >"$OUT"
