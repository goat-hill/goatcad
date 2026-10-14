#!/usr/bin/env bash
# Moves a release's build output through the goatcad R2 bucket, served at
# download.goatcad.com (docs/RELEASES.md §8). Shared by release.yml and
# web-release-bump.yml so the folder layout lives in one place.
#
#   r2-release.sh url-base                    public URL of the release folder
#   r2-release.sh upload <platform> <file>... a build job's output: installers into the
#                                             release folder, update feeds held back under
#                                             pending/<tag>/
#   r2-release.sh files                       installer names every platform uploaded
#   r2-release.sh promote                     moves the held-back update feeds into place
#
# Needs TAG, and for the last three BUCKET, R2_ENDPOINT, AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY. Run from the repo root or from electron/.
set -euo pipefail

PLATFORMS=(linux windows macos)
FEEDS=(latest.yml latest-mac.yml latest-linux.yml)

: "${TAG:?TAG must be set}"

# The release folder is the updater's feed URL in electron-builder.yml — the one
# place it is defined, since the packaged app has to agree with the uploads.
root="$(cd "$(dirname "$0")/../.." && pwd)"
url_base="$(sed -n 's/^[[:space:]]*url:[[:space:]]*//p' "$root/electron/electron-builder.yml" | head -1)"
case "$url_base" in
  https://download.goatcad.com/*) ;;
  *)
    echo "::error::electron-builder.yml has no publish.url under https://download.goatcad.com/ (got '$url_base')." >&2
    exit 1
    ;;
esac
folder="${url_base#https://download.goatcad.com/}"
pending="$folder/pending/$TAG"

need_r2() {
  : "${BUCKET:?}" "${R2_ENDPOINT:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
}

s3() {
  AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED \
    aws s3 "$@" --endpoint-url "$R2_ENDPOINT" --only-show-errors
}

case "${1:-}" in
  url-base)
    echo "$url_base"
    ;;
  upload)
    need_r2
    platform="${2:?usage: r2-release.sh upload <platform> <file>...}"
    shift 2
    if [ "$#" -eq 0 ]; then
      echo "::error::No build output given for $platform." >&2
      exit 1
    fi
    # Relative rather than mktemp: on Windows the aws CLI is a native program
    # and cannot read an MSYS /tmp path.
    list="r2-files-$platform.txt"
    : > "$list"
    for file in "$@"; do
      # An unmatched glob arrives as its literal pattern.
      if [ ! -f "$file" ]; then
        echo "::error::Missing build output: $file" >&2
        exit 1
      fi
      name="$(basename "$file")"
      case "$name" in
        latest*.yml)
          s3 cp "$file" "s3://$BUCKET/$pending/$name" --cache-control no-cache
          ;;
        *)
          s3 cp "$file" "s3://$BUCKET/$folder/$name" --cache-control "public, max-age=86400"
          echo "$name" >> "$list"
          ;;
      esac
      echo "Uploaded $name"
    done
    s3 cp "$list" "s3://$BUCKET/$pending/files-$platform.txt" \
      --cache-control no-cache --content-type text/plain
    rm -f "$list"
    ;;
  files)
    need_r2
    for platform in "${PLATFORMS[@]}"; do
      if ! s3 cp "s3://$BUCKET/$pending/files-$platform.txt" -; then
        echo "::error::No $platform build was uploaded for $TAG." >&2
        exit 1
      fi
    done
    ;;
  promote)
    need_r2
    for feed in "${FEEDS[@]}"; do
      s3 cp "s3://$BUCKET/$pending/$feed" "s3://$BUCKET/$folder/$feed" \
        --cache-control no-cache --metadata-directive REPLACE
      echo "Promoted $feed"
    done
    ;;
  *)
    echo "usage: r2-release.sh url-base | upload <platform> <file>... | files | promote" >&2
    exit 2
    ;;
esac
