/**
 * One open board, for everyone who reads or writes it.
 *
 * The schematic's session (`lib/schematic/sheetSession.ts`) with a board's
 * command layer: the parsed board, its structural undo, the deferred
 * serialize, and every mutation. It lives as long as the tab does, so
 * switching away neither re-parses the board nor loses its history, and an
 * agent's `board.sync` is the same undoable command a gesture is.
 *
 * Undo here is structural, not textual: an entry holds the root's top-level
 * `children` array with a deep clone of each node the command mutated, so
 * undoing a dense board is an array swap and a remap rather than a re-parse.
 * The dirty-mark contract (`beginNodeCapture`) is what produces those clones,
 * which is why every mutator must mark before it writes.
 */
import {
  parseKicadBoard,
  parseKicadBoardAsync,
  remapKicadBoard,
  serializeKicadBoard,
  warmBoardSerializeCacheSteps,
  type KicadBoard
} from '../kicad/board'
import { ParseAbortedError, beginNodeCapture, endNodeCapture } from '../kicad/sexpr'
import type { SExprList, SExprNode } from '../kicad/sexpr'
import { CommandHistory, type HistoryEntry, type SelectionItem } from '../history'
import type { DocumentHandle } from '../document/documentStore'
import { FRAME_BUDGET_MS, afterPaint, yieldControl } from '../cooperate'
import { boardIndex, cachedBoardIndex } from './spatialIndex'
import { clipperLoaded, loadClipper } from '../geometry/clip'
import { applyNetChanges, propagationFor } from './netPropagation'
import type { BoardWorkerHost } from './worker/boardWorkerHost'
import { zoneKey } from './boardItems'
import { fillable } from './zoneRefill'
import {
  applyTeardropPlan,
  planTeardrops,
  teardropDirtyOf,
  teardropsUnchanged,
  touchesTeardropCopper,
  type TeardropOptions
} from './teardrop/manager'
import { DEFAULT_TEARDROP_SETTINGS } from './teardrop/params'
import { TeardropOwners } from './teardrop/owners'
import { DEFAULT_DESIGN_RULES } from '../kicad/project'
import { mmToNm } from '../kicad/coordinates'

/** The root's top-level children, with a pre-mutation clone of everything the
 *  recorded command touched, and the zones whose stored fill was stale then. */
export interface BoardSnapshot {
  children: SExprNode[]
  stale?: string[]
}

/** What a command did to the stored zone fills, by zone key (`boardItems.ts`'s ids). */
export interface ZoneFillChange {
  /** Zones whose stored fill the edit left out of date. */
  stale?: Iterable<string>
  /** Zones the command refilled. */
  filled?: Iterable<string>
}

/** What a command changed, for a view that patches its scene in place. */
export interface BoardCommandChange {
  fromBoard: KicadBoard
  raws: Set<SExprNode>
}

export interface BoardCommandOptions {
  mergeKey?: string
  /** Derived work (an auto zone refill) undoes with the command before it. */
  groupWithPrevious?: boolean
  /** The selection to record, read before and after the edit. */
  selection?: { before: SelectionItem[]; after(): SelectionItem[] }
  /** Runs after the board is remapped, before the change is announced. */
  afterApply?(): void
  /**
   * The command's effect on the stored fills, read after the remap with the
   * nodes it added, removed or mutated. Recorded with the command, so undo
   * restores which zones were stale.
   */
  zones?(after: KicadBoard, raws: ReadonlySet<SExprNode>): ZoneFillChange
  /** A refill's own commit, which leaves nothing for the next refill (the board worker). */
  refill?: boolean
  /**
   * False when the command keeps the teardrops as they are, as KiCad's
   * `SKIP_TEARDROPS` does for a lock, or writes them itself.
   */
  teardrops?: boolean
}

export interface BoardSessionDeps {
  filePath: string
  document: DocumentHandle
  /** Land new text for this board in its tab's buffer. */
  commit(content: string): void
  readOnly(): boolean
  /** The board worker this session keeps current (docs/performance-workstream.md); none under test. */
  worker?: BoardWorkerHost
}

