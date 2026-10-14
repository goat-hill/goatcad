/**
 * Fab CPL / pick-and-place rows (fabrication-export-workstream.md).
 *
 * Sourced from the **board footprints** — the same board the Gerbers, drill, and
 * BOM come from (see fabBom.ts for why: a fab package must describe the board
 * being made). Each placed footprint becomes one placement row: its designator,
 * centroid (the footprint origin, KiCad's own placement point), rotation, and
 * side.
 *
 * `positionsMatrix` emits the columns a `PositionFormat` names. Coordinates
 * are y-up (KiCad's position-file convention, matching the Gerbers), in mm or
 * mil.
 *
 * KNOWN LIMITATION (alpha, §5d): we emit **standard KiCad centroids and
 * rotations**. JLCPCB's per-footprint rotation conventions differ, and bottom-
 * side X mirroring varies by house; automatic remap tables are M2+. The CPL
 * preview surfaces a one-line note so this is never a silent surprise.
 */
import type { KicadBoardFootprint } from './kicad/board'
import type { PositionField, PositionFormat } from './exportProfiles'
import { mmToSpacing, nmToMm } from './kicad/coordinates'
// R10 after R2, and a reference designator's case never splits the rows.
import { compareNames } from './nameOrder'

export type CplSide = 'top' | 'bottom'

export interface CplComponent {
  reference: string
  value: string
  /** Board footprint identity (`Library:Footprint`), library prefix kept. */
  footprint: string
  /** Centroid in raw KiCad board mm (x right, y **down**). */
  x: number
  y: number
  /** Placement rotation in degrees, KiCad convention. */
  rotation: number
  side: CplSide
  flags: { dnp: boolean; excludeFromPos: boolean }
}

export interface CplOptions {
  units: 'mm' | 'mil'
  /** Both sides, or one. */
  side: 'both' | 'front' | 'back'
  /** Include Do-Not-Populate parts (off by default — they aren't placed). */
  includeDnp: boolean
}

/** The board's placed footprints as CPL components. */
export function boardCplComponents(footprints: readonly KicadBoardFootprint[]): CplComponent[] {
  const out: CplComponent[] = []
  for (const fp of footprints) {
    const reference = fp.reference ?? ''
    if (!reference) continue // graphic-only footprints (logos, fiducials w/o ref)
    const attrs = fp.footprint.attributes
    out.push({
      reference,
      value: fp.value ?? '',
      footprint: fp.libId,
      // CPL rows speak millimeters; the domain holds integer nanometers.
      x: nmToMm(fp.position.x),
      y: nmToMm(fp.position.y),
      rotation: fp.position.angle ?? 0,
      side: fp.layer === 'B.Cu' ? 'bottom' : 'top',
      flags: {
        dnp: attrs.includes('dnp'),
        // board_only footprints are graphics; exclude_from_pos_files is explicit.
        excludeFromPos: attrs.includes('exclude_from_pos_files') || attrs.includes('board_only')
      }
    })
  }
  return out
}

/** The components that belong in the CPL: exclusions out, side + DNP per option. */
export function componentsForCpl(components: CplComponent[], options: CplOptions): CplComponent[] {
  return components
    .filter((c) => !c.flags.excludeFromPos)
    .filter((c) => options.includeDnp || !c.flags.dnp)
    .filter(
      (c) => options.side === 'both' || c.side === (options.side === 'front' ? 'top' : 'bottom')
    )
    .sort((a, b) => compareNames(a.reference, b.reference))
}

/** Convert a millimeter value to the output units. */
const toUnits = mmToSpacing

/** Trim to a compact fixed-point string (4 dp mm, 2 dp mil). */
const coord = (v: number, units: 'mm' | 'mil'): string =>
  parseFloat(v.toFixed(units === 'mil' ? 2 : 4)).toString()

const footprintName = (libId: string): string => libId.slice(libId.indexOf(':') + 1)

const normalizeAngle = (deg: number): number => ((deg % 360) + 360) % 360

/** One CPL row per component (fabs list every placement — never grouped). */
export function buildCplRows(
  components: CplComponent[],
  options: CplOptions
): Array<Record<string, string>> {
  return componentsForCpl(components, options).map((c) => ({
    designator: c.reference,
    // y-up: KiCad's position files (and our Gerbers) put +Y up.
    midX: coord(toUnits(c.x, options.units), options.units),
    midY: coord(toUnits(-c.y, options.units), options.units),
    value: c.value,
    footprint: footprintName(c.footprint),
    layer: c.side === 'bottom' ? 'Bottom' : 'Top',
    rotation: parseFloat(normalizeAngle(c.rotation).toFixed(2)).toString()
  }))
}

/** The columns a position file writes when its format names none: KiCad's own. */
export const DEFAULT_POSITION_COLUMNS: NonNullable<PositionFormat['columns']> = [
  { label: 'Ref', field: 'reference' },
  { label: 'Val', field: 'value' },
  { label: 'Package', field: 'footprint' },
  { label: 'PosX', field: 'x' },
  { label: 'PosY', field: 'y' },
  { label: 'Rot', field: 'rotation' },
  { label: 'Side', field: 'side' }
]

const FIELD_KEYS: Record<PositionField, string> = {
  reference: 'designator',
  value: 'value',
  footprint: 'footprint',
  x: 'midX',
  y: 'midY',
  rotation: 'rotation',
  side: 'layer'
}

/** The position file as a header-first matrix of raw cells, ready for `serializeCsv`. */
export function positionsMatrix(components: CplComponent[], format: PositionFormat): string[][] {
  const columns = format.columns ?? DEFAULT_POSITION_COLUMNS
  const rows = buildCplRows(components, {
    units: format.units ?? 'mm',
    side: format.side ?? 'both',
    includeDnp: format.includeDnp ?? false
  })
  return [
    columns.map((column) => column.label),
    ...rows.map((row) => columns.map((column) => row[FIELD_KEYS[column.field]] ?? ''))
  ]
}
