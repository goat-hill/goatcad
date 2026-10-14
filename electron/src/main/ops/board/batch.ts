/**
 * `board.batch` — several item operations on one board as one undo step, or
 * none.
 *
 * The board twin of `schematic.batch` and `footprint.batch`: atomic
 * over one board, so a sheet or footprint edit is refused from it. The window
 * applies every entry inside one command on the board's session, which puts
 * the board back when an entry is refused, so a failure halfway writes
 * nothing.
 */
import type { McpDesignRequest } from '../../../preload/mcpTypes'
import { defineOp, type OpRegistry, type RegisteredOp } from '../registry'
import { s } from '../schema'
import { fail, nearest, notFound, refused } from '../errors'
import { design } from '../design'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'
import { batchViewportArg, entryViewport, viewportMissing } from '../viewport/open'
import { actionMissing, batchActionArg, oneLine } from '../viewport/action'

/** The operations a board batch holds, by registry name. */
const BATCH_OPS = [
  'items.get',
  'items.query',
  'items.update',
  'items.delete',
  'items.create',
  'items.transform',
  'board.place_footprint'
]

const BOARD_REQUEST_KINDS = new Set([
  'get-board-items',
  'query-board-items',
  'update-board-item',
  'delete-board-items',
  'create-board-item',
  'transform-board-items',
  'place-footprint-board'
])

/**
 * What an entry is built against when the batch names no board: the entries
 * never carry their own, and the window resolves the batch's board once.
 */
const THIS_BOARD = '(batch)'

