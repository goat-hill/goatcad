/**
 * An agent's routing session (`route.begin`, `route.step`, `route.preview`,
 * docs/agent-api.md "Routing sessions"): the route tool's own
 * `RouteController`, driven by gestures that mirror its hotkeys and clicks,
 * over a board session the person's editor shares.
 *
 * A session is a run of gestures from the state it started in. The engine is
 * deterministic, so the same gestures over the same board give the same
 * route: `preview` runs each candidate on a throwaway run replayed from the
 * log, and a board the person edited mid-session is met by replaying the log
 * over it (`rebased`). A commit lands through the board session's command
 * layer as one undo step, and the next gesture starts a fresh run.
 *
 * Coordinates: gestures and answers are board mm, y down, as `items.*`; the
 * controller works in scene mm, y up. Ids are `boardItems.ts`'s.
 */
import { getNetName, type KicadBoard } from '../kicad/board'
import { isCopperLayer } from '../kicad/layers'
import { nmToMm } from '../kicad/coordinates'
import type { McpRouteGesture, McpRouteSettings, McpRouteView } from '../../../../preload/mcpTypes'
import type { PcbRouterState } from '../../../../preload/pcbRouterTypes'
import { BoardSpatialIndex, type CopperItem, type CopperItemRef, type Pt } from './spatialIndex'
import { boardItems, resolveItem, type BoardItem } from './boardItems'
import { boardRules, type BoardRules } from './rules/boardRules'
import {
  RouteController,
  routerWorldOf,
  copperOf,
  selectedFinishEdges,
  selectedRouteRefs,
  type CopperRef,
  type SelectedFinishEdge,
  type RouteDraftSegment,
  type RouteDraftVia,
  type RouteHost,
  type RouteOutcome,
  type RouteSetup,
  type RouteState
} from './routeController'
import { alignToStartAxes, routeTarget } from './routeTarget'
import { stepCopperLayer } from './pcbTools'
import type { RouteProposal, RouteState as RouterState, ViolationMark } from './router/engine'
import { chordsOf } from './router/engine'
import { routeRatsnest } from './router/autocomplete'
import { computeConnectivity } from './boardConnectivity'
import type { RouterWorld } from './router/world'
import type { DisplacedPreview } from './router/shove'
import type { BoardDisplayOptions } from '../engine/BoardScene'
import type { AgentCapture, WorldBox } from '../schematic/schematicAgent'
import type { CheckFinding } from '../schematic/checks'
import type { SExprNode } from '../kicad/sexpr'
import type { MessageKey } from '../messageKey'
import {
  PairTool,
  ToolRefused,
  TuneTool,
  toolGestureKeys,
  type RouteToolSpec,
  type ToolHost,
  type ToolResult
} from './routeAgentTools'

/** A gesture or argument the session cannot act on; the door answers it as a refusal. */
export class RouteRefused extends Error {
  constructor(
    readonly error: string,
    readonly detail: string,
    readonly candidates?: string[]
  ) {
    super(detail)
  }
}

export type RouteSnap = 'copper' | 'grid' | 'none'

/** What a run starts from besides the board: everything a gesture can change. */
export interface RouteEnv {
  layer: string
  prefs: PcbRouterState
  /** *Use starting track width* (R1): the project's, or the session's override. */
  useConnectedWidth: boolean
  grid: { spacing: number; snap: RouteSnap }
  /** The controller's state, idle: the size choice, layer pair and start via carry across routes. */
  state: RouteState
  /** The pair router or the tuner in hand instead of the route tool (`routeAgentTools.ts`). */
  tool?: RouteToolSpec
}

const cloneEnv = (env: RouteEnv): RouteEnv => JSON.parse(JSON.stringify(env)) as RouteEnv

/**
 * The person's router preferences with a session's overrides, never written
 * back. *Use starting track width* is the project's, not a preference (`RouteEnv`).
 */
export function routePrefsWith(base: PcbRouterState, overrides?: McpRouteSettings): PcbRouterState {
  const { mode, corner, ...switches } = overrides ?? {}
  const settings = { ...base.settings, ...switches }
  delete settings.useConnectedWidth
  return {
    mode: mode ?? base.mode,
    ...((corner ?? base.corner) ? { corner: corner ?? base.corner } : {}),
    settings
  }
}

/** What the session's pictures draw over the board (`BoardWorkScene.overlay`). */
export interface RouteOverlay {
  placed: OverlaySegment[]
  head: OverlaySegment[]
  vias: Array<{ x: number; y: number; size: number; drill: number; violation?: boolean }>
  hidden: Array<{ type: string; index: number }>
  pushed: OverlaySegment[]
  pushedVias: Array<{ x: number; y: number; size: number; drill: number }>
  marks: ViolationMark[]
  /** The board's airwires, the routed net's left to `ratsnest`; empty with the ratsnest off. */
  airwires: Array<{ from: Pt; to: Pt; net?: number }>
  /** The routed net's ratsnest from the head (F7). */
  ratsnest: Array<{ from: Pt; to: Pt }>
}

export interface OverlaySegment {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  layer: string
  violation?: boolean
}

/** A scene the session draws its pictures with (`engine/boardCapture.ts`'s `BoardWorkScene`). */
export interface RouteWorkScene {
  show(
    board: KicadBoard,
    view: { layers?: readonly string[]; activeLayer: string; options: BoardDisplayOptions },
    change?: { fromBoard: KicadBoard; raws: ReadonlySet<SExprNode> } | null
  ): void
  overlay(overlay: RouteOverlay, markHalfWidth: number): void
  capture(box: WorldBox | null, maxPixels: number): Promise<AgentCapture | null>
  /** Shots side by side, one picture. */
  tile(shots: readonly AgentCapture[]): Promise<{ dataUrl: string; width: number; height: number }>
  dispose(): void
}

/** Copper of the routed net not yet joined, as the answers list it. */
export interface RouteTargetRow {
  id: string
  at: { x: number; y: number }
  layers: readonly string[]
  distance: number
}

/**
 * Lands a route through the board's command layer; `net` is the route's. A
 * pair or a tune names its own label and nets (`how`).
 */
export type RouteLand = (
  mutate: () => void,
  net: number,
  how?: { nets: number[]; label: MessageKey }
) => void

