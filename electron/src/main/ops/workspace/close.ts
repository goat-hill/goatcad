/**
 * `workspace.close` — end a workspace and its windows.
 */
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceClose = defineOp({
  name: 'workspace.close',
  scope: 'project',
  mutates: true,
  summary: 'Close a workspace and every window of it.',
  guidance:
    'Refused while it has unsaved edits: save them with workspace_save, or pass discard: true and tell the user they were dropped. Connections attached to it are detached.',
  input: s.object({
    workspace: s.string().trim().describe('A workspace id from workspace_list.'),
    discard: s
      .boolean()
      .describe('Close even with unsaved edits, losing them. Default false.')
      .optional()
  }),
  examples: [{ args: { workspace: 'ws_3f2a01' }, note: 'done with a background project' }],
  async run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(await service.close(args.workspace, args.discard === true))
  }
})
