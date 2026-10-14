/**
 * The house style a generated footprint is drawn to: KLC's nominal values
 * (`klc.ts`) plus GoatCAD's own choices, as measured off the installed library
 * and as the library's own generator applies them. Every derived element of
 * `footprintGenerate.ts` reads its numbers from here and nowhere else, so a
 * footprint that looks wrong has one place to look.
 */
import { mmToNm, type Nm } from '../kicad/coordinates'
import {
  KLC_COURTYARD_GRID,
  KLC_COURTYARD_OFFSET,
  KLC_COURTYARD_WIDTH,
  KLC_FAB_WIDTH,
  KLC_SILK_WIDTH,
  KLC_TEXT_SIZE,
  KLC_TEXT_THICKNESS
} from './klc'

/** Bumped whenever a rule below changes what a generated file contains; it is
 *  written into every footprint's provenance property. */
export const FOOTPRINT_STYLE_VERSION = 1

/** The provenance property, the `KiLib_Generator` twin. */
export const GENERATOR_PROPERTY = 'GoatCAD_Generator'

export const SILK_WIDTH: Nm = KLC_SILK_WIDTH
export const FAB_WIDTH: Nm = KLC_FAB_WIDTH
export const COURTYARD_WIDTH: Nm = KLC_COURTYARD_WIDTH

/** The silk outline sits this far outside the fab outline. */
export const SILK_OFFSET: Nm = mmToNm(0.11)
/** Silk keeps this clear of any pad's copper (mask, for a through-hole pad). */
export const SILK_PAD_CLEARANCE: Nm = mmToNm(0.2)
/** A silk piece shorter than this after cutting is dropped. */
export const SILK_MIN_SEGMENT: Nm = mmToNm(0.2)

/** Pin 1 bevel on the fab outline: min(1.0, 0.25 × the shorter body side). */
export const FAB_BEVEL_MAX: Nm = mmToNm(1)
export const FAB_BEVEL_FRACTION = 0.25

export const PIN1_CHEVRON_LENGTH: Nm = mmToNm(1)
export const PIN1_DOT_DIAMETER: Nm = mmToNm(0.4)
/** The dot sits this far outside pad 1's copper. */
export const PIN1_DOT_GAP: Nm = mmToNm(0.5)
/** The `line` marker runs this far past pad 1. */
export const PIN1_LINE_OVERRUN: Nm = mmToNm(0.5)

export type CourtyardClass = 'default' | 'connector' | 'bga' | 'crystal'

export const COURTYARD_OFFSET: Record<CourtyardClass, Nm> = {
  default: KLC_COURTYARD_OFFSET.default,
  connector: KLC_COURTYARD_OFFSET.connector,
  bga: KLC_COURTYARD_OFFSET.bga,
  crystal: mmToNm(0.5)
}

/** The courtyard's corners are rounded outward to this grid. */
export const COURTYARD_GRID: Nm = KLC_COURTYARD_GRID

export const TEXT_SIZE: Nm = KLC_TEXT_SIZE
export const TEXT_THICKNESS: Nm = KLC_TEXT_THICKNESS
/** Reference above and Value below the courtyard, by this much to their centers. */
export const TEXT_GAP: Nm = mmToNm(0.5)
/** The fab-layer `${REFERENCE}` is sized to fit three characters in the body. */
export const FAB_REFERENCE_MIN: Nm = mmToNm(0.25)
export const FAB_REFERENCE_MAX: Nm = mmToNm(1)
export const FAB_REFERENCE_CHARACTERS = 3
/** Thickness as a fraction of height, KLC's 0.15 on 1.0. */
export const TEXT_THICKNESS_RATIO = 0.15

export const ROUNDRECT_RATIO = 0.25
export const ROUNDRECT_MAX_RADIUS: Nm = mmToNm(0.25)

export const DEFAULT_PAD_LAYERS: Record<'smd' | 'thru_hole' | 'np_thru_hole', string[]> = {
  smd: ['F.Cu', 'F.Paste', 'F.Mask'],
  thru_hole: ['*.Cu', '*.Mask'],
  np_thru_hole: ['*.Cu', '*.Mask']
}

/** The IPC-7351 density levels (`landPattern.ts`), and the project's choice of one. */
export type FootprintDensity = 'least' | 'nominal' | 'most'
export type Pin1MarkerKind = 'chevron' | 'dot' | 'line'

/** The project's say over a generated footprint: exactly two choices. */
export interface FootprintStyleChoices {
  density: FootprintDensity
  pin1Marker: Pin1MarkerKind
  /** Where the choices came from, echoed in every answer. */
  source: 'board-intent' | 'default'
}

export const DEFAULT_STYLE_CHOICES: FootprintStyleChoices = {
  density: 'nominal',
  pin1Marker: 'chevron',
  source: 'default'
}

/** The roundrect ratio for a pad: 0.25, with the radius capped at 0.25 mm. */
export const roundrectRatio = (width: Nm, height: Nm): number => {
  const shorter = Math.min(width, height)
  if (shorter <= 0) return ROUNDRECT_RATIO
  const ratio = Math.min(ROUNDRECT_RATIO, ROUNDRECT_MAX_RADIUS / shorter)
  // KiCad writes six decimals (0.208333 on a 1.2 mm pad).
  return Math.round(ratio * 1e6) / 1e6
}
