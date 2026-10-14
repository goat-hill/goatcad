/**
 * The agent's door to one footprint: `items.*`, `footprint.check` and
 * `footprint.batch` with a `footprint` argument — a library footprint by its
 * id, or a placed one's board copy by its reference and board, reached through
 * the design-copy session Edit footprint… opens (`lib/designCopy.ts`).
 *
 * The same shape as the sheet and library doors: a map from request kind to
 * handler over a context the window supplies. Reads reach any tier and prefer
 * an open tab's buffer to the disk; writes reach only the project's own
 * library and land through the footprint editor's session, so each is one
 * undo step on that tab and the tab goes dirty like a hand edit.
 *
 * Every write is applied to a scratch parse first. A refusal therefore leaves
 * the document untouched, a dry run is the same move with nothing committed,
 * and a batch is atomic without the session knowing batches exist.
 */
import type {
  McpBatchFootprintRequest,
  McpChanged,
  McpCheckAnswer,
  McpCheckFootprintRequest,
  McpCreateFootprintItemRequest,
  McpDeleteFootprintItemsRequest,
  McpDesignRequest,
  McpFootprintTarget,
  McpGetFootprintItemsRequest,
  McpQueryFootprintItemsRequest,
  McpTransformFootprintItemsRequest,
  McpUndoFootprintRequest,
  McpUpdateFootprintItemRequest,
  McpWriteAnswer
} from '../../../../preload/mcpTypes'
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  type KicadFootprint,
  type SExprList
} from '../kicad/footprint'
import type { TextSession } from '../document/textSession'
import { checkCodeFilter, checkDelta, compactDelta, type CheckResult } from '../schematic/checks'
import { checkAnswer } from '../symbol/checkAnswer'
import { tk, type MessageKey } from '../messageKey'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { FOOTPRINT_CHECK_RULES, footprintChecks } from './footprintChecks'
import { footprintExtents } from './footprintExtent'
import type { MmRect, ModelFacts } from '../engine/board3d/modelFacts'
import { cappedGuidance } from '../queryPage'
import { changedBetween, historyAnswer, historyGuidance, stepHistory } from '../historyStep'
import {
  createItem,
  deleteItems,
  footprintItems,
  footprintNarrowings,
  itemRow,
  queryItems,
  resolveItem,
  updateItem,
  type FootprintItem,
  type FootprintQuery,
  type ItemFailure
} from './footprintItems'
import { transformFootprintItemsById } from './footprintItemsTransform'

export type FootprintRequest =
  | McpGetFootprintItemsRequest
  | McpQueryFootprintItemsRequest
  | McpUpdateFootprintItemRequest
  | McpDeleteFootprintItemsRequest
  | McpCreateFootprintItemRequest
  | McpCheckFootprintRequest
  | McpBatchFootprintRequest
  | McpUndoFootprintRequest
  | McpTransformFootprintItemsRequest

type EditRequest =
  | McpUpdateFootprintItemRequest
  | McpDeleteFootprintItemsRequest
  | McpCreateFootprintItemRequest
  | McpTransformFootprintItemsRequest

const FOOTPRINT_KINDS: ReadonlySet<string> = new Set<FootprintRequest['kind']>([
  'get-footprint-items',
  'query-footprint-items',
  'update-footprint-item',
  'delete-footprint-items',
  'create-footprint-item',
  'check-footprint',
  'batch-footprint',
  'undo-footprint',
  'transform-footprint-items'
])

export const isFootprintRequest = (request: McpDesignRequest): request is FootprintRequest =>
  FOOTPRINT_KINDS.has(request.kind)

/**
 * Where a footprint is: a library file and its tier, or — for a placed one —
 * its design-copy path, scope `board`, and the board file it lives in.
 */
export type FootprintResolution =
  | { ok: true; file: string; scope: string; board?: string }
  | { ok: false; error: string; detail: string; candidates?: string[] }

