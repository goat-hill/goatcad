/**
 * `workspace.close_window` — close one window; the last one closes its workspace.
 */
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceCloseWindow = defineOp({
  name: 'workspace.close_window',
  scope: 'project',
  mutates: true,
  summary: 'Close one window of a workspace; closing its last window closes the workspace.',
  guidance:
    'Refused while the window holds unsaved edits: save them with workspace_save, or pass discard: true and tell the user. workspaceClosed says whether the workspace went with it.',
  input: s.object({
    window: s.string().trim().describe('A window id from workspace_list.'),
    discard: s
      .boolean()
      .describe('Close even with unsaved edits, losing them. Default false.')
      .optional()
  }),
  examples: [{ args: { window: 'win_7c0105' }, note: 'close one of two windows' }],
  async run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(await service.closeWindow(args.window, args.discard === true))
  }
})