/** Session copper not landed yet, as a step answers it: board mm, y down. */
export interface LaidCopper {
  segments: Array<{
    start: { x: number; y: number }
    end: { x: number; y: number }
    mid?: { x: number; y: number }
    width: number
    layer: string
  }>
  vias: Array<{ at: { x: number; y: number }; size: number; drill: number; layers?: string[] }>
}

/** What one gesture did, as `route.step` lists it. */
export type GestureResult =
  | RouteOutcome
  | 'moved'
  | 'armed'
  | 'disarmed'
  | 'layer'
  | 'posture'
  | 'settings'
  | 'size'
  | 'undone'
  | 'committed'
  | 'cancelled'
  | ToolResult

export const roundMm = (value: number): number => Math.round(value * 1000) / 1000

/** The width of the track the magnet found, when it found a track. */
const trackWidthOf = (target: ReturnType<typeof routeTarget>): number | undefined => {
  const shape = target?.item.shape
  return target &&
    (target.item.ref.type === 'segment' || target.item.ref.type === 'tarc') &&
    shape &&
    (shape.kind === 'capsule' || shape.kind === 'arc')
    ? shape.halfWidth * 2
    : undefined
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4

/** The length of a route's segments, mm, arcs along their chords. */
const lengthOf = (segments: readonly RouteDraftSegment[]): number =>
  roundMm(
    chordsOf(segments).reduce((sum, seg) => sum + Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0), 0)
  )

/**
 * What the head breaks, as `board.check` answers a finding: the item it comes
 * too near, on which layer, and the gap against the clearance where measured.
 * The head is not an item yet, so `items` holds the other side alone.
 */
export const violationOf = (id: string, mark: ViolationMark): CheckFinding => ({
  items: [id],
  layer: mark.layer,
  ...(mark.actual !== undefined && mark.clearance > 0
    ? {
        measure: {
          actual: round4(mark.actual),
          limit: round4(mark.clearance),
          bound: 'min' as const,
          unit: 'mm' as const
        }
      }
    : {})
})
/** A scene point as the board writes it: mm, y down. */
export const boardPt = (p: Pt): { x: number; y: number } => ({ x: roundMm(p.x), y: roundMm(-p.y) })
const scenePt = (p: { x: number; y: number }): Pt => ({ x: p.x, y: -p.y })

const ONE_ACTION_KEYS = [
  'via',
  'layer',
  'posture',
  'corner',
  'mode',
  'width',
  'widthRow',
  'viaSize',
  'viaRow',
  'undo',
  'finish',
  'commit',
  'cancel'
] as const

/** A gesture holds one action, or a move with or without a click. */
export function gestureShape(g: McpRouteGesture, index: number): void {
  const actions = ONE_ACTION_KEYS.filter((key) => g[key] !== undefined)
  const move = g.to !== undefined || g.at !== undefined
  if (g.to !== undefined && g.at !== undefined)
    throw new RouteRefused('invalid-args', `Gesture ${index} has both to and at; pass one.`)
  if (actions.length > 1 || (actions.length === 1 && (move || g.click)))
    throw new RouteRefused(
      'invalid-args',
      `Gesture ${index} holds ${[...actions, ...(move ? ['to'] : []), ...(g.click ? ['click'] : [])].join(' and ')}; a gesture is one action, or to/at with click.`
    )
  if (actions.length === 0 && !move && !g.click)
    throw new RouteRefused('invalid-args', `Gesture ${index} is empty.`)
}

/** The board's copper items by id, both ways, for one board. */
class CopperIds {
  private readonly items: BoardItem[]
  private readonly byRaw = new Map<SExprNode, string>()
  private readonly byPad = new Map<string, string>()

  constructor(private readonly board: KicadBoard) {
    this.items = boardItems(board)
    for (const item of this.items) {
      if (item.kind === 'track' || item.kind === 'via') this.byRaw.set(item.raw, item.id)
      else if (item.kind === 'pad') {
        const fp = board.footprints.indexOf(item.footprint)
        const pad = item.footprint.footprint.pads.indexOf(item.pad)
        this.byPad.set(`${fp}:${pad}`, item.id)
      }
    }
  }

  /** The id `items_get` takes for a copper item of the index, or null for a drawing. */
  idOf(ref: CopperItemRef): string | null {
    const b = this.board
    if (ref.type === 'pad') return this.byPad.get(`${ref.index}:${ref.pad}`) ?? null
    const raw =
      ref.type === 'segment'
        ? b.segments[ref.index]?._raw
        : ref.type === 'tarc'
          ? b.trackArcs[ref.index]?._raw
          : ref.type === 'via'
            ? b.vias[ref.index]?._raw
            : undefined
    return raw ? (this.byRaw.get(raw) ?? null) : null
  }

  resolve(id: string): BoardItem {
    const found = resolveItem(this.items, id)
    if (!found.ok) throw new RouteRefused(found.error, found.detail, found.candidates)
    return found.item
  }
}

/**
 * One route's worth of gestures over one board: a `RouteController` and the
 * environment it routes in. The live session holds one; a preview or a
 * rebase builds another and replays the log into it.
 */
export class RouteRun {
  readonly env: RouteEnv
  readonly controller: RouteController
  readonly index: BoardSpatialIndex
  readonly ids: CopperIds
  private world: RouterWorld | null = null
  private rules: BoardRules | null = null
  /** Where the cursor is, scene mm. */
  cursor: Pt | null = null
  /** The head the router proposed at the cursor after the last move, while a route is in progress. */
  proposal: RouteProposal | null = null
  /** Set once the route landed (or would have, in a preview): the run is spent. */
  landed = false
  /** The copper a click arrived at, by id. */
  arrivedAt: string | null = null
  /** The route as it landed, which the controller clears on landing: its segments, vias and pushes. */
  private landedSegments: readonly RouteDraftSegment[] | null = null
  private landedVias: readonly RouteDraftVia[] = []
  private landedPushes: DisplacedPreview | null = null

