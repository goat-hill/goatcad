/**
 * The agent's door to one symbol definition: `items.*` and `symbol.batch` with
 * a `symbol` argument — a library symbol by its id, or a placed symbol's copy
 * on its sheet by its reference, reached through the design-copy session Edit
 * symbol… opens (`lib/designCopy.ts`).
 *
 * The footprint door's shape (`lib/footprint/footprintAgent.ts`): reads reach
 * any tier; writes reach the project's own library or a sheet's copy and land
 * through the symbol editor's session, one undo step on the tab that holds the
 * file. Every write is applied to a scratch parse first, so a refusal leaves
 * the document untouched, a dry run commits nothing, and a batch is atomic.
 */
import type {
  McpBatchSymbolRequest,
  McpCreateSymbolItemRequest,
  McpDeleteSymbolItemsRequest,
  McpDesignRequest,
  McpGetSymbolItemsRequest,
  McpQuerySymbolItemsRequest,
  McpChanged,
  McpTransformSymbolItemsRequest,
  McpSymbolTarget,
  McpUndoSymbolRequest,
  McpUpdateSymbolItemRequest,
  McpWriteAnswer
} from '../../../../preload/mcpTypes'
import type { TextSession } from '../document/textSession'
import {
  findChild,
  findChildren,
  getFirstAtomValue,
  markNodeDirty,
  type SExprList
} from '../kicad/sexpr'
import { setPositionalAtom } from '../kicad/footprint'
import type { Nm } from '../kicad/coordinates'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../kicad/symbolLibrary'
import { checkDelta, compactDelta, type CheckResult } from '../schematic/checks'
import { tk, type MessageKey } from '../messageKey'
import { symbolChecks } from './symbolChecks'
import { cappedGuidance, type QueryPage } from '../queryPage'
import { changedBetween, historyAnswer, historyGuidance, stepHistory } from '../historyStep'
import {
  createSymbolItem,
  deleteSymbolItems,
  querySymbolItems,
  symbolNarrowings,
  resolveSymbolItem,
  symbolItemRow,
  symbolItems,
  updateSymbolItem,
  SYMBOL_ID,
  type SymbolItem,
  type SymbolItemFailure,
  type SymbolItemQuery
} from './symbolItems'
import { transformSymbolItems } from './symbolItemsTransform'

export type SymbolItemsRequest =
  | McpGetSymbolItemsRequest
  | McpQuerySymbolItemsRequest
  | McpUpdateSymbolItemRequest
  | McpDeleteSymbolItemsRequest
  | McpCreateSymbolItemRequest
  | McpBatchSymbolRequest
  | McpUndoSymbolRequest
  | McpTransformSymbolItemsRequest

type EditRequest =
  | McpUpdateSymbolItemRequest
  | McpDeleteSymbolItemsRequest
  | McpCreateSymbolItemRequest
  | McpTransformSymbolItemsRequest

const SYMBOL_ITEM_KINDS: ReadonlySet<string> = new Set<SymbolItemsRequest['kind']>([
  'get-symbol-items',
  'query-symbol-items',
  'update-symbol-item',
  'delete-symbol-items',
  'create-symbol-item',
  'batch-symbol',
  'undo-symbol',
  'transform-symbol-items'
])

export const isSymbolItemsRequest = (request: McpDesignRequest): request is SymbolItemsRequest =>
  SYMBOL_ITEM_KINDS.has(request.kind)

/**
 * Where a symbol definition is. `file` is the library file, or a sheet copy's
 * design-copy path; a read-only tier may hand its text instead. `name` is the
 * symbol's name inside that text.
 */
export type SymbolResolution =
  | {
      ok: true
      name: string
      scope: string
      writable: boolean
      file?: string
      text?: string
      /** The sheet a placed symbol's copy belongs to. */
      sheet?: string
    }
  | { ok: false; error: string; detail: string; candidates?: string[] }

export interface SymbolItemsAgentContext {
  resolve(target: McpSymbolTarget): Promise<SymbolResolution>
  /** A file's text: an open tab's buffer first, else the disk; a design copy projected. */
  read(file: string): Promise<string | null>
  /** The session that writes the file, opened behind the user's tab. */
  session(file: string): Promise<TextSession<KicadSymbolLibrary, unknown> | null>
  label(key: MessageKey, count?: number): string
  /** The pin grid the symbol checks measure against. */
  checkGrid(): Promise<Nm>
}

export interface SymbolItemsAgent {
  dispatch(request: SymbolItemsRequest): Promise<unknown>
}

type Failure = { error: string; detail?: string; candidates?: string[] }

