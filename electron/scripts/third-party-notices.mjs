/**
 * Build resources/THIRD_PARTY_NOTICES.txt, and the same notices as a list for
 * Settings ▸ About (src/renderer/src/lib/licenses.json), which adds the GPL's
 * text for About's License row. The file: GoatCAD's own license statement and
 * the KiCad attribution, then the license text of everything a build ships —
 * the npm packages the app imports (bundled or not) and everything they depend
 * on, and the `*.licenses.txt` beside each component built from source (the
 * wasm modules, the newstroke font). The GPL's text closes the file, since a
 * build must carry it.
 *
 * The packages are found from the source, not listed: every bare import under
 * src/ outside the tests, plus package.json's `dependencies`. Over-including a
 * dependency of a dependency costs a few lines; missing one is a license breach.
 *
 * `bin/notices` writes both; the default suite fails while either is stale
 * (src/main/__tests__/thirdPartyNotices.test.ts).
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const NOTICES_PATH = join(ROOT, 'resources', 'THIRD_PARTY_NOTICES.txt')
/** The same notices as entries, and the GPL's text, for Settings ▸ About (lib/licenses.ts). */
export const LIST_PATH = join(ROOT, 'src', 'renderer', 'src', 'lib', 'licenses.json')

const RULE = '='.repeat(80)
/** Electron ships its own notices beside the app (see the header). */
const SKIP = new Set(['electron'])
const ALIASES = ['@renderer']
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

/**
 * Code a package bundles that its top-level license file does not cover. The
 * files are read from the package; a note stands in where it ships none.
 */
const NESTED = {
  'node-pty': {
    files: ['deps/winpty/LICENSE'],
    note: `third_party/conpty: Microsoft's ConPTY and OpenConsole (https://github.com/microsoft/terminal)

MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
  },
  'occt-import-js': {
    files: [],
    note: `dist/occt-import-js.wasm includes Open CASCADE Technology
(https://dev.opencascade.org), under the same LGPL-2.1 as above.`
  }
}

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') yield* sourceFiles(path)
    } else if (/\.(ts|mts|js|mjs|vue)$/.test(name) && !/\.test\.ts$/.test(name)) {
      yield path
    }
  }
}

function packageOf(specifier) {
  const bare = specifier.split('?')[0]
  if (bare.startsWith('.') || bare.startsWith('/') || bare.startsWith('node:')) return null
  if (ALIASES.some((alias) => bare === alias || bare.startsWith(`${alias}/`))) return null
  const parts = bare.split('/')
  const name = bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return builtinModules.includes(name) || SKIP.has(name) ? null : name
}

/** Every package the app's source imports at runtime, plus package.json's `dependencies`. */
function rootPackages() {
  const names = new Set(Object.keys(readJson(join(ROOT, 'package.json')).dependencies ?? {}))
  const IMPORT =
    /^\s*(?:import\s+(?!type\b)(?:[^'";]*?\bfrom\s*)?|export\s+(?:\*|\{[^}]*\})\s*from\s*)['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const name = packageOf(match[1] ?? match[2])
      if (name) names.add(name)
    }
  }
  return [...names].filter((name) => !SKIP.has(name))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Node's lookup: the nearest node_modules/<name> at or above `from`. */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return manifest
    if (dirname(dir) === dir) return null
  }
}

function collectPackages() {
  const found = new Map()
  const visit = (name, from, optional) => {
    if (SKIP.has(name)) return
    const manifest = locate(name, from)
    if (!manifest) {
      // An optional dependency for another platform is simply not installed.
      if (optional) return
      throw new Error(`third-party-notices: ${name} is imported but not installed`)
    }
    const dir = dirname(manifest)
    if ([...found.values()].some((pkg) => pkg.dir === dir)) return
    const json = readJson(manifest)
    found.set(`${json.name}@${json.version}`, { dir, json })
    for (const dep of Object.keys(json.dependencies ?? {})) visit(dep, dir, false)
    for (const dep of Object.keys(json.optionalDependencies ?? {})) visit(dep, dir, true)
  }
  for (const name of rootPackages()) visit(name, ROOT, false)
  return [...found.values()].sort(
    (a, b) => a.json.name.localeCompare(b.json.name) || a.json.version.localeCompare(b.json.version)
  )
}

function licenseId(json) {
  const { license, licenses } = json
  if (typeof license === 'string') return license
  if (license?.type) return license.type
  if (Array.isArray(licenses)) return licenses.map((l) => l.type ?? l).join(' OR ')
  return 'unstated'
}

function sourceUrl(json) {
  const repo = typeof json.repository === 'string' ? json.repository : json.repository?.url
  const url = repo ?? json.homepage
  if (!url) return null
  return (
    url
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, 'https://github.com/')
      .replace(/^github:/, 'https://github.com/')
      // npm's shorthand: a bare "owner/repo" is a GitHub repository.
      .replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
      .replace(/\.git$/, '')
  )
}

function heading(title) {
  return `${RULE}\n${title}\n${RULE}\n`
}

