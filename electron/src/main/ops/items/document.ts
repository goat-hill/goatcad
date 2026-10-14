/**
 * The `sheet` argument the item operations share. With none of sheet, board
 * and footprint, an item operation acts on the root sheet, else the only open sheet.
 */
import { s } from '../schema'
import { SHEET_FILE } from '../fileArgs'

export const itemsSheetArg = s
  .string()
  .trim()
  .describe(
    `Act on this sheet. ${SHEET_FILE}. Omit it — with neither board nor footprint — for the root sheet, else the only open sheet.`
  )
  .optional()
