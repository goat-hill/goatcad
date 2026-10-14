import { describe, test, expect } from 'vitest'
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

// build/Assets.car is compiled from build/icon.icon by bin/build-mac-icon and
// committed, because only Xcode 26's actool can compile it. The script records
// a SHA-256 per source file (the `shasum -a 256` format) in
// build/Assets.car.sources; if the bundle no longer matches, someone edited the
// icon without recompiling, and the app would ship the old one on macOS 26.

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../build')
const iconDir = join(buildDir, 'icon.icon')

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return files(join(dir, entry.name))
    return entry.name === '.DS_Store' ? [] : [join(dir, entry.name)]
  })

describe('macOS app icon', () => {
  test('build/Assets.car was compiled from the current build/icon.icon', () => {
    const current = files(iconDir)
      .map((file) => `./${relative(iconDir, file).split('\\').join('/')}`)
      // LC_ALL=C sort in the script: plain code-unit order.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => {
        const hash = createHash('sha256')
          .update(readFileSync(join(iconDir, path)))
          .digest('hex')
        return `${hash}  ${path}\n`
      })
      .join('')
    const recorded = readFileSync(join(buildDir, 'Assets.car.sources'), 'utf8')
    expect(current, 'build/icon.icon changed: run ./bin/build-mac-icon and commit').toBe(recorded)
  })
})
