<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, onMounted, onUnmounted, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as THREE from 'three'
import {
  ViewportEngine,
  GridSettings,
  STANDARD_GRID_APPEARANCE
} from '../../lib/engine/ViewportEngine'
import {
  BoardScene,
  boardRefKey,
  isFootprintChild,
  promotePads,
  BoardItemRef,
  BoardDisplayOptions,
  type BoardEditDelta,
  type RoutePreviewSegment
} from '../../lib/engine/BoardScene'
import { KicadBoard, getNetName, type KicadBoardFootprint } from '../../lib/kicad/board'
import { hotkeyLabel } from '../../lib/hotkeys'
import { mmToNm, nmToMm, spacingToMm, type Nm } from '../../lib/kicad/coordinates'
import { footprintTransform, tfPoint } from '../../lib/schematic/placement'
import {
  graphicDefaults,
  isGestureTool,
  pcbToolShape,
  previewToScene,
  takesLineMode,
  shapePreviewPrimitives,
  type PcbTool,
  type PcbToolShape,
  type RouteCornerMode
} from '../../lib/board/pcbTools'
import { type BoardSpatialIndex, type CopperItem } from '../../lib/board/spatialIndex'
import {
  clearanceOutlines,
  ownClearanceMemo,
  previewClearanceRings
} from '../../lib/board/clearanceOutlines'
import type { BoardRules } from '../../lib/board/rules/boardRules'
import { keyCapLabel } from '../../lib/keyCap'
import KeyCapKbd from '../shared/KeyCapKbd.vue'
import {
  showsDragClearance,
  showsRouteClearance,
  type TrackClearanceDisplay
} from '../../lib/pcbView'
import { isCopperLayer } from '../../lib/kicad/layers'
import { alignToStartAxes, routeTarget } from '../../lib/board/routeTarget'
import {
  chordsOf,
  type RouteMode,
  type RouteState,
  type ViolationMark
} from '../../lib/board/router/engine'
import { routeRatsnest } from '../../lib/board/router/autocomplete'
import type { RouteDraft, RoutePreviewSource } from '../../lib/board/routeController'
import type { NonActiveLayerDisplay } from '../../lib/board/layerPresets'
import { delayedVisible } from '../../lib/delayedVisible'
import { FRAME_BUDGET_MS, afterPaint, yieldControl } from '../../lib/cooperate'
import { loadCamera, saveCamera } from '../../lib/engine/cameraStore'
import { measureViewportInsets } from '../../lib/engine/viewportInsets'
import { BoardRenderLayer } from '../../lib/engine/board3d/boardRenderLayer'
import { BoardModelAssetCache } from '../../lib/engine/board3d/modelAssetCache'
import { board3dPresentation, board3dViewState } from '../../lib/board3dView'
import type { PixelSize } from '../../lib/board3dExport'
import { exportBoard3DView } from '../../lib/engine/board3d/viewExport'
import { dirnameOf } from '../../lib/kicad/paths'
import { useCanvasSelection } from '../../lib/canvasSelection'
import { resolveHit } from '../../lib/selectionResolve'
import { boardItemLabel } from '../../lib/board/boardItemLabel'
import { chordsLength } from '../../lib/board/routeLength'
import SelectOtherMenu from '../shared/SelectOtherMenu.vue'
import { constrainChainPoint } from '../../lib/lineMode'
import { useSelectionFilter } from '../../lib/selectionFilter'
import { useAppTheme } from '../../lib/theme'
import { iconCursor } from '../../lib/icons'
import CubeIcon from '../shared/CubeIcon.vue'
import Icon from '../shared/Icon.vue'
import {
  agentViewportHandlers,
  agentViewportsFor,
  type ViewportFrame
} from '../../lib/agentViewportView'
import AgentViewportOverlay from '../shared/AgentViewportOverlay.vue'
import FitViewButton from '../shared/FitViewButton.vue'
import SelectionFilterControl from '../shared/SelectionFilterControl.vue'
import GridSettingsControl from '../shared/GridSettingsControl.vue'
import type { ViewCommand } from '../../lib/viewCommands'
import { findingMarkersLayer, type DocumentMarker } from '../../lib/engine/findingMarkersLayer'
import { MARKER_UNIT_MM } from '../../lib/engine/FindingMarkers'
import TuneMeter from './TuneMeter.vue'
import type { TuneMeterReading } from '../../lib/board/tuneMeter'
import ViewportStatusBar, {
  type StatusCoords,
  type StatusItem
} from '../shared/ViewportStatusBar.vue'
import {
  registerTestProvider,
  type TestElement,
  type TestElementQuery,
  type TestProvider
} from '../../lib/testHooks'

const { t } = useI18n()

export type { PcbTool }

/** Info emitted for tool clicks (scene-space coordinates, y up). */
export interface ToolClick {
  point: { x: number; y: number }
  snapped: { x: number; y: number }
  hit: BoardItemRef | null
  /**
   * Net of the copper the route magnet snapped to, when it did — how the
   * first route click inherits its net at pad precision.
   */
  magnetNet?: number
  /**
   * True when the click magnet-landed on same-net copper — pad, via, or
   * track — while a route was in progress: the "arrived" signal that
   * finishes the trace with a single click (double-click stays the dead-end
   * finish).
   */
  onNetTarget?: boolean
  /** Width (mm) of the track the click's magnet landed on, if any. */
  magnetTrackWidth?: number
  /** Copper layers of the pad, via or track the magnet landed on — a route
   *  started there goes on one of them. */
  magnetLayers?: readonly string[]
}

/** What the router is doing with the head, for the keys the hint teaches (router-behavior.md K1). */
export interface RouteStateReport {
  state: RouteState
  /** Blocked, and no narrower width the rules allow gets through. */
  narrowerFails: boolean
  /** The head is near a pad of its net that the routed layer does not reach. */
  nearViaPad: boolean
  /** The head's length, mm, to the micron: the live length readout adds it (S11). */
  headLength: number
}

/** A pending (uncommitted) trace (`lib/board/routeController.ts`). */
export type { RouteDraft }

const props = defineProps<{
  mode: 'layout' | '3d'
  board: KicadBoard | null
  /**
   * Changes only when `board` came from a parse, not from an edit's AST
   * remap — the two arrive the same way and want opposite builds (see
   * `buildBoardScene`).
   */
  loadId: number
  selectedItems: BoardItemRef[]
  gridSettings: GridSettings
  layerVisibility: Record<string, boolean>
  activeLayer: string
  nonActiveDisplay: NonActiveLayerDisplay
  flipped: boolean
  /** Persisted display toggles (lib/pcbView.ts): fills + sketch modes. */
  viewOptions: {
    zoneFills: boolean
    sketchTracks: boolean
    sketchVias: boolean
    sketchPads: boolean
    boardArea?: boolean
    fpReferences?: boolean
    fpValues?: boolean
    fpText?: boolean
    padClearance?: boolean
    trackClearance?: TrackClearanceDisplay
  }
  /** The board's rules, while clearance outlines are on: each item's own clearance. */
  clearanceRules?: BoardRules | null
  activeTool: PcbTool
  /** The in-progress trace (null when the route tool is idle) */
  routeDraft: RouteDraft | null
  /**
   * The routed net's copper by cluster: the one the route left and every
   * other, which the route's ratsnest spans from the head (F7); `airwires`
   * false draws only the line to where it is headed.
   */
  routeNetClusters?: {
    origin: ReadonlyArray<{ x: number; y: number }>
    others: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>
    airwires: boolean
  }
  /** `V` before a route: the via its start will place, drawn at the cursor (R37). */
  routeStartVia?: { size: number; drill: number } | null
  /** What a refused drop or start violated, marked for a moment after it springs back (D9, R24). */
  refusalMarks?: readonly ViolationMark[]
  /** Committed clicks of an armed graphics tool (domain nm, y down) */
  toolDraft: Array<{ x: number; y: number }>
  routeWidth: number
  /** Pads of the routed net not yet joined that the routed layer does not reach (K1). */
  routeViaPads?: ReadonlyArray<{ x: number; y: number }>
  /** The route's net has a length rule: report the head's length (S11), else 0 so no frame is news. */
  routeMeasureHead?: boolean
  /**
   * Every key of the operation in hand, in order (router-behavior.md K1): the
   * hint shows the first `routeHintMax` that fit beside the right corner's
   * pills, and `routeHintMore` (`?`) after them where any did not.
   */
  routeHintKeys?: StatusItem['keys']
  routeHintMax?: number
  routeHintMore?: NonNullable<StatusItem['keys']>[number]
  /** The armed pair or tuner's coaching line, over the tool's own (PR1, T1). */
  coaching?: string
  /** A tune's status, drawn as a meter beside the cursor (router-behavior.md T4). */
  tuneMeter?: TuneMeterReading | null
  /**
   * The operation's keys in sections, on a card above the hint while `?` holds
   * it open (K4), and the caps that toggle it; null when shut.
   */
  routeKeysCard?: {
    title: string
    toggle: string[]
    sections: Array<{ title?: string; keys: NonNullable<StatusItem['keys']> }>
  } | null
  /** Copper layer new tracks go on (the active layer may be non-copper) */
  routeLayer: string
  routeCornerMode: RouteCornerMode
  routeDiagFirst: boolean
  /** Clearance (mm) the live elbow is checked against; the governing class's. */
  routeClearance: number
  spatialIndex: BoardSpatialIndex | null
  /** The last command's change set, for the incremental scene apply. */
  editDelta?: BoardEditDelta | null
  /** Router mode, and the route every proposal goes through (`RouteController`). */
  routeMode: RouteMode
  routePreview: RoutePreviewSource | null
  /** True while a track drag (D) is in progress — clicks commit it. */
  trackDragging: boolean
  /** Net of the live track drag, for the same net-focus dim routing gets; 0 idle. */
  trackDragNet: number
  /** The net Highlight Net (`) holds lit while no route or drag focuses one; 0 none. */
  highlightedNet: number
  /** Hidden originals + proposed geometry while a track drag is live. */
  trackDragPreview: {
    hiddenRefs: Array<{ type: string; index: number }>
    segments: Array<{
      x0: number
      y0: number
      x1: number
      y1: number
      width: number
      layer: string
      violation?: boolean
    }>
    /** Pushed vias (board index), where they would go. */
    vias?: Array<{ index: number; x: number; y: number; size: number }>
    /** What the drag violates (F2). */
    marks?: ViolationMark[]
    /**
     * The clearance the dragged copper keeps, and where in `segments` (and in
     * `vias`, for a dragged via) it begins: what comes before was pushed.
     */
    clearance?: { mm: number; from: number; viaFrom?: number }
  } | null
  /** Airwires to draw (scene space, y up); [] hides the ratsnest. */
  airwires: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; net?: number }>
  filePath?: string | null
  /** The `.kicad_pro`, for resolving project-relative `(model …)` paths. */
  projectPath?: string | null
  /**
   * The footprint Place Footprint holds, placed at the origin: drawn as a
   * selected footprint is, at the snapped cursor, while the tool is armed.
   */
  placementGhost?: KicadBoardFootprint | null
  /** Draw placed component bodies over the layout (boardRenderLayer.ts). */
  renderLayer: boolean
  /** How strongly it covers the layout: 0 pure layout, 1 pure render. */
  renderLayerOpacity: number
  /** The checks' findings to mark on the canvas, board mm, y down. */
  findingMarkers?: readonly DocumentMarker[]
}>()

