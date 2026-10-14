/**
 * An agent's routing session with the pair router or the length tuner in
 * hand instead of the route tool (`route.begin`'s `pair` and `tune`,
 * docs/agent-api.md "Routing sessions"): the editor's `6` and `7`/`8`/`9`,
 * over the steps they share with it (`pairRoute.ts`, `tuneTool.ts`), driven
 * by the same gestures a route takes. `RouteRun` holds one when its env
 * names the tool; scene mm, y up, as the controller works.
 */
import { getNetName, type KicadBoard } from '../kicad/board'
import { nmToMm } from '../kicad/coordinates'
import {
  DEFAULT_TUNING_PATTERN_SETTINGS,
  defaultNetClass,
  extractTuningPatternSettings,
  netClassForNet,
  type NetClass
} from '../kicad/project'
import type { McpBeginRouteRequest, McpRouteGesture } from '../../../../preload/mcpTypes'
import type { PcbRouterState } from '../../../../preload/pcbRouterTypes'
import { commitsViolations, routerSettings } from '../pcbRouter'
import { tk, type MessageKey } from '../messageKey'
import type { BoardSpatialIndex, CopperItem, CopperItemRef, Pt } from './spatialIndex'
import type { RouterWorld } from './router/world'
import type { RouteState as RouterState, ViolationMark } from './router/engine'
import { DiffPairSession, type PairProposal } from './router/diffPair'
import {
  delayAt,
  tuneTargetOf,
  type TuneMode,
  type TuneTarget,
  type TuneTimeScale,
  type TuneUpdate
} from './router/tuning'
import { DEFAULT_MEANDER, type MeanderSettings } from './router/meander'
import { routerOptionsOf, type RouteSetup } from './routeController'
import type { LayerPair } from './viaPlacement'
import { boardRules, type BoardRules } from './rules/boardRules'
import { resolvePairSizes } from './routeSizes'
import {
  beginPair,
  clickPair,
  pairEndAt,
  pairLaid,
  pairMateOf,
  pairPushes,
  pairSegments,
  pairSizesOf,
  pairTarget,
  proposePair,
  throughViaSpec,
  undoPair,
  writePair,
  type PairDimensions,
  type PairDraft,
  type PairSegment
} from './pairRoute'
import {
  tunedTrackLength,
  startTune,
  tuneRuleFor,
  tuneTimeScale,
  inTuningPattern,
  tuneSeedAt,
  tuneSegments,
  writeTune
} from './tuneTool'
import type { TuneSession } from './router/tuning'

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** The tool a session drives instead of the route tool; plain data, carried from route to route. */
export type RouteToolSpec =
  | {
      kind: 'pair'
      /** A row of the pair size list: 0 the net class, then the project's sizes. */
      row: number
      override: PairDimensions | null
      /** The project's pair sizes past the net class's (`diff_pair_dimensions`). */
      list: PairDimensions[]
    }
  | {
      kind: 'tune'
      mode: TuneMode
      /** A typed target, mm (skew: the difference); null takes the net's rule. */
      target: number | null
      overrideRules: boolean
      settings: MeanderSettings
    }

/** What a tool reaches of its run: the board, the router and where the work lands. */
export interface ToolHost {
  board: KicadBoard
  index: BoardSpatialIndex
  world(): RouterWorld
  setup: RouteSetup
  prefs(): PcbRouterState
  layer(): string
  setLayer(layer: string): void
  layerPair(): LayerPair
  /** Lands `mutate` as one undo step labeled `label`; `nets` are the work's own. */
  land(mutate: () => void, nets: number[], label: MessageKey): void
  idOf(ref: CopperItemRef): string | null
}

/** A tool's refusal; the run turns it into the session's (`RouteRefused`). */
export class ToolRefused extends Error {
  constructor(
    readonly error: string,
    readonly detail: string
  ) {
    super(detail)
  }
}