  constructor(
    readonly board: KicadBoard,
    readonly setup: RouteSetup,
    env: RouteEnv,
    land: RouteLand | null,
    /** The index and ids another run over this board built, to reuse. */
    shared?: RouteRun
  ) {
    this.env = cloneEnv(env)
    const reuse = shared?.board === board ? shared : undefined
    this.index = reuse?.index ?? BoardSpatialIndex.build(board)
    this.ids = reuse?.ids ?? new CopperIds(board)
    this.rules = reuse?.rules ?? null
    const host: RouteHost = {
      board: () => this.board,
      index: () => this.index,
      world: () => (this.world ??= routerWorldOf(this.board, this.index, this.setup)),
      prefs: () => this.env.prefs,
      useConnectedWidth: () => this.env.useConnectedWidth,
      setup: () => this.setup,
      sizeRules: () =>
        (this.rules ??= boardRules(
          this.board,
          {
            rules: setup.rules,
            classes: setup.classes,
            patterns: setup.patterns,
            assignments: setup.assignments,
            tuning: setup.tuning
          },
          setup.customRules
        )),
      layer: () => this.env.layer,
      setLayer: (layer) => (this.env.layer = layer),
      land: (mutate) => {
        this.landed = true
        this.landedSegments = this.controller.state.segments
        this.landedVias = this.controller.state.vias
        this.landedPushes = this.controller.displaced()
        land?.(mutate, this.controller.state.net)
      }
    }
    this.controller = new RouteController(host, this.env.state)
    const spec = this.env.tool
    if (spec) {
      const toolHost: ToolHost = {
        board: this.board,
        index: this.index,
        world: () => (this.world ??= routerWorldOf(this.board, this.index, this.setup)),
        setup: this.setup,
        prefs: () => this.env.prefs,
        layer: () => this.env.layer,
        setLayer: (layer) => (this.env.layer = layer),
        layerPair: () => this.controller.layerPair(),
        land: (mutate, nets, label) => {
          this.landed = true
          land?.(mutate, nets[0] ?? 0, { nets, label })
        },
        idOf: (ref) => this.ids.idOf(ref)
      }
      this.pairTool = spec.kind === 'pair' ? new PairTool(toolHost, spec) : null
      this.tuneTool = spec.kind === 'tune' ? new TuneTool(toolHost, spec) : null
    }
  }

  /** The pair router in hand, when the session routes pairs. */
  readonly pairTool: PairTool | null = null
  /** The tuner in hand, when the session tunes. */
  readonly tuneTool: TuneTool | null = null

  /** The tool the run drives instead of the route tool, if any. */
  get tool(): 'pair' | 'tune' | null {
    return this.pairTool ? 'pair' : this.tuneTool ? 'tune' : null
  }

  /** Whether work is in hand: a route, a pair or a pattern. */
  get active(): boolean {
    return this.pairTool?.active ?? this.tuneTool?.active ?? this.controller.active
  }

  /**
   * End what is in hand as Esc does (R21): a route or pair lands what was
   * clicked, a pattern in hand is dropped (T1). True when something landed.
   */
  commit(): boolean {
    if (this.pairTool) return this.pairTool.commit()
    if (this.tuneTool) {
      this.tuneTool.drop()
      return false
    }
    return this.controller.commit()
  }

  /** The last tune this run laid, as `route.step` answers it (tuned). */
  tuned(): Record<string, unknown> | null {
    return this.landed ? (this.tuneTool?.landedFacts() ?? null) : null
  }

  copper(): string[] {
    return this.controller.copper()
  }

  /** The grid point nearest `p` (scene), from the board's grid origin; null with snap off. */
  private gridPoint(p: Pt): Pt | null {
    if (this.env.grid.snap === 'none') return null
    const step = this.env.grid.spacing
    const origin = this.board.gridOrigin
    const ox = origin ? nmToMm(origin.x) : 0
    const oy = origin ? -nmToMm(origin.y) : 0
    return {
      x: ox + Math.round((p.x - ox) / step) * step,
      y: oy + Math.round((p.y - oy) / step) * step
    }
  }

  /** `gridPoint`, held mid-route to the start's axes as the editor's pointer is (R47). */
  private routeGridPoint(p: Pt): Pt | null {
    const g = this.gridPoint(p)
    const s = this.controller.state
    return g && s.tail ? alignToStartAxes(p, g, s.start) : g
  }

  /**
   * The copper the cursor means at `p`, as the editor's magnet picks it
   * (router-behavior.md R28–R31): within a grid step of its outline, mid-route
   * only the route's net on the routed layer.
   */
  private magnet(p: Pt, layers?: readonly string[]): ReturnType<typeof routeTarget> {
    const draft = this.controller.draft()
    const routing = draft?.tail ? draft : null
    const net =
      routing && !(routing.net === 0 && this.env.prefs.mode === 'highlight')
        ? routing.net
        : undefined
    const reach = this.env.grid.spacing
    const hits = this.index.near(p.x, p.y, reach, net !== undefined ? { net } : {})
    return routeTarget(hits, p, {
      reach,
      ...(routing ? { layer: this.env.layer } : {}),
      activeLayer: this.env.layer,
      pointable: (item) => (layers ? item.layers.filter((l) => layers.includes(l)) : item.layers),
      grid: (q) => this.gridPoint(q)
    })
  }

  /** Where an id puts the cursor: a pad or via at its center, a track at its end nearest the head. */
  private pointOf(id: string): Pt {
    const item = this.ids.resolve(id)
    const copper = (match: (it: CopperItem) => boolean): CopperItem => {
      const found = this.index.items.find((it) => it !== undefined && match(it))
      if (!found) throw new RouteRefused('not-applicable', `${id} has no copper to route to.`)
      return found
    }
    const b = this.board
    if (item.kind === 'pad') {
      const fp = b.footprints.indexOf(item.footprint)
      const pad = item.footprint.footprint.pads.indexOf(item.pad)
      const it = copper((c) => c.ref.type === 'pad' && c.ref.index === fp && c.ref.pad === pad)
      return it.anchor ?? { x: (it.minX + it.maxX) / 2, y: (it.minY + it.maxY) / 2 }
    }
    if (item.kind === 'via') {
      const v = b.vias.indexOf(item.via)
      const it = copper((c) => c.ref.type === 'via' && c.ref.index === v)
      return { x: (it.minX + it.maxX) / 2, y: (it.minY + it.maxY) / 2 }
    }
    if (item.kind === 'track') {
      const seg = b.segments.indexOf(item.track as (typeof b.segments)[number])
      const arc = b.trackArcs.indexOf(item.track as (typeof b.trackArcs)[number])
      const it = copper((c) =>
        seg >= 0
          ? c.ref.type === 'segment' && c.ref.index === seg
          : c.ref.type === 'tarc' && c.ref.index === arc
      )
      const s = it.shape
      if (s.kind !== 'capsule' && s.kind !== 'arc')
        throw new RouteRefused('not-applicable', `${id} has no ends to route to.`)
      const a = { x: s.x0, y: s.y0 }
      const z = { x: s.x1, y: s.y1 }
      const head = this.controller.state.tail
      if (!head) return a
      return Math.hypot(a.x - head.x, a.y - head.y) <= Math.hypot(z.x - head.x, z.y - head.y)
        ? a
        : z
    }
    throw new RouteRefused(
      'not-applicable',
      `${id} is a ${item.kind}; a route goes to a pad, a via or a track.`
    )
  }

