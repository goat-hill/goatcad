/**
 * Safe coordinate conversions using integer nanometers.
 * Avoids floating-point precision issues when doing layout edits.
 */

// 1 mm = 1,000,000 nm
export const NM_PER_MM = 1000000
// 1 mil = 0.0254 mm = 25,400 nm
export const NM_PER_MIL = 25400
// 1 in = 25.4 mm = 25,400,000 nm
export const NM_PER_INCH = 25400000

/** The units a length is shown and typed in: KiCad's mm, mil and in. */
export type LengthUnit = 'mm' | 'mil' | 'in'

const NM_PER_UNIT: Record<LengthUnit, number> = { mm: NM_PER_MM, mil: NM_PER_MIL, in: NM_PER_INCH }

/**
 * An integer count of nanometers — the domain model's coordinate type.
 *
 * KiCad holds coordinates as integers on a nanometer grid; binary64 holds
 * integers exactly to 2^53, four orders beyond KiCad's ±2147 mm int32 range,
 * so `number` carrying integers loses nothing — it is fractional millimeters
 * that drift. The brand is erased at compile time; its job is to make an
 * unconverted millimeter value landing in a nanometer slot a type error.
 *
 * Arithmetic widens `Nm` back to `number`; re-brand results at the boundary
 * with `nm()` (which rounds, because trig and averaging produce fractions).
 */
export type Nm = number & { readonly __nm: unique symbol }

/** KiCad's coordinate limit (int32 nm = ±2147 mm) — the packed-storage guard. */
export const NM_INT32_MAX = 2147483647

/**
 * Re-brand a numeric result as integer nanometers, rounding away any
 * fractional part that trig or division introduced.
 */
export const nm = (value: number): Nm => Math.round(value) as Nm

/** Fractional millimeters to integer nanometers. */
export const mmToNm = (mm: number): Nm => Math.round(mm * NM_PER_MM) as Nm

/** Integer nanometers to millimeters — the nm→mm world/scene boundary. */
export const nmToMm = (value: Nm): number => value / NM_PER_MM

/**
 * Parse a KiCad decimal atom (millimeters) into integer nanometers. KiCad's
 * own writer emits at most 6 decimals, so for files it authored this is
 * lossless; hand-written values beyond the 1 nm grid round onto it.
 */
export const mmAtomToNm = (text: string): Nm => Math.round(parseFloat(text) * NM_PER_MM) as Nm

/**
 * Format integer nanometers as KiCad's canonical millimeter decimal.
 *
 * For integer nm, `value / 1e6` is the double nearest the exact ≤6-decimal
 * value, and String() prints the shortest decimal identifying that double —
 * which is exactly that ≤6-decimal form (two distinct ≤6-decimal values are
 * never closer than a double ulp in this range). So the output is
 * byte-identical to what `formatKicadNumber` emits for the same on-grid
 * value, and can never be exponential: |mm| is 0 or ≥ 1e-6.
 */
export function formatNmAtom(value: Nm): string {
  const mm = value / NM_PER_MM
  return Object.is(mm, -0) ? '0' : String(mm)
}

/** A typed unit suffix, read as KiCad's unit parser reads it. */
const unitOfSuffix = (suffix: string): LengthUnit =>
  suffix === 'mm' ? 'mm' : suffix.startsWith('mil') ? 'mil' : 'in'

/**
 * Parses a coordinate string (e.g. "1.5mm", "100mil", "0.1in", "-0.5") into integer nanometers.
 * If no unit is specified, uses the provided defaultUnit.
 */
export function parseValueToNanometers(input: string, defaultUnit: LengthUnit): number {
  const clean = input.trim().toLowerCase()
  if (!clean) return 0

  const match = clean.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(mm|mils?|in|inch|inches|")?$/)
  if (!match) {
    throw new Error(`Invalid coordinate format: "${input}"`)
  }

  const value = parseFloat(match[1])
  if (isNaN(value)) {
    throw new Error(`Invalid numeric value: "${match[1]}"`)
  }

  const unit = match[2] ? unitOfSuffix(match[2]) : defaultUnit
  return Math.round(value * NM_PER_UNIT[unit])
}

/** A grid spacing expressed in its own unit, as millimeters. */
export function spacingToMm(spacing: number, unit: LengthUnit): number {
  return unit === 'mm' ? spacing : (spacing * NM_PER_UNIT[unit]) / NM_PER_MM
}

/** The inverse of `spacingToMm`: millimeters back into `unit`. */
export function mmToSpacing(mm: number, unit: LengthUnit): number {
  return unit === 'mm' ? mm : (mm * NM_PER_MM) / NM_PER_UNIT[unit]
}

/**
 * A small distance tolerance in nanometers, for tests that measure a distance
 * TO something (a segment, a line) rather than compare two stored points —
 * projection arithmetic can leave sub-nanometer residue even on integer
 * inputs. Never needed for point identity: stored points are exact integers.
 */
export const SNAP_EPSILON_NM = 1000

/**
 * Do two domain points name the same spot? Exact integer equality — the
 * dividend of the nm migration. Every stored coordinate is an integer, so a
 * tolerance here could only paper over a value that failed to be rounded on
 * its way in, which is a bug this comparison should surface, not absorb.
 */
export const pointsEqualNm = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  a.x === b.x && a.y === b.y

/**
 * Formats a decimal value — a millimeter distance or a degree angle — for
 * writing into a KiCad file. The single write-side quantizer; every mutator
 * that emits a number goes through it.
 *
 * KiCad holds coordinates as integers in a nanometer-scale internal unit, so
 * every value it writes sits on the 1 nm grid. We hold millimeters as binary64,
 * where 1.27 and 0.0254 have no exact form — so arithmetic drifts and String()
 * faithfully prints the drift (`13.969999999999997`). Worse, String() switches
 * to exponential notation below 1e-6, and KiCad's number parser rejects it: a
 * rotation that drives a coordinate near zero would write a file KiCad cannot
 * open. Snapping to the 1e-6 grid fixes both — and because 1e-6 is exactly the
 * quantum, a non-zero result can never come back exponential.
 *
 * For millimeters the grid is principled: 1e-6 mm is 1 nm, KiCad's own quantum,
 * and its writer emits at most 6 decimals, so this is lossless for KiCad-authored
 * files. For degrees the same quantum is simply far below any meaningful angular
 * precision, and earns its place by killing the exponential-notation case.
 *
 * Distances in the domain model are integer nanometers and write through
 * `formatNmAtom`; this serves the values that stay fractional (angles, ratios).
 */
export function formatKicadNumber(value: number): string {
  const snapped = Math.round(value * NM_PER_MM) / NM_PER_MM
  return Object.is(snapped, -0) ? '0' : String(snapped)
}

/** Decimals a typed length keeps: 4 for mm, 2 for mil, 5 for in (a hundredth of a mil). */
const UNIT_DECIMALS: Record<LengthUnit, number> = { mm: 4, mil: 2, in: 5 }

/**
 * Formats integer nanometers into a clean unit string for UI textboxes,
 * rounding to `UNIT_DECIMALS` places.
 */
export function formatNanometersToUnit(nm: number, targetUnit: LengthUnit): string {
  const value = nm / NM_PER_UNIT[targetUnit]
  return parseFloat(value.toFixed(UNIT_DECIMALS[targetUnit])).toString()
}
