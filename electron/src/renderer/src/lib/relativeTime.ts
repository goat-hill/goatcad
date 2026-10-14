/**
 * "2 days ago" / "2 minutes ago" for a past timestamp.
 *
 * Built on `Intl.RelativeTimeFormat` rather than a hand-rolled table, for the
 * same reason `locales/plurals.ts` derives its rules from `Intl.PluralRules`:
 * the platform already knows every locale's wording, including the irregular
 * ones ("yesterday" rather than "1 day ago", which `numeric: 'auto'` gives free).
 *
 * Returns **null** for anything too recent to name, leaving the caller to render
 * its own translated "just now". That split keeps the one string a caller must
 * supply in the locale files, where a translator can see it, instead of
 * hardcoding an English phrase here.
 */

/** Largest unit first; the first one the elapsed time reaches is the one used. */
const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

/** Under this, "3 seconds ago" is noise — the caller says "just now" instead. */
const JUST_NOW_SECONDS = 45

export function relativeTime(atMs: number, nowMs: number, locale: string): string | null {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null

  // Negative = in the past, which is the sign Intl.RelativeTimeFormat wants.
  const elapsed = Math.round((atMs - nowMs) / 1000)
  if (Math.abs(elapsed) < JUST_NOW_SECONDS) return null

  for (const [unit, seconds] of UNITS) {
    if (Math.abs(elapsed) < seconds) continue
    const value = Math.round(elapsed / seconds)
    // An unknown locale tag throws rather than falling back, and a stale display
    // string is never worth failing a render over.
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit)
    } catch {
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, unit)
    }
  }
  return null
}
