/**
 * The width a trace needs to carry a current, per IPC-2221: I = k·ΔT^0.44·A^0.725,
 * with I in amperes, ΔT the allowed rise in °C and A the cross-section in mil².
 * An inner layer sheds heat into the laminate, so its k is half an outer one's.
 */

import { spacingToMm } from '../kicad/coordinates'

const K_OUTER = 0.048
const K_INNER = 0.024
const MM_PER_MIL = spacingToMm(1, 'mil')

/** The chart range IPC-2221 was fitted over; past it the formula is extrapolation. */
/** Inner copper's chart stops at half the outer's current. */
const MAX_AMPS_OUTER = 35
const MAX_AMPS_INNER = 17.5
const MIN_RISE = 10
const MAX_RISE = 100
const MAX_WIDTH_MIL = 400
const MIN_COPPER_MIL = 0.0175 / MM_PER_MIL // 0.5 oz
const MAX_COPPER_MIL = 0.105 / MM_PER_MIL // 3 oz

export interface TraceWidth {
  /** The least width, mm; null where the inputs give none (no current, no copper). */
  widthMm: number | null
  /** Inside the range the formula was fitted over. */
  inRange: boolean
}

export function traceWidthForCurrent(
  amps: number,
  riseC: number,
  copperMm: number,
  outer: boolean
): TraceWidth {
  if (!(amps > 0) || !(riseC > 0) || !(copperMm > 0)) return { widthMm: null, inRange: false }
  const k = outer ? K_OUTER : K_INNER
  const areaMil2 = (amps / (k * riseC ** 0.44)) ** (1 / 0.725)
  const copperMil = copperMm / MM_PER_MIL
  const widthMil = areaMil2 / copperMil
  const inRange =
    amps <= (outer ? MAX_AMPS_OUTER : MAX_AMPS_INNER) &&
    riseC >= MIN_RISE &&
    riseC <= MAX_RISE &&
    widthMil <= MAX_WIDTH_MIL &&
    copperMil >= MIN_COPPER_MIL - 1e-9 &&
    copperMil <= MAX_COPPER_MIL + 1e-9
  return { widthMm: widthMil * MM_PER_MIL, inRange }
}
