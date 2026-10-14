import { describe, test, expect } from 'vitest'
import { flatten, loadLocale, localeNames } from './helpers'

/**
 * Release-only: is every locale actually finished?
 *
 * Excluded from `npm run test` (see vitest.config.ts) and run by
 * `npm run test:i18n`, which the release workflow gates on. Adding an English
 * string must not fail a feature PR just because nobody has translated it yet —
 * vue-i18n falls back to `en`, so the app is correct, only untranslated. That
 * debt is a release concern, not a per-commit one.
 *
 * Correctness checks that must never be deferred (malformed messages, wrong
 * plural branch counts, main/renderer locale drift) live in `messages.test.ts`
 * and run on every commit.
 *
 * Failures here name the exact keys, so fixing them — by hand or by an agent —
 * needs no extra digging.
 */

const en = flatten(loadLocale('en'))
const others = localeNames().filter((locale) => locale !== 'en')

describe('translation completeness', () => {
  test('en is the source of truth and has messages', () => {
    expect(localeNames()).toContain('en')
    expect(en.size).toBeGreaterThan(0)
  })

  test.each(others)('%s has every en key, and no keys en lacks', (locale) => {
    const translated = flatten(loadLocale(locale))
    const missing = [...en.keys()].filter((key) => !translated.has(key)).sort()
    const orphaned = [...translated.keys()].filter((key) => !en.has(key)).sort()

    // Reported as named lists rather than a whole-array diff: vitest truncates
    // a 401-element array to "…(400)", which tells you nothing about what to fix.
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] })
  })

  test.each(others)('%s leaves no message identical to English by accident', (locale) => {
    // A copy-paste of the en value is the usual sign of a half-done file. Some
    // strings are legitimately identical across languages (proper nouns, units,
    // KiCad layer codes), so this reports rather than hard-fails on a threshold:
    // it only trips when a whole file looks untouched.
    const translated = flatten(loadLocale(locale))
    const byNamespace = new Map<string, { same: number; total: number }>()
    for (const [key, value] of translated) {
      const namespace = key.split('.')[0]
      const stats = byNamespace.get(namespace) ?? { same: 0, total: 0 }
      stats.total += 1
      if (en.get(key) === value) stats.same += 1
      byNamespace.set(namespace, stats)
    }
    const untouched = [...byNamespace]
      .filter(([, s]) => s.total >= 5 && s.same === s.total)
      .map(([namespace]) => namespace)
    expect(untouched).toEqual([])
  })
})