const emit = defineEmits<{
  (e: 'update:selectedItems', items: BoardItemRef[]): void
  /** A finding's canvas marker was clicked, by its finding's key. */
  (e: 'finding-marker', key: string): void
  (e: 'update-grid', settings: Partial<GridSettings>): void
  (e: 'tool-click', info: ToolClick): void
  (e: 'tool-finish'): void
  /** A double-click with the select tool: the editor selects a track's connection. */
  (e: 'select-double-click'): void
  (e: 'drag-start', type: 'object' | 'vertex', info?: Record<string, unknown>): void
  (e: 'drag-move', delta: { x: number; y: number }): void
  (e: 'drag-end'): void
  (e: 'track-drag-move', point: { x: number; y: number }): void
  /** A click ending a `D` drag, pair or tune; Ctrl (Cmd) held commits it anyway (D9). */
  (e: 'track-drag-commit', commitAnyway: boolean): void
  /** A right click while routing, or with a drag, pair or tune in hand: the router's menu (R21). */
  (e: 'gesture-menu', at: { clientX: number; clientY: number }): void
  /** The posture the live head is drawn in (auto from the mouse, or flipped). */
  (e: 'route-posture', diagFirst: boolean): void
  /**
   * What S11's clearance names (`CopperItem.id`): the copper the head violates
   * first, else what it hugs or stops at; null when none.
   */
  (e: 'route-violator', id: number | null): void
  /** What the router is doing with the head, null with no route: what K1 teaches for. */
  (e: 'route-state', report: RouteStateReport | null): void
  (e: 'close-route-keys'): void
  /** Whether the hint left keys out, so `?` has a card to open (K4). */
  (e: 'hint-overflow', overflow: boolean): void
  /**
   * Progress (0–1) through a newly loaded board's scene build, null once it
   * has settled onto a painted frame. PcbEditor folds this into the tail of
   * the tab's single load bar.
   */
  (e: 'build-progress', fraction: number | null): void
  /** A right click with no tool armed: where, and what is under the pointer. */
  (
    e: 'context-menu',
    payload: {
      clientX: number
      clientY: number
      hit: BoardItemRef | null
      /** Where it was right-clicked, data-scene mm (y up). */
      point: { x: number; y: number }
    }
  ): void
}>()

const viewportContainer = ref<HTMLDivElement | null>(null)
/** Snapped cursor in data space, for gestures that start on a key. */
let lastDataCursor: { x: number; y: number } = { x: 0, y: 0 }
/** A key gesture must not act on a stale point from before the mouse left. */
let pointerInside = false
/** The snapped cursor in world space, where the tune meter sits beside. */
let lastSnappedWorld: { x: number; y: number } | null = null
const tuneMeterEl = ref<HTMLElement | null>(null)
/** The tune meter's top-left in the viewport, px: down-right of the cursor, flipped at an edge. */
const tuneMeterAt = ref<{ x: number; y: number } | null>(null)
/** How far the meter stands off the cursor, px, clear of the crosshair. */
const TUNE_METER_GAP = 20
const placeTuneMeter = (): void => {
  const host = viewportContainer.value
  if (!props.tuneMeter || !engine || !host || !lastSnappedWorld) return
  const rect = host.getBoundingClientRect()
  const at = engine.worldToScreen(lastSnappedWorld.x, lastSnappedWorld.y)
  const x = at.x - rect.left
  const y = at.y - rect.top
  const w = tuneMeterEl.value?.offsetWidth ?? 0
  const h = tuneMeterEl.value?.offsetHeight ?? 0
  tuneMeterAt.value = {
    x: x + TUNE_METER_GAP + w > rect.width ? x - TUNE_METER_GAP - w : x + TUNE_METER_GAP,
    y: y + TUNE_METER_GAP + h > rect.height ? y - TUNE_METER_GAP - h : y + TUNE_METER_GAP
  }
}
watch(
  () => !!props.tuneMeter,
  (shown) => {
    tuneMeterAt.value = null
    // Placed once it has a size, so it flips at an edge from its first frame.
    if (shown) void nextTick(placeTuneMeter)
  }
)
const onContainerMouseEnter = (): void => {
  pointerInside = true
}
const onContainerMouseLeave = (): void => {
  pointerInside = false
}
let engine: ViewportEngine | null = null
let sceneBuilder: BoardScene | null = null
let physicalRender: BoardRenderLayer | null = null
const modelCache = new BoardModelAssetCache()
/** Prevent reactive option/model updates from restarting an in-flight mode entry. */
let entering3DPending = false
let modeEntryToken = 0
/** Selection presses become physical drags only after a nonzero move. */
let physicalDragStarted = false
let disposeTestProvider: (() => void) | null = null
const board3dOptions = board3dViewState()
const board3dLook = board3dPresentation()
const applyPresentation = (): void =>
  engine?.setPresentation3D(
    board3dLook.value.projection,
    board3dLook.value.lighting,
    board3dLook.value.exposure
  )
watch(board3dLook, applyPresentation)
/** True while the assembly overlay is building — the layout stays usable. */
const renderLayerBuilding = ref(false)
/** A deferred-fill repaint is already booked for the next frame. */
let fillRenderScheduled = false

// Pencil-tip hotspot at the glyph's lower-left. Handed to the engine rather
// than bound into CSS: the engine owns the cursor, and a container rule loses
// to the inline style it writes on the canvas filling that container.
const drawCursor = iconCursor('pencil', 3, 15)

/**
 * Where the pointer last was, already in board (file) orientation. Seeded at the
 * origin rather than left empty so the readout is present from the first frame:
 * a pill that materializes on the first mouse move reads as the panel changing
 * shape, and 0,0 is the honest answer before the pointer has been anywhere.
 */
const cursor = ref({ x: 0, y: 0 })
const statusCoords = computed<StatusCoords>(() => ({
  ...cursor.value,
  unit: props.gridSettings.unit,
  spacing: props.gridSettings.snap ? props.gridSettings.spacing : undefined
}))

// Zone fills stream in from the tessellation worker on a cold cache. While
// they do, a bottom-left pill says so with real numbers — otherwise the user
// can't tell when elements will stop fading in — but only for loads that
// outlive the indicator delay (lib/delayedVisible.ts); warm-cache rebuilds
// never see it.
const fillProgress = ref<{ queued: number; settled: number }>({ queued: 0, settled: 0 })
const refreshFillProgress = (): void => {
  if (sceneBuilder) fillProgress.value = sceneBuilder.getFillProgress()
}
const showFillProgress = delayedVisible(
  () => fillProgress.value.settled < fillProgress.value.queued
)
const showRenderLayerBuilding = delayedVisible(() => renderLayerBuilding.value)

let lastSeenFilePath: string | null | undefined = undefined
let lastSeenLoadId = -1

const displayOptions = (): BoardDisplayOptions => ({
  nonActiveDisplay: props.nonActiveDisplay,
  flipped: props.flipped,
  ...props.viewOptions,
  // Routing focus (KiCad's net dimming): once a trace is live — routed or
  // dragged — everything but its net's copper fades until the gesture ends,
  // and the highlighted net comes back after.
  highlightNet: focusNet()
})

const focusNet = (): number =>
  props.routeDraft?.tail ? props.routeDraft.net : props.trackDragNet || props.highlightedNet

// In flipped (view-from-back) mode the scene mirrors X; engine/world
// coordinates convert to board-data coordinates by negating X.
const worldToDataX = (x: number): number => (props.flipped ? -x : x)

/** A world length for `px` screen pixels at the current zoom. */
const pxToWorld = (px: number): number => {
  if (!engine) return 0
  const frustumWidth =
    engine.camera2D.right - engine.camera2D.left || viewportContainer.value?.clientWidth || 1
  return (px * frustumWidth) / (viewportContainer.value?.clientWidth || 1000)
}

interface RouteMagnet {
  point: { x: number; y: number }
  net: number
  /** Copper a trace terminates on — any same-net pad, via, or track. */
  isTarget: boolean
  /** A track's copper width (mm) when the magnet landed on one — what a
   *  route STARTED on it continues with (KiCad's continue-a-trace feel). */
  trackWidth?: number
  /** The copper's layers, those the pointer can reach — a route started on
   *  it goes on one of them (a track's own, an SMD pad's side). */
  layers: readonly string[]
}

/**
 * The connection point the route cursor magnetically prefers: the nearest
 * snap point (pad/via center, track end) of nearby copper, or the nearest
 * point ALONG a track's centerline — same-net only once a trace is in
 * progress, any net for the first click (which is how the trace inherits its
 * net at pad precision, and its width/layer at track precision). The
 * centerline candidates are what make "start anywhere on a wire" and "end
 * anywhere on a same-net wire" work, not just its endpoints. Data-space in
 * and out.
 */
/** Shift held turns snapping to copper off; the grid still applies (R31). */
let shiftHeld = false
const noteShift = (e: KeyboardEvent | MouseEvent): void => {
  shiftHeld = e.shiftKey
}

/** The grid point nearest a data-space point, or null with snap off. */
const gridPointOf = (p: { x: number; y: number }): { x: number; y: number } | null => {
  if (!engine || !props.gridSettings.snap) return null
  const world = engine.snapPoint(new THREE.Vector2(props.flipped ? -p.x : p.x, p.y))
  return { x: worldToDataX(world.x), y: world.y }
}

/**
 * The copper the cursor means to the route tool, and where on it the route
 * connects (lib/board/routeTarget.ts, router-behavior.md R28–R31). Mid-route
 * only the route's net on the routed layer counts.
 */
const routeMagnet = (
  dataPt: { x: number; y: number },
  skip?: ReadonlySet<string>
): RouteMagnet | null => {
  const idx = props.spatialIndex
  if (!idx || shiftHeld) return null
  // KiCad's pick distance: the grid step, from the copper's outline (R28).
  const reach = spacingToMm(props.gridSettings.spacing, props.gridSettings.unit)
  const routing = props.routeDraft?.tail ? props.routeDraft : null
  // A route with no net, in Highlight, may end on any net's copper (R1).
  const net =
    routing && !(routing.net === 0 && props.routeMode === 'highlight') ? routing.net : undefined
  const hits = idx
    .near(dataPt.x, dataPt.y, reach, net !== undefined ? { net } : {})
    .filter((hit) => !skip?.has(`${hit.item.ref.type}:${hit.item.ref.index}`))
  // The magnet obeys the same rule as the pointer: copper on a hidden or
  // dimmed-away layer neither starts nor ends a trace (the index knows
  // nothing about display state, so the scene answers). Net focus lifts
  // the dim restriction mid-route exactly as it lifts the fade.
  const target = routeTarget(hits, dataPt, {
    reach,
    ...(routing ? { layer: props.routeLayer } : {}),
    activeLayer: props.activeLayer,
    pointable: (item) =>
      sceneBuilder ? item.layers.filter((l) => sceneBuilder!.isLayerSelectable(l)) : item.layers,
    grid: gridPointOf
  })
  if (!target) return null
  const s = target.item.shape
  const type = target.item.ref.type
  return {
    point: target.point,
    net: target.item.net,
    isTarget: true,
    trackWidth:
      (type === 'segment' || type === 'tarc') && (s.kind === 'capsule' || s.kind === 'arc')
        ? s.halfWidth * 2
        : undefined,
    layers: target.layers
  }
}

