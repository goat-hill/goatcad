/**
 * A zone as an agent reads it, one shape wherever the zone lives: a board's
 * own (`boardItems.ts`), a footprint's on its board, or a footprint's in its
 * library file (`footprint/footprintItems.ts`). Millimeters in the frame of
 * the file it came from, y down.
 */
import type { KicadBoardZone, ZoneUpdate } from '../kicad/board'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { ISLAND_MODES, KEEPOUT_RULES } from '../../../../shared/itemRecords'

export { ISLAND_MODES, KEEPOUT_RULES }

/** Integer nm to mm, as every agent record reads a length. */
export const mm = (value: number): number => nmToMm(Math.round(value) as Nm)
const mmXY = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: mm(p.x),
  y: mm(p.y)
})

/** The smallest island kept under "below_area" when none is given, mm²: KiCad's, and the GUI's. */
const DEFAULT_MIN_ISLAND_AREA = 10

const islandsOf = (zone: KicadBoardZone): string =>
  ISLAND_MODES[zone.islandRemovalMode ?? 0] ?? 'remove'

/**
 * The island keys of a record as the zone writer takes them: the mode, and
 * the minimum area (mm²) once the zone removes islands below one.
 */
export const islandsUpdate = (
  zone: KicadBoardZone | null,
  islands: unknown,
  minIslandArea: unknown
): Pick<ZoneUpdate, 'islandRemovalMode' | 'minIslandArea'> => {
  const mode =
    islands === undefined
      ? (zone?.islandRemovalMode ?? 0)
      : ISLAND_MODES.indexOf(islands as (typeof ISLAND_MODES)[number])
  return {
    ...(islands !== undefined ? { islandRemovalMode: mode === 0 ? null : mode } : {}),
    ...(typeof minIslandArea === 'number'
      ? { minIslandArea }
      : islands !== undefined && mode === 2 && zone?.minIslandArea === undefined
        ? { minIslandArea: DEFAULT_MIN_ISLAND_AREA }
        : {})
  }
}

/** What a query row carries beyond id, kind and box. */
export const zoneRowFields = (zone: KicadBoardZone, net: string): Record<string, unknown> => ({
  net,
  layers: zone.layers,
  ...(zone.name ? { name: zone.name } : {}),
  ...(zone.priority ? { priority: zone.priority } : {}),
  ...(zone.isKeepout ? { keepout: true } : {})
})

/** What a full record adds to the row: the outline, and the rules or the pour settings. */
export const zoneRecordFields = (zone: KicadBoardZone): Record<string, unknown> => {
  const filled = [...new Set(zone.filledPolys.map((poly) => poly.layer ?? zone.layers[0]))]
  return {
    points: zone.points.map(mmXY),
    ...(zone.holes?.length ? { holes: zone.holes.map((hole) => hole.map(mmXY)) } : {}),
    priority: zone.priority ?? 0,
    ...(zone.isKeepout
      ? {
          rules: Object.fromEntries(
            KEEPOUT_RULES.map((rule) => [
              rule,
              zone.keepoutRules?.[rule] === false ? 'not_allowed' : 'allowed'
            ])
          )
        }
      : {
          padConnection: zone.padConnection ?? 'thermal',
          padClearance: mm(zone.padClearance ?? mmToNm(0.5)),
          minThickness: mm(zone.minThickness ?? mmToNm(0.25)),
          thermalGap: mm(zone.thermalGap ?? mmToNm(0.5)),
          thermalBridgeWidth: mm(zone.thermalBridgeWidth ?? mmToNm(0.5)),
          islands: islandsOf(zone),
          ...(zone.islandRemovalMode === 2
            ? { minIslandArea: zone.minIslandArea ?? DEFAULT_MIN_ISLAND_AREA }
            : {}),
          filled
        })
  }
}
