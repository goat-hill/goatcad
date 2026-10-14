/** `project.open` — the old name of `workspace.open_file`, kept for one release. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectOpen = defineDesignOp({
  name: 'project.open',
  scope: 'project',
  mutates: false,
  summary: 'Deprecated: use workspace_open_file, which this is.',
  input: s.object({
    file: s
      .string()
      .trim()
      .describe('Absolute path or bare file name, e.g. "phoneamenal.kicad_pcb".')
  }),
  examples: [{ args: { file: 'phoneamenal.kicad_pcb' }, note: 'bring the board to the front' }],
  request: (args) => ({ kind: 'open-file', file: args.file })
})
