/** `export.drill` — the board's Excellon drill files. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { SAVED_BOARD, boardArg, directoryArg, drillShape } from './formats'

export const exportDrill = defineDesignOp({
  name: 'export.drill',
  scope: 'board',
  mutates: false,
  summary: "Write the board's Excellon drill files to a folder.",
  guidance: `Every pad and via hole; Excellon, metric, decimal, absolute, slots as G85. ${SAVED_BOARD}`,
  input: s.object({ board: boardArg, directory: directoryArg, ...drillShape }),
  examples: [
    { args: {}, note: 'board-PTH.drl and board-NPTH.drl' },
    { args: { separatePlated: false }, note: 'one board.drl' }
  ],
  request: ({ board, directory, ...drill }) => ({
    kind: 'export-board',
    output: 'drill',
    ...(board ? { board } : {}),
    ...(directory ? { directory } : {}),
    drill
  })
})
