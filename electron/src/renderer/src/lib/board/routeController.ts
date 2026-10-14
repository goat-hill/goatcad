/**
 * The route tool's state machine, headless: a route begun on copper, its
 * clicks, the armed via, layer switches, the size in force, Backspace, the
 * finish and the commit (docs/router-behavior.md R1–R47, S1–S9). The PCB
 * editor and an agent's routing session (`routeAgent.ts`, `route.*`) both
 * drive one, so their routes cannot drift.
 *
 * Plain TypeScript over a `RouteHost`: the board, its index and router world,
 * the router preferences, the project's sizes, and where the routed layer
 * lives. It never reads view state — the editor supplies the cursor and the
 * magnet from its viewport and the keys from its hotkeys. `state` is a plain
 * object the host may hand in wrapped (`reactive`), so a view tracks it.
 *
 * One `RouteSession` lives from `begin` to the route's end, built over the
 * world the board had then. The board holds still under a route (R34): the
 * editor commits a live route before its own edits, and `outsideChange`
 * cancels one when someone else's edit moved the board, since the session's
 * pushes index copper that may no longer be there.
 */
import { getNetName, type KicadBoard } from '../kicad/board'
import {
  defaultNetClass,
  netClassForNet,
  type BoardDesignSettings,
  type DesignRules,
  type NetClass,
  type NetClassAssignment,
  type NetClassPattern,
  type ViaSize
} from '../kicad/project'
import { isCopperLayer } from '../kicad/layers'
import {
  RouteSession,
  chordsOf,
  type ProposedSegment,
  type RouteOptions,
  type RouteProposal,
  type RouteRequest,
  type ViolationMark
} from './router/engine'
import type { DisplacedPreview, PendingCopper } from './router/shove'
import type { DragOptions } from './router/drag'
import { RouterWorld } from './router/world'
import { routerBounds } from './router/boundaries'
import { routerRules } from './router/rules'
import {
  attemptFinish,
  cutRetraces,
  nearestAnchor,
  nearestUnconnectedAnchor,
  routeNetClusters,
  type RouteNetClusters,
  type UnconnectedAnchor
} from './router/autocomplete'
import { clusterOfRef, computeConnectivity, type AirwireRef } from './boardConnectivity'
import { boardRules, type BoardRules } from './rules/boardRules'
import { pointToShape, type BoardSpatialIndex, type CopperItem, type Pt } from './spatialIndex'
import {
  connectedTrackWidth,
  initialSizeChoice,
  resolveTrackWidth,
  resolveVia,
  stepViaChoice,
  stepWidthChoice,
  viaInForce,
  viaList as viaSizeList,
  widthInForce,
  widthList as widthSizeList,
  type RouteSizeChoice,
  type SizeEntry,
  type SizeRule,
  type WidthSource
} from './routeSizes'
import {
  defaultLayerPair,
  settledViaType,
  viaSpan,
  viaTarget,
  type LayerPair,
  type RouteViaType
} from './viaPlacement'
import { emptyRouteClick } from './routerGesture'
import { commitsViolations, routeCorner, routerSettings } from '../pcbRouter'
import type { PcbRouterState } from '../../../../preload/pcbRouterTypes'
import {
  landingPreview,
  landRoute,
  planLanding,
  type RouteDraftSegment,
  type RouteDraftVia
} from './routeLanding'

export type { RouteDraftSegment, RouteDraftVia } from './routeLanding'

/** A pending (uncommitted) trace, scene space — what the route tool has drawn. */
export interface RouteDraft {
  segments: RouteDraftSegment[]
  vias: RouteDraftVia[]
  tail: Pt | null
  /** Where the route began: its pointer is held to this point's axes (R47). */
  start: Pt | null
  net: number
  /**
   * A via armed at the head's end (R24): drawn where the head ends, placed
   * by the next click, and held to every copper layer it spans.
   */
  armedVia: { size: number; drill: number; layers: readonly string[] } | null
}

/** The project's rules and sizes a route is drawn with. */
export interface RouteSetup {
  rules: DesignRules
  classes: NetClass[]
  patterns: NetClassPattern[]
  assignments: NetClassAssignment[]
  /** KiCad 10's tuning profiles, whose per-layer widths and gaps the rules resolve. */
  tuning?: BoardDesignSettings['tuning']
  /** The project's sizes beyond the net classes' (`track_widths`, `via_dimensions`). */
  extraSizes: { tracks: number[]; vias: ViaSize[] }
  /** The project's `.kicad_dru`. */
  customRules?: string
}

/** What a route stands on; the editor and an agent's session each supply one. */
export interface RouteHost {
  board(): KicadBoard | null
  index(): BoardSpatialIndex | null
  /** The router's world over the board as it is now (`routerWorldOf`). */
  world(): RouterWorld | null
  /** The router preferences in force: the person's, or an agent's overrides of them. */
  prefs(): PcbRouterState
  /** *Use starting track width* (R1): the project's, kept in its `.kicad_prl`, or an agent's override. */
  useConnectedWidth(): boolean
  setup(): RouteSetup
  /** The rules the size rows resolve from, custom rules included; null falls back to the net class. */
  sizeRules(): BoardRules | null
  /** The copper layer a route goes on now. */
  layer(): string
  /** Route on another copper layer: after a via, or where the route began. */
  setLayer(layer: string): void
  /** Run `mutate` as one board command: the route's landing. */
  land(mutate: () => void): void
  /** The net of the copper touching a point, where the start found none; default the index's. */
  netAt?(point: Pt): number
}

/** The trace as each click left it, for Backspace (R22). */
export interface RouteStop {
  segs: number
  vias: number
  layer: string
  inherited: number | null
  ruleWidth: boolean
}