/** What a gesture did with a tool in hand, as `route.step` lists it. */
export type ToolResult =
  | 'begun'
  | 'laid'
  | 'arrived'
  | 'nothing'
  | 'moved'
  | 'armed'
  | 'disarmed'
  | 'settings'
  | 'posture'
  | 'size'
  | 'undone'
  | 'committed'
  | 'cancelled'

/** What a tool draws over the board in a session's picture. */
export interface ToolOverlay {
  placed: PairSegment[]
  head: PairSegment[]
  vias: Array<{ x: number; y: number; size: number; drill: number; violation?: boolean }>
  hidden: Array<{ type: string; index: number }>
  pushed: PairSegment[]
  pushedVias: Array<{ x: number; y: number; size: number; drill: number }>
  marks: ViolationMark[]
}

/** A tool's state as `route.step` answers it: the router's state, the head, and the tool's own facts. */
export interface ToolState {
  state: RouterState | 'idle'
  head?: { at: Pt; layer: string }
  marks: ViolationMark[]
  blocked: boolean
  pair?: Record<string, unknown>
  tune?: Record<string, unknown>
}

const roundMm = (value: number): number => Math.round(value * 1000) / 1000

/** The keys of a gesture each tool acts on; the rest are the route tool's alone. */
const PAIR_KEYS = new Set([
  'to',
  'at',
  'click',
  'via',
  'posture',
  'corner',
  'mode',
  'widthRow',
  'undo',
  'finish',
  'commit',
  'cancel'
])
const TUNE_KEYS = new Set([
  'to',
  'at',
  'click',
  'undo',
  'finish',
  'commit',
  'cancel',
  'mode',
  'corner'
])

/** Refuse a gesture key the tool has no counterpart for. */
export function toolGestureKeys(kind: RouteToolSpec['kind'], g: McpRouteGesture): void {
  const allowed = kind === 'pair' ? PAIR_KEYS : TUNE_KEYS
  const bad = Object.keys(g).filter((key) => !allowed.has(key))
  if (bad.length)
    throw new ToolRefused(
      'not-applicable',
      `${kind === 'pair' ? 'A pair' : 'A tune'} session takes no ${bad.join(', ')}; its gestures are ${[...allowed].join(', ')}.`
    )
  if (kind === 'pair' && g.finish === 'attempt')
    throw new ToolRefused(
      'not-applicable',
      'A pair has no Attempt Finish; move to the far pads and click.'
    )
  if (kind === 'pair' && g.via && (g.via.type !== undefined || g.via.to !== undefined))
    throw new ToolRefused(
      'not-applicable',
      'A via pair goes through, across the layer pair; send via: {} to arm it.'
    )
}

const lengthOfSegments = (segs: readonly PairSegment[]): number =>
  roundMm(segs.reduce((sum, s) => sum + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0))

/** The routed net's class, else Default. */
const classOf = (board: KicadBoard, setup: RouteSetup, net: number): NetClass => {
  const name = net > 0 ? getNetName(board, net) : ''
  return name
    ? netClassForNet(name, setup.classes, setup.patterns, setup.assignments)
    : defaultNetClass(setup.classes)
}

/** The editor's `6` (PR1–PR6), driven by gestures. */
export class PairTool {
  draft: PairDraft | null = null
  private session: DiffPairSession | null = null
  private proposal: PairProposal | null = null
  cursor: Pt | null = null
  /** The head's posture, flipped as `/` flips it (R10). */
  private flip = false
  /** The pair as it landed, for the picture a landing answers. */
  landedDraft: PairDraft | null = null
  /** The copper the pair arrived at, by id. */
  arrivedAt: string | null = null

  constructor(
    private readonly host: ToolHost,
    private readonly spec: Extract<RouteToolSpec, { kind: 'pair' }>
  ) {}

  get active(): boolean {
    return this.draft !== null
  }

  private cls(): NetClass {
    return classOf(this.host.board, this.host.setup, this.draft?.nets.p ?? 0)
  }

  private rules: { board: KicadBoard; rules: BoardRules } | null = null

