/**
 * The tuner's cursor meter (router-behavior.md T4): where the length (skew)
 * sits against the min and max it is held to, as fractions of a bar. The bar
 * spans the bounds with room either side, widened to take the value in, so a
 * far-short tune shows the band small and grows it as the length closes in.
 */

import type { TuneMode, TuneStatus, TuneTarget, TuneTimeScale } from './router/tuning'

/** What the meter reads: a tune in hand, the track under an armed tuner, or a pattern's handles mid-drag. */
export interface TuneMeterReading {
  mode: TuneMode
  net: string
  /** The length, or the skew for a skew tune, mm. */
  value: number
  target: TuneTarget
  status: TuneStatus
  /** Where the tune holds a delay: how it follows the length. */
  time?: TuneTimeScale | null
}

export interface TuneMeterScale {
  /** The band the value is held to, `[min, max]` as fractions of the bar. */
  band: [number, number]
  /** The opt's tick, a fraction of the bar. */
  opt: number
  /** The value's needle, a fraction of the bar. */
  needle: number
}

/** Room either side of the band, as a share of its width. */
const MARGIN = 1
/** Room past the value when it lies outside the band, as a share of the bar. */
const VALUE_ROOM = 0.06

/** The meter's scale, or null where nothing limits the value (no target): the plain readout. */
export function tuneMeterScale(value: number, target: TuneTarget): TuneMeterScale | null {
  const { min, opt, max } = target
  if (!Number.isFinite(opt) || !Number.isFinite(min) || !Number.isFinite(max)) return null
  const span = Math.max(max - min, 1e-6)
  let lo = Math.min(min - span * MARGIN, value)
  let hi = Math.max(max + span * MARGIN, value)
  const room = (hi - lo) * VALUE_ROOM
  if (value <= lo) lo -= room
  if (value >= hi) hi += room
  const at = (v: number): number => (v - lo) / (hi - lo)
  return { band: [at(min), at(max)], opt: at(opt), needle: at(value) }
}