/** Everything a route in progress holds. Scene coordinates (mm, y up) throughout. */
export interface RouteState {
  segments: RouteDraftSegment[]
  vias: RouteDraftVia[]
  /** The route's current end; null while no route is in progress. */
  tail: Pt | null
  start: Pt | null
  /** The layer when the route began, which its end hands back (R24). */
  originLayer: string | null
  /** The layer an armed via goes to (R24); null while none is armed. */
  viaTarget: string | null
  /** What the armed via is (R41). */
  viaType: RouteViaType
  /** The layer pair (R40); null is the board's outer pair. */
  layerPairPick: LayerPair | null
  /** `V` with no route in progress: the next route starts with a via (R37). */
  startVia: boolean
  /** The layers of the copper the route started on: a layer key there needs no via (R36). */
  startLayers: readonly string[]
  net: number
  /** `/` since the last click (R4). */
  postureFlip: boolean
  stops: RouteStop[]
  /** The width a route started on a track carries while *Use starting track width* holds (R1). */
  inheritedWidth: number | null
  /**
   * A via took the route onto a layer whose rule the width in force broke, a
   * width not picked on this route: it draws at the rules' width from there
   * (S12, KiCad's `updateSizesAfterRouterEvent`). Per route.
   */
  ruleWidth: boolean
  /** The size rows in force and a custom size (S1–S6), kept across routes. */
  sizeChoice: RouteSizeChoice
}

export const createRouteState = (): RouteState => ({
  segments: [],
  vias: [],
  tail: null,
  start: null,
  originLayer: null,
  viaTarget: null,
  viaType: 'through',
  layerPairPick: null,
  startVia: false,
  startLayers: [],
  net: 0,
  postureFlip: false,
  stops: [],
  inheritedWidth: null,
  ruleWidth: false,
  sizeChoice: initialSizeChoice()
})

/** Where a route begins: what the magnet found at the start point. */
export interface RouteStart {
  net?: number
  /** The width of the track it started on (R1). */
  trackWidth?: number
  /** The copper's layers the pointer could reach. */
  layers?: readonly string[]
  /** Where the pointer was: which of a pad's tracks it points along (R1). */
  cursor?: Pt
}

/** A click with the route tool, as the magnet resolved it. */
export interface RouteClick {
  /** Where the click lands: magnet-adjusted, else snapped. */
  snapped: Pt
  /** The raw pointer. */
  point?: Pt
  /** Net of the copper the magnet snapped to. */
  magnetNet?: number
  /** The cursor is over copper of the route's net: the click ends the route there (R20). */
  onNetTarget?: boolean
  magnetTrackWidth?: number
  magnetLayers?: readonly string[]
}

/**
 * What a click or a finish did: began a route, laid copper, landed the route
 * because it arrived (or an armed via ended it), or nothing — a blocked head
 * included, whose marks the caller can show.
 */
export type RouteOutcome = 'begun' | 'refused' | 'laid' | 'arrived' | 'ended' | 'nothing'

/** A pad or via of the board's index, as the selection names one. */
export interface CopperRef {
  type: string
  index: number
  pad?: number
}

/** The pads and vias Route Selected starts from (R44): each selected pad and via, and a selected footprint's pads with a net. */
export function selectedRouteRefs(
  index: BoardSpatialIndex,
  selected: readonly CopperRef[]
): CopperRef[] {
  const out: CopperRef[] = []
  for (const ref of selected) {
    if (ref.type === 'pad' || ref.type === 'via') out.push({ ...ref })
    else if (ref.type === 'footprint')
      for (const item of index.items)
        if (item?.ref.type === 'pad' && item.ref.index === ref.index && item.net > 0)
          out.push({ type: 'pad', index: item.ref.index, pad: item.ref.pad })
  }
  return out
}

/** Where Route Selected and Attempt Finish Selected begin a route (R44, R46). */
export interface SelectedRouteStart {
  point: Pt
  net: number
  layers: readonly string[]
}

/**
 * Where a route from a selected pad or via begins (R44): at the item
 * itself or, `fromEnd`, at the nearest copper its net has not yet joined.
 * Null when the item is gone, has no net, or its net is already whole.
 */
export function selectedRouteStart(
  board: KicadBoard,
  index: BoardSpatialIndex,
  ref: CopperRef,
  fromEnd: boolean
): SelectedRouteStart | null {
  const item = copperOf(index, ref)
  if (!item || item.net <= 0) return null
  const point = item.anchor ?? { x: (item.minX + item.maxX) / 2, y: (item.minY + item.maxY) / 2 }
  const far = nearestAnchor(routeNetClusters(board, index, item.net, point).others.flat(), point)
  if (!far) return null
  const start = fromEnd ? far : { point, item }
  return { point: start.point, net: item.net, layers: start.item.layers }
}

/**
 * One ratsnest line Attempt Finish Selected follows from an item (R46): the
 * route begins at the line's end on the item, while its other end is not yet
 * joined, and heads for the copper nearest it, as `F` does.
 */
export interface SelectedFinishEdge {
  start: SelectedRouteStart
  /** The line's other end. */
  target: Pt
}

/** The copper of the index a pad or via ref names. */
export const copperOf = (index: BoardSpatialIndex, ref: CopperRef): CopperItem | undefined =>
  index.items.find(
    (it) =>
      it !== undefined &&
      it.ref.type === ref.type &&
      it.ref.index === ref.index &&
      (it.ref.type !== 'pad' || it.ref.pad === ref.pad)
  )

/** A proposal's segments as drafts on `layer`, `width` wide. */
const draftsOf = (
  segments: readonly ProposedSegment[],
  layer: string,
  width: number
): RouteDraftSegment[] =>
  segments.map((seg) => ({
    x0: seg.x0,
    y0: seg.y0,
    x1: seg.x1,
    y1: seg.y1,
    ...(seg.mid ? { mid: seg.mid } : {}),
    layer,
    width
  }))

