/**
 * How an op's `board` or `sheet` argument names its file. The resolvers
 * (`resolveAgentFile` and `resolveAgentSheet`, `lib/schematic/schematicAgent.ts`)
 * match exactly, extension included, so the text says so.
 */
import { s, type OptionalSchema } from './schema'

export const BOARD_FILE =
  'The board\'s file name with its extension ("main.kicad_pcb"), or its absolute path'

export const SHEET_FILE =
  'The sheet\'s file name with its extension ("power.kicad_sch"), or its absolute path'

/** An optional `sheet`, defaulting as the resolver does; `prefix` leads its text. */
export const sheetFileArg = (prefix = ''): OptionalSchema<string> =>
  s
    .string()
    .trim()
    .describe(`${prefix}${SHEET_FILE}. Default: the root sheet, else the only open sheet.`)
    .optional()
