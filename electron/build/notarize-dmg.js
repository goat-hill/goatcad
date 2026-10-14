// electron-builder `afterAllArtifactBuild` hook: notarize and staple the .dmg.
//
// electron-builder notarizes and staples the .app, then builds the disk image
// from the stapled bundle — so the image itself is never submitted to the notary
// service. Gatekeeper assesses the .dmg too, and it wants a ticket there: a
// signed but un-notarized image reports "rejected / source=Unnotarized Developer
// ID", and an unsigned one "no usable signature". Both mean a download that gets
// refused on a user's machine while opening fine on the machine that built it.
// See docs/RELEASES.md §7.4.
//
// Ordering matters: `dmg.sign: true` (electron-builder.yml) must sign the image
// first, because the notary service rejects an unsigned submission.
//
// Stapling rewrites the .dmg, which invalidates the sha512 and size that
// electron-builder already wrote into latest-mac.yml. That metadata is what
// electron-updater trusts, so this hook repairs it after stapling. The .blockmap
// beside the image goes stale too, but it is not published (release.yml uploads
// *.dmg, *.zip and latest-mac.yml only) and macOS updates come from the .zip.

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync, statSync } = require('node:fs')
const path = require('node:path')

// Matches electron-builder's own artifact hashing: sha512, base64-encoded.
function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Patch only the two lines belonging to this .dmg's entry. A targeted edit
// rather than a YAML round-trip on purpose: every other byte — including the
// top-level `path`/`sha512`, which describe the .zip and must not move — stays
// exactly as electron-builder wrote it.
function repairUpdateMetadata(outDir, dmg) {
  const ymlPath = path.join(outDir, 'latest-mac.yml')
  if (!existsSync(ymlPath)) {
    return
  }

  const name = path.basename(dmg)
  const yml = readFileSync(ymlPath, 'utf8')
  const entry = new RegExp(
    `(- url: ${escapeRegExp(name)}\\n(\\s+)sha512: )[^\\n]*(\\n\\s+size: )\\d+`
  )

  if (!entry.test(yml)) {
    // Never leave a stale hash behind quietly — that ships an update manifest
    // whose checksum does not match the file it names.
    throw new Error(
      `notarize-dmg: no entry for ${name} in ${ymlPath}; cannot refresh the checksum it records. ` +
        `electron-builder's metadata format has changed and this hook needs updating.`
    )
  }

  const patched = yml.replace(entry, `$1${sha512Base64(dmg)}$3${statSync(dmg).size}`)
  writeFileSync(ymlPath, patched)
  console.log(`  • refreshed update metadata  file=${path.basename(ymlPath)} entry=${name}`)
}

module.exports = async function notarizeDmg(buildResult) {
  if (process.platform !== 'darwin') {
    return []
  }

  const dmgs = buildResult.artifactPaths.filter((artifact) => artifact.endsWith('.dmg'))
  if (dmgs.length === 0) {
    return []
  }

  const key = process.env.APPLE_API_KEY
  const keyId = process.env.APPLE_API_KEY_ID
  const issuer = process.env.APPLE_API_ISSUER

  // Degrade the same way `mac.notarize` does when credentials are absent, so a
  // contributor without an Apple account can still build a working local .dmg.
  // That leniency is exactly why a release must not trust a green build —
  // ./bin/verify-mac-signing is the gate that catches an unnotarized image.
  if (!key || !keyId || !issuer) {
    console.log('  • skipped disk image notarization  reason=no App Store Connect credentials')
    return []
  }

  for (const dmg of dmgs) {
    console.log(`  • notarizing disk image  file=${path.relative(process.cwd(), dmg)}`)

    // Captured rather than inherited: `notarytool submit --wait` has shipped
    // versions that exit 0 on a rejected submission, so the status line is the
    // authority, not the exit code.
    const output = execFileSync(
      'xcrun',
      ['notarytool', 'submit', dmg, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait'],
      { encoding: 'utf8' }
    )
    process.stdout.write(output)

    if (!/status:\s*Accepted/i.test(output)) {
      throw new Error(
        `notarize-dmg: Apple did not accept ${path.basename(dmg)}. ` +
          `Run 'xcrun notarytool log <submission-id>' with the same credentials for the reason.`
      )
    }

    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
    repairUpdateMetadata(buildResult.outDir, dmg)
  }

  return []
}
