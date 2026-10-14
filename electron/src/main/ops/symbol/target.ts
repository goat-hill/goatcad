/**
 * The `symbol` argument the symbol reads share: a library symbol by its id, or
 * a placed symbol's definition by its reference — the sheet's own copy, as
 * Edit symbol… opens it (`lib/designCopy.ts`).
 */
import { s } from '../schema'
import { refused, type OpFailure } from '../errors'
import type { McpSymbolTarget } from '../../../preload/mcpTypes'
import { SHEET_FILE } from '../fileArgs'

export { SYMBOL_CREATE_KINDS, SYMBOL_ITEM_KINDS } from '../../../shared/itemRecords'

export const symbolArg = s
  .string()
  .trim()
  .describe('A library id "Nickname:Name", or a placed reference ("U1") for its sheet\'s copy.')

export const placedSheetArg = s
  .string()
  .trim()
  .describe(
    `With a reference: the sheet the symbol is placed on. ${SHEET_FILE}. Omit for the open sheet, else the root sheet.`
  )
  .optional()

/** A library id always carries its nickname; a reference never has a colon. */
export const symbolTarget = (args: {
  symbol: string
  sheet?: string
}): McpSymbolTarget | OpFailure => {
  if (!args.symbol) {
    return refused(
      'symbol is required and must not be empty.',
      'Pass a library id as symbol_search reports it, or a placed reference.'
    )
  }
  if (args.symbol.includes(':')) {
    return args.sheet
      ? refused(
          `"${args.symbol}" is a library id, and sheet is for a symbol placed on a sheet.`,
          'Drop sheet to read the library symbol, or pass the reference of the placed one ("U1") with sheet.'
        )
      : { symbol: args.symbol }
  }
  return { symbol: args.symbol, ...(args.sheet ? { sheet: args.sheet } : {}) }
}

export const bodyStyleArg = s
  .integer()
  .min(1)
  .describe('Body style, e.g. 2 for the De Morgan drawing. Defaults to 1.')
  .optional()

export const isSymbolRefusal = (value: McpSymbolTarget | OpFailure): value is OpFailure =>
  'ok' in value

export const itemsSymbolArg = s
  .string()
  .trim()
  .describe(
    'Act on this symbol definition: a library id "Nickname:Name", or a placed reference ("U1") for its sheet\'s copy.'
  )
  .optional()