export interface FootprintAgentContext {
  /** A lib id to its file and tier through the library index, or a reference
   *  on a board to that board's copy. */
  resolve(target: McpFootprintTarget): Promise<FootprintResolution>
  /** The file's text: an open tab's buffer first, else the disk. */
  read(file: string): Promise<string | null>
  /** The session that writes the file, opening it behind the user's tab. */
  session(file: string): Promise<TextSession<KicadFootprint, unknown> | null>
  /** A command label in the user's language. */
  label(key: MessageKey, count?: number): string
  /** What a `(model …)` link is (`engine/board3d/modelFacts.ts`): the file, the
   *  box the part fills here, and how that box sits over the land pattern. */
  modelFacts(input: {
    path: string
    footprintFile: string | null
    footprint?: KicadFootprint
    boxes?: { fab: MmRect | null; courtyard: MmRect | null; pads: MmRect | null }
    decode?: boolean
  }): Promise<ModelFacts>
}

export interface FootprintAgent {
  dispatch(request: FootprintRequest): Promise<unknown>
}

type Failure = { error: string; detail?: string; candidates?: string[] }

const failure = (outcome: ItemFailure): Failure => ({
  error: outcome.error,
  detail: outcome.detail,
  ...(outcome.candidates?.length ? { candidates: outcome.candidates } : {})
})

/** A read's filter and page as the item query takes it. */
const footprintQueryOf = (
  request: Omit<FootprintQuery, 'kind'> & { itemKind?: FootprintQuery['kind'] }
): FootprintQuery => ({
  ...(request.itemKind ? { kind: request.itemKind } : {}),
  ...(request.layer ? { layer: request.layer } : {}),
  ...(request.number !== undefined ? { number: request.number } : {}),
  ...(request.box ? { box: request.box } : {}),
  ...(request.near ? { near: request.near } : {}),
  ...(request.radius !== undefined ? { radius: request.radius } : {}),
  ...(request.limit !== undefined ? { limit: request.limit } : {}),
  ...(request.offset !== undefined ? { offset: request.offset } : {})
})

const MODEL_GUIDANCE =
  "Model bounds are millimeters in the footprint's frame, zMax the height above copper; leads past fab (overFab) are normal, insideCourtyard is the containment test. status missing or not-installed is not an error. bounds and fit need modelFit: true on a read, or checks: true on the write."

const READ_GUIDANCE =
  "Millimeters in the footprint's frame, y down. Edit with items_update on these ids, sending only the keys that change."

const WRITE_GUIDANCE =
  "One undo step on the footprint's tab, now unsaved; project_save writes it. render_footprint shows the change."

const BOARD_COPY_GUIDANCE =
  "One undo step on the board's own copy, on the board's tab, now unsaved; project_save writes it. The library is untouched. render_footprint with board shows the copy."

/** A resolved footprint as an answer names it. */
type Located = { file: string; scope: string; board?: string }

const located = (target: McpFootprintTarget, where: Located): Record<string, unknown> => ({
  footprint: target.footprint,
  ...(where.board ? { board: where.board } : {}),
  tier: where.scope
})

/** The op a batch entry came from, as its failure names it. */
const OP_NAMES: Record<string, string> = {
  'get-footprint-items': 'items.get',
  'query-footprint-items': 'items.query',
  'update-footprint-item': 'items.update',
  'delete-footprint-items': 'items.delete',
  'create-footprint-item': 'items.create',
  'transform-footprint-items': 'items.transform'
}

/** Text ending in a stop, so a sentence can follow it. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

/** The file a model path resolves against: the board for its copy, else the footprint's own. */
const modelBase = (where: Located): string => where.board ?? where.file

/** What the answer says about the checks: read them, or how to ask for them. */
const checksGuidance = (checked: boolean): string =>
  checked
    ? 'Read checks for what it broke or fixed.'
    : 'No checks ran: pass checks: true for what an edit broke or fixed, or call footprint_check.'

/** An edit's result on the scratch copy. */
interface Applied {
  changed: McpChanged
}