const isRef = (ref: AirwireRef, item: CopperItem): boolean =>
  ref.type === item.ref.type &&
  ref.index === item.ref.index &&
  (ref.type !== 'pad' || item.ref.type !== 'pad' || ref.pad === item.ref.pad)

/**
 * The ratsnest lines that end on a selected pad or via (R46), as the canvas
 * draws them: KiCad's Route Selected gathers the anchors of the ratsnest edges
 * whose source or target is the item, counting ends inside it, as its comment
 * says it does (`ROUTER_TOOL::RouteSelected`). Empty when no line ends on it; null when
 * the item is gone or has no net. Each route starts on the item's layers, as
 * a click there does: on the active layer where the item has it (R46).
 */
export function selectedFinishEdges(
  board: KicadBoard,
  index: BoardSpatialIndex,
  ref: CopperRef
): SelectedFinishEdge[] | null {
  const item = copperOf(index, ref)
  if (!item || item.net <= 0) return null
  const conn = computeConnectivity(board, index, new Set([item.net])).nets.get(item.net)
  if (!conn) return []
  const cluster = conn.clusterOfItem.get(item.id)
  // An end on the item, or inside its copper on its own cluster (a track ending in the pad).
  const endsOn = (ref: AirwireRef, p: Pt): boolean =>
    isRef(ref, item) ||
    (clusterOfRef(conn, index, ref) === cluster && pointToShape(item.shape, p.x, p.y) <= 1e-6)
  const edges: SelectedFinishEdge[] = []
  for (const wire of conn.airwires) {
    const own = endsOn(wire.fromRef, wire.from)
      ? { at: wire.from, target: wire.to }
      : endsOn(wire.toRef, wire.to)
        ? { at: wire.to, target: wire.from }
        : null
    if (!own) continue
    edges.push({ start: { point: own.at, net: item.net, layers: item.layers }, target: own.target })
  }
  return edges
}

/** What the editor's preview asks the route for. */
export interface RoutePreviewSource {
  propose(cursor: Pt): RouteProposal | null
  displaced(): DisplacedPreview
  /** What landing with this head would change of the net's copper (R26, R27). */
  landed(proposal: RouteProposal): DisplacedPreview
}

/**
 * The router's world over a board: its copper index, held inside the edge
 * and keepouts and clear of holes, each route held to its own net's
 * clearances through the board's rules; the largest any rule asks stands
 * where nothing asks for a net.
 */
export function routerWorldOf(
  board: KicadBoard,
  index: BoardSpatialIndex,
  setup: Pick<
    RouteSetup,
    'rules' | 'classes' | 'patterns' | 'assignments' | 'tuning' | 'customRules'
  >
): RouterWorld {
  const settings = {
    rules: setup.rules,
    classes: setup.classes,
    patterns: setup.patterns,
    assignments: setup.assignments,
    tuning: setup.tuning
  }
  let rules: BoardRules | null = null
  const ruleSet = (): BoardRules => (rules ??= boardRules(board, settings, setup.customRules))
  return new RouterWorld(
    index,
    undefined,
    () =>
      routerBounds(board, ruleSet().resolver.worst('edge_clearance'), {
        holeClearance: ruleSet().resolver.worst('hole_clearance'),
        index
      }),
    () => routerRules(ruleSet())
  )
}

/**
 * How the router routes, drags and pushes: the preferences' switches, read
 * through getters each time the engine asks, so a switch flipped mid-route
 * applies from the next frame without starting the route over; and nothing
 * locked moves (router-behavior.md P1).
 */
export function routerOptionsOf(
  prefs: () => PcbRouterState,
  board: () => KicadBoard | null
): RouteOptions & DragOptions {
  return {
    get pushVias() {
      return routerSettings(prefs()).shoveVias
    },
    get jumpOverObstacles() {
      return routerSettings(prefs()).jumpOverObstacles
    },
    get smartPads() {
      return routerSettings(prefs()).smartPads
    },
    get autoPosture() {
      return routerSettings(prefs()).autoPosture
    },
    get startDiagonal() {
      return routerSettings(prefs()).startDiagonal
    },
    get smoothDragged() {
      return routerSettings(prefs()).smoothDragged
    },
    get optimizeDragged() {
      return routerSettings(prefs()).optimizeDragged
    },
    isFixed: (item) => {
      const b = board()
      if (!b || item.ref.index < 0) return false
      if (item.ref.type === 'segment') return b.segments[item.ref.index]?.locked ?? true
      if (item.ref.type === 'tarc') return b.trackArcs[item.ref.index]?.locked ?? true
      if (item.ref.type === 'via') return b.vias[item.ref.index]?.locked ?? true
      return true
    }
  }
}

const EPS = 1e-6

export class RouteController implements RoutePreviewSource {
  private session: RouteSession | null = null
  /** The board the route began on: an edit from elsewhere moves it (`outsideChange`). */
  private beganOn: KicadBoard | null = null
  private clusterMemo: {
    board: KicadBoard
    index: BoardSpatialIndex
    net: number
    start: Pt
    clusters: RouteNetClusters
  } | null = null
  /** Set while the route lands its own command, which R34 must let through. */
  landing = false
  /** The copper the last finish that arrived ended on (`attemptFinish`). */
  finishedAt: CopperItem | null = null
  /** The copper the last finish headed for, arrived or not. */
  private headedFor: CopperItem | null = null

  constructor(
    private readonly host: RouteHost,
    readonly state: RouteState = createRouteState()
  ) {}

  // ---- what the route is drawn with ---------------------------------------

  /** Whether a route is in progress. */
  get active(): boolean {
    return this.state.tail !== null
  }

  /** The board's copper in stack order (file order — v9+ ordinals lie). */
  copper(): string[] {
    return (this.host.board()?.layers ?? []).filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  }

  layer(): string {
    return this.host.layer()
  }

