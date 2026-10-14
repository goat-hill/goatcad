/**
 * `items.create` — one item on a sheet, a board or a footprint.
 *
 * Design: `docs/agent-api.md`. The simple items, created the way
 * the editors' own tools create them. On a sheet, `connect` remains the way to
 * put a net on several pins at once; this is one label, where you say. Text
 * and rectangles are what an annotated sheet is made of: a title over a block,
 * a line on what it is for, the datasheet's rule in fine print.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { boardArg, BOARD_CREATE_KINDS } from './board'
import {
  bothDocuments,
  footprintArg,
  footprintTarget,
  FOOTPRINT_CREATE_KINDS,
  isTargetRefusal
} from './footprint'
import { checksArg } from '../checksArg'
import { itemsSheetArg } from './document'
import { SHEET_CREATE_KINDS, type SheetCreateKind } from '../../../shared/itemRecords'
import { recordArg, recordCheck, SHEET_CREATE_KEYS_TEXT } from './record'
import type { McpCreateItemRequest } from '../../../preload/mcpTypes'
import type { OpFailure } from '../errors'
import {
  isSymbolRefusal,
  itemsSymbolArg,
  SYMBOL_CREATE_KINDS,
  symbolTarget
} from '../symbol/target'
import { itemsViewportRefusal, layoutViewportArg } from '../viewport/open'
import { layoutActionArg } from '../viewport/action'

/** A sheet item's record checked key by key and turned into the window's request. */
export const sheetCreateRequest = (
  kind: SheetCreateKind,
  record: Record<string, unknown> | undefined,
  sheet: string | undefined
): McpCreateItemRequest | OpFailure => {
  if (!record) {
    return refused(
      `A ${kind} needs record.`,
      'Pass its fields in record, e.g. {"kind": "label", "record": {"text": "GND", "pin": "C8.2"}}.'
    )
  }
  const bad = recordCheck('sheet', kind, record, 'create')
  if (bad) return bad
  const fields = record as Omit<McpCreateItemRequest, 'kind' | 'itemKind' | 'sheet' | 'checks'>
  const missing = (keys: string): OpFailure =>
    refused(
      `A ${kind} needs ${keys} in record.`,
      `Sheet create keys by kind: ${SHEET_CREATE_KEYS_TEXT}.`
    )
  if ((kind === 'label' || kind === 'text') && !fields.text) return missing('text')
  if (
    (kind === 'junction' || kind === 'image' || kind === 'table' || kind === 'bus_entry') &&
    !fields.at
  )
    return missing('at')
  if ((kind === 'rect' || kind === 'text_box') && !fields.box) return missing('box')
  if (kind === 'sheet_pin' && (!fields.ofSheet || !fields.name)) return missing('ofSheet and name')
  if (
    (kind === 'label' || kind === 'text' || kind === 'no_connect' || kind === 'directive_label') &&
    !fields.pin &&
    !fields.at
  )
    return missing('pin or at')
  if ((kind === 'polyline' || kind === 'bezier' || kind === 'rule_area') && !fields.points)
    return missing('points')
  if (kind === 'circle' && (!fields.center || fields.radius === undefined))
    return missing('center and radius')
  if (kind === 'arc' && (!fields.start || !fields.end)) return missing('start and end')
  if (kind === 'image' && !fields.path) return missing('path')
  if (kind === 'table' && (!fields.columnWidths || !fields.rowHeights))
    return missing('columnWidths and rowHeights')
  return {
    kind: 'create-item',
    itemKind: kind,
    ...(sheet ? { sheet } : {}),
    ...fields
  }
}

