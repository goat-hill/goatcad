/** `workspace.list` — what the person and the agents have open (`main/workspaces.ts`). */
import { succeed } from '../errors'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceList = defineOp({
  name: 'workspace.list',
  scope: 'app',
  mutates: false,
  summary: 'List the open workspaces: folder, project, windows with their files, and connections.',
  guidance:
    'With one workspace open every op acts in it; with several, pass workspace (an id from here) to every op, or it is refused workspace-required. Start your own with workspace_start rather than working in one the user has open, unless asked to. A workspace with windows: [] is open in the background, with no window.',
  input: s.object({}),
  run(_args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    const workspaces = service.list()
    return succeed({ workspaces, count: workspaces.length })
  }
})