  /** The width and gap the rules give the pair on its layer (S13); the class's before it begins. */
  private own(): { width: number; gap: number } {
    const draft = this.draft
    const cls = this.cls()
    if (!draft) return { width: cls.diffPairWidth, gap: cls.diffPairGap }
    const h = this.host
    if (this.rules?.board !== h.board)
      this.rules = { board: h.board, rules: boardRules(h.board, h.setup, h.setup.customRules) }
    const { width, gap } = resolvePairSizes(this.rules.rules, draft.nets, draft.layer, {
      width: h.setup.rules.minTrackWidth,
      clearance: h.setup.rules.minClearance
    })
    return { width: width.value, gap: gap.value }
  }

  /** The sizes the pair draws with now (PR6, S13). */
  sizes(): PairDimensions {
    return pairSizesOf(this.own(), this.spec.list, this.spec.row, this.spec.override)
  }

  /** Begin the pair on the copper at `point` (PR1); false where none starts one. */
  start(point: Pt): boolean {
    const h = this.host
    const found = pairEndAt(h.board, h.index, point, h.layer())
    if (!found) return false
    const origin = h.layer()
    if (found.layer !== origin) h.setLayer(found.layer)
    this.session = new DiffPairSession(
      h.world(),
      routerOptionsOf(
        () => h.prefs(),
        () => h.board
      )
    )
    this.draft = beginPair(this.session, found, origin)
    this.move(point)
    return true
  }

  move(point: Pt): void {
    this.cursor = point
    const draft = this.draft
    const session = this.session
    if (!draft || !session) return
    const prefs = this.host.prefs()
    const cls = this.cls()
    this.proposal = proposePair(
      session,
      draft,
      {
        mode: prefs.mode,
        postureFlipped: this.flip,
        sizes: this.sizes(),
        clearance: cls.clearance,
        cursor: point
      },
      pairTarget(
        pairEndAt(this.host.board, this.host.index, point, this.host.layer(), draft.layer),
        draft
      ),
      throughViaSpec(
        this.host.board,
        { diameter: cls.viaDiameter, drill: cls.viaDrill },
        this.sizes().viaGap
      )
    )
  }

  /** A click: begin on the copper under the cursor, or lay what is shown (R18), arriving where it heads (PR4). */
  click(finish = false): ToolResult {
    const point = this.cursor
    if (!point)
      throw new ToolRefused('invalid-args', 'A click needs a cursor: pass to or at with it.')
    const draft = this.draft
    const session = this.session
    if (!draft || !session) return this.start(point) ? 'begun' : 'nothing'
    this.move(point)
    const proposal = this.proposal
    if (!proposal || (proposal.blocked && !commitsViolations(this.host.prefs()))) return 'nothing'
    const next = clickPair(
      session,
      draft,
      proposal,
      { postureFlipped: this.flip, sizes: this.sizes() },
      this.host.layerPair(),
      { fixAll: routerSettings(this.host.prefs()).fixAllSegments, finish }
    )
    if (!next) return 'nothing'
    if (next.layer !== draft.layer) this.host.setLayer(next.layer)
    this.draft = next
    if (proposal.arrived) {
      this.arrivedAt = this.copperAt(point)
      this.commit()
      return 'arrived'
    }
    this.move(point)
    return 'laid'
  }

  /** The pad or via of the pair under `point`, by id. */
  private copperAt(point: Pt): string | null {
    const nets = this.draft ? [this.draft.nets.p, this.draft.nets.n] : []
    const hit = this.host.index
      .near(point.x, point.y, 0, {})
      .find(
        (h) => nets.includes(h.item.net) && (h.item.ref.type === 'pad' || h.item.ref.type === 'via')
      )
    return hit ? this.host.idOf(hit.item.ref) : null
  }

  /** `V`: arm or disarm a via pair at the head (PR5). */
  toggleVia(): ToolResult {
    if (!this.draft)
      throw new ToolRefused('not-applicable', 'Arm a via pair once the pair has begun.')
    this.draft = { ...this.draft, armedVia: !this.draft.armedVia }
    if (this.cursor) this.move(this.cursor)
    return this.draft.armedVia ? 'armed' : 'disarmed'
  }

