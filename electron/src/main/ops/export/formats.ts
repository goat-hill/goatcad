/**
 * The arguments the `export.*` ops share: the writers' formats, with the
 * vocabulary of `kicad-cli pcb export` where the two overlap
 * (fabrication-export-workstream.md, "The export ops"). The types they parse
 * to are `preload/fabTypes.d.ts`, which the renderer's writers take.
 */
import { s } from '../schema'
import { invalidArgs } from '../errors'
import type { OpFailure } from '../errors'
import type { BomColumnSpec, GerberFormat } from '../../../preload/fabTypes'
import { BOARD_FILE } from '../fileArgs'

export const boardArg = s
  .string()
  .trim()
  .describe(`${BOARD_FILE}; omit for the project's one board.`)
  .optional()

export const directoryArg = s
  .string()
  .trim()
  .min(1)
  .describe(
    "Output folder, absolute or relative to the board's folder; default fab beside the board. Same-named files are replaced."
  )
  .optional()

export const gerberShape = {
  layers: s
    .array(s.string().trim())
    .min(1)
    .describe(
      'KiCad layer names in package order, e.g. ["F.Cu", "B.Cu", "Edge.Cuts"]; default every copper, paste, silkscreen and mask layer and Edge.Cuts.'
    )
    .optional(),
  naming: s
    .enum(['kicad', 'protel'] as const)
    .describe(
      'File names. kicad (default): board-F_Cu.gbr; protel: board.GTL, board.GBL, board.G1 for In1.Cu.'
    )
    .optional(),
  precision: s
    .integer()
    .min(5)
    .max(6)
    .describe('Decimal digits of the 4.n mm coordinate format; default 6.')
    .optional(),
  jobFile: s
    .boolean()
    .describe('Write the .gbrjob job file; default on with kicad naming, off with protel.')
    .optional(),
  subtractMaskFromSilk: s
    .boolean()
    .describe('Remove silkscreen over solder-mask openings; default true.')
    .optional()
}

export const drillShape = {
  separatePlated: s
    .boolean()
    .describe(
      'Plated and non-plated holes in separate files (board-PTH.drl, board-NPTH.drl); default true. false writes one board.drl.'
    )
    .optional()
}

export const bomShape = {
  columns: s
    .array(
      s.object({
        label: s.string().describe('Column header, written as given.'),
        field: s
          .string()
          .trim()
          .min(1)
          .describe(
            'A footprint field name, case-insensitive (Value, Manufacturer, …), or Reference (designators, "C1,C2"), Quantity, or Footprint (name without library).'
          )
          .optional(),
        partNumber: s
          .enum(['MPN', 'LCSC'] as const)
          .describe(
            'Instead of field: a part number from any field name in its family (MPN: MPN, MFR#, Manufacturer Part Number, …; LCSC: LCSC, LCSC Part #, JLCPCB Part #, …), else the other family.'
          )
          .optional()
      })
    )
    .min(1)
    .describe(
      'Columns in order, each with field or partNumber; default Reference, Value, Footprint, Qty, MPN.'
    )
    .optional(),
  group: s
    .boolean()
    .describe(
      'One row per part identical in every column but Reference and Quantity; default true.'
    )
    .optional(),
  includeDnp: s.boolean().describe('List DNP parts; default false.').optional()
}

export const positionsShape = {
  columns: s
    .array(
      s.object({
        label: s.string().describe('Column header, written as given.'),
        field: s.enum(['reference', 'value', 'footprint', 'x', 'y', 'rotation', 'side'] as const)
      })
    )
    .min(1)
    .describe(
      "Columns in order; default KiCad's Ref, Val, Package, PosX, PosY, Rot, Side. x, y: part origin, y up; rotation: degrees counterclockwise; side: Top or Bottom."
    )
    .optional(),
  units: s
    .enum(['mm', 'mil'] as const)
    .describe('Default mm.')
    .optional(),
  side: s
    .enum(['front', 'back', 'both'] as const)
    .describe('Default both.')
    .optional(),
  includeDnp: s.boolean().describe('Include DNP parts; default false.').optional()
}

/** A BOM column names exactly one source; the schema cannot say so, so this does. */
export function bomColumns(
  columns: Array<{ label: string; field?: string; partNumber?: 'MPN' | 'LCSC' }> | undefined,
  path: string
): BomColumnSpec[] | OpFailure | undefined {
  if (!columns) return undefined
  const out: BomColumnSpec[] = []
  for (const [i, column] of columns.entries()) {
    if (!!column.field === !!column.partNumber)
      return invalidArgs(
        `Column ${i} (${column.label}) needs a field or a partNumber, not ${column.field ? 'both' : 'neither'}.`,
        `${path}/columns/${i}`,
        'Give each BOM column one of field or partNumber.'
      )
    out.push(
      column.field
        ? { label: column.label, field: column.field }
        : { label: column.label, partNumber: column.partNumber! }
    )
  }
  return out
}

export const isFailure = (value: unknown): value is OpFailure =>
  !!value && typeof value === 'object' && 'ok' in value

/** What every export's guidance says about the board it reads. */
export const SAVED_BOARD =
  "Writes from the board's saved file: refused while its tab has unsaved edits (workspace_save) or stale zone fills (board_refill, then workspace_save). The answer lists each file's path, size and summary, not its content."

/** The Gerber arguments as the writer takes them; the schema bounds precision to 5 or 6. */
export const gerberFormat = ({
  precision,
  ...rest
}: Omit<GerberFormat, 'precision'> & { precision?: number }): GerberFormat => ({
  ...rest,
  ...(precision === 5 || precision === 6 ? { precision } : {})
})
