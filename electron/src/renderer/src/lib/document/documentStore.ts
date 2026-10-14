/**
 * The files a window has open, one document each, outliving any view of them.
 *
 * An editor is mounted only for the tab in front and rebuilt on every switch, so
 * what has to survive a switch lives here, keyed by path: the text, what is on
 * disk, undo history, the revision agents read, and a parsed model a view left
 * behind. See ARCHITECTURE.md §3.13.
 */
import { CommandHistory, type SelectionItem } from '../history'

export type DocumentKind = 'schematic' | 'board' | 'symbol-library' | 'footprint' | 'other'

/** `discarded` is reserved for freeing memory later; nothing discards yet. */
export type DocumentState = 'loaded' | 'discarded'

export type DocumentActivity = 'viewed' | 'agent'

/**
 * A session that derives this document's text from something richer — a parsed
 * board it edits in place, whose text is written out lazily. The document asks
 * it before answering `text()`, so a reader never sees text that owes an edit.
 */
export interface TextSource {
  /** True while the text owes an edit the session already holds. */
  pending(): boolean
  /** Write the pending edit out now, and return the text. */
  flush(): string
}

/** A file's disk text, for reading a discarded document back; null when it cannot be read. */
export type DocumentReader = (path: string) => Promise<string | null>

export type DocumentListener = (document: DocumentHandle) => void

const VIRTUAL_FOOTPRINT_PREFIXES = ['readonly-lib://']

export const documentKindOf = (path: string): DocumentKind => {
  const lower = path.toLowerCase()
  if (lower.startsWith('design-copy://symbol/')) return 'symbol-library'
  if (lower.startsWith('design-copy://footprint/')) return 'footprint'
  if (lower.endsWith('.kicad_sch')) return 'schematic'
  if (lower.endsWith('.kicad_pcb')) return 'board'
  if (lower.endsWith('.kicad_sym')) return 'symbol-library'
  if (
    lower.endsWith('.kicad_mod') ||
    VIRTUAL_FOOTPRINT_PREFIXES.some((prefix) => lower.startsWith(prefix))
  ) {
    return 'footprint'
  }
  return 'other'
}

/**
 * Bytes a parsed model takes per character of its text, measured with the app's
 * own parsers on large real files. Good enough
 * to rank documents by what freeing them would return, which is all it is for.
 */
const PARSED_BYTES_PER_CHAR: Record<DocumentKind, number> = {
  schematic: 20,
  board: 8,
  'symbol-library': 48,
  footprint: 22,
  other: 0
}

/** A JavaScript string takes up to two bytes a character. */
const TEXT_BYTES_PER_CHAR = 2

export class DocumentHandle {
  readonly path: string
  readonly kind: DocumentKind
  private currentState: DocumentState = 'loaded'
  private content: string
  private diskText: string
  private revisionNumber = 0
  private undo: CommandHistory<unknown, unknown> | null = null
  /** The text the history's owner last committed; undefined until one has. */
  private committed: string | undefined
  private source: TextSource | null = null
  private readonly pinned = new Map<symbol, string>()
  private readonly activity = new Map<DocumentActivity, number>()
  private reloading: Promise<void> | null = null

  constructor(
    path: string,
    text: string,
    baseline: string,
    private readonly reader: DocumentReader,
    private readonly notify: DocumentListener
  ) {
    this.path = path
    this.kind = documentKindOf(path)
    this.content = text
    this.diskText = baseline
  }

  state(): DocumentState {
    return this.currentState
  }

  /** Moves on every change to the text, and only then. */
  revision(): number {
    return this.revisionNumber
  }

  /** The current text, with any edit its session still owes written out first. */
  text(): string {
    this.assertLoaded('text')
    if (this.source?.pending()) {
      const written = this.source.flush()
      this.committed = written
      if (written !== this.content) {
        this.content = written
        this.revisionNumber += 1
      }
      this.notify(this)
    }
    return this.content
  }

  /** The text as stored, leaving an edit its session owes unwritten: for a
   *  reader that drives that session itself. */
  storedText(): string {
    this.assertLoaded('storedText')
    return this.content
  }

  /** What the file holds on disk, as of the last load or save. */
  baseline(): string {
    this.assertLoaded('baseline')
    return this.diskText
  }

  isDirty(): boolean {
    if (this.currentState !== 'loaded') return false
    return (this.source?.pending() ?? false) || this.content !== this.diskText
  }

  /**
   * Replace the text; `saved` says the same text is now on disk. Text landed
   * from outside is the truth, and a session reads it back on its next load.
   */
  setText(text: string, options: { saved?: boolean } = {}): void {
    this.assertLoaded('setText')
    let changed = false
    if (text !== this.content) {
      this.content = text
      this.revisionNumber += 1
      changed = true
    }
    if (options.saved && this.diskText !== text) {
      this.diskText = text
      changed = true
    }
    if (changed) this.notify(this)
  }

  markSaved(text: string): void {
    this.setText(text, { saved: true })
  }

  /** Text read from disk just now replaces what the document holds, loaded or not. */
  reload(text: string): void {
    const wasDiscarded = this.currentState === 'discarded'
    this.currentState = 'loaded'
    if (wasDiscarded || text !== this.content) this.revisionNumber += 1
    this.content = text
    this.diskText = text
    this.notify(this)
  }

  /** This file's undo history, however many views have come and gone. */
  history<S = string, Sel = SelectionItem>(): CommandHistory<S, Sel> {
    this.assertLoaded('history')
    if (!this.undo) this.undo = new CommandHistory<unknown, unknown>()
    return this.undo as unknown as CommandHistory<S, Sel>
  }

