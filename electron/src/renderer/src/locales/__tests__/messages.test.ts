import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createI18n } from 'vue-i18n'
import { i18n, LOCALE_NAMES } from '../../i18n'
import { HOTKEYS } from '../../lib/hotkeys'
import { SUPPORTED_LOCALES } from '../../../../main/appConfig'
import { pluralBranchCount, pluralRuleFor, pluralRulesFor } from '../plurals'
import {
  flatten,
  hasSuspectPipe,
  isDeliberatePlural,
  loadLocale,
  localeNames,
  pluralBranches,
  resolvePath
} from './helpers'

/** Correctness checks for messages shared by every locale. */

const rendererDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'locales') continue
      out.push(...sourceFiles(join(dir, entry.name)))
    } else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** `t('…')` translates now; `tk('…')` marks a key translated later (lib/messageKey.ts). */
const STATIC_KEY = /\btk?\(\s*(['"])([A-Za-z0-9_.]+)\1/g
const KEYPATH = /keypath\s*=\s*"([A-Za-z0-9_.]+)"/g
/** e.g. t(`shared.layerPresets.${key}`) -> captures "shared.layerPresets." */
const DYNAMIC_PREFIX = /\bt\(\s*`([A-Za-z0-9_.]*)\$\{/g

/** Comments may name a key in prose; blank them, keeping offsets and line numbers. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm, (match) => match.replace(/[^\n]/g, ' '))

const collect = (re: RegExp, text: string, group: number): string[] => {
  const found: string[] = []
  for (const match of text.matchAll(re)) found.push(match[group])
  return found
}

const en = loadLocale('en')

describe('locale message shape', () => {
  // Every locale, not just en: a translator writing "a | b" as a separator
  // breaks the message exactly the same way, and that is a bug, not a gap.
  test.each(localeNames())('%s has no message with an accidental pipe', (locale) => {
    const offenders = [...flatten(loadLocale(locale))].filter(([, message]) =>
      hasSuspectPipe(message)
    )
    expect(offenders).toEqual([])
  })

  // vue-i18n treats `${VAR}` as an interpolation; KiCad path variables need escaping.
  test.each(localeNames())('%s has no message with an unescaped ${…} token', (locale) => {
    const offenders = [...flatten(loadLocale(locale))]
      .filter(([, message]) => /\$\{/.test(message))
      .map(([key, message]) => `${key}: ${message}`)
    expect(offenders).toEqual([])
  })

  // vue-i18n compiles lazily, so key and shape checks cannot catch syntax errors.
  test.each(localeNames())('%s compiles every message', (locale) => {
    const failures: string[] = []
    for (const [key, message] of flatten(loadLocale(locale))) {
      try {
        // Compilation is the assertion; placeholder values are irrelevant.
        createI18n({ legacy: false, locale, messages: { [locale]: { message } } }).global.t(
          'message'
        )
      } catch (err) {
        failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    expect(failures).toEqual([])
  })

  test('a ${…} token fails loudly or silently depending on what is inside it', () => {
    const render = (message: string): string | Error => {
      try {
        return createI18n({ legacy: false, locale: 'en', messages: { en: { message } } }).global.t(
          'message'
        )
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err))
      }
    }

    // Invalid identifiers throw.
    expect(render('Paths using ${KICAD…_3DMODEL_DIR} resolve here.')).toBeInstanceOf(Error)
    expect(render('Paths using ${KICAD*_3DMODEL_DIR} resolve here.')).toBeInstanceOf(Error)

    // Valid identifiers compile but render as nothing.
    expect(render('Paths using ${KICAD10_3DMODEL_DIR} resolve here.')).toBe(
      'Paths using $ resolve here.'
    )

    // Both fixes keep the token intact.
    expect(render("Paths using {'${KICAD10_3DMODEL_DIR}'} resolve here.")).toBe(
      'Paths using ${KICAD10_3DMODEL_DIR} resolve here.'
    )
    expect(render('Paths using {variableName} resolve here.')).toBe('Paths using  resolve here.')
  })

  test('pipe rule flags a separator, allows a plural, allows an escape', () => {
    expect(hasSuspectPipe('Electron v{electron} | Chrome v{chrome}')).toBe(true)
    expect(hasSuspectPipe('{count} symbol | {count} symbols')).toBe(false)
    expect(hasSuspectPipe('Rotate Footprint | Rotate {count} Footprints')).toBe(false)
    expect(hasSuspectPipe("Pipe {'|'} literal")).toBe(false)
    expect(hasSuspectPipe('No pipe at all')).toBe(false)
  })
})

describe('pluralisation', () => {
  test.each(localeNames())('%s plural messages have the CLDR branch count', (locale) => {
    const expected = pluralBranchCount(locale)
    const translated = flatten(loadLocale(locale))
    const wrong: string[] = []
    for (const [key, enMessage] of flatten(en)) {
      if (!isDeliberatePlural(enMessage)) continue
      const message = translated.get(key)
      // Completeness is checked separately.
      if (message === undefined) continue
      // A pipeless message is one branch — the whole of a 1-category locale (ja, zh-CN).
      const count = Math.max(pluralBranches(message).length, 1)
      if (count !== expected) wrong.push(`${key}: ${count} branches, expected ${expected}`)
    }
    expect(wrong).toEqual([])
  })

  test('branch counts come from CLDR, not from assuming English', () => {
    expect(pluralBranchCount('en')).toBe(2) // one, other
    expect(pluralBranchCount('ja')).toBe(1) // other
    expect(pluralBranchCount('fr')).toBe(3) // one, many, other — not two!
    expect(pluralBranchCount('ru')).toBe(4) // one, few, many, other
    expect(pluralBranchCount('ar')).toBe(6) // zero, one, two, few, many, other
  })

  test('en indices match vue-i18n’s default, so existing messages are unchanged', () => {
    const rule = pluralRuleFor('en')
    expect(rule(0, 2)).toBe(1) // other
    expect(rule(1, 2)).toBe(0) // one
    expect(rule(2, 2)).toBe(1) // other
  })

  test('picks the right branch for languages vue-i18n’s default gets wrong', () => {
    const ru = pluralRuleFor('ru')
    expect(ru(1, 4)).toBe(0) // one
    expect(ru(2, 4)).toBe(1) // few   — default would have said "other"
    expect(ru(5, 4)).toBe(2) // many  — default would have said "other"
    expect(ru(21, 4)).toBe(0) // one  — 21 is singular in Russian

    const ar = pluralRuleFor('ar')
    expect([0, 1, 2, 3, 11, 100].map((n) => ar(n, 6))).toEqual([0, 1, 2, 3, 4, 5])

    expect(pluralRuleFor('ja')(5, 1)).toBe(0) // single form for everything
  })

  test('clamps instead of throwing when a message has too few branches', () => {
    // Wrong branch count is locale-data rot; the test above is what should fail,
    // not the render.
    expect(pluralRuleFor('ru')(5, 2)).toBe(1)
  })

  test('renders Russian forms correctly end-to-end', () => {
    // Proves the wiring works for a 4-form language before we ship one.
    const ru = createI18n({
      legacy: false,
      locale: 'ru',
      messages: {
        ru: { files: '{count} файл | {count} файла | {count} файлов | {count} файла' }
      },
      pluralRules: pluralRulesFor(['ru'])
    })
    const t = ru.global.t
    expect(t('files', { count: 1 }, 1)).toBe('1 файл')
    expect(t('files', { count: 2 }, 2)).toBe('2 файла')
    expect(t('files', { count: 5 }, 5)).toBe('5 файлов')
    expect(t('files', { count: 21 }, 21)).toBe('21 файл')
  })

  test('the shipped instance registers a rule for every locale it has', () => {
    // pluralRules is derived from the messages map; drift means a locale would
    // silently fall back to the English-shaped default.
    for (const locale of i18n.global.availableLocales) {
      expect(pluralBranchCount(locale)).toBeGreaterThan(0)
    }
  })

  test('the shipped instance still renders en plurals as before', () => {
    const t = i18n.global.t
    expect(t('commandLabels.move', { count: 1 }, 1)).toBe('Move item')
    expect(t('commandLabels.move', { count: 2 }, 2)).toBe('Move 2 items')
    expect(t('schematicEditor.itemTypes.symbol', { count: 1 }, 1)).toBe('1 symbol')
    expect(t('schematicEditor.itemTypes.symbol', { count: 3 }, 3)).toBe('3 symbols')
  })
})

describe('key coverage', () => {
  const files = sourceFiles(rendererDir)

  test('finds the renderer sources it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  test('every static t() / keypath key resolves', () => {
    const missing: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const keys = [...collect(STATIC_KEY, text, 2), ...collect(KEYPATH, text, 1)]
      for (const key of keys) {
        if (typeof resolvePath(en, key) !== 'string') missing.push(`${file}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('every key literal is marked with t() or tk()', () => {
    // A key passed around as a bare string is invisible to the check above, so
    // a missing message ships and shows only in the app. Hotkey ids share the
    // dotted shape and are not keys.
    const namespaces = Object.keys(en).join('|')
    const keyLiteral = new RegExp(`'((?:${namespaces})(?:\\.[A-Za-z0-9_]+)+)'`, 'g')
    const hotkeys = new Set<string>(Object.keys(HOTKEYS))
    const unmarked: string[] = []
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const match of text.matchAll(keyLiteral)) {
        const before = text.slice(0, match.index)
        if (hotkeys.has(match[1]) || /\btk?\(\s*$/.test(before)) continue
        unmarked.push(`${file}:${before.split('\n').length}: ${match[1]}`)
      }
    }
    expect(unmarked).toEqual([])
  })

  test('every dynamically-built key has a populated namespace', () => {
    // Template-literal keys can't be resolved statically; assert the namespace
    // they index into exists and is non-empty.
    const missing: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const prefix of collect(DYNAMIC_PREFIX, text, 1)) {
        const namespace = resolvePath(en, prefix.replace(/\.$/, ''))
        if (typeof namespace !== 'object' || Object.keys(namespace).length === 0) {
          missing.push(`${file}: ${prefix}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

/**
 * The locale *list* has to agree in four places, and a mismatch is a real bug
 * rather than missing translation work — so unlike parity, these stay in the
 * dev suite.
 */
describe('locale registration', () => {
  const locales = localeNames()

  test('en exists', () => {
    expect(locales).toContain('en')
  })

  test('every locale on disk is registered with vue-i18n', () => {
    // An unregistered locale silently falls back to en, which looks fine in dev.
    expect([...locales].sort()).toEqual([...i18n.global.availableLocales].sort())
  })

  test("main's SUPPORTED_LOCALES matches what vue-i18n has registered", () => {
    // The main process validates the persisted `locale` but cannot import
    // i18n.ts, so the list is duplicated by necessity. If it drifts, main
    // either rejects a language the UI offers (the picker silently does
    // nothing) or persists one the renderer cannot render.
    expect([...SUPPORTED_LOCALES].sort()).toEqual([...i18n.global.availableLocales].sort())
  })

  test('every locale has an endonym for the language picker', () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...i18n.global.availableLocales].sort())
  })

  // Whether each locale is fully *translated* is checked by
  // messages.completeness.test.ts, which only the release workflow runs.
})
