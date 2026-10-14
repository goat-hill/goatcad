/** `project.save` — the old name of `workspace.save`, kept for one release. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectSave = defineDesignOp({
  name: 'project.save',
  scope: 'project',
  mutates: true,
  summary: 'Deprecated: use workspace_save, which this is.',
  input: s.object({
    files: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'Open tabs to save, as absolute paths or bare file names. Default: every tab with unsaved edits.'
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'save every dirty tab' },
    {
      args: { files: ['phoneamenal.kicad_sch'] },
      note: 'one sheet, before kicad-cli'
    }
  ],
  request: (args) => ({ kind: 'save-files', ...(args.files ? { files: args.files } : {}) })
})
