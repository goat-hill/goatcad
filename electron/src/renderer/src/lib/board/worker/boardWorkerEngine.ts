/**
 * What the board worker does with each message (docs/performance-workstream.md,
 * "The board worker"), apart from the worker itself so it runs under test.
 *
 * It keeps the session's board (`BoardMirror`) and the state that makes the
 * work after an edit small: the ratsnest, the last check run and the edits
 * since it. A refill fills every zone but the teardrops no edit came near
 * since their fill landed. Each change the session makes is
 * applied as it arrives; the ratsnest follows every change, and the refill and
 * the check run when the session asks for them. Every job is for one revision
 * and gives up, between slices, once the session publishes a newer one or asks
 * for another job of its kind: one check and one refill run at a time.
 */
import { loadClipper } from '../../geometry/clip'
import type { BoardDesignSettings } from '../../kicad/project'
import type { SExprNode } from '../../kicad/sexpr'
import { computeConnectivitySteps, type BoardConnectivity } from '../boardConnectivity'
import { boardCheckRun } from '../boardChecks'
import { boardLibrariesOf, type BoardLibraries } from '../boardLibraries'
import type { SchematicNetlist } from '../schematicNetlist'
import { zoneKey } from '../boardItems'
import type { BoardCheckRun } from '../drc/incremental'
import { boardRules } from '../rules/boardRules'
import type { CheckResult } from '../../schematic/checks'
import type { BoardSpatialIndex } from '../spatialIndex'
import { computeRefill } from '../zoneRefill'
import { isTeardropZone, type KicadBoard, type KicadBoardZone } from '../../kicad/board'
import { findChild, getToken } from '../../kicad/sexpr'
import { zoneFillOptions } from '../zoneFill'
import type { CopperItem } from '../spatialIndex'
import { BoardMirror } from './boardMirror'
import {
  CONTROL_REVISION,
  type FillPoly,
  type FromWorker,
  type JobSpan,
  type ToWorker
} from './protocol'

/** How long a job runs between looks at the control word and the message queue. */
const SLICE_MS = 30

type Post = (message: FromWorker, transfer?: Transferable[]) => void

export class BoardWorkerEngine {
  private mirror = new BoardMirror()
  /** The shared control word, when the page is isolated: the latest revision as it is published. */
  private control: Int32Array | null = null
  /** The latest revision a message has brought: what a job answers to without the control word. */
  private revisionSeen = 0
  private connectivity: { board: KicadBoard; value: BoardConnectivity } | null = null
  /** The ratsnest being computed, so a check on the same board waits for it, not redoes it. */
  private connectivityPending: {
    board: KicadBoard
    value: Promise<BoardConnectivity | null>
  } | null = null
  /** How long each phase of a check took last time, ms: what a check's progress is weighed by. */
  private phaseMs = new Map<string, number>(Object.entries(PHASE_MS))
  /** How long each zone took to fill last time, ms, by zone key: what a refill's progress is weighed by. */
  private zoneMs = new Map<string, number>()
  private connectivityRun = 0
  private lastCheck: BoardCheckRun | null = null
  /** The edits since the last check's board, while they can be followed. */
  private checkChain: {
    fromBoard: KicadBoard
    fromIndex: BoardSpatialIndex
    raws: Set<SExprNode>
  } | null = null
  private chainBroken = false
  private settings: { version: number; value: BoardDesignSettings } | null = null
  private libraries: { version: number; value: BoardLibraries | undefined } | null = null
  private schematic: { version: number; value: SchematicNetlist | null } | null = null
  /**
   * Teardrops whose stored fill is current, by item id: a refill leaves them
   * be. A teardrop's fill reads only the copper near it, and a board can hold
   * thousands, each costing the filler as much as a small pour.
   */
  private freshTeardrops = new Set<number>()
  /** The teardrops the last refill filled, fresh once its commit arrives. */
  private filledTeardrops = new Set<number>()
  /** Where edits since put or took copper, for the teardrops near it; 'all' when anywhere. */
  private teardropDirt: Box[] | 'all' = []
  /** The latest job of each kind: an older one gives up at its next slice. */
  private latest = { refill: 0, check: 0 }

  /**
   * Clipper, loaded before the first message is handled: the board's index,
   * its pads' copper and several rules read differently without it, and say
   * nothing when it is missing.
   */
  private readonly ready: Promise<void>

  constructor(public post: Post) {
    this.ready = loadClipper()
  }

  /** The board as this worker holds it. */
  get board(): KicadBoard | null {
    return this.mirror.board
  }

