/**
 * The `board` argument the item operations share: with it, an item operation
 * reads or writes one board instead of a sheet, through the window's board
 * door (`lib/board/boardAgent.ts`).
 */
import { s } from '../schema'
import { BOARD_FILE } from '../fileArgs'

export { BOARD_CREATE_KINDS, BOARD_ITEM_KINDS } from '../../../shared/itemRecords'

export const boardArg = s
  .string()
  .trim()
  .describe(`Act on this board. ${BOARD_FILE}. With footprint, the board a placed footprint is on.`)
  .optional()