const failure = (outcome: SymbolItemFailure): Failure => ({
  error: outcome.error,
  detail: outcome.detail,
  ...(outcome.candidates?.length ? { candidates: outcome.candidates } : {})
})

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && typeof (value as Failure).error === 'string'

const READ_GUIDANCE =
  'Millimeters in the symbol frame, y down. Change an item with items_update and symbol, sending only the record keys that change.'

const LIBRARY_WRITE_GUIDANCE =
  "One undo step on the library's tab, now unsaved; project_save writes it. Placed symbols keep their own copies until updated from the library."

const SHEET_COPY_GUIDANCE =
  "One undo step on the sheet's tab, now unsaved; every placement on this sheet drawn from this copy changes. The library is untouched."

const checksGuidance = (checked: boolean): string =>
  checked
    ? 'Read checks for what it broke or fixed.'
    : 'No checks ran: pass checks: true, or call symbol_check.'

type Located = { scope: string; sheet?: string }

const located = (target: McpSymbolTarget, where: Located): Record<string, unknown> => ({
  symbol: target.symbol,
  ...(where.sheet ? { sheet: where.sheet } : {}),
  tier: where.scope
})

/** The op a batch entry came from, as its failure names it. */
const OP_NAMES: Record<string, string> = {
  'get-symbol-items': 'items.get',
  'query-symbol-items': 'items.query',
  'update-symbol-item': 'items.update',
  'delete-symbol-items': 'items.delete',
  'create-symbol-item': 'items.create',
  'transform-symbol-items': 'items.transform'
}

/** Text ending in a stop, so a sentence can follow it. */
/** The item query a request names. */
const queryOf = (request: McpQuerySymbolItemsRequest): SymbolItemQuery => ({
  ...(request.itemKind ? { kind: request.itemKind } : {}),
  ...(request.unit !== undefined ? { unit: request.unit } : {}),
  ...(request.number !== undefined ? { number: request.number } : {}),
  ...(request.box ? { box: request.box } : {}),
  ...(request.near ? { near: request.near } : {}),
  ...(request.radius !== undefined ? { radius: request.radius } : {}),
  ...(request.limit !== undefined ? { limit: request.limit } : {}),
  ...(request.offset !== undefined ? { offset: request.offset } : {})
})

/** A page of items as a query answers it. */
const pageAnswer = (page: QueryPage<SymbolItem>): Record<string, unknown> => ({
  count: page.total,
  items: page.rows.map(symbolItemRow),
  ...(page.offset ? { offset: page.offset } : {}),
  ...(page.truncated ? { truncated: true } : {})
})

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

/** The symbol node `name` names in a parsed library, or null. */
const symbolNode = (library: KicadSymbolLibrary, name: string): SExprList | null =>
  library.symbols.get(name)?._node ?? null

interface Applied {
  changed: McpChanged
  /** The symbol's new name, when the edit renamed it. */
  renamed?: string
}

/** What an edit may touch beyond its symbol: the scratch library, for a rename. */
interface EditScope {
  library: KicadSymbolLibrary
  /** A sheet's copy, whose name its placements link to. */
  sheetCopy: boolean
}

const symbolNames = (library: KicadSymbolLibrary): string[] =>
  findChildren(library.root, 'symbol').map((node) => getFirstAtomValue(node) ?? '')

/** Why a rename is refused, or null. */
const renameRefusal = (scope: EditScope, from: string, to: string): Failure | null => {
  if (scope.sheetCopy) {
    return {
      error: 'refused',
      detail: `A sheet's copy keeps the name its placements link to (${from}); rename the library symbol instead.`
    }
  }
  return symbolNames(scope.library).includes(to)
    ? { error: 'refused', detail: `The library already has a symbol named ${to}.` }
    : null
}

/** Point every symbol derived from `from` at its new name, as KiCad's rename does. */
const renameDerived = (library: KicadSymbolLibrary, from: string, to: string): void => {
  for (const node of findChildren(library.root, 'symbol')) {
    const link = findChild(node, 'extends')
    if (link && getFirstAtomValue(link) === from) {
      markNodeDirty(node)
      setPositionalAtom(link, 1, to, true)
    }
  }
}

/** The id a symbol has after a rename: its nickname with the new name. */
const renamedId = (symbol: string, name: string): string =>
  `${symbol.slice(0, symbol.indexOf(':'))}:${name}`