  /** A pad, via or footprint by id, as the selection names it; else refused. */
  private selectionRefOf(id: string): CopperRef {
    const item = this.ids.resolve(id)
    const b = this.board
    if (item.kind === 'pad')
      return {
        type: 'pad',
        index: b.footprints.indexOf(item.footprint),
        pad: item.footprint.footprint.pads.indexOf(item.pad)
      }
    if (item.kind === 'via') return { type: 'via', index: b.vias.indexOf(item.via) }
    if (item.kind === 'footprint')
      return { type: 'footprint', index: b.footprints.indexOf(item.footprint) }
    throw new RouteRefused(
      'not-applicable',
      `${id} is a ${item.kind}; a finish starts from a pad, a via or a footprint's pads.`
    )
  }

  /** The pads and vias, by id, Attempt Finish Selected starts from for `id`: a footprint's pads with a net (R44). */
  finishStarts(id: string): string[] {
    return selectedRouteRefs(this.index, [this.selectionRefOf(id)]).flatMap((ref) => {
      const item = copperOf(this.index, ref)
      const found = item ? this.ids.idOf(item.ref) : null
      return found ? [found] : []
    })
  }

  /**
   * The ratsnest lines Attempt Finish Selected follows from one pad or via by
   * id (R46, `route.finish`), as the canvas draws them; else why it is
   * dropped: `no-net`, or `joined` (no line ends on it).
   */
  finishEdges(id: string): SelectedFinishEdge[] | { dropped: 'no-net' | 'joined' } {
    const edges = selectedFinishEdges(this.board, this.index, this.selectionRefOf(id))
    if (!edges) return { dropped: 'no-net' }
    return edges.length > 0 ? edges : { dropped: 'joined' }
  }

  /**
   * The editor's own finish along one of `finishEdges`' lines, toward the
   * copper nearest its start (R46). Arrived, the route landed: `to` is the
   * copper it reached and `length` the track laid; `stopped`, it did not get
   * to `to` and was dropped. A line an earlier route has joined is routed all
   * the same, toward what is left to join, as KiCad's Route Selected does.
   */
  finishAlong(
    edge: SelectedFinishEdge
  ): { to: string | null; length: number } | { dropped: 'stopped'; to: string | null } {
    const { outcome, toward } = this.controller.finishFrom(edge.start)
    const to = toward ? this.ids.idOf(toward.ref) : null
    if (outcome !== 'arrived') return { dropped: 'stopped', to }
    return { to, length: this.laidLengthSince([]) }
  }

  /** Begin the route (`route.begin`): at an item or a point, on a net when one is named. */
  begin(
    from: { to?: string; at?: { x: number; y: number } },
    net: number | undefined,
    layers?: readonly string[]
  ): void {
    if (this.tool) return this.beginTool(from, layers)
    const raw = from.to !== undefined ? this.pointOf(from.to) : scenePt(from.at!)
    const target =
      from.to !== undefined || this.env.grid.snap === 'copper' ? this.magnet(raw, layers) : null
    const start = target?.point ?? (from.to !== undefined ? raw : (this.gridPoint(raw) ?? raw))
    const begun = this.controller.begin(start, {
      net: net ?? target?.item.net,
      trackWidth: trackWidthOf(target),
      layers: target?.layers,
      cursor: raw
    })
    this.cursor = start
    if (begun.refused) {
      throw new RouteRefused(
        'route-start-refused',
        'The via armed for the start cannot stand there: it breaks clearance or a keepout. Begin elsewhere, or without the via.'
      )
    }
  }

