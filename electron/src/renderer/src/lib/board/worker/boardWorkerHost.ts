/**
 * A board session's side of its board worker (docs/performance-workstream.md,
 * "The board worker"). The session reports each change (`BoardSessionMirror`);
 * the host names every top-level item by an id, sends the worker the items it
 * does not hold as they now are, and publishes the new revision to the shared
 * control word first, so a job on the old board stops at its next slice. Jobs
 * the editor asks for answer with what the worker found, or null when a newer
 * change made the answer moot.
 *
 * Where there is no Worker (a test under node) the same engine runs on this
 * thread, behind the same messages.
 *
 * Each job that answers is measured on the page's timeline (`board:refill`,
 * `board:check`, and each zone or phase within, named after its job): the
 * DevTools Performance panel shows them, and `bin/board-timing` reads them.
 */
import { serializeSExpr, type SExprList, type SExprNode } from '../../kicad/sexpr'
import type { BoardDesignSettings } from '../../kicad/project'
import type { CheckResult } from '../../schematic/checks'
import type { Airwire } from '../boardConnectivity'
import type { BoardLibraryData } from '../boardLibraries'
import type { SchematicNetlist } from '../schematicNetlist'
import { BoardWorkerEngine } from './boardWorkerEngine'
import {
  CONTROL_REVISION,
  CONTROL_WORDS,
  type ChangeKind,
  type FillPoly,
  type FromWorker,
  type JobSpan,
  type ToWorker
} from './protocol'

/** Measures the page's timeline holds before the oldest are cleared (`measure`). */
const MAX_TIMELINE_MEASURES = 2000

/** What a board session tells its mirror. */
export interface BoardSessionMirror {
  /** A board was parsed from `text`; `root` is its tree. */
  loaded(text: string, root: SExprList): void
  /** The board changed: its top-level items are `root.children`, `mutated` changed in place. */
  changed(root: SExprList, mutated: ReadonlySet<SExprNode>, kind: ChangeKind): void
  /** The session holds no board. */
  cleared(): void
}

export interface RefillAnswer {
  fills: Array<{ zone: string; polys: FillPoly[] }>
  remaining: number
  ms: number
}

/** A board worker task whose last run the Performance tab shows. */
export type TimedTask = 'refill' | 'check' | 'ratsnest'

/** The last finished run of a task: how long, of what scope, and each step. */
export interface TaskTiming {
  /** What it covered: `all` or `dirty` zones, a `whole` check or one `since` the last. */
  scope: string
  ms: number
  spans: JobSpan[]
}

export interface ConnectivityAnswer {
  revision: number
  airwires: Airwire[]
  unrouted: number
}

interface Channel {
  post(message: ToWorker, transfer?: Transferable[]): void
  terminate(): void
}

export class BoardWorkerHost implements BoardSessionMirror {
  private channel: Channel
  // Shared, so a newer revision reaches a running job at once. Without
  // isolation (never in the app; see open()) the revision rides on messages.
  private readonly control = new Int32Array(
    typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(CONTROL_WORDS * 4)
      : new ArrayBuffer(CONTROL_WORDS * 4)
  )
  private ids = new WeakMap<SExprNode, number>()
  /** The ids the worker holds now: an item undo brings back must be sent again. */
  private held = new Set<number>()
  private nextId = 1
  private revisionNumber = 0
  private loadedRevision = -1
  private nextJob = 1
  private jobs = new Map<number, (message: FromWorker) => void>()
  private progressListeners = new Map<number, (done: number) => void>()
  /** What each job's measures are called: its kind and scope. */
  private jobNames = new Map<number, string>()
  private connectivityListeners = new Set<(answer: ConnectivityAnswer) => void>()
  private lastConnectivity: ConnectivityAnswer | null = null
  private timings: Partial<Record<TimedTask, TaskTiming>> = {}
  private timingListeners = new Set<(timings: Partial<Record<TimedTask, TaskTiming>>) => void>()
  /** What this worker was last sent, by version: it keeps them. */
  private sent = { settings: -1, libraries: -1, schematic: -1 }
  /** Set when the worker lost the board; the next change reloads it from `reload`. */
  private lost = false
  disposed = false

  /**
   * `reload` gives the board as it is now, for a worker that lost it. A test
   * hands in the engine to run on this thread, to read what it holds.
   */
  constructor(
    private readonly reload: () => { text: string; root: SExprList } | null,
    private readonly inThread?: BoardWorkerEngine
  ) {
    this.channel = this.open()
  }