export const createSymbolItemsAgent = (ctx: SymbolItemsAgentContext): SymbolItemsAgent => {
  const load = async (
    target: McpSymbolTarget
  ): Promise<
    | { ok: true; resolution: Extract<SymbolResolution, { ok: true }>; library: KicadSymbolLibrary }
    | { ok: false; failure: Failure }
  > => {
    const resolution = await ctx.resolve(target)
    if (!resolution.ok) {
      const { error, detail, candidates } = resolution
      return { ok: false, failure: { error, detail, ...(candidates ? { candidates } : {}) } }
    }
    const text = resolution.text ?? (resolution.file ? await ctx.read(resolution.file) : null)
    if (text === null) {
      return {
        ok: false,
        failure: { error: 'symbol-unreadable', detail: resolution.file ?? target.symbol }
      }
    }
    try {
      const library = parseKicadSymbolLibrary(text)
      if (!symbolNode(library, resolution.name)) {
        return {
          ok: false,
          failure: {
            error: 'unknown-symbol',
            detail: target.symbol,
            candidates: library.names.slice(0, 8)
          }
        }
      }
      return { ok: true, resolution, library }
    } catch (error) {
      return {
        ok: false,
        failure: {
          error: 'symbol-unreadable',
          detail: `${target.symbol}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  }

  const checksOf = async (library: KicadSymbolLibrary, name: string): Promise<CheckResult[]> => {
    const definition = library.symbols.get(name)
    if (!definition) return []
    return symbolChecks(definition, await ctx.checkGrid(), (other) => library.symbols.get(other))
  }

  const getItems = async (request: McpGetSymbolItemsRequest): Promise<unknown> => {
    const loaded = await load(request)
    if (!loaded.ok) return loaded.failure
    const node = symbolNode(loaded.library, loaded.resolution.name)
    if (!node) return { error: 'unknown-symbol', detail: request.symbol }
    const all = symbolItems(node)
    const rows: Record<string, unknown>[] = []
    for (const id of request.ids) {
      const found = resolveSymbolItem(all, id)
      if (!found.ok) return failure(found)
      rows.push(symbolItemRow(found.item))
    }
    return {
      ...located(request, loaded.resolution),
      count: rows.length,
      items: rows,
      guidance: READ_GUIDANCE
    }
  }

  const queryAll = async (request: McpQuerySymbolItemsRequest): Promise<unknown> => {
    const loaded = await load(request)
    if (!loaded.ok) return loaded.failure
    const node = symbolNode(loaded.library, loaded.resolution.name)
    if (!node) return { error: 'unknown-symbol', detail: request.symbol }
    const query = queryOf(request)
    const page = querySymbolItems(symbolItems(node), query)
    return {
      ...located(request, loaded.resolution),
      ...pageAnswer(page),
      guidance: page.truncated
        ? `${cappedGuidance(page, symbolNarrowings(page.matches, query))} ${READ_GUIDANCE}`
        : READ_GUIDANCE
    }
  }

  /** One edit on the scratch symbol; the scratch is left edited on success. */
  const applyEdit = (
    node: SExprList,
    request: EditRequest,
    scope: EditScope
  ): Applied | Failure => {
    const items = symbolItems(node)
    switch (request.kind) {
      case 'update-symbol-item': {
        const found = resolveSymbolItem(items, request.id)
        if (!found.ok) return failure(found)
        const newName =
          found.item.kind === 'symbol' && typeof request.record.name === 'string'
            ? request.record.name.trim()
            : null
        const oldName = getFirstAtomValue(node) ?? ''
        if (newName !== null && newName !== oldName) {
          const refusal = renameRefusal(scope, oldName, newName)
          if (refusal) return refusal
        }
        const outcome = updateSymbolItem(node, found.item, request.record)
        if (!outcome.ok) return failure(outcome)
        if (newName !== null && newName !== oldName) {
          renameDerived(scope.library, oldName, newName)
          return {
            changed: { created: [], updated: [SYMBOL_ID], deleted: [] },
            renamed: newName
          }
        }
        // An edit can rename a pin's id (its number); answer with the id it has now.
        const after = symbolItems(node).find((item) => item.node === found.item.node)
        return { changed: { created: [], updated: [after?.id ?? found.item.id], deleted: [] } }
      }
      case 'delete-symbol-items': {
        const targets: SymbolItem[] = []
        for (const id of request.ids) {
          const found = resolveSymbolItem(items, id)
          if (!found.ok) return failure(found)
          targets.push(found.item)
        }
        const outcome = deleteSymbolItems(node, targets)
        if (!outcome.ok) return failure(outcome)
        return { changed: { created: [], updated: [], deleted: targets.map((item) => item.id) } }
      }
      case 'create-symbol-item': {
        const outcome = createSymbolItem(node, request.itemKind, request.record)
        if (!outcome.ok) return failure(outcome)
        return { changed: { created: [outcome.id], updated: [], deleted: [] } }
      }
      case 'transform-symbol-items': {
        const outcome = transformSymbolItems(node, request)
        if (!outcome.ok) {
          const { error, detail, candidates } = outcome
          return { error, detail, ...(candidates?.length ? { candidates } : {}) }
        }
        return { changed: outcome.changed }
      }
    }
  }

  /**
   * Run edits against a scratch parse of the symbol's file and, unless
   * `dryRun`, land the result as one command on the file's session.
   */
  const commit = async (
    target: McpSymbolTarget,
    label: string,
    dryRun: boolean,
    checks: boolean,
    run: (
      scratch: SExprList,
      scope: EditScope
    ) => Promise<(Applied & { extra?: Record<string, unknown> }) | Failure>
  ): Promise<unknown> => {
    const resolution = await ctx.resolve(target)
    if (!resolution.ok) {
      const { error, detail, candidates } = resolution
      return { error, detail, ...(candidates ? { candidates } : {}) }
    }
    if (!resolution.writable || !resolution.file) {
      return {
        error: 'library-read-only',
        detail: `${target.symbol} is in the ${resolution.scope} library.`
      }
    }
    const session = await ctx.session(resolution.file)
    const model = session?.model()
    if (!session || !model) {
      return { error: 'symbol-unreadable', detail: session?.parseError() ?? resolution.file }
    }
    const text = serializeKicadSymbolLibrary(model)
    const scratch = parseKicadSymbolLibrary(text)
    const node = symbolNode(scratch, resolution.name)
    if (!node) return { error: 'unknown-symbol', detail: target.symbol }
    const beforeChecks = checks
      ? await checksOf(parseKicadSymbolLibrary(text), resolution.name)
      : null
    const outcome = await run(node, { library: scratch, sheetCopy: resolution.sheet !== undefined })
    if (isFailure(outcome)) return outcome
    const afterText = serializeKicadSymbolLibrary(scratch)
    if (!dryRun && afterText !== text) {
      const committed = session.runCommand(label, (live) => {
        live.root.children = parseKicadSymbolLibrary(afterText).root.children
      })
      if (!committed)
        return { error: 'read-only', detail: `${resolution.file} could not be written.` }
    }
    const afterChecks = beforeChecks
      ? await checksOf(parseKicadSymbolLibrary(afterText), outcome.renamed ?? resolution.name)
      : null
    const answer: McpWriteAnswer & Record<string, unknown> = {
      ...located(target, resolution),
      ...(dryRun ? { dryRun: true as const } : {}),
      ...(outcome.renamed ? { libId: renamedId(target.symbol, outcome.renamed) } : {}),
      changed: outcome.changed,
      ...(outcome.extra ?? {}),
      ...(beforeChecks && afterChecks
        ? { checks: compactDelta(checkDelta(beforeChecks, afterChecks)) }
        : {}),
      revision: session.revision(),
      guidance: [
        dryRun
          ? 'Nothing was written: this is what the batch would do. Run it without dryRun to commit.'
          : resolution.sheet
            ? SHEET_COPY_GUIDANCE
            : LIBRARY_WRITE_GUIDANCE,
        checksGuidance(beforeChecks !== null)
      ].join(' ')
    }
    return answer
  }

  /** The editor's own label for the transform. */
  const transformLabel = (request: McpTransformSymbolItemsRequest): string => {
    const count = request.ids.length
    switch (request.transform) {
      case 'rotate':
        return ctx.label(tk('symbolEditor.commands.rotate'))
      case 'mirror':
        return ctx.label(
          request.axis === 'y'
            ? tk('symbolEditor.commands.mirrorHorizontal')
            : tk('symbolEditor.commands.mirrorVertical')
        )
      case 'duplicate':
        return ctx.label(
          request.pinStep === undefined
            ? tk('symbolEditor.commands.duplicateItems')
            : tk('symbolEditor.commands.repeatItems'),
          count
        )
      case 'anchor':
        return ctx.label(tk('symbolEditor.commands.moveAnchor'))
      default:
        return ctx.label(tk('commandLabels.move'), count)
    }
  }

  const edit = (request: EditRequest): Promise<unknown> => {
    const label =
      request.kind === 'delete-symbol-items'
        ? ctx.label(tk('commandLabels.delete'), request.ids.length)
        : request.kind === 'create-symbol-item'
          ? ctx.label(tk('commandLabels.addSymbolItem'))
          : request.kind === 'transform-symbol-items'
            ? transformLabel(request)
            : ctx.label(tk('commandLabels.editSymbolItem'))
    return commit(request, label, false, request.checks === true, async (scratch, scope) =>
      applyEdit(scratch, request, scope)
    )
  }

  const batch = (request: McpBatchSymbolRequest): Promise<unknown> =>
    commit(
      request,
      ctx.label(tk('commandLabels.agentBatch'), request.ops.length),
      request.dryRun === true,
      request.checks === true,
      async (scratch, scope) => {
        const changed: Applied['changed'] = { created: [], updated: [], deleted: [] }
        let renamed: string | undefined
        const results: unknown[] = []
        for (const [index, op] of request.ops.entries()) {
          const fail = (outcome: Failure): Failure => ({
            ...outcome,
            detail: `Operation ${index} (\`${OP_NAMES[op.kind] ?? op.kind}\`): ${sentence(outcome.detail ?? outcome.error)} Nothing was written.`
          })
          if (
            op.kind === 'update-symbol-item' ||
            op.kind === 'delete-symbol-items' ||
            op.kind === 'create-symbol-item' ||
            op.kind === 'transform-symbol-items'
          ) {
            const applied = applyEdit(scratch, op, scope)
            if (isFailure(applied)) return fail(applied)
            renamed = applied.renamed ?? renamed
            changed.created.push(...applied.changed.created)
            changed.updated.push(...applied.changed.updated)
            changed.deleted.push(...applied.changed.deleted)
            results.push({ changed: applied.changed })
            continue
          }
          // Reads see the batch's state so far.
          const items = symbolItems(scratch)
          if (op.kind === 'get-symbol-items') {
            const rows: Record<string, unknown>[] = []
            for (const id of op.ids) {
              const found = resolveSymbolItem(items, id)
              if (!found.ok) return fail(failure(found))
              rows.push(symbolItemRow(found.item))
            }
            results.push({ count: rows.length, items: rows })
            continue
          }
          if (op.kind === 'query-symbol-items') {
            results.push(pageAnswer(querySymbolItems(items, queryOf(op))))
            continue
          }
          return fail({
            error: 'not-applicable',
            detail: `${op.kind} cannot run in a symbol batch`
          })
        }
        return { changed, ...(renamed ? { renamed } : {}), extra: { results } }
      }
    )

  /** Edit ▸ Undo or Redo on the tab that holds the symbol, `steps` times or not at all. */
  const step = async (request: McpUndoSymbolRequest): Promise<unknown> => {
    const resolution = await ctx.resolve(request)
    if (!resolution.ok) {
      const { error, detail, candidates } = resolution
      return { error, detail, ...(candidates ? { candidates } : {}) }
    }
    if (!resolution.writable || !resolution.file) {
      return {
        error: 'library-read-only',
        detail: `${request.symbol} is in the ${resolution.scope} library.`
      }
    }
    const session = await ctx.session(resolution.file)
    if (!session?.model()) {
      return { error: 'symbol-unreadable', detail: session?.parseError() ?? resolution.file }
    }
    // The named symbol's items: a step on another symbol of the library leaves them as they were.
    const prints = (): Map<string, unknown> => {
      const model = session.model()
      const node = model ? symbolNode(model, resolution.name) : null
      return new Map(
        node ? symbolItems(node).map((item) => [item.id, JSON.stringify(symbolItemRow(item))]) : []
      )
    }
    const redo = request.redo === true
    const before = prints()
    const stepped = stepHistory(session, redo, request.steps, 'The symbol')
    if (!stepped.ok) return { error: stepped.error, detail: stepped.detail }
    return {
      ...located(request, resolution),
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

  const handlers: Record<
    SymbolItemsRequest['kind'],
    (request: SymbolItemsRequest) => Promise<unknown>
  > = {
    'get-symbol-items': (request) => getItems(request as McpGetSymbolItemsRequest),
    'query-symbol-items': (request) => queryAll(request as McpQuerySymbolItemsRequest),
    'update-symbol-item': (request) => edit(request as McpUpdateSymbolItemRequest),
    'delete-symbol-items': (request) => edit(request as McpDeleteSymbolItemsRequest),
    'create-symbol-item': (request) => edit(request as McpCreateSymbolItemRequest),
    'batch-symbol': (request) => batch(request as McpBatchSymbolRequest),
    'undo-symbol': (request) => step(request as McpUndoSymbolRequest),
    'transform-symbol-items': (request) => edit(request as McpTransformSymbolItemsRequest)
  }

  return { dispatch: (request) => handlers[request.kind](request) }
}