/** Live cursor for the route preview (data space), magnet-adjusted. */
const routeCursor = ref<{ x: number; y: number } | null>(null)

/** A pushed via's preview carries its drill from the board. */
const movedViaPreview = (
  vias: ReadonlyArray<{ index: number; x: number; y: number; size: number }>
): Array<{ x: number; y: number; size: number; drill: number }> =>
  vias.map((v) => ({
    x: v.x,
    y: v.y,
    size: v.size,
    drill: props.board?.vias[v.index] ? nmToMm(props.board.vias[v.index].drill) : v.size / 2
  }))

let lastViolator: number | null = null
/** Only a change is news: the preview refreshes every mouse move. */
const reportViolator = (id: number | null): void => {
  if (id === lastViolator) return
  lastViolator = id
  emit('route-violator', id)
}
let lastState: RouteStateReport | null = null
const reportState = (report: RouteStateReport | null): void => {
  if (
    report?.state === lastState?.state &&
    report?.narrowerFails === lastState?.narrowerFails &&
    report?.nearViaPad === lastState?.nearViaPad &&
    report?.headLength === lastState?.headLength
  )
    return
  lastState = report
  emit('route-state', report)
}

/** How near a pad of the net on another layer the head comes before `V` is hinted (K1), mm. */
const VIA_HINT_REACH = 2

/** Half a violation mark's width on screen (F8). */
const MARK_HALF_PX = 1

/**
 * The routed net's ratsnest from the head (F7): the line to where it is headed,
 * and the rest of the net spanned from the route and the copper it left.
 */
const routeRatsnestLines = (
  draft: RouteDraft,
  head: readonly RoutePreviewSegment[],
  headEnd: { x: number; y: number }
): Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> => {
  const clusters = props.routeNetClusters
  if (!clusters) return []
  const joined: Array<{ x: number; y: number }> = [...draft.vias]
  for (const s of [...draft.segments, ...head]) {
    joined.push({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 })
  }
  const { lead, airwires } = routeRatsnest(clusters, joined, headEnd)
  return [...(lead ? [lead] : []), ...(clusters.airwires ? airwires : [])]
}

/** The board copper a route or drag violates, by index id: its own clearance outline gives way to the halo (F2). */
const violatedIds = shallowRef<ReadonlySet<number>>(new Set())

/** What the live route or drag violates, kept to redraw under a refusal's marks. */
let liveMarks: readonly ViolationMark[] = []

/** Mark what a route or drag violates (F2), and what a refusal did. */
const showViolations = (marks: readonly ViolationMark[]): void => {
  liveMarks = marks
  const all = props.refusalMarks?.length ? [...marks, ...props.refusalMarks] : marks
  sceneBuilder?.setViolationMarks(all, pxToWorld(MARK_HALF_PX))
  const ids = new Set(all.flatMap((m) => (m.id === undefined ? [] : [m.id])))
  const was = violatedIds.value
  if (ids.size !== was.size || [...ids].some((id) => !was.has(id))) violatedIds.value = ids
}

/** The clearance the route keeps, outlined round it as the display setting asks. */
const setRouteClearance = (
  segments: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; width: number }>,
  vias: ReadonlyArray<{ x: number; y: number; size: number }>
): void => {
  const shown = showsRouteClearance(props.viewOptions.trackClearance ?? 'never')
  const c = props.routeClearance
  sceneBuilder?.setPreviewClearance(
    'route',
    shown
      ? previewClearanceRings(
          segments.map((s) => ({ ...s, halfWidth: s.width / 2 + c })),
          vias.map((v) => ({ x: v.x, y: v.y, r: v.size / 2 + c })),
          props.clearanceRules?.maxError
        )
      : []
  )
}

const refreshRoutePreview = (): void => {
  if (!sceneBuilder || !engine) return
  const draft = props.activeTool === 'route' ? props.routeDraft : null
  if (!draft) {
    const startVia = props.activeTool === 'route' ? props.routeStartVia : null
    sceneBuilder.setRoutePreview(
      [],
      [],
      startVia && lastDataCursor ? [{ ...lastDataCursor, ...startVia }] : []
    )
    sceneBuilder.setRouteRatsnest([])
    setRouteClearance([], startVia && lastDataCursor ? [{ ...lastDataCursor, ...startVia }] : [])
    sceneBuilder.setShovePreview([], [])
    showViolations([])
    engine.setPreviewLayers(sceneBuilder.previewLayerSpecs())
    reportViolator(null)
    reportState(null)
    engine.render()
    return
  }
  const head: RoutePreviewSegment[] = []
  /** Where the head ends: an armed via rides it there. */
  let headEnd = draft.tail
  let viaViolation = false
  const proposal =
    draft.tail && routeCursor.value
      ? (props.routePreview?.propose(routeCursor.value) ?? null)
      : null
  if (proposal && props.routePreview) {
    // The same proposal the click commits: the route asks its session with
    // the request a click makes (docs/router-behavior.md R18).
    viaViolation = proposal.via?.violation ?? false
    headEnd = proposal.endsAt
    emit('route-posture', proposal.diagFirst)
    reportViolator(proposal.violatorIds[0] ?? proposal.huggingId ?? null)
    const end = proposal.endsAt
    reportState({
      state: proposal.state,
      narrowerFails: proposal.narrowerFails ?? false,
      nearViaPad: (props.routeViaPads ?? []).some(
        (p) => Math.hypot(p.x - end.x, p.y - end.y) <= VIA_HINT_REACH
      ),
      headLength: props.routeMeasureHead
        ? Math.round(chordsLength(proposal.segments) * 1000) / 1000
        : 0
    })
    const displaced = props.routePreview.displaced()
    // What landing here would make of the net's copper (R26, R27), drawn with
    // what the head pushed; only the pushed copper carries a clearance halo.
    const landing = props.routePreview.landed(proposal)
    sceneBuilder.setShovePreview(
      [...displaced.hiddenRefs, ...landing.hiddenRefs],
      [...displaced.segments, ...landing.segments],
      movedViaPreview(displaced.vias ?? []),
      showsRouteClearance(props.viewOptions.trackClearance ?? 'never')
        ? { clearance: props.routeClearance, segments: displaced.segments.length }
        : undefined
    )
    showViolations(proposal.marks)
    for (const s of chordsOf(proposal.segments)) {
      head.push({
        x0: s.x0,
        y0: s.y0,
        x1: s.x1,
        y1: s.y1,
        layer: props.routeLayer,
        width: props.routeWidth,
        violation: s.violation
      })
    }
  }
  const vias =
    draft.armedVia && headEnd
      ? [
          ...draft.vias,
          {
            x: headEnd.x,
            y: headEnd.y,
            size: draft.armedVia.size,
            drill: draft.armedVia.drill,
            violation: viaViolation
          }
        ]
      : draft.vias
  const placed = chordsOf(draft.segments)
  sceneBuilder.setRoutePreview(placed, head, vias)
  setRouteClearance([...placed, ...head], vias)
  sceneBuilder.setRouteRatsnest(headEnd ? routeRatsnestLines(draft, head, headEnd) : [])
  engine.setPreviewLayers(sceneBuilder.previewLayerSpecs())
  engine.render()
}

/**
 * Chrome floating over this canvas. The tool pill and the left view rail live
 * in `PcbEditor.vue` (they outlast the 2D/3D swap), so they are found from the
 * host area rather than from this component's own root.
 */
const BOARD_CHROME = ['.canvas-floating-toolbar', '.viewport-status-corner', '.fill-progress-pill']

// --- The agents' viewports on this board (lib/agentViewportView.ts): each
// box and its label are AgentViewportOverlay's. An agent's uncommitted route
// is never drawn here, only in the picture its call answers. The camera moves
// only when the person clicks a box's edge marker.
const agentViewports = computed(() => agentViewportsFor(props.filePath))

/** Board mm (y down) to the scene's space: y up, x mirrored while flipped. */
const agentFrameBox = (frame: ViewportFrame): THREE.Box3 => {
  const xs = props.flipped ? [-(frame.x + frame.width), -frame.x] : [frame.x, frame.x + frame.width]
  return new THREE.Box3(
    new THREE.Vector3(xs[0], -(frame.y + frame.height), 0),
    new THREE.Vector3(xs[1], -frame.y, 0)
  )
}

const agentView = agentViewportHandlers(
  () => engine,
  agentFrameBox,
  () => viewportContainer.value,
  BOARD_CHROME
)

/**
 * Ghost of the shape a graphics tool would place: the committed clicks plus
 * the live cursor, decomposed by the same pcbToolShape the commit runs, so
 * the preview and the inserted item cannot disagree. An unfinished polygon
 * (under three points) previews as its open edges via the line decomposition.
 */
const refreshDraftPreview = (cursor?: { x: number; y: number }): void => {
  if (!sceneBuilder || !engine) return
  if (!isGestureTool(props.activeTool) || props.toolDraft.length === 0) {
    sceneBuilder.setDraftPreview(null, 0, props.activeLayer)
    engine.render()
    return
  }
  // The draft is domain nm (y down); the cursor arrives in scene mm (y up).
  // The live point takes the line mode the click will (lib/lineMode.ts).
  const live = cursor ? { x: mmToNm(cursor.x), y: mmToNm(-cursor.y) } : null
  const pts = live
    ? [
        ...props.toolDraft,
        takesLineMode(props.activeTool)
          ? constrainChainPoint(props.routeCornerMode, props.toolDraft, live)
          : live
      ]
    : [...props.toolDraft]
  let shape = pcbToolShape(props.activeTool, pts)
  // An unfinished outline (under three points) previews as its open edges.
  if (!shape && (props.activeTool === 'polygon' || props.activeTool === 'zone')) {
    shape = pcbToolShape('line', pts)
  }
  sceneBuilder.setDraftPreview(
    shape ? previewToScene(shapePreviewPrimitives(shape)) : null,
    nmToMm(graphicDefaults(props.activeLayer).lineWidth),
    props.activeLayer
  )
  engine.render()
}

/** The held footprint, drawn once by the scene and carried to the snapped cursor. */
const refreshPlacementGhost = (): void => {
  if (!sceneBuilder || !engine) return
  sceneBuilder.setFootprintGhost(
    props.activeTool === 'footprint' ? (props.placementGhost ?? null) : null
  )
  sceneBuilder.moveFootprintGhost(lastDataCursor)
  engine.render()
}

/**
 * Ghost of a shape mid-handle-drag (domain nm). Cheap where a full scene
 * rebuild per mousemove is not; the real shape redraws on drop. Null clears.
 */
const showShapeGhost = (shape: PcbToolShape | null, layer: string): void => {
  if (!sceneBuilder || !engine) return
  sceneBuilder.setDraftPreview(
    shape ? previewToScene(shapePreviewPrimitives(shape)) : null,
    nmToMm(graphicDefaults(layer).lineWidth),
    layer
  )
  engine.render()
}

/**
 * The armed tool's coaching, only where the tool does not explain itself: a
 * click order you could not guess, or how to close a shape. "Click to place"
 * is what every tool does, and saying it is noise.
 */
