import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

// RULES.md §6: never a Unicode character as an icon — the OS picks the font
// that draws it, so it renders differently per platform. Draw a registry glyph
// (lib/icons.ts) instead. Typographic characters (`·`, `—`, `…`, the `‹…›`
// mixed-value placeholder) are text and stay.

const componentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const vueFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return entry.name === '__tests__' ? [] : vueFiles(join(dir, entry.name))
    return entry.name.endsWith('.vue') ? [join(dir, entry.name)] : []
  })

/** Arrows, technical symbols, enclosed alphanumerics, shapes, dingbats and emoji. */
const ICON_LIKE =
  /[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u2500-\u27BF\u27F0-\u27FF\u2900-\u297F\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u
/** A lone `×`, `›`, `+` or `−` as an element's whole content: a close, caret or add/remove button. */
const LONE_GLYPH = /(^|>)\s*[\u00D7\u203A\u2039+\u2212]\s*($|<)/

describe('templates draw icons from the registry, not from Unicode', () => {
  const offenders: string[] = []
  for (const file of vueFiles(componentsDir)) {
    const template = /<template>([\s\S]*)<\/template>/.exec(readFileSync(file, 'utf8'))?.[1]
    if (!template) continue
    // Comments may name a glyph ("not a bare +"); only markup counts.
    const source = template.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ''))
    for (const line of source.split('\n')) {
      if (ICON_LIKE.test(line) || LONE_GLYPH.test(line)) {
        offenders.push(`${relative(componentsDir, file)}: ${line.trim()}`)
      }
    }
  }

  test('no icon-like characters in any template', () => {
    expect(offenders).toEqual([])
  })
})
