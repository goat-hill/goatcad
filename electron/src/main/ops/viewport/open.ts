/**
 * `viewport.open` — a box on the person's canvas that shows where an agent is
 * working, labeled as the agent's.
 *
 * Design: docs/agent-api.md, "The agent viewport". The window keeps
 * the viewports (`renderer/src/lib/agentViewports.ts`); main gives each an id
 * unique across windows and keeps one per agent connection
 * (`agentViewportRoutes.ts`). What the box frames comes from the ops that take
 * `viewport`.
 */
import { defineDesignOp, type RegisteredOp } from '../registry'
import { s } from '../schema'
import { BOARD_FILE, SHEET_FILE } from '../fileArgs'
import { invalidArgs, refused, type OpFailure } from '../errors'
import { actionMissing, oneLine } from './action'
import { BOARD_UPDATE_KEYS } from '../../../shared/itemRecords'

/** The longest label a viewport takes, in characters: one short line on the canvas. */
export const VIEWPORT_LABEL_MAX = 40

export const viewportLabelArg = s
  .string()
  .trim()
  .min(1)
  .max(VIEWPORT_LABEL_MAX)
  .describe(
    `Plain text the user reads on the box until the next call's action replaces it, at most ${VIEWPORT_LABEL_MAX} characters.`
  )

/**
 * What sets layout, and so needs a viewport (docs/agent-api.md,
 * "The agent viewport"): where an item is and how big it is. A record key here
 * makes an `items.update` on a sheet or board a layout edit; creating or
 * deleting a sheet or board item always is.
 */
export const LAYOUT_KEYS: ReadonlySet<string> = new Set([
  'at',
  'angle',
  'mirror',
  'side',
  'size',
  'start',
  'mid',
  'end',
  'center',
  'radius',
  'points',
  'box',
  'scale',
  'width',
  'layer',
  'layers',
  'drill'
])

/** A tuning pattern's keys, each of which lays its meanders again. */
const TUNING_KEYS: ReadonlySet<string> = new Set(BOARD_UPDATE_KEYS.tuning_pattern)

/** Whether a record writes layout. */
export const setsLayout = (record: unknown): boolean =>
  typeof record === 'object' &&
  record !== null &&
  Object.keys(record).some((key) => LAYOUT_KEYS.has(key) || TUNING_KEYS.has(key))

/** The rule, said once for every op that takes `viewport`. */
const VIEWPORT_RULE =
  'The viewport_open id the user watches this work in; its box moves to frame what the call drew or changed, labeled with action.'

/** The `viewport` a render or a layout edit takes, and refuses without. */
export const viewportArg = s.string().trim().describe(VIEWPORT_RULE)

/** The `viewport` of an op that sets layout only with some arguments. */
export const layoutViewportArg = s
  .string()
  .trim()
  .describe(
    `${VIEWPORT_RULE} Required on a sheet or board when the call creates or deletes an item, or its record sets ${[...LAYOUT_KEYS].join(', ')} or any tuning pattern key; a symbol or footprint takes none.`
  )
  .optional()

/** A batch's `viewport`, which its entries' rules require. */
export const batchViewportArg = s
  .string()
  .trim()
  .describe(
    'The viewport_open id for the batch; its box frames what the batch changed, labeled with action. Required when an entry sets layout; entries take none.'
  )
  .optional()

/** The refusal of a layout edit made with no viewport. */
export const viewportMissing = (what: string, where = 'viewport'): OpFailure =>
  invalidArgs(
    `\`viewport\` is required: ${what} sets layout.`,
    '/viewport',
    `Open one with viewport_open on this sheet or board and pass its id as ${where}.`
  )

/**
 * An `items.*` call's viewport and action: refused on a symbol or footprint,
 * which has no viewport, and missing on a sheet or board edit that sets layout.
 */
export const itemsViewportRefusal = (
  args: { symbol?: string; footprint?: string; viewport?: string; action?: string },
  layout: boolean,
  what: string
): OpFailure | null => {
  if (args.symbol || args.footprint) {
    const given = args.viewport ? 'viewport' : args.action ? 'action' : null
    return given
      ? invalidArgs(
          `A symbol or footprint takes no ${given}.`,
          `/${given}`,
          `Drop ${given}; viewports are on sheets and boards.`
        )
      : null
  }
  if (!layout) return null
  if (!args.viewport) return viewportMissing(what)
  return args.action ? null : actionMissing(what)
}

/**
 * What a batch entry is built with: the batch's viewport and action, where the
 * entry's op takes them, so the entry's own rule decides whether it needs
 * them. An entry naming its own is refused: one box frames the whole batch.
 */
export const entryViewport = (
  op: RegisteredOp,
  given: Record<string, unknown>,
  index: number,
  batch: { viewport?: string; action?: string }
): { viewport?: string; action?: string } | OpFailure => {
  for (const key of ['viewport', 'action'] as const)
    if (given[key] !== undefined)
      return refused(
        `Operation ${index} names its own ${key}.`,
        `Pass ${key} on the batch; its box frames the whole batch.`
      )
  const properties = (op.inputSchema.properties ?? {}) as Record<string, unknown>
  // An item entry on a symbol or footprint has no viewport; the batch refuses it on its own terms.
  const library =
    op.name.startsWith('items.') && (given.symbol !== undefined || given.footprint !== undefined)
  if (library || !('viewport' in properties)) return {}
  return {
    ...(batch.viewport ? { viewport: batch.viewport } : {}),
    ...(batch.action ? { action: batch.action } : {})
  }
}

export const viewportOpen = defineDesignOp({
  name: 'viewport.open',
  scope: 'project',
  mutates: false,
  summary: "Open a labeled box on the user's canvas that shows where you work, or relabel one.",
  guidance:
    "Answers a viewport id. Every render and every edit that sets layout takes it and an action, and refuses without them; the box frames what each call drew or changed. label is the box's first label; each later call's action (\"Route USB_DP\") replaces it with what is happening now. A connection holds one per workspace: calling this again there relabels and moves it, answering the same id. A document no tab holds opens behind the active one; the user's view never moves. Close it with viewport_close when its block of work is done. It also closes after 10 idle minutes, when its tab closes, when your client disconnects, or when the user closes it; a later call naming it is told which.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`A board to open it on: ${BOARD_FILE}. Not needed with viewport.`)
      .optional(),
    sheet: s
      .string()
      .trim()
      .describe(`A schematic sheet to open it on: ${SHEET_FILE}. Not needed with viewport.`)
      .optional(),
    label: viewportLabelArg,
    viewport: s
      .string()
      .trim()
      .describe('An open viewport to relabel instead of opening one.')
      .optional()
  }),
  examples: [
    { args: { board: 'phone.kicad_pcb', label: 'Placing the charger' }, note: 'on a board' },
    { args: { sheet: 'power.kicad_sch', label: 'Wiring the LDO' }, note: 'on a sheet' },
    { args: { viewport: 'viewport-1', label: 'Checking clearances' }, note: 'relabel' }
  ],
  request: (args, ctx) => ({
    kind: 'open-viewport',
    ...(args.board ? { board: args.board } : {}),
    ...(args.sheet ? { sheet: args.sheet } : {}),
    label: oneLine(args.label),
    ...(ctx?.connection ? { connection: ctx.connection } : {})
  })
})
