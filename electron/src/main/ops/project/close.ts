/**
 * `project.close` — close an open tab.
 *
 * The refusal is the point:
 * a tab with unsaved edits is work the user can still undo, and closing it is
 * the one way to lose that without a save. So it is refused unless `discard`
 * is passed, and the answer says whether edits were dropped.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectClose = defineDesignOp({
  name: 'project.close',
  scope: 'project',
  mutates: true,
  summary: 'Close an open tab.',
  guidance:
    'A tab with unsaved edits is refused: save it with project_save, or pass discard: true and tell the user the edits were dropped. Close and reopen a file to re-read it after something else changed it on disk.',
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
