/**
 * `workspace.open_window` — a window on a workspace. On one with no window it
 * shows the background renderer, so its undo and unsaved edits come along.
 */
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceOpenWindow = defineOp({
  name: 'workspace.open_window',
  scope: 'project',
  mutates: false,
  summary: 'Open a window on a workspace, moving the named open files into it.',
  guidance:
    "Answers the window's id. On a workspace with no window, it shows the one it has, with its documents, undo and unsaved edits; files are then ignored. Otherwise a new window opens and each named file open in the workspace moves into it.",
  input: s.object({
    workspace: s.string().trim().describe('A workspace id from workspace_list.'),
    files: s
      .array(s.string().trim())
      .describe('Open files to move into the new window, as absolute paths.')
      .optional()
  }),
  examples: [{ args: { workspace: 'ws_3f2a01' }, note: 'show a background workspace to the user' }],
  async run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(await service.openWindow(args.workspace, args.files ?? []))
  }
})
