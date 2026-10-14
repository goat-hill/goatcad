import { describe, it, expect } from 'vitest'
import {
  dayKey,
  nextDayResetMs,
  normalizeUsageFile,
  PartsQuotaTracker,
  type QuotaLimits
} from '../partsRateLimit'
import type { PartsProviderId } from '../../preload/partsTypes'

const LIMITS: Record<PartsProviderId, QuotaLimits> = {
  digikey: { perMinute: 3, perDay: 5 },
  mouser: { perMinute: 2, perDay: 4 }
}

/** A clock the test moves by hand — the whole point of injecting it. */
const clock = (start: number): { now: () => number; advance: (ms: number) => void } => {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

describe('day bucket', () => {
  it('keys on the UTC date, not on elapsed time', () => {
    expect(dayKey(Date.UTC(2026, 7, 14, 23, 59))).toBe('2026-08-14')
    expect(dayKey(Date.UTC(2026, 7, 15, 0, 1))).toBe('2026-08-15')
  })

  it('resets at the next UTC midnight', () => {
    const now = Date.UTC(2026, 7, 14, 13, 0)
    expect(nextDayResetMs(now)).toBe(Date.UTC(2026, 7, 15))
  })
})

describe('PartsQuotaTracker', () => {
  it('allows up to the per-minute limit, then refuses locally', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)

    for (let i = 0; i < 3; i++) {
      expect(tracker.check('digikey').allowed).toBe(true)
      tracker.record('digikey')
    }
    const verdict = tracker.check('digikey')
    expect(verdict).toMatchObject({ allowed: false, reason: 'rate-limited' })
  })

  it('frees a minute slot as the oldest hit ages out', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)
    tracker.record('mouser')
    tracker.record('mouser')
    expect(tracker.check('mouser').allowed).toBe(false)

    time.advance(60_001)
    expect(tracker.check('mouser').allowed).toBe(true)
  })

  it('refuses with quota-exhausted once the day is spent, and says when it resets', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)
    // Spread across minutes so the daily limit, not the per-minute one, bites.
    for (let i = 0; i < 5; i++) {
      tracker.record('digikey')
      time.advance(61_000)
    }
    const verdict = tracker.check('digikey')
    expect(verdict).toMatchObject({ allowed: false, reason: 'quota-exhausted' })
    if (verdict.allowed) throw new Error('expected a refusal')
    expect(time.now() + verdict.retryAfterMs).toBe(Date.UTC(2026, 7, 15))
  })

  it('rolls the day over without a timer — a machine asleep past midnight recovers', () => {
    const time = clock(Date.UTC(2026, 7, 14, 23, 59))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)
    for (let i = 0; i < 5; i++) tracker.record('digikey')
    expect(tracker.check('digikey').allowed).toBe(false)

    time.advance(2 * 60_000) // past midnight UTC
    expect(tracker.check('digikey').allowed).toBe(true)
    expect(tracker.usage('digikey').day.used).toBe(0)
  })

  it('carries the day count across a restart', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const first = new PartsQuotaTracker(LIMITS, time.now)
    first.record('mouser')
    first.record('mouser')

    // A fresh process on the same day must not get its quota back.
    const second = new PartsQuotaTracker(LIMITS, time.now, first.snapshot())
    expect(second.usage('mouser').day.used).toBe(2)
  })

  it('keeps quotas independent per provider', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)
    for (let i = 0; i < 3; i++) tracker.record('digikey')
    expect(tracker.check('digikey').allowed).toBe(false)
    expect(tracker.check('mouser').allowed).toBe(true)
  })

  it('charges a request even when it fails — the provider counted it too', () => {
    const time = clock(Date.UTC(2026, 7, 14, 12, 0))
    const tracker = new PartsQuotaTracker(LIMITS, time.now)
    tracker.record('mouser')
    expect(tracker.usage('mouser').day.used).toBe(1)
    expect(tracker.usage('mouser').lastSuccessAt).toBeNull()
  })
})

describe('normalizeUsageFile', () => {
  it('drops junk rather than failing', () => {
    expect(normalizeUsageFile(null)).toEqual({})
    expect(normalizeUsageFile('nope')).toEqual({})
    expect(normalizeUsageFile({ unknownProvider: { day: '2026-08-14', dayCount: 3 } })).toEqual({})
    expect(normalizeUsageFile({ mouser: { dayCount: 3 } })).toEqual({})
  })

  it('keeps a well-formed entry', () => {
    expect(
      normalizeUsageFile({ mouser: { day: '2026-08-14', dayCount: 7, lastSuccessAt: 123 } })
    ).toEqual({ mouser: { day: '2026-08-14', dayCount: 7, lastSuccessAt: 123 } })
  })
})
