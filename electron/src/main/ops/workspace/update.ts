/**
 * `workspace.update` — change a workspace's folder or project.
 */
import { designAnswer } from '../design'
import { defineOp } from '../registry'
import { s } from '../schema'
import { isFailure, workspaceService } from './service'

export const workspaceUpdate = defineOp({
  name: 'workspace.update',
  scope: 'project',
  mutates: false,
  summary: "Set a workspace's folder or active project.",
  guidance:
    "Refused while the workspace has unsaved edits: save them with workspace_save first. A new folder closes the documents open in the old one; a new project in the same folder keeps them. root defaults to the project's folder. A folder or project another workspace holds is refused with its id.",
  input: s.object({
    workspace: s.string().trim().describe('A workspace id from workspace_list.'),
    root: s.string().trim().describe('Absolute folder path.').optional(),
    project: s.string().trim().describe('Absolute path of a .kicad_pro.').optional()
  }),
  examples: [
    {
      args: { workspace: 'ws_3f2a01', project: '/home/me/boards/canary/canary-v2.kicad_pro' },
      note: 'switch the active project'
    }
  ],
  async run(args, ctx) {
    const service = workspaceService(ctx)
    if (isFailure(service)) return service
    return designAnswer(
      await service.update({
        workspace: args.workspace,
        ...(args.root ? { root: args.root } : {}),
        ...(args.project ? { project: args.project } : {})
      })
    )
  }
})
