/**
 * `items.query` — what is on a sheet, a board or a footprint, where.
 *
 * Design: `docs/agent-api.md`. The spatial question a
 * blind model otherwise guesses at: what sits in this region, what is near
 * this pin, what carries this net. Rows are compact; `items.get` has the rest.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import {
  bothDocuments,
  footprintArg,
  footprintTarget,
  FOOTPRINT_ITEM_KINDS,
  isTargetRefusal,
  modelFitArg
} from './footprint'
import { boardArg, BOARD_ITEM_KINDS } from './board'
import { itemsSheetArg } from './document'
import { SHEET_ITEM_KINDS } from '../../../shared/itemRecords'
import { isSymbolRefusal, itemsSymbolArg, SYMBOL_ITEM_KINDS, symbolTarget } from '../symbol/target'

/** The most rows one answer holds. The Python client pages at this size (`_PAGE`, pythonRuntime.ts). */
export const QUERY_MAX_LIMIT = 400

export const itemsQuery = defineDesignOp({
  name: 'items.query',
  scope: 'project',
  mutates: false,
  summary:
    'List items on a sheet, a board, a footprint or a symbol by kind, region, nearness or net.',
  guidance:
    'Rows carry id, position and box; a board\'s track, via, graphic and text rows carry their own points and sizes instead of a box. Filters combine. A capped answer says truncated and names the counts to narrow by; offset with the revision it answered reads the next page. Sheet: near takes a pin or point; net matches symbols by their pins. For what is on a pin, read the symbol\'s `attached` with items_get instead. Board: near takes a point or an item id ("U1.3"); zones whose fill predates an edit are marked stale; zones a footprint carries list its reference. Footprint: filter by kind, layer, pad number, box or point; its own properties are the "footprint" row. Symbol: filter by kind, unit (0 is common to all units), pin number, box or point.',
  input: s.object({
    footprint: footprintArg,
    symbol: itemsSymbolArg,
    board: boardArg,
    sheet: itemsSheetArg,
    kind: s
      .enum([
        ...new Set([
          ...SHEET_ITEM_KINDS,
          ...FOOTPRINT_ITEM_KINDS,
          ...BOARD_ITEM_KINDS,
          ...SYMBOL_ITEM_KINDS
        ])
      ])
      .describe('Only items of this kind; the kinds differ by document.')
      .optional(),
    layer: s
      .string()
      .trim()
      .describe(
        'Footprints and boards: items on this layer, e.g. "F.SilkS"; a *.Cu pad is on every copper layer.'
      )
      .optional(),
    unit: s.integer().min(0).describe('Symbols: only items of this unit.').optional(),
    number: s
      .string()
      .describe('Footprints and symbols: the pads or pins with this number.')
      .optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe("A rectangle in the document's millimeters; items whose box touches it.")
      .optional(),
    near: s
      .object({
        pin: s
          .string()
          .trim()
          .describe('A pin id from schematic_describe, e.g. "U3.2".')
          .optional(),
        id: s
          .string()
          .trim()
          .describe(
            'Boards: around the center of this item\'s box, e.g. a pad "U1.3" or a footprint "C4".'
          )
          .optional(),
        x: s.number().optional(),
        y: s.number().optional()
      })
      .describe(
        "Around a pin (a sheet), an item's center (a board), or a point in millimeters, within radius; a board item is near when its box is."
      )
      .optional(),
    radius: s
      .number()
      .min(0)
      .describe(
        'Millimeters around near. Defaults to 5.08 on a sheet, two grid squares, and 1 on a board or a footprint.'
      )
      .optional(),
    net: s
      .string()
      .trim()
      .describe('Only items on this net; on a sheet, symbols match by their pins.')
      .optional(),
    limit: s
      .integer()
      .min(1)
      .max(QUERY_MAX_LIMIT)
      .describe('Rows to return. Defaults to 100.')
      .optional(),
    offset: s
      .integer()
      .min(0)
      .describe('Matches to skip: the next page starts at the rows already read. Defaults to 0.')
      .optional(),
    revision: s
      .integer()
      .min(0)
      .describe(
        'Sheets and boards: the revision the first page answered; refused once the document moved, so the pages join.'
      )
      .optional(),
    modelFit: modelFitArg
  }),
  examples: [
    { args: { near: { pin: 'U3.2' } }, note: 'what is beside a supply pin' },
    { args: { kind: 'label', net: 'GND' }, note: 'every ground label' },
    {
      args: { box: { x: 20, y: 40, width: 100, height: 40 } },
      note: 'what a region already holds'
    },
    {
      args: { board: 'bitclock.kicad_pcb', near: { id: 'U1.3' }, radius: 2 },
      note: 'the copper around a pad, before routing to it'
    },
    {
      args: { footprint: 'board:SOT-23-5', kind: 'line', layer: 'F.SilkS' },
      note: "a footprint's silkscreen lines"
    }
  ],
  request: (args) => {
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    if (args.modelFit !== undefined && !args.footprint)
      return refused('modelFit is for a footprint.', 'Pass footprint with it, or drop it.')
    if (args.revision !== undefined && (args.symbol || args.footprint))
      return refused(
        'A footprint or symbol query answers no revision to pin.',
        'Drop revision; page with offset alone.'
      )
    if (args.unit !== undefined && !args.symbol)
      return refused('unit is for symbol items.', 'Pass symbol with it, or drop it.')
    if (args.symbol) {
      const target = symbolTarget({ symbol: args.symbol, sheet: args.sheet })
      if (isSymbolRefusal(target)) return target
      if (args.net || args.layer || args.near?.pin || args.near?.id) {
        return refused(
          'A symbol has no nets, layers or neighbors to search by.',
          'On a symbol, filter by kind, unit, number, box, or near a point.'
        )
      }
      const kind = args.kind
      if (kind && !(SYMBOL_ITEM_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A symbol has no ${kind} items.`,
          `On a symbol, kind is one of ${SYMBOL_ITEM_KINDS.join(', ')}.`
        )
      }
      const near =
        args.near && args.near.x !== undefined && args.near.y !== undefined
          ? { x: args.near.x, y: args.near.y }
          : undefined
      return {
        kind: 'query-symbol-items',
        ...target,
        ...(kind ? { itemKind: kind as (typeof SYMBOL_ITEM_KINDS)[number] } : {}),
        ...(args.unit !== undefined ? { unit: args.unit } : {}),
        ...(args.number !== undefined ? { number: args.number } : {}),
        ...(args.box ? { box: args.box } : {}),
        ...(near ? { near } : {}),
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {})
      }
    }
    if (args.footprint) {
      const target = footprintTarget({ footprint: args.footprint, board: args.board })
      if (isTargetRefusal(target)) return target
      if (args.net || args.near?.pin || args.near?.id) {
        return refused(
          'A footprint has no nets or pins to search by.',
          'On a footprint, filter by kind, layer, number, box, or near a point.'
        )
      }
      const kind = args.kind
      if (kind && !(FOOTPRINT_ITEM_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A footprint has no ${kind} items.`,
          `On a footprint, kind is one of ${FOOTPRINT_ITEM_KINDS.join(', ')}.`
        )
      }
      const near =
        args.near && args.near.x !== undefined && args.near.y !== undefined
          ? { x: args.near.x, y: args.near.y }
          : undefined
      return {
        kind: 'query-footprint-items',
        ...target,
        ...(args.modelFit ? { modelFit: true } : {}),
        ...(kind ? { itemKind: kind as (typeof FOOTPRINT_ITEM_KINDS)[number] } : {}),
        ...(args.layer ? { layer: args.layer } : {}),
        ...(args.number !== undefined ? { number: args.number } : {}),
        ...(args.box ? { box: args.box } : {}),
        ...(near ? { near } : {}),
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {})
      }
    }
    if (args.board) {
      if (args.near?.pin || args.number !== undefined) {
        return refused(
          'A board is searched by item, not by pin or pad number.',
          'Pass near.id with a pad id such as "U1.3", or filter by kind, layer, net or box.'
        )
      }
      const kind = args.kind
      if (kind && !(BOARD_ITEM_KINDS as readonly string[]).includes(kind)) {
        return refused(
          `A board has no ${kind} items.`,
          `On a board, kind is one of ${BOARD_ITEM_KINDS.join(', ')}.`
        )
      }
      return {
        kind: 'query-board-items',
        board: args.board,
        ...(kind ? { itemKind: kind as (typeof BOARD_ITEM_KINDS)[number] } : {}),
        ...(args.layer ? { layer: args.layer } : {}),
        ...(args.net !== undefined ? { net: args.net } : {}),
        ...(args.box ? { box: args.box } : {}),
        ...(args.near ? { near: args.near } : {}),
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.revision !== undefined ? { revision: args.revision } : {})
      }
    }
    if (args.near?.id) {
      return refused('near.id is for board items.', 'On a sheet, pass near.pin or a point.')
    }
    if (args.layer || args.number !== undefined) {
      return refused(
        'layer and number filter footprint and board items.',
        'Pass footprint or board, or drop them for a sheet.'
      )
    }
    if (args.kind && !(SHEET_ITEM_KINDS as readonly string[]).includes(args.kind)) {
      return refused(
        `A sheet has no ${args.kind} items.`,
        `On a sheet, kind is one of ${SHEET_ITEM_KINDS.join(', ')}.`
      )
    }
    return {
      kind: 'query-items',
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.kind ? { itemKind: args.kind as (typeof SHEET_ITEM_KINDS)[number] } : {}),
      ...(args.box ? { box: args.box } : {}),
      ...(args.near ? { near: args.near } : {}),
      ...(args.radius !== undefined ? { radius: args.radius } : {}),
      ...(args.net ? { net: args.net } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.revision !== undefined ? { revision: args.revision } : {})
    }
  }
})
