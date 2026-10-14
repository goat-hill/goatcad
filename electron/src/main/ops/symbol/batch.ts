/**
 * `symbol.batch` — several item operations on one symbol definition as one
 * undo step, or none: a project library symbol, or a sheet's copy of a placed
 * one. The symbol twin of `footprint.batch`; the window applies every entry to
 * a scratch copy first, so a failure halfway writes nothing.
 */
import type { McpDesignRequest } from '../../../preload/mcpTypes'
import { defineOp, type OpRegistry, type RegisteredOp } from '../registry'
import { s } from '../schema'
import { fail, nearest, notFound, refused } from '../errors'
import { design } from '../design'
import { checksArg } from '../checksArg'
import { isSymbolRefusal, symbolTarget } from './target'
import { SHEET_FILE } from '../fileArgs'

/** The operations a symbol batch holds, by registry name. */
const ITEM_OPS = [
  'items.get',
  'items.query',
  'items.update',
  'items.delete',
  'items.create',
  'items.transform'
]

const SYMBOL_REQUEST_KINDS = new Set([
  'get-symbol-items',
  'query-symbol-items',
  'update-symbol-item',
  'delete-symbol-items',
  'create-symbol-item',
  'transform-symbol-items'
])

export const makeSymbolBatch = (inner: OpRegistry): RegisteredOp =>
  defineOp({
    name: 'symbol.batch',
    scope: 'project',
    mutates: true,
    summary:
      'Run several item operations on one symbol definition as one undo step, or preview them with dryRun.',
    guidance:
      "Entries are items_get, items_query, items_update, items_delete, items_create and items_transform, without symbol, sheet or checks. Reads see earlier entries' edits. If any entry fails, nothing is written and the answer names its index. A sheet's copy is one step on the sheet's tab; a library symbol, on its library's tab. checks: true adds the check delta.",
    input: s.object({
      symbol: s
        .string()
        .trim()
        .describe(
          'A project library id "Nickname:Name", or a placed reference ("U1") for its sheet\'s copy.'
        ),
      sheet: s
        .string()
        .trim()
        .describe(
          `With a reference: the sheet it is placed on. ${SHEET_FILE}. Omit for the root sheet, else the only open sheet.`
        )
        .optional(),
      ops: s
        .array(
          s.object({
            op: s.string().trim().describe('Operation name, e.g. "items.update".'),
            args: s
              .json()
              .describe("The operation's arguments, without symbol or sheet.")
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
          symbol: 'board:ES8388',
          ops: [
            { op: 'items.update', args: { id: 'pin:7', record: { type: 'power_in' } } },
            { op: 'items.update', args: { id: 'pin:8', record: { type: 'power_in' } } }
          ]
        },
        note: 'two pin types in one step'
      }
    ],
    async run(args, ctx) {
      const target = symbolTarget({ symbol: args.symbol, sheet: args.sheet })
      if (isSymbolRefusal(target)) return target
      const planned: McpDesignRequest[] = []
      for (let index = 0; index < args.ops.length; index += 1) {
        const entry = args.ops[index]
        const op = inner.get(entry.op)
        if (!op?.designRequest || !ITEM_OPS.includes(op.name)) {
          return notFound(
            `Operation ${index} names \`${entry.op}\`, which a symbol batch cannot run.`,
            `A symbol batch holds ${ITEM_OPS.join(', ')}.`,
            { candidates: nearest(entry.op, ITEM_OPS) }
          )
        }
        const given = entry.args ?? {}
        const own = (['sheet', 'symbol', 'footprint', 'board'] as const).find(
          (key) => given[key] !== undefined
        )
        if (own) {
          return refused(
            `Operation ${index} names its own ${own}.`,
            'A symbol batch is atomic over the one symbol it names; drop the argument from the entry.'
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
        if (!SYMBOL_REQUEST_KINDS.has(built.request.kind)) {
          return refused(
            `Operation ${index} (\`${entry.op}\`) does not act on symbol items.`,
            'Call it on its own.'
          )
        }
        planned.push(built.request)
      }
      return design(ctx, {
        kind: 'batch-symbol',
        ...target,
        ops: planned,
        ...(args.checks === true ? { checks: true } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {})
      })
    }
  })
