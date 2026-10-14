/**
 * `project.create` — a new project in a folder, as the New Project dialog
 * makes one: the project file, a root sheet and a board, or a project around
 * a schematic already there. Design: `docs/agent-api.md`.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectCreate = defineDesignOp({
  name: 'project.create',
  scope: 'app',
  mutates: true,
  summary:
    'Create a KiCad project in a folder: project file, root sheet and board, optionally with stackup and profile.',
  guidance:
    "A folder that already holds a project is refused with its name; one holding schematics needs adopt or blank: true. copperLayers and profile set the board's stackup, rules and Default class as Board Setup would; change them later with board_update_setup. Files are written to disk at once, with no undo. The project becomes the workspace's when the folder is the workspace's own or it has none; for a new folder, start a workspace on it first (workspace_start with root).",
  input: s.object({
    name: s
      .string()
      .trim()
      .describe('Project name: the file stem of its .kicad_pro, sheet and board.'),
    folder: s
      .string()
      .trim()
      .describe("Absolute folder path. Default: the workspace's folder.")
      .optional(),
    adopt: s
      .string()
      .trim()
      .describe('Schematic already in the folder to use as the root sheet.')
      .optional(),
    blank: s
      .boolean()
      .describe('Create a new root sheet although the folder holds other schematics.')
      .optional(),
    copperLayers: s
      .integer()
      .min(2)
      .max(32)
      .describe('Copper layer count for the new board: 2, 4, …')
      .optional(),
    profile: s
      .string()
      .trim()
      .describe('Manufacturing profile id, e.g. "jlcpcb-4l-1.6"; board_get_setup lists them.')
      .optional()
  }),
  examples: [
    { args: { name: 'canary' }, note: 'blank 2-layer project, open folder' },
    {
      args: { name: 'canary', profile: 'jlcpcb-4l-1.6' },
      note: '4-layer JLCPCB board'
    }
  ],
  request: (args) => ({
    kind: 'create-project',
    name: args.name,
    ...(args.folder ? { folder: args.folder } : {}),
    ...(args.adopt ? { adopt: args.adopt } : {}),
    ...(args.blank ? { blank: true } : {}),
    ...(args.copperLayers !== undefined ? { copperLayers: args.copperLayers } : {}),
    ...(args.profile ? { profile: args.profile } : {})
  })
})
