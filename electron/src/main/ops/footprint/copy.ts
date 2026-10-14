/**
 * `footprint.copy` — a standard footprint, copied into the project's
 * own library unchanged.
 *
 * It exists for one job
 * an agent cannot otherwise do: the standard libraries are read-only, so a
 * footprint that needs a 3D model attached needs a project copy — and
 * `footprint_create` would redraw it, restyling silk, courtyard and
 * texts to the house style. That changes the land pattern in order to add a
 * model, which is the opposite of what was asked for.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'

export const footprintCopy = defineDesignOp({
  name: 'footprint.copy',
  scope: 'project',
  mutates: true,
  summary:
    "Copy a footprint unchanged into the project's own footprint library, to edit it or attach a model.",
  guidance:
    'Standard and global libraries are read-only; this makes an editable copy, unchanged. For a different land pattern use footprint_create. The copy is a new id: point parts at it with bom_update on Footprint. Writes the .kicad_mod file and opens it as a tab behind.',
  input: s.object({
    footprint: s.string().trim().describe('Source footprint id "Nickname:Name".'),
    name: s
      .string()
      .trim()
      .describe("Name for the copy. Defaults to the source's name.")
      .optional(),
    library: s
      .string()
      .trim()
      .describe("Footprint library (.pretty) stem. Defaults to the project's own name.")
      .optional()
  }),
  examples: [
    {
      args: { footprint: 'Package_TO_SOT_SMD:SOT-23-5' },
      note: 'a copy to attach a model to'
    }
  ],
  request(args) {
    if (!args.footprint.includes(':')) {
      return refused(
        `"${args.footprint}" is not a library id.`,
        'Pass "Nickname:Name" as footprint_search reports it.'
      )
    }
    return {
      kind: 'copy-footprint',
      libId: args.footprint,
      ...(args.name ? { name: args.name } : {}),
      ...(args.library ? { library: args.library } : {})
    }
  }
})