  /**
   * The net class governing the route: the routed net's through the
   * assignment patterns, Default when idle or the net is unassigned.
   */
  netClass(): NetClass {
    const b = this.host.board()
    const setup = this.host.setup()
    const name = b && this.state.net > 0 ? getNetName(b, this.state.net) : ''
    return name
      ? netClassForNet(name, setup.classes, setup.patterns, setup.assignments)
      : defaultNetClass(setup.classes)
  }

  /** The rules' width for the routed net on the layer being routed (S1). */
  widthRule(): SizeRule<number> {
    const min = this.host.setup().rules.minTrackWidth
    const rules = this.host.sizeRules()
    if (rules) return resolveTrackWidth(rules, this.state.net, this.layer(), min)
    const cls = this.netClass()
    return { value: Math.max(cls.trackWidth, min), min, source: `netclass '${cls.name}'` }
  }

  viaRule(): SizeRule<ViaSize> {
    const setup = this.host.setup().rules
    const boardMin = { diameter: setup.minViaDiameter, drill: setup.minThroughHoleDiameter }
    const rules = this.host.sizeRules()
    const copper = this.copper()
    if (rules)
      return resolveVia(
        rules,
        this.state.net,
        [copper[0] ?? 'F.Cu', copper.at(-1) ?? 'B.Cu'],
        boardMin
      )
    const cls = this.netClass()
    return {
      value: { diameter: cls.viaDiameter, drill: cls.viaDrill },
      min: boardMin,
      source: `netclass '${cls.name}'`
    }
  }

  widthList(): SizeEntry<number>[] {
    return widthSizeList(this.widthRule(), this.host.setup().extraSizes.tracks)
  }

  viaList(): SizeEntry<ViaSize>[] {
    return viaSizeList(this.viaRule(), this.host.setup().extraSizes.vias)
  }

  /** The width a click lays now, why, and whether the rules allow it (S1, S7, S12, R1). */
  widthState(): { width: number; source: WidthSource; outOfRule: boolean } {
    const list = this.widthList()
    const { width, source } = this.ruleWidthHolds()
      ? { width: list[0].size, source: 'rules' as const }
      : widthInForce(
          list,
          this.state.sizeChoice,
          this.state.tail ? this.state.inheritedWidth : null,
          this.host.useConnectedWidth()
        )
    const rule = this.widthRule()
    const outOfRule = width < rule.min - EPS || (rule.max !== undefined && width > rule.max + EPS)
    return { width, source, outOfRule }
  }

  width(): number {
    return this.widthState().width
  }

  /** The narrowest size on the list the rules allow, for K1's `Shift+W`; none narrower than the width in use. */
  narrowestWidth(): number | undefined {
    const legal = this.widthList().filter((o) => !o.outOfRule && o.size < this.width() - 1e-9)
    return legal.length > 0 ? Math.min(...legal.map((o) => o.size)) : undefined
  }

  /** The via a click places now, and why. */
  viaState(): { via: ViaSize; source: Exclude<WidthSource, 'track'> } {
    return viaInForce(this.viaList(), this.state.sizeChoice)
  }

  viaSize(): ViaSize {
    return this.viaState().via
  }

  /** The armed via's size: a microvia's is the net class's microvia, any other the via a click places. */
  armedViaSize(): { size: number; drill: number } {
    if (this.state.viaType === 'micro') {
      const cls = this.netClass()
      return { size: cls.microviaDiameter, drill: cls.microviaDrill }
    }
    const via = this.viaSize()
    return { size: via.diameter, drill: via.drill }
  }

  clearance(): number {
    return this.netClass().clearance
  }

  /** The layer pair (R40): the pick while both its layers exist, else the outer pair. */
  layerPair(): LayerPair {
    const copper = this.copper()
    const pick = this.state.layerPairPick
    return pick && copper.includes(pick.top) && copper.includes(pick.bottom)
      ? pick
      : defaultLayerPair(copper)
  }

  /** The trace as the preview draws it, or null with no route. */
  draft(): RouteDraft | null {
    const s = this.state
    if (!s.tail) return null
    return {
      segments: s.segments,
      vias: s.vias,
      tail: s.tail,
      start: s.start,
      net: s.net,
      armedVia: s.viaTarget
        ? {
            ...this.armedViaSize(),
            layers: viaSpan(s.viaType, this.layer(), s.viaTarget, this.copper())
          }
        : null
    }
  }

  /**
   * The request the session proposes from: the same for the preview and the
   * click, so a click gets back the proposal on screen (R18).
   */
  request(tail: Pt, cursor: Pt, mode = this.host.prefs().mode): RouteRequest {
    const prefs = this.host.prefs()
    const corner = routeCorner(prefs)
    const flip = this.state.postureFlip
    const armed = this.draft()?.armedVia
    return {
      mode,
      tail,
      cursor,
      cornerMode: corner.cornerMode,
      rounded: corner.rounded,
      diagFirst: flip,
      // Flipped by hand with `/`: no pad exits, as KiCad's (R38).
      postureForced: flip,
      autoPosture: true,
      layer: this.layer(),
      width: this.width(),
      narrowestWidth: this.narrowestWidth(),
      clearance: this.clearance(),
      net: this.state.net,
      ...(armed ? { via: { size: armed.size, drill: armed.drill, layers: armed.layers } } : {})
    }
  }

  /** The trace's clicked copper, as the engine holds it. */
  pending(extra: RouteDraftSegment[] = []): PendingCopper {
    return {
      segments: chordsOf([...this.state.segments, ...extra]),
      vias: this.state.vias.map((v) => ({
        x: v.x,
        y: v.y,
        size: v.size,
        drill: v.drill,
        ...(v.layers ? { layers: v.layers } : {})
      }))
    }
  }

  /** The head for `cursor`, as the preview shows it; null with no route or no world. */
  propose(cursor: Pt): RouteProposal | null {
    const tail = this.state.tail
    const session = this.ensureSession()
    if (!tail || !session) return null
    return session.propose(this.request(tail, cursor), this.pending())
  }