  private open(): Channel {
    const receive = (message: FromWorker): void => this.receive(message)
    let channel: Channel
    if (!this.inThread && typeof Worker !== 'undefined') {
      if (
        typeof SharedArrayBuffer === 'undefined' ||
        !(this.control.buffer instanceof SharedArrayBuffer)
      ) {
        console.error(
          'board worker: the page is not cross-origin isolated (no SharedArrayBuffer); check how it is served'
        )
      }
      const worker = new Worker(new URL('./boardWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<FromWorker>) => receive(e.data)
      worker.onerror = (e) => {
        console.error('board worker failed:', e.message)
        this.restart()
      }
      channel = {
        post: (message, transfer) => worker.postMessage(message, transfer ?? []),
        terminate: () => worker.terminate()
      }
    } else {
      const engine =
        this.inThread ?? new BoardWorkerEngine((message) => queueMicrotask(() => receive(message)))
      if (this.inThread) this.inThread.post = (message) => queueMicrotask(() => receive(message))
      channel = {
        post: (message) => void engine.handle(message),
        terminate: () => {}
      }
    }
    channel.post({ type: 'init', control: this.control.buffer })
    this.sent = { settings: -1, libraries: -1, schematic: -1 }
    return channel
  }

  /** Start a fresh worker and give it the board as it is now. */
  private restart(): void {
    if (this.disposed) return
    this.channel.terminate()
    for (const resolve of this.jobs.values()) resolve({ type: 'error', message: 'restarted' })
    this.jobs.clear()
    this.jobNames.clear()
    this.progressListeners.clear()
    this.channel = this.open()
    const current = this.reload()
    if (current) this.loaded(current.text, current.root)
  }

  get revision(): number {
    return this.revisionNumber
  }

  private publish(): number {
    this.revisionNumber += 1
    Atomics.store(this.control, CONTROL_REVISION, this.revisionNumber)
    this.lastConnectivity = null
    return this.revisionNumber
  }

  private idOf(node: SExprNode): { id: number } {
    const known = this.ids.get(node)
    if (known !== undefined) return { id: known }
    const id = this.nextId++
    this.ids.set(node, id)
    return { id }
  }

  loaded(text: string, root: SExprList): void {
    if (this.disposed) return
    const revision = this.publish()
    this.ids = new WeakMap()
    const ids = Int32Array.from(root.children, (node) => this.idOf(node).id)
    this.held = new Set(ids)
    this.lost = false
    this.loadedRevision = revision
    this.channel.post({ type: 'load', revision, text, ids })
  }

  changed(root: SExprList, mutated: ReadonlySet<SExprNode>, kind: ChangeKind): void {
    if (this.disposed) return
    if (this.lost) {
      const current = this.reload()
      if (current) this.loaded(current.text, current.root)
      return
    }
    const revision = this.publish()
    const order = new Int32Array(root.children.length)
    const texts: Array<[number, string]> = []
    root.children.forEach((node, i) => {
      const { id } = this.idOf(node)
      order[i] = id
      if (!this.held.has(id) || mutated.has(node)) texts.push([id, serializeSExpr(node)])
    })
    this.held = new Set(order)
    this.channel.post({ type: 'change', revision, kind, order, texts })
  }

  cleared(): void {
    if (this.disposed) return
    const revision = this.publish()
    this.channel.post({ type: 'unload', revision })
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'loaded':
        if (!message.ok) console.error('board worker could not load the board:', message.error)
        return
      case 'connectivity': {
        if (message.revision !== this.revisionNumber) return
        const answer = {
          revision: message.revision,
          airwires: message.airwires,
          unrouted: message.unrouted
        }
        this.lastConnectivity = answer
        for (const listener of this.connectivityListeners) listener(answer)
        this.timed('ratsnest', {
          scope: 'whole',
          ms: message.ms,
          spans: []
        })
        return
      }
      case 'refilled':
      case 'checked':
        if (message.error) console.error(`board worker: ${message.type} failed:`, message.error)
        this.measure(message)
        this.jobs.get(message.job)?.(message)
        this.jobs.delete(message.job)
        this.progressListeners.delete(message.job)
        return
      case 'progress':
        this.progressListeners.get(message.job)?.(message.done)
        return
      case 'error':
        // The worker's copy no longer follows the session: reload it at the next change.
        console.error('board worker:', message.message)
        this.lost = true
        // A job the worker failed under will not answer: answer it with nothing.
        for (const resolve of this.jobs.values()) resolve(message)
        this.jobs.clear()
        this.jobNames.clear()
        this.progressListeners.clear()
        return
    }
  }

  /** A finished job and its spans on the page's timeline, and kept as its task's last run; a cancelled or failed one is not. */
  private measure(message: Extract<FromWorker, { type: 'refilled' | 'checked' }>): void {
    const name = this.jobNames.get(message.job)
    this.jobNames.delete(message.job)
    const answered = message.type === 'refilled' ? message.fills : message.results
    if (!name || !answered) return
    const superseded = message.revision !== this.revisionNumber
    if (typeof performance.measure === 'function') {
      // The timeline keeps every measure until cleared: past a session's worth,
      // the old ones go before the next job's land (what reads them, DevTools
      // and board-timing, wants the latest jobs).
      if (performance.getEntriesByType('measure').length > MAX_TIMELINE_MEASURES)
        performance.clearMeasures()
      const at = (epoch: number): number => epoch - performance.timeOrigin
      performance.measure(name, {
        start: at(message.started),
        duration: message.ms,
        detail: { revision: message.revision, superseded, steps: message.spans.length }
      })
      for (const span of message.spans) {
        performance.measure(`${name} · ${span.name}`, { start: at(span.start), duration: span.ms })
      }
    }
    // An answer for a board since edited is dropped, and its run is not the board's last.
    if (superseded) return
    this.timed(message.type === 'refilled' ? 'refill' : 'check', {
      scope: name.split(' ').pop() ?? '',
      ms: message.ms,
      spans: message.spans
    })
  }

  private timed(task: TimedTask, timing: TaskTiming): void {
    this.timings = { ...this.timings, [task]: timing }
    for (const listener of this.timingListeners) listener(this.timings)
  }

  /** The last finished run of each task as each lands; what is known at once. */
  onTimings(listener: (timings: Partial<Record<TimedTask, TaskTiming>>) => void): () => void {
    this.timingListeners.add(listener)
    listener(this.timings)
    return () => this.timingListeners.delete(listener)
  }

  /** The ratsnest of each revision as the worker finishes it; the current one at once if known. */
  onConnectivity(listener: (answer: ConnectivityAnswer) => void): () => void {
    this.connectivityListeners.add(listener)
    if (this.lastConnectivity) listener(this.lastConnectivity)
    return () => this.connectivityListeners.delete(listener)
  }

  private request<T extends FromWorker>(
    name: string,
    build: (job: number, revision: number) => ToWorker,
    progress?: (done: number) => void
  ): Promise<T | null> {
    if (this.disposed || this.loadedRevision < 0) return Promise.resolve(null)
    const job = this.nextJob++
    this.jobNames.set(job, name)
    if (progress) this.progressListeners.set(job, progress)
    const revision = this.revisionNumber
    return new Promise((resolve) => {
      this.jobs.set(job, (message) => {
        const answered = message as T & { revision?: number }
        resolve(
          message.type === 'error' || answered.revision !== this.revisionNumber ? null : answered
        )
      })
      this.channel.post(build(job, revision))
    })
  }

  /**
   * Refill every zone of the current board. `progress` hears how far it has
   * got, 0–1, as it runs.
   */
  async refill(options: {
    settings: BoardDesignSettings
    budgetMs?: number
    progress?: (done: number) => void
  }): Promise<RefillAnswer | null> {
    const answer = await this.request<Extract<FromWorker, { type: 'refilled' }>>(
      'board:refill all',
      (job, revision) => ({
        type: 'refill',
        revision,
        job,
        settings: plain(options.settings),
        budgetMs: options.budgetMs
      }),
      options.progress
    )
    return answer?.fills
      ? { fills: answer.fills, remaining: answer.remaining, ms: answer.ms }
      : null
  }

  /**
   * Check the current board: around the edits since the last check, or whole.
   * `progress` hears how far it has got, 0–1, as it runs.
   */
  async check(options: {
    settings: { version: number; value: BoardDesignSettings }
    libraries: { version: number; value: BoardLibraryData | null }
    schematic: { version: number; value: SchematicNetlist | null }
    whole: boolean
    progress?: (done: number) => void
  }): Promise<CheckResult[] | null> {
    const { settings, libraries, schematic } = options
    const message: Omit<Extract<ToWorker, { type: 'check' }>, 'job' | 'revision'> = {
      type: 'check',
      settingsVersion: settings.version,
      librariesVersion: libraries.version,
      schematicVersion: schematic.version,
      whole: options.whole
    }
    if (this.sent.settings !== settings.version) message.settings = plain(settings.value)
    if (this.sent.libraries !== libraries.version) message.libraries = libraries.value
    if (this.sent.schematic !== schematic.version) message.schematic = schematic.value
    this.sent = {
      settings: settings.version,
      libraries: libraries.version,
      schematic: schematic.version
    }
    const answer = await this.request<Extract<FromWorker, { type: 'checked' }>>(
      `board:check ${options.whole ? 'whole' : 'since'}`,
      (job, revision) => ({
        ...message,
        job,
        revision
      }),
      options.progress
    )
    return answer?.results ?? null
  }

  dispose(): void {
    this.disposed = true
    this.publish()
    for (const resolve of this.jobs.values()) resolve({ type: 'error', message: 'disposed' })
    this.jobs.clear()
    this.jobNames.clear()
    this.progressListeners.clear()
    this.channel.terminate()
  }
}

/**
 * The settings as plain data: the editor's are Vue proxies, which a worker
 * cannot be sent. They are JSON by nature (numbers, strings, lists).
 */
const plain = (settings: BoardDesignSettings): BoardDesignSettings =>
  JSON.parse(JSON.stringify(settings)) as BoardDesignSettings
