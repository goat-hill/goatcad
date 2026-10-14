/**
 * Command history for document editors.
 *
 * Stores labeled undo/redo entries as full document snapshots (before/after
 * text) plus the selection on each side, so undo restores both content and
 * what the user had selected. Entries with the same `mergeKey` arriving in
 * quick succession coalesce into one entry (e.g. keystrokes in a properties
 * panel field become a single undo step).
 *
 * The editor funnels every mutation through one executor that records into
 * this history, so new operations get undo/redo support by construction.
 */

/**
 * How the PCB, footprint and schematic editors name a selected item: a kind
 * plus an index into the parsed arrays.
 *
 * It is the DEFAULT selection shape, not the only one — `HistoryEntry` is
 * generic over it. The symbol editor names parts structurally instead
 * (`SymbolPartAddress`), because a flat index there shifts whenever an earlier
 * unit gains a part; see ARCHITECTURE.md §3.7. Forcing one shape on
 * every editor would mean keeping a second numbering alongside the names, which
 * is the mismatch that model exists to remove.
 */
export interface SelectionItem {
  type: string
  index: number
}

/**
 * Another file a command touched, with its text before and after. A command
 * that edits sibling sheets — annotating a whole design — is still one undo
 * step: the entry's `before`/`after` are the editor's own file, and these are
 * the rest, restored through the tab store when the entry is applied.
 */
export interface FileState<S = string> {
  path: string
  before: S
  after: S
}

export interface HistoryEntry<S = string, Sel = SelectionItem> {
  /** Human-readable operation name, shown in undo/redo UI ("Move 2 Items") */
  label: string
  /** Document state before the command (text, or a structural snapshot) */
  before: S
  /** Document state after the command */
  after: S
  selectionBefore: Sel[]
  selectionAfter: Sel[]
  /** Other files the command changed; absent when it stayed in this one. */
  files?: FileState<S>[]
  /** Consecutive entries with the same non-empty key merge within the window */
  mergeKey?: string
  /** Undo this derived/auxiliary mutation together with the entry before it. */
  groupWithPrevious?: boolean
  /** Approximate retained bytes for the byte budget; string states derive it */
  sizeBytes?: number
  timestamp: number
}

/** Two entries' sibling states as one: a path in both keeps the first's
 *  `before` and takes the second's `after`. */
const mergeFiles = <S>(
  first: FileState<S>[] | undefined,
  second: FileState<S>[] | undefined
): FileState<S>[] | undefined => {
  if (!first?.length) return second?.length ? second : undefined
  if (!second?.length) return first
  const byPath = new Map(first.map((file) => [file.path, { ...file }]))
  for (const file of second) {
    const existing = byPath.get(file.path)
    if (existing) existing.after = file.after
    else byPath.set(file.path, { ...file })
  }
  return [...byPath.values()]
}

const DEFAULT_LIMIT = 100
const DEFAULT_MERGE_WINDOW_MS = 1000
/**
 * Total snapshot bytes (before + after across both stacks) the history may
 * retain. Snapshots are whole documents, and a dense .kicad_pcb serializes to
 * ~90 MB — without a byte cap, 100 entries can hold gigabytes of strings and
 * OOM the renderer. Consecutive entries share their boundary string
 * (entry.after === next.before), so the real retained set is smaller than
 * this sum, making the cap conservative.
 */
const DEFAULT_BYTE_BUDGET = 512 * 1024 * 1024

export class CommandHistory<S = string, Sel = SelectionItem> {
  private undoStack: HistoryEntry<S, Sel>[] = []
  private redoStack: HistoryEntry<S, Sel>[] = []
  private limit: number
  /** No entry below this depth takes a merge: what came before a `mark`. */
  private sealedAt = 0
  private mergeWindowMs: number
  private byteBudget: number

  constructor(
    limit = DEFAULT_LIMIT,
    mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
    byteBudget = DEFAULT_BYTE_BUDGET
  ) {
    this.limit = limit
    this.mergeWindowMs = mergeWindowMs
    this.byteBudget = byteBudget
  }

