#!/bin/bash
#
# Import the Developer ID certificate into a build keychain and decode the App
# Store Connect API key, exporting both to the job environment.
#
# We create and own the keychain rather than exporting CSC_LINK and letting
# electron-builder do it: its import passes the .p12 password where the keychain
# password belongs, so the key's partition list never takes and codesign hangs
# forever on a GUI prompt no CI runner can answer. See docs/RELEASES.md §7.2.
#
# Every failure here is otherwise quiet — electron-builder skips signing, exits
# 0, and ships a .dmg that only fails once a user downloads it. Hence the checks.
set -euo pipefail

missing=()
[ -n "${CERT_P12_BASE64:-}" ] || missing+=(APPLE_CSC_LINK)
[ -n "${CERT_PASSWORD:-}" ] || missing+=(APPLE_CSC_KEY_PASSWORD)
[ -n "${ASC_KEY_BASE64:-}" ] || missing+=(APPLE_API_KEY)
[ -n "${ASC_KEY_ID:-}" ] || missing+=(APPLE_API_KEY_ID)
[ -n "${ASC_ISSUER:-}" ] || missing+=(APPLE_API_ISSUER)
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing repository secrets: ${missing[*]}. See docs/RELEASES.md §7.1."
  exit 1
fi

# electron-builder wants a path for APPLE_API_KEY, not the key itself.
key_path="$RUNNER_TEMP/asc-api-key.p8"
printf '%s' "$ASC_KEY_BASE64" | base64 --decode > "$key_path"
chmod 600 "$key_path"
if ! grep -q 'BEGIN PRIVATE KEY' "$key_path"; then
  echo "::error::APPLE_API_KEY is not a base64-encoded PEM private key. Encode the AuthKey_*.p8 from App Store Connect, not the .p12."
  exit 1
fi

p12="$RUNNER_TEMP/developer-id.p12"
printf '%s' "$CERT_P12_BASE64" | base64 --decode > "$p12"
chmod 600 "$p12"
if [ ! -s "$p12" ]; then
  echo "::error::APPLE_CSC_LINK did not base64-decode to anything. Re-encode the .p12 per docs/RELEASES.md §7.1."
  exit 1
fi

keychain="$RUNNER_TEMP/goatcad-signing.keychain"
keychain_password="$(openssl rand -base64 24)"
echo "::add-mask::$keychain_password"

security create-keychain -p "$keychain_password" "$keychain"
# macOS may append -db. CSC_KEYCHAIN reaches `codesign --keychain`, so resolve it.
[ -f "$keychain" ] || keychain="$keychain-db"
# No -t/-u: never auto-lock. The 300s default can expire mid-signing.
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"

# Prepend; `-s` alone overwrites the search list and drops the login keychain.
existing="$(security list-keychains -d user | sed 's/[[:space:]]*"\(.*\)"/\1/')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $existing

security import "$p12" -k "$keychain" -P "$CERT_PASSWORD" -f pkcs12 \
  -T /usr/bin/codesign -T /usr/bin/productbuild
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
rm -f "$p12"

# Fail here rather than ten minutes into the build.
identities="$(security find-identity -v -p codesigning "$keychain" || true)"
echo "$identities"
if ! echo "$identities" | grep -q "Developer ID Application"; then
  echo "::error::No 'Developer ID Application' identity in the build keychain. APPLE_CSC_LINK is likely a development certificate, or was exported without its private key."
  exit 1
fi

# APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD must stay unset — electron-builder checks
# those first and ignores the API key if either is present.
{
  echo "CSC_KEYCHAIN=$keychain"
  echo "APPLE_API_KEY=$key_path"
  echo "APPLE_API_KEY_ID=$ASC_KEY_ID"
  echo "APPLE_API_ISSUER=$ASC_ISSUER"
} >> "$GITHUB_ENV"