  /**
   * Whether the session has moved past `revision`. A job looks between slices,
   * after the queue has had its turn, so the changes sent since have arrived;
   * the control word also tells of one still in flight.
   */
  private superseded(revision: number): boolean {
    const latest = this.control ? Atomics.load(this.control, CONTROL_REVISION) : this.revisionSeen
    return latest !== revision
  }

  /** Whether a job is moot: its board is gone, or a newer job of its kind was asked for. */
  private moot(kind: 'refill' | 'check', job: number, revision: number): boolean {
    return this.latest[kind] !== job || this.superseded(revision)
  }

  async handle(message: ToWorker): Promise<void> {
    // Every message waits on the same promise, so they are still handled in
    // order. Without Clipper this throws: the host hears and drops the jobs.
    await this.ready
    if ('revision' in message) this.revisionSeen = Math.max(this.revisionSeen, message.revision)
    switch (message.type) {
      case 'init':
        // A copied buffer (no isolation) would hold the revision it was sent with, forever.
        this.control =
          typeof SharedArrayBuffer !== 'undefined' && message.control instanceof SharedArrayBuffer
            ? new Int32Array(message.control)
            : null
        return
      case 'load':
        return this.load(message.revision, message.text, message.ids)
      case 'change':
        return this.change(message)
      case 'refill':
        this.latest.refill = message.job
        return this.refill(message).catch((error: unknown) =>
          this.post({ ...failed(message, error), type: 'refilled', fills: null, remaining: 0 })
        )
      case 'check':
        // Kept as they arrive, before any job awaits: every check reads the latest.
        this.latest.check = message.job
        this.keepInputs(message)
        return this.check(message).catch((error: unknown) =>
          this.post({ ...failed(message, error), type: 'checked', results: null })
        )
      case 'unload':
        this.mirror.clear()
        this.connectivity = null
        this.lastCheck = null
        this.checkChain = null
        return
    }
  }

  private load(revision: number, text: string, ids: Int32Array): void {
    this.freshTeardrops.clear()
    this.filledTeardrops.clear()
    this.teardropDirt = []
    this.connectivity = null
    this.lastCheck = null
    this.checkChain = null
    this.chainBroken = false
    try {
      this.mirror.load(text, ids)
      this.post({ type: 'loaded', revision, ok: true })
    } catch (error) {
      this.mirror.clear()
      this.post({ type: 'loaded', revision, ok: false, error: String(error) })
      return
    }
    void this.updateConnectivity(revision)
  }

  private change(message: Extract<ToWorker, { type: 'change' }>): void {
    if (!this.mirror.board) return
    let change
    try {
      change = this.mirror.apply(message.order, message.texts)
    } catch (error) {
      // The copy has lost the session's board: say so, and wait to be reloaded.
      this.mirror.clear()
      this.post({ type: 'error', message: String(error) })
      return
    }
    if (message.kind === 'refill') {
      for (const id of this.filledTeardrops) this.freshTeardrops.add(id)
      this.filledTeardrops.clear()
    } else this.noteTeardropDirt(change.from, change.raws)
    // The check follows the edits from its last board, as long as they chain.
    if (this.lastCheck) {
      if (!this.checkChain && change.from.board === this.lastCheck.input.board) {
        this.checkChain = {
          fromBoard: change.from.board,
          fromIndex: change.from.index,
          raws: new Set()
        }
      }
      if (this.checkChain) for (const raw of change.raws) this.checkChain.raws.add(raw)
      else this.chainBroken = true
    }
    void this.updateConnectivity(message.revision)
  }

  /** Where an edit's copper was and is, before and after; anywhere for an outline or drawing. */
  private noteTeardropDirt(
    from: { board: KicadBoard; index: BoardSpatialIndex },
    raws: ReadonlySet<SExprNode>
  ): void {
    if (this.teardropDirt === 'all' || this.freshTeardrops.size === 0) return
    for (const raw of raws) {
      const token = getToken(raw)
      if (token !== null && (token.startsWith('gr_') || TEARDROP_GLOBAL.has(token))) {
        this.teardropDirt = 'all'
        return
      }
      if (token === 'zone' && raw.type === 'list' && findChild(raw, 'keepout')) {
        this.teardropDirt = 'all'
        return
      }
    }
    const touched = (board: KicadBoard, index: BoardSpatialIndex | null): void => {
      if (!index || this.teardropDirt === 'all') return
      for (const item of index.items)
        if (raws.has(copperOwner(board, item) as SExprNode)) this.teardropDirt.push(item)
    }
    touched(from.board, from.index)
    if (this.mirror.board) touched(this.mirror.board, this.mirror.index)
  }