  private entryBytes(entry: HistoryEntry<S, Sel>): number {
    if (entry.sizeBytes !== undefined) return entry.sizeBytes
    const size = (state: unknown): number => (typeof state === 'string' ? state.length : 0)
    let total = size(entry.before) + size(entry.after)
    for (const file of entry.files ?? []) total += size(file.before) + size(file.after)
    return total
  }

  /** Evict oldest undo entries while over the byte budget (undo keeps ≥ 1). */
  private enforceByteBudget(): void {
    let total = 0
    for (const e of this.undoStack) total += this.entryBytes(e)
    for (const e of this.redoStack) total += this.entryBytes(e)
    while (total > this.byteBudget && this.undoStack.length > 1) {
      const evicted = this.undoStack.shift()!
      total -= this.entryBytes(evicted)
    }
  }

  /**
   * Record a completed command. No-ops (before === after) are dropped.
   * Recording clears the redo stack.
   */
  public push(entry: Omit<HistoryEntry<S, Sel>, 'timestamp'> & { timestamp?: number }): void {
    if (entry.before === entry.after && !entry.files?.length) return

    const timestamp = entry.timestamp ?? Date.now()
    this.redoStack = []

    const top = this.undoStack[this.undoStack.length - 1]
    if (
      top &&
      this.undoStack.length > this.sealedAt &&
      entry.mergeKey &&
      top.mergeKey === entry.mergeKey &&
      timestamp - top.timestamp < this.mergeWindowMs
    ) {
      // Coalesce: keep the original "before", adopt the new "after"
      top.after = entry.after
      top.files = mergeFiles(top.files, entry.files)
      top.selectionAfter = entry.selectionAfter
      top.timestamp = timestamp
      return
    }

    this.undoStack.push({ ...entry, timestamp })
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift()
    }
    this.enforceByteBudget()
  }

  /**
   * Step back. Returns the entry whose `before` state the caller should
   * apply, or null when there is nothing to undo.
   */
  public undo(): HistoryEntry<S, Sel> | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    if (entry.groupWithPrevious && this.undoStack.length > 0) {
      const previous = this.undoStack.pop()!
      const grouped: HistoryEntry<S, Sel> = {
        label: previous.label,
        before: previous.before,
        after: entry.after,
        selectionBefore: previous.selectionBefore,
        selectionAfter: entry.selectionAfter,
        files: mergeFiles(previous.files, entry.files),
        sizeBytes: this.entryBytes(previous) + this.entryBytes(entry),
        timestamp: entry.timestamp
      }
      this.redoStack.push(grouped)
      return grouped
    }
    this.redoStack.push(entry)
    return entry
  }

  /**
   * Step forward. Returns the entry whose `after` state the caller should
   * apply, or null when there is nothing to redo.
   */
  public redo(): HistoryEntry<S, Sel> | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    return entry
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Label of the command that undo would revert, or null. */
  public get undoLabel(): string | null {
    const top = this.undoStack[this.undoStack.length - 1]
    if (top?.groupWithPrevious && this.undoStack.length > 1) {
      return this.undoStack[this.undoStack.length - 2].label
    }
    return top?.label ?? null
  }

  /** Label of the command that redo would re-apply, or null. */
  public get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null
  }

  /** Where the history stands, for `rollback`; nothing after merges into what came before. */
  public mark(): number {
    this.sealedAt = this.undoStack.length
    return this.sealedAt
  }

  /**
   * Take back every entry since `mark`, leaving nothing to redo — a gesture
   * abandoned, as KiCad reverts its commit. The oldest entry taken, whose
   * `before` is the state at the mark; null when there was none.
   */
  public rollback(mark: number): HistoryEntry<S, Sel> | null {
    if (this.undoStack.length <= mark) return null
    const taken = this.undoStack.splice(mark)
    this.redoStack = []
    return taken[0]
  }

  public clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  /**
   * Rewrite every retained state (both stacks). Structural histories use this
   * to substitute an immutable snapshot for a live node that is about to be
   * mutated, keeping older entries valid.
   */
  public mapStates(fn: (state: S) => S): void {
    for (const entry of this.undoStack) {
      entry.before = fn(entry.before)
      entry.after = fn(entry.after)
    }
    for (const entry of this.redoStack) {
      entry.before = fn(entry.before)
      entry.after = fn(entry.after)
    }
  }
}
