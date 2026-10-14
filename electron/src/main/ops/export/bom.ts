/**
 * `export.bom` — the board's bill of materials as a CSV with the columns asked
 * for. From the board's footprints, so it lists the parts that will be built.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { SAVED_BOARD, bomColumns, bomShape, boardArg, directoryArg, isFailure } from './formats'

export const exportBom = defineDesignOp({
  name: 'export.bom',
  scope: 'board',
  mutates: false,
  summary: "Write the board's BOM as a CSV, with the columns and headers you name.",
  guidance: `Reads the board's footprints (fields, DNP, exclude-from-BOM), not the schematic: run board_sync first if the schematic changed. bom_get reads and edits part data. ${SAVED_BOARD}`,
  input: s.object({ board: boardArg, directory: directoryArg, ...bomShape }),
  examples: [
    { args: {}, note: 'default columns' },
    {
      args: {
        columns: [
          { label: 'Comment', field: 'Value' },
          { label: 'Designator', field: 'Reference' },
          { label: 'Footprint', field: 'Footprint' },
          { label: 'JLCPCB Part #', partNumber: 'LCSC' }
        ]
      },
      note: "JLCPCB's columns"
    }
  ],
  request: ({ board, directory, columns, ...rest }) => {
    const parsed = bomColumns(columns, '')
    if (isFailure(parsed)) return parsed
    return {
      kind: 'export-board',
      output: 'bom',
      ...(board ? { board } : {}),
      ...(directory ? { directory } : {}),
      bom: { ...rest, ...(parsed ? { columns: parsed } : {}) }
    }
  }
})
