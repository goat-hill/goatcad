/**
 * `project.open` — a project file as a tab, any kind.
 *
 * The schematic verbs open
 * their sheet implicitly; this makes opening a verb of its own, so an agent
 * can put a board, a library or a text file in front of the user — and in
 * front of the verbs that need it mounted — before acting on it. Only files
 * the project tree lists can be opened, which is what keeps a made-up path
 * from opening anything.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectOpen = defineDesignOp({
  name: 'project.open',
  scope: 'project',
  mutates: false,
  summary: 'Open a project file (schematic, board, library or text) as the active tab.',
  guidance:
    'Only files in the project tree open; a file name matching several files is refused with the candidates. The tab comes to the front; an open file is just activated. Nothing is edited.',
  input: s.object({
    file: s
      .string()
      .trim()
      .describe('Absolute path or bare file name, e.g. "phoneamenal.kicad_pcb".')
  }),
  examples: [{ args: { file: 'phoneamenal.kicad_pcb' }, note: 'bring the board to the front' }],
  request: (args) => ({ kind: 'open-file', file: args.file })
})