  /**
   * The history, for a view opening on `text`: cleared when that is not what the
   * history last committed, since every entry would then predate a change it
   * does not hold and undoing it would silently revert that change.
   */
  openHistory<S = string, Sel = SelectionItem>(text: string): CommandHistory<S, Sel> {
    const history = this.history<S, Sel>()
    if (this.committed !== undefined && this.committed !== text) history.clear()
    this.committed = text
    return history
  }

  /** Record that `text` is what the history's owner has now committed. */
  commitText(text: string): void {
    this.committed = text
  }

  hasHistory(): boolean {
    return !!this.undo && (this.undo.canUndo || this.undo.canRedo)
  }

  /** Attach the session that derives this document's text; returns the detach. */
  /**
   * Closed: let go of what reaches the editor — the session behind the text
   * source, the history's commands — so a handle something stray still holds
   * keeps its text and nothing of the board or sheet behind it.
   */
  release(): void {
    this.source = null
    this.undo = null
    this.committed = undefined
  }

  attachTextSource(source: TextSource): () => void {
    this.source = source
    this.notify(this)
    return () => {
      if (this.source === source) this.source = null
    }
  }

  /** Keep the document loaded until the returned release is called. */
  pin(reason: string): () => void {
    const token = Symbol(reason)
    this.pinned.set(token, reason)
    return () => {
      this.pinned.delete(token)
    }
  }

  pins(): string[] {
    return [...this.pinned.values()]
  }

  touch(activity: DocumentActivity, at: number = Date.now()): void {
    this.activity.set(activity, at)
  }

  lastActive(activity: DocumentActivity): number | null {
    return this.activity.get(activity) ?? null
  }

  /**
   * Roughly what freeing this document would return, in bytes: the text, plus
   * what a session attached to it holds parsed.
   */
  estimatedBytes(): number {
    if (this.currentState !== 'loaded') return 0
    let bytes = this.content.length * TEXT_BYTES_PER_CHAR
    if (this.diskText !== this.content) bytes += this.diskText.length * TEXT_BYTES_PER_CHAR
    if (this.source) bytes += this.content.length * PARSED_BYTES_PER_CHAR[this.kind]
    return bytes
  }

  /**
   * Free the text and anything parsed, keeping the path, revision and activity.
   * Refused while dirty, pinned or holding undo history, none of which a read
   * from disk could bring back.
   */
  discard(): boolean {
    if (this.currentState !== 'loaded') return false
    if (this.isDirty() || this.pinned.size > 0 || this.hasHistory()) return false
    this.currentState = 'discarded'
    this.content = ''
    this.diskText = ''
    this.undo = null
    this.committed = undefined
    this.notify(this)
    return true
  }

  /** Resolves once the document is loaded, reading a discarded one back from disk. */
  ready(): Promise<void> {
    if (this.currentState === 'loaded') return Promise.resolve()
    if (!this.reloading) {
      this.reloading = this.reader(this.path).then(
        (text) => {
          this.reloading = null
          if (text === null) throw new Error(`${this.path} could not be read back`)
          if (this.currentState === 'discarded') this.reload(text)
        },
        (error: unknown) => {
          this.reloading = null
          throw error
        }
      )
    }
    return this.reloading
  }

  private assertLoaded(operation: string): void {
    if (this.currentState !== 'loaded') {
      throw new Error(`${operation} on discarded document ${this.path}; await ready() first`)
    }
  }
}

export class DocumentStore {
  private readonly byPath = new Map<string, DocumentHandle>()
  private readonly listeners = new Set<DocumentListener>()

  constructor(private readonly reader: DocumentReader) {}

  /** The document for `path`, created from `text` when none is open; an open one is returned unchanged. */
  open(path: string, text: string, baseline: string = text): DocumentHandle {
    const existing = this.byPath.get(path)
    if (existing) return existing
    const document = new DocumentHandle(path, text, baseline, this.reader, this.broadcast)
    this.byPath.set(path, document)
    return document
  }

  /** The document for `path` holding text just read from disk, creating it if need be. */
  load(path: string, text: string): DocumentHandle {
    const existing = this.byPath.get(path)
    if (!existing) return this.open(path, text)
    existing.reload(text)
    return existing
  }

  get(path: string): DocumentHandle | null {
    return this.byPath.get(path) ?? null
  }

  has(path: string): boolean {
    return this.byPath.has(path)
  }

  /** The open document for `path`, falling back to `same` for spellings of one file that differ. */
  find(path: string, same: (a: string, b: string) => boolean): DocumentHandle | null {
    const exact = this.byPath.get(path)
    if (exact) return exact
    for (const [key, document] of this.byPath) {
      if (same(key, path)) return document
    }
    return null
  }

  close(path: string): void {
    this.byPath.get(path)?.release()
    this.byPath.delete(path)
  }

  paths(): string[] {
    return [...this.byPath.keys()]
  }

  documents(): DocumentHandle[] {
    return [...this.byPath.values()]
  }

  /** Called on every change to any document's text, disk text, session or state. */
  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private readonly broadcast = (document: DocumentHandle): void => {
    for (const listener of this.listeners) listener(document)
  }
}

const readFromDisk: DocumentReader = async (path) => {
  if (path.includes('://')) return null
  const result = await window.api.readFile(path)
  return result.success && typeof result.content === 'string' ? result.content : null
}

/** This window's documents. */
export const documentStore = new DocumentStore(readFromDisk)
