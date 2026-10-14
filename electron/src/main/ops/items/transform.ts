/**
 * `items.transform` — the symbol, footprint and PCB editors' selection
 * transforms (rotate, mirror, flip, move, duplicate) and the symbol and
 * footprint editors' anchor move, on items by id. A verb rather than record fields: it acts on several items about one
 * pivot, or on every item, as one step (`docs/agent-api.md`, verbs).
 *
 * One op with a `transform` choice, not six: every variant shares the
 * document, the ids and the write answer, and the tool list is paid for on
 * every call. The window applies each with the editor's own geometry
 * (`lib/symbol/symbolItemsTransform.ts`, `lib/footprint/footprintItemsTransform.ts`,
 * `lib/board/boardItemsTransform.ts`). On a board it sets layout, so it takes
 * `viewport` and `action` there, as `items.update` does.
 */
import type { McpItemsTransform } from '../../../preload/mcpTypes'
import { defineDesignOp } from '../registry'
import { s, type OptionalSchema } from '../schema'
import { invalidArgs, type OpFailure } from '../errors'
import { bothDocuments, footprintArg, footprintTarget, isTargetRefusal } from './footprint'
import { checksArg } from '../checksArg'
import { isSymbolRefusal, itemsSymbolArg, placedSheetArg, symbolTarget } from '../symbol/target'
import { boardArg } from './board'
import { itemsViewportRefusal } from '../viewport/open'
import { layoutActionArg } from '../viewport/action'

const TRANSFORMS = ['rotate', 'mirror', 'flip', 'move', 'duplicate', 'anchor'] as const

type Transform = (typeof TRANSFORMS)[number]
type Option = 'angle' | 'axis' | 'about' | 'by' | 'at' | 'pinStep'

/** What each transform takes, the required first. */
const TAKES: Record<Transform, { needs: Option[]; may: Option[] }> = {
  rotate: { needs: ['angle'], may: ['about'] },
  mirror: { needs: ['axis'], may: ['about'] },
  flip: { needs: [], may: ['about'] },
  move: { needs: ['by'], may: [] },
  duplicate: { needs: ['by'], may: ['pinStep'] },
  anchor: { needs: ['at'], may: [] }
}

const OPTIONS: Option[] = ['angle', 'axis', 'about', 'by', 'at', 'pinStep']

/** A point or offset {x, y} in millimeters. */
const point = (what: string): OptionalSchema<{ x: number; y: number }> =>
  s.object({ x: s.number(), y: s.number() }).describe(what).optional()

/** The arguments a transform takes and needs, checked against the document it acts on. */
const transformRefusal = (
  args: Partial<Record<Option, unknown>> & { ids?: string[] },
  transform: Transform,
  on: 'symbol' | 'footprint' | 'board'
): OpFailure | null => {
  const { needs, may } = TAKES[transform]
  const takes = [...needs, ...may]
  const taken = takes.length ? takes.join(', ') : 'nothing beside ids'
  for (const key of OPTIONS) {
    if (args[key] !== undefined && !takes.includes(key)) {
      return invalidArgs(
        `${transform} does not take ${key}.`,
        `/${key}`,
        `${transform} takes ${taken}.`
      )
    }
  }
  const missing = needs.find((key) => args[key] === undefined)
  if (missing) {
    return invalidArgs(
      `${transform} needs ${missing}.`,
      `/${missing}`,
      `${transform} takes ${taken}.`
    )
  }
  if (transform === 'anchor') {
    if (on === 'board') {
      return invalidArgs(
        'A board has no anchor.',
        '/transform',
        'Move the items with transform "move", or pass footprint with board to re-anchor its copy.'
      )
    }
    if (args.ids !== undefined) {
      return invalidArgs(
        'anchor moves every item and takes no ids.',
        '/ids',
        'Drop ids; pass at, the point that becomes the origin.'
      )
    }
  } else if (!args.ids?.length) {
    return invalidArgs(`${transform} needs ids.`, '/ids', 'Pass the item ids from items_query.')
  }
  if (on === 'symbol') {
    if (transform === 'flip') {
      return invalidArgs(
        'A symbol has no sides to flip.',
        '/transform',
        'Mirror it instead: transform "mirror" with axis.'
      )
    }
    if (transform === 'rotate' && (args.angle as number) % 90 !== 0) {
      return invalidArgs(
        'A symbol turns in quarter turns.',
        '/angle',
        'Pass a multiple of 90 degrees.'
      )
    }
  } else if (args.pinStep !== undefined) {
    return invalidArgs(
      'pinStep is for symbol pins.',
      '/pinStep',
      on === 'board'
        ? 'Drop it; a duplicated footprint counts up from its own number to the first free reference.'
        : 'Drop it; a footprint duplicate keeps its pad numbers, which items_update renumbers.'
    )
  }
  return null
}

