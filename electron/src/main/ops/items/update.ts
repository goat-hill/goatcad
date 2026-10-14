/**
 * `items.update` — a partial record written back onto one item.
 *
 * Design: `docs/agent-api.md`. Move, rotate and mirror are
 * not verbs: they are `at`, `angle` and `mirror` on a symbol's record, and the
 * same `at` moves a label, a text, a field or a flag. What a kind does not
 * carry is refused rather than ignored, so a misdirected argument is a visible
 * failure and never a call that succeeded meaning something else.
 */
import type { McpUpdateItemRequest } from '../../../preload/mcpTypes'
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { invalidArgs, refused, type OpFailure } from '../errors'
import {
  bothDocuments,
  footprintArg,
  footprintTarget,
  isTargetRefusal,
  sheetOnlyKeys
} from './footprint'
import { boardArg } from './board'
import { itemsSheetArg } from './document'
import { recordArg, recordCheck } from './record'
import { checksArg } from '../checksArg'
import { isSymbolRefusal, itemsSymbolArg, symbolTarget } from '../symbol/target'
import { itemsViewportRefusal, layoutViewportArg, setsLayout } from '../viewport/open'
import { layoutActionArg } from '../viewport/action'

/** A sheet record checked key by key and turned into the window's request. */
export const sheetUpdateRequest = (
  id: string,
  record: unknown,
  extra: { sheet?: string; wires?: 'follow' | 'leave' }
): McpUpdateItemRequest | OpFailure => {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return invalidArgs(
      'record must be an object of the keys that change.',
      '/record',
      'Send e.g. {"record": {"at": {"x": 100.33, "y": 50.8}}}.'
    )
  }
  const entries = Object.entries(record as Record<string, unknown>)
  if (!entries.length) {
    return refused(
      'Nothing to change: record is empty.',
      'Send the keys that change inside record, e.g. {"record": {"at": {"x": 100.33, "y": 50.8}}}.'
    )
  }
  const bad = recordCheck('sheet', undefined, record as Record<string, unknown>, 'update')
  if (bad) return bad
  const change = record as Partial<McpUpdateItemRequest>
  if (change.fields && 'Reference' in change.fields) {
    return refused(
      'The Reference is assigned by annotation and is not written through fields.',
      'Renumber with schematic_annotate.'
    )
  }
  if (id.endsWith('#Reference') && change.value !== undefined) {
    return refused(
      'The Reference is assigned by annotation and is not written through its field.',
      'Renumber with schematic_annotate; the field takes at, angle and hidden.'
    )
  }
  return {
    kind: 'update-item',
    id,
    ...(extra.sheet ? { sheet: extra.sheet } : {}),
    ...(change as Omit<McpUpdateItemRequest, 'kind' | 'id' | 'sheet' | 'wires' | 'checks'>),
    ...(extra.wires ? { wires: extra.wires } : {})
  }
}