export const itemsCreate = defineDesignOp({
  name: 'items.create',
  scope: 'project',
  mutates: true,
  summary: 'Add one item to a sheet, a board, a footprint or a symbol.',
  guidance:
    "Answers with the new id; one undo step. On a sheet or board it needs viewport. Sheet: fields go in record; a label, no-connect or directive label goes on a pin (pin) or at a point; a global label joins every sheet's net of that name, a local one only this sheet's; a directive label's netClass sets its net's class. A bus_entry runs from a bus (at) to a wire end (end). Text, graphics, tables and images connect nothing. Board: fields go in record. A track is straight segments through exactly the points given (a pad or via id is a point), with no clearance kept and nothing shoved; to route a connection, use route_begin or route_finish. Its net comes from the pads, and joining two nets is refused. Widths and via sizes default to the net class. Footprint: fields go in record; add a model only when none is linked (else items_update id \"model\"); a zone is on no net, and keepout: true makes it a rule area. A placed footprint (reference with board) takes items on the board's copy. Symbol: fields go in record; pins and graphics default to unit 1, style 1 (unit 0 is common to all units); a pin needs number and at, a field needs key. A placed symbol (reference, with sheet) takes items on its sheet's copy.",
  input: s.object({
    footprint: footprintArg,
    symbol: itemsSymbolArg,
    board: boardArg,
    sheet: itemsSheetArg,
    kind: s
      .enum([
        ...new Set([
          ...SHEET_CREATE_KINDS,
          ...FOOTPRINT_CREATE_KINDS,
          ...BOARD_CREATE_KINDS,
          ...SYMBOL_CREATE_KINDS
        ])
      ])
      .describe(
        `Item kind. Sheet: ${SHEET_CREATE_KINDS.join(', ')}; a bus is schematic_wire with bus. Board: ${BOARD_CREATE_KINDS.join(', ')}. Footprint: ${FOOTPRINT_CREATE_KINDS.join(', ')}. Symbol: ${SYMBOL_CREATE_KINDS.join(', ')}.`
      ),
    record: recordArg,
    viewport: layoutViewportArg,
    action: layoutActionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        kind: 'no_connect',
        record: { pin: 'U3.10' },
        viewport: 'viewport-1',
        action: 'Mark U3.10 open'
      },
      note: 'a pin left open on purpose'
    },
    {
      args: {
        kind: 'label',
        record: { text: 'GND', labelKind: 'global', pin: 'C8.2' },
        viewport: 'viewport-1',
        action: 'Label C8.2 GND'
      },
      note: 'a global ground on a pin'
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        kind: 'track',
        record: { layer: 'F.Cu', points: ['U1.3', { x: 121.5, y: 88 }, 'C4.1'] },
        viewport: 'viewport-2',
        action: 'Route U1.3 to C4.1'
      },
      note: 'a track from a pad to a pad with one bend, net and width from the pads'
    },
    {
      args: {
        footprint: 'board:JST_PH_B4B-PH-K_1x04_P2.00mm_Vertical',
        kind: 'line',
        record: { layer: 'F.Fab', width: 0.1, start: { x: -1, y: 2 }, end: { x: 1, y: 2 } }
      },
      note: 'a fab line on a project footprint'
    },
    {
      args: {
        footprint: 'U1',
        board: 'bitclock.kicad_pcb',
        kind: 'model',
        record: { path: '${KIPRJMOD}/models/ESP32-S3-WROOM-1.step' }
      },
      note: "a 3D model on the board's own copy of U1"
    }
  ],
  request(args) {
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    const noViewport = itemsViewportRefusal(args, true, 'creating a sheet or board item')
    if (noViewport) return noViewport
    if (args.symbol) {
      const { symbol, sheet, record, kind } = args
      const target = symbolTarget({ symbol, sheet })
      if (isSymbolRefusal(target)) return target
      if (!(SYMBOL_CREATE_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A symbol has no ${kind} items.`,
          `On a symbol, kind is one of ${SYMBOL_CREATE_KINDS.join(', ')}.`
        )
      }
      if (!record) {
        return refused(
          'A symbol item needs record.',
          'Pass its fields in record, e.g. {"kind": "pin", "record": {"number": "5", "name": "EN", "at": {"x": -7.62, "y": 0}, "angle": 0}}.'
        )
      }
      const bad = recordCheck('symbol', kind, record, 'create')
      if (bad) return bad
      return {
        kind: 'create-symbol-item',
        ...target,
        itemKind: kind as (typeof SYMBOL_CREATE_KINDS)[number],
        record
      }
    }
    if (args.footprint) {
      const { footprint, board, record, kind } = args
      const target = footprintTarget({ footprint, board })
      if (isTargetRefusal(target)) return target
      if (!(FOOTPRINT_CREATE_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A footprint has no ${kind} items.`,
          `On a footprint, kind is one of ${FOOTPRINT_CREATE_KINDS.join(', ')}.`
        )
      }
      if (!record) {
        return refused(
          'A footprint item needs record.',
          'Pass its fields in record, e.g. {"kind": "line", "record": {"layer": "F.SilkS", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}}}.'
        )
      }
      const bad = recordCheck('footprint', kind, record, 'create')
      if (bad) return bad
      return {
        kind: 'create-footprint-item',
        ...target,
        itemKind: kind as (typeof FOOTPRINT_CREATE_KINDS)[number],
        record
      }
    }
    if (args.board) {
      const { board, record, kind } = args
      if (!(BOARD_CREATE_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A ${kind} cannot be created on a board.`,
          `On a board, kind is one of ${BOARD_CREATE_KINDS.join(', ')}. Footprints arrive by board_sync; pads come with their footprint.`
        )
      }
      if (!record) {
        return refused(
          'A board item needs record.',
          'Pass its fields in record, e.g. {"kind": "track", "record": {"layer": "F.Cu", "points": ["U1.3", "C4.1"]}}.'
        )
      }
      const bad = recordCheck('board', kind, record, 'create')
      if (bad) return bad
      return {
        kind: 'create-board-item',
        board,
        itemKind: kind as (typeof BOARD_CREATE_KINDS)[number],
        record
      }
    }
    if (!(SHEET_CREATE_KINDS as readonly string[]).includes(args.kind)) {
      return refused(
        `A sheet has no ${args.kind} items.`,
        `On a sheet, kind is one of ${SHEET_CREATE_KINDS.join(', ')}; pass footprint for a footprint item.`
      )
    }
    return sheetCreateRequest(args.kind as SheetCreateKind, args.record, args.sheet)
  }
})
