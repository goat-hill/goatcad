/**
 * `export.package` — a fab's upload, from a profile: the pre-flight, then the
 * writers the profile names, laid out and zipped as it says. The same function
 * as the Manufacture tab's Export (fabrication-export-workstream.md).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import {
  SAVED_BOARD,
  boardArg,
  bomColumns,
  bomShape,
  directoryArg,
  drillShape,
  gerberFormat,
  gerberShape,
  isFailure,
  positionsShape
} from './formats'

const OUTPUTS = ['gerber', 'drill', 'bom', 'cpl'] as const

export const exportPackage = defineDesignOp({
  name: 'export.package',
  scope: 'board',
  mutates: false,
  summary:
    "Write a fab's full upload from an export profile: Gerbers, drill, BOM and positions, zipped as the fab takes them.",
  guidance: `Read the profile with export_profiles first and tell the user its todo items. The Manufacture tab's pre-flight runs first: DRC, outline, zone fills, the fab's drill and hole-spacing limits, part numbers and values. Only a board with no closed outline is refused; other problems come back under findings. Run with dryRun to read the findings and file list first. gerber, drill, bom and cpl (positions) replace the profile's format for that output; with no profile they are the whole package. ${SAVED_BOARD}`,
  input: s.object({
    board: boardArg,
    directory: directoryArg,
    profile: s.string().trim().describe('Profile id from export_profiles, e.g. jlcpcb.').optional(),
    gerber: s.object(gerberShape).describe("Replaces the profile's Gerber format.").optional(),
    drill: s.object(drillShape).describe("Replaces the profile's drill format.").optional(),
    bom: s.object(bomShape).describe("Replaces the profile's BOM format.").optional(),
    cpl: s.object(positionsShape).describe("Replaces the profile's positions format.").optional(),
    archive: s
      .array(s.enum(OUTPUTS))
      .describe(
        "Outputs zipped into board-gerbers.zip, the rest written beside it; replaces the profile's; [] writes no zip."
      )
      .optional(),
    dryRun: s
      .boolean()
      .describe('Answer the pre-flight and file list and write nothing.')
      .optional()
  }),
  examples: [
    {
      args: { profile: 'jlcpcb', dryRun: true },
      note: 'preview findings and files'
    },
    { args: { profile: 'jlcpcb' }, note: "JLCPCB's upload into fab/" }
  ],
  request: ({ board, directory, profile, gerber, drill, bom, cpl, archive, dryRun }) => {
    const columns = bomColumns(bom?.columns, '/bom')
    if (isFailure(columns)) return columns
    return {
      kind: 'export-board',
      output: 'package',
      ...(board ? { board } : {}),
      ...(directory ? { directory } : {}),
      ...(profile ? { profile } : {}),
      ...(gerber ? { gerber: gerberFormat(gerber) } : {}),
      ...(drill ? { drill } : {}),
      ...(bom
        ? { bom: { group: bom.group, includeDnp: bom.includeDnp, ...(columns ? { columns } : {}) } }
        : {}),
      ...(cpl ? { cpl } : {}),
      ...(archive ? { archive } : {}),
      ...(dryRun ? { dryRun: true } : {})
    }
  }
})