  flipPosture(): ToolResult {
    this.flip = !this.flip
    if (this.cursor) this.move(this.cursor)
    return 'posture'
  }

  /** `W`: a row of the pair size list (PR6). */
  pickRow(row: number): ToolResult {
    if (row > this.spec.list.length)
      throw new ToolRefused(
        'invalid-args',
        `widthRow ${row} is past the pair size list, which has ${this.spec.list.length + 1} rows.`
      )
    this.spec.row = row
    this.spec.override = null
    if (this.cursor) this.move(this.cursor)
    return 'size'
  }

  /** Backspace (R22): the armed via pair, else the last click; with nothing clicked the pair ends. */
  undo(): ToolResult {
    const draft = this.draft
    if (!draft || !this.session) return 'nothing'
    const next = undoPair(this.session, draft)
    if (!next) {
      this.end()
      return 'cancelled'
    }
    if (next.layer !== draft.layer) this.host.setLayer(next.layer)
    this.draft = next
    if (!draft.armedVia && this.cursor) this.move(this.cursor)
    return 'undone'
  }

  /** Esc (R25): what is laid lands as one undo step; false with nothing laid. */
  commit(): boolean {
    const draft = this.draft
    const session = this.session
    let landed = false
    if (draft && session && pairLaid(draft)) {
      const pushed = pairPushes(session)
      const board = this.host.board
      this.landedDraft = draft
      this.host.land(
        () => writePair(board, draft, pushed),
        [draft.nets.p, draft.nets.n],
        tk('pcbEditor.commands.routePair')
      )
      landed = true
    }
    this.end()
    return landed
  }

  /** `End` (R21): the head laid as a click lays it, and the pair ends there. */
  finishHere(): boolean {
    if (this.draft) {
      const result = this.click(true)
      if (result === 'arrived') return true
    }
    return this.commit()
  }

  /** The pair dropped, the layer handed back. */
  private end(): void {
    const origin = this.draft?.originLayer
    this.draft = null
    this.session = null
    this.proposal = null
    if (origin && origin !== this.host.layer()) this.host.setLayer(origin)
  }

  state(): ToolState {
    const draft = this.draft
    const p = this.proposal
    if (!draft) return { state: 'idle', marks: [], blocked: false }
    const b = this.host.board
    const sizes = this.sizes()
    return {
      state: p?.state ?? 'clear',
      ...(p && p.p.length > 0
        ? { head: { at: mid(p.p[p.p.length - 1], p.n[p.n.length - 1]), layer: draft.layer } }
        : {}),
      marks: p?.marks ?? [],
      blocked: p?.blocked ?? false,
      pair: {
        nets: [getNetName(b, draft.nets.p), getNetName(b, draft.nets.n)],
        width: roundMm(sizes.width),
        gap: roundMm(sizes.gap),
        viaGap: roundMm(sizes.viaGap),
        sizes: [
          { width: roundMm(this.own().width), gap: roundMm(this.own().gap) },
          ...this.spec.list.map((d) => ({
            width: roundMm(d.width),
            gap: roundMm(d.gap),
            viaGap: roundMm(d.viaGap)
          }))
        ],
        ...(draft.armedVia ? { armedVia: true } : {}),
        placed: {
          p: lengthOfSegments(draft.p),
          n: lengthOfSegments(draft.n),
          vias: draft.vias.length
        },
        ...(p?.arrived ? { arrives: true } : {})
      }
    }
  }