export interface BoardSession {
  /** The parsed board as it is now, or null when none has parsed. */
  board(): KicadBoard | null
  parseError(): string | null
  /** Bumped on every change to the board: a view's redraw key. */
  revision(): number
  /** Bumped only when a parse produced a new board, which a scene rebuilds from
   *  whole rather than patching. */
  loadId(): number
  /** What the last command changed, for an incremental scene apply. */
  lastChange(): BoardCommandChange | null
  /** Whether the last change was an undo or a redo, which restores its fills and never refills. */
  lastStep(): 'undo' | 'redo' | null
  subscribe(listener: () => void): () => void
  /**
   * Parse `text` unless this session already holds that board. Reports progress
   * for a document large enough to parse in slices; resolves when the board is
   * the session's, or the parse was superseded.
   */
  load(text: string, onProgress?: (fraction: number | null) => void): Promise<void>
  /**
   * One undoable command over the board. A `mutate` that throws leaves the
   * board as it was and the error propagates: nothing is recorded.
   */
  runCommand(label: string, mutate: () => void, options?: BoardCommandOptions): boolean
  /**
   * What the board's teardrops are built with: the project's max error and
   * teardrop settings. Until set, KiCad's defaults.
   */
  setTeardropOptions(options: Omit<TeardropOptions, 'maskExpansion'> | null): void
  /** The options a command's teardrops are built with now. */
  teardropOptions(): TeardropOptions
  /** What each teardrop belongs to, kept true by the session's commands (`teardrop/owners.ts`). */
  teardropOwners(): TeardropOwners
  /**
   * Rebuild every teardrop as one command, as KiCad does before Fill All Zones;
   * false when they are already what they should be.
   */
  rebuildTeardrops(label: string): boolean
  /**
   * Zones whose stored fill an edit left out of date and no refill has
   * rewritten since, by zone key. Only commands that say so mark a zone
   * (an agent's writes); the editor's own debounced refill covers its edits.
   */
  staleZones(): ReadonlySet<string>
  /**
   * Mark zones stale for a change outside the board's own text — new rules
   * in the project file. No command records it, so undo keeps it: only a
   * refill of the zone clears it.
   */
  markZonesStale(keys: Iterable<string>): void
  /** Whether nothing may be written back: the file is read-only here. */
  readOnly(): boolean
  undo(): HistoryEntry<BoardSnapshot, SelectionItem> | null
  redo(): HistoryEntry<BoardSnapshot, SelectionItem> | null
  canUndo(): boolean
  canRedo(): boolean
  /** Where the history stands, for `rollback`. */
  mark(): number
  /** Take back every command since `mark`, nothing left to redo: an abandoned gesture. */
  rollback(mark: number): void
  /** True while the text owes an edit the board already holds. */
  textPending(): boolean
  /** Bring the text current, cooperatively; the text either way. */
  flush(): Promise<string>
  /** The same in one task: what a synchronous reader of the document gets. */
  flushSync(): string
  /** What undo and redo would take back, for a toolbar that says so. */
  undoLabel(): string | null
  redoLabel(): string | null
  /** The board worker that follows this board, which runs its refills and checks. */
  worker(): BoardWorkerHost | null
  /** Abandon work in flight, when the tab closes. */
  dispose(): void
}

/** A board this big parses in slices so the window keeps painting. */
const ASYNC_PARSE_THRESHOLD = 4_000_000 // chars