  /** Copper the live head pushed, as the preview draws it. */
  displaced(): DisplacedPreview {
    return this.session?.displaced() ?? { hiddenRefs: [], segments: [] }
  }

  /**
   * The net's copper as landing the route with this head would leave it: the
   * tracks it merges into, cuts, lies over or makes redundant (R26, R27),
   * shown as KiCad's router shows a loop it removes, before the click.
   */
  landed(proposal: RouteProposal): DisplacedPreview {
    const b = this.host.board()
    const s = this.state
    if (!b || s.net === 0) return { hiddenRefs: [], segments: [] }
    const head = draftsOf(proposal.segments, this.layer(), this.width())
    const plan = planLanding(
      b,
      { segments: [...s.segments, ...head], vias: s.vias, net: s.net },
      { removeLoops: routerSettings(this.host.prefs()).removeLoops, index: this.host.index() }
    )
    return landingPreview(b, plan)
  }

  /** Copper the route's clicks have pushed so far, as it would land. */
  pushedCount(): number {
    const delta = this.session?.delta()
    return delta ? delta.removed.length + (delta.movedVias?.length ?? 0) : 0
  }

  /**
   * Where the route may connect to the rest of its net: each anchor of the
   * net's copper not yet joined to where it started. Worked out once per route
   * and board (F7, R35).
   */
  clusters(): RouteNetClusters {
    const b = this.host.board()
    const index = this.host.index()
    const start = this.state.start
    const net = this.state.net
    if (!b || !index || !start || net === 0) return { origin: [], others: [] }
    const memo = this.clusterMemo
    if (
      memo &&
      memo.board === b &&
      memo.index === index &&
      memo.net === net &&
      memo.start.x === start.x &&
      memo.start.y === start.y
    )
      return memo.clusters
    const clusters = routeNetClusters(b, index, net, start)
    this.clusterMemo = { board: b, index, net, start: { ...start }, clusters }
    return clusters
  }

  anchors(): RouteNetClusters['others'][number] {
    return this.clusters().others.flat()
  }

  /** Pads of the routed net not yet joined that the routed layer does not reach (K1). */
  viaPads(): Pt[] {
    const layer = this.layer()
    return this.anchors()
      .filter((a) => a.item.ref.type === 'pad' && !a.item.layers.includes(layer))
      .map((a) => a.point)
  }

  /**
   * Whether a point is on the route's current end: inside the via dropped
   * there, or within the track's half width of the tail. Grid snap puts a click
   * near the end rather than on it, so this is a reach, not an equality.
   */
  onRouteEnd(point: Pt): boolean {
    const tail = this.state.tail
    if (!tail) return false
    const via = this.state.vias.find((v) => Math.hypot(v.x - tail.x, v.y - tail.y) < 1e-9)
    const reach = via ? via.size / 2 : this.width() / 2
    return Math.hypot(point.x - tail.x, point.y - tail.y) <= reach
  }

  /**
   * Whether the route's end already reaches a layer with nothing laid since a
   * through pad or a via, so changing to it needs no via (R36).
   */
  tailReaches(layer: string): boolean {
    const tail = this.state.tail
    if (!tail) return false
    const at = (p: Pt): boolean => Math.abs(p.x - tail.x) < EPS && Math.abs(p.y - tail.y) < EPS
    if (this.state.vias.some((via) => at(via) && (via.layers ?? this.copper()).includes(layer)))
      return true
    return (
      this.state.segments.length === 0 &&
      this.state.vias.length === 0 &&
      this.state.startLayers.includes(layer)
    )
  }

  // ---- the route ------------------------------------------------------------

  /**
   * Start a trace at `start` — the one way a route begins. `from` is what the
   * magnet found there: its net, its copper layers, and when it is a track,
   * its width, which the route carries while *Use starting track width* is
   * on (R1); started on a pad or via, the width of a track leaving it, as
   * KiCad's. Copper that is not on the routing layer switches to its own — a
   * track's layer, an SMD pad's side — while a through pad or via already on
   * it keeps it. The switch is for this route only: the layer active now is
   * the one the route's end hands back, as after a via (R24).
   *
   * With a via armed for the start (R37) it is placed there and the route
   * runs on its far layer; a via that cannot stand refuses the start, still
   * armed, and `refused` holds what it violates.
   */
  begin(start: Pt, from: RouteStart = {}): { refused?: ViolationMark[] } {
    const s = this.state
    this.session = null
    this.beganOn = this.host.board()
    s.originLayer = this.layer()
    s.net = from.net ?? this.netAt(start)
    const copper = from.layers?.filter(isCopperLayer) ?? []
    s.startLayers = copper
    if (copper.length > 0 && !copper.includes(this.layer())) this.host.setLayer(copper[0])
    s.inheritedWidth = from.trackWidth ?? this.tracksLeaving(start, s.net, from.cursor ?? start)
    s.ruleWidth = false
    s.sizeChoice = { ...s.sizeChoice, override: false }
    s.tail = start
    s.start = start
    this.ensureSession()
    if (!s.startVia) return {}
    s.viaTarget = this.defaultViaTarget()
    if (this.commitHead(start)) {
      s.startVia = false
      return {}
    }
    const session = this.ensureSession()
    const marks = session ? session.propose(this.request(start, start), this.pending()).marks : []
    this.cancel()
    s.startVia = true
    return { refused: marks }
  }

