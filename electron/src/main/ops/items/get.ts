/**
 * `items.get` — the full record of named items on a sheet, a board or a
 * footprint.
 *
 * Design: `docs/agent-api.md`. `describe` is the summary an
 * agent reads first; this is the detail a layout script plans from — every pin
 * of a symbol with its sheet position and free side, the bounding box of a
 * body or a label's text, which net a wire lies on. Ids are the ones `describe`
 * and `items.query` print, never invented.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import {
  bothDocuments,
  footprintArg,
  footprintTarget,
  isTargetRefusal,
  modelFitArg
} from './footprint'
import { refused } from '../errors'
import { boardArg } from './board'
import { itemsSheetArg } from './document'
import { isSymbolRefusal, itemsSymbolArg, symbolTarget } from '../symbol/target'

export const ITEMS_GET_MAX = 50

export const itemsGet = defineDesignOp({
  name: 'items.get',
  scope: 'project',
  mutates: false,
  summary: 'Read items in full by id on a sheet, a board, a footprint or a symbol.',
  guidance:
    'Records come back in the shape items_update takes. Sheet: a symbol lists its box, fields and every pin with position, free side, net and `attached` (the ids sitting on the pin). Ids are a reference ("U1"; one unit of a multi-unit part is "U5A", and "U5" reads every unit), a field ("U1#Value") or a uuid; a pin is not an item. Board: millimeters, y down; a footprint lists its pads ("U1.3") with nets; a field ("U1#Value") reads as the board shows it: at and angle on the board, layer the board\'s. Footprint: its own frame; pads are "pad:<number>", the 3D link "model", its own properties (attributes, overrides) "footprint". A placed footprint (reference with board) reads the board\'s copy in the library frame. Symbol: its own frame, y down; pins are "pin:<number>", graphics "<kind>:<unit>.<style>.<index>", fields "field:<Key>", the definition itself "symbol". A placed symbol (reference, with sheet, else the open or root sheet) reads its sheet\'s copy.',
  input: s.object({
    footprint: footprintArg,
    symbol: itemsSymbolArg,
    board: boardArg,
    sheet: itemsSheetArg,
    ids: s
      .array(s.string().trim())
      .min(1)
      .max(ITEMS_GET_MAX)
      .describe(
        'Item ids, e.g. ["U1", "R1#Value"] on a sheet, ["U1.3"] on a board, ["pad:1"] on a footprint.'
      ),
    modelFit: modelFitArg
  }),
  examples: [
    { args: { ids: ['U1'] }, note: 'a symbol with all of its pins and fields' },
    { args: { ids: ['U1', 'C8', 'C9'] }, note: 'a part and its decoupling, to plan a move' },
    {
      args: { board: 'bitclock.kicad_pcb', ids: ['U1', 'U1.3'] },
      note: 'a placed footprint with its pads, and one pad'
    },
    {
      args: { footprint: 'board:SOT-23-5', ids: ['pad:1', 'model'] },
      note: "a library footprint's pad and its 3D model link"
    },
    {
      args: { footprint: 'J1', board: 'bitclock.kicad_pcb', ids: ['pad:1'] },
      note: "a pad of the board's own copy of J1"
    },
    { args: { symbol: 'U3', ids: ['pin:1', 'field:Value'] }, note: "a pin of U3's sheet copy" }
  ],
  request: (args) => {
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    if (args.modelFit !== undefined && !args.footprint)
      return refused('modelFit is for a footprint.', 'Pass footprint with it, or drop it.')
    if (args.symbol) {
      const target = symbolTarget({ symbol: args.symbol, sheet: args.sheet })
      if (isSymbolRefusal(target)) return target
      return { kind: 'get-symbol-items', ...target, ids: args.ids }
    }
    if (args.footprint) {
      const target = footprintTarget({ footprint: args.footprint, board: args.board })
      if (isTargetRefusal(target)) return target
      return {
        kind: 'get-footprint-items',
        ...target,
        ids: args.ids,
        ...(args.modelFit ? { modelFit: true } : {})
      }
    }
    if (args.board) return { kind: 'get-board-items', board: args.board, ids: args.ids }
    return { kind: 'get-items', ids: args.ids, ...(args.sheet ? { sheet: args.sheet } : {}) }
  }
})