export const itemsTransform = defineDesignOp({
  name: 'items.transform',
  scope: 'project',
  mutates: true,
  summary:
    'Rotate, mirror, flip, move, duplicate or re-anchor items of a symbol, footprint or board, as its editor does.',
  guidance:
    "Millimeters in the document's frame, y down; angle counterclockwise. One undo step on the tab; a library definition only in the project's library, a placed one (reference with sheet or board) its design's copy. Without about, the pivot is the editor's: symbol, the center of the items' extent; footprint and board, a lone item's own position, else the center of their box (a footprint flips about the origin unless one item flips alone). anchor shifts every item so that at becomes the origin. Symbol: quarter turns; a field only moves; a duplicate numbers its pins on from the highest, or by pinStep from its source. Footprint: flip swaps layers; a padstack pad does not flip; the model and fields do not duplicate. Board (needs viewport): locked items transform too; flip changes side; mirror takes graphics, texts and zones; a duplicated footprint counts up from its own number to the first free reference; tracks stay put.",
  input: s.object({
    symbol: itemsSymbolArg,
    sheet: placedSheetArg,
    footprint: footprintArg,
    board: boardArg,
    transform: s.enum(TRANSFORMS).describe('What to do to the items.'),
    ids: s
      .array(s.string().trim())
      .min(1)
      .max(500)
      .describe('Item ids from items_query or items_get. Every transform but anchor needs them.')
      .optional(),
    angle: s
      .number()
      .describe('rotate: degrees counterclockwise; a symbol takes multiples of 90.')
      .optional(),
    axis: s
      .enum(['x', 'y'] as const)
      .describe('mirror: "x" flips top to bottom, "y" left to right.')
      .optional(),
    about: point("rotate, mirror, flip: the pivot. Default the editor's."),
    by: point('move, duplicate: the offset.'),
    at: point('anchor: the point that becomes the origin, in the current frame.'),
    pinStep: s
      .integer()
      .min(0)
      .describe(
        "Symbol duplicate: step each copied pin's number and name on by this from its source; 1 continues a row."
      )
      .optional(),
    viewport: s
      .string()
      .trim()
      .describe(
        'The viewport_open id the user watches this work in; its box frames what the call changed, labeled with action. Required on a board; a symbol or footprint takes none.'
      )
      .optional(),
    action: layoutActionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { symbol: 'board:ES8388', ids: ['pin:7', 'pin:8'], transform: 'rotate', angle: 90 },
      note: 'turn two pins about their center'
    },
    {
      args: {
        symbol: 'board:Conn_01x08',
        ids: ['pin:1'],
        transform: 'duplicate',
        by: { x: 0, y: 2.54 },
        pinStep: 1
      },
      note: 'repeat a pin down the row, as pin 2'
    },
    {
      args: {
        footprint: 'board:SOT-23-5',
        ids: ['pad:1', 'pad:2', 'pad:3'],
        transform: 'mirror',
        axis: 'y'
      },
      note: 'mirror a pad row left to right'
    },
    {
      args: {
        footprint: 'U1',
        board: 'bitclock.kicad_pcb',
        transform: 'anchor',
        at: { x: -1.27, y: 0 }
      },
      note: "move the origin of the board's copy of U1 to pin 1"
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        ids: ['C3', 'C4', 'R2'],
        transform: 'rotate',
        angle: 90,
        viewport: 'viewport-2',
        action: 'Turn the decoupling group'
      },
      note: 'turn three parts about their center'
    }
  ],
  request(args) {
    const { symbol, sheet, footprint, board, transform, ids } = args
    const conflict = bothDocuments(args)
    if (conflict) return conflict
    if (!symbol && !footprint && !board) {
      return invalidArgs(
        'items_transform acts on a symbol, a footprint or a board.',
        '/symbol',
        'Pass symbol (with sheet for a placed one), footprint (with board for a placed one), or board for its items.'
      )
    }
    const on = symbol ? 'symbol' : footprint ? 'footprint' : 'board'
    const refusal =
      transformRefusal(args, transform, on) ??
      itemsViewportRefusal(args, on === 'board', 'items_transform on a board')
    if (refusal) return refusal
    const spec: McpItemsTransform = {
      transform,
      ids: ids ?? [],
      ...(args.angle !== undefined ? { angle: args.angle } : {}),
      ...(args.axis ? { axis: args.axis } : {}),
      ...(args.about ? { about: args.about } : {}),
      ...(args.by ? { by: args.by } : {}),
      ...(args.at ? { at: args.at } : {}),
      ...(args.pinStep !== undefined ? { pinStep: args.pinStep } : {})
    }
    if (symbol) {
      const target = symbolTarget({ symbol, sheet })
      if (isSymbolRefusal(target)) return target
      return { kind: 'transform-symbol-items', ...target, ...spec }
    }
    if (!footprint) return { kind: 'transform-board-items', board: board as string, ...spec }
    const target = footprintTarget({ footprint, board })
    if (isTargetRefusal(target)) return target
    return { kind: 'transform-footprint-items', ...target, ...spec }
  }
})