  /**
   * Fold a click into the trace: commit exactly what the engine proposed for
   * this cursor — the preview IS the commit. A head blocked while violations
   * are blocked lays nothing (R19). In walkaround a click may land short of
   * the cursor (a hug); the tail advances to wherever the proposal reached.
   * A click over the route's own net's copper ends the route (R20, KiCad's
   * `FixRoute` on an end item of its net): arrived where the head reached it,
   * else ended short of it, that end left unconnected.
   */
  click(info: RouteClick): RouteOutcome {
    const s = this.state
    const scenePt = info.snapped
    if (!s.tail) {
      const begun = this.begin(scenePt, {
        net: info.magnetNet,
        trackWidth: info.magnetTrackWidth,
        layers: info.magnetLayers,
        cursor: info.point
      })
      return begun.refused ? 'refused' : 'begun'
    }
    // A click with nothing to lay — on the route's current end, a via just
    // placed there included — does nothing, but for an armed via, which is
    // placed there alone and ends the route (R21, KiCad's FixRoute).
    if (this.onRouteEnd(scenePt)) {
      if (emptyRouteClick(s.viaTarget !== null) === 'placeViaAndFinish') {
        if (this.commitHead(s.tail ?? scenePt)) {
          this.commit()
          return 'ended'
        }
      }
      return 'nothing'
    }
    // An armed via lands with this click at the head's end (R24), refused with it.
    if (s.viaTarget) return this.commitHead(scenePt) ? 'laid' : 'nothing'
    // A route with no net, through copper as Highlight goes, takes the
    // net of what it ends on (R1): the head is the same, its violation is not.
    if (
      s.net === 0 &&
      info.magnetNet !== undefined &&
      info.magnetNet > 0 &&
      this.host.prefs().mode === 'highlight'
    ) {
      s.net = info.magnetNet
      if (this.commitHead(scenePt)) {
        this.commit()
        return 'ended'
      }
      s.net = 0
      return 'nothing'
    }
    // Fix all segments off: the click lays the head up to its last corner, and
    // the segment nearest the cursor stays free (R18, KiCad's setting).
    const session = this.ensureSession()
    const tail = s.tail
    if (!routerSettings(this.host.prefs()).fixAllSegments && !info.onNetTarget && session && tail) {
      const head = session.propose(this.request(tail, scenePt), this.pending())
      const last = head.segments[head.segments.length - 1]
      if (head.segments.length >= 2 && !head.blocked && last) {
        return this.commitHead({ x: last.x0, y: last.y0 }) ? 'laid' : 'nothing'
      }
    }
    const endsAt = this.commitHead(scenePt)
    if (!endsAt) return 'nothing'
    if (!info.onNetTarget) return 'laid'
    const arrived = Math.hypot(endsAt.x - scenePt.x, endsAt.y - scenePt.y) < EPS
    this.commit()
    return arrived ? 'arrived' : 'ended'
  }

  /**
   * Lay the head the preview shows for `cursor` down as a click does (R18): the
   * segments join the trace and the tail moves to where the head ends, which it
   * returns. An armed via lands with it at its end — alone, for a head of no
   * length — and is refused with it (R24). Null when nothing lands — no head
   * and no via, or one blocked by a violation while violations are blocked (R19).
   */
  commitHead(cursor: Pt): Pt | null {
    const s = this.state
    const session = this.ensureSession()
    const tail = s.tail
    if (!session || !tail) return null
    const armed = s.viaTarget !== null
    const proposal = session.propose(this.request(tail, cursor), this.pending())
    if (proposal.segments.length === 0 && !armed) return null
    if (!commitsViolations(this.host.prefs()) && proposal.blocked) return null
    if (proposal.segments.length > 0) {
      session.markClick()
      this.pushStop()
      const layer = this.layer()
      const width = this.width()
      s.segments = [...s.segments, ...draftsOf(proposal.segments, layer, width)]
      s.tail = proposal.endsAt
    }
    if (armed) this.placeArmedVia()
    return proposal.endsAt
  }

  /**
   * Land the trace as one command, its pushes with it (R25), and end the
   * route. Nothing clicked ends it without a command. True when it landed.
   */
  commit(): boolean {
    const s = this.state
    const b = this.host.board()
    const segments = s.segments
    const vias = s.vias
    if (!b || (segments.length === 0 && vias.length === 0)) {
      this.cancel()
      return false
    }
    // The pushes of every click are in the session's floor; the head's own
    // since the last click never landed, so they are not.
    const session = this.session
    session?.dropHead()
    const delta = session?.delta()
    const net = s.net
    const removeLoops = routerSettings(this.host.prefs()).removeLoops
    const copper = this.copper()
    const index = this.host.index()
    this.landing = true
    try {
      this.host.land(() =>
        landRoute(b, { segments, vias, net }, { delta, removeLoops, copper, index })
      )
    } finally {
      this.landing = false
    }
    this.cancel()
    return true
  }

  /**
   * End the route, landed or not: the head and its pushes spring back. The
   * layer goes back to the one the route began on unless `restoreLayer` is
   * false (a different board is opening, whose layers are its own).
   */
  cancel(restoreLayer = true): void {
    const s = this.state
    s.viaTarget = null
    s.segments = []
    s.vias = []
    s.tail = null
    s.start = null
    s.stops = []
    s.net = 0
    s.inheritedWidth = null
    s.ruleWidth = false
    s.startLayers = []
    s.postureFlip = false
    this.session?.reset()
    this.session = null
    this.beganOn = null
    const origin = s.originLayer
    s.originLayer = null
    if (restoreLayer && origin && origin !== this.layer()) this.host.setLayer(origin)
  }

  /**
   * The board changed under a route by someone else's edit (an agent's, an
   * undo): the session's pushes index copper that may have moved, so the
   * route ends with nothing landed. True when it did.
   */
  outsideChange(): boolean {
    if (!this.state.tail || this.host.board() === this.beganOn) return false
    this.cancel()
    return true
  }

  /**
   * `End` (KiCad's End Track): the head lands where the preview shows it for
   * `cursor`, as a click lays it, and the route ends there; a head that cannot
   * land leaves what was clicked (R21).
   */
  endHere(cursor: Pt | null): boolean {
    const tail = this.state.tail
    // On the route's end there is no head, but an armed via is still placed (R21).
    if (cursor && tail) this.commitHead(this.onRouteEnd(cursor) ? tail : cursor)
    return this.commit()
  }