  /** Drive a generator in slices, yielding to the queue between them; null once moot. */
  private async drive<T>(steps: Generator<unknown, T>, moot: () => boolean): Promise<T | null> {
    let sliceStart = performance.now()
    let step = steps.next()
    while (!step.done) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToQueue()
        if (moot()) return null
        sliceStart = performance.now()
      }
      step = steps.next()
    }
    return step.value
  }

  private async updateConnectivity(revision: number): Promise<void> {
    const run = ++this.connectivityRun
    const board = this.mirror.board
    const index = this.mirror.index
    if (!board || !index) return
    const started = performance.now()
    const pending = this.drive(
      computeConnectivitySteps(board, index),
      () => run !== this.connectivityRun || this.superseded(revision)
    )
    this.connectivityPending = { board, value: pending }
    const value = await pending
    if (this.connectivityPending?.value === pending) this.connectivityPending = null
    if (!value || run !== this.connectivityRun) return
    this.connectivity = { board, value }
    this.post({
      type: 'connectivity',
      revision,
      airwires: value.airwires,
      unrouted: value.unrouted,
      ms: performance.now() - started,
      started: performance.timeOrigin + started
    })
  }

  /** The ratsnest of the current board, computing it if a change has outrun it. */
  private async currentConnectivity(moot: () => boolean): Promise<BoardConnectivity | null> {
    const board = this.mirror.board
    if (!board) return null
    if (this.connectivity?.board === board) return this.connectivity.value
    if (this.connectivityPending?.board === board) {
      const value = await this.connectivityPending.value
      if (value) return value
    }
    if (moot() || this.mirror.board !== board) return null
    const index = this.mirror.index!
    const value = await this.drive(computeConnectivitySteps(board, index), moot)
    if (value && this.mirror.board === board) this.connectivity = { board, value }
    return value
  }

  private async refill(message: Extract<ToWorker, { type: 'refill' }>): Promise<void> {
    const { revision, job } = message
    const started = performance.now()
    let spans: JobSpan[] = []
    const answer = (
      fills: Array<{ zone: string; polys: FillPoly[] }> | null,
      remaining = 0
    ): void => {
      const transfer = fills?.flatMap((fill) => fill.polys.map((poly) => poly.points.buffer)) ?? []
      this.post(
        {
          type: 'refilled',
          revision,
          job,
          fills,
          remaining,
          ms: performance.now() - started,
          started: performance.timeOrigin + started,
          spans
        },
        transfer
      )
    }
    const moot = (): boolean => this.moot('refill', job, revision)
    const board = this.mirror.board
    const index = this.mirror.index
    if (!board || !index || moot()) return answer(null)
    const rules = boardRules(board, message.settings, message.settings.customRules)
    const progress = new JobProgress(this.zoneMs, (done) =>
      this.post({ type: 'progress', job, done })
    )
    const ticker = setInterval(() => progress.report(), PROGRESS_MS)
    // Teardrops nothing came near keep their fill; the rest fill again.
    const dirt = this.teardropDirt
    this.teardropDirt = []
    const isFresh = (zone: KicadBoardZone): boolean => {
      const id = this.mirror.idOf(zone._raw)
      if (id === undefined || !this.freshTeardrops.has(id)) return false
      if (dirt === 'all') return false
      const reach = zoneFillOptions(rules, zone).maxClearance + 1
      const pts = zone.points.map((p) => ({ x: p.x / 1e6, y: -p.y / 1e6 }))
      const box = {
        minX: Math.min(...pts.map((p) => p.x)) - reach,
        maxX: Math.max(...pts.map((p) => p.x)) + reach,
        minY: Math.min(...pts.map((p) => p.y)) - reach,
        maxY: Math.max(...pts.map((p) => p.y)) + reach
      }
      return !dirt.some(
        (d) => d.minX <= box.maxX && d.maxX >= box.minX && d.minY <= box.maxY && d.maxY >= box.minY
      )
    }
    const targets = new Set<KicadBoardZone>()
    this.filledTeardrops.clear()
    const nowFresh = new Set<number>()
    for (const zone of board.zones) {
      if (!isTeardropZone(zone)) targets.add(zone)
      else if (isFresh(zone)) nowFresh.add(this.mirror.idOf(zone._raw)!)
      else {
        targets.add(zone)
        const id = this.mirror.idOf(zone._raw)
        if (id !== undefined) this.filledTeardrops.add(id)
      }
    }
    this.freshTeardrops = nowFresh
    const result = await computeRefill(board, index, rules, targets, {
      ...(message.budgetMs !== undefined ? { deadline: started + message.budgetMs } : {}),
      cancelled: moot,
      zone: (zone, plan) => progress.phase(zoneKey(zone), plan.map(zoneKey), zoneLabel(zone))
    }).finally(() => clearInterval(ticker))
    if (result) spans = progress.finish()
    if (!result || moot()) return answer(null)
    answer(
      result.fills.map(({ zone, polys }) => ({
        zone: zoneKey(zone),
        polys: polys.map((poly) => {
          const points = new Int32Array(poly.points.length * 2)
          poly.points.forEach((p, i) => {
            points[2 * i] = p.x
            points[2 * i + 1] = p.y
          })
          return { layer: poly.layer, points }
        })
      })),
      result.remaining.length
    )
  }

  private async check(message: Extract<ToWorker, { type: 'check' }>): Promise<void> {
    const { revision, job } = message
    const started = performance.now()
    let spans: JobSpan[] = []
    const answer = (results: CheckResult[] | null): void =>
      this.post({
        type: 'checked',
        revision,
        job,
        results,
        ms: performance.now() - started,
        started: performance.timeOrigin + started,
        spans
      })
    const moot = (): boolean => this.moot('check', job, revision)
    const board = this.mirror.board
    const index = this.mirror.index
    if (!board || !index) return answer(null)
    const progress = new JobProgress(this.phaseMs, (done) =>
      this.post({ type: 'progress', job, done })
    )
    if (this.connectivity?.board !== board) progress.phase('ratsnest', [])
    const ticker = setInterval(() => progress.report(), PROGRESS_MS)
    try {
      const results = await this.runCheck(message, board, index, moot, progress)
      if (results) spans = progress.finish()
      answer(results)
    } finally {
      clearInterval(ticker)
    }
  }

  private async runCheck(
    message: Extract<ToWorker, { type: 'check' }>,
    board: KicadBoard,
    index: BoardSpatialIndex,
    moot: () => boolean,
    progress: JobProgress
  ): Promise<CheckResult[] | null> {
    const connectivity = await this.currentConnectivity(moot)
    if (!connectivity || moot()) return null
    // The host sends the settings with the first check that uses them.
    if (!this.settings || this.settings.version !== message.settingsVersion) return null
    const input = {
      board,
      index,
      connectivity,
      settings: this.settings.value,
      libraries: this.libraries?.value,
      schematic: this.schematic?.value ?? null
    }
    // The settings object is the same while its version is, so a run can tell they held.
    const last =
      !message.whole && this.lastCheck?.input.settings === input.settings ? this.lastCheck : null
    const chain = this.checkChain
    const since = !last
      ? undefined
      : last.input.board === board
        ? { run: last, edit: { fromBoard: board, fromIndex: index, raws: new Set<SExprNode>() } }
        : chain && !this.chainBroken && chain.fromBoard === last.input.board
          ? { run: last, edit: chain }
          : undefined
    const run = await this.drive(
      boardCheckRun(input, since, true, (name, plan) => progress.phase(name, plan)),
      moot
    )
    if (!run || moot()) return null
    this.lastCheck = run
    this.checkChain = null
    this.chainBroken = false
    return run.results
  }

  /** A check's settings, libraries and schematic, kept when their version is new. */
  private keepInputs(message: Extract<ToWorker, { type: 'check' }>): void {
    if (message.settings && this.settings?.version !== message.settingsVersion) {
      this.settings = { version: message.settingsVersion, value: message.settings }
    }
    if (message.libraries !== undefined && this.libraries?.version !== message.librariesVersion) {
      const data = message.libraries
      this.libraries = {
        version: message.librariesVersion,
        value: data ? boardLibrariesOf(data) : undefined
      }
    }
    if (message.schematic !== undefined && this.schematic?.version !== message.schematicVersion) {
      this.schematic = { version: message.schematicVersion, value: message.schematic }
    }
  }
}

