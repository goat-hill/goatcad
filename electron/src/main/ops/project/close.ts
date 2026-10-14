/** `project.close` — the old name of `workspace.close_file`, kept for one release. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectClose = defineDesignOp({
  name: 'project.close',
  scope: 'project',
  mutates: true,
  summary: 'Deprecated: use workspace_close_file, which this is.',
  input: s.object({
    file: s
      .string()
      .trim()
      .describe('Absolute path, or file name with its extension, of an open tab.'),
    discard: s
      .boolean()
      .describe('Close even with unsaved edits, losing them. Default false.')
      .optional()
  }),
  examples: [{ args: { file: 'phoneamenal.kicad_sch' }, note: 'close a clean tab' }],
  request: (args) => ({
    kind: 'close-file',
    file: args.file,
    ...(args.discard === true ? { discard: true } : {})
  })
})
