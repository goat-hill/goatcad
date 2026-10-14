/**
 * Fab BOM rows (fabrication-export-workstream.md).
 *
 * Sourced from the **board footprints**, not the schematic — deliberately. A fab
 * package (Gerbers, drill, CPL, BOM) must describe *the board being made*. If a
 * user updates the schematic but hasn't pushed it to the board, "manufacture" of
 * that board should ship the board's current parts, not the newer schematic's;
 * sourcing every output from the one `.kicad_pcb` keeps the package internally
 * consistent and honors an intentional older-board fabrication. The board
 * footprint carries the synced fields (Value, custom MPN/LCSC) and the
 * `exclude_from_bom` / `dnp` attributes, so it has everything a BOM needs.
 *
 * `bomMatrix` turns components into the rows of the columns a `BomFormat`
 * names, grouped by identical part and honoring exclude-from-BOM and DNP. KiCad
 * names a part-number field inconsistently, so a part-number column resolves it
 * through an alias list — MPN is the canonical field, LCSC a marketplace alias.
 */
import type { KicadBoardFootprint } from './kicad/board'
import type { BomColumnSpec, BomFormat, PartNumberKind } from './exportProfiles'

export type { PartNumberKind }

// Case-insensitive; first non-empty match wins.
const LCSC_ALIASES = ['LCSC', 'LCSC Part', 'LCSC Part #', 'LCSC#', 'JLCPCB Part #']
const MPN_ALIASES = [
  'MPN',
  'MFR#',
  'MFR. #',
  'MFN',
  'Manufacturer Part Number',
  'Mfr Part #',
  'Part Number',
  'PartNumber'
]

const findField = (fields: Record<string, string>, aliases: readonly string[]): string => {
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]))
  for (const alias of aliases) {
    const value = lower.get(alias.toLowerCase())
    if (value && value.trim()) return value.trim()
  }
  return ''
}

/** The part number for a component, trying the fab's preferred kind then the other. */
export function resolvePartNumber(fields: Record<string, string>, kind: PartNumberKind): string {
  return kind === 'LCSC'
    ? findField(fields, LCSC_ALIASES) || findField(fields, MPN_ALIASES)
    : findField(fields, MPN_ALIASES) || findField(fields, LCSC_ALIASES)
}

/** Minimal component shape a BOM needs — one row's reference, fields, and flags. */
export interface FabBomComponent {
  reference: string
  fields: Record<string, string>
  flags: { dnp: boolean; excludeFromBom: boolean }
}

/**
 * The board's placed footprints as BOM components. Footprint identity is the
 * board's own `libId` (what will actually be assembled), and the exclude/DNP
 * flags come from the footprint's `(attr …)` — the same board this package's
 * Gerbers and CPL come from.
 */
export function boardBomComponents(footprints: readonly KicadBoardFootprint[]): FabBomComponent[] {
  return footprints.map((fp) => {
    const fields: Record<string, string> = {}
    for (const property of fp.footprint.properties) fields[property.key] = property.value
    // The Footprint column is the board's real footprint, not a stale field copy.
    fields.Footprint = fp.libId
    if (fp.value && !fields.Value) fields.Value = fp.value
    const attrs = fp.footprint.attributes
    return {
      reference: fp.reference ?? fields.Reference ?? '',
      fields,
      flags: {
        dnp: attrs.includes('dnp'),
        excludeFromBom: attrs.includes('exclude_from_bom')
      }
    }
  })
}

/** Strip the library prefix from a `Library:Footprint` value. */
const footprintName = (footprint: string): string => {
  const colon = footprint.indexOf(':')
  return colon >= 0 ? footprint.slice(colon + 1) : footprint
}

const byRef = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** The components that belong in the BOM: exclude-from-BOM out, DNP per option. */
export function componentsForBom(
  components: FabBomComponent[],
  includeDnp: boolean
): FabBomComponent[] {
  return components.filter(
    (c) => !c.flags.excludeFromBom && (includeDnp || !c.flags.dnp) && !!c.reference
  )
}

/** References of DNP (do-not-populate) parts that are otherwise in the BOM, sorted. */
export function dnpReferences(components: FabBomComponent[]): string[] {
  return components
    .filter((c) => c.flags.dnp && !c.flags.excludeFromBom && !!c.reference)
    .map((c) => c.reference)
    .sort((a, b) => byRef.compare(a, b))
}

/** The columns a BOM writes when its format names none: KiCad's BOM fields and an MPN. */
export const DEFAULT_BOM_COLUMNS: readonly BomColumnSpec[] = [
  { label: 'Reference', field: 'Reference' },
  { label: 'Value', field: 'Value' },
  { label: 'Footprint', field: 'Footprint' },
  { label: 'Qty', field: 'Quantity' },
  { label: 'MPN', partNumber: 'MPN' }
]

/** A component's text for one column; `Reference` and `Quantity` are the row's, filled after grouping. */
const cellOf = (c: FabBomComponent, column: BomColumnSpec): string => {
  if ('partNumber' in column) return resolvePartNumber(c.fields, column.partNumber)
  const field = column.field.toLowerCase()
  if (field === 'reference') return c.reference
  if (field === 'quantity') return '1'
  if (field === 'footprint') return footprintName(c.fields.Footprint ?? '')
  return findField(c.fields, [column.field])
}

const isRowField = (column: BomColumnSpec): boolean =>
  'field' in column && ['reference', 'quantity'].includes(column.field.toLowerCase())

/**
 * The BOM as a header-first matrix of raw cells, ready for `serializeCsv`.
 * Grouped, parts identical in every column but Reference and Quantity share a
 * row, their designators joined without spaces ("C1,C2,C3", as fabs expect).
 */
export function bomMatrix(components: FabBomComponent[], format: BomFormat): string[][] {
  const columns = format.columns ?? DEFAULT_BOM_COLUMNS
  const usable = componentsForBom(components, format.includeDnp ?? false)
  const groups = new Map<string, { refs: string[]; cells: string[] }>()
  for (const c of usable) {
    const cells = columns.map((column) => cellOf(c, column))
    const key =
      format.group === false
        ? c.reference
        : JSON.stringify(cells.filter((_, i) => !isRowField(columns[i])))
    const known = groups.get(key)
    if (known) known.refs.push(c.reference)
    else groups.set(key, { refs: [c.reference], cells })
  }
  const rows = [...groups.values()].map(({ refs, cells }) => {
    refs.sort((a, b) => byRef.compare(a, b))
    return {
      first: refs[0],
      cells: columns.map((column, i) => {
        if (!('field' in column)) return cells[i]
        const field = column.field.toLowerCase()
        if (field === 'reference') return refs.join(',')
        if (field === 'quantity') return String(refs.length)
        return cells[i]
      })
    }
  })
  rows.sort((a, b) => byRef.compare(a.first, b.first))
  return [columns.map((column) => column.label), ...rows.map((row) => row.cells)]
}
