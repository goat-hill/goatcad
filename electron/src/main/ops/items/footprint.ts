/**
 * The `footprint` argument the item operations share: with it, an item
 * operation reads or writes one footprint instead of a sheet, through the
 * window's footprint door (`lib/footprint/footprintAgent.ts`).
 */
import { s } from '../schema'
import { refused, type OpFailure } from '../errors'

export { FOOTPRINT_CREATE_KINDS, FOOTPRINT_ITEM_KINDS } from '../../../shared/itemRecords'

export const footprintArg = s
  .string()
  .trim()
  .describe(
    'Act on this footprint: a library id "Nickname:Name", or with board a placed reference ("U1") for the board\'s copy.'
  )
  .optional()

/** A library id always carries its nickname; a reference never has a colon. */
const isLibraryId = (id: string): boolean => id.includes(':')

/**
 * The footprint a request names: a library id alone, or a placed footprint's
 * reference with the board it is on. A refusal when the two are mixed.
 */
export const footprintTarget = (args: {
  footprint: string
  board?: string
}): { footprint: string; board?: string } | OpFailure => {
  if (isLibraryId(args.footprint)) {
    return args.board
      ? refused(
          `"${args.footprint}" is a library id, and board is for a footprint placed on a board.`,
          'Drop board to act on the library footprint, or pass the reference of the placed one ("U1") with board.'
        )
      : { footprint: args.footprint }
  }
  return args.board
    ? { footprint: args.footprint, board: args.board }
    : refused(
        `"${args.footprint}" is not a library id, so it names a footprint placed on a board.`,
        'Pass board with the reference, or a "Nickname:Name" library id as footprint_search reports it.'
      )
}

export const isTargetRefusal = (
  value: { footprint: string; board?: string } | OpFailure
): value is OpFailure => 'ok' in value

/** Decoding a model is the slow part of reading one, so it is asked for. */
export const modelFitArg = s
  .boolean()
  .describe(
    'Footprints: decode each linked 3D model and answer its bounds and fit. Slow; off by default.'
  )
  .optional()

/**
 * Which arguments name two documents. A footprint with its board names one (a
 * placed footprint), as does a symbol with its sheet (a placed symbol's copy).
 */
export const bothDocuments = (args: {
  sheet?: string
  footprint?: string
  board?: string
  symbol?: string
}): OpFailure | null => {
  if (args.symbol && (args.footprint || args.board))
    return refused(
      `symbol and ${args.footprint ? 'footprint' : 'board'} name different documents.`,
      'Pass one: symbol (with sheet for a placed one), footprint (with board for a placed one), board, or sheet.'
    )
  const other = args.footprint ? 'footprint' : args.board ? 'board' : null
  return args.sheet && other
    ? refused(
        `sheet and ${other} name different documents.`,
        'Pass sheet to act on a schematic, board on a board, or footprint on a footprint — a library one by its id, or one placed on a board by its reference with board.'
      )
    : null
}

/** Keys that only mean something on a sheet, refused beside a footprint. */
export const sheetOnlyKeys = (
  args: Record<string, unknown>,
  keys: readonly string[]
): OpFailure | null => {
  const given = keys.filter((key) => args[key] !== undefined)
  return given.length
    ? refused(
        `${given.join(', ')} ${given.length === 1 ? 'is' : 'are'} for sheet items, not symbol, footprint or board items.`,
        'On a symbol, a footprint or a board, send what changes inside record, in the shape items_get answers.'
      )
    : null
}
