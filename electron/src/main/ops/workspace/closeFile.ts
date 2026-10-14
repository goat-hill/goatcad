/**
 * `workspace.close_file` — close an open document and its tab. A tab with
 * unsaved edits is work the user can still undo, and closing it is the one way
 * to lose that without a save, so it is refused unless `discard` is passed.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const workspaceCloseFile = defineDesignOp({
  name: 'workspace.close_file',
  scope: 'project',
  mutates: true,
  summary: 'Close an open document of the workspace, and its tab.',
  guidance:
    'Unsaved edits are refused: save them with workspace_save, or pass discard: true and tell the user the edits were dropped. Close and reopen a file to re-read it after something else changed it on disk.',
  input: s.object({
    file: s
      .string()
      .trim()
      .describe('Absolute path, or file name with its extension, of an open document.'),
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