const toolHint = computed<string>(() => {
  switch (props.activeTool) {
    case 'polygon':
      return props.toolDraft.length > 0 ? t('pcbEditor.viewport.polygonContinueHint') : ''
    case 'zone':
      return props.toolDraft.length > 0 ? t('pcbEditor.viewport.zoneContinueHint') : ''
    case 'arc':
      return t('pcbEditor.viewport.arcHint')
    case 'bezier':
      return t('pcbEditor.viewport.bezierHint')
  }
  return ''
})

/** Bottom-left is the armed tool's coaching line — transient, so it is kept
 *  clear of the coordinates it would otherwise push around. */
/**
 * How many of the operation's keys the hint shows (K1): its max, fewer where
 * the strip would run into the right corner's pills; `?` follows where any
 * were left out. Refit when the keys change and when the canvas resizes.
 */
const hintBar = ref<InstanceType<typeof ViewportStatusBar> | null>(null)
const coordsBar = ref<InstanceType<typeof ViewportStatusBar> | null>(null)
const hintRoom = ref(Infinity)
const HINT_GAP_PX = 12
const allHintKeys = computed(() => props.routeHintKeys ?? [])
const hintShown = computed(() =>
  Math.min(allHintKeys.value.length, props.routeHintMax ?? Infinity, hintRoom.value)
)
const hintOverflow = computed(() => hintShown.value < allHintKeys.value.length)
watch(hintOverflow, (overflow) => emit('hint-overflow', overflow), { immediate: true })
const routeKeys = computed(() => {
  const keys = allHintKeys.value.slice(0, hintShown.value)
  const more = hintOverflow.value && props.routeHintMore
  const all = more ? [...keys, more] : keys
  return all.length ? all : null
})
const hintCollides = (): boolean => {
  const left = hintBar.value?.$el
  const right = coordsBar.value?.$el
  if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return false
  return left.getBoundingClientRect().right + HINT_GAP_PX > right.getBoundingClientRect().left
}
let fitting = 0
const fitHint = async (): Promise<void> => {
  const run = ++fitting
  hintRoom.value = Infinity
  await nextTick()
  // Layout is read before the frame paints: the strip is never seen too wide.
  while (run === fitting && hintShown.value > 0 && hintCollides()) {
    hintRoom.value = hintShown.value - 1
    await nextTick()
  }
}
watch(
  () => `${allHintKeys.value.map((k) => k.text).join('|')}#${props.routeHintMax}`,
  () => void fitHint()
)
let hintResize: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !viewportContainer.value) return
  hintResize = new ResizeObserver(() => void fitHint())
  hintResize.observe(viewportContainer.value)
})
onUnmounted(() => {
  hintResize?.disconnect()
  hintResize = null
})
const hintText = computed(() => props.coaching || toolHint.value)
const hintItems = computed<StatusItem[]>(() => [
  // The highlighted net names itself, as KiCad's message panel does, beside the key that clears it.
  ...(props.highlightedNet && props.board
    ? [
        {
          id: 'net',
          text: t('shared.netHighlight.status'),
          value: getNetName(props.board, props.highlightedNet),
          accent: true,
          keys: [
            {
              caps: [hotkeyLabel('pcb.clearHighlight')],
              text: t('shared.netHighlight.clear')
            }
          ]
        }
      ]
    : []),
  ...(hintText.value || routeKeys.value
    ? [
        {
          id: 'hint',
          text: hintText.value,
          ...(routeKeys.value ? { keys: routeKeys.value } : {})
        }
      ]
    : [])
])

const { allows } = useSelectionFilter('pcb')
const appTheme = useAppTheme()

// Click, band, pointer and Select Other: one model for every 2D editor
// (lib/canvasSelection.ts). The board's scene ranks and sweeps; the policy
// and the user's filter resolve.

const selection = useCanvasSelection<BoardItemRef>({
  engine: () => engine,
  filterEditor: 'pcb',
  pointCandidates: (point, radius) => sceneBuilder?.hitCandidates(point, radius) ?? [],
  boxCandidates: (bounds, crossing) => sceneBuilder?.boxCandidates(bounds, crossing) ?? [],
  allows: () => allows.value,
  key: (ref) => `${ref.type}:${ref.index}:${ref.pad ?? ''}`,
  // The engine's click names a pad by its footprint only; the pad is the one
  // under the pointer, resolved again as the click was.
  fromEngine: (type, index) =>
    isFootprintChild(type)
      ? itemAtCursor((ref) => ref.type === type && ref.index === index)
      : { type, index },
  selected: () => props.selectedItems,
  select: (items) => emit('update:selectedItems', items),
  active: () => props.activeTool === 'select' && props.mode !== '3d'
})
const { itemAtCursor, selectOther } = selection

const labelBoardItem = (ref: BoardItemRef): string =>
  props.board ? boardItemLabel(props.board, ref, t) : ref.type

// Tool clicks are intercepted in the capture phase so the engine's own
// mousedown handler (selection / box select) never sees them.
/** A right click that puts a tool away or drops a drag is not asking for a menu. */
let menuBlocked = false

const onContainerContextMenu = (e: MouseEvent): void => {
  e.preventDefault()
  if (props.mode === '3d' || menuBlocked) return
  emit('context-menu', {
    clientX: e.clientX,
    clientY: e.clientY,
    hit: itemAtCursor(),
    point: engine
      ? { x: worldToDataX(engine.mouseWorld.x), y: engine.mouseWorld.y }
      : { x: 0, y: 0 }
  })
}

const markersLayer = findingMarkersLayer(
  toRef(props, 'findingMarkers'),
  (x, y) => ({ x: props.flipped ? -x : x, y: -y }),
  MARKER_UNIT_MM.board
)

const onContainerMouseDownCapture = (e: MouseEvent): void => {
  // Any button: a macOS Ctrl+click raises the menu event too.
  menuBlocked = props.trackDragging || props.activeTool !== 'select'
  if (props.mode === '3d') return
  // The middle button pans whatever is in hand.
  if (e.button === 1) return
  if (props.trackDragging) {
    e.stopPropagation()
    e.preventDefault()
    if (e.button === 0) emit('track-drag-commit', e.ctrlKey || e.metaKey)
    else if (e.button === 2) emit('gesture-menu', { clientX: e.clientX, clientY: e.clientY })
    return
  }
  if (props.activeTool === 'select' && e.button === 0 && !e.ctrlKey && !e.metaKey) {
    const key = markersLayer.hitAt(e)
    if (key) {
      e.stopPropagation()
      e.preventDefault()
      emit('finding-marker', key)
      return
    }
  }
  if (props.activeTool === 'select' || !engine || !sceneBuilder) return
  // Ctrl+click routes as a click does (KiCad's); elsewhere Ctrl+drag pans.
  const ctrlRoute = props.activeTool === 'route'
  if ((e.ctrlKey || e.metaKey) && e.button === 0 && !ctrlRoute) return // allow panning

  e.stopPropagation()
  e.preventDefault()

  if (e.button === 2) {
    if (props.activeTool === 'route')
      emit('gesture-menu', { clientX: e.clientX, clientY: e.clientY })
    else emit('tool-finish')
    return
  }
  if (e.button !== 0) return

  const threshold = engine.hitRadius()
  // hitTest takes world coordinates (it un-mirrors internally when flipped)
  const hit = sceneBuilder.hitTest(
    new THREE.Vector2(engine.mouseWorld.x, engine.mouseWorld.y),
    threshold
  )

  // The emitted points are data-space (board) coordinates
  const point = { x: worldToDataX(engine.mouseWorld.x), y: engine.mouseWorld.y }
  let snapped = { x: worldToDataX(engine.mouseSnapped.x), y: engine.mouseSnapped.y }
  let magnetNet: number | undefined
  let onNetTarget: boolean | undefined
  let magnetTrackWidth: number | undefined
  let magnetLayers: readonly string[] | undefined
  if (props.activeTool === 'route') {
    // The magnet outranks the grid: a route click lands on the connection
    // point it is visibly snapped to, not the grid intersection beside it.
    const magnet = routeMagnet(point)
    if (magnet) {
      snapped = magnet.point
      magnetNet = magnet.net
      magnetTrackWidth = magnet.trackWidth
      magnetLayers = magnet.layers
      onNetTarget =
        props.routeDraft !== null && magnet.isTarget && magnet.net === props.routeDraft.net
    }
  }
  emit('tool-click', {
    point,
    snapped,
    hit,
    magnetNet,
    onNetTarget,
    magnetTrackWidth,
    magnetLayers
  })
}

const onContainerDblClick = (e: MouseEvent): void => {
  if (props.mode === '3d') return
  if (props.activeTool === 'select') {
    emit('select-double-click')
    return
  }
  e.stopPropagation()
  e.preventDefault()
  emit('tool-finish')
}

/** Bumped to abandon a cooperative build that something newer superseded. */
let buildToken = 0
let buildInFlight = false

/**
 * Framing still owed to the current document. A load asks for 'restore'
 * framing, but the cooperative build that would deliver it can be cancelled
 * mid-yield (a view-option or theme watcher firing during the load) — the
 * superseding synchronous rebuild must then frame the board itself, or the
 * camera stays at the engine default and the board sits off-screen behind a
 * blank grid. While the debt is unpaid the camera state is meaningless, so
 * it must also never be saved as the file's remembered camera.
 */
let pendingCameraRestore = false

// Pay the framing debt: the file's remembered camera if it has one, else fit.
const applyRestoredCamera = (bounds: THREE.Box3): void => {
  if (!engine) return
  pendingCameraRestore = false
  const savedState = props.filePath ? loadCamera(props.filePath) : null
  if (savedState) {
    engine.setCameraState2D(savedState)
    // A remembered camera IS the user's frame — they left the board at it —
    // so a cross-select arriving on it preserves it (ViewportEngine
    // `viewFramedByUser`). A plain fit is the engine's own and is not kept.
    engine.markViewFramedByUser()
    engine.render()
  } else {
    engine.clearUserFramedView()
    engine.zoomToFit(bounds)
  }
}

/**
 * Abandon an in-flight cooperative build. Every synchronous rebuild path
 * below clears and rewrites the whole scene, so a build still feeding the
 * old one has to be voted off first — and the bar it was reporting to
 * settled, since nothing else will settle it.
 */
const cancelBuild = (): void => {
  if (!buildInFlight) return
  buildToken++
  buildInFlight = false
  emit('build-progress', null)
}

/**
 * Build a newly loaded board's scene a frame-budget slice at a time. On a
 * dense board this is half a second of geometry, glyph rasterization and
 * batch sorting: run in one task it lands as a freeze under a load bar that
 * cannot repaint, so it is yielded instead and reported as that bar's tail.
 */