  /** What the pair's picture draws: what is laid, the head and its via pair, and what it pushed. */
  overlay(): ToolOverlay {
    const draft = this.draft ?? this.landedDraft
    const p = this.draft ? this.proposal : null
    const session = this.draft ? this.session : null
    if (!draft) return emptyOverlay()
    const sizes = this.sizes()
    const displaced = session?.displaced() ?? { hiddenRefs: [], segments: [], vias: [] }
    const armed = p?.vias ?? null
    return {
      placed: [...draft.p, ...draft.n],
      head: p
        ? [
            ...pairSegments(p.p, sizes.width, draft.layer, p.pViolations),
            ...pairSegments(p.n, sizes.width, draft.layer, p.nViolations)
          ]
        : [],
      vias: [
        ...draft.vias,
        ...(armed
          ? [
              { ...armed.p, size: armed.spec.size, drill: armed.spec.drill },
              { ...armed.n, size: armed.spec.size, drill: armed.spec.drill }
            ]
          : [])
      ],
      hidden: displaced.hiddenRefs,
      pushed: displaced.segments,
      pushedVias: (displaced.vias ?? []).map((v) => ({
        x: v.x,
        y: v.y,
        size: v.size,
        drill: this.host.board.vias[v.index]
          ? nmToMm(this.host.board.vias[v.index].drill)
          : v.size / 2
      })),
      marks: p?.marks ?? []
    }
  }

  /** Where the pair has been: its start and what it laid. */
  points(): Pt[] {
    const draft = this.draft ?? this.landedDraft
    if (!draft) return []
    return [
      draft.start.anchorP,
      draft.start.anchorN,
      ...[...draft.p, ...draft.n].flatMap((s) => [
        { x: s.x0, y: s.y0 },
        { x: s.x1, y: s.y1 }
      ])
    ]
  }

  nets(): number[] {
    return this.draft ? [this.draft.nets.p, this.draft.nets.n] : []
  }
}

const emptyOverlay = (): ToolOverlay => ({
  placed: [],
  head: [],
  vias: [],
  hidden: [],
  pushed: [],
  pushedVias: [],
  marks: []
})

/** A target as an answer reads it: an unbounded side left out, none at all null. */
const targetRecord = (target: TuneTarget): Record<string, number> | null => {
  if (!Number.isFinite(target.opt)) return null
  return {
    ...(Number.isFinite(target.min) ? { min: roundMm(target.min) } : {}),
    opt: roundMm(target.opt),
    ...(Number.isFinite(target.max) ? { max: roundMm(target.max) } : {})
  }
}

/** The editor's `7`, `8` and `9` (T1–T6), driven by gestures. */
export class TuneTool {
  private session: TuneSession | null = null
  private update: TuneUpdate | null = null
  /** The tuned track's length when the pattern began, mm (T2). */
  private before = 0
  cursor: Pt | null = null
  /** The last tune laid, for the answer and picture its landing gives. */
  landedUpdate: TuneUpdate | null = null

  constructor(
    private readonly host: ToolHost,
    private readonly spec: Extract<RouteToolSpec, { kind: 'tune' }>
  ) {}

  get active(): boolean {
    return this.session !== null
  }

  private lengthOf = (track: CopperItem): number =>
    tunedTrackLength(this.host.board, track, this.host.setup.rules)

  /** How the tune in hand's delay follows its length, where its net's profile tunes in time (T2). */
  private time: TuneTimeScale | null = null

  /** The target a net is tuned to (T2): its rule's, unless overridden or none; then typed; else none. */
  private targetFor(net: number, layer: string): TuneTarget {
    return tuneTargetOf(
      this.spec.mode,
      this.spec.target,
      tuneRuleFor(this.host.board, this.host.setup, net, layer, this.spec.mode),
      this.spec.overrideRules,
      this.time
    )
  }