export const makeBoardBatch = (inner: OpRegistry): RegisteredOp =>
  defineOp({
    name: 'board.batch',
    batchOps: BATCH_OPS,
    scope: 'board',
    mutates: true,
    summary: 'Run several item operations and placements on one board as one undo step.',
    guidance:
      "Entries are items_get, items_query, items_update, items_delete, items_create, items_transform and board_place_footprint, without board, checks, dryRun or viewport: those go on the batch. Reads see the edits before them; an entry can name an id an earlier one created. If any entry fails, nothing is written. results holds each entry's answer, in order. For entries computed in a loop, use app_scripting: `with gc.transaction(board=True, refill=True):`.",
    input: s.object({
      board: s
        .string()
        .trim()
        .describe(`${BOARD_FILE}; omit for the project's one board.`)
        .optional(),
      ops: s
        .array(
          s.object({
            op: s.string().trim().describe('Operation name, e.g. "items.update".'),
            args: s.json().describe('Its arguments, without board, checks or dryRun.').optional()
          })
        )
        .min(1)
        .describe('Run in order.'),
      refill: s
        .boolean()
        .describe('Refill every zone after the batch, in the same undo step.')
        .optional(),
      dryRun: s.boolean().describe('Answer with the changes and write nothing.').optional(),
      viewport: batchViewportArg,
      action: batchActionArg,
      checks: checksArg
    }),
    examples: [
      {
        args: {
          ops: [
            { op: 'items.update', args: { id: 'U1', record: { at: { x: 120, y: 85 } } } },
            {
              op: 'items.update',
              args: { id: 'C4', record: { at: { x: 124, y: 82 }, angle: 90 } }
            },
            {
              op: 'items.update',
              args: { id: 'J1', record: { at: { x: 105, y: 90 }, side: 'back' } }
            }
          ],
          viewport: 'viewport-2',
          action: 'Place C4 and J1'
        },
        note: 'place three parts in one step'
      },
      {
        args: {
          ops: [
            {
              op: 'items.create',
              args: {
                kind: 'rect',
                record: { layer: 'Edge.Cuts', start: { x: 100, y: 70 }, end: { x: 150, y: 110 } }
              }
            },
            {
              op: 'items.create',
              args: {
                kind: 'zone',
                record: {
                  net: 'GND',
                  layers: ['F.Cu', 'B.Cu'],
                  points: [
                    { x: 100, y: 70 },
                    { x: 150, y: 70 },
                    { x: 150, y: 110 },
                    { x: 100, y: 110 }
                  ]
                }
              }
            }
          ],
          refill: true,
          viewport: 'viewport-2',
          action: 'Draw outline and GND pour'
        },
        note: 'outline and a filled two-sided ground pour'
      },
      {
        args: {
          ops: [
            {
              op: 'board.place_footprint',
              args: { footprint: 'MountingHole:MountingHole_3.2mm_M3', at: { x: 103.5, y: 73.5 } }
            },
            {
              op: 'board.place_footprint',
              args: {
                footprint: 'TestPoint:TestPoint_Pad_D1.0mm',
                at: { x: 140, y: 100 },
                side: 'back'
              }
            }
          ],
          viewport: 'viewport-2',
          action: 'Add hole and test point'
        },
        note: 'a mounting hole and a back-side test point'
      }
    ],
    async run(args, ctx) {
      const planned: McpDesignRequest[] = []
      for (let index = 0; index < args.ops.length; index += 1) {
        const entry = args.ops[index]
        const op = inner.get(entry.op)
        if (!op?.designRequest || !BATCH_OPS.includes(op.name)) {
          return notFound(
            `Operation ${index} names \`${entry.op}\`, which a board batch cannot run.`,
            `A board batch holds ${BATCH_OPS.join(', ')}.`,
            { candidates: nearest(entry.op, BATCH_OPS) }
          )
        }
        const given = entry.args ?? {}
        // A placement's footprint is the lib id it places, not a definition to act on.
        const documents =
          op.name === 'board.place_footprint'
            ? (['sheet', 'board'] as const)
            : (['sheet', 'footprint', 'board'] as const)
        const named = documents.find((key) => given[key] !== undefined)
        if (named) {
          return refused(
            `Operation ${index} names its own ${named}.`,
            'A board batch is atomic over the one board it names; drop the argument from the entry.'
          )
        }
        if (given.checks !== undefined) {
          return refused(
            `Operation ${index} asks for its own checks.`,
            'A batch is checked as one write: pass checks on the batch, not on an entry.'
          )
        }
        if (given.revision !== undefined) {
          return refused(
            `Operation ${index} pins its own revision.`,
            'A batch reads one snapshot of the board; drop revision from the entry.'
          )
        }
        if (given.dryRun !== undefined) {
          return refused(
            `Operation ${index} asks for its own dryRun.`,
            'A batch is previewed as one write: pass dryRun on the batch, not on an entry.'
          )
        }
        const viewport = entryViewport(op, given, index, args)
        if ('ok' in viewport) return viewport
        const built = op.designRequest({
          ...given,
          ...viewport,
          board: args.board ?? THIS_BOARD
        })
        if (!built.ok) {
          if (built.error.path === '/viewport')
            return viewportMissing(`operation ${index} (\`${entry.op}\`)`, 'viewport on the batch')
          if (built.error.path === '/action')
            return actionMissing(`operation ${index} (\`${entry.op}\`)`, 'action on the batch')
          return fail({
            ...built.error,
            message: `Operation ${index} (\`${entry.op}\`): ${built.error.message}`,
            path: `/ops/${index}/args${built.error.path ?? ''}`
          })
        }
        if (!BOARD_REQUEST_KINDS.has(built.request.kind)) {
          return refused(
            `Operation ${index} (\`${entry.op}\`) does not act on board items.`,
            'Call it on its own.'
          )
        }
        planned.push(built.request)
      }
      return design(ctx, {
        kind: 'batch-board',
        ...(args.board ? { board: args.board } : {}),
        ops: planned,
        ...(args.refill === true ? { refill: true } : {}),
        ...(args.checks === true ? { checks: true } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {}),
        ...(args.viewport ? { viewport: args.viewport } : {}),
        ...(args.action ? { action: oneLine(args.action) } : {})
      })
    }
  })