export const createFootprintAgent = (ctx: FootprintAgentContext): FootprintAgent => {
  const load = async (
    target: McpFootprintTarget
  ): Promise<({ ok: true; text: string } & Located) | { ok: false; failure: Failure }> => {
    const resolved = await ctx.resolve(target)
    if (!resolved.ok) {
      return {
        ok: false,
        failure: {
          error: resolved.error,
          detail: resolved.detail,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {})
        }
      }
    }
    const text = await ctx.read(resolved.file)
    if (text === null) {
      return { ok: false, failure: { error: 'footprint-unreadable', detail: resolved.file } }
    }
    return {
      ok: true,
      file: resolved.file,
      scope: resolved.scope,
      ...(resolved.board ? { board: resolved.board } : {}),
      text
    }
  }

  const parse = (text: string, file: string): KicadFootprint | Failure => {
    try {
      return parseKicadFootprint(text)
    } catch (error) {
      return {
        error: 'footprint-unreadable',
        detail: `${file}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  const isFailure = (value: unknown): value is Failure =>
    typeof value === 'object' && value !== null && typeof (value as Failure).error === 'string'

  /** The model row, with its `modelFacts` merged in. Rows of every other kind are
   *  already complete; only this one needs a file read to answer. Where the file
   *  lands (`bounds`, `fit`) needs it decoded, which is slow: only when `fit`. */
  const withModelFacts = async (
    rows: Record<string, unknown>[],
    fp: KicadFootprint,
    file: string,
    fit: boolean
  ): Promise<Record<string, unknown>[]> => {
    const index = rows.findIndex((row) => row.kind === 'model')
    if (index < 0) return rows
    const extents = footprintExtents(fp)
    const frame = (
      extent: { minX: number; minY: number; maxX: number; maxY: number } | null
    ): MmRect | null =>
      extent
        ? {
            x: nmToMm(extent.minX as Nm),
            y: nmToMm(extent.minY as Nm),
            width: nmToMm((extent.maxX - extent.minX) as Nm),
            height: nmToMm((extent.maxY - extent.minY) as Nm)
          }
        : null
    const facts = await ctx.modelFacts({
      path: String(rows[index].path ?? ''),
      footprintFile: file,
      footprint: fp,
      boxes: {
        fab: frame(extents.fab),
        courtyard: frame(extents.courtyard),
        pads: frame(extents.pads)
      },
      decode: fit
    })
    const enriched = {
      ...rows[index],
      status: facts.status,
      resolved: facts.resolved,
      ...(fit
        ? {
            bounds: facts.bounds,
            ...(facts.fit ? { fit: facts.fit } : {}),
            ...(facts.status === 'resolved'
              ? { triangles: facts.triangles, meshes: facts.meshes }
              : {})
          }
        : {})
    }
    return rows.map((row, at) => (at === index ? enriched : row))
  }

  const getItems = async (request: McpGetFootprintItemsRequest): Promise<unknown> => {
    const loaded = await load(request)
    if (!loaded.ok) return loaded.failure
    const fp = parse(loaded.text, loaded.file)
    if (isFailure(fp)) return fp
    const all = footprintItems(fp)
    const rows: Record<string, unknown>[] = []
    for (const id of request.ids) {
      const found = resolveItem(all, id)
      if (!found.ok) return failure(found)
      rows.push(itemRow(found.item))
    }
    const items = await withModelFacts(rows, fp, modelBase(loaded), request.modelFit === true)
    return {
      ...located(request, loaded),
      count: items.length,
      items,
      guidance: items.some((row) => row.kind === 'model')
        ? `${READ_GUIDANCE} ${MODEL_GUIDANCE}`
        : READ_GUIDANCE
    }
  }

  const queryAll = async (request: McpQueryFootprintItemsRequest): Promise<unknown> => {
    const loaded = await load(request)
    if (!loaded.ok) return loaded.failure
    const fp = parse(loaded.text, loaded.file)
    if (isFailure(fp)) return fp
    const query = footprintQueryOf(request)
    const page = queryItems(footprintItems(fp), query)
    const { rows, total } = page
    const items = await withModelFacts(
      rows.map(itemRow),
      fp,
      modelBase(loaded),
      request.modelFit === true
    )
    return {
      ...located(request, loaded),
      count: total,
      items,
      ...(page.offset ? { offset: page.offset } : {}),
      ...(page.truncated ? { truncated: true } : {}),
      guidance: [
        ...(page.truncated ? [cappedGuidance(page, footprintNarrowings(page.matches, query))] : []),
        READ_GUIDANCE,
        ...(items.some((row) => row.kind === 'model') ? [MODEL_GUIDANCE] : [])
      ].join(' ')
    }
  }

  const check = async (request: McpCheckFootprintRequest): Promise<unknown> => {
    const only = checkCodeFilter(request.codes, FOOTPRINT_CHECK_RULES)
    if (typeof only !== 'function') return only
    const loaded = await load(request)
    if (!loaded.ok) return loaded.failure
    const fp = parse(loaded.text, loaded.file)
    if (isFailure(fp)) return fp
    const answer: McpCheckAnswer = checkAnswer(
      only(footprintChecks(fp)),
      FOOTPRINT_CHECK_RULES,
      'Fix the named items with items_update and check again.',
      request.codes
    )
    return {
      ...located(request, loaded),
      ...(request.codes ? { codes: request.codes } : {}),
      ...answer
    }
  }

  /** One edit on the scratch copy; the scratch is left edited on success. */
  const applyEdit = (fp: KicadFootprint, request: EditRequest): Applied | Failure => {
    const items = footprintItems(fp)
    switch (request.kind) {
      case 'update-footprint-item': {
        const found = resolveItem(items, request.id)
        if (!found.ok) return failure(found)
        const kindIndex = items.filter((item) => item.kind === found.item.kind).indexOf(found.item)
        const outcome = updateItem(fp, found.item, request.record)
        if (!outcome.ok) return failure(outcome)
        const after = footprintItems(parseKicadFootprint(serializeKicadFootprint(fp)))
        const moved = after.filter((item) => item.kind === found.item.kind)[kindIndex]
        return {
          changed: { created: [], updated: [moved?.id ?? found.item.id], deleted: [] }
        }
      }
      case 'delete-footprint-items': {
        const targets: FootprintItem[] = []
        for (const id of request.ids) {
          const found = resolveItem(items, id)
          if (!found.ok) return failure(found)
          targets.push(found.item)
        }
        const outcome = deleteItems(fp, targets)
        if (!outcome.ok) return failure(outcome)
        return { changed: { created: [], updated: [], deleted: targets.map((item) => item.id) } }
      }
      case 'create-footprint-item': {
        const outcome = createItem(fp, request.itemKind, request.record)
        if (!outcome.ok) return failure(outcome)
        return { changed: { created: [outcome.id], updated: [], deleted: [] } }
      }
      case 'transform-footprint-items': {
        const outcome = transformFootprintItemsById(fp, request)
        if (!outcome.ok) {
          const { error, detail, candidates } = outcome
          return { error, detail, ...(candidates?.length ? { candidates } : {}) }
        }
        return { changed: outcome.changed }
      }
    }
  }

  /**
   * Run edits against a scratch parse of the footprint and, unless `dryRun`,
   * land the result as one command on the file's session.
   */
  const commit = async (
    target: McpFootprintTarget,
    label: string,
    dryRun: boolean,
    checks: boolean,
    run: (
      scratch: KicadFootprint
    ) => Promise<{ changed: Applied['changed']; extra?: Record<string, unknown> } | Failure>
  ): Promise<unknown> => {
    const resolved = await ctx.resolve(target)
    if (!resolved.ok) {
      return {
        error: resolved.error,
        detail: resolved.detail,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {})
      }
    }
    if (resolved.scope !== 'project' && !resolved.board) {
      return {
        error: 'library-read-only',
        detail: `${target.footprint} is in the ${resolved.scope} library.`
      }
    }
    const session = await ctx.session(resolved.file)
    const model = session?.model()
    if (!session || !model) {
      return { error: 'footprint-unreadable', detail: session?.parseError() ?? resolved.file }
    }
    const text = serializeKicadFootprint(model)
    const beforeChecks: CheckResult[] | null = checks
      ? footprintChecks(parseKicadFootprint(text))
      : null
    const scratch = parseKicadFootprint(text)
    const outcome = await run(scratch)
    if (isFailure(outcome)) return outcome
    const afterText = serializeKicadFootprint(scratch)
    let committed: boolean
    if (!dryRun && afterText !== text) {
      committed = session.runCommand(label, (live) => {
        ;(live._raw as SExprList).children = (
          parseKicadFootprint(afterText)._raw as SExprList
        ).children
      })
      if (!committed) {
        return { error: 'read-only', detail: `${resolved.file} could not be written.` }
      }
    }
    const touchedModel = [
      ...outcome.changed.created,
      ...outcome.changed.updated,
      ...outcome.changed.deleted
    ].includes('model')
    // A model written is a file claim, and the claim is what the caller has to
    // check: the answer says whether the file is there and where the part lands.
    const modelRow = touchedModel
      ? (
          await withModelFacts(
            footprintItems(scratch)
              .filter((item) => item.kind === 'model')
              .map(itemRow),
            scratch,
            modelBase(resolved),
            checks
          )
        )[0]
      : undefined
    const answer: McpWriteAnswer & Record<string, unknown> = {
      ...located(target, resolved),
      ...(dryRun ? { dryRun: true as const } : {}),
      changed: outcome.changed,
      ...(modelRow ? { model: modelRow } : {}),
      ...(outcome.extra ?? {}),
      ...(beforeChecks
        ? {
            checks: compactDelta(
              checkDelta(beforeChecks, footprintChecks(parseKicadFootprint(afterText)))
            )
          }
        : {}),
      revision: session.revision(),
      guidance: [
        dryRun
          ? 'Nothing was written. Run again without dryRun to commit.'
          : resolved.board
            ? BOARD_COPY_GUIDANCE
            : WRITE_GUIDANCE,
        checksGuidance(beforeChecks !== null),
        ...(modelRow ? [MODEL_GUIDANCE] : [])
      ].join(' ')
    }
    return answer
  }

  /** The editor's own label for the transform. */
  const transformLabel = (request: McpTransformFootprintItemsRequest): string => {
    const count = request.ids.length
    switch (request.transform) {
      case 'rotate':
        return ctx.label(tk('footprintEditor.commands.rotate'))
      case 'mirror':
        return ctx.label(tk('footprintEditor.commands.mirror'))
      case 'flip':
        return ctx.label(tk('footprintEditor.commands.flip'))
      case 'duplicate':
        return ctx.label(tk('commandLabels.duplicate'), count)
      case 'anchor':
        return ctx.label(tk('footprintEditor.commands.moveAnchor'))
      default:
        return ctx.label(tk('commandLabels.move'), count)
    }
  }

  const edit = (request: EditRequest): Promise<unknown> => {
    const label =
      request.kind === 'delete-footprint-items'
        ? ctx.label(tk('commandLabels.delete'), request.ids.length)
        : request.kind === 'create-footprint-item'
          ? ctx.label(tk('commandLabels.addFootprintItem'))
          : request.kind === 'transform-footprint-items'
            ? transformLabel(request)
            : ctx.label(tk('commandLabels.editFootprintItem'))
    return commit(request, label, false, request.checks === true, async (scratch) =>
      applyEdit(scratch, request)
    )
  }

  const batch = (request: McpBatchFootprintRequest): Promise<unknown> =>
    commit(
      request,
      ctx.label(tk('commandLabels.agentBatch'), request.ops.length),
      request.dryRun === true,
      request.checks === true,
      async (scratch) => {
        const changed: Applied['changed'] = { created: [], updated: [], deleted: [] }
        const results: unknown[] = []
        for (const [index, op] of request.ops.entries()) {
          const fail = (outcome: Failure): Failure => ({
            ...outcome,
            detail: `Operation ${index} (\`${OP_NAMES[op.kind] ?? op.kind}\`): ${sentence(outcome.detail ?? outcome.error)} Nothing was written.`
          })
          if (
            op.kind === 'update-footprint-item' ||
            op.kind === 'delete-footprint-items' ||
            op.kind === 'create-footprint-item' ||
            op.kind === 'transform-footprint-items'
          ) {
            const applied = applyEdit(scratch, op)
            if (isFailure(applied)) return fail(applied)
            changed.created.push(...applied.changed.created)
            changed.updated.push(...applied.changed.updated)
            changed.deleted.push(...applied.changed.deleted)
            results.push({ changed: applied.changed })
            continue
          }
          // Reads see the batch's state so far.
          const items = footprintItems(parseKicadFootprint(serializeKicadFootprint(scratch)))
          if (op.kind === 'get-footprint-items') {
            const rows: Record<string, unknown>[] = []
            for (const id of op.ids) {
              const found = resolveItem(items, id)
              if (!found.ok) return fail(failure(found))
              rows.push(itemRow(found.item))
            }
            results.push({ count: rows.length, items: rows })
            continue
          }
          if (op.kind === 'query-footprint-items') {
            const page = queryItems(items, footprintQueryOf(op))
            results.push({
              count: page.total,
              items: page.rows.map(itemRow),
              ...(page.offset ? { offset: page.offset } : {}),
              ...(page.truncated ? { truncated: true } : {})
            })
            continue
          }
          return fail({
            error: 'not-applicable',
            detail: `${op.kind} cannot run in a footprint batch`
          })
        }
        return { changed, extra: { results } }
      }
    )

  /** Edit ▸ Undo or Redo on the tab that holds the footprint, `steps` times or not at all. */
  const step = async (request: McpUndoFootprintRequest): Promise<unknown> => {
    const resolved = await ctx.resolve(request)
    if (!resolved.ok) {
      return {
        error: resolved.error,
        detail: resolved.detail,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {})
      }
    }
    if (resolved.scope !== 'project' && !resolved.board) {
      return {
        error: 'library-read-only',
        detail: `${request.footprint} is in the ${resolved.scope} library.`
      }
    }
    const session = await ctx.session(resolved.file)
    if (!session?.model()) {
      return { error: 'footprint-unreadable', detail: session?.parseError() ?? resolved.file }
    }
    const prints = (): Map<string, unknown> => {
      const model = session.model()
      return new Map(
        model ? footprintItems(model).map((item) => [item.id, JSON.stringify(itemRow(item))]) : []
      )
    }
    const redo = request.redo === true
    const before = prints()
    const stepped = stepHistory(session, redo, request.steps, 'The footprint')
    if (!stepped.ok) return { error: stepped.error, detail: stepped.detail }
    return {
      ...located(request, resolved),
      ...historyAnswer(
        redo,
        stepped.labels,
        changedBetween(before, prints()),
        session,
        session.revision()
      ),
      guidance: historyGuidance(redo)
    }
  }

  const handlers: {
    [K in FootprintRequest['kind']]: (request: FootprintRequest) => Promise<unknown>
  } = {
    'get-footprint-items': (request) => getItems(request as McpGetFootprintItemsRequest),
    'query-footprint-items': (request) => queryAll(request as McpQueryFootprintItemsRequest),
    'update-footprint-item': (request) => edit(request as McpUpdateFootprintItemRequest),
    'delete-footprint-items': (request) => edit(request as McpDeleteFootprintItemsRequest),
    'create-footprint-item': (request) => edit(request as McpCreateFootprintItemRequest),
    'check-footprint': (request) => check(request as McpCheckFootprintRequest),
    'batch-footprint': (request) => batch(request as McpBatchFootprintRequest),
    'undo-footprint': (request) => step(request as McpUndoFootprintRequest),
    'transform-footprint-items': (request) => edit(request as McpTransformFootprintItemsRequest)
  }

  return { dispatch: (request) => handlers[request.kind](request) }
}