const buildBoardScene = async (board: KicadBoard, camera: 'restore' | 'keep'): Promise<void> => {
  if (!sceneBuilder || !engine) return
  const scene = sceneBuilder
  const eng = engine
  const token = ++buildToken
  buildInFlight = true
  if (camera === 'restore') pendingCameraRestore = true
  emit('build-progress', 0)

  const steps = scene.rebuildSteps(
    board,
    props.layerVisibility,
    props.activeLayer,
    displayOptions()
  )
  let sliceStart = performance.now()
  let step = steps.next()
  while (!step.done) {
    emit('build-progress', step.value)
    if (performance.now() - sliceStart > FRAME_BUDGET_MS) {
      await yieldControl()
      if (token !== buildToken) return
      sliceStart = performance.now()
    }
    step = steps.next()
  }

  scene.highlightSelection(props.selectedItems)
  scene.resumeDrag()
  scene.renderVertexHandles(props.selectedItems)
  scene.setRatsnest(props.airwires)
  refreshFillProgress()
  if (camera === 'restore' || pendingCameraRestore) {
    applyRestoredCamera(step.value)
  } else {
    eng.render()
  }
  buildInFlight = false

  // Only lift the bar once the board has actually reached the screen.
  await afterPaint()
  if (token !== buildToken) return
  // bin/board-timing's "board shown" (docs/performance-workstream.md).
  performance.mark('board:shown')
  emit('build-progress', null)
}

// Zoom to fit the whole board; middle-double-click (engine.onResetView) and
// the editor's fit hotkey both land here.
const zoomToFit = (): void => {
  if (!props.board || !sceneBuilder || !engine) return
  cancelBuild()
  const bounds = sceneBuilder.rebuild(
    props.board,
    props.layerVisibility,
    props.activeLayer,
    displayOptions()
  )
  sceneBuilder.highlightSelection(props.selectedItems)
  sceneBuilder.resumeDrag()
  refreshFillProgress()
  pendingCameraRestore = false
  engine.zoomToFit(bounds)
  // Asked for by the user, so it is their frame: a cross-select arriving on a
  // whole-board fit someone chose leaves it alone.
  engine.markViewFramedByUser()
}

/** A cross-selected part is brought into view with room around it, never
 *  zoomed until it fills the pane. Only reached on the fit branch below. */
const FOCUS_MIN_EXTENT_MM = 30

/**
 * Reveal these footprints: select-in-place if they are already in sight, pan if
 * not, zoom out only if they cannot fit (`lib/engine/bringIntoView.ts`). Bounds
 * are in data space; the scene mirrors X when flipped.
 */
const focusFootprints = (indices: number[]): void => {
  if (!engine || !sceneBuilder) return
  const box = new THREE.Box3()
  for (const index of indices) {
    const bounds = sceneBuilder.getFootprintBounds(index)
    if (!bounds) continue
    const minX = props.flipped ? -bounds.maxX : bounds.minX
    const maxX = props.flipped ? -bounds.minX : bounds.maxX
    box.expandByPoint(new THREE.Vector3(minX, bounds.minY, 0))
    box.expandByPoint(new THREE.Vector3(maxX, bounds.maxY, 0))
  }
  if (box.isEmpty()) return

  engine.bringIntoView(box, {
    insets: measureViewportInsets(
      viewportContainer.value,
      BOARD_CHROME,
      viewportContainer.value?.closest<HTMLElement>('.viewport-host-area')
    ),
    minExtent: FOCUS_MIN_EXTENT_MM
  })
}

/** Smallest extent a located finding frames, mm: a lone via is not blown up to fill the view. */
const FINDING_MIN_EXTENT_MM = 8

/** Zoom in / out, center on cursor, zoom to selection (`lib/viewCommands.ts`). */
const runViewCommand = (command: ViewCommand): void => {
  if (!engine) return
  if (command === 'zoomIn' || command === 'zoomOut') engine.zoomStep(command === 'zoomIn' ? 1 : -1)
  else if (command === 'centerOnCursor') engine.centerOnCursor()
  else if (sceneBuilder)
    engine.frameBounds(sceneBuilder.selectionBounds(props.selectedItems), FINDING_MIN_EXTENT_MM)
}

/** Bring the selection into view as a reveal does: a find hit, say. */
const revealSelection = (): void => {
  if (!engine || !sceneBuilder) return
  const bounds = sceneBuilder.selectionBounds(props.selectedItems)
  if (bounds.isEmpty()) return
  engine.bringIntoView(bounds, {
    insets: measureViewportInsets(
      viewportContainer.value,
      BOARD_CHROME,
      viewportContainer.value?.closest<HTMLElement>('.viewport-host-area')
    ),
    minExtent: FINDING_MIN_EXTENT_MM
  })
}

/**
 * Reveal a point in board space (mm, y down): a finding's position. The
 * marker is the whole story, so a small window around it is framed the way
 * a cross-selected footprint is.
 */
const focusPoint = (x: number, y: number): void => {
  if (!engine) return
  const sx = props.flipped ? -x : x
  const sy = -y
  const half = FINDING_MIN_EXTENT_MM / 2
  engine.bringIntoView(
    new THREE.Box3(
      new THREE.Vector3(sx - half, sy - half, 0),
      new THREE.Vector3(sx + half, sy + half, 0)
    ),
    {
      insets: measureViewportInsets(
        viewportContainer.value,
        BOARD_CHROME,
        viewportContainer.value?.closest<HTMLElement>('.viewport-host-area')
      ),
      minExtent: FINDING_MIN_EXTENT_MM
    }
  )
}

/** A picked finding at a board point (mm, y down): centered, or with `zoom`, framed close. */
const showFinding = (x: number, y: number, zoom: boolean): void =>
  engine?.showPoint(props.flipped ? -x : x, -y, zoom, FINDING_MIN_EXTENT_MM)

// --- Automation bridge provider (see lib/testHooks.ts) ---------------------
// Board coords are KiCad space (y down); the scene mirrors that to y-up and
// (when flipped) mirrors X, so convert before projecting through the engine.
const boardToScene = (x: number, y: number): { x: number; y: number } => ({
  x: props.flipped ? -x : x,
  y: -y
})

