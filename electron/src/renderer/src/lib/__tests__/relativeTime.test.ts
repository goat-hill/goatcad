import { describe, it, expect } from 'vitest'
import { relativeTime } from '../relativeTime'

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)
const ago = (seconds: number): number => NOW - seconds * 1000

describe('relativeTime', () => {
  it('returns null for anything too recent to name', () => {
    // The caller renders its own translated "just now"; naming seconds here
    // would hardcode an English phrase outside the locale files.
    expect(relativeTime(NOW, NOW, 'en')).toBeNull()
    expect(relativeTime(ago(3), NOW, 'en')).toBeNull()
    expect(relativeTime(ago(44), NOW, 'en')).toBeNull()
  })

  it('names minutes, hours and days', () => {
    expect(relativeTime(ago(60), NOW, 'en')).toBe('1 minute ago')
    expect(relativeTime(ago(120), NOW, 'en')).toBe('2 minutes ago')
    expect(relativeTime(ago(3 * 3600), NOW, 'en')).toBe('3 hours ago')
    expect(relativeTime(ago(2 * 86400), NOW, 'en')).toBe('2 days ago')
  })

  it('uses the locale-idiomatic wording rather than a literal count', () => {
    // What `numeric: 'auto'` buys: the platform knows "yesterday" is the right
    // English for one day, and knows the equivalent in every other locale.
    expect(relativeTime(ago(86400), NOW, 'en')).toBe('yesterday')
  })

  it('picks the largest unit that fits', () => {
    expect(relativeTime(ago(9 * 86400), NOW, 'en')).toBe('last week')
    expect(relativeTime(ago(40 * 86400), NOW, 'en')).toBe('last month')
    expect(relativeTime(ago(75 * 86400), NOW, 'en')).toBe('2 months ago')
    expect(relativeTime(ago(400 * 86400), NOW, 'en')).toBe('last year')
  })

  it('translates with the locale, idioms included', () => {
    // German has a single word for "the day before yesterday"; a hand-rolled
    // "vor {n} Tagen" table would never produce it.
    expect(relativeTime(ago(2 * 86400), NOW, 'de')).toBe('vorgestern')
    expect(relativeTime(ago(5 * 86400), NOW, 'de')).toBe('vor 5 Tagen')
  })

  it('falls back to English rather than throwing on a junk locale tag', () => {
    // A stale display string is never worth failing a render over.
    expect(relativeTime(ago(2 * 86400), NOW, 'not a locale')).toBe('2 days ago')
  })

  it('returns null on a non-finite timestamp', () => {
    expect(relativeTime(Number.NaN, NOW, 'en')).toBeNull()
    expect(relativeTime(NOW, Number.POSITIVE_INFINITY, 'en')).toBeNull()
  })
})