  /**
   * Route the rest of the connection (`F`, KiCad's Attempt Finish): iterate the
   * engine toward the nearest unconnected same-net anchor on the routed layer,
   * nearest the head's end for `cursor` as KiCad measures from the line's end
   * (else the tail), or toward `target`, and land the route if it arrives.
   * Progress is kept either way, the tail advanced to wherever the head reached.
   */
  attemptFinish(opts: { cursor?: Pt | null; target?: UnconnectedAnchor } = {}): RouteOutcome {
    const s = this.state
    this.finishedAt = null
    this.headedFor = null
    const b = this.host.board()
    const idx = this.host.index()
    const tail = s.tail
    if (!b || !idx || !tail || s.net <= 0) return 'nothing'
    const layer = this.layer()
    const from = (opts.cursor && this.propose(opts.cursor)?.endsAt) || tail
    // Only copper on the routed layer is arrived at (R30): a via gets to the rest.
    const anchor = opts.target
      ? opts.target.item.layers.includes(layer)
        ? opts.target
        : null
      : nearestUnconnectedAnchor(b, idx, s.net, s.start ?? tail, from, layer)
    if (!anchor) return 'nothing'
    this.headedFor = anchor.item
    const target = anchor.point
    const session = this.ensureSession()
    if (!session) return 'nothing'
    const mode = this.host.prefs().mode
    // Highlight would only draw a line through everything: finish walks.
    const finishMode = mode === 'highlight' ? 'walkaround' : mode
    const width = this.width()
    const done: RouteDraftSegment[] = []
    const result = attemptFinish(tail, target, (from, cursor) => {
      const p = session.propose(this.request(from, cursor, finishMode), this.pending(done))
      // Each round's pushes stay while the next round goes on from its end.
      if (!p.blocked && p.segments.length > 0) {
        session.markClick()
        done.push(...draftsOf(p.segments, layer, width))
      }
      return p
    })
    if (result.segments.length === 0) return 'nothing'
    session.mergeClicks(result.rounds)
    this.pushStop()
    // The rounds joined end to end may run back over their own copper (R26).
    s.segments = [...s.segments, ...cutRetraces(draftsOf(result.segments, layer, width))]
    s.tail = result.endsAt
    if (!result.arrived) return 'laid'
    // Arrived with a via armed, it is placed at the end, as KiCad's Finish lays the via its head carries.
    if (s.viaTarget) this.placeArmedVia()
    this.finishedAt = anchor.item
    this.commit()
    return 'arrived'
  }

  /**
   * Attempt Finish Selected along one ratsnest line (R46, KiCad's Autoroute
   * Selected): a route begun at `start` on the active layer where the start
   * has it, and finished as `F` finishes one, toward the copper nearest the
   * start (`toward`). One that arrives lands; one that does not is dropped.
   */
  finishFrom(start: SelectedRouteStart): {
    outcome: RouteOutcome
    toward: CopperItem | null
    refused?: ViolationMark[]
  } {
    const { refused } = this.begin(start.point, { net: start.net, layers: start.layers })
    if (refused) return { outcome: 'refused', toward: null, refused }
    const outcome = this.attemptFinish()
    const toward = this.headedFor
    if (this.active) this.cancel()
    return { outcome, toward }
  }

  /**
   * Arm a via at the head's end, bound for `targetLayer` — where `V` goes
   * (R35) when none is named (R24). Arming it again for the same layer and
   * type takes it back.
   */
  armVia(targetLayer?: string, type: RouteViaType = 'through'): void {
    const s = this.state
    if (!s.tail) return
    const layer = this.layer()
    const chosen = targetLayer
      ? { target: targetLayer, type: settledViaType(type, layer, targetLayer, this.copper()) }
      : this.viaTargetFor(type)
    if (
      !chosen ||
      chosen.target === layer ||
      (chosen.target === s.viaTarget && chosen.type === s.viaType)
    ) {
      s.viaTarget = null
      return
    }
    s.viaTarget = chosen.target
    s.viaType = chosen.type
  }

  /** Where a via of `type` goes from the routed layer (R35, R40, R41). */
  viaTargetFor(type: RouteViaType): { target: string; type: RouteViaType } | null {
    const tail = this.state.tail
    return viaTarget({
      type,
      current: this.layer(),
      pair: this.layerPair(),
      copper: this.copper(),
      toward: tail ? nearestAnchor(this.anchors(), tail)?.item.layers : undefined
    })
  }

  /** Where `V` sends the route (R35). */
  defaultViaTarget(): string {
    return this.viaTargetFor('through')?.target ?? defaultLayerPair(this.copper()).bottom
  }

  /**
   * Place the armed via at the tail — where the click's head has just ended —
   * and continue on its layer. One stop, so Backspace takes the via back alone,
   * with what it pushed.
   */
  placeArmedVia(): void {
    const s = this.state
    const tail = s.tail
    const target = s.viaTarget
    if (!tail || !target) return
    s.viaTarget = null
    this.session?.markVia()
    this.pushStop()
    const type = s.viaType
    s.vias = [
      ...s.vias,
      {
        x: tail.x,
        y: tail.y,
        ...this.armedViaSize(),
        type,
        layers: viaSpan(type, this.layer(), target, this.copper())
      }
    ]
    s.viaType = 'through'
    this.host.setLayer(target)
    // With *Use starting track width* on, a width not picked on this route —
    // carried from a track, or a row or size picked before it — survives the
    // via only within the new layer's rule; past it, the rules' width (S1, S12).
    if (
      this.host.useConnectedWidth() &&
      !s.sizeChoice.override &&
      !s.ruleWidth &&
      this.widthState().outOfRule
    ) {
      s.inheritedWidth = null
      s.ruleWidth = true
    }
  }