const projectSceneRect = (b: {
  minX: number
  minY: number
  maxX: number
  maxY: number
}): { x: number; y: number; width: number; height: number } | null => {
  if (!engine) return null
  const pts = [
    engine.worldToScreen(b.minX, b.minY),
    engine.worldToScreen(b.maxX, b.minY),
    engine.worldToScreen(b.minX, b.maxY),
    engine.worldToScreen(b.maxX, b.maxY)
  ]
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

const listTestElements = (type?: string): TestElement[] => {
  // Footprints by default; pads and segments only when asked for by type, there being thousands.
  if (!props.board || !sceneBuilder || !engine) return []
  if (type === 'pad') return listTestPads()
  if (type === 'segment') return listTestSegments()
  if (type && type !== 'footprint') return []
  return props.board.footprints.map((fp, index) => {
    const bounds = sceneBuilder!.getFootprintBounds(index)
    const screenRect = bounds ? projectSceneRect(bounds) : null
    const screenCenter = screenRect
      ? { x: screenRect.x + screenRect.width / 2, y: screenRect.y + screenRect.height / 2 }
      : null
    return {
      type: 'footprint',
      index,
      ref: fp.reference,
      value: fp.value,
      uuid: fp.uuid,
      layer: fp.layer,
      world: { x: fp.position.x, y: fp.position.y },
      screenRect,
      screenCenter
    }
  })
}

/**
 * Every track segment at its midpoint, `value` its net number, `screenRect`
 * the box its two ends span: where a click selects it.
 */
const listTestSegments = (): TestElement[] =>
  props.board!.segments.map((seg, index) => {
    const at = (p: { x: Nm; y: Nm }): { x: number; y: number } =>
      engine!.worldToScreen((props.flipped ? -1 : 1) * nmToMm(p.x), -nmToMm(p.y))
    const a = at(seg.start)
    const b = at(seg.end)
    return {
      type: 'segment',
      index,
      ref: seg.uuid ?? '',
      value: String(seg.net),
      layer: seg.layer,
      world: { x: (seg.start.x + seg.end.x) / 2, y: (seg.start.y + seg.end.y) / 2 },
      screenRect: {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y)
      },
      screenCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
  })

/** Every pad at its center, `value` its net: where a route starts (bin/board-timing). */
const listTestPads = (): TestElement[] =>
  props.board!.footprints.flatMap((fp, index) => {
    const tf = footprintTransform(fp)
    return fp.footprint.pads.map((pad) => {
      const at = tfPoint(tf, pad.position.x, pad.position.y)
      const screenCenter = engine!.worldToScreen(props.flipped ? -at.x : at.x, at.y)
      return {
        type: 'pad',
        index,
        ref: `${fp.reference}.${pad.number}`,
        value: pad.net?.name,
        layer: fp.layer,
        world: { x: mmToNm(at.x), y: mmToNm(-at.y) },
        screenRect: null,
        screenCenter
      }
    })
  })

const buildTestProvider = (): TestProvider => ({
  kind: 'pcb',
  worldToScreen: (x: number, y: number): { x: number; y: number } | null => {
    if (!engine) return null
    const s = boardToScene(x, y)
    return engine.worldToScreen(s.x, s.y)
  },
  listElements: listTestElements,
  getElement: (query: TestElementQuery): TestElement | null =>
    listTestElements(query.type).find(
      (e) =>
        (query.uuid !== undefined && e.uuid === query.uuid) ||
        (query.ref !== undefined && e.ref === query.ref) ||
        (query.index !== undefined &&
          e.index === query.index &&
          (query.type === undefined || e.type === query.type))
    ) ?? null
})

onMounted(() => {
  if (!viewportContainer.value) return
  window.addEventListener('keydown', noteShift, true)
  window.addEventListener('keyup', noteShift, true)
  window.addEventListener('pointermove', noteShift, true)

  engine = new ViewportEngine(viewportContainer.value)
  engine.setSnapCrosshair(true)
  applyPresentation()
  // A viewport can mount with a tool already armed (a tab switch keeps the
  // editor's tool state), so the pointer is set here as well as on change.
  applyDrawMode()
  sceneBuilder = new BoardScene(engine.scene)
  sceneBuilder.setClearanceOutlines(boardOutlineList.value, 'board')
  sceneBuilder.setClearanceOutlines(selectedOutlineList.value, 'selected')
  // Vertex handles keep a constant on-screen size across zoom.
  for (const target of sceneBuilder.screenScaledTargets()) engine.registerScreenScaled(target)
  markersLayer.install(engine)
  engine.setCompositeLayers(sceneBuilder.compositeLayers())
  sceneBuilder.applyTheme(appTheme.value)
  // Deferred zone fills land as worker results after first paint. The repaint
  // is coalesced to one render per animation frame, never one per result: on a
  // dense board hundreds of fills stream in, and wherever a full render is
  // expensive (software GL, weak GPUs) per-result renders queue the worker's
  // messages behind themselves and freeze the thread for the whole stream.
  sceneBuilder.setDeferredGeometryCallback(() => {
    refreshFillProgress()
    if (fillRenderScheduled) return
    fillRenderScheduled = true
    requestAnimationFrame(() => {
      fillRenderScheduled = false
      engine?.render()
    })
  })

  engine.setGridSettings(props.gridSettings)
  // One step dimmer than the standard grid so it doesn't compete with copper.
  engine.setGridAppearance({
    ...STANDARD_GRID_APPEARANCE,
    gridOpacity: 0.3,
    axisOpacity: 0.2,
    originOpacity: 0.15
  })
  engine.applyTheme()

  // Selection resolves through the editor's policy and the user's filter; an
  // armed tool (above, `onContainerMouseDownCapture`) deliberately does NOT —
  // it asks its own question of the same geometry, and routing to a via must
  // keep working whether or not vias are selectable right now.
  engine.setCustomHitTest((point, threshold) => {
    if (!sceneBuilder) return null
    const hit = resolveHit(sceneBuilder.hitCandidates(point, threshold), allows.value)
    // A pad is selected under its paint key, which `type:index` cannot spell.
    return hit ? { ...hit, key: boardRefKey(hit) } : null
  })

  // A click past the filter's hits must not land on a fill's mesh instead.
  engine.setRaycastFilter(
    (type, index) => !!sceneBuilder && sceneBuilder.raycastSelectable(type, index, allows.value)
  )

  engine.setSelectedKeys(new Set(props.selectedItems.map(boardRefKey)))
  selection.install(engine)

  engine.onMouseMoveCoords((worldPos, snappedPos) => {
    // Board (data) coordinates, so X mirrors back when the view is flipped and
    // Y negates — a readout states FILE coordinates. It is the point the editor
    // would ACT on: snapped while snap is on, the raw cursor otherwise.
    const point = props.gridSettings.snap ? snappedPos : worldPos
    cursor.value = { x: worldToDataX(point.x), y: -point.y }

    lastDataCursor = { x: worldToDataX(snappedPos.x), y: snappedPos.y }
    lastSnappedWorld = { x: snappedPos.x, y: snappedPos.y }
    placeTuneMeter()
    if (props.trackDragging) {
      emit('track-drag-move', lastDataCursor)
    }

    if (props.activeTool === 'route' && !props.routeDraft && props.routeStartVia) {
      refreshRoutePreview()
    }
    // Rubber-band the route preview to the (magnet-adjusted) cursor
    if (props.activeTool === 'route' && props.routeDraft?.tail) {
      const dataPt = { x: worldToDataX(snappedPos.x), y: snappedPos.y }
      const magnet = routeMagnet({ x: worldToDataX(worldPos.x), y: worldPos.y })
      routeCursor.value = magnet?.point ?? dataPt
      refreshRoutePreview()
    }
    if (isGestureTool(props.activeTool) && props.toolDraft.length > 0) {
      refreshDraftPreview({ x: worldToDataX(snappedPos.x), y: snappedPos.y })
    }
    if (props.activeTool === 'footprint' && props.placementGhost) {
      sceneBuilder?.moveFootprintGhost(lastDataCursor)
      engine?.render()
    }
  })

  // A pad moves its footprint, which grabs by its origin or any pad.
  engine.onDragAnchors(() => sceneBuilder?.moveAnchors(promotePads(props.selectedItems)) ?? [])
  engine.onDragTargets(() => sceneBuilder?.snapTargets(promotePads(props.selectedItems)) ?? [])
  engine.onDragStart((type, info) => {
    if (props.activeTool !== 'select') return
    emit('drag-start', type, info)
  })
  engine.onDragMove((delta) => {
    if (props.activeTool !== 'select') return
    emit('drag-move', { x: worldToDataX(delta.x), y: delta.y })
  })
  engine.onDragEnd(() => {
    if (props.activeTool !== 'select') return
    emit('drag-end')
  })

  engine.onResetView(() => {
    if (engine?.mode === '3d') fit3D()
    else zoomToFit()
  })
  // Remembered as the user moves, not only when the viewport goes away: a
  // window that closes takes its components with it without unmounting them.
  engine.onViewChanged(() => {
    if (props.filePath && !pendingCameraRestore && engine) {
      saveCamera(props.filePath, engine.getCameraState2D())
    }
  })
  engine.setSnapOverride(snapProvider())

  viewportContainer.value.addEventListener('mousedown', onContainerMouseDownCapture, true)
  viewportContainer.value.addEventListener('dblclick', onContainerDblClick, true)
  viewportContainer.value.addEventListener('contextmenu', onContainerContextMenu)
  viewportContainer.value.addEventListener('mouseenter', onContainerMouseEnter)
  viewportContainer.value.addEventListener('mouseleave', onContainerMouseLeave)

  lastSeenFilePath = props.filePath
  lastSeenLoadId = props.loadId
  physicalRender = new BoardRenderLayer(
    engine,
    (busy) => (renderLayerBuilding.value = busy),
    modelCache
  )
  syncRenderLayer()
  syncOrigins()
  engine.render()
  if (props.board) void buildBoardScene(props.board, 'restore')

  // Automation bridge (harness only): let a runner project board points to
  // pixels and locate footprints by reference, instead of pixel-hunting a canvas
  // whose elements have no DOM. Registered only under GOATCAD_TEST_HOOKS.
  if (window.api?.testHooks) {
    disposeTestProvider = registerTestProvider(buildTestProvider())
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', noteShift, true)
  window.removeEventListener('keyup', noteShift, true)
  window.removeEventListener('pointermove', noteShift, true)
  cancelBuild()
  disposeTestProvider?.()
  disposeTestProvider = null
  viewportContainer.value?.removeEventListener('mousedown', onContainerMouseDownCapture, true)
  viewportContainer.value?.removeEventListener('mouseenter', onContainerMouseEnter)
  viewportContainer.value?.removeEventListener('mouseleave', onContainerMouseLeave)
  viewportContainer.value?.removeEventListener('dblclick', onContainerDblClick, true)
  viewportContainer.value?.removeEventListener('contextmenu', onContainerContextMenu)
  physicalRender?.dispose()
  physicalRender = null
  modelCache.dispose()
  if (engine) {
    if (lastSeenFilePath && !pendingCameraRestore) {
      saveCamera(lastSeenFilePath, engine.getCameraState2D())
    }
    markersLayer.dispose()
    sceneBuilder?.dispose()
    engine.destroy()
    engine = null
    sceneBuilder = null
  }
})

let lastAppliedDeltaId = -1
let editRebuildScheduled = false
const scheduleEditRebuild = (): void => {
  if (editRebuildScheduled) return
  editRebuildScheduled = true
  requestAnimationFrame(() => {
    editRebuildScheduled = false
    rebuildScene()
  })
}

const rebuildScene = (): void => {
  if (props.board && sceneBuilder && engine) {
    cancelBuild()
    const bounds = sceneBuilder.rebuild(
      props.board,
      props.layerVisibility,
      props.activeLayer,
      displayOptions()
    )
    sceneBuilder.highlightSelection(props.selectedItems)
    sceneBuilder.resumeDrag()
    sceneBuilder.renderVertexHandles(props.selectedItems)
    refreshFillProgress()
    if (pendingCameraRestore) {
      applyRestoredCamera(bounds)
    } else {
      engine.render()
    }
  }
}

/**
 * Hand the render layer the current inputs. Cheap and idempotent — it decides
 * for itself whether anything is owed, and while the layer is off a changed
 * board only marks a debt it will pay when the layer is next switched on.
 */
const syncRenderLayer = (): void => {
  if (!physicalRender) return
  physicalRender.setSources({
    board: props.board,
    filePath: props.filePath ?? null,
    projectDir: props.projectPath ? dirnameOf(props.projectPath) : null,
    flipped: props.flipped,
    nonActiveDisplay: props.nonActiveDisplay,
    options: board3dOptions.value
  })
  const preview = props.mode === '3d'
  const entering3D = preview && engine?.mode === '2d' && !entering3DPending
  const leaving3D = !preview && engine?.mode === '3d'
  if (entering3D) {
    entering3DPending = true
    engine?.prepareModeTransition()
  } else if (leaving3D) {
    modeEntryToken++
    entering3DPending = false
    engine?.prepareModeTransition()
    engine?.exit3D()
  } else if (!preview && engine?.mode === '2d') {
    modeEntryToken++
    entering3DPending = false
    engine.cancelModeTransition()
  }
  physicalRender.setPresentation(preview ? '3d' : 'assembly')
  physicalRender.setOpacity(preview ? 1 : props.renderLayerOpacity)
  physicalRender.setEnabled(preview || props.renderLayer)
  if (engine) {
    if (entering3D) {
      const layer = physicalRender
      const token = ++modeEntryToken
      const enterWhenReady = (): void => {
        if (token !== modeEntryToken || props.mode !== '3d' || !engine) return
        const bounds = layer.getBounds()
        if (!bounds) {
          requestAnimationFrame(enterWhenReady)
          return
        }
        entering3DPending = false
        if (engine.mode !== '3d') engine.enter3D(bounds)
      }
      requestAnimationFrame(enterWhenReady)
    }
  }
}

watch(
  [
    () => props.renderLayer,
    () => props.renderLayerOpacity,
    () => props.mode,
    () => props.board,
    () => props.flipped,
    () => props.nonActiveDisplay,
    () => props.filePath,
    () => props.projectPath,
    board3dOptions
  ],
  syncRenderLayer
)

watch(
  [() => props.board, () => props.filePath, () => props.projectPath],
  ([board]) => {
    modelCache.cancelWarm()
    if (!board) return
    void modelCache.warm(
      board,
      props.filePath ?? null,
      props.projectPath ? dirnameOf(props.projectPath) : null
    )
  },
  { immediate: true }
)

const fit3D = (): void => engine?.fitView3D(physicalRender?.getBounds() ?? null)
/** The pane in device pixels, and the 3D view drawn to a canvas (Export image). */
const view3DSize = (): PixelSize | null => engine?.drawingBufferSize() ?? null
const export3DImage = (size: PixelSize): HTMLCanvasElement | null =>
  engine ? exportBoard3DView(engine, size, board3dLook.value.background) : null
const set3DView = (preset: 'iso' | 'top' | 'bottom' | 'front'): void =>
  engine?.setView3D(preset, physicalRender?.getBounds() ?? null)
// The pointer says which mode the editor is in — pick, or place — and routing
// draws copper, so it takes the pencil rather than the pick crosshair. One
// engine call, so every editor answers it the same way (ARCHITECTURE, DESIGN.md).
// In 3D the pointer orbits rather than places, so no tool arms it.
const applyDrawMode = (): void => {
  const tool = props.activeTool
  const armed = props.mode === 'layout' && tool !== 'select'
  engine?.setDrawMode(armed, armed && tool === 'route' ? drawCursor : undefined)
}

watch([() => props.activeTool, () => props.mode], applyDrawMode)

watch(
  () => props.refusalMarks,
  () => {
    if (!sceneBuilder || !engine) return
    showViolations(liveMarks)
    engine.render()
  }
)

watch(
  () => props.board,
  (newBoard) => {
    if (!newBoard || !sceneBuilder || !engine) return
    if (lastSeenFilePath && !pendingCameraRestore) {
      saveCamera(lastSeenFilePath, engine.getCameraState2D())
    }
    // An edit command hands over a remapped board for a scene the user is
    // looking at. First choice: patch the scene in place from the command's
    // delta — the committed copper is on screen the same frame, no rebuild.
    // Anything the incremental path can't attribute (graphics edits, zone
    // adds/removes, undo/redo which carries no delta, a scene mid-build)
    // falls back to a whole rebuild on the next animation frame — rAF runs
    // before paint, so the stale scene is never shown; the command's task
    // just ends first and input interleaves.
    if (props.loadId === lastSeenLoadId) {
      const delta = props.editDelta
      if (
        !buildInFlight &&
        sceneBuilder &&
        engine &&
        delta &&
        delta.id !== lastAppliedDeltaId &&
        sceneBuilder.applyBoardEdit(delta, newBoard)
      ) {
        lastAppliedDeltaId = delta.id
        sceneBuilder.highlightSelection(props.selectedItems)
        sceneBuilder.resumeDrag()
        sceneBuilder.renderVertexHandles(props.selectedItems)
        refreshFillProgress()
        engine.render()
      } else {
        scheduleEditRebuild()
      }
      return
    }
    lastSeenLoadId = props.loadId
    // A different file frames itself; the same file re-parsed (a source-view
    // edit, an external reload) keeps the camera the user left it at.
    const camera = props.filePath !== lastSeenFilePath ? 'restore' : 'keep'
    lastSeenFilePath = props.filePath
    void buildBoardScene(newBoard, camera)
  }
)

/**
 * The board's two origins onto the canvas: the grid is measured from its
 * origin (snap and dots alike), and the drill / place file origin carries its
 * mark. The file is y down and the view may be mirrored; the engine takes
 * world points, the scene board ones.
 */
const syncOrigins = (): void => {
  if (!engine || !sceneBuilder) return
  const grid = props.board?.gridOrigin
  engine.setGridOrigin(
    grid ? (props.flipped ? -1 : 1) * nmToMm(grid.x) : 0,
    grid ? -nmToMm(grid.y) : 0
  )
  const drill = props.board?.auxOrigin
  sceneBuilder.setDrillOrigin(drill ? { x: nmToMm(drill.x), y: -nmToMm(drill.y) } : null)
  engine.render()
}
watch([() => props.board, () => props.flipped], syncOrigins)

/**
 * The active layer, which layers show, the non-active display and net focus
 * are the view, not the board: applied to the built scene, never a rebuild
 * (ARCHITECTURE.md, View state is applied, not built).
 */
const applyView = (): void => {
  if (!sceneBuilder || !engine) return
  sceneBuilder.applyView({
    activeLayer: props.activeLayer,
    layerVisibility: props.layerVisibility,
    nonActiveDisplay: props.nonActiveDisplay,
    focusNet: displayOptions().highlightNet
  })
  engine.render()
}
watch(() => props.layerVisibility, applyView, { deep: true })
watch(() => props.activeLayer, applyView)
watch(() => props.nonActiveDisplay, applyView)
// Only the derived net matters — per-click routeDraft churn must not apply.
watch(focusNet, applyView)
watch(() => props.viewOptions, rebuildScene, { deep: true })
watch(appTheme, (theme) => {
  engine?.applyTheme()
  sceneBuilder?.applyTheme(theme)
  rebuildScene()
})

watch(() => props.flipped, markersLayer.refresh)
watch(
  () => props.flipped,
  () => {
    // Keep the board under the camera when the view mirrors about x = 0
    if (engine) {
      const state = engine.getCameraState2D()
      engine.setCameraState2D({ ...state, x: -state.x })
    }
    rebuildScene()
  }
)

watch(
  () => props.selectedItems,
  (newItems) => {
    if (sceneBuilder && engine) {
      sceneBuilder.highlightSelection(newItems)
      sceneBuilder.renderVertexHandles(newItems)
      engine.setSelectedKeys(new Set(newItems.map(boardRefKey)))
      engine.render()
    }
  },
  { deep: true }
)

watch(
  () => props.gridSettings,
  (newSettings) => {
    engine?.setGridSettings(newSettings)
  },
  { deep: true }
)

watch(
  () => [
    props.activeTool,
    props.routeDraft,
    props.routeWidth,
    props.routeLayer,
    props.routeCornerMode,
    props.routeDiagFirst,
    props.routeMode,
    props.routeStartVia
  ],
  () => {
    if (!props.routeDraft) routeCursor.value = null
    refreshRoutePreview()
  },
  { deep: true }
)

watch(
  () => [props.activeTool, props.toolDraft, props.activeLayer],
  () => refreshDraftPreview(),
  { deep: true }
)

watch(() => [props.activeTool, props.placementGhost] as const, refreshPlacementGhost)

/**
 * KiCad's wire-tool reading: while routing, the crosshair itself snaps to
 * the nearest pad/track-end, not just the click (workstream §6.7c). The
 * engine's snap override feeds the crosshair, the coordinate readout, and
 * the click's snapped point from ONE source, so the cursor shown is exactly
 * the point a click lands on. Off copper, mid-route, the grid point is held
 * to the route start's axes (R47).
 */
const routeSnapProvider = (world: { x: number; y: number }): { x: number; y: number } | null => {
  const data = { x: worldToDataX(world.x), y: world.y }
  const magnet = routeMagnet(data)
  const start = props.routeDraft?.tail ? props.routeDraft.start : null
  const grid = !magnet && start ? gridPointOf(data) : null
  const p = magnet ? magnet.point : grid ? alignToStartAxes(data, grid, start) : null
  return p ? { x: worldToDataX(p.x), y: p.y } : null
}

/**
 * A track drag's cursor snaps to copper as KiCad's router drag does (pads,
 * vias, track ends), the copper being dragged aside — none until the drag has
 * said which that is.
 */
const dragSnapProvider = (world: { x: number; y: number }): { x: number; y: number } | null => {
  const dragged = props.trackDragPreview?.hiddenRefs ?? []
  if (!dragged.length) return null
  const magnet = routeMagnet(
    { x: worldToDataX(world.x), y: world.y },
    new Set(dragged.map((ref) => `${ref.type}:${ref.index}`))
  )
  return magnet ? { x: worldToDataX(magnet.point.x), y: magnet.point.y } : null
}

// The tuner shares the drag's mode but not its net: it keeps the grid.
const snapProvider = (): typeof routeSnapProvider | null =>
  props.activeTool === 'route'
    ? routeSnapProvider
    : props.trackDragging && props.trackDragNet
      ? dragSnapProvider
      : null

watch([() => props.activeTool, () => props.trackDragging, () => props.trackDragNet], () =>
  engine?.setSnapOverride(snapProvider())
)

watch(
  () => props.trackDragPreview,
  (preview) => {
    if (!sceneBuilder || !engine) return
    const band = preview?.clearance
    sceneBuilder.setShovePreview(
      preview?.hiddenRefs ?? [],
      preview?.segments ?? [],
      movedViaPreview(preview?.vias ?? []),
      band && showsDragClearance(props.viewOptions.trackClearance ?? 'never')
        ? { clearance: band.mm, segments: band.from, vias: band.viaFrom }
        : undefined
    )
    showViolations(preview?.marks ?? [])
    engine.setPreviewLayers(sceneBuilder.previewLayerSpecs())
    sceneBuilder.setPreviewClearance(
      'drag',
      band && showsDragClearance(props.viewOptions.trackClearance ?? 'never')
        ? previewClearanceRings(
            preview.segments
              .slice(band.from)
              .map((s) => ({ ...s, halfWidth: s.width / 2 + band.mm })),
            (preview.vias ?? [])
              .slice(band.viaFrom ?? Infinity)
              .map((v) => ({ x: v.x, y: v.y, r: v.size / 2 + band.mm })),
            props.clearanceRules?.maxError
          )
        : []
    )
    engine.render()
  }
)

/**
 * Pads (and, shown always, tracks and vias) outlined at their own clearance on
 * the active layer, and a selected item on every visible copper layer: KiCad's
 * clearance outlines, as Settings ▸ Board editor sets them.
 */
/** What a move drag is carrying, so its clearance outlines travel with it. */
const dragged = shallowRef<readonly BoardItemRef[]>([])

/**
 * What the clearance outlines are drawn from, but for the selection: so the
 * board's outlines (every outlined item on the active layer) are worked out
 * again only when this changes, never on a click.
 */
const outlineQuery = computed(() => {
  const idx = props.spatialIndex
  const rules = props.clearanceRules
  const pads = props.viewOptions.padClearance ?? false
  const tracks = props.viewOptions.trackClearance === 'always'
  if (!idx || !rules || (!pads && !tracks)) return null
  const visible = (layer: string): boolean => props.layerVisibility[layer] !== false
  const active = props.activeLayer
  const violated = violatedIds.value
  const draggedKeys = new Set(dragged.value.map(boardRefKey))
  const moving = (item: CopperItem): boolean => {
    const ref = item.ref
    if (ref.type === 'pad')
      return (
        draggedKeys.has(`footprint:${ref.index}`) ||
        draggedKeys.has(boardRefKey({ type: 'pad', index: ref.index, pad: ref.pad }))
      )
    return draggedKeys.has(`${ref.type}:${ref.index}`)
  }
  return {
    items: idx.items,
    query: {
      layer: isCopperLayer(active) && visible(active) ? active : null,
      visibleLayers: new Set(
        Object.keys(props.layerVisibility).filter((l) => isCopperLayer(l) && visible(l))
      ),
      pads,
      tracks,
      clearanceOf: clearanceOf.value,
      ...(draggedKeys.size > 0 ? { moving } : {}),
      hidden: (item: CopperItem) => violated.has(item.id),
      maxError: rules.maxError
    }
  }
})

/** The board's outlines: every outlined item on the active layer, selected or not. */
const boardOutlineList = computed(() => {
  const q = outlineQuery.value
  return q ? clearanceOutlines(q.items, { ...q.query, selected: () => false }) : []
})

/**
 * The selection's outlines: selected copper on the visible layers other than
 * the active one, as KiCad shows them. On the active layer the board's set
 * already draws it, merged with the rest of its net.
 */
const selectedOutlineList = computed(() => {
  const q = outlineQuery.value
  if (!q || props.selectedItems.length === 0) return []
  const footprints = new Set<number>()
  const keys = new Set<string>()
  for (const ref of props.selectedItems) {
    if (ref.type === 'footprint') footprints.add(ref.index)
    else keys.add(ref.type === 'pad' ? `pad:${ref.index}:${ref.pad}` : `${ref.type}:${ref.index}`)
  }
  const selected = q.items.filter(({ ref }) =>
    ref.type === 'pad'
      ? footprints.has(ref.index) || keys.has(`pad:${ref.index}:${ref.pad}`)
      : keys.has(`${ref.type}:${ref.index}`)
  )
  if (selected.length === 0) return []
  const others = new Set([...q.query.visibleLayers].filter((l) => l !== q.query.layer))
  return clearanceOutlines(selected, {
    ...q.query,
    layer: null,
    visibleLayers: others,
    selected: () => true
  })
})

/** A clearance is asked again on every selection change. */
const ownClearance = ownClearanceMemo()
const clearanceOf = computed(() => {
  const rules = props.clearanceRules
  return rules ? ownClearance(rules) : () => 0
})

watch(boardOutlineList, (outlines) => {
  if (!sceneBuilder || !engine) return
  sceneBuilder.setClearanceOutlines(outlines, 'board')
  engine.render()
})
watch(selectedOutlineList, (outlines) => {
  if (!sceneBuilder || !engine) return
  sceneBuilder.setClearanceOutlines(outlines, 'selected')
  engine.render()
})

watch(
  () => props.airwires,
  (wires) => {
    if (!sceneBuilder || !engine) return
    sceneBuilder.setRatsnest(wires)
    engine.render()
  }
)

defineExpose({
  /** The canvas menu's Select Other, at the client point it was opened. */
  selectOtherAt: selection.selectOtherAt,
  getCursor(): { x: number; y: number } | null {
    return pointerInside ? { ...lastDataCursor } : null
  },
  /**
   * The pointer unsnapped, data-scene mm, and how far a pick there reaches —
   * what Highlight Net picks with. Null off the canvas.
   */
  getPointer(): { x: number; y: number; reach: number } | null {
    const at = engine?.pointerWorld()
    if (!engine || !at) return null
    return { x: worldToDataX(at.x), y: at.y, reach: engine.hitRadius() }
  },
  /** Where the running move grabbed what it moves, board nm before it moved; null when none runs. */
  dragAnchorStart(): { x: Nm; y: Nm } | null {
    const at = engine?.dragAnchorStart()
    return at ? { x: mmToNm(worldToDataX(at.x)), y: mmToNm(-at.y) } : null
  },
  /**
   * KiCad's Move (M): what the editor picked up follows the pointer until a
   * click drops it. False when a drag is already running.
   */
  startHeldMove(): boolean {
    return engine?.beginHeldDrag({ held: true }) ?? false
  },
  /** Abandon a held move, nothing dropped; false when none is running. */
  cancelHeldMove(): boolean {
    return engine?.cancelDrag() ?? false
  },
  /** Where the route preview's head was last aimed: the cursor, magnet-adjusted (R18). */
  getRouteCursor(): { x: number; y: number } | null {
    return routeCursor.value ? { ...routeCursor.value } : null
  },
  /**
   * Select All: a band over everything, so it takes exactly what a sweep could
   * — visible layers, the selection filter, footprints but not their pads.
   */
  selectAll(): BoardItemRef[] {
    return selection.selectAll()
  },

  itemAtCursor,
  /** The route magnet at a data-space point (pad/track-end snap + net). */
  routeMagnetAt(pt: { x: number; y: number }): ReturnType<typeof routeMagnet> {
    return routeMagnet(pt)
  },
  saveDragOrigins(items: BoardItemRef[]): void {
    // Outlines first: the dragged copper's are drawn apart, then saved with it.
    dragged.value = items
    sceneBuilder?.setClearanceOutlines(boardOutlineList.value, 'board')
    sceneBuilder?.setClearanceOutlines(selectedOutlineList.value, 'selected')
    sceneBuilder?.saveDragOrigins(items)
    physicalDragStarted = false
  },
  clearDragOrigins(): void {
    dragged.value = []
    sceneBuilder?.clearDragOrigins()
    if (physicalDragStarted) physicalRender?.clearComponentDrag()
    physicalDragStarted = false
  },
  translateElements(items: BoardItemRef[], dataDelta: { x: number; y: number }): void {
    if (sceneBuilder && engine) {
      // Batch instances hold mirrored world coords, so convert back
      const localDelta = { x: worldToDataX(dataDelta.x), y: dataDelta.y }
      sceneBuilder.translateElements(items, localDelta)
      // The delta is cumulative from the drag origin. The physical drag begins
      // lazily on first real movement, but once begun every delta must reach
      // it — a drag back to exactly zero is how a body returns home.
      const moved = Math.abs(localDelta.x) > 1e-9 || Math.abs(localDelta.y) > 1e-9
      if (physicalDragStarted || moved) {
        if (!physicalDragStarted) {
          physicalRender?.beginComponentDrag(items)
          physicalDragStarted = true
        }
        physicalRender?.translateComponentDrag(localDelta)
      }
      engine.render()
    }
  },
  rebuildAndRender(): void {
    rebuildScene()
  },
  showShapeGhost,
  zoomToFit,
  focusFootprints,
  focusPoint,
  showFinding,
  runViewCommand,
  revealSelection,
  fit3D,
  view3DSize,
  export3DImage
})
</script>

<template>
  <div
    class="viewport-2d-layout"
    :class="{
      'preview-3d': mode === '3d',
      'transparent-ground': mode === '3d' && board3dLook.background === 'transparent'
    }"
    :data-background="mode === '3d' ? board3dLook.background : undefined"
  >
    <!-- The floating toolbar lives in PcbEditor.vue so it survives the
         2D/3D view switch -->

    <!-- Main WebGL/WebGPU render host container -->
    <div ref="viewportContainer" class="canvas-host-container"></div>

    <SelectOtherMenu
      v-if="selectOther"
      :items="selectOther.items"
      :label="labelBoardItem"
      :x="selectOther.x"
      :y="selectOther.y"
      @preview="selection.previewSelectOther"
      @commit="selection.closeSelectOther"
      @cancel="selection.closeSelectOther()"
    />

    <!-- Zone fills still streaming in from the worker (cold cache only). -->
    <div v-if="mode === 'layout' && showFillProgress" class="fill-progress-pill">
      <span>
        {{
          t('pcbEditor.viewport.fillProgress', {
            settled: fillProgress.settled,
            total: fillProgress.queued
          })
        }}
      </span>
      <span class="fill-progress-track">
        <span
          class="fill-progress-fill"
          :style="{
            width: Math.round((fillProgress.settled / Math.max(1, fillProgress.queued)) * 100) + '%'
          }"
        ></span>
      </span>
    </div>

    <!-- First build of the assembly overlay; later toggles reuse it. -->
    <div v-if="showRenderLayerBuilding" class="fill-progress-pill">
      <span>{{ t('pcbEditor.viewport.renderBuilding') }}</span>
    </div>

    <!-- Where agents work on this board: never part of the board. -->
    <AgentViewportOverlay
      v-if="mode === 'layout'"
      :viewports="agentViewports"
      :to-screen="agentView.toScreen"
      :marker-insets="agentView.markerInsets"
      @reveal="agentView.reveal"
    />

    <!-- Layout's readouts: nothing in the corner pills is a fact about the
         orbiting 3D view, so they leave with the mode rather than go stale. -->
    <template v-if="mode === 'layout'">
      <div v-if="routeKeysCard" class="route-keys-card">
        <div class="route-keys-header">
          <span class="route-keys-title">{{ routeKeysCard.title }}</span>
          <button
            type="button"
            class="btn-subtle btn-icon-sm"
            :title="t('common.close')"
            @click="emit('close-route-keys')"
          >
            <Icon name="close-sm" />
          </button>
        </div>
        <div class="route-keys-sections">
          <section
            v-for="(section, i) in routeKeysCard.sections"
            :key="section.title ?? i"
            class="route-keys-section"
          >
            <div v-if="section.title" class="route-keys-section-title">{{ section.title }}</div>
            <dl class="shortcut-grid route-keys-grid">
              <template v-for="key in section.keys" :key="key.text">
                <dt>{{ key.text }}</dt>
                <dd>
                  <KeyCapKbd v-for="cap in key.caps" :key="keyCapLabel(cap)" :cap="cap" />
                </dd>
              </template>
            </dl>
          </section>
        </div>
        <div class="route-keys-footer">
          <span class="route-keys-toggle">
            <kbd v-for="cap in routeKeysCard.toggle" :key="cap" class="kbd"
              ><span>{{ cap }}</span></kbd
            >
            {{ t('pcbEditor.viewport.keysCard.toggle') }}
          </span>
        </div>
      </div>
      <div
        v-if="tuneMeter"
        ref="tuneMeterEl"
        class="tune-meter-anchor"
        :style="
          tuneMeterAt
            ? { transform: `translate(${tuneMeterAt.x}px, ${tuneMeterAt.y}px)` }
            : { visibility: 'hidden' }
        "
      >
        <TuneMeter v-bind="tuneMeter" :unit="gridSettings.unit" />
      </div>
      <ViewportStatusBar ref="hintBar" side="left" :items="hintItems" />
      <ViewportStatusBar ref="coordsBar" :coords="statusCoords">
        <GridSettingsControl
          editor="pcb"
          :grid-settings="gridSettings"
          @update-grid="(g) => emit('update-grid', g)"
        />
        <SelectionFilterControl editor="pcb" />
        <slot name="status" />
      </ViewportStatusBar>
    </template>

    <!-- The 3D view's rail: the camera, where the layout keeps its display
         toggles (PcbEditor.vue), so view controls sit left in both modes. -->
    <div
      v-if="mode === '3d'"
      class="canvas-floating-toolbar toolbar-left-rail rail-solo unified-3d-toolbar"
    >
      <FitViewButton @fit="fit3D" />
      <div class="toolbar-divider"></div>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.isoViewTitle')"
        @click="set3DView('iso')"
      >
        <CubeIcon />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.topViewTitle')"
        @click="set3DView('top')"
      >
        <Icon name="cube-top" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('pcbEditor.viewport3d.bottomViewTitle')"
        @click="set3DView('bottom')"
      >
        <Icon name="cube-bottom" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.frontViewTitle')"
        @click="set3DView('front')"
      >
        <Icon name="cube-front" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.viewport-2d-layout {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: var(--vscode-bg-viewport);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* The pane's background (lib/board3dView.ts), which an exported picture
   carries too. Transparent is the shared `.transparent-ground`. */
.viewport-2d-layout.preview-3d[data-background='theme'] {
  background: radial-gradient(
    ellipse at 50% 38%,
    var(--vscode-bg-3d-near) 0%,
    var(--vscode-bg-3d-mid) 48%,
    var(--vscode-bg-3d-far) 100%
  );
}

/* The picture's own white and black, not theme colors. */
.viewport-2d-layout.preview-3d[data-background='white'] {
  background: white;
}

.viewport-2d-layout.preview-3d[data-background='black'] {
  background: black;
}

.unified-3d-toolbar {
  z-index: 12;
}

.unified-3d-toolbar .tool-btn svg {
  width: 15px;
  height: 15px;
}

.canvas-host-container {
  flex: 1;
  width: 100%;
  height: 100%;
}

/* Shares the coords overlay's corner, stacked just above it. */
.fill-progress-pill {
  position: absolute;
  bottom: 44px;
  left: 12px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  min-width: 150px;
  padding: 4px 10px;
  background-color: var(--vscode-overlay);
  backdrop-filter: blur(8px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text, #c5d3cd);
  pointer-events: none;
  z-index: 10;
}

.fill-progress-track {
  height: 3px;
  border-radius: 2px;
  background: var(--vscode-overlay-control-hover);
  overflow: hidden;
}

.fill-progress-fill {
  display: block;
  height: 100%;
  background: var(--vscode-accent, #cca250);
}

@media (prefers-reduced-motion: no-preference) {
  .fill-progress-fill {
    transition: width 120ms linear;
  }
}

/* The tune meter rides the cursor, so it never takes the pointer. */
.tune-meter-anchor {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 12;
  pointer-events: none;
}

/* `?`'s card of the routing keys (router-behavior.md K4): above the hint,
   in the corner pills' chrome; its sections flow in two columns, and a short
   canvas scrolls it rather than pushing it off the top. */
.route-keys-card {
  position: absolute;
  left: 12px;
  bottom: 54px;
  z-index: 12;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100% - 66px);
  overflow-y: auto;
  padding: 8px 12px 12px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
}

.route-keys-header,
.route-keys-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.route-keys-title,
.route-keys-section-title {
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.route-keys-sections {
  column-count: 2;
  column-gap: 24px;
}

.route-keys-section {
  break-inside: avoid;
  padding-bottom: 12px;
}

.route-keys-section-title {
  margin-bottom: 4px;
}

.route-keys-grid {
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
}

.route-keys-card dd {
  display: flex;
  gap: 4px;
}

.route-keys-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text-muted);
}
</style>