  /** Apply one gesture; `layers` is what the view lets the cursor point at. */
  apply(g: McpRouteGesture, layers?: readonly string[]): GestureResult {
    if (this.tool) return this.applyTool(g, layers)
    const ctl = this.controller
    const s = ctl.state
    let result: GestureResult = 'nothing'
    let info: Parameters<RouteController['click']>[0] | null = null
    if (g.to !== undefined || g.at !== undefined) {
      this.lastMove = { to: g.to, at: g.at }
      info = this.pointer(this.lastMove, layers)
      result = 'moved'
    }
    if (g.click) {
      // A click where the cursor already is asks the magnet again, as the route stands now.
      const at = info ?? (this.lastMove ? this.pointer(this.lastMove, layers) : null)
      if (!at)
        throw new RouteRefused('invalid-args', 'A click needs a cursor: pass to or at with it.')
      const target = this.pendingTarget
      const outcome: RouteOutcome = ctl.click(at)
      result = outcome
      if (outcome === 'arrived' && target) this.arrivedAt = this.ids.idOf(target.ref)
    } else if (g.via !== undefined) {
      if (!s.tail) {
        if ((g.via.type ?? 'through') !== 'through')
          throw new RouteRefused(
            'not-applicable',
            'Only a through via can start a route (R37); begin the route, then arm a blind or micro via.'
          )
        ctl.setStartVia(true)
        result = 'armed'
      } else {
        if (g.via.to !== undefined) this.layerNamed(g.via.to)
        ctl.armVia(g.via.to, g.via.type ?? 'through')
        result = s.viaTarget ? 'armed' : 'disarmed'
      }
    } else if (g.layer !== undefined) {
      const target =
        g.layer === 'next' || g.layer === 'prev'
          ? stepCopperLayer(this.copper(), this.env.layer, g.layer === 'next' ? 1 : -1)
          : this.layerNamed(g.layer)
      ctl.switchLayer(target)
      result = s.viaTarget ? 'armed' : 'layer'
    } else if (g.posture) {
      ctl.flipPosture()
      result = 'posture'
    } else if (g.corner) {
      this.env.prefs.corner = g.corner
      result = 'settings'
    } else if (g.mode) {
      this.env.prefs.mode = g.mode
      result = 'settings'
    } else if (g.width !== undefined) {
      const rows = ctl.widthList()
      const row = rows.findIndex((r) => Math.abs(r.size - g.width!) < 1e-6)
      if (row >= 0) ctl.pickWidthRow(row)
      else
        ctl.setSizeChoice({
          ...s.sizeChoice,
          custom: { width: g.width, via: s.sizeChoice.custom?.via ?? ctl.viaSize() },
          override: true
        })
      result = 'size'
    } else if (g.widthRow !== undefined) {
      if (g.widthRow >= ctl.widthList().length)
        throw new RouteRefused(
          'invalid-args',
          `widthRow ${g.widthRow} is past the width list, which has ${ctl.widthList().length} rows.`
        )
      ctl.pickWidthRow(g.widthRow)
      result = 'size'
    } else if (g.viaSize !== undefined) {
      const via = { diameter: g.viaSize.size, drill: g.viaSize.drill }
      const rows = ctl.viaList()
      const row = rows.findIndex(
        (r) =>
          Math.abs(r.size.diameter - via.diameter) < 1e-6 &&
          Math.abs(r.size.drill - via.drill) < 1e-6
      )
      if (row >= 0) ctl.pickViaRow(row)
      else
        ctl.setSizeChoice({
          ...s.sizeChoice,
          custom: { width: s.sizeChoice.custom?.width ?? ctl.width(), via },
          override: true
        })
      result = 'size'
    } else if (g.viaRow !== undefined) {
      if (g.viaRow >= ctl.viaList().length)
        throw new RouteRefused(
          'invalid-args',
          `viaRow ${g.viaRow} is past the via list, which has ${ctl.viaList().length} rows.`
        )
      ctl.pickViaRow(g.viaRow)
      result = 'size'
    } else if (g.undo) {
      if (s.tail) ctl.undoStep()
      result = 'undone'
    } else if (g.finish === 'attempt') {
      result = ctl.attemptFinish({ cursor: this.cursor })
      const at = ctl.finishedAt
      if (result === 'arrived' && at) this.arrivedAt = this.ids.idOf(at.ref)
    } else if (g.finish === 'here') {
      result = ctl.endHere(this.cursor) ? 'committed' : 'cancelled'
    } else if (g.commit) {
      result = ctl.commit() ? 'committed' : 'nothing'
    } else if (g.cancel) {
      // Esc (R21): what was clicked lands, the head and an armed via are dropped.
      result = ctl.commit() ? 'committed' : 'cancelled'
    }
    // The head follows the cursor after anything that changed what it is drawn with.
    this.proposal = s.tail && this.cursor ? ctl.propose(this.cursor) : null
    return result
  }

