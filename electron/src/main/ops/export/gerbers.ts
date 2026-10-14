/**
 * `export.gerbers` — the board's Gerber files, in the format asked for.
 *
 * A writer, not a fab: its arguments describe the files and name no
 * manufacturer (fabrication-export-workstream.md, "The export ops").
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { SAVED_BOARD, boardArg, directoryArg, gerberFormat, gerberShape } from './formats'

export const exportGerbers = defineDesignOp({
  name: 'export.gerbers',
  scope: 'board',
  mutates: false,
  summary: "Write the board's Gerber files (RS-274X with X2 attributes) to a folder.",
  guidance: `One file per layer, plotted as the Manufacture tab plots them. For a fab's full upload, use export_package. ${SAVED_BOARD}`,
  input: s.object({ board: boardArg, directory: directoryArg, ...gerberShape }),
  examples: [
    { args: {}, note: 'standard layers into fab/' },
    { args: { naming: 'protel', directory: 'out/gerbers' }, note: 'Protel extensions' }
  ],
  request: ({ board, directory, ...gerber }) => ({
    kind: 'export-board',
    output: 'gerber',
    ...(board ? { board } : {}),
    ...(directory ? { directory } : {}),
    gerber: gerberFormat(gerber)
  })
})
