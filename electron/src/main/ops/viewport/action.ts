/**
 * `action` — what a call that moves the agent's viewport is doing, shown as
 * the box's label in place of the last one ("Route USB_DP"). Required exactly
 * where `viewport` is: every render and layout edit, `route.step` and
 * `route.preview` (which act in their session's viewport), and a batch once.
 *
 * Design: docs/agent-api.md, "The agent viewport". Forwarded onto
 * the window request by `buildRequest` (`registry.ts`), as `checks` is; kept
 * apart from `open.ts` so the registry can name its fix without a cycle.
 */
import { s } from '../schema'
import { invalidArgs, type OpFailure } from '../errors'

/** The longest action, in characters: it replaces the box's label, one short line. */
export const VIEWPORT_ACTION_MAX = 32

const ACTION_RULE = `What this call is doing, at most ${VIEWPORT_ACTION_MAX} characters, e.g. "Route USB_DP"; the viewport's box shows it as its label.`

/** The fix a missing `action` answers with. */
export const ACTION_FIX = `Pass action: a few words on what this call does (at most ${VIEWPORT_ACTION_MAX} characters), e.g. "Move U3 left of J1".`

/** One line of plain text: each run of whitespace, line breaks included, becomes a space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ')

const actionBase = s.string().trim().min(1).max(VIEWPORT_ACTION_MAX)

/** The `action` of a call that always moves the box. */
export const actionArg = actionBase.describe(ACTION_RULE)

/** The `action` of an op whose `viewport` is required only with some arguments (`layoutViewportArg`). */
export const layoutActionArg = actionBase
  .describe(`${ACTION_RULE} Required when viewport is.`)
  .optional()

/** A batch's `action`, which its entries take none of. */
export const batchActionArg = actionBase
  .describe(`${ACTION_RULE} For the whole batch; required when viewport is. Entries take none.`)
  .optional()

/** The refusal of a box-moving call made with no action. */
export const actionMissing = (what: string, where = 'action'): OpFailure =>
  invalidArgs(
    `\`action\` is required: ${what} moves the viewport's box.`,
    '/action',
    ACTION_FIX.replace('Pass action', `Pass ${where}`)
  )