  /** A tool's refusal as the session's. */
  private withTool<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof ToolRefused) throw new RouteRefused(error.error, error.detail)
      throw error
    }
  }

  /**
   * Where a tool's cursor goes: an id's copper, else the point, snapped as
   * the grid says for a pair; a tune takes points exactly, as it projects
   * them onto its track.
   */
  private toolPoint(
    move: { to?: string; at?: { x: number; y: number } },
    layers?: readonly string[]
  ): Pt {
    if (move.to !== undefined) return this.pointOf(move.to)
    const raw = scenePt(move.at!)
    if (this.tuneTool) return raw
    if (this.env.grid.snap === 'copper')
      return this.magnet(raw, layers)?.point ?? this.gridPoint(raw) ?? raw
    return this.gridPoint(raw) ?? raw
  }

  /** Begin with the tool in hand: a pair at its copper (PR1), a pattern on its track (T1). */
  private beginTool(
    from: { to?: string; at?: { x: number; y: number } },
    layers?: readonly string[]
  ): void {
    this.withTool(() => {
      if (this.pairTool) {
        const point = this.toolPoint(from, layers)
        this.cursor = point
        if (!this.pairTool.start(point))
          throw new RouteRefused(
            'not-applicable',
            `${from.to ?? 'That point'} is not on a pair half with partner copper on the board: a pair is two nets named as KiCad pairs them (USB_D+/USB_D-, CLK_P/CLK_N), and the other half has a pad, via or loose track end of the same kind.`
          )
        return
      }
      const tune = this.tuneTool!
      const seed = from.to !== undefined ? this.trackItemOf(from.to) : undefined
      // A track by id is grabbed at its start, as a click there would be.
      const point =
        seed?.shape.kind === 'capsule' || seed?.shape.kind === 'arc'
          ? { x: seed.shape.x0, y: seed.shape.y0 }
          : scenePt(from.at!)
      this.cursor = point
      if (!tune.start(point, seed))
        throw new RouteRefused(
          'not-applicable',
          `${from.to ?? 'No track lies within 0.5 mm of that point'}${from.to ? ' cannot be tuned' : ''}: a tune starts on a track outside any tuning pattern, and a pair or skew tune on a straight pair half with its partner's track running beside it.`
        )
    })
  }

  /** The track or arc an id names, for a tune to start on. */
  private trackItemOf(id: string): CopperItem {
    const item = this.ids.resolve(id)
    const seg =
      item.kind === 'track'
        ? this.board.segments.indexOf(item.track as (typeof this.board.segments)[number])
        : -1
    const arc =
      item.kind === 'track'
        ? this.board.trackArcs.indexOf(item.track as (typeof this.board.trackArcs)[number])
        : -1
    const found =
      seg >= 0
        ? this.index.items.find((c) => c?.ref.type === 'segment' && c.ref.index === seg)
        : arc >= 0
          ? this.index.items.find((c) => c?.ref.type === 'tarc' && c.ref.index === arc)
          : undefined
    if (!found)
      throw new RouteRefused('not-applicable', `${id} is a ${item.kind}; a tune starts on a track.`)
    return found
  }

  /** One gesture with the pair router or the tuner in hand, as its keys and clicks are. */
  private applyTool(g: McpRouteGesture, layers?: readonly string[]): GestureResult {
    return this.withTool(() => {
      toolGestureKeys(this.tool!, g)
      const pair = this.pairTool
      const tune = this.tuneTool
      let result: GestureResult = 'nothing'
      if (g.to !== undefined || g.at !== undefined) {
        const point = this.toolPoint({ to: g.to, at: g.at }, layers)
        this.cursor = point
        pair?.move(point)
        tune?.move(point)
        result = 'moved'
      }
      if (g.click) {
        result = pair ? pair.click() : tune!.click()
        if (result === 'arrived' && pair?.arrivedAt) this.arrivedAt = pair.arrivedAt
      } else if (g.via !== undefined) result = pair!.toggleVia()
      else if (g.posture) result = pair!.flipPosture()
      else if (g.corner) {
        this.env.prefs.corner = g.corner
        if (this.cursor) pair?.move(this.cursor)
        result = 'settings'
      } else if (g.mode) {
        this.env.prefs.mode = g.mode
        if (this.cursor) pair?.move(this.cursor)
        result = 'settings'
      } else if (g.widthRow !== undefined) result = pair!.pickRow(g.widthRow)
      else if (g.undo) result = pair ? pair.undo() : tune!.drop() ? 'cancelled' : 'nothing'
      else if (g.finish === 'here' || g.commit) {
        // Commit lands what was clicked; finishing here lays the head first.
        const landed = !pair ? tune!.lay() : g.commit ? pair.commit() : pair.finishHere()
        if (landed && pair?.arrivedAt) this.arrivedAt = pair.arrivedAt
        result = landed ? 'committed' : 'nothing'
      } else if (g.cancel) {
        // Esc: a pair lands what was laid (R25); a pattern in hand is dropped (T1).
        result = pair
          ? pair.commit()
            ? 'committed'
            : 'cancelled'
          : tune!.drop()
            ? 'cancelled'
            : 'nothing'
      }
      return result
    })
  }

  /** Copper a move landed on that is of the route's net: what a click there arrives at. */
  private pendingTarget: CopperItem | null = null
  /** The last move, which a click with none asks the magnet about again. */
  private lastMove: { to?: string; at?: { x: number; y: number } } | null = null

  /**
   * Where a move puts the cursor and what the magnet found there, as the
   * viewport's click reports it. An id means its copper, whatever the snap; a
   * point follows the snap.
   */
  private pointer(
    move: { to?: string; at?: { x: number; y: number } },
    layers?: readonly string[]
  ): Parameters<RouteController['click']>[0] {
    const s = this.controller.state
    const raw = move.to !== undefined ? this.pointOf(move.to) : scenePt(move.at!)
    const target =
      move.to !== undefined || this.env.grid.snap === 'copper' ? this.magnet(raw, layers) : null
    const snapped =
      target?.point ?? (move.to !== undefined ? raw : (this.routeGridPoint(raw) ?? raw))
    this.cursor = snapped
    const width = trackWidthOf(target)
    const onNet = s.tail !== null && target !== null && target.item.net === s.net
    this.pendingTarget = onNet ? target.item : null
    return {
      snapped,
      point: raw,
      ...(target ? { magnetNet: target.item.net, magnetLayers: target.layers } : {}),
      ...(onNet ? { onNetTarget: true } : {}),
      ...(width !== undefined ? { magnetTrackWidth: width } : {})
    }
  }

  private layerNamed(name: string): string {
    if (!isCopperLayer(name) || !this.copper().includes(name))
      throw new RouteRefused(
        'layer-not-found',
        `The board has no copper layer ${name}.`,
        this.copper()
      )
    return name
  }

  /** The routed net's copper not yet joined to the route, nearest the head first. */
  targets(limit: number): RouteTargetRow[] {
    const from = this.controller.state.tail ?? this.cursor
    const seen = new Set<string>()
    const rows: RouteTargetRow[] = []
    for (const anchor of this.controller.anchors()) {
      const id = this.ids.idOf(anchor.item.ref)
      if (!id || seen.has(id)) continue
      seen.add(id)
      rows.push({
        id,
        at: boardPt(anchor.point),
        layers: anchor.item.layers,
        distance: from ? roundMm(Math.hypot(anchor.point.x - from.x, anchor.point.y - from.y)) : 0
      })
    }
    return rows.sort((a, b) => a.distance - b.distance).slice(0, limit)
  }

  /** What the router is doing with the head now, as `route.step` answers it. */
  routeState(): {
    state: RouterState | 'idle'
    head?: { at: { x: number; y: number }; layer: string }
    violations?: CheckFinding[]
    blockedBy?: string[]
    pair?: Record<string, unknown>
    tune?: Record<string, unknown>
  } {
    const tool = this.pairTool?.state() ?? this.tuneTool?.state()
    if (tool) {
      const marks = tool.marks.flatMap((m) => {
        const item = m.id !== undefined ? this.index.items[m.id] : undefined
        const id = item ? this.ids.idOf(item.ref) : null
        return id ? [{ id, finding: violationOf(id, m) }] : []
      })
      return {
        state: tool.state,
        ...(tool.head ? { head: { at: boardPt(tool.head.at), layer: tool.head.layer } } : {}),
        ...(marks.length ? { violations: marks.map((m) => m.finding) } : {}),
        ...(tool.blocked && marks.length
          ? { blockedBy: [...new Set(marks.map((m) => m.id))] }
          : {}),
        ...(tool.pair ? { pair: tool.pair } : {}),
        ...(tool.tune ? { tune: tool.tune } : {})
      }
    }
    const s = this.controller.state
    if (!s.tail) return { state: 'idle' }
    const p = this.proposal
    const head = { at: boardPt(p?.endsAt ?? s.tail), layer: this.env.layer }
    if (!p) return { state: 'clear', head }
    const marks = p.marks.flatMap((m) => {
      const item = m.id !== undefined ? this.index.items[m.id] : undefined
      const id = item ? this.ids.idOf(item.ref) : null
      return id ? [violationOf(id, m)] : []
    })
    const blockedBy = p.violatorIds.flatMap((n) => {
      const item = this.index.items[n]
      const id = item ? this.ids.idOf(item.ref) : null
      return id ? [id] : []
    })
    return {
      state: p.state,
      head,
      ...(marks.length ? { violations: marks } : {}),
      ...(p.blocked && blockedBy.length ? { blockedBy: [...new Set(blockedBy)] } : {})
    }
  }

  /** What the route has laid so far: its clicked copper and length. */
  placed(): { segments: number; vias: number; length: number } {
    const s = this.controller.state
    return { segments: s.segments.length, vias: s.vias.length, length: lengthOf(s.segments) }
  }

  /** The clicked copper the route holds now, for `laidSince`. */
  clicked(): { segments: readonly RouteDraftSegment[]; vias: readonly RouteDraftVia[] } {
    const s = this.controller.state
    return { segments: s.segments, vias: s.vias }
  }

  /** The clicked copper the route holds now that `before` did not: what a step laid and has not landed. */
  laidSince(before: ReturnType<RouteRun['clicked']>): LaidCopper {
    const had = new Set<object>([...before.segments, ...before.vias])
    const now = this.clicked()
    return {
      segments: now.segments
        .filter((seg) => !had.has(seg))
        .map((seg) => ({
          start: boardPt({ x: seg.x0, y: seg.y0 }),
          end: boardPt({ x: seg.x1, y: seg.y1 }),
          ...(seg.mid ? { mid: boardPt(seg.mid) } : {}),
          width: roundMm(seg.width),
          layer: seg.layer
        })),
      vias: now.vias
        .filter((via) => !had.has(via))
        .map((via) => ({
          at: boardPt(via),
          size: roundMm(via.size),
          drill: roundMm(via.drill),
          ...(via.layers ? { layers: via.layers } : {})
        }))
    }
  }

  /** The route's clicked segments now, or as it landed. */
  laidSegments(): readonly RouteDraftSegment[] {
    return this.landedSegments ?? this.controller.state.segments
  }

  /** Where the route has been, board mm: its start and the copper it laid, landed or not. */
  laidPoints(): Array<{ x: number; y: number }> {
    const tool = this.pairTool ?? this.tuneTool
    if (tool) return tool.points().map(boardPt)
    const start = this.controller.state.start
    const vias = this.landedSegments ? this.landedVias : this.controller.state.vias
    return [
      ...(start ? [start] : []),
      ...this.laidSegments().flatMap((seg) => [
        { x: seg.x0, y: seg.y0 },
        { x: seg.x1, y: seg.y1 },
        ...(seg.mid ? [seg.mid] : [])
      ]),
      ...vias
    ].map(boardPt)
  }

  /**
   * The length, mm, of the track laid since `before` (`laidSegments` then):
   * clicked, finished or landed, and still in the route at its end. A head
   * not clicked is not laid.
   */
  laidLengthSince(before: readonly RouteDraftSegment[]): number {
    const had = new Set(before)
    return lengthOf(this.laidSegments().filter((seg) => !had.has(seg)))
  }

  /**
   * What the session's picture draws over the board, as the editor's preview
   * does; a run that landed draws the route as it landed, since its board is
   * the one from before.
   */
  overlay(ratsnest: boolean): RouteOverlay {
    const tool = this.pairTool ?? this.tuneTool
    if (tool) {
      const drawn = tool.overlay()
      const nets = tool.nets()
      return {
        ...drawn,
        airwires: ratsnest
          ? computeConnectivity(this.board, this.index).airwires.filter(
              (w) => w.net === undefined || !nets.includes(w.net)
            )
          : [],
        ratsnest: []
      }
    }
    const ctl = this.controller
    const draft = ctl.draft()
    const landed = draft ? null : this.landedSegments
    const p = this.proposal
    const layer = this.env.layer
    const width = ctl.width()
    const head: OverlaySegment[] = p
      ? chordsOf(p.segments).map((seg) => ({
          x0: seg.x0,
          y0: seg.y0,
          x1: seg.x1,
          y1: seg.y1,
          layer,
          width,
          violation: seg.violation
        }))
      : []
    const headEnd = p?.endsAt ?? draft?.tail ?? null
    const vias = draft
      ? [
          ...draft.vias,
          ...(draft.armedVia && headEnd
            ? [
                {
                  x: headEnd.x,
                  y: headEnd.y,
                  size: draft.armedVia.size,
                  drill: draft.armedVia.drill,
                  violation: p?.via?.violation ?? false
                }
              ]
            : [])
        ]
      : landed
        ? [...this.landedVias]
        : []
    const displaced = draft
      ? ctl.displaced()
      : landed && this.landedPushes
        ? this.landedPushes
        : { hiddenRefs: [], segments: [], vias: [] }
    const airwires = ratsnest
      ? computeConnectivity(this.board, this.index).airwires.filter(
          (w) => !draft || draft.net <= 0 || w.net !== draft.net
        )
      : []
    let lines: Array<{ from: Pt; to: Pt }> = []
    if (ratsnest && draft && headEnd) {
      const clusters = ctl.clusters()
      const joined: Pt[] = [...draft.vias]
      for (const seg of [...draft.segments, ...head])
        joined.push({ x: seg.x0, y: seg.y0 }, { x: seg.x1, y: seg.y1 })
      const r = routeRatsnest(
        {
          origin: clusters.origin.map((a) => a.point),
          others: clusters.others.map((c) => c.map((a) => a.point))
        },
        joined,
        headEnd
      )
      lines = [...(r.lead ? [r.lead] : []), ...r.airwires]
    }
    return {
      placed: chordsOf(draft?.segments ?? landed ?? []),
      head,
      vias,
      hidden: displaced.hiddenRefs,
      pushed: displaced.segments,
      pushedVias: (displaced.vias ?? []).map((v) => ({
        x: v.x,
        y: v.y,
        size: v.size,
        drill: this.board.vias[v.index] ? nmToMm(this.board.vias[v.index].drill) : v.size / 2
      })),
      marks: p?.marks ?? [],
      airwires,
      ratsnest: lines
    }
  }

  /** The routed net's name, or '' with none. */
  netName(): string {
    const net = (this.pairTool ?? this.tuneTool)?.nets()[0] ?? this.controller.state.net
    return net > 0 ? getNetName(this.board, net) : ''
  }
}

