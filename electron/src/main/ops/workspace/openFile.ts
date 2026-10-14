/**
 * `workspace.open_file` — a file of the workspace as a tab, any kind. The
 * schematic and board verbs open their document behind the active tab on their
 * own; this makes opening a verb, so an agent can put a board, a library or a
 * text file in front of the user. Only files the workspace's tree lists open,
 * which keeps a made-up path from opening anything.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const workspaceOpenFile = defineDesignOp({
  name: 'workspace.open_file',
  scope: 'project',
  mutates: false,
  summary:
    "Open a file of the workspace (schematic, board, library or text) as its window's active tab.",
  guidance:
    "Only files in the workspace's folder open; a name matching several files is refused with the candidates. An open file is just brought to the front of its window. With several windows, pass window; a file open in another window is refused with that window's id. Nothing is edited.",
  input: s.object({
    file: s
      .string()
      .trim()
      .describe('Absolute path or bare file name, e.g. "phoneamenal.kicad_pcb".'),
    window: s.string().trim().describe('A window id from workspace_list.').optional()
  }),
  examples: [{ args: { file: 'phoneamenal.kicad_pcb' }, note: 'bring the board to the front' }],
  request: (args) => ({
    kind: 'open-file',
    file: args.file,
    ...(args.window ? { window: args.window } : {})
  })
})
