/**
 * Fab export across the process boundary: the writers' format arguments, which
 * the `export.*` ops validate in main and the renderer's writers take
 * (`lib/fabExport.ts`, profiles in `lib/exportProfiles.ts`), and the package's
 * disk write (`fab:export`).
 */

/** The artifacts a fab package can contain. */
export type FabOutput = 'gerber' | 'drill' | 'bom' | 'cpl'

/** Gerber file names: KiCad's (`board-F_Cu.gbr`) or the Protel extension family (`board.GTL`). */
export type GerberNaming = 'kicad' | 'protel'

export interface GerberFormat {
  /** KiCad layer names to plot, in package order; omitted, the board's standard set. */
  layers?: string[]
  naming?: GerberNaming
  /** Decimal digits of the 4.n coordinate format: 6 (KiCad's default) or 5. */
  precision?: 5 | 6
  /** Write the `.gbrjob` job file. Defaults on for KiCad naming, as KiCad does. */
  jobFile?: boolean
  /** Remove silkscreen over solder-mask openings. Default true. */
  subtractMaskFromSilk?: boolean
}

export interface DrillFormat {
  /** Plated and non-plated holes in separate files (`-PTH.drl`, `-NPTH.drl`), as KiCad writes them by default. */
  separatePlated?: boolean
}

/**
 * The part-number family a column reads through its alias list
 * (`lib/fabBom.ts`): MPN is canonical, LCSC a JLCPCB alias family.
 */
export type PartNumberKind = 'LCSC' | 'MPN'

/**
 * One BOM column: a header and what fills it. `field` is a footprint field by
 * name, case-insensitive, or one of the derived `Reference` (the row's
 * designators), `Quantity` and `Footprint` (the footprint's name without its
 * library). `partNumber` reads a family through its aliases.
 */
export type BomColumnSpec =
  { label: string; field: string } | { label: string; partNumber: PartNumberKind }

export interface BomFormat {
  columns?: BomColumnSpec[]
  /** One row per identical part, its designators joined. Default true. */
  group?: boolean
  /** List Do-Not-Populate parts. Default false. */
  includeDnp?: boolean
}

export type PositionField = 'reference' | 'value' | 'footprint' | 'x' | 'y' | 'rotation' | 'side'

export interface PositionFormat {
  columns?: Array<{ label: string; field: PositionField }>
  units?: 'mm' | 'mil'
  side?: 'front' | 'back' | 'both'
  includeDnp?: boolean
}

export interface FabExportPayload {
  /** The folder every file lands in, created when missing. */
  directory: string
  /** Bare file names: main refuses a name with a path in it. */
  files: Array<{ name: string; content: string }>
  /** A zip of the named files, written beside them. */
  archive: { name: string; files: string[] } | null
}

export interface FabWrittenFile {
  path: string
  bytes: number
}

export interface FabExportResult {
  success: boolean
  directory?: string
  written?: FabWrittenFile[]
  archive?: FabWrittenFile
  /** What a person is shown: the zip when there is one, else the first file. */
  revealPath?: string
  error?: string
}