function packageEntry({ dir, json }) {
  const files = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
  const lines = []
  if (files.length === 0) {
    lines.push(
      `(The package carries no license file; its package.json declares ${licenseId(json)}.)`
    )
  }
  for (const file of files) lines.push(readFileSync(join(dir, file), 'utf8').trimEnd(), '')
  const nested = NESTED[json.name]
  for (const file of nested?.files ?? []) {
    lines.push(`${file}:`, '', readFileSync(join(dir, file), 'utf8').trimEnd(), '')
  }
  if (nested?.note) lines.push(nested.note)
  return {
    name: json.name,
    version: json.version,
    license: licenseId(json),
    source: sourceUrl(json),
    text: lines.join('\n').trimEnd()
  }
}

function packageSection({ name, version, license, source, text }) {
  const lines = [heading(`${name} ${version} — ${license}`)]
  if (source) lines.push(`Source: ${source}`)
  lines.push('', text)
  return lines.join('\n').trimEnd()
}

/**
 * The notices beside components built from source, in path order. Each is
 * already in this file's shape: a heading, then the license text.
 */
function builtSections() {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.licenses.txt')) files.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  // Split at each heading so a section two files share (Emscripten's runtime,
  // linked into every wasm module) appears once.
  const sections = files.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split(new RegExp(`(?=^${RULE}\\n[^\\n]+\\n${RULE}$)`, 'm'))
      .map((section) => section.trimEnd())
  )
  return [...new Set(sections)]
}

/** A built component's section as an entry: its heading's last word is the version when it has a digit. */
function builtEntry(section) {
  const [, title, text] = section.match(
    new RegExp(`^${RULE}\\n([^\\n]+)\\n${RULE}\\n+([\\s\\S]*)$`)
  )
  const words = title.split(' ')
  const versioned = words.length > 1 && /\d/.test(words.at(-1))
  return {
    name: versioned ? words.slice(0, -1).join(' ') : title,
    version: versioned ? words.at(-1) : null,
    license: null,
    source: null,
    text
  }
}

const KICAD = `Where GoatCAD's output must match KiCad's, parts of it follow KiCad's own
algorithms, and those parts derive from KiCad: Copyright The KiCad Developers,
licensed under the GNU General Public License version 3 or later.
https://www.kicad.org`

const HEADER = `GoatCAD
Copyright © Goat Hill Electronics LLC and contributors

GoatCAD is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. GoatCAD is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. The license's full text closes this file.

The source code is at https://github.com/goat-hill/goatcad.

${KICAD}

Electron and Chromium ship their notices beside the app, in
LICENSE.electron.txt and LICENSES.chromium.html.

GoatCAD also includes the software below, each under its own license.`

/**
 * What Settings ▸ About names first; the rest fold under "supporting
 * components". The page sorts each group by name. Keyed by entry name. A built component's notice
 * states no SPDX id or source, so its row gives them here.
 */
const FEATURED = {
  KiCad: { license: 'GPL-3.0-or-later', source: 'https://www.kicad.org' },
  Electron: { license: 'MIT', source: 'https://github.com/electron/electron' },
  'Newstroke font (KiCad)': {
    license: 'GPL-2.0-or-later AND MIT',
    source: 'https://gitlab.com/kicad/code/kicad'
  },
  PDFium: { license: 'BSD-3-Clause', source: 'https://pdfium.googlesource.com/pdfium' },
  Clipper2: { license: 'BSL-1.0', source: 'https://github.com/AngusJohnson/Clipper2' },
  'occt-import-js': {},
  three: {},
  vue: {},
  '@xterm/xterm': {},
  'node-pty': {}
}

/**
 * Both outputs from one pass. The notices file, and what Settings ▸ About
 * shows: the GPL's text, and one entry per component in the file's order (the
 * page sorts them). KiCad's license is GoatCAD's own, so its entry is the
 * attribution.
 */
export function buildNotices() {
  const built = builtSections()
  const packages = collectPackages().map(packageEntry)
  const gpl = readFileSync(join(ROOT, '..', 'LICENSE'), 'utf8').trimEnd()
  const text =
    [
      HEADER,
      ...built,
      ...packages.map(packageSection),
      `${heading('GNU General Public License, version 3')}\n${gpl}`
    ].join('\n\n') + '\n'

  const kicad = { name: 'KiCad', version: null, license: null, source: null, text: KICAD }
  // Electron's notices ship beside the app rather than in the file, but the
  // list names it like the rest.
  const electronDir = join(ROOT, 'node_modules', 'electron')
  const electron = {
    name: 'Electron',
    version: readJson(join(electronDir, 'package.json')).version,
    license: null,
    source: null,
    text: `${readFileSync(join(electronDir, 'LICENSE'), 'utf8').trimEnd()}

Chromium, Node.js and the other components Electron includes ship their
notices beside the app, in LICENSES.chromium.html.`
  }
  const order = Object.keys(FEATURED)
  const entries = [kicad, electron, ...built.map(builtEntry), ...packages].map((entry) => ({
    ...entry,
    ...FEATURED[entry.name],
    featured: order.includes(entry.name)
  }))
  const missing = order.filter((name) => !entries.some((entry) => entry.name === name))
  if (missing.length) throw new Error(`third-party-notices: featured but not shipped: ${missing}`)
  return { text, list: JSON.stringify({ gpl, components: entries }, null, 2) + '\n' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, list } = buildNotices()
  writeFileSync(NOTICES_PATH, text)
  writeFileSync(LIST_PATH, list)
  for (const path of [NOTICES_PATH, LIST_PATH]) {
    console.log(`Wrote ${relative(process.cwd(), path).split(sep).join('/')}`)
  }
}
