/**
 * One open document whose model is derived from its text, for everyone who
 * reads or writes it.
 *
 * The symbol library and footprint editors both work this way: parse the text,
 * edit the parsed model, serialize, commit. That is the sheet session
 * (`lib/schematic/sheetSession.ts`) without a design around it, so it is one
 * module rather than two near-identical ones. The session owns the parsed
 * model and the undo history for as long as the tab is open, which is what
 * lets an editor be a view over it and an agent write to the same document
 * rather than to the file underneath it.
 */
import type { DocumentHandle } from './documentStore'
import type { HistoryEntry } from '../history'

/** What a command carries from a view, so undo can put the selection back. */
export interface TextCommandSelection<Sel> {
  before: Sel[]
  after(): Sel[]
}

export interface TextSessionDeps<M> {
  document: DocumentHandle
  parse(text: string): M
  serialize(model: M): string
  /** Land new text for this file in its tab's buffer. */
  commit(text: string): void
  readOnly(): boolean
}

export interface TextSession<M, Sel> {
  /** The parsed model as it is now, or null when the text does not parse. */
  model(): M | null
  /** Why the text does not parse, or null. Empty text is `empty`. */
  parseError(): string | null
  /** Bumped on every change to the model: a view's redraw key. */
  revision(): number
  subscribe(listener: () => void): () => void
  /** Catch up with the tab's text, if something else wrote it. */
  sync(): void
  /**
   * One undoable step. `mutate` edits the model in place; the text it
   * serializes to is committed and recorded. False when nothing changed.
   */
  runCommand(
    label: string,
    mutate: (model: M) => void,
    options?: { selection?: TextCommandSelection<Sel> }
  ): boolean
  undo(): HistoryEntry<string, Sel> | null
  redo(): HistoryEntry<string, Sel> | null
  /** Where the history stands, for `rollback`. */
  mark(): number
  /** Take back every command since `mark`, nothing left to redo: an abandoned gesture. */
  rollback(mark: number): void
  canUndo(): boolean
  canRedo(): boolean
  undoLabel(): string | null
  redoLabel(): string | null
}

export const createTextSession = <M, Sel>(deps: TextSessionDeps<M>): TextSession<M, Sel> => {
  /** The tab's text as this session last read or wrote it. */
  let known = deps.document.storedText()
  let model: M | null = null
  let parseError: string | null = null
  let revision = 0
  const listeners = new Set<() => void>()

  const history = (): ReturnType<DocumentHandle['history']> =>
    deps.document.history<string, Sel>() as ReturnType<DocumentHandle['history']>

  const changed = (): void => {
    revision += 1
    for (const listener of listeners) listener()
  }

  const read = (text: string): void => {
    known = text
    if (!text.trim()) {
      model = null
      parseError = 'empty'
      return
    }
    try {
      model = deps.parse(text)
      parseError = null
    } catch (error) {
      model = null
      parseError = error instanceof Error ? error.message : String(error)
    }
  }
  read(known)
  deps.document.openHistory<string, Sel>(known)

  /** The tab's text may have been rewritten behind this session — a rename's
   *  forwarding, an agent's write, a reload — so every entry starts from it. */
  const sync = (): void => {
    const text = deps.document.storedText()
    if (text === known) return
    read(text)
    deps.document.openHistory<string, Sel>(text)
    changed()
  }

  const land = (text: string): void => {
    read(text)
    deps.document.commitText(text)
    deps.commit(text)
    changed()
  }

  const runCommand = (
    label: string,
    mutate: (model: M) => void,
    options: { selection?: TextCommandSelection<Sel> } = {}
  ): boolean => {
    sync()
    const target = model
    if (!target || deps.readOnly()) return false
    const before = known
    mutate(target)
    let after: string
    try {
      after = deps.serialize(target)
    } catch (error) {
      console.error(`Failed to serialize after ${label}:`, error)
      // The model is mid-edit and no longer matches the text; re-read it.
      read(before)
      return false
    }
    if (after === before) return false
    land(after)
    history().push({
      label,
      before,
      after,
      selectionBefore: (options.selection?.before ?? []) as never[],
      selectionAfter: (options.selection?.after() ?? []) as never[]
    })
    return true
  }

  const step = (
    entry: HistoryEntry<string, Sel> | null,
    side: 'before' | 'after'
  ): HistoryEntry<string, Sel> | null => {
    if (!entry || deps.readOnly()) return null
    land(entry[side])
    return entry
  }

  return {
    model: () => model,
    parseError: () => parseError,
    revision: () => revision,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sync,
    runCommand,
    undo: () => step(history().undo() as HistoryEntry<string, Sel> | null, 'before'),
    redo: () => step(history().redo() as HistoryEntry<string, Sel> | null, 'after'),
    mark: () => history().mark(),
    rollback: (mark) =>
      void step(history().rollback(mark) as HistoryEntry<string, Sel> | null, 'before'),
    canUndo: () => history().canUndo,
    canRedo: () => history().canRedo,
    undoLabel: () => history().undoLabel,
    redoLabel: () => history().redoLabel
  }
}