/** One gesture as the log holds it: a begin, or a gesture applied in turn. */
type LogEntry =
  | { begin: { to?: string; at?: { x: number; y: number } }; net?: number }
  | { gesture: McpRouteGesture }

/** The view a session draws with, its defaults filled. */
export interface RouteViewState {
  layers?: string[]
  otherLayers: 'show' | 'dim' | 'hide'
  side: 'front' | 'back'
  frame?: { x: number; y: number; width: number; height: number }
  follow: number
  ratsnest: boolean
  highlight: boolean
}

/** mm across the square a session's picture follows the head with, by default. */
export const DEFAULT_FOLLOW = 12

export const viewWith = (view: RouteViewState, patch?: McpRouteView): RouteViewState => {
  if (!patch) return view
  const next: RouteViewState = { ...view, ...patch } as RouteViewState
  // A follow given drops a frame kept from before, and a frame given wins over follow.
  if (patch.follow !== undefined && patch.frame === undefined) delete next.frame
  return next
}

/**
 * A routing session: the log of gestures since the run started, the live
 * run they built, and the view its pictures draw with.
 */
export class AgentRouteSession {
  private run: RouteRun
  /** The environment, board and cursor the log replays from. */
  private start: { env: RouteEnv; board: KicadBoard; cursor: Pt | null }
  private log: LogEntry[] = []
  view: RouteViewState
  scene: RouteWorkScene | null = null
  lastUsed = Date.now()

