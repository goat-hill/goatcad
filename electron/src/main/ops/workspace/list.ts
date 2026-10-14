/**
 * `workspace.list` — what the person has open, and which one this connection
 * acts in (`main/workspaces.ts`).
 */
import { callerOf } from '../context'
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
    'Every design op acts in the workspace this connection is attached to, and refuses no-workspace until there is one: attach one of these with workspace_attach, or start one with workspace_start. attached is the id this connection acts in. A workspace with windows: [] is open in the background, with no window.',
  input: s.object({}),
  run(_args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    const workspaces = service.list()
    return succeed({
      workspaces,
      count: workspaces.length,
      attached: service.attached(callerOf(ctx))?.id ?? null
    })
  }
})
