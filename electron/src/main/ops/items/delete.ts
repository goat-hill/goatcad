/**
 * `items.delete` — take items off a sheet, a board or a footprint by id, or
 * off a board by the filters `items.query` takes, held to an `expect` count.
 *
 * Design: `docs/agent-api.md`. On a sheet: a label, a wire, a
 * junction, a flag, a text, a sheet node, or a symbol — which takes the labels
 * and flags on its pins with it.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { bothDocuments, footprintArg, footprintTarget, isTargetRefusal } from './footprint'
import { boardArg, BOARD_ITEM_KINDS } from './board'
import { itemsSheetArg } from './document'
import { checksArg } from '../checksArg'
import { isSymbolRefusal, itemsSymbolArg, symbolTarget } from '../symbol/target'
import { itemsViewportRefusal, layoutViewportArg } from '../viewport/open'
import { layoutActionArg } from '../viewport/action'

export const ITEMS_DELETE_MAX = 200

export const itemsDelete = defineDesignOp({
  name: 'items.delete',
  scope: 'project',
  mutates: true,
  summary:
    'Delete items by id from a sheet, a board, a footprint or a symbol, or from a board by filter.',
  guidance:
    "Every id is checked first; one miss refuses the whole call with candidates. One undo step; on a sheet or board it needs viewport. By filter (boards): kind, layer, net and box match as items_query's do, and expect is the count items_query answered for them; any other count refuses the call; a footprint's zones are counted and left. Sheet: a symbol takes the labels and no-connects on its pins with it. Board: locked items are refused; a pad or a footprint's zone goes only with its footprint; a deleted footprint the schematic still has returns on the next board_sync. Footprint: library footprints only in the project's library; a placed one (reference with board) edits the board's copy. Symbol: the same rule with sheet for a placed one; mandatory fields are refused (hide them instead).",
  input: s.object({
    footprint: footprintArg,
    symbol: itemsSymbolArg,
    board: boardArg,
    sheet: itemsSheetArg,
    ids: s
      .array(s.string().trim())
      .min(1)
      .max(ITEMS_DELETE_MAX)
      .describe(
        'Item ids, e.g. ["C8"] on a sheet, a uuid on a board, ["model"] on a footprint. Omit to delete by filter.'
      )
      .optional(),
    kind: s.enum(BOARD_ITEM_KINDS).describe('Boards, by filter: items of this kind.').optional(),
    layer: s.string().trim().describe('Boards, by filter: items on this layer.').optional(),
    net: s.string().trim().describe('Boards, by filter: items on this net.').optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe("Boards, by filter: items whose box touches this rectangle, in the board's mm.")
      .optional(),
    expect: s
      .integer()
      .min(1)
      .describe('Required with the filters: how many items they match, or nothing is deleted.')
      .optional(),
    viewport: layoutViewportArg,
    action: layoutActionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { ids: ['C8'], viewport: 'viewport-1', action: 'Delete C8' },
      note: 'a capacitor and the labels on its pins'
    },
    {
      args: {
        ids: ['227a52e6-dab0-4475-8726-e8557c1be432'],
        viewport: 'viewport-1',
        action: 'Delete a stray label'
      },
      note: 'one stray label'
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        ids: ['5d0c3a41-7b2e-4f7a-9a51-0b6f1c2d8e93'],
        viewport: 'viewport-2',
        action: 'Delete a stray track'
      },
      note: 'a stray track'
    },
    {
      args: { footprint: 'board:SOT-23-5', ids: ['model'] },
      note: "drop a footprint's model link"
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        kind: 'track',
        net: 'SDA',
        expect: 27,
        viewport: 'viewport-2',
        action: 'Delete SDA tracks'
      },
      note: 'every track of a net, as items_query counted them'
    }
  ],
  request(args) {
    const noViewport = itemsViewportRefusal(args, true, 'deleting a sheet or board item')
    if (noViewport) return noViewport
    const filtered =
      args.kind !== undefined ||
      args.layer !== undefined ||
      args.net !== undefined ||
      args.box !== undefined
    if (!args.ids === !filtered) {
      return refused(
        'Name the items one way: ids, or filters (kind, layer, net, box).',
        'Pass ids from items_query, or the filters with expect.'
      )
    }
    if (filtered) {
      if (!args.board || args.footprint || args.symbol)
        return refused(
          'Delete by filter is for a board.',
          'Pass board, or list ids on a sheet, a footprint or a symbol.'
        )
      if (args.expect === undefined)
        return refused(
          'A delete by filter needs expect.',
          'Run items_query with the same filters and pass its count as expect.'
        )
      return {
        kind: 'delete-board-items',
        board: args.board,
        ...(args.kind ? { itemKind: args.kind } : {}),
        ...(args.layer ? { layer: args.layer } : {}),
        ...(args.net !== undefined ? { net: args.net } : {}),
        ...(args.box ? { box: args.box } : {}),
        expect: args.expect
      }
    }
    if (args.expect !== undefined)
      return refused('expect goes with the filters.', 'Drop expect when deleting by ids.')
    const ids = args.ids ?? []
    const blank = ids.findIndex((id) => !id)
    if (blank >= 0) {
      return refused(`ids[${blank}] is empty.`, 'Every entry is an item id from items_query.')
    }
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    if (args.symbol) {
      const target = symbolTarget({ symbol: args.symbol, sheet: args.sheet })
      if (isSymbolRefusal(target)) return target
      return { kind: 'delete-symbol-items', ...target, ids }
    }
    if (args.footprint) {
      const target = footprintTarget({ footprint: args.footprint, board: args.board })
      if (isTargetRefusal(target)) return target
      return { kind: 'delete-footprint-items', ...target, ids }
    }
    if (args.board) return { kind: 'delete-board-items', board: args.board, ids }
    return { kind: 'delete-items', ids, ...(args.sheet ? { sheet: args.sheet } : {}) }
  }
})
