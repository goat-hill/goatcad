/** `export.positions` — the pick-and-place file: where each part sits, turned and sided. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { SAVED_BOARD, boardArg, directoryArg, positionsShape } from './formats'

export const exportPositions = defineDesignOp({
  name: 'export.positions',
  scope: 'board',
  mutates: false,
  summary: "Write the board's pick-and-place (position, CPL) file as a CSV.",
  guidance: `One row per placed part, at its footprint origin and rotation as KiCad's position file gives them; parts excluded from position files or board-only are left out. Rotations are KiCad's; a fab whose library turns a package differently corrects them in review. ${SAVED_BOARD}`,
  input: s.object({ board: boardArg, directory: directoryArg, ...positionsShape }),
  examples: [
    { args: {}, note: 'defaults: mm, both sides' },
    { args: { side: 'front', units: 'mil' }, note: 'the front only, in mil' }
  ],
  request: ({ board, directory, ...cpl }) => ({
    kind: 'export-board',
    output: 'cpl',
    ...(board ? { board } : {}),
    ...(directory ? { directory } : {}),
    cpl
  })
})