  constructor(
    readonly id: string,
    readonly path: string,
    private readonly board: () => KicadBoard | null,
    private readonly setup: RouteSetup,
    env: RouteEnv,
    view: RouteViewState,
    private readonly land: RouteLand
  ) {
    const b = board()
    if (!b) throw new RouteRefused('board-unreadable', path)
    this.start = { env: cloneEnv(env), board: b, cursor: null }
    this.run = new RouteRun(b, setup, env, land)
    this.view = view
  }

  get live(): RouteRun {
    return this.run
  }

  /** What the view lets the cursor point at: its layers, or every one. */
  private pointable(): readonly string[] | undefined {
    return this.view.layers
  }

  begin(from: { to?: string; at?: { x: number; y: number } }, net?: number): void {
    this.run.begin(from, net, this.pointable())
    this.log.push({ begin: from, ...(net !== undefined ? { net } : {}) })
  }

  /**
   * The board moved under the session since its run began (the person's
   * edit): replay the log over the board as it is now. True when it did.
   */
  rebase(): boolean {
    const b = this.board()
    if (!b) throw new RouteRefused('route-session-ended', 'The board is no longer open.')
    if (b === this.run.board) return false
    this.start = { ...this.start, board: b }
    this.run = this.replay(b, this.log, this.land)
    return true
  }

  /** A run over `board`, the session's start replayed with `entries`. */
  private replay(
    board: KicadBoard,
    entries: readonly LogEntry[],
    land: RouteLand | null
  ): RouteRun {
    const run = new RouteRun(board, this.setup, this.start.env, land, this.run)
    run.cursor = this.start.cursor
    for (const entry of entries) {
      if ('begin' in entry) run.begin(entry.begin, entry.net, this.pointable())
      else run.apply(entry.gesture, this.pointable())
    }
    return run
  }

  /**
   * Apply gestures in order. With no route in progress after one, the log
   * starts over from the run's state; a landed route also starts a fresh run
   * over the board it left, and ends the step: `skipped` counts the gestures
   * after it, which were not applied, as `preview` stops at a landing.
   */
  step(gestures: readonly McpRouteGesture[]): {
    results: GestureResult[]
    arrived: string[]
    skipped: number
    /** The tune a click laid, as the tuner read it then. */
    tuned?: Record<string, unknown>
  } {
    this.lastUsed = Date.now()
    const results: GestureResult[] = []
    const arrived: string[] = []
    let tuned: Record<string, unknown> | undefined
    for (const g of gestures) {
      results.push(this.run.apply(g, this.pointable()))
      if (this.run.active) {
        this.log.push({ gesture: g })
        continue
      }
      const prev = this.run
      if (prev.arrivedAt) arrived.push(prev.arrivedAt)
      tuned = prev.tuned() ?? tuned
      const board = prev.landed ? this.board() : prev.board
      if (!board) throw new RouteRefused('route-session-ended', 'The board is no longer open.')
      this.start = { env: cloneEnv(prev.env), board, cursor: prev.cursor }
      this.log = []
      if (prev.landed) {
        this.run = new RouteRun(board, this.setup, prev.env, this.land)
        this.run.cursor = prev.cursor
        break
      }
    }
    return {
      results,
      arrived,
      skipped: gestures.length - results.length,
      ...(tuned ? { tuned } : {})
    }
  }

  /** Where the session stands, to put back when a step is refused partway. */
  snapshot(): { start: AgentRouteSession['start']; log: LogEntry[] } {
    return { start: { ...this.start, env: cloneEnv(this.start.env) }, log: [...this.log] }
  }

  restore(snap: { start: AgentRouteSession['start']; log: LogEntry[] }): void {
    this.start = snap.start
    this.log = snap.log
    this.run = this.replay(snap.start.board, snap.log, this.land)
  }

  /**
   * Each candidate run from the session's state over a throwaway run; nothing
   * changes. `length` is what the candidate's own gestures laid (`laidLengthSince`).
   */
  preview(candidates: readonly (readonly McpRouteGesture[])[]): Array<{
    run: RouteRun
    results: GestureResult[]
    length: number
  }> {
    this.lastUsed = Date.now()
    return candidates.map((gestures) => {
      const run = this.replay(this.run.board, this.log, null)
      const before = run.laidSegments()
      const results: GestureResult[] = []
      for (const g of gestures) {
        if (run.landed) break
        results.push(run.apply(g, this.pointable()))
      }
      return { run, results, length: run.laidLengthSince(before) }
    })
  }

  dispose(): void {
    this.scene?.dispose()
    this.scene = null
  }
}
