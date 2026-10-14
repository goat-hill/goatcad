import type { BoardDesignSettings } from '../kicad/project'

/**
 * KiCad's compiled-in rules (`board_design_settings.h`), for a board with no
 * project: what `kicad-cli` runs with, which is not what a new GoatCAD board
 * gets (`DEFAULT_DESIGN_RULES` is a fab's floor, not KiCad's).
 */
export const KICAD_DEFAULTS: BoardDesignSettings['rules'] = {
  minClearance: 0,
  minTrackWidth: 0.2,
  minConnectionWidth: 0,
  minViaAnnularWidth: 0.1,
  minViaDiameter: 0.5,
  minCopperHoleClearance: 0.25,
  minCopperEdgeClearance: 0.5,
  minThroughHoleDiameter: 0.3,
  minHoleToHole: 0.25,
  minMicroviaDiameter: 0.2,
  minMicroviaDrill: 0.1,
  minSilkClearance: 0,
  minTextHeight: 0.8,
  minTextThickness: 0.08,
  maxError: 0.005,
  zonesAllowExternalFillets: false,
  minResolvedSpokes: 2,
  useHeightForLengthCalcs: true
}