export const itemsUpdate = defineDesignOp({
  name: 'items.update',
  scope: 'project',
  mutates: true,
  summary: 'Change one item by id on a sheet, a board, a footprint or a symbol.',
  guidance:
    "Send only what changes, in record; a key the item's kind lacks is refused. On a sheet or board, a record that sets layout needs viewport. Sheet: a moved symbol carries its labels and no-connects and reshapes its wires; a pin off the 1.27 mm grid is refused with the nearest valid at. Reference is schematic_annotate's; a value, field or flag goes on every unit. A sheet resizes from its top-left corner. A graphic moves by at or reshapes by its geometry keys, not both at once. Board: a locked item moves only with \"locked\": false. A library footprint or symbol is written only in the project's library; a placed one (reference with board or sheet) writes the design's copy, which a symbol's placements on that sheet share. Symbol: unit and style move a part, one past the last adds one; id \"symbol\" is Symbol Properties, where fewer units drop the last and a new name answers the new libId.",
  input: s.object({
    footprint: footprintArg,
    symbol: itemsSymbolArg,
    board: boardArg,
    sheet: itemsSheetArg,
    id: s.string().trim().describe('An item id from a describe, items_query or items_get.'),
    wires: s
      .enum(['follow', 'leave'] as const)
      .describe(
        'Sheet symbols and sheets: "follow" (default) reshapes the wires on moved pins; "leave" keeps them.'
      )
      .optional(),
    tracks: s
      .enum(['follow', 'leave'] as const)
      .describe(
        'Board footprints: "follow" carries the ends of tracks on its pads with a move, redrawing their last bend; "leave" (default) keeps them. Vias stay put.'
      )
      .optional(),
    record: recordArg,
    viewport: layoutViewportArg,
    action: layoutActionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        id: 'C8',
        record: { at: { x: 248.92, y: 49.53 }, angle: 90 },
        viewport: 'viewport-1',
        action: 'Move C8'
      },
      note: 'move and turn a capacitor, labels following'
    },
    {
      args: { id: 'R4', record: { dnp: true, fields: { Value: '0R' } } },
      note: "a sheet symbol's flag and field together"
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        id: 'U1',
        record: { at: { x: 120, y: 85 }, angle: 90 },
        viewport: 'viewport-2',
        action: 'Move U1'
      },
      note: 'place a part on the board'
    },
    {
      args: { footprint: 'board:SOT-23-5', id: 'pad:1', record: { shape: 'rect' } },
      note: 'square off pin 1 of a project footprint'
    },
    {
      args: {
        footprint: 'J1',
        board: 'bitclock.kicad_pcb',
        id: 'model',
        record: { offset: { x: 0, y: 0, z: 0.1 } }
      },
      note: "lift the model on the board's own copy of J1"
    },
    {
      args: { symbol: 'board:ES8388', id: 'pin:7', record: { type: 'power_in' } },
      note: 'make a library pin a power input'
    }
  ],
  request(args) {
    const { sheet, id, footprint, board, symbol, record, wires, tracks } = args
    if (!id)
      return refused('id is required and must not be empty.', 'Pass an item id from items_query.')
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    const notSheet = (): OpFailure | null => sheetOnlyKeys({ wires }, ['wires'])
    const notBoard = (): OpFailure | null =>
      tracks === undefined
        ? null
        : invalidArgs(
            'tracks is for a footprint on a board.',
            '/tracks',
            'Pass board with the footprint reference as id; on a sheet, wires does the same.'
          )
    // Checked after the record, so a misspelled key is the refusal a caller sees first.
    const noViewport = itemsViewportRefusal(args, setsLayout(record), 'a record with layout keys')
    if (noViewport && (symbol || footprint)) return noViewport
    if (symbol) {
      const target = symbolTarget({ symbol, sheet })
      if (isSymbolRefusal(target)) return target
      const sheetKeys = notSheet() ?? notBoard()
      if (sheetKeys) return sheetKeys
      if (!record || !Object.keys(record).length) {
        return refused(
          'Nothing to change: record is absent or empty.',
          'Send the keys that change inside record, e.g. {"record": {"type": "power_in"}}.'
        )
      }
      const bad = recordCheck('symbol', undefined, record, 'update')
      if (bad) return bad
      return { kind: 'update-symbol-item', ...target, id, record }
    }
    if (footprint) {
      const target = footprintTarget({ footprint, board })
      if (isTargetRefusal(target)) return target
      const sheetKeys = notSheet() ?? notBoard()
      if (sheetKeys) return sheetKeys
      if (!record || !Object.keys(record).length) {
        return refused(
          'Nothing to change: record is absent or empty.',
          'Send the keys that change inside record, e.g. {"record": {"size": {"width": 0.6, "height": 1.2}}}.'
        )
      }
      const bad = recordCheck('footprint', undefined, record, 'update')
      if (bad) return bad
      return { kind: 'update-footprint-item', ...target, id, record }
    }
    if (board) {
      const sheetKeys = notSheet()
      if (sheetKeys) return sheetKeys
      if (!record || !Object.keys(record).length) {
        return refused(
          'Nothing to change: record is absent or empty.',
          'Send the keys that change inside record, e.g. {"record": {"at": {"x": 120, "y": 85}}}.'
        )
      }
      const bad = recordCheck('board', undefined, record, 'update')
      if (bad) return bad
      if (noViewport) return noViewport
      return {
        kind: 'update-board-item',
        board,
        id,
        record,
        ...(tracks ? { tracks } : {})
      }
    }
    const boardKeys = notBoard()
    if (boardKeys) return boardKeys
    if (record === undefined) {
      return refused(
        'Nothing to change: record is absent.',
        'Send the keys that change inside record, keyed as items_get answers them.'
      )
    }
    const built = sheetUpdateRequest(id, record, { sheet, wires })
    return 'ok' in built ? built : (noViewport ?? built)
  }
})
