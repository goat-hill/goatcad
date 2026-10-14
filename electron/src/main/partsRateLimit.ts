/**
 * Client-side quota accounting for the distributor APIs.
 *
 * The published limits are small — DigiKey ~120/min and ~1000/day, Mouser ~30/min
 * and ~1000/day — so the quota is a design constraint rather than a safety net.
 * Two things follow, and both are here:
 *
 * **We refuse locally rather than learn from a 429.** Spending a call to be told
 * we are out of calls is the one thing a metered client must not do.
 *
 * **The daily count outlives the process.** A per-run counter would reset on every
 * relaunch and quietly overrun the real limit, so the day bucket is persisted and
 * reloaded; the minute bucket is in-memory, where a restart costs at most a few
 * calls of slack and the server's own limit is the backstop.
 *
 * Pure but for the injected clock and reader/writer, so the rollover and refusal
 * paths are unit-testable without waiting a day.
 */
import type { PartsProviderId, PartsUsage } from '../preload/partsTypes'

export interface QuotaLimits {
  perMinute: number
  perDay: number
}

/** One provider's persisted state. `day` is a UTC date key, not a timestamp:
 *  the comparison must be "is it still the same day", which arithmetic on a
 *  duration gets wrong across a clock change. */
export interface ProviderUsageState {
  day: string
  dayCount: number
  lastSuccessAt: number | null
}

export type PartsUsageFile = Partial<Record<PartsProviderId, ProviderUsageState>>

export const dayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10)

/** Midnight UTC after `nowMs` — when the day bucket refills. */
export const nextDayResetMs = (nowMs: number): number => {
  const date = new Date(nowMs)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

const MINUTE_MS = 60_000

export type QuotaVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'rate-limited'; retryAfterMs: number }
  | { allowed: false; reason: 'quota-exhausted'; retryAfterMs: number }

/**
 * Tracks one process's spend against every provider's published quota.
 *
 * `check` is deliberately separate from `record`: a call that never reached the
 * network (no credentials, a cache hit) must not be charged, so only the code
 * that actually issues a request records one.
 */
export class PartsQuotaTracker {
  private readonly minuteHits = new Map<PartsProviderId, number[]>()
  private state: PartsUsageFile

  constructor(
    private readonly limits: Record<PartsProviderId, QuotaLimits>,
    private readonly now: () => number = Date.now,
    initial: PartsUsageFile = {}
  ) {
    this.state = { ...initial }
  }

  private dayState(provider: PartsProviderId): ProviderUsageState {
    const today = dayKey(this.now())
    const existing = this.state[provider]
    // A stale day key *is* the rollover — no timer, so a machine asleep across
    // midnight resets on its next call rather than never.
    if (!existing || existing.day !== today) {
      const fresh: ProviderUsageState = {
        day: today,
        dayCount: 0,
        lastSuccessAt: existing?.lastSuccessAt ?? null
      }
      this.state[provider] = fresh
      return fresh
    }
    return existing
  }

  private recentMinuteHits(provider: PartsProviderId): number[] {
    const cutoff = this.now() - MINUTE_MS
    const hits = (this.minuteHits.get(provider) ?? []).filter((at) => at > cutoff)
    this.minuteHits.set(provider, hits)
    return hits
  }

  check(provider: PartsProviderId): QuotaVerdict {
    const limits = this.limits[provider]
    const day = this.dayState(provider)
    if (day.dayCount >= limits.perDay) {
      return {
        allowed: false,
        reason: 'quota-exhausted',
        retryAfterMs: nextDayResetMs(this.now()) - this.now()
      }
    }
    const hits = this.recentMinuteHits(provider)
    if (hits.length >= limits.perMinute) {
      // The oldest hit in the window is what frees the next slot.
      const retryAfterMs = Math.max(0, hits[0] + MINUTE_MS - this.now())
      return { allowed: false, reason: 'rate-limited', retryAfterMs }
    }
    return { allowed: true }
  }

  /** Charge one request. Called when a request is *issued*, not when it succeeds:
   *  a rejected call still consumed quota at the provider's end. */
  record(provider: PartsProviderId): void {
    const day = this.dayState(provider)
    day.dayCount += 1
    this.minuteHits.set(provider, [...this.recentMinuteHits(provider), this.now()])
  }

  markSuccess(provider: PartsProviderId): void {
    this.dayState(provider).lastSuccessAt = this.now()
  }

  usage(provider: PartsProviderId): PartsUsage {
    const limits = this.limits[provider]
    const day = this.dayState(provider)
    return {
      provider,
      minute: { used: this.recentMinuteHits(provider).length, limit: limits.perMinute },
      day: { used: day.dayCount, limit: limits.perDay, resetsAt: nextDayResetMs(this.now()) },
      lastSuccessAt: day.lastSuccessAt
    }
  }

  snapshot(): PartsUsageFile {
    return { ...this.state }
  }
}

/** Coerce a hand-edited or corrupt usage file; a bad entry loses its count rather
 *  than blocking every search, since the provider's own limit still holds. */
export const normalizeUsageFile = (raw: unknown): PartsUsageFile => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: PartsUsageFile = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'digikey' && key !== 'mouser') continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const day = typeof entry.day === 'string' ? entry.day : null
    const dayCount = typeof entry.dayCount === 'number' && entry.dayCount >= 0 ? entry.dayCount : 0
    if (!day) continue
    result[key] = {
      day,
      dayCount: Math.floor(dayCount),
      lastSuccessAt: typeof entry.lastSuccessAt === 'number' ? entry.lastSuccessAt : null
    }
  }
  return result
}
