/**
 * Export profiles: what a fab takes, as the writers' own arguments
 * (fabrication-export-workstream.md, "The export ops"). A profile is data over
 * `lib/fabExport.ts`, never a second exporter, so the formats it names are the
 * ones the writers implement and a fab is added by writing a profile.
 *
 * Every setting a built-in profile makes is held to the fab's own published
 * page, named in `sources`; what no page confirms is left at the writer's
 * default and listed under `todo`.
 */

import type {
  BomColumnSpec,
  BomFormat,
  DrillFormat,
  FabOutput,
  GerberFormat,
  GerberNaming,
  PartNumberKind,
  PositionField,
  PositionFormat
} from '../../../preload/fabTypes'

export type {
  BomColumnSpec,
  BomFormat,
  DrillFormat,
  FabOutput,
  GerberFormat,
  GerberNaming,
  PartNumberKind,
  PositionField,
  PositionFormat
}

export const ALL_OUTPUTS: readonly FabOutput[] = ['gerber', 'drill', 'bom', 'cpl']

export interface ExportProfile {
  id: string
  /** Fab name, matching the manufacturing-profile vendor where both exist. */
  vendor: string
  /** True for the shipped read-only set; false once a user forks one. */
  builtIn: boolean
  /** Set when this profile was derived from a built-in by editing. */
  derivedFrom?: string
  /** The outputs this fab takes, each with the writer's arguments; absent means not made. */
  outputs: {
    gerber?: GerberFormat
    drill?: DrillFormat
    bom?: BomFormat
    cpl?: PositionFormat
  }
  /** The outputs zipped together for upload; the rest are written beside the zip. */
  archive: FabOutput[]
  /** The published pages each setting is held to. */
  sources: string[]
  /** What no source confirms yet: left at the writer's defaults until one does. */
  todo: string[]
}

const JLCPCB_GERBERS =
  'https://jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-kicad-9'
const JLCPCB_BOM_CPL =
  'https://jlcpcb.com/help/article/how-to-generate-the-bom-and-centroid-file-from-kicad'
const JLCPCB_CPL = 'https://jlcpcb.com/help/article/pick-place-file-for-pcb-assembly'

const JLCPCB: ExportProfile = {
  id: 'jlcpcb',
  vendor: 'JLCPCB',
  builtIn: true,
  outputs: {
    gerber: { naming: 'protel', precision: 6 },
    drill: { separatePlated: true },
    bom: {
      columns: [
        { label: 'Comment', field: 'Value' },
        { label: 'Designator', field: 'Reference' },
        { label: 'Footprint', field: 'Footprint' },
        { label: 'JLCPCB Part #', partNumber: 'LCSC' }
      ],
      group: true
    },
    cpl: {
      columns: [
        { label: 'Designator', field: 'reference' },
        { label: 'Mid X', field: 'x' },
        { label: 'Mid Y', field: 'y' },
        { label: 'Layer', field: 'side' },
        { label: 'Rotation', field: 'rotation' }
      ],
      units: 'mm',
      side: 'both'
    }
  },
  // The Gerbers and both drill files in one archive; the BOM and CPL go to their own upload slots.
  archive: ['gerber', 'drill'],
  sources: [JLCPCB_GERBERS, JLCPCB_BOM_CPL, JLCPCB_CPL],
  todo: [
    'Netlist attributes (TO.N) in the Gerbers, which the Gerber guide enables for its DFM checks: the writer does not emit them yet.',
    "Per-part rotation offsets between KiCad's footprints and JLCPCB's library."
  ]
}

const OSHPARK_KICAD = 'https://docs.oshpark.com/design-tools/kicad/generating-kicad-gerbers/'
const OSHPARK_NAMING = 'https://docs.oshpark.com/troubleshooting/naming-pattern/'
const OSHPARK_DRILLS = 'https://docs.oshpark.com/submitting-orders/drill-specs/'

// Bare boards only: OSH Park does not assemble, so no BOM or CPL.
const OSHPARK: ExportProfile = {
  id: 'oshpark',
  vendor: 'OSH Park',
  builtIn: true,
  outputs: {
    // KiCad's names and X2 attributes, as its KiCad guide plots them; the writer
    // always emits X2, and slots as G85, the guide's alternate drill mode.
    gerber: { naming: 'kicad' },
    drill: {}
  },
  archive: ['gerber', 'drill'],
  sources: [OSHPARK_KICAD, OSHPARK_NAMING, OSHPARK_DRILLS],
  todo: [
    "Whether plated and non-plated holes may come as KiCad's two drill files: no page says, so they stay split.",
    'The .kicad_pcb itself, which the KiCad guide calls the best way to order: the package has no output for it.'
  ]
}

// House-agnostic: the writers' defaults, which follow KiCad's own plot and position-file defaults.
const GENERIC: ExportProfile = {
  id: 'generic',
  vendor: 'Generic',
  builtIn: true,
  outputs: { gerber: {}, drill: {}, bom: {}, cpl: {} },
  archive: ['gerber', 'drill'],
  sources: [],
  todo: []
}

/** The read-only set shipped with the app; the default is first. */
export const BUILT_IN_EXPORT_PROFILES: readonly ExportProfile[] = [JLCPCB, OSHPARK, GENERIC]

export const DEFAULT_EXPORT_PROFILE_ID = JLCPCB.id

export const findExportProfile = (id: string): ExportProfile | null =>
  BUILT_IN_EXPORT_PROFILES.find((p) => p.id === id) ?? null

export const hasOutput = (profile: ExportProfile, output: FabOutput): boolean =>
  profile.outputs[output] !== undefined

/** The outputs a profile makes, in package order. */
export const profileOutputs = (profile: ExportProfile): FabOutput[] =>
  ALL_OUTPUTS.filter((output) => hasOutput(profile, output))

/** The part-number family a profile's BOM reads, or null when it writes no BOM or no such column. */
export function bomPartNumber(profile: ExportProfile): PartNumberKind | null {
  const columns = profile.outputs.bom?.columns
  if (!profile.outputs.bom) return null
  if (!columns) return 'MPN'
  for (const column of columns) if ('partNumber' in column) return column.partNumber
  return null
}

/**
 * The export profile to pre-select for a board set up for `vendor`, keeping
 * Board Setup and Manufacture coherent without coupling them. Falls back to
 * the default, never to null, so the picker always has a selection.
 */
export const exportProfileForVendor = (vendor: string | null | undefined): ExportProfile =>
  (vendor ? BUILT_IN_EXPORT_PROFILES.find((p) => p.vendor === vendor) : null) ??
  findExportProfile(DEFAULT_EXPORT_PROFILE_ID)!

/**
 * Fork a profile into an edited copy. Editing a built-in never mutates it — the
 * user gets a derived profile they may keep or save (persistence is a later
 * slice, mirroring `manufacturingProfiles.deriveProfile`).
 */
export function deriveExportProfile(
  base: ExportProfile,
  changes: Partial<Omit<ExportProfile, 'id' | 'builtIn' | 'derivedFrom'>>
): ExportProfile {
  return {
    ...base,
    ...changes,
    id: `${base.id}+edited`,
    builtIn: false,
    derivedFrom: base.derivedFrom ?? base.id
  }
}
