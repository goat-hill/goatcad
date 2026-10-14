/**
 * `workspace.start` — a new workspace on a folder, a project, both or neither,
 * with one window or none.
 */
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceStart = defineOp({
  name: 'workspace.start',
  scope: 'app',
  mutates: false,
  summary: 'Start a workspace on a folder or project, in a new window or in the background.',
  guidance:
    "Answers its id: pass it as workspace to every later op whenever more than one workspace is open. root defaults to the project's folder. openWindow: false opens it with no window: documents, undo and checks work as in a window, and the user can open one on it later with all of it intact. One with no window closes when your client disconnects (it shows a window instead when it holds unsaved edits); close it yourself with workspace_close when done. A folder or project another workspace holds is refused with that workspace's id; work there by passing it. To make a new project, start on its folder, then call project_create.",
  input: s.object({
    root: s.string().trim().describe('Absolute folder path.').optional(),
    project: s.string().trim().describe('Absolute path of a .kicad_pro.').optional(),
    openWindow: s.boolean().describe('Show it to the user in a new window.')
  }),
  examples: [
    {
      args: { project: '/home/me/boards/canary/canary.kicad_pro', openWindow: false },
      note: 'a project, in the background'
    },
    { args: { root: '/home/me/boards/new', openWindow: true }, note: 'a folder, in a window' }
  ],
  async run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(
      await service.start(
        {
          ...(args.root ? { root: args.root } : {}),
          ...(args.project ? { project: args.project } : {}),
          openWindow: args.openWindow
        },
        ctx.connection
      )
    )
  }
})