export const createBoardSession = (deps: BoardSessionDeps): BoardSession => {
  let board: KicadBoard | null = null
  let parseError: string | null = null
  let committed = deps.document.storedText()
  let revision = 0
  let loadId = 0
  let lastChange: BoardCommandChange | null = null
  let lastStep: 'undo' | 'redo' | null = null
  let stale = new Set<string>()
  /** Stale by a change no command records (`markZonesStale`); undo does not touch it. */
  let staleOutside = new Set<string>()
  const listeners = new Set<() => void>()
  /**
   * Drop stale keys that name no fillable zone of the board as it is now: a
   * zone deleted, re-keyed or made a rule area since. No refill would ever
   * clear one, so a caller that refills while any is stale would never stop.
   */
  const pruneStale = (): void => {
    if (!board || (stale.size === 0 && staleOutside.size === 0)) return
    const live = new Set(board.zones.filter(fillable).map(zoneKey))
    const keep = (keys: Set<string>): Set<string> =>
      [...keys].every((key) => live.has(key))
        ? keys
        : new Set([...keys].filter((key) => live.has(key)))
    stale = keep(stale)
    staleOutside = keep(staleOutside)
  }
  const changed = (): void => {
    revision += 1
    for (const listener of listeners) listener()
  }

  const history = (): CommandHistory<BoardSnapshot, SelectionItem> =>
    deps.document.history<BoardSnapshot, SelectionItem>()

  let parseToken = 0
  let serializeToken = 0
  let serializePending = false
  let disposed = false

  /** The text is the board's again: commit it to the tab and the history's
   *  record of what it last wrote. */
  const publish = (text: string): void => {
    serializePending = false
    committed = text
    deps.document.commitText(text)
    deps.commit(text)
  }

  /**
   * Regenerate the text at idle, in frame-budget slices. A command never pays
   * for it in its own task: on a dense board the serialize costs far more than
   * the edit, and nothing needs the text until a save or a read.
   */
  const scheduleSerialize = (): void => {
    serializePending = true
    const token = ++serializeToken
    const current = board
    if (!current) return
    void (async () => {
      await afterPaint()
      const warm = warmBoardSerializeCacheSteps(current)
      let sliceStart = performance.now()
      let step = warm.next()
      while (!step.done) {
        if (performance.now() - sliceStart > FRAME_BUDGET_MS) {
          await yieldControl()
          if (token !== serializeToken || board !== current || disposed) return
          sliceStart = performance.now()
        }
        step = warm.next()
      }
      if (token !== serializeToken || board !== current || disposed) return
      try {
        publish(serializeKicadBoard(current))
      } catch (error) {
        console.error('Failed to serialize board:', error)
        serializePending = false
      }
    })()
  }

  const flush = async (): Promise<string> => {
    if (!serializePending || !board) return committed
    ++serializeToken // take over from any scheduled run
    const warm = warmBoardSerializeCacheSteps(board)
    let sliceStart = performance.now()
    let step = warm.next()
    while (!step.done) {
      if (performance.now() - sliceStart > FRAME_BUDGET_MS) {
        await yieldControl()
        sliceStart = performance.now()
      }
      step = warm.next()
    }
    // Serialize the board as it is NOW: an edit that landed mid-flush is in it,
    // and the warm above was only a head start.
    const current = board
    if (!current) return committed
    const text = serializeKicadBoard(current)
    publish(text)
    return text
  }

  const adopt = (parsed: KicadBoard, text: string): void => {
    deps.worker?.loaded(text, parsed._raw as SExprList)
    board = parsed
    parseError = null
    committed = text
    serializePending = false
    lastChange = null
    lastStep = null
    stale = new Set()
    staleOutside = new Set()
    loadId += 1
    changed()
  }

  const load = async (
    text: string,
    onProgress?: (fraction: number | null) => void
  ): Promise<void> => {
    // The session already holds this document: a tab switch is not a reload.
    if (board && text === committed) return
    const token = ++parseToken
    serializeToken++
    serializePending = false
    // The board's index (its pads' merged copper among it) needs the geometry
    // engine, started at launch: a board waits for it rather than indexing without.
    if (!clipperLoaded()) {
      await loadClipper()
      if (token !== parseToken) return
    }
    if (!text.trim()) {
      board = null
      parseError = null
      committed = text
      deps.worker?.cleared()
      changed()
      return
    }
    if (text.length < ASYNC_PARSE_THRESHOLD) {
      try {
        adopt(parseKicadBoard(text), text)
      } catch (error) {
        board = null
        parseError = error instanceof Error ? error.message : String(error)
        committed = text
        deps.worker?.cleared()
        changed()
      }
      return
    }
    onProgress?.(0)
    try {
      const parsed = await parseKicadBoardAsync(text, {
        onProgress: (fraction) => {
          if (token === parseToken) onProgress?.(fraction)
        },
        shouldAbort: () => token !== parseToken || disposed
      })
      if (token !== parseToken || disposed) return
      performance.mark('board:parsed')
      adopt(parsed, text)
    } catch (error) {
      if (token !== parseToken || disposed || error instanceof ParseAbortedError) return
      board = null
      parseError = error instanceof Error ? error.message : String(error)
      committed = text
      deps.worker?.cleared()
      changed()
    } finally {
      if (token === parseToken) onProgress?.(null)
    }
  }

  /** Older entries that reference a node this command just mutated take its
   *  pre-mutation clone instead, keeping every retained snapshot appliable. */
  const substituteNodes = (
    snapshot: BoardSnapshot,
    clones: Map<SExprNode, SExprNode>
  ): BoardSnapshot => {
    if (!snapshot.children.some((node) => clones.has(node))) return snapshot
    return { ...snapshot, children: snapshot.children.map((node) => clones.get(node) ?? node) }
  }

  let teardropSettings: Omit<TeardropOptions, 'maskExpansion'> | null = null
  const teardropOwners = new TeardropOwners()
  const teardropOptionsFor = (b: KicadBoard): TeardropOptions => ({
    maxError: teardropSettings?.maxError ?? mmToNm(DEFAULT_DESIGN_RULES.maxError),
    settings: teardropSettings?.settings ?? DEFAULT_TEARDROP_SETTINGS,
    maskExpansion: b.padToMaskClearance
  })

  const runCommand = (
    label: string,
    mutate: () => void,
    options: BoardCommandOptions = {}
  ): boolean => {
    const current = board
    if (!current || deps.readOnly() || disposed) return false
    const root = current._raw as SExprList
    const childrenBefore = root.children.slice()
    // Where the board's copper was, for the nets the edit may take apart: its
    // index, if one is built, and its arrays before the edit writes them.
    const beforeIndex = cachedBoardIndex(current)
    const before = beforeIndex && {
      index: beforeIndex,
      arrays: {
        segments: current.segments.slice(),
        trackArcs: current.trackArcs.slice(),
        vias: current.vias.slice(),
        footprints: current.footprints.slice()
      }
    }

    // What each teardrop belongs to, read before the edit moves anything: a
    // load, undo or redo left a board the map does not hold for.
    if (!teardropOwners.holds(current)) teardropOwners.build(current)

    // The dirty-mark contract doubles as undo capture: the first mark per node
    // deep-clones its pre-mutation state.
    beginNodeCapture()
    try {
      mutate()
    } catch (error) {
      // The clones are the pre-mutation nodes: put them back, and remap so
      // the facade forgets the in-place writes. A reader holding the old
      // facade is told the board changed.
      const clones = endNodeCapture()
      root.children = childrenBefore.map((node) => clones.get(node) ?? node)
      if (clones.size > 0) history().mapStates((snapshot) => substituteNodes(snapshot, clones))
      board = remapKicadBoard(current)
      lastChange = null
      changed()
      throw error
    }
    const mutatedClones = endNodeCapture()

    // No-op detection is structural, so a command costs no serialize of its own.
    const beforeChildren = new Set(childrenBefore)
    const afterChildren = new Set(root.children)
    const structural =
      mutatedClones.size > 0 ||
      root.children.some((node) => !beforeChildren.has(node)) ||
      childrenBefore.some((node) => !afterChildren.has(node))
    if (!structural) return false

    // Remap the facade arrays from the mutated AST rather than re-parsing the
    // text: a full reparse costs seconds on a dense board.
    const previous = current
    board = remapKicadBoard(current)
    const raws = new Set<SExprNode>()
    for (const node of root.children) if (!beforeChildren.has(node)) raws.add(node)
    for (const node of childrenBefore) if (!afterChildren.has(node)) raws.add(node)
    for (const node of mutatedClones.keys()) raws.add(node)

    // Copper takes the net of what the edit joined it to, as KiCad's commit
    // propagates it (`netPropagation.ts`), in this same step.
    const edited = board
    const changes = propagationFor(
      edited,
      raws,
      () => boardIndex(edited, before && { from: before.index, prevArrays: before.arrays, raws }),
      before
    )
    if (changes && changes.length > 0) {
      beginNodeCapture()
      applyNetChanges(edited, changes)
      for (const [node, clone] of endNodeCapture()) {
        raws.add(node)
        if (!mutatedClones.has(node)) mutatedClones.set(node, clone)
      }
      board = remapKicadBoard(edited)
    }

    // The teardrops of what the edit touched are rebuilt in this same step,
    // as KiCad's commit rebuilds them (`teardrop/manager.ts`).
    if (options.teardrops !== false && !options.refill && touchesTeardropCopper(raws)) {
      const index = boardIndex(
        edited,
        before && { from: before.index, prevArrays: before.arrays, raws }
      )
      const plan = planTeardrops(
        board,
        index,
        teardropDirtyOf(board, raws),
        teardropOptionsFor(board),
        teardropOwners
      )
      if (plan.remove.length > 0 || plan.add.length > 0) {
        for (const node of applyTeardropPlan(board, plan, teardropOwners)) raws.add(node)
        board = remapKicadBoard(board)
      }
    }
    teardropOwners.heldFor(board)
    options.afterApply?.()
    scheduleSerialize()

    if (mutatedClones.size > 0) {
      history().mapStates((snapshot) => substituteNodes(snapshot, mutatedClones))
    }
    let cloneBytes = 0
    for (const original of mutatedClones.keys()) {
      cloneBytes += Math.max(original.end - original.start, 64)
    }

    const staleBefore = [...stale]
    const fills = options.zones?.(board, raws)
    if (fills) {
      const next = new Set(stale)
      for (const key of fills.stale ?? []) next.add(key)
      for (const key of fills.filled ?? []) {
        next.delete(key)
        staleOutside.delete(key)
      }
      stale = next
    }
    pruneStale()

    history().push({
      label,
      before: {
        children: childrenBefore.map((node) => mutatedClones.get(node) ?? node),
        stale: staleBefore
      },
      after: { children: root.children.slice(), stale: [...stale] },
      sizeBytes: (childrenBefore.length + root.children.length) * 8 + cloneBytes,
      selectionBefore: options.selection?.before ?? [],
      selectionAfter: options.selection?.after() ?? [],
      mergeKey: options.mergeKey,
      groupWithPrevious: options.groupWithPrevious
    })

    lastChange = { fromBoard: previous, raws }
    lastStep = null
    deps.worker?.changed(root, new Set(mutatedClones.keys()), options.refill ? 'refill' : 'command')
    changed()
    return true
  }

  const applySnapshot = (snapshot: BoardSnapshot): void => {
    const current = board
    if (!current) return
    const root = current._raw as SExprList
    root.children = snapshot.children.slice()
    stale = new Set(snapshot.stale ?? [])
    board = remapKicadBoard(current)
    pruneStale()
    lastChange = null
    deps.worker?.changed(root, new Set(), 'snapshot')
    scheduleSerialize()
    changed()
  }

  const step = (
    entry: HistoryEntry<BoardSnapshot, SelectionItem> | null,
    side: 'before' | 'after'
  ): HistoryEntry<BoardSnapshot, SelectionItem> | null => {
    if (!entry || deps.readOnly()) return null
    lastStep = side === 'before' ? 'undo' : 'redo'
    applySnapshot(entry[side])
    return entry
  }

  /** Serialize now, in one task. A save or an agent's read cannot wait for the
   *  cooperative flush, and the join of cached strings is most of the cost. */
  const flushSync = (): string => {
    if (!serializePending || !board) return committed
    ++serializeToken
    const text = serializeKicadBoard(board)
    publish(text)
    return text
  }

  return {
    board: () => board,
    parseError: () => parseError,
    revision: () => revision,
    loadId: () => loadId,
    lastChange: () => lastChange,
    lastStep: () => lastStep,
    staleZones: () => (staleOutside.size ? new Set([...stale, ...staleOutside]) : stale),
    markZonesStale: (keys) => {
      const next = new Set(staleOutside)
      for (const key of keys) next.add(key)
      if (next.size === staleOutside.size) return
      staleOutside = next
      pruneStale()
      changed()
    },
    readOnly: () => deps.readOnly(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load,
    runCommand,
    setTeardropOptions: (o) => {
      teardropSettings = o
    },
    teardropOwners: () => teardropOwners,
    teardropOptions: () => teardropOptionsFor(board ?? ({ padToMaskClearance: 0 } as KicadBoard)),
    rebuildTeardrops: (label) => {
      const current = board
      if (!current || deps.readOnly() || disposed) return false
      const plan = planTeardrops(current, boardIndex(current), 'all', teardropOptionsFor(current))
      if (teardropsUnchanged(current, plan)) return false
      return runCommand(label, () => void applyTeardropPlan(current, plan, teardropOwners), {
        teardrops: false
      })
    },
    undo: () => step(history().undo(), 'before'),
    redo: () => step(history().redo(), 'after'),
    canUndo: () => history().canUndo,
    mark: () => history().mark(),
    rollback: (mark) => void step(history().rollback(mark), 'before'),
    canRedo: () => history().canRedo,
    textPending: () => serializePending,
    flush,
    flushSync,
    undoLabel: () => history().undoLabel,
    redoLabel: () => history().redoLabel,
    worker: () => deps.worker ?? null,
    dispose: () => {
      deps.worker?.dispose()
      disposed = true
      parseToken++
      serializeToken++
    }
  }
}
