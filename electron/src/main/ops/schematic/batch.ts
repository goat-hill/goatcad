/**
 * `schematic.batch` — N edits, one undo step, or none at all.
 *
 * Design: `docs/agent-api.md`. Two things it is for:
 * a script that places fifty parts should cost the user one Ctrl+Z rather than
 * fifty, and an agent should be able to ask what a plan *would* do before
 * committing to it.
 *
 * **Atomicity is structural, not defensive.** The window snapshots the document,
 * runs the operations, and either records one history entry or re-parses the
 * snapshot — `CommandHistory` stores whole documents rather than inverse
 * commands, so a half-applied batch is not a state that exists. `dryRun` is the
 * same move with the entry never pushed.
 *
 * **Named `schematic.batch`, not `batch`.** The doc writes the latter, but a
 * batch is only atomic over one transaction domain, and the one this serves is
 * a sheet: a library write goes to a different file through a different path
 * and could not be rolled back with the sheet. A general `batch` is worth
 * revisiting when board verbs exist and there is a second domain to span.
 */
import type { McpDesignRequest } from '../../../preload/mcpTypes'
import { defineOp, type OpRegistry, type RegisteredOp } from '../registry'
import { s } from '../schema'
import { fail, nearest, notFound, refused } from '../errors'
import { design } from '../design'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'
import { batchViewportArg, entryViewport, viewportMissing } from '../viewport/open'
import { actionMissing, batchActionArg, oneLine } from '../viewport/action'

/** The ops a sheet batch holds, by registry name: what the schematic editor can
 *  serve inside one snapshot. */
const BATCH_OPS = [
  'schematic.describe',
  'items.get',
  'items.query',
  'items.update',
  'items.delete',
  'items.create',
  'schematic.place_symbol',
  'schematic.bind',
  'schematic.connect',
  'schematic.wire',
  'schematic.cleanup',
  'schematic.check'
]

/** The requests those ops build on a sheet. An item op on a symbol, footprint or
 *  board builds another — a different transaction. */
const SHEET_KINDS = new Set([
  'describe-schematic',
  'get-items',
  'query-items',
  'update-item',
  'delete-items',
  'create-item',
  'place-symbol',
  'bind-part',
  'connect-pins',
  'draw-wire',
  'cleanup-schematic',
  'check-schematic'
])

/**
 * Build the batch operation against a registry that does not contain it.
 *
 * That is not a trick to dodge a circular import — it is the rule: a batch
 * cannot hold a batch, and resolving against a registry where the name does not
 * exist is how that stays true without a special case to forget.
 */
export const makeSchematicBatch = (inner: OpRegistry): RegisteredOp =>
  defineOp({
    name: 'schematic.batch',
    batchOps: BATCH_OPS,
    scope: 'schematic',
    mutates: true,
    summary: 'Run several schematic ops on one sheet as one undo step, or dry-run them.',
    guidance:
      "Every op is validated before any runs; if one fails, nothing is written and the answer is that op's own failure, its detail naming the index. Read ops are allowed inside; library writes, schematic_annotate and nested batches are refused: call them on their own. Pass checks and viewport on the batch, not on an entry. dryRun answers the change set (and check delta) without writing.",
    input: s.object({
      sheet: sheetFileArg(),
      ops: s
        .array(
          s.object({
            op: s.string().trim().describe('Op name, dotted, e.g. "schematic.place_symbol".'),
            args: s.json().describe("The op's arguments.").optional()
          })
        )
        .min(1)
        .describe('Ops, run in order.'),
      dryRun: s
        .boolean()
        .describe('Return what the batch would change without writing. Default false.')
        .optional(),
      viewport: batchViewportArg,
      action: batchActionArg,
      checks: checksArg
    }),
    examples: [
      {
        args: {
          dryRun: true,
          ops: [
            {
              op: 'schematic.place_symbol',
              args: { symbol: 'Device:C', value: '100nF', at: { x: 116.84, y: 71.12 } }
            },
            { op: 'schematic.connect', args: { net: 'VDD_3V3', pins: ['C1.1'] } }
          ],
          viewport: 'viewport-1',
          action: 'Add C1 on VDD_3V3'
        },
        note: 'dry-run a place and its connection'
      }
    ],
    async run(args, ctx) {
      const planned: McpDesignRequest[] = []
      const names: string[] = []

      for (let index = 0; index < args.ops.length; index += 1) {
        const entry = args.ops[index]
        const op = inner.get(entry.op)
        if (!op) {
          return notFound(
            `Operation ${index} names \`${entry.op}\`, which is not something a batch can run.`,
            'Only schematic operations can be batched, and a batch cannot contain a batch. Call GET /v1/ops, or use the tool list, for the names.',
            { candidates: nearest(entry.op, inner.names()) }
          )
        }
        if (!op.designRequest || !BATCH_OPS.includes(op.name)) {
          return refused(
            `Operation ${index} (\`${entry.op}\`) cannot run in a sheet batch.`,
            `A sheet batch holds ${BATCH_OPS.join(', ')}. Call this one on its own.`
          )
        }

        const given = entry.args ?? {}
        if (given.checks !== undefined) {
          return refused(
            `Operation ${index} asks for its own checks.`,
            'A batch is checked as one write: pass checks on the batch, not on an entry.'
          )
        }
        const viewport = entryViewport(op, given, index, args)
        if ('ok' in viewport) return viewport
        const built = op.designRequest({ ...given, ...viewport })
        if (!built.ok) {
          if (built.error.path === '/viewport')
            return viewportMissing(`operation ${index} (\`${entry.op}\`)`, 'viewport on the batch')
          if (built.error.path === '/action')
            return actionMissing(`operation ${index} (\`${entry.op}\`)`, 'action on the batch')
          // Re-pointed at the batch's own arguments, so the caller can find the
          // entry that is wrong without counting.
          return fail({
            ...built.error,
            message: `Operation ${index} (\`${entry.op}\`): ${built.error.message}`,
            path: `/ops/${index}/args${built.error.path ?? ''}`
          })
        }
        if (!SHEET_KINDS.has(built.request.kind)) {
          return refused(
            `Operation ${index} (\`${entry.op}\`) writes a library file, not the sheet.`,
            'A batch is atomic over one sheet, and a library write could not be rolled back with it. Call this one on its own.'
          )
        }
        planned.push(built.request)
        names.push(op.name)
      }

      return design(ctx, {
        kind: 'batch',
        ops: planned,
        names,
        ...(args.sheet ? { sheet: args.sheet } : {}),
        ...(args.checks === true ? { checks: true } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {}),
        ...(args.viewport ? { viewport: args.viewport } : {}),
        ...(args.action ? { action: oneLine(args.action) } : {})
      })
    }
  })