  /** Undo mid-route: the last click, as Backspace; with nothing clicked, the start (R22). */
  undoStep(): void {
    if (this.state.viaTarget || this.state.stops.length > 0) this.unrouteLast()
    else this.cancel()
  }

  /**
   * Backspace mid-route: an armed via goes first, else the last click, its
   * pushes springing back (R22). What it took back, or nothing.
   */
  unrouteLast(): 'via' | 'click' | 'nothing' {
    const s = this.state
    if (s.viaTarget) {
      s.viaTarget = null
      return 'via'
    }
    const stops = s.stops
    if (stops.length === 0) return 'nothing'
    const stop = stops[stops.length - 1]
    s.stops = stops.slice(0, -1)
    this.session?.undoClick()
    s.segments = s.segments.slice(0, stop.segs)
    s.vias = s.vias.slice(0, stop.vias)
    s.inheritedWidth = stop.inherited
    s.ruleWidth = stop.ruleWidth
    if (stop.layer !== this.layer()) this.host.setLayer(stop.layer)
    const last = s.segments[s.segments.length - 1]
    s.tail = last ? { x: last.x1, y: last.y1 } : (s.start ?? s.tail)
    return 'click'
  }

  /**
   * A layer key: mid-route it arms a via to that layer (R24) unless the end
   * already reaches it (R36); otherwise the layer simply changes.
   */
  switchLayer(target: string): void {
    if (!isCopperLayer(target)) return
    if (this.state.tail && !this.tailReaches(target)) this.armVia(target)
    else this.host.setLayer(target)
  }

  /**
   * Route From Other End (`Ctrl+E`, R45): what is clicked lands, and a new
   * route starts at the nearest copper of the net it has not yet joined.
   */
  fromOtherEnd(): boolean {
    const s = this.state
    const tail = s.tail
    if (!this.host.board() || !this.host.index() || !tail || s.net <= 0) return false
    const net = s.net
    const target = nearestAnchor(this.anchors(), tail)
    if (!target) return false
    this.commit()
    this.begin(target.point, { net, layers: target.item.layers })
    return true
  }

  /** `/`: flip the head's posture until the next click (R4). */
  flipPosture(): void {
    this.state.postureFlip = !this.state.postureFlip
  }

  /** `V` before a route: arm (or disarm) a via for its start (R37). */
  setStartVia(on: boolean): void {
    this.state.startVia = on
  }

  setLayerPair(pair: LayerPair): void {
    this.state.layerPairPick = { top: pair.top, bottom: pair.bottom }
  }

  setSizeChoice(next: RouteSizeChoice): void {
    this.state.sizeChoice = next
  }

  /**
   * `W` / `Shift+W` (S5). Mid-route the pick is this route's own, so a via
   * keeps it whatever the new layer's rule (S12).
   */
  stepWidth(dir: 1 | -1): void {
    const next = stepWidthChoice(
      this.state.sizeChoice,
      this.widthList().length,
      dir,
      this.widthState().source === 'track' || this.ruleWidthHolds()
    )
    this.setSizeChoice(this.active ? { ...next, override: true } : next)
  }

  /** `'` / `\`. */
  stepVia(dir: 1 | -1): void {
    this.setSizeChoice(stepViaChoice(this.state.sizeChoice, this.viaList().length, dir))
  }

  /** A row picked from the list: KiCad's menu, which also leaves a carried width. */
  pickWidthRow(index: number): void {
    this.setSizeChoice({
      ...this.state.sizeChoice,
      widthIndex: index,
      custom: null,
      override: true
    })
  }

  pickViaRow(index: number): void {
    this.setSizeChoice({ ...this.state.sizeChoice, viaIndex: index, custom: null })
  }

  // ---- internals -------------------------------------------------------------

  /** Whether the rules' width stands in for one a via's layer forbade, nothing picked since (S12). */
  private ruleWidthHolds(): boolean {
    const s = this.state
    return s.tail !== null && s.ruleWidth && !s.sizeChoice.override
  }

  /** The route's session, made over the world the board had when the route began. */
  private ensureSession(): RouteSession | null {
    if (this.session) return this.session
    if (!this.state.tail) return null
    const world = this.host.world()
    if (!world) return null
    this.session = new RouteSession(
      world,
      routerOptionsOf(
        () => this.host.prefs(),
        () => this.host.board()
      )
    )
    return this.session
  }

  private pushStop(): void {
    const s = this.state
    s.postureFlip = false
    s.stops = [
      ...s.stops,
      {
        segs: s.segments.length,
        vias: s.vias.length,
        layer: this.layer(),
        inherited: s.inheritedWidth,
        ruleWidth: s.ruleWidth
      }
    ]
  }

  private netAt(point: Pt): number {
    if (this.host.netAt) return this.host.netAt(point)
    const hit = this.host
      .index()
      ?.near(point.x, point.y, 0.05, {})
      .find((h) => h.dist === 0)
    return hit ? hit.item.net : 0
  }

  /** The width of the net's tracks ending at `at` that a route started there carries (R1). */
  private tracksLeaving(at: Pt, net: number, cursor: Pt): number | null {
    const idx = this.host.index()
    if (!idx || net <= 0) return null
    const tracks = idx.near(at.x, at.y, 1e-3, { net }).flatMap(({ item }) => {
      const sh = item.shape
      return (item.ref.type === 'segment' || item.ref.type === 'tarc') &&
        (sh.kind === 'capsule' || sh.kind === 'arc')
        ? [
            {
              a: { x: sh.x0, y: sh.y0 },
              b: { x: sh.x1, y: sh.y1 },
              width: sh.halfWidth * 2,
              layer: item.layers[0]
            }
          ]
        : []
    })
    return connectedTrackWidth(tracks, at, this.layer(), cursor)
  }
}
