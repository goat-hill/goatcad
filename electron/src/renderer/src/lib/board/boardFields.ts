/**
 * A placed footprint's fields on a board, by the field id `<ref>#<field>`
 * (docs/agent-api.md, "Ids are read, never recalled").
 *
 * A field reads and writes in board coordinates, as KiCad's properties panel
 * and the GUI's property table show it (`pcbPropertySchema.ts`): `at` is where
 * it sits on the board, `angle` its angle on the board, `layer` the board's
 * layer (B.SilkS on a back-side part). The board file keeps the position
 * relative to the footprint and unrotated, the angle absolute
 * (`footprintChildren.ts`), so only `at` goes through the placement, both
 * ways. The record's keys and checks are the footprint door's
 * (`footprintItems.ts`), run on a clone of the board's own node that replaces
 * it whole, so one write is one top-level node changed.
 *
 * `#` is also the suffix a board gives a repeated id (`boardItems`), so an id
 * names a field only when its left side is the reference of exactly one
 * footprint and its right side a field that footprint has; anything else
 * stays an item id.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { remapKicadBoard } from '../kicad/board'
import { mmToNm, nmToMm } from '../kicad/coordinates'
import { mm } from './zoneRecord'
import { parseFootprintNode } from '../kicad/footprint'
import { cloneNodeDeep, outsideNodeCapture, type SExprList, type SExprNode } from '../kicad/sexpr'
import {
  footprintItems,
  itemRow,
  updateItem,
  type FootprintItem,
  type ItemFailure
} from '../footprint/footprintItems'
import { boardPointInFootprint, footprintPointOnBoard } from './footprintChildren'
import { isSymbolOwned } from './footprintExchange'

const PROPERTY = 'property:'

/** A field a board id names, read from the board's own footprint. */
export interface BoardField {
  id: string
  reference: string
  key: string
  placed: KicadBoardFootprint
  item: FootprintItem
}

/** The one footprint with this reference, or null when none or several carry it. */
const placedBy = (board: KicadBoard, reference: string): KicadBoardFootprint | null => {
  const placed = board.footprints.filter((footprint) => footprint.reference === reference)
  return placed.length === 1 ? placed[0] : null
}

const fieldItem = (placed: KicadBoardFootprint, key: string): FootprintItem | undefined =>
  footprintItems(placed.footprint).find((entry) => entry.id === `${PROPERTY}${key}`)

/** The field `id` names, or null when it is not a field id on this board. */
export function boardField(board: KicadBoard, id: string): BoardField | null {
  const split = id.indexOf('#')
  if (split <= 0) return null
  const reference = id.slice(0, split)
  const key = id.slice(split + 1)
  const placed = placedBy(board, reference)
  if (!placed || !key) return null
  const item = fieldItem(placed, key)
  return item ? { id, reference, key, placed, item } : null
}

/** Every field id of the footprint an id's left side names: the candidates for a field that missed. */
export function boardFieldIds(board: KicadBoard, id: string): string[] {
  const split = id.indexOf('#')
  if (split <= 0) return []
  const reference = id.slice(0, split)
  const placed = placedBy(board, reference)
  if (!placed) return []
  return footprintItems(placed.footprint).flatMap((item) =>
    item.id.startsWith(PROPERTY) ? [`${reference}#${item.id.slice(PROPERTY.length)}`] : []
  )
}

const isPoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as { x: unknown }).x) &&
  Number.isFinite((value as { y: unknown }).y)

/**
 * The field's record in board coordinates, under the board id with its
 * footprint's reference. The footprint door answers `at` as stored, relative
 * to the footprint; its box is centered there and already turned by the
 * absolute angle, so both move by the same offset to the board.
 */
export const boardFieldRecord = (field: BoardField): Record<string, unknown> => {
  const row = itemRow(field.item)
  const local = row.at as { x: number; y: number }
  const onBoard = footprintPointOnBoard(field.placed, { x: mmToNm(local.x), y: mmToNm(local.y) })
  const at = { x: mm(onBoard.x), y: mm(onBoard.y) }
  const box = row.box as { x: number; y: number; width: number; height: number } | undefined
  return {
    ...row,
    id: field.id,
    reference: field.reference,
    at,
    ...(box
      ? {
          box: {
            ...box,
            x: mm(mmToNm(box.x) + onBoard.x - mmToNm(local.x)),
            y: mm(mmToNm(box.y) + onBoard.y - mmToNm(local.y))
          }
        }
      : {})
  }
}

/**
 * Write a partial record onto the field, in board coordinates: `at` is
 * brought into the footprint's frame as the property table's X and Y are,
 * `angle` and `layer` are stored as given. The footprint door's `updateItem`
 * checks and applies the record on a clone of the board's node, which then
 * takes the node's place. Answers the field's id after the write (a new
 * Reference renames it).
 */
export function updateBoardField(
  board: KicadBoard,
  field: BoardField,
  record: Record<string, unknown>
): { ok: true; board: KicadBoard; id: string } | ItemFailure {
  // As the board editor's field rows: the schematic owns a placed part's names.
  if (
    (field.key === 'Reference' || field.key === 'Value') &&
    record.value !== undefined &&
    isSymbolOwned(field.placed)
  )
    return {
      ok: false,
      error: 'refused',
      detail: `${field.reference}'s reference and value are its schematic symbol's. Change them on the sheet (schematic_annotate renumbers; items_update sets the value), then board_sync.`
    }
  const local = isPoint(record.at)
    ? boardPointInFootprint(field.placed, {
        x: mmToNm(record.at.x),
        y: mmToNm(record.at.y)
      })
    : null
  const stored = local ? { ...record, at: { x: nmToMm(local.x), y: nmToMm(local.y) } } : record
  const fresh = cloneNodeDeep(field.placed._raw) as SExprList
  const copy = parseFootprintNode(fresh)
  const item = footprintItems(copy).find((entry) => entry.id === field.item.id)
  if (!item)
    return { ok: false, error: 'refused', detail: `${field.id} could not be read for the write.` }
  // The clone is detached: the board's change is its node replaced whole below.
  const outcome = outsideNodeCapture(() => updateItem(copy, item, stored))
  if (!outcome.ok) return outcome
  const root = board._raw as SExprList
  const index = root.children.indexOf(field.placed._raw as SExprNode)
  if (index < 0)
    return {
      ok: false,
      error: 'refused',
      detail: `${field.reference} could not be written back onto the board.`
    }
  root.children[index] = fresh
  const next = remapKicadBoard(board)
  const renamed =
    field.key === 'Reference' && typeof record.value === 'string' ? record.value : field.reference
  return { ok: true, board: next, id: `${renamed}#${field.key}` }
}