  /** A pattern begun on `seed`, else the track at `point` (T1); false where none starts. */
  start(point: Pt, seed?: CopperItem): boolean {
    const h = this.host
    const track = seed ?? tuneSeedAt(h.index, point)
    if (!track || (track.ref.type !== 'segment' && track.ref.type !== 'tarc')) return false
    // KiCad's tuner starts no pattern inside another (T1).
    if (inTuningPattern(h.board, track.ref)) return false
    const mate =
      this.spec.mode === 'single'
        ? null
        : pairMateOf(h.board, h.index, track, (name) => {
            const cls = netClassForNet(name, h.setup.classes, h.setup.patterns, h.setup.assignments)
            return cls.diffPairGap + cls.diffPairWidth
          })
    this.time = tuneTimeScale(
      h.board,
      h.setup,
      this.spec.mode,
      track,
      mate,
      track.net,
      track.layers[0]
    )
    const session = startTune(h.world(), track, point, {
      mode: this.spec.mode,
      settings: this.spec.settings,
      target: this.targetFor(track.net, track.layers[0]),
      clearance: classOf(h.board, h.setup, track.net).clearance,
      lengthOf: this.lengthOf,
      mate
    })
    if (!session) return false
    this.session = session
    this.before =
      this.spec.mode === 'pair'
        ? Math.max(this.lengthOf(track), mate ? this.lengthOf(mate) : 0)
        : this.spec.mode === 'skew' && mate
          ? this.lengthOf(track) - this.lengthOf(mate)
          : this.lengthOf(track)
    this.move(point)
    return true
  }

  move(point: Pt): void {
    this.cursor = point
    if (this.session) this.update = this.session.update(point)
  }

  /** A click: begin a pattern on the track under the cursor, or lay the one in hand (T4). */
  click(): ToolResult {
    const point = this.cursor
    if (!point)
      throw new ToolRefused('invalid-args', 'A click needs a cursor: pass to or at with it.')
    if (!this.session) return this.start(point) ? 'begun' : 'nothing'
    this.move(point)
    return this.lay() ? 'committed' : 'nothing'
  }

  /** The pattern in hand laid with its meanders, one undo step (T4); false while it violates. */
  lay(): boolean {
    const u = this.update
    const session = this.session
    if (!u || !session || u.lines.length === 0) return false
    if (u.blocked && !commitsViolations(this.host.prefs())) return false
    const board = this.host.board
    const settings = session.meanderSettings
    const time = this.time
    this.landedUpdate = u
    this.landedBefore = this.before
    this.landedTime = time
    this.host.land(
      () => writeTune(board, u, this.spec.mode, settings, this.spec.overrideRules, time),
      [...new Set(u.lines.map((l) => l.net))],
      tk('pcbEditor.commands.tune')
    )
    this.drop()
    return true
  }

  /** Esc: the pattern in hand dropped, the tuner still armed (T1). */
  drop(): boolean {
    const had = this.session !== null
    this.session = null
    this.update = null
    return had
  }

  /** A tune as an answer reads it: the net, its length (skew), the target and the status. */
  facts(u: TuneUpdate, before: number, time: TuneTimeScale | null): Record<string, unknown> {
    const b = this.host.board
    const skew = this.spec.mode === 'skew'
    const now = skew ? (u.skew ?? 0) : u.length
    const ps = (mm: number): number => Math.round(delayAt(time!, mm) * 100) / 100
    return {
      mode: this.spec.mode,
      nets: [...new Set(u.lines.map((l) => getNetName(b, l.net)))],
      ...(skew ? { skew: roundMm(now) } : { length: roundMm(now) }),
      before: roundMm(before),
      target: targetRecord(u.target),
      // Held to a delay (KiCad's time domain): the same, in ps.
      ...(time
        ? {
            delay: {
              now: ps(now),
              before: ps(before),
              target: { min: ps(u.target.min), opt: ps(u.target.opt), max: ps(u.target.max) }
            }
          }
        : {}),
      status: u.status,
      ...(u.blocked ? { blocked: true } : {}),
      meanders: {
        minAmplitude: this.spec.settings.minAmplitude,
        maxAmplitude: this.spec.settings.maxAmplitude,
        spacing: this.spec.settings.spacing,
        cornerRadiusPercent: this.spec.settings.cornerRadiusPercent,
        singleSided: this.spec.settings.singleSided
      }
    }
  }

  /** The last landing's facts. */
  landedFacts(): Record<string, unknown> | null {
    return this.landedUpdate
      ? this.facts(this.landedUpdate, this.landedBefore, this.landedTime)
      : null
  }