/** How often a running check says how far it has got, ms. */
const PROGRESS_MS = 100

/**
 * What a board's first check weighs its phases by, before it has timed its
 * own: a whole check of a large board (Jetson AGX Thor), ms. Only their
 * proportions matter.
 */
const PHASE_MS: Readonly<Record<string, number>> = {
  ratsnest: 235,
  context: 100,
  'copper clearance': 1211,
  'hole clearance': 87,
  'fill clearance': 804,
  zones: 59,
  'starved thermal': 56,
  dangling: 529,
  edge: 15,
  sizes: 63,
  courtyards: 12,
  'track geometry': 74,
  footprints: 22,
  texts: 31,
  misc: 9,
  silk: 516,
  'solder mask': 284,
  'diff pairs': 124,
  'schematic parity': 12,
  'connection width': 7447,
  'copper sliver': 1438
}

/** Of a check's progress, the most the ratsnest before it can claim while the rest is unknown. */
const RATSNEST_SHARE = 0.1

/**
 * How far a job has got, 0–1: the phases done (a check's rules, a refill's
 * zones) and the one running, each weighed by how long it took last time (a
 * phase not timed yet, by the mean), the running one credited with its time so
 * far up to most of its weight.
 */
class JobProgress {
  private plan: readonly string[] = []
  /** Phases run before the job's own plan: the ratsnest a check waited for. */
  private before: string[] = []
  private current = -1
  private started = performance.now()
  private took = new Map<string, number>()
  /** What each phase is called in the job's spans: a zone by its net and layers, not its key. */
  private label = ''
  private spans: JobSpan[] = []
  private lastSent = -1

