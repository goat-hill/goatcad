/**
 * `<document>.undo` and `<document>.redo` — Edit ▸ Undo and Redo on one
 * document's undo list, the list its tab keeps for the person and every write.
 *
 * One op per document and verb, as `check` and `batch` are: an undo list
 * belongs to a document, not to its records, so it is not an `items.*` verb.
 * The eight ops are all here: their shared text and step fields, and each
 * document's own arguments and request.
 *
 * Design: `docs/agent-api.md`, "Writes". No revision guard:
 * an open editor's own derived steps (a refill joining the step before it, a
 * merged nudge) move a document's revision without a new step of the
 * person's, so a guard would refuse a safe undo. The answer names every step
 * it took instead (`undone` / `redone`) and what each list would take next.
 */
import type { McpDesignRequest } from '../../preload/mcpTypes'
import { defineDesignOp, type OpExample, type RegisteredOp } from './registry'
import { s, type Schema } from './schema'
import { refused, type OpFailure } from './errors'
import { BOARD_FILE, sheetFileArg } from './fileArgs'
import { viewportArg } from './viewport/open'
import { actionArg } from './viewport/action'
import { isSymbolRefusal, placedSheetArg, symbolArg, symbolTarget } from './symbol/target'
import { footprintTarget, isTargetRefusal } from './items/footprint'

/** The most steps one call takes. */
export const HISTORY_STEPS_MAX = 100

type Domain = 'schematic' | 'board' | 'symbol' | 'footprint'
type HistoryVerb = 'undo' | 'redo'

const stepsArg = s
  .integer()
  .min(1)
  .max(HISTORY_STEPS_MAX)
  .describe('How many steps, newest first. Default 1.')
  .optional()

const WHAT: Record<Domain, string> = {
  schematic: 'a sheet',
  board: 'a board',
  symbol: 'a symbol',
  footprint: 'a footprint'
}

const VERB_TEXT: Record<HistoryVerb, { summary: (what: string) => string; guidance: string }> = {
  undo: {
    summary: (what) => `Undo the last steps on ${what}'s undo list, as Edit ▸ Undo does.`,
    guidance:
      "The list is the tab's: the user's steps and every write's, newest first, each route_finish arrival its own. All steps or none. undone names each step taken back, next what each list would take next; a redo puts them back."
  },
  redo: {
    summary: (what) => `Redo the steps last undone on ${what}'s undo list, as Edit ▸ Redo does.`,
    guidance:
      'Re-applies what an undo took back, newest first; any new edit to the document clears the redo list. All steps or none. redone names each step, next what each list would take next.'
  }
}

const DOMAIN_GUIDANCE: Record<Domain, string> = {
  schematic:
    'Takes viewport; its box frames what the steps changed. A step of an edit across sheets (annotate, bom_update) changes each sheet it touched. A sheet no tab holds has an empty list.',
  board:
    'Takes viewport; its box frames what the steps changed. Zone fills return as each step left them (stale.fills). A board no tab holds has an empty list.',
  symbol:
    "A library symbol's list is its library tab's, so a step may be on another symbol in the library. A placed symbol's steps are its sheet's: schematic_undo.",
  footprint:
    "A library footprint's list is its file's tab. A placed footprint's steps are its board's: board_undo."
}

const SCOPE = {
  schematic: 'schematic',
  board: 'board',
  symbol: 'project',
  footprint: 'project'
} as const

/** The step fields every request carries. */
interface StepFields {
  steps: number
  redo?: true
}

/**
 * A document's undo and redo: the shared text and step fields, over the
 * document's own arguments and request.
 */
const historyOps = <I extends { steps?: number }>(
  domain: Domain,
  input: Schema<I>,
  examples: OpExample[],
  request: (args: I, step: StepFields, verb: HistoryVerb) => McpDesignRequest | OpFailure
): [RegisteredOp, RegisteredOp] =>
  (['undo', 'redo'] as const).map((verb) =>
    defineDesignOp<I>({
      name: `${domain}.${verb}`,
      scope: SCOPE[domain],
      mutates: true,
      summary: VERB_TEXT[verb].summary(WHAT[domain]),
      guidance: `${VERB_TEXT[verb].guidance} ${DOMAIN_GUIDANCE[domain]}`,
      input,
      examples,
      request: (args) =>
        request(args, { steps: args.steps ?? 1, ...(verb === 'redo' ? { redo: true } : {}) }, verb)
    })
  ) as [RegisteredOp, RegisteredOp]

export const [schematicUndo, schematicRedo] = historyOps(
  'schematic',
  s.object({ sheet: sheetFileArg(), steps: stepsArg, viewport: viewportArg, action: actionArg }),
  [
    {
      args: { viewport: 'viewport-1', action: 'Undo the last step' },
      note: 'the last step on the open sheet'
    }
  ],
  (args, step) => ({ kind: 'undo-sheet', ...step, ...(args.sheet ? { sheet: args.sheet } : {}) })
)

export const [boardUndo, boardRedo] = historyOps(
  'board',
  s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    steps: stepsArg,
    viewport: viewportArg,
    action: actionArg
  }),
  [
    {
      args: { board: 'bitclock.kicad_pcb', viewport: 'viewport-2', action: 'Undo the last move' },
      note: 'the last step'
    },
    {
      args: {
        board: 'bitclock.kicad_pcb',
        steps: 3,
        viewport: 'viewport-2',
        action: 'Undo three steps'
      },
      note: 'three steps'
    }
  ],
  (args, step) => ({ kind: 'undo-board', ...step, ...(args.board ? { board: args.board } : {}) })
)

/** A placed symbol's list is its sheet's, whose undo is a layout edit: `schematic.undo`'s. */
export const [symbolUndo, symbolRedo] = historyOps(
  'symbol',
  s.object({ symbol: symbolArg, sheet: placedSheetArg, steps: stepsArg }),
  [{ args: { symbol: 'board:LDO_3V3' }, note: "the library tab's last step" }],
  (args, step, verb) => {
    const target = symbolTarget(args)
    if (isSymbolRefusal(target)) return target
    if (target.sheet !== undefined || !target.symbol.includes(':'))
      return refused(
        `${args.symbol} is placed on a sheet, and its steps are on the sheet's undo list.`,
        `Call schematic_${verb} on the sheet, with viewport and action.`
      )
    return { kind: 'undo-symbol', ...target, ...step }
  }
)

/** A placed footprint's list is its board's, whose undo is a layout edit: `board.undo`'s. */
export const [footprintUndo, footprintRedo] = historyOps(
  'footprint',
  s.object({
    footprint: s
      .string()
      .trim()
      .describe(
        'A library id "Nickname:Name", or with board a placed reference ("U1") for the board\'s copy.'
      ),
    board: s
      .string()
      .trim()
      .describe(`With a reference: the board it is placed on. ${BOARD_FILE}.`)
      .optional(),
    steps: stepsArg
  }),
  [{ args: { footprint: 'board:SOT-23-5' }, note: "the footprint tab's last step" }],
  (args, step, verb) => {
    const target = footprintTarget(args)
    if (isTargetRefusal(target)) return target
    if (target.board !== undefined)
      return refused(
        `${args.footprint} is placed on a board, and its steps are on the board's undo list.`,
        `Call board_${verb} on the board, with viewport and action.`
      )
    return { kind: 'undo-footprint', ...target, ...step }
  }
)
