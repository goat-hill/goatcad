/**
 * `workspace.attach` — act in an existing workspace from now on.
 */
import { callerOf } from '../context'
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceAttach = defineOp({
  name: 'workspace.attach',
  scope: 'app',
  mutates: false,
  summary: 'Attach this connection to a workspace; every later call acts in it.',
  guidance:
    'Take the id from workspace_list. Attaching again moves to the other workspace and closes your viewport. An agent started in a GoatCAD terminal tab is already attached to its workspace.',
  input: s.object({
    workspace: s.string().trim().describe('A workspace id from workspace_list.')
  }),
  examples: [{ args: { workspace: 'ws_3f2a01' }, note: 'work in this one' }],
  run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(service.attach(callerOf(ctx), args.workspace))
  }
})