  constructor(
    private readonly phaseMs: Map<string, number>,
    private readonly send: (done: number) => void
  ) {}

  phase(name: string, plan: readonly string[], label = name): void {
    const now = performance.now()
    if (this.current >= 0) this.close(now)
    if (name === 'ratsnest' && plan.length === 0) this.before = [name]
    this.plan = [...this.before, ...plan.filter((phase) => !this.before.includes(phase))]
    this.current = this.plan.indexOf(name)
    this.started = now
    this.label = label
  }

  /** The running phase ends at `now`. */
  private close(now: number): void {
    const ms = now - this.started
    this.took.set(this.plan[this.current], ms)
    this.spans.push({ name: this.label, start: performance.timeOrigin + this.started, ms })
  }

  private done(): number {
    if (this.current < 0) return 0
    const known = [...this.phaseMs.values()]
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
    const weight = (phase: string): number => this.phaseMs.get(phase) ?? fallback
    // Only the ratsnest is known yet: a share of it, not the whole.
    if (this.plan.length === this.before.length) {
      const w = weight(this.plan[this.current])
      return (RATSNEST_SHARE * Math.min(performance.now() - this.started, 0.9 * w)) / w
    }
    let total = 0
    let done = 0
    this.plan.forEach((phase, i) => {
      const w = weight(phase)
      total += w
      if (i < this.current) done += w
      else if (i === this.current) {
        done += Math.min(performance.now() - this.started, 0.9 * w)
      }
    })
    return total > 0 ? done / total : 0
  }

  report(): void {
    // Never backwards: a phase longer than last time holds rather than drops.
    const done = Math.max(this.lastSent, Math.min(1, this.done()))
    if (done - this.lastSent < 0.005) return
    this.lastSent = done
    this.send(done)
  }

  /** The run finished: its phases' times weigh the next one. Answers with its spans. */
  finish(): JobSpan[] {
    if (this.current >= 0) this.close(performance.now())
    this.current = -1
    for (const [phase, ms] of this.took) this.phaseMs.set(phase, ms)
    return this.spans
  }
}

/** A zone as a refill's spans name it: its net and layers, the key being a uuid. */
const zoneLabel = (zone: KicadBoardZone): string =>
  `${zone.netName || 'no net'} on ${zone.layers.join(', ')}`

/** A job that threw: answered with nothing, and why. */
const failed = (
  message: { revision: number; job: number },
  error: unknown
): {
  revision: number
  job: number
  ms: number
  started: number
  spans: JobSpan[]
  error: string
} => ({
  revision: message.revision,
  job: message.job,
  ms: 0,
  started: performance.timeOrigin + performance.now(),
  spans: [],
  error: error instanceof Error ? (error.stack ?? error.message) : String(error)
})

/** Let queued messages in: a change, or the next request. */
const yieldToQueue = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Top-level items that can move every teardrop's fill. */
const TEARDROP_GLOBAL = new Set(['net', 'setup', 'layers', 'general', 'net_class'])

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The node an index item was read from: its track's or via's, a pad's footprint's. */
function copperOwner(board: KicadBoard, item: CopperItem): unknown {
  const ref = item.ref
  switch (ref.type) {
    case 'segment':
      return board.segments[ref.index]?._raw
    case 'tarc':
      return board.trackArcs[ref.index]?._raw
    case 'via':
      return board.vias[ref.index]?._raw
    case 'pad':
      return board.footprints[ref.index]?._raw
    default:
      return undefined
  }
}
