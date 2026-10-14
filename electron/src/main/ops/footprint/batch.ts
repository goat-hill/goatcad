/**
 * `footprint.batch` — several item operations on one footprint as one
 * undo step, or none: a project library footprint, or a board's copy of a
 * placed one.
 *
 * The footprint twin
 * of `schematic.batch`: atomic over one document, so a sheet edit is refused
 * from it as a footprint edit is refused from the sheet batch. The window
 * applies every entry to a scratch copy first, so a failure halfway writes
 * nothing.
 */
import type { McpDesignRequest } from '../../../preload/mcpTypes'
import { defineOp, type OpRegistry, type RegisteredOp } from '../registry'
import { s } from '../schema'
import { fail, nearest, notFound, refused } from '../errors'
import { design } from '../design'
import { checksArg } from '../checksArg'
import { footprintTarget, isTargetRefusal } from '../items/footprint'
import { BOARD_FILE } from '../fileArgs'

/** The operations a footprint batch holds, by registry name. */
const ITEM_OPS = [
  'items.get',
  'items.query',
  'items.update',
  'items.delete',
  'items.create',
  'items.transform'
]

const FOOTPRINT_REQUEST_KINDS = new Set([
  'get-footprint-items',
  'query-footprint-items',
  'update-footprint-item',
  'delete-footprint-items',
  'create-footprint-item',
  'transform-footprint-items'
])

export const makeFootprintBatch = (inner: OpRegistry): RegisteredOp =>
  defineOp({
    name: 'footprint.batch',
    scope: 'project',
    mutates: true,
    summary:
      'Run several item operations on one footprint as one undo step, or preview them with dryRun.',
    guidance:
      "Entries are items_get, items_query, items_update, items_delete, items_create and items_transform, without footprint, board or checks. Reads see earlier entries' edits. If any entry fails, nothing is written and the answer names its index. A board's copy is one step on the board's tab; a library footprint, on its own tab. checks: true adds the check delta.",
    input: s.object({
      footprint: s
        .string()
        .trim()
        .describe('A project library id "Nickname:Name", or with board a placed reference ("U1").'),
      board: s
        .string()
        .trim()
        .describe(`With a reference: the board it is placed on. ${BOARD_FILE}.`)
        .optional(),
      ops: s
        .array(
          s.object({
            op: s.string().trim().describe('Operation name, e.g. "items.update".'),
            args: s
              .json()
              .describe("The operation's arguments, without footprint or board.")
              .optional()
          })
        )
        .min(1)
        .describe('Operations, run in order.'),
      dryRun: s
        .boolean()
        .describe('Answer what the batch would change, writing nothing.')
        .optional(),
      checks: checksArg
    }),
    examples: [
      {
        args: {
          footprint: 'board:JST_PH_B4B-PH-K_1x04_P2.00mm_Vertical',
          ops: [
            {
              op: 'items.create',
              args: {
                kind: 'line',
                record: { layer: 'F.Fab', start: { x: -1, y: 2 }, end: { x: 1, y: 2 } }
              }
            },
            { op: 'items.update', args: { id: 'pad:1', record: { shape: 'rect' } } }
          ]
        },
        note: 'a fab line and a square pin 1'
      }
    ],
    async run(args, ctx) {
      if (!args.footprint) {
        return refused('footprint is required.', 'Name the footprint the batch edits.')
      }
      const target = footprintTarget({ footprint: args.footprint, board: args.board })
      if (isTargetRefusal(target)) return target
      const planned: McpDesignRequest[] = []
      for (let index = 0; index < args.ops.length; index += 1) {
        const entry = args.ops[index]
        const op = inner.get(entry.op)
        if (!op?.designRequest || !ITEM_OPS.includes(op.name)) {
          return notFound(
            `Operation ${index} names \`${entry.op}\`, which a footprint batch cannot run.`,
            `A footprint batch holds ${ITEM_OPS.join(', ')}.`,
            { candidates: nearest(entry.op, ITEM_OPS) }
          )
        }
        const given = entry.args ?? {}
        const own = (['sheet', 'footprint', 'board'] as const).find(
          (key) => given[key] !== undefined
        )
        if (own) {
          return refused(
            `Operation ${index} names its own ${own}.`,
            'A footprint batch is atomic over the one footprint it names; drop the argument from the entry.'
          )
        }
        if (given.checks !== undefined) {
          return refused(
            `Operation ${index} asks for its own checks.`,
            'A batch is checked as one write: pass checks on the batch, not on an entry.'
          )
        }
        const built = op.designRequest({ ...given, ...target })
        if (!built.ok) {
          return fail({
            ...built.error,
            message: `Operation ${index} (\`${entry.op}\`): ${built.error.message}`,
            path: `/ops/${index}/args${built.error.path ?? ''}`
          })
        }
        if (!FOOTPRINT_REQUEST_KINDS.has(built.request.kind)) {
          return refused(
            `Operation ${index} (\`${entry.op}\`) does not act on footprint items.`,
            'Call it on its own.'
          )
        }
        planned.push(built.request)
      }
      return design(ctx, {
        kind: 'batch-footprint',
        ...target,
        ops: planned,
        ...(args.checks === true ? { checks: true } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {})
      })
    }
  })