  private landedBefore = 0
  private landedTime: TuneTimeScale | null = null

  state(): ToolState {
    const u = this.update
    if (!this.session || !u) return { state: 'idle', marks: [], blocked: false }
    return {
      state: u.blocked ? 'blocked' : 'clear',
      ...(this.cursor ? { head: { at: this.cursor, layer: u.lines[0]?.layer ?? '' } } : {}),
      marks: u.marks,
      blocked: u.blocked,
      tune: this.facts(u, this.before, this.time)
    }
  }

  overlay(): ToolOverlay {
    const u = this.session ? this.update : this.landedUpdate
    if (!u) return emptyOverlay()
    return {
      ...emptyOverlay(),
      head: tuneSegments(u),
      hidden: u.lines.flatMap((l) => l.replaces),
      marks: this.session ? u.marks : []
    }
  }

  points(): Pt[] {
    const u = this.session ? this.update : this.landedUpdate
    return u ? [u.pattern.origin, u.pattern.end, ...(this.cursor ? [this.cursor] : [])] : []
  }

  nets(): number[] {
    const u = this.update
    return u ? [...new Set(u.lines.map((l) => l.net))] : []
  }
}

/**
 * The tool `route.begin` asks for, as the session carries it: a pair at a row
 * of the project's pair sizes or typed ones (PR6), or a tuner with the
 * project's meander defaults for its mode under any given (T6). Null for a
 * plain route; an error for a request no tool takes.
 */
export function routeToolSpec(
  request: Pick<McpBeginRouteRequest, 'pair' | 'tune' | 'net'>,
  pairSizes: readonly PairDimensions[],
  projectText: string | null
): RouteToolSpec | null | { error: string; detail: string } {
  const { pair, tune } = request
  if (!pair && !tune) return null
  if (pair && tune)
    return {
      error: 'invalid-args',
      detail: 'Pass pair or tune, not both: a session holds one tool.'
    }
  if (request.net !== undefined)
    return {
      error: 'invalid-args',
      detail: 'A pair or a tune takes its nets from the copper it starts on; leave net out.'
    }
  if (pair) {
    const typed = pair.width !== undefined || pair.gap !== undefined || pair.viaGap !== undefined
    if (typed && (pair.width === undefined || pair.gap === undefined))
      return {
        error: 'invalid-args',
        detail: 'Typed pair sizes need width and gap; viaGap defaults to gap.'
      }
    if (typed && pair.row !== undefined)
      return { error: 'invalid-args', detail: 'Pass pair.row or typed sizes, not both.' }
    if ((pair.row ?? 0) > pairSizes.length)
      return {
        error: 'invalid-args',
        detail: `pair.row ${pair.row} is past the pair size list, which has ${pairSizes.length + 1} rows (0 the net class).`
      }
    return {
      kind: 'pair',
      row: pair.row ?? 0,
      override: typed
        ? { width: pair.width!, gap: pair.gap!, viaGap: pair.viaGap ?? pair.gap! }
        : null,
      list: pairSizes.map((d) => ({ ...d }))
    }
  }
  const t = tune!
  const saved =
    (projectText !== null ? extractTuningPatternSettings(projectText) : null) ??
    DEFAULT_TUNING_PATTERN_SETTINGS
  const settings: MeanderSettings = { ...DEFAULT_MEANDER, ...saved[t.mode] }
  for (const key of ['minAmplitude', 'maxAmplitude', 'spacing', 'cornerRadiusPercent'] as const)
    if (t[key] !== undefined) settings[key] = t[key]!
  if (t.singleSided !== undefined) settings.singleSided = t.singleSided
  // As the settings form holds them (T6).
  settings.maxAmplitude = Math.max(settings.maxAmplitude, settings.minAmplitude)
  settings.cornerRadiusPercent = Math.min(100, settings.cornerRadiusPercent)
  return {
    kind: 'tune',
    mode: t.mode,
    target: t.target ?? null,
    overrideRules: t.overrideRules === true,
    settings
  }
}
