// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import * as THREE from 'three'
import {
  BOARD_3D_FOV,
  VIEW_FIT_PADDING,
  fitOrbit,
  poseOrthoFromLens,
  visibleBoxes
} from './cameraFit'
import {
  BOARD_RIG,
  BOARD_TONE_MAPPING,
  applyBoardLighting,
  createBoardRig,
  type BoardRig
} from './board3d/boardLighting'
import type { Board3DLighting, Board3DProjection } from '../../../../preload/board3dTypes'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { releaseSharedAtlas } from './LabelBatch'
import { GridShader } from './GridShader'
import { bringIntoViewMove } from './bringIntoView'
import { observeDevicePixelSize } from './devicePixelSize'
import type { BringIntoViewMove, ViewInsets } from './bringIntoView'
import { NO_INSETS } from './viewportInsets'
import { primitiveBatchUniforms } from './PrimitiveBatch'
import { MIDDLE_DOUBLE_CLICK_INTERVAL_MS } from '../hotkeys'
import { spacingToMm } from '../kicad/coordinates'
import { themeColor, themeGridAppearance } from '../theme'
import { compositeCapture } from '../board3dExport'
import { gpuPowerPreference } from '../gpuPreference'
import { isRemoveSelect } from '../viewportSelection'

/** Key-light direction for the render layer, board-space (upper-left, ~40° up). */

export interface GridSettings {
  spacing: number
  unit: 'mm' | 'mil' | 'in'
  visible: boolean
  snap: boolean
}

export type View3DPreset = 'iso' | 'top' | 'bottom' | 'front'

/** Modifier keys held during a drag, read off the pointer event each frame. */
export interface DragModifiers {
  shift: boolean
  alt: boolean
  ctrl: boolean
}

/** The grid line nearest `value` on a grid of `spacing` passing through `origin`. */
export const snapToGrid = (value: number, spacing: number, origin = 0): number =>
  spacing > 0 ? Math.round((value - origin) / spacing) * spacing + origin : value

const dragModifiersOf = (e: MouseEvent): DragModifiers => ({
  shift: e.shiftKey,
  alt: e.altKey,
  ctrl: e.ctrlKey || e.metaKey
})

/** A drag event with no keys held: a keyboard move starting. */
const NO_MODIFIERS: DragModifiers = { shift: false, alt: false, ctrl: false }

/** How far a move's anchor reaches for another item's to snap to, screen px (KiCad's 25). */
const DRAG_SNAP_REACH_PX = 25

const nearestTo = (
  point: THREE.Vector2,
  points: readonly THREE.Vector2[]
): THREE.Vector2 | null => {
  let nearest: THREE.Vector2 | null = null
  for (const at of points) {
    if (!nearest || at.distanceToSquared(point) < nearest.distanceToSquared(point)) nearest = at
  }
  return nearest
}

/** Pointer travel (screen px) under which a press and release is a click, not a drag or pan. */
const CLICK_SLOP_PX = 4

/**
 * The box-select cursor badge: the box, and a part either wholly inside it
 * (window select, solid) or straddling its edge (crossing select, dashed).
 */
const boxSelectIcon = (crossing: boolean): string => {
  // Both drawings are centered on (8, 8): the crossing box sits left so that it
  // and the part hanging off its right edge balance as one shape.
  const box = crossing
    ? '<rect x="1.5" y="3.5" width="10" height="9" stroke-dasharray="2 1.5"/>'
    : '<rect x="2.5" y="3.5" width="11" height="9"/>'
  const part = crossing
    ? '<rect x="8.5" y="6" width="6" height="4" fill="currentColor" fill-opacity="0.5"/>'
    : '<rect x="5.5" y="6" width="5" height="4" fill="currentColor" fill-opacity="0.5"/>'
  return `<svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" style="display:block">${box}${part}</svg>`
}

/**
 * How long a press on an item is held, within the click slop, before it opens
 * Select Other — KiCad's disambiguation delay, long enough that a slow click
 * never does.
 */
const HOLD_MS = 500

/** Keep the transition implementation available while comparing a direct mode switch. */
const MODE_CROSSFADE_ENABLED = false

/** What a reveal is allowed to do (`bringIntoView.ts`). */
export interface BringIntoViewOptions {
  /** Chrome drawn over the canvas; `viewportInsets.ts` measures it. */
  insets?: ViewInsets
  /** Floor on the framed extent per axis when a fit is unavoidable, world mm. */
  minExtent?: number
  /** Border left around the target on a fit. */
  padding?: number
}

/**
 * One entry of the composite layer stack (see setCompositeLayers): a scene
 * whose content is rendered as opaque monochrome *coverage* into an offscreen
 * target, then composited into the frame as one flat tint. Paint order within
 * the scene is authoritative (renderOrder), which is what lets erase-blended
 * content (Gerber clear polarity) punch holes in the layer without touching
 * anything beneath it — and overlapping strokes can never double-darken.
 */
export interface CompositeLayerSpec {
  scene: THREE.Scene
  color: THREE.Color
  opacity: number
  visible: boolean
}

/**
 * Work in progress drawn above the document (see `setPreviewLayers`): drawn
 * by itself, then laid down once at `opacity`, so a translucent preview whose
 * strokes overlap — a route's joints, its caps under a via — reads as one
 * shape rather than a pile of ribbons.
 */
export interface PreviewLayerSpec {
  /** Everything the layer consists of, wherever it lives in the scene graph. */
  objects: THREE.Object3D[]
  opacity: number
}

/**
 * What a capture draws beyond the engine's own document: another scene in its
 * place (a routing session's, `boardCapture.ts`), and the preview layers the
 * live view flattens, which a plain capture leaves out.
 */
export interface FramedLayers {
  scene?: THREE.Scene
  preview?: PreviewLayerSpec[]
}

export interface GridAppearance {
  gridColor?: THREE.ColorRepresentation
  axisColorX?: THREE.ColorRepresentation
  axisColorY?: THREE.ColorRepresentation
  gridOpacity?: number
  axisOpacity?: number
  originOpacity?: number
  dotScale?: number
  majorDotScale?: number
}

/**
 * The grid appearance every 2D editor applies over the shader's (stronger)
 * built-in defaults. One home so "make the grid brighter" is a one-value
 * change, not a five-viewport sweep; the PCB editor spreads this and dims a
 * step so the grid doesn't compete with copper.
 */
export const STANDARD_GRID_APPEARANCE: GridAppearance = {
  gridOpacity: 0.35,
  axisOpacity: 0.24,
  originOpacity: 0.18,
  dotScale: 0.72,
  majorDotScale: 1.45
}

/** Zoom multiplier applied per notch of wheel travel. */
const ZOOM_STEP = 1.15

/**
 * Wheel travel that counts as one notch, per WheelEvent.deltaMode. A discrete
 * mouse wheel reports one notch per detent (100px in Chromium, 3 lines in
 * line mode); a trackpad reports a stream of much smaller deltas, so scaling by
 * these keeps a wheel detent at ZOOM_STEP while making trackpad zoom track
 * finger travel instead of event count.
 */
const NOTCH_PER_DELTA_MODE = [100, 3, 1]

/** Trackpad pinch reports far smaller deltas than scroll; scale it back up. */
const PINCH_GAIN = 8

/** Guards against momentum/accelerated deltas jumping the zoom in one event. */
const MAX_NOTCHES_PER_EVENT = 2

/**
 * What the pointer looks like, from the state that decides it. Panning wins
 * while it lasts; an armed tool takes its own glyph, defaulting to the pick
 * crosshair; everything else is the ordinary arrow.
 *
 * Pulled out as a function because the rule is worth pinning: the cursor is the
 * one piece of feedback whose absence is easy to miss, and the CSS this replaced
 * went dead in three editors the moment the engine wrote its first inline
 * cursor, with nothing to say so.
 */
export function viewportCursor(state: {
  panning: boolean
  drawMode: boolean
  drawCursor?: string
}): string {
  if (state.panning) return 'grabbing'
  if (!state.drawMode) return 'default'
  return state.drawCursor ?? 'crosshair'
}

/**
 * The perspective camera's near/far planes for a camera `distance` from the
 * center of content of the given bounding `radius` — both in millimeters.
 *
 * This exists because a PCB is a stack of surfaces microns apart (a pad sits
 * 10µm above the track it covers) while depth precision in a perspective
 * projection is set by the near plane and decays with the SQUARE of distance.
 * A fixed 0.1mm near plane spends nearly the whole depth buffer on the empty
 * space in front of the lens: past roughly 130mm of camera distance its
 * smallest resolvable step is already coarser than that 10µm, so the stack
 * tears, and every further click of zoom-out makes it worse. Clamping the
 * range to the content makes precision a function of the board's own depth
 * rather than of how far away you stand — the stack then holds at any zoom.
 */
/**
 * Where the camera stands for each 3D preset, as an offset direction from the
 * target (Z up, millimeters).
 *
 * The tiny Y components on top and bottom are not just pole-avoidance. Up is
 * world +Z for every preset, so looking straight down (or up) leaves the roll
 * undetermined, and this nudge is what resolves it — which makes the SIGN of it
 * the whole answer to "which way does the board turn over".
 *
 * Bottom leans the opposite way from top on purpose. That lands it with the
 * board's top edge still at the top of the screen and X mirrored — the board
 * turned over right-side-to-left, the way you would flip one in your hands to
 * read the back. It also decides the flight path, since `orbitFlightStep`
 * sweeps along whatever rotation separates the two poses: opposing leans make
 * that a half turn about the vertical axis, so the camera travels over the
 * board's side. Match the leans instead and both change together — the board
 * would tip end-over-end and arrive upside down.
 */
// `iso` and `front` are restated as bearings in `board3d/viewBearings.ts`.
export function view3DDirection(preset: View3DPreset): THREE.Vector3 {
  if (preset === 'top') return new THREE.Vector3(0, -1e-6, 1).normalize()
  if (preset === 'bottom') return new THREE.Vector3(0, 1e-6, -1).normalize()
  if (preset === 'front') return new THREE.Vector3(0, -1, 0.12).normalize()
  return new THREE.Vector3(0.72, -0.82, 0.62).normalize()
}

/** A camera that looks at `target` from `radius` away, in the orientation
 *  `quaternion` — the three quantities an orbiting flight interpolates. */
export interface OrbitPose {
  quaternion: THREE.Quaternion
  target: THREE.Vector3
  radius: number
}

/** Camera-space back: the axis a look-at camera's position lies along, from
 *  the thing it is looking at. */
const CAMERA_BACK = new THREE.Vector3(0, 0, 1)

/**
 * The zoom floor an off-screen capture fits against — effectively none. The
 * interactive floor exists so a person cannot lose the sheet in the distance;
 * a capture has no such reader, and a drawing too large for it must be shown
 * whole rather than cropped to a frame the answer then misreports.
 */
/**
 * How many pixels a capture may allocate in total, whatever its shape.
 *
 * The per-side limit is the GPU's own `MAX_TEXTURE_SIZE`, asked for at render
 * time rather than guessed. This is the second limit, and it is memory: the
 * readback is four bytes a pixel in a plain array, plus the target itself, so
 * a square capture at a 16384 texture limit would ask for a gigabyte. 64 MP
 * holds a 16384 x 4096 sheet-shaped capture, and fails a request rather than
 * the tab.
 */
const CAPTURE_MAX_AREA = 64_000_000

/**
 * A capture's world rectangle from the bounds it was asked for, grown about
 * its center to `minExtent` on a side that is smaller — which keeps a lone
 * 0603 or a single label from being magnified to fill a picture.
 */
const boundsAsRect = (bounds: THREE.Box3, minExtent: number): WorldRect => {
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  bounds.getSize(size)
  bounds.getCenter(center)
  const halfW = Math.max(size.x, minExtent) / 2
  const halfH = Math.max(size.y, minExtent) / 2
  return {
    minX: center.x - halfW,
    maxX: center.x + halfW,
    minY: center.y - halfH,
    maxY: center.y + halfH
  }
}

/**
 * The camera pose partway (`t` in 0..1) through a flight from one view to
 * another — an orbit around the target rather than a slide between the two
 * positions.
 *
 * Interpolating the positions directly takes the straight line between them,
 * and for opposed views (top to bottom) that line runs exactly through the
 * target: the camera flies through the board instead of around it, which is
 * both wrong and briefly alarming.
 *
 * So position is DERIVED from orientation rather than interpolated alongside
 * it: the slerped orientation already sweeps the arc, and a camera looking at
 * something sits on its own camera-space back axis from it. Placing the camera
 * there at a lerped radius makes the board stay centered and correctly sized
 * for the whole flight, by construction rather than by agreement between two
 * interpolations that could disagree.
 */
export function orbitFlightStep(
  from: OrbitPose,
  to: OrbitPose,
  t: number
): { position: THREE.Vector3; quaternion: THREE.Quaternion; target: THREE.Vector3 } {
  const quaternion = new THREE.Quaternion().slerpQuaternions(from.quaternion, to.quaternion, t)
  const target = from.target.clone().lerp(to.target, t)
  const radius = from.radius + (to.radius - from.radius) * t
  const back = CAMERA_BACK.clone().applyQuaternion(quaternion)
  return { position: target.clone().addScaledVector(back, radius), quaternion, target }
}

export function depthRangeFor(distance: number, radius: number): { near: number; far: number } {
  // Slack so geometry exactly on the bounds is not clipped by rounding.
  const padded = Math.max(radius, 0.001) * 1.05
  const far = distance + padded
  // Zoomed in among the parts the near plane cannot follow the bounds any
  // further; hold it at a fixed fraction of far, which bounds the ratio and so
  // the precision.
  return { near: Math.max(distance - padded, far * 1e-4), far }
}

/**
 * Something drawn at a fixed size in SCREEN pixels rather than world units.
 * `worldPerPixel` is `1 / zoomFactor`, the world distance one pixel spans, so a
 * target wanting N pixels scales its geometry by `N * worldPerPixel`.
 */
export interface ScreenScaled {
  setWorldPerPixel(worldPerPixel: number): void
}

export interface CustomHitResult {
  type: string
  index: number
  /**
   * What `setSelectedKeys` calls this element, when `type:index` is not it.
   *
   * A scene whose elements are NAMED rather than numbered — the symbol editor,
   * whose parts are addressed structurally — has nothing to put in `index`.
   * Without this the caller would have to reproduce the `type:index` spelling
   * to match, duplicating a format that lives here.
   */
  key?: string
}

/** A world-space rectangle in millimetres, y up. */
export interface WorldRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** One function, so the listener can come off again in `destroy`. */
const preventDefault = (event: Event): void => event.preventDefault()

export class ViewportEngine {
  private container: HTMLDivElement
  private canvas: HTMLCanvasElement
  private renderer!: THREE.WebGLRenderer // Fallback type in standard Three, but can use any

  public scene!: THREE.Scene
  public camera2D!: THREE.OrthographicCamera
  public camera3D!: THREE.PerspectiveCamera
  public activeCamera!: THREE.Camera
  public mode: '2d' | '3d' = '2d'
  private controls3D!: OrbitControls
  /** Where OrbitControls put its key listeners (`releaseControls`). */
  private controlsRoot: Node | null = null
  private cameraFlight = 0

  // Grid state
  private gridPlane!: THREE.Mesh
  private gridSettings: GridSettings = {
    spacing: 1.0,
    unit: 'mm',
    visible: true,
    snap: true
  }
  /**
   * Where the grid's lines pass through, world mm (y up): KiCad's grid origin.
   * The document origin — the axes and their crosshair — stays at 0,0; only
   * the dots and every snap move with it.
   */
  private gridOrigin = new THREE.Vector2(0, 0)

  /** An insert/draw tool is armed — see setDrawMode. */
  private drawMode = false
  /** The armed tool's own cursor, if it has one; otherwise the crosshair. */
  private drawCursor: string | undefined

  // Camera navigation state
  private isPanning = false
  /**
   * A Ctrl/Cmd press pans; released where it began, it was a click, and it
   * toggles what it landed on in the selection, as Shift+click does.
   */
  private modifierClick: { x: number; y: number; event: MouseEvent } | null = null
  /**
   * A modified press on an item already selected starts a drag of the
   * selection; released where it began, it takes the item out instead.
   */
  private pendingDeselect: {
    x: number
    y: number
    type: string
    index: number
    event: MouseEvent
  } | null = null
  /**
   * A press on an item not selected: KiCad's default left drag ("drag
   * selected objects, otherwise draw a selection rectangle"). Released where
   * it began, it is a click on the item; moved past the click slop, it is a
   * band from where it was pressed. Only what is already selected drags.
   */
  private pendingPick: {
    x: number
    y: number
    type: string
    index: number
    event: MouseEvent
  } | null = null
  private panStart = new THREE.Vector2()
  private cameraStartPos = new THREE.Vector3()
  private zoomFactor = 40.0 // pixels per mm (2D zoom level)
  private maxZoom = 400.0
  private minZoom = 2.0
  /**
   * Whether the view on screen is one the USER composed — panned, zoomed, or
   * restored from their last visit — as opposed to the fit this engine did
   * when the scene first arrived.
   *
   * `bringIntoView` reads it to decide whether there is a frame worth
   * preserving: a probe that opens a tab lands on a whole-board fit the user
   * never chose and has no bearing on what they want to see, so that one
   * frames the part outright. Preserve a view the user built; do not preserve
   * a view they never had.
   */
  private viewFramedByUser = false

  // Objects holding a constant on-screen size; see registerScreenScaled.
  private screenScaled = new Set<ScreenScaled>()
  private lastScaledZoom = 0

  // Event listeners tracker
  private resizeObserver: ResizeObserver | null = null
  private verticalResizeAnchor: 'center' | 'top' = 'center'
  private lastViewHeight = 0

  // Interactive mouse position
  public mouseWorld = new THREE.Vector2()
  /** Where the pointer is over the canvas, client px; null while it is elsewhere. */
  private pointerClient: { x: number; y: number } | null = null
  public mouseSnapped = new THREE.Vector2()
  /** See the mousemove handler: item snapping layered over the grid. */
  private snapOverride: ((world: THREE.Vector2) => { x: number; y: number } | null) | null = null

  /** Install (or clear, with null) an item-snap override for the crosshair. */
  public setSnapOverride(
    provider: ((world: THREE.Vector2) => { x: number; y: number } | null) | null
  ): void {
    this.snapOverride = provider
  }

  // Selection callback
  private onSelectCallback?: (
    objectName: string | null,
    index: number | null,
    event: MouseEvent
  ) => void
  private onMouseMoveCallback?: (worldPos: THREE.Vector2, snappedPos: THREE.Vector2) => void
  private customHitTestCallback?: (
    point: THREE.Vector2,
    threshold: number
  ) => CustomHitResult | null

  // Selection keys
  private currentlySelectedKeys: Set<string> = new Set()

  // Dragging state
  private isDragging = false
  private isDraggingVertex = false
  /** A drag begun from the keyboard (`beginHeldDrag`): no button is down, and
   *  the next left click drops it. */
  private heldDrag = false
  /**
   * Where the button went down on an item, until the pointer leaves the click
   * slop: no drag moves before then, so a press that is a click, or a hold,
   * never nudges what it landed on.
   */
  private dragPress: { x: number; y: number } | null = null
  /** `onPressCapture` listeners, removed on dispose. */
  private pressListeners: Array<(e: MouseEvent) => void> = []
  /** The pending hold of a plain press on an item (`HOLD_MS`). */
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private dragAnchorsCallback?: () => THREE.Vector2[]
  private dragTargetsCallback?: () => THREE.Vector2[]
  private dragGridCallback?: () => number | null
  /** The running move's snap targets, taken when it starts. */
  private dragTargets: THREE.Vector2[] = []
  private onSelectOtherCallback?: (
    point: THREE.Vector2,
    threshold: number,
    client: { x: number; y: number }
  ) => void
  private dragStartMouse = new THREE.Vector2()
  private dragStartVertexWorld = new THREE.Vector3()
  private pivotStartPos = new THREE.Vector3()

  // Box selection state
  private isBoxSelecting = false
  /** See `setViewOnly`. */
  private viewOnly = false
  /** A view-only left press: released where it began, it was a click (`onViewClick`). */
  private viewClick: { x: number; y: number; event: MouseEvent } | null = null
  private boxStartScreen = new THREE.Vector2()
  private boxEndScreen = new THREE.Vector2()
  private boxStartWorld = new THREE.Vector2()
  private selectionBoxEl!: HTMLDivElement
  private selectionTooltipEl!: HTMLDivElement

  // Composite layer stack (see setCompositeLayers)
  /**
   * Camera channel the preview flatten's objects live on, so the ordinary
   * document pass never sees them and cannot draw them twice.
   */
  private static readonly PREVIEW_LAYER_CHANNEL = 1
  /**
   * The one layer a flatten is drawing now: its objects step onto this channel
   * for their draw and back. Isolation is by channel, never by `visible`, which
   * is the scene's (a layer switched off is not drawn, flattened or not).
   */
  private static readonly FLATTEN_CHANNEL = 2

  private compositeLayers: CompositeLayerSpec[] = []
  private previewLayers: PreviewLayerSpec[] = []
  /** One reused flatten target: preview layers composite as each is drawn. */
  private flattenBuffer: THREE.WebGLRenderTarget | null = null
  private flattenQuadMaterial: THREE.ShaderMaterial | null = null
  private flattenQuadScene: THREE.Scene | null = null
  private compositeTargets: THREE.WebGLRenderTarget[] = []
  private compositeQuadScene: THREE.Scene | null = null
  private compositeQuadMaterial: THREE.ShaderMaterial | null = null
  private readonly compositeSize = new THREE.Vector2()

  // Overlap-safe overlay layer (see initOverlayLayer)
  public readonly overlayScene = new THREE.Scene()
  /**
   * KiCad's selection shadow carries alpha 0.8 (`builtin_color_themes.h`);
   * with the halo now KiCad-thin, opacity is the other half of its
   * visibility. 0.55 rather than 0.8 because this layer is SHARED — the
   * hover-net wire underlay flattens through it too, and 0.8 made that read
   * like selection rather than a hint. Trim here if either surface fights.
   */
  private overlayOpacity = 0.55
  private overlayTarget: THREE.WebGLRenderTarget | null = null
  private overlayQuadScene!: THREE.Scene
  private readonly overlayQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private overlayQuadMaterial!: THREE.ShaderMaterial
  private readonly overlaySize = new THREE.Vector2()
  private readonly overlayClearColor = new THREE.Color('#000000')
  /** Manual clear color — the layer stack repaints the background each frame.
   *  Keep in sync with --vscode-bg-viewport (base.css), the editor-host
   *  background, so mount gaps behind the canvas don't flash a different shade. */
  private readonly backgroundColor = new THREE.Color('#101513')
  /** The grid renders from its own scene so it can sit BELOW the overlay layer. */
  private readonly gridScene = new THREE.Scene()

  // Physical-render layer (see setRenderLayer)
  private renderLayerRoot: THREE.Object3D | null = null
  /** The far-side half of the root, drawn in its own pass (setRenderLayerFar). */
  private renderLayerNear: THREE.Object3D | null = null
  private renderLayerFar: THREE.Object3D | null = null
  private renderLayerFarScale = 1
  private renderLayerFarTarget: THREE.WebGLRenderTarget | null = null
  private renderLayerOpacity = 1
  private readonly renderLayerScene = new THREE.Scene()
  private renderLayerTarget: THREE.WebGLRenderTarget | null = null
  private renderLayerQuadScene: THREE.Scene | null = null
  private renderLayerQuadMaterial: THREE.ShaderMaterial | null = null
  private readonly renderLayerSize = new THREE.Vector2()
  private renderLayerEnv: THREE.Texture | null = null
  private renderLayerRig: BoardRig | null = null
  /** How the 3D view presents the board (`lib/board3dView.ts`). */
  private projection3D: Board3DProjection = 'perspective'
  private lighting3D: Board3DLighting = 'studio'
  private exposure3D = 1
  /** Draws the 3D view while it is orthographic; posed from `camera3D` each frame. */
  private readonly orthoCamera3D = new THREE.OrthographicCamera()
  /** Geometry/light/camera changed since the offscreen texture was drawn. */
  private renderLayerDirty = true
  private renderLayerCameraKey = ''
  /** World bounds of the render layer: the shadow frustum and the 3D camera's
   *  depth range are both fitted to it. Cached — measuring a dense board is a
   *  full-tree traversal, and it only moves when the board is rebuilt. */
  private readonly renderLayerBounds = new THREE.Box3()
  private renderLayerBoundsDirty = true
  private readonly depthSphere = new THREE.Sphere()
  /** Last fully composed canvas frame, held briefly while modes crossfade. */
  private transitionImage: HTMLImageElement | null = null
  private transitionCaptured = false
  private transitionOpacity = 0
  private physicalTransitionOpacity = 1
  private transitionRun = 0

  /**
   * Snapped-cursor crosshair (see setSnapCrosshair): a fixed-size cross at
   * `mouseSnapped`, KiCad's way of showing where a click will actually land —
   * including an item-snap override's magnet point while routing. Its own
   * scene, rendered LAST — the cursor reads on top of content, unlike the
   * grid — and never raycast, so it can't swallow clicks.
   */
  private readonly crosshairScene = new THREE.Scene()
  private crosshairLines: THREE.LineSegments | null = null
  private crosshairEnabled = false
  /** No crosshair until the pointer has actually been over this canvas. */
  private crosshairSeen = false
  private readonly crosshairLast = new THREE.Vector2(NaN, NaN)

  // Drag & Box selection callbacks
  private onDragStartCallback?: (type: 'object' | 'vertex', info?: Record<string, unknown>) => void
  private onDragMoveCallback?: (totalDelta: THREE.Vector2, modifiers: DragModifiers) => void
  private onDragEndCallback?: (modifiers: DragModifiers) => void
  private onResetViewCallback?: () => void
  private onViewClickCallback?: (world: THREE.Vector2, event: MouseEvent) => void
  private onViewChangedCallback?: () => void
  private lastMiddleDownTime = 0
  // The second press of a middle double-click; the fit waits for its release,
  // so a press that turns into a pan (the first click was a slip) stays a pan.
  private pendingMiddleFit: { x: number; y: number } | null = null
  private onBoxSelectCallback?: (
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    isCrossing: boolean,
    e: MouseEvent
  ) => void

  constructor(container: HTMLDivElement) {
    this.container = container
    this.canvas = document.createElement('canvas')
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.display = 'block'
    this.container.appendChild(this.canvas)

    // Selection box overlay setup
    this.selectionBoxEl = document.createElement('div')
    this.selectionBoxEl.style.position = 'absolute'
    this.selectionBoxEl.style.pointerEvents = 'none'
    this.selectionBoxEl.style.display = 'none'
    this.selectionBoxEl.style.zIndex = '10'
    this.container.appendChild(this.selectionBoxEl)

    // Selection tooltip overlay setup
    this.selectionTooltipEl = document.createElement('div')
    this.selectionTooltipEl.style.position = 'absolute'
    this.selectionTooltipEl.style.pointerEvents = 'none'
    this.selectionTooltipEl.style.display = 'none'
    this.selectionTooltipEl.style.zIndex = '11'
    this.container.appendChild(this.selectionTooltipEl)

    // Stated rather than inherited, so the viewport never starts in whatever
    // the page happens to give it.
    this.applyCursor()

    this.initScene()
    this.initRenderer()
    this.init3DControls()
    this.initGrid()
    this.initEvents()
  }

  private initScene(): void {
    this.scene = new THREE.Scene()
    // No scene.background: render() clears manually so the grid layer and
    // the flattened overlay can composite between background and document.

    // 2D Orthographic Camera
    const aspect = this.container.clientWidth / this.container.clientHeight
    const d = 10 // size frustum
    this.camera2D = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 0.1, 1000)
    this.camera2D.position.set(0, 0, 100)
    this.camera2D.lookAt(0, 0, 0)

    // 3D Perspective Camera
    this.camera3D = new THREE.PerspectiveCamera(BOARD_3D_FOV, aspect, 0.1, 1000)
    this.camera3D.up.set(0, 0, 1)
    this.camera3D.position.set(0, -15, 15)
    this.camera3D.lookAt(0, 0, 0)

    // Set active camera
    this.activeCamera = this.camera2D

    // Lights for 3D mode
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    this.scene.add(ambientLight)

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight1.position.set(10, -20, 20)
    this.scene.add(dirLight1)

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3)
    dirLight2.position.set(-10, 20, 10)
    this.scene.add(dirLight2)
  }

  private initRenderer(): void {
    // Standard WebGLRenderer fallback (or WebGPURenderer if preferred by bundler,
    // WebGLRenderer works everywhere and is stable).
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: gpuPowerPreference(),
      // Layout clears opaque; 3D clears transparent so the viewport's themed
      // radial studio background can show through the same canvas.
      alpha: true
    })
    // Checking a new shader program's log makes the first draw with it wait,
    // on this thread, for the GPU process to finish compiling it: seconds on a
    // software GL after an edit brings new materials in. Development keeps it.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV
    // The drawing buffer is sized in device pixels, exactly (see
    // observeDevicePixelSize), so the renderer's own ratio stays 1 and the
    // canvas keeps the 100% style it was given. This first size is a guess the
    // observer corrects before anything is painted.
    this.renderer.setPixelRatio(1)
    const ratio = window.devicePixelRatio
    this.renderer.setSize(
      Math.round(this.container.clientWidth * ratio),
      Math.round(this.container.clientHeight * ratio),
      false
    )
    this.renderer.sortObjects = true
    this.initOverlayLayer()
  }

  private readonly onControlsChange = (): void => {
    if (this.mode === '3d') this.render()
  }

  private init3DControls(): void {
    this.controlsRoot = this.canvas.getRootNode()
    this.controls3D = new OrbitControls(this.camera3D, this.canvas)
    this.controls3D.enabled = false
    this.controls3D.enableDamping = false
    this.controls3D.screenSpacePanning = true
    this.controls3D.addEventListener('change', this.onControlsChange)
  }

  /**
   * OrbitControls hangs its Ctrl-key listeners on `canvas.getRootNode()` and
   * takes them off by asking again. Viewports destroy their engine on unmount,
   * once Vue has taken their element out of the page, when the root is that
   * detached element: the listeners would stay on the document, holding the
   * controls and through them this engine and the editor's whole document. So
   * they come off the root they went on, and the controls let go of the engine.
   */
  private releaseControls(): void {
    const root = this.controlsRoot
    const keys = this.controls3D as unknown as {
      _interceptControlDown?: EventListener
      _interceptControlUp?: EventListener
    }
    if (root && root !== this.canvas.getRootNode()) {
      if (keys._interceptControlDown)
        root.removeEventListener('keydown', keys._interceptControlDown, { capture: true })
      if (keys._interceptControlUp)
        root.removeEventListener('keyup', keys._interceptControlUp, { capture: true })
    }
    this.controls3D.removeEventListener('change', this.onControlsChange)
    this.controls3D.dispose()
  }

  /**
   * Overlap-safe overlay layer: `overlayScene` content is rendered OPAQUE to
   * an offscreen target and composited beneath the document once at a single
   * uniform opacity. Overlapping strokes flatten to one shade in the target,
   * so the composite never accumulates alpha — the fix for glow/underlay
   * effects that must read as one continuous translucent color. The extra
   * passes run only when the layer has instances; otherwise render() keeps
   * the single-pass fast path.
   */
  private initOverlayLayer(): void {
    this.overlayQuadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tOverlay: { value: null },
        uOpacity: { value: this.overlayOpacity }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tOverlay;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(tOverlay, vUv);
          gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overlayQuadMaterial)
    quad.frustumCulled = false
    this.overlayQuadScene = new THREE.Scene()
    this.overlayQuadScene.add(quad)
  }

  /** Recreate the offscreen target when the drawing buffer size changed. */
  private ensureOverlayTarget(): THREE.WebGLRenderTarget {
    const size = this.renderer.getDrawingBufferSize(this.overlaySize)
    if (
      !this.overlayTarget ||
      this.overlayTarget.width !== size.x ||
      this.overlayTarget.height !== size.y
    ) {
      this.overlayTarget?.dispose()
      // 1:1 texel-to-pixel composite; Nearest keeps it pixel-exact (crisp).
      this.overlayTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false
      })
      this.overlayQuadMaterial.uniforms.tOverlay.value = this.overlayTarget.texture
    }
    return this.overlayTarget
  }

  private overlayHasContent(): boolean {
    for (const child of this.overlayScene.children) {
      if (!child.visible) continue
      const geometry = (child as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined
      if (!geometry || typeof geometry.instanceCount !== 'number' || geometry.instanceCount > 0) {
        return true
      }
    }
    return false
  }

  /** Global opacity of the flattened overlay layer (default 0.4). */
  public setOverlayOpacity(opacity: number): void {
    this.overlayOpacity = opacity
    this.overlayQuadMaterial.uniforms.uOpacity.value = opacity
  }

  // ---------------------------------------------------------------------------
  // Physical-render layer (the board as an object, over the layout)
  // ---------------------------------------------------------------------------

  /**
   * Hand the layer the root of a lit 3D board scene, or null to clear it.
   *
   * The layer is drawn with the SAME camera as the document, which is what
   * makes this work at all: `camera2D` is already orthographic and already in
   * millimeters, so a `BoardScene3D` built in that world lands pixel-registered
   * on top of the layout it depicts — same pad, same screen position, at every
   * zoom. Nothing is synchronized because nothing is duplicated. The caller
   * keeps ownership of the root and disposes it.
   */
  public setRenderLayer(root: THREE.Object3D | null): void {
    if (this.renderLayerRoot === root) return
    if (this.renderLayerRoot) this.renderLayerScene.remove(this.renderLayerRoot)
    this.renderLayerRoot = root
    if (root) this.renderLayerScene.add(root)
    this.renderLayerDirty = true
    this.renderLayerBoundsDirty = true
    this.render()
  }

  /**
   * The half of the render layer on the far side of the board, and how much of
   * it survives. 1 leaves it as it was; 0 removes it; in between it reads as
   * context rather than as content.
   *
   * A separate pass rather than a material change, for the reason the flatten
   * itself exists: the far side is drawn whole and faded once, so two parts
   * overlapping on the underside do not print darker than either. It also keeps
   * the near side's compositing exact — it lands on top of an already-finished
   * far side, so a part still covers what is behind it.
   *
   * `group` must be a descendant of the root handed to `setRenderLayer`; both
   * passes render that one scene, because the lighting lives there.
   */
  public setRenderLayerSides(
    near: THREE.Object3D | null,
    far: THREE.Object3D | null,
    farOpacityScale: number
  ): void {
    const next = Math.min(1, Math.max(0, farOpacityScale))
    if (
      this.renderLayerNear === near &&
      this.renderLayerFar === far &&
      this.renderLayerFarScale === next
    ) {
      return
    }
    this.renderLayerNear = near
    this.renderLayerFar = far
    this.renderLayerFarScale = next
    this.renderLayerDirty = true
    this.render()
  }

  /** Whether the far side earns a pass of its own: only a PARTIAL fade does.
   *  At full strength it can ride along with the near side, and at zero it is
   *  simply held out of that pass. */
  private farPassActive(): boolean {
    return !!this.renderLayerFar && this.renderLayerFarScale > 0 && this.renderLayerFarScale < 1
  }

  /** 0 = pure layout, 1 = pure render; in between crossfades the two. */
  public setRenderLayerOpacity(opacity: number): void {
    const next = Math.min(1, Math.max(0, opacity))
    if (this.renderLayerOpacity === next) return
    this.renderLayerOpacity = next
    this.render()
  }

  /** Scene contents changed without changing their overall bounds. */
  public invalidateRenderLayer(): void {
    this.renderLayerDirty = true
    this.render()
  }

  private renderLayerActive(): boolean {
    return !!this.renderLayerRoot && this.renderLayerRoot.visible && this.renderLayerOpacity > 0
  }

  /** The board rig (`boardLighting.ts`), shared with the agent's 3D render. */
  private initRenderLayerLights(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.renderLayerEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.renderLayerScene.environment = this.renderLayerEnv
    this.renderLayerScene.environmentIntensity = BOARD_RIG.environment

    const rig = createBoardRig()
    // The overlay texture is cached, so its shadow map obeys the same
    // invalidation contract instead of regenerating on unrelated cursor draws.
    rig.key.shadow.autoUpdate = false
    rig.key.shadow.needsUpdate = true
    this.renderLayerScene.add(rig.group)
    this.renderLayerRig = rig
    this.applyRenderLayerLighting()

    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
  }

  /** The chosen preset lights the 3D view; the assembly overlay keeps the
   *  studio light its top-down picture is tuned under. */
  private applyRenderLayerLighting(): void {
    const rig = this.renderLayerRig
    if (!rig) return
    const inView = this.mode === '3d'
    const environment = applyBoardLighting(rig, inView ? this.lighting3D : 'studio')
    // Exposure scales the whole rig rather than the tone curve, as the agent's
    // render does, so a preset's balance holds at any level.
    const exposure = inView ? this.exposure3D : 1
    for (const light of [rig.key, rig.overhead, rig.fill, rig.ambient]) light.intensity *= exposure
    this.renderLayerScene.environmentIntensity = environment * exposure
  }

  /** Set the 3D view's projection, light and exposure. */
  public setPresentation3D(
    projection: Board3DProjection,
    lighting: Board3DLighting,
    exposure: number
  ): void {
    if (
      projection === this.projection3D &&
      lighting === this.lighting3D &&
      exposure === this.exposure3D
    )
      return
    this.projection3D = projection
    this.lighting3D = lighting
    this.exposure3D = exposure
    this.applyRenderLayerLighting()
    this.renderLayerDirty = true
    this.render()
  }

  /**
   * The camera the render layer is drawn through. Orbit, fit and flight all
   * move `camera3D`; an orthographic 3D view is that same pose drawn in
   * parallel (`poseOrthoFromLens`).
   */
  private renderLayerCamera(): THREE.Camera {
    if (this.mode !== '3d' || this.projection3D !== 'orthographic') return this.activeCamera
    const bounds = this.layerBounds()
    poseOrthoFromLens(
      this.orthoCamera3D,
      this.camera3D,
      this.controls3D.target,
      bounds.isEmpty() ? null : bounds.getBoundingSphere(this.depthSphere)
    )
    return this.orthoCamera3D
  }

  /**
   * Re-fit the shadow frustum to the board. The directional light's shadow
   * camera is itself orthographic, so aiming it at exactly the board's bounds
   * spends every texel on the board — no cascades, and uniform density at any
   * zoom.
   */
  public refreshRenderLayer(): void {
    const rig = this.renderLayerRig
    this.renderLayerBoundsDirty = true
    const bounds = this.layerBounds()
    if (!rig || bounds.isEmpty()) return
    rig.fitShadow(bounds)
    this.renderLayerDirty = true
    this.render()
  }

  /** The render layer's world bounds, re-measured only after it changed. */
  private layerBounds(): THREE.Box3 {
    if (this.renderLayerBoundsDirty) {
      this.renderLayerBoundsDirty = false
      if (this.renderLayerRoot) this.renderLayerBounds.setFromObject(this.renderLayerRoot)
      else this.renderLayerBounds.makeEmpty()
    }
    return this.renderLayerBounds
  }

  /** Fit the perspective camera's depth range to the board it is looking at,
   *  which is what keeps the layer stack from tearing at low zoom — see
   *  `depthRangeFor` for why. */
  private update3DDepthRange(): void {
    const bounds = this.layerBounds()
    if (bounds.isEmpty()) return
    bounds.getBoundingSphere(this.depthSphere)
    const camera = this.camera3D
    const { near, far } = depthRangeFor(
      camera.position.distanceTo(this.depthSphere.center),
      this.depthSphere.radius
    )
    if (camera.near === near && camera.far === far) return
    camera.near = near
    camera.far = far
    camera.updateProjectionMatrix()
  }

  /**
   * How the render layer's offscreen images are made. Both halves share it, so
   * the far side resolves identically to the near one it composites under.
   *
   * The `antialias: true` the canvas is created with does NOTHING for this
   * layer: the board is drawn offscreen and arrives as a fullscreen textured
   * quad, and by then its edges are already resolved. Multisampling has to be
   * asked for on the target itself — otherwise a board of chamfered part bodies
   * and round pads is the one surface in the app rendering without it.
   *
   * Sample count is halved at retina density, where the drawing buffer is
   * already supersampling and 4× would buy little for four times the memory
   * (this target is drawing-buffer sized, and there can be two of them).
   */
  private renderLayerTargetOptions(): THREE.RenderTargetOptions {
    return {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      // Half-float keeps the PBR pass HDR: tone mapping happens later, at the
      // compositing quad, and an 8-bit target would clip highlights to white
      // before the mapping ever sees them.
      type: THREE.HalfFloatType,
      samples: window.devicePixelRatio >= 2 ? 2 : 4
    }
  }

  /** The far side's own image; same format as the near one, made on demand so
   *  a single-sided board never pays for it. */
  private ensureRenderLayerFarTarget(): THREE.WebGLRenderTarget {
    const size = this.renderer.getDrawingBufferSize(this.renderLayerSize)
    if (
      !this.renderLayerFarTarget ||
      this.renderLayerFarTarget.width !== size.x ||
      this.renderLayerFarTarget.height !== size.y
    ) {
      this.renderLayerFarTarget?.dispose()
      this.renderLayerFarTarget = new THREE.WebGLRenderTarget(
        size.x,
        size.y,
        this.renderLayerTargetOptions()
      )
    }
    return this.renderLayerFarTarget
  }

  private ensureRenderLayerResources(): THREE.WebGLRenderTarget {
    if (!this.renderLayerQuadMaterial) {
      this.renderLayerQuadMaterial = new THREE.ShaderMaterial({
        uniforms: { tLayer: { value: null }, uOpacity: { value: this.renderLayerOpacity } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tLayer;
          uniform float uOpacity;
          varying vec2 vUv;
          void main() {
            vec4 texel = texture2D(tLayer, vUv);
            gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
            // The offscreen image is linear HDR. The renderer applies tone
            // mapping and the output encode only on the default framebuffer,
            // which is this draw — not the passes that made the image.
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false
      })
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.renderLayerQuadMaterial)
      quad.frustumCulled = false
      this.renderLayerQuadScene = new THREE.Scene()
      this.renderLayerQuadScene.add(quad)
      this.initRenderLayerLights()
    }
    const size = this.renderer.getDrawingBufferSize(this.renderLayerSize)
    if (
      !this.renderLayerTarget ||
      this.renderLayerTarget.width !== size.x ||
      this.renderLayerTarget.height !== size.y
    ) {
      this.renderLayerTarget?.dispose()
      this.renderLayerTarget = new THREE.WebGLRenderTarget(
        size.x,
        size.y,
        this.renderLayerTargetOptions()
      )
      this.renderLayerQuadMaterial.uniforms.tLayer.value = this.renderLayerTarget.texture
      this.renderLayerDirty = true
    }
    return this.renderLayerTarget
  }

  // ---------------------------------------------------------------------------
  // Composite layer stack (offscreen coverage targets, e.g. Gerber layers)
  // ---------------------------------------------------------------------------

  /**
   * Replace the composite layer stack. Layers render between the grid and the
   * document scene, in array order (first = bottom). Pass [] to clear; the
   * offscreen targets are pooled and released on the next size change or
   * destroy(). The caller keeps ownership of the scenes.
   */
  public setCompositeLayers(layers: CompositeLayerSpec[]): void {
    this.compositeLayers = layers
    this.render()
  }

  /**
   * Layers of in-progress work to flatten and draw above the document, bottom
   * first. Each must draw as coverage (`PrimitiveBatch.setCoverageMode`) in a
   * single color: the flatten resolves overlaps with max, which keeps the
   * stronger paint and does not mix two colors. Pass [] to hand them back.
   * Does not render; the caller renders once it has drawn the preview.
   */
  public setPreviewLayers(specs: PreviewLayerSpec[]): void {
    for (const spec of this.previewLayers) for (const object of spec.objects) object.layers.set(0)
    this.previewLayers = specs
    for (const spec of specs) {
      for (const object of spec.objects) object.layers.set(ViewportEngine.PREVIEW_LAYER_CHANNEL)
    }
  }

  /**
   * The quad that puts one flattened layer on screen at one opacity.
   *
   * Separate from the Gerber composite quad because the two carry different
   * things: that one holds monochrome coverage and supplies the color itself,
   * this one holds the layer already painted in its own colors. Both are
   * premultiplied, so both composite with `One / OneMinusSrcAlpha`.
   */
  private ensureFlattenQuad(): void {
    if (this.flattenQuadMaterial) return
    this.flattenQuadMaterial = new THREE.ShaderMaterial({
      uniforms: { tLayer: { value: null }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tLayer;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 layer = texture2D(tLayer, vUv);
          if (layer.a <= 0.0) discard;
          gl_FragColor = layer * uOpacity;
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flattenQuadMaterial)
    quad.frustumCulled = false
    this.flattenQuadScene = new THREE.Scene()
    this.flattenQuadScene.add(quad)
  }

  /** The preview layers, each flattened and laid down once, above the document. */
  private renderPreviewLayers(): void {
    this.renderFlattened(this.previewLayers, ViewportEngine.PREVIEW_LAYER_CHANNEL)
  }

  /**
   * Flatten each spec's objects alone and lay the result down once. Into the
   * canvas from the live render; a capture passes `into`: its own scene,
   * camera, picture target and a flatten target of the picture's size.
   */
  private renderFlattened(
    specs: ReadonlyArray<PreviewLayerSpec>,
    channel: number,
    into?: {
      scene: THREE.Scene
      camera: THREE.Camera
      target: THREE.WebGLRenderTarget
      scratch: THREE.WebGLRenderTarget
    }
  ): void {
    if (specs.length === 0 || this.mode !== '2d') return
    this.ensureFlattenQuad()
    const material = this.flattenQuadMaterial
    const quadScene = this.flattenQuadScene
    if (!material || !quadScene) return

    let flatten: THREE.WebGLRenderTarget
    if (into) {
      flatten = into.scratch
    } else {
      const size = this.renderer.getDrawingBufferSize(this.compositeSize)
      const buffer = this.flattenBuffer
      if (buffer && (buffer.width !== size.x || buffer.height !== size.y)) {
        buffer.dispose()
        this.flattenBuffer = null
      }
      // RGBA, not the single-channel coverage the Gerber stack uses: a board
      // layer is not one color. A via's annulus, its barrel and its net label
      // share a slot and differ, and a flatten that carried only coverage would
      // repaint all three in whatever color the slot's name resolved to.
      this.flattenBuffer ??= ViewportEngine.flattenTarget(size.x, size.y)
      flatten = this.flattenBuffer
    }
    const scene = into?.scene ?? this.scene
    const camera = into?.camera ?? this.activeCamera
    const destination = into?.target ?? null

    const previousMask = camera.layers.mask
    // A layer's objects are scattered through the document (a board layer's
    // strokes are one mesh, its fills hang off the footprints' anchors), so
    // there is no subtree to render: each layer in turn steps onto the
    // flatten channel, alone, for its draw.
    camera.layers.set(ViewportEngine.FLATTEN_CHANNEL)

    for (const spec of specs) {
      for (const object of spec.objects) object.layers.set(ViewportEngine.FLATTEN_CHANNEL)
      this.renderer.setRenderTarget(flatten)
      this.renderer.setClearColor(this.overlayClearColor, 0)
      this.renderer.clear(true, false, false)
      this.renderer.render(scene, camera)
      this.renderer.setRenderTarget(destination)

      material.uniforms.tLayer.value = flatten.texture
      material.uniforms.uOpacity.value = spec.opacity
      this.renderer.render(quadScene, this.overlayQuadCamera)
      for (const object of spec.objects) object.layers.set(channel)
    }
    camera.layers.mask = previousMask
  }

  private static flattenTarget(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false
    })
  }

  private ensureCompositeResources(count: number): void {
    this.ensureCompositeQuad()

    const size = this.renderer.getDrawingBufferSize(this.compositeSize)
    const stale =
      this.compositeTargets.length > 0 &&
      (this.compositeTargets[0].width !== size.x || this.compositeTargets[0].height !== size.y)
    if (stale) {
      for (const target of this.compositeTargets) target.dispose()
      this.compositeTargets = []
    }
    while (this.compositeTargets.length < count) {
      // Single-channel coverage: a fraction of an RGBA target's memory, which
      // matters when a board's Gerber set is 15+ layers.
      this.compositeTargets.push(this.createCoverageTarget(size))
    }
  }

  private createCoverageTarget(size: THREE.Vector2): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(size.x, size.y, {
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false
    })
  }

  private ensureCompositeQuad(): void {
    if (!this.compositeQuadMaterial) {
      // Coverage lives in the red channel (content draws white); the quad
      // tints it with the layer color at the layer opacity.
      this.compositeQuadMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tCoverage: { value: null },
          uColor: { value: new THREE.Color('#ffffff') },
          uOpacity: { value: 1.0 }
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tCoverage;
          uniform vec3 uColor;
          uniform float uOpacity;
          varying vec2 vUv;
          void main() {
            float coverage = texture2D(tCoverage, vUv).r;
            gl_FragColor = vec4(uColor, coverage * uOpacity);
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false
      })
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeQuadMaterial)
      quad.frustumCulled = false
      this.compositeQuadScene = new THREE.Scene()
      this.compositeQuadScene.add(quad)
    }
  }

  private initGrid(): void {
    // A huge plane for the infinite grid shader
    const geometry = new THREE.PlaneGeometry(10000, 10000)
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(GridShader.uniforms),
      vertexShader: GridShader.vertexShader,
      fragmentShader: GridShader.fragmentShader,
      transparent: true,
      depthWrite: false
    })

    this.gridPlane = new THREE.Mesh(geometry, material)
    this.gridPlane.position.z = -0.01 // Draw slightly behind footprint elements
    this.gridPlane.frustumCulled = false // Always render
    this.gridScene.add(this.gridPlane)

    this.updateGridUniforms()
  }

  private updateGridUniforms(): void {
    const mat = this.gridPlane.material as THREE.ShaderMaterial
    if (!mat) return

    mat.uniforms.gridSpacing.value = spacingToMm(this.gridSettings.spacing, this.gridSettings.unit)
    ;(mat.uniforms.gridOrigin.value as THREE.Vector2).copy(this.gridOrigin)
    mat.uniforms.pixelSize.value = 1.0 / this.zoomFactor
    this.syncBatchPixelSize()
  }

  /**
   * The SDF primitive batch's world size of one DEVICE pixel (the drawing buffer
   * is sized in them), which sets its anti-aliasing ramp and min-stroke clamp.
   *
   * `primitiveBatchUniforms` is module scope — every engine's batches read the
   * one object — so this is written at the top of every `render()`, not only on
   * a zoom change: in a split two engines are alive, and a board drawn at the
   * schematic's pixel size has every stroke fattened and smeared until it zooms.
   */
  private syncBatchPixelSize(): void {
    primitiveBatchUniforms.uPixelSize.value = 1.0 / (this.zoomFactor * window.devicePixelRatio)
  }

  // Bound once so destroy() can remove the exact listener instances added
  // here. Passing a fresh `.bind(this)` to removeEventListener silently
  // removes nothing — the window-level mouseup listener then retains the
  // whole engine (renderer, scene graph, batch arrays) after every unmount,
  // leaking a full viewport per editor tab switch.
  private readonly boundMouseDown = this.onMouseDown.bind(this)
  private readonly boundMouseMove = (e: MouseEvent): void => this.inFrame(() => this.onMouseMove(e))
  private readonly boundMouseUp = this.onMouseUp.bind(this)
  private readonly boundMouseLeave = this.onMouseLeave.bind(this)
  private readonly boundWheel = (e: WheelEvent): void => this.inFrame(() => this.onWheel(e))

  /** Inside a pointer move or wheel event: a `render()` now draws on the next frame. */
  private inInput = false
  /** The frame a deferred `render()` will draw in, if one is asked for. */
  private pendingFrame: number | null = null

  /**
   * Handle one input event with its draws held to the next animation frame:
   * the pointer and the wheel can fire faster than the display refreshes, and
   * a draw per event spends frames nobody sees and delays the next event.
   * Covers whatever the event's callbacks draw too (a route preview, a drag).
   */
  private inFrame(handle: () => void): void {
    this.inInput = true
    try {
      handle()
    } finally {
      this.inInput = false
    }
  }
  /**
   * A left or middle press holds the pointer until its button lifts, so every
   * drag it starts — a pan, a box, an item or vertex drag, a tool's drag —
   * keeps following it over a toolbar, a panel or past the window's edge, and
   * its release still lands here. The release ends the capture on its own.
   * The right button is left alone for the context menu. In 3D, OrbitControls
   * holds the pointer itself.
   */
  private readonly boundPointerDown = (e: PointerEvent): void => {
    if (this.mode === '3d' || (e.button !== 0 && e.button !== 1)) return
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is no longer active — nothing to hold.
    }
  }

  private initEvents(): void {
    // Resize handling
    this.resizeObserver = observeDevicePixelSize(this.canvas, (width, height) => {
      this.resize(width, height)
    })

    // Pan & Zoom mouse handling
    this.canvas.addEventListener('pointerdown', this.boundPointerDown)
    this.canvas.addEventListener('mousedown', this.boundMouseDown)
    this.canvas.addEventListener('mousemove', this.boundMouseMove)
    this.canvas.addEventListener('mouseleave', this.boundMouseLeave)
    window.addEventListener('mouseup', this.boundMouseUp)
    this.canvas.addEventListener('wheel', this.boundWheel, { passive: false })

    // Prevent default context menu
    this.canvas.addEventListener('contextmenu', preventDefault)
  }

  /** `bufferWidth` × `bufferHeight` is the canvas in device pixels. */
  private resize(bufferWidth: number, bufferHeight: number): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0 || bufferWidth === 0 || bufferHeight === 0) return

    // With a 'top' anchor the frustum grows/shrinks off the bottom edge only,
    // so a panel opening below the viewport clips content instead of appearing
    // to pan it. Centered (the default) splits the delta across both edges.
    if (this.verticalResizeAnchor === 'top' && this.lastViewHeight > 0) {
      this.camera2D.position.y += (this.lastViewHeight - height) / (2 * this.zoomFactor)
    }
    this.lastViewHeight = height

    this.renderer.setSize(bufferWidth, bufferHeight, false)

    // Update 2D Camera
    this.update2DCameraFrustum()

    // Update 3D Camera
    this.camera3D.aspect = width / height
    this.camera3D.updateProjectionMatrix()

    this.render()
  }

  private update2DCameraFrustum(): void {
    // Frustum width/height depends on zoomFactor
    const halfWidth = this.container.clientWidth / (2 * this.zoomFactor)
    const halfHeight = this.container.clientHeight / (2 * this.zoomFactor)

    this.camera2D.left = -halfWidth
    this.camera2D.right = halfWidth
    this.camera2D.top = halfHeight
    this.camera2D.bottom = -halfHeight
    this.camera2D.updateProjectionMatrix()
  }

  public setMode(mode: '2d' | '3d'): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === '2d') {
      this.cameraFlight++
      this.activeCamera = this.camera2D
      this.controls3D.enabled = false
      this.gridPlane.visible = this.gridSettings.visible
    } else {
      this.activeCamera = this.camera3D
      this.controls3D.enabled = true
      this.gridPlane.visible = false
    }
    this.applyRenderLayerLighting()
    this.render()
  }

  /**
   * Freeze the exact composed canvas before its presentation changes. The
   * texture belongs to this renderer/context and lives only for the ensuing
   * crossfade; geometry and board state remain live underneath it.
   */
  public prepareModeTransition(): void {
    if (!MODE_CROSSFADE_ENABLED) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    this.clearTransitionCapture()
    // Ensure the default framebuffer contains a current, transition-free frame
    // immediately before serializing it into the short-lived DOM overlay.
    this.render()
    const image = this.ensureTransitionImage()
    image.src = this.canvas.toDataURL('image/png')
    image.style.display = 'block'
    image.style.opacity = '1'
    this.transitionCaptured = true
    this.transitionOpacity = 1
  }

  /**
   * A PNG of a world rectangle, for an agent that cannot otherwise see the
   * sheet (`render.schematic`), drawn **off-screen at the size that was asked for**.
   *
   * The earlier version fitted the on-screen camera and read the canvas back,
   * which made the picture the window's: `maxPixels` above the pane's device
   * pixels did nothing (4096 asked, 1986 returned), a fit filled the axis it
   * could not match so the reported frame ran far outside the drawing, and
   * every capture was a downscale of an already-antialiased canvas. Rendering
   * into a target sized from the request removes all three — the frame IS the
   * rectangle, at the resolution asked for, with no resample at all.
   *
   * The on-screen view never moves: the camera is borrowed and put back, and
   * nothing is drawn to the canvas until the restoring `render()`. What is
   * drawn is the background and the document, and nothing else: not the grid,
   * the selection halo, the snapped-cursor crosshair, or the layer compositing
   * a board view uses. All of it is editor chrome rather than drawing, and
   * KiCad's own plot leaves it out too. A capture that wants any of it back is
   * an export for a person to look at, which is a different verb.
   *
   * `layers` is the one exception, for a working view rather than an audit (a
   * routing session's): another scene drawn in place of the document, with
   * the preview layers flattened over it, as `render()` lays them.
   */
  public captureFramed(
    bounds: THREE.Box3 | null,
    minExtent: number,
    maxPixels: number,
    layers?: FramedLayers
  ): {
    dataUrl: string
    width: number
    height: number
    visible: WorldRect
    /** Present only when `maxPixels` could not be served: the longest edge that
     *  was, and which ceiling stopped it, so the answer can say so instead of
     *  quietly differing. */
    limit?: { pixels: number; reason: 'memory' | 'texture'; texture: number }
  } | null {
    const want =
      bounds && !bounds.isEmpty() ? boundsAsRect(bounds, minExtent) : this.visibleWorldBox()
    const worldW = want.maxX - want.minX
    const worldH = want.maxY - want.minY
    if (!(worldW > 0) || !(worldH > 0)) return null

    // One scale for both axes, so the picture is never stretched, and the
    // reported rectangle is recomputed from the pixels actually allocated —
    // rounding a millimetre box to whole pixels moves its edges, and a
    // coordinate read off the image has to land where the answer says.
    //
    // The caller's number is what it gets unless the hardware cannot: the two
    // ceilings below are what this machine can draw, not a view about how big
    // a picture ought to be. When one of them bites the answer says so — a
    // request silently served at another size is the defect this whole slice
    // started from.
    const longest = Math.max(worldW, worldH)
    const texture = this.renderer.capabilities.maxTextureSize
    const byTexture = Math.min(maxPixels, texture) / longest
    const byArea = Math.sqrt(CAPTURE_MAX_AREA / (worldW * worldH))
    const perMm = Math.min(byTexture, byArea)
    const limit =
      perMm * longest < maxPixels
        ? {
            pixels: Math.round(perMm * longest),
            reason: byArea < byTexture ? ('memory' as const) : ('texture' as const),
            texture
          }
        : undefined
    const width = Math.max(1, Math.round(worldW * perMm))
    const height = Math.max(1, Math.round(worldH * perMm))
    const centerX = (want.minX + want.maxX) / 2
    const centerY = (want.minY + want.maxY) / 2
    const visible: WorldRect = {
      minX: centerX - width / perMm / 2,
      maxX: centerX + width / perMm / 2,
      minY: centerY - height / perMm / 2,
      maxY: centerY + height / perMm / 2
    }

    const camera = this.camera2D
    const saved = {
      position: camera.position.clone(),
      left: camera.left,
      right: camera.right,
      top: camera.top,
      bottom: camera.bottom,
      zoom: this.zoomFactor,
      pixelSize: primitiveBatchUniforms.uPixelSize.value,
      autoClear: this.renderer.autoClear
    }
    const target = new THREE.WebGLRenderTarget(width, height)
    const coverages: THREE.WebGLRenderTarget[] = []
    const scene = layers?.scene ?? this.scene
    const preview = layers?.preview ?? []
    const scratch = preview.length > 0 ? ViewportEngine.flattenTarget(width, height) : null
    // As setPreviewLayers does: the objects leave the document pass for their
    // own channel, and come home after.
    for (const spec of preview)
      for (const object of spec.objects) object.layers.set(ViewportEngine.PREVIEW_LAYER_CHANNEL)
    // Without this the readback is linear and the picture comes out dark: the
    // sRGB encode happens on the way into whatever is being drawn to, and the
    // canvas normally supplies it.
    target.texture.colorSpace = THREE.SRGBColorSpace

    try {
      camera.position.set(centerX, centerY, saved.position.z)
      camera.left = -width / perMm / 2
      camera.right = width / perMm / 2
      camera.top = height / perMm / 2
      camera.bottom = -height / perMm / 2
      camera.updateProjectionMatrix()
      // The stroke shaders anti-alias and hold a minimum stroke against a world
      // size per pixel, which is what keeps a hairline visible in a small
      // picture. It has to be the TARGET's pixel, not the screen's, or a
      // capture at another scale draws its edges for the wrong resolution.
      this.zoomFactor = perMm
      // Set directly rather than through updateGridUniforms, which divides by
      // the canvas's device-pixel ratio: a render target has none, its pixels
      // are its own. Nothing else here touches the grid material.
      primitiveBatchUniforms.uPixelSize.value = 1 / perMm

      this.renderer.autoClear = false
      // The composite stack first, as render() lays it under the document: each
      // layer's coverage at the target's size, then tinted into the picture.
      const composites = this.compositeLayers.filter((layer) => layer.visible)
      if (composites.length) this.ensureCompositeQuad()
      for (const layer of composites) {
        const coverage = this.createCoverageTarget(new THREE.Vector2(width, height))
        coverages.push(coverage)
        this.renderer.setRenderTarget(coverage)
        this.renderer.setClearColor(this.overlayClearColor, 0)
        this.renderer.clear(true, false, false)
        this.renderer.render(layer.scene, camera)
      }
      this.renderer.setRenderTarget(target)
      this.renderer.setClearColor(this.backgroundColor, 1)
      this.renderer.clear(true, true, true)
      const quadScene = this.compositeQuadScene
      const quadMaterial = this.compositeQuadMaterial
      if (quadScene && quadMaterial) {
        const uniforms = quadMaterial.uniforms
        composites.forEach((layer, i) => {
          uniforms.tCoverage.value = coverages[i].texture
          uniforms.uColor.value.copy(layer.color)
          uniforms.uOpacity.value = layer.opacity
          this.renderer.render(quadScene, this.overlayQuadCamera)
        })
      }
      const into = scratch ? { scene, camera, target, scratch } : undefined
      this.renderer.setRenderTarget(target)
      this.renderer.render(scene, camera)
      this.renderFlattened(preview, ViewportEngine.PREVIEW_LAYER_CHANNEL, into)
      this.renderer.setRenderTarget(target)

      const pixels = new Uint8Array(width * height * 4)
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return null
      const image = context.createImageData(width, height)
      // GL reads bottom-up; a canvas is top-down.
      const stride = width * 4
      for (let y = 0; y < height; y++) {
        const from = (height - 1 - y) * stride
        image.data.set(pixels.subarray(from, from + stride), y * stride)
      }
      context.putImageData(image, 0, 0)
      return {
        dataUrl: canvas.toDataURL('image/png'),
        width,
        height,
        visible,
        ...(limit === undefined ? {} : { limit })
      }
    } finally {
      this.renderer.setRenderTarget(null)
      this.renderer.autoClear = saved.autoClear
      target.dispose()
      scratch?.dispose()
      for (const spec of preview) for (const object of spec.objects) object.layers.set(0)
      for (const coverage of coverages) coverage.dispose()
      camera.position.copy(saved.position)
      camera.left = saved.left
      camera.right = saved.right
      camera.top = saved.top
      camera.bottom = saved.bottom
      camera.updateProjectionMatrix()
      this.zoomFactor = saved.zoom
      primitiveBatchUniforms.uPixelSize.value = saved.pixelSize
      this.render()
    }
  }

  /** The world rectangle the 2D camera shows right now, in millimetres. */
  public visibleWorldBox(): WorldRect {
    const camera = this.camera2D
    return {
      minX: camera.position.x + camera.left,
      maxX: camera.position.x + camera.right,
      minY: camera.position.y + camera.bottom,
      maxY: camera.position.y + camera.top
    }
  }

  /** The canvas in device pixels: the size the view is drawn at. */
  public drawingBufferSize(): { width: number; height: number } {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    return { width: size.x, height: size.y }
  }

  /**
   * A picture of the 3D view as it stands — this camera, this scene, this
   * light — at another size, for a person's export. The view keeps its height,
   * so a wider picture shows more to the sides. `background` is laid under the
   * board; null leaves it transparent. Null outside 3D or with nothing built.
   *
   * Drawn through `render()` on the canvas's own buffer, borrowed at the
   * picture's size and handed back in the same task, so the picture is the
   * pane's to the pixel and the pane never shows it.
   */
  public capture3D(
    width: number,
    height: number,
    background: THREE.Color | null
  ): ImageData | null {
    if (this.mode !== '3d' || !this.renderLayerActive()) return null
    if (Math.max(width, height) > this.renderer.capabilities.maxTextureSize) return null
    const gl = this.renderer.getContext()
    const saved = this.renderer.getSize(new THREE.Vector2())
    const savedAspect = this.camera3D.aspect
    try {
      this.renderer.setSize(width, height, false)
      this.camera3D.aspect = width / height
      this.camera3D.updateProjectionMatrix()
      this.render()
      // Same task as the draw, so the buffer is still there without
      // preserveDrawingBuffer.
      const raw = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
      const image = new ImageData(width, height)
      // GL reads bottom-up; a canvas is top-down.
      const stride = width * 4
      for (let y = 0; y < height; y++) {
        const from = (height - 1 - y) * stride
        image.data.set(raw.subarray(from, from + stride), y * stride)
      }
      const hex = background?.getHex()
      compositeCapture(
        image.data,
        hex === undefined ? null : [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
      )
      return image
    } finally {
      this.renderer.setSize(saved.x, saved.y, false)
      this.camera3D.aspect = savedAspect
      this.camera3D.updateProjectionMatrix()
      this.render()
    }
  }

  public cancelModeTransition(): void {
    this.transitionRun++
    this.physicalTransitionOpacity = 1
    this.clearTransitionCapture()
  }

  /** Enter 3D top-down, with a perspective projection matched to the current 2D frame. */
  public enter3D(_bounds: THREE.Box3 | null, animate = true): void {
    const target = new THREE.Vector3(this.camera2D.position.x, this.camera2D.position.y, 0)
    const visibleHeight = this.camera2D.top - this.camera2D.bottom
    const fov = THREE.MathUtils.degToRad(this.camera3D.fov)
    const matchedDistance = Math.max(1, visibleHeight / (2 * Math.tan(fov / 2)))
    // OrbitControls cannot represent the exact Z-up pole: its first update
    // clamps the polar angle and otherwise appears to jump from top to an old
    // orbit when the user begins rotating. Seed that same imperceptibly offset
    // pole now, so the controller and the rendered camera agree from frame one.
    const poleOffset = 1e-6
    this.camera3D.position.set(
      target.x,
      target.y - matchedDistance * Math.sin(poleOffset),
      matchedDistance * Math.cos(poleOffset)
    )
    this.camera3D.up.set(0, 0, 1)
    this.controls3D.target.copy(target)
    this.controls3D.update()
    const crossfade = animate && this.transitionCaptured
    this.physicalTransitionOpacity = crossfade ? 0 : 1
    this.setMode('3d')
    if (crossfade) this.controls3D.enabled = false
    if (crossfade) {
      this.crossfadeMode(true, () => {
        if (this.mode === '3d') this.controls3D.enabled = true
      })
    }
  }

  /** Return to the still-resident editor under a fading capture of 3D. */
  public exit3D(animate = true): void {
    const crossfade = animate && this.transitionCaptured
    this.setMode('2d')
    this.physicalTransitionOpacity = 1
    if (crossfade) this.crossfadeMode(false)
    else this.clearTransitionCapture()
  }

  public setView3D(preset: View3DPreset, bounds: THREE.Box3 | null, animate = true): void {
    const pose = this.viewPose3D(bounds, preset, this.controls3D.target)
    if (animate) this.flyCamera3D(pose.position, pose.target)
    else {
      this.cameraFlight++
      this.camera3D.position.copy(pose.position)
      this.controls3D.target.copy(pose.target)
      this.camera3D.up.copy(this.cameraUpForPose())
      this.camera3D.lookAt(pose.target)
      // No pass renders with camera3D unless the dirty key — a hash of
      // matrixWorld — changes, so refresh it here; render() alone would
      // compare the stale matrix and skip the repaint.
      this.camera3D.updateMatrixWorld()
      // A flight this call aborted had disabled orbit input for its duration.
      if (this.mode === '3d') this.controls3D.enabled = true
      this.render()
    }
  }

  public fitView3D(bounds: THREE.Box3 | null): void {
    if (!bounds) return
    const direction = this.camera3D.position.clone().sub(this.controls3D.target).normalize()
    const pose = this.orbitPose3D(bounds, direction)
    this.flyCamera3D(pose.position, pose.target)
  }

  private viewPose3D(
    bounds: THREE.Box3 | null,
    preset: View3DPreset,
    fallbackTarget: THREE.Vector3
  ): { position: THREE.Vector3; target: THREE.Vector3 } {
    if (!bounds) {
      const distance = 10 / Math.tan(THREE.MathUtils.degToRad(this.camera3D.fov) / 2)
      return {
        position: fallbackTarget.clone().addScaledVector(view3DDirection(preset), distance),
        target: fallbackTarget.clone()
      }
    }
    return this.orbitPose3D(bounds, view3DDirection(preset))
  }

  /**
   * Fit what the 3D view draws, orbiting a point on the board's top face
   * (`cameraFit.ts`); `bounds` stands in when the scene has nothing measured.
   */
  private orbitPose3D(
    bounds: THREE.Box3,
    direction: THREE.Vector3
  ): { position: THREE.Vector3; target: THREE.Vector3 } {
    const root = this.renderLayerRoot
    const boxes = root ? visibleBoxes(root) : []
    const body = root?.getObjectByName('body')
    const bodyBox = body ? new THREE.Box3().setFromObject(body) : null
    const pivotZ =
      bodyBox && !bodyBox.isEmpty() ? bodyBox.max.z : bounds.getCenter(new THREE.Vector3()).z
    const fit = fitOrbit(
      boxes.length ? boxes : [bounds],
      direction,
      this.camera3D.fov,
      this.camera3D.aspect,
      pivotZ,
      this.cameraUpForPose()
    )
    if (fit) return fit
    const target = bounds.getCenter(new THREE.Vector3())
    const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2)
    const distance = (radius / Math.tan(THREE.MathUtils.degToRad(this.camera3D.fov) / 2)) * 1.15
    return { position: target.clone().addScaledVector(direction, distance), target }
  }

  private flyCamera3D(toPosition: THREE.Vector3, toTarget: THREE.Vector3, duration = 420): void {
    const run = ++this.cameraFlight
    this.controls3D.enabled = false
    const toUp = this.cameraUpForPose()
    const targetCamera = this.camera3D.clone()
    targetCamera.position.copy(toPosition)
    targetCamera.up.copy(toUp)
    targetCamera.lookAt(toTarget)
    const toQuaternion = targetCamera.quaternion.clone()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.camera3D.position.copy(toPosition)
      this.controls3D.target.copy(toTarget)
      this.camera3D.up.copy(toUp)
      this.camera3D.quaternion.copy(toQuaternion)
      // The render-layer dirty key hashes matrixWorld; without this refresh
      // the pose change is invisible to it and the old view stays on screen.
      this.camera3D.updateMatrixWorld()
      if (this.mode === '3d') this.controls3D.enabled = true
      this.render()
      return
    }
    const fromTarget = this.controls3D.target.clone()
    const fromPose: OrbitPose = {
      quaternion: this.camera3D.quaternion.clone(),
      target: fromTarget,
      radius: this.camera3D.position.distanceTo(fromTarget)
    }
    const toPose: OrbitPose = {
      quaternion: toQuaternion,
      target: toTarget,
      radius: toPosition.distanceTo(toTarget)
    }
    const started = performance.now()
    const tick = (now: number): void => {
      if (run !== this.cameraFlight || this.mode !== '3d') return
      const linear = Math.min(1, (now - started) / duration)
      const eased = linear * linear * (3 - 2 * linear)
      const pose = orbitFlightStep(fromPose, toPose, eased)
      this.camera3D.position.copy(pose.position)
      this.controls3D.target.copy(pose.target)
      this.camera3D.quaternion.copy(pose.quaternion)
      if (linear === 1) {
        this.camera3D.up.copy(toUp)
        this.controls3D.enabled = true
      }
      this.render()
      if (linear < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private cameraUpForPose(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1)
  }

  private ensureTransitionImage(): HTMLImageElement {
    if (this.transitionImage) return this.transitionImage
    const image = document.createElement('img')
    image.alt = ''
    image.style.position = 'absolute'
    image.style.inset = '0'
    image.style.width = '100%'
    image.style.height = '100%'
    image.style.pointerEvents = 'none'
    image.style.zIndex = '5'
    image.style.display = 'none'
    this.container.appendChild(image)
    this.transitionImage = image
    return image
  }

  private crossfadeMode(revealPhysical: boolean, done: () => void = () => {}): void {
    const run = ++this.transitionRun
    const started = performance.now()
    const tick = (now: number): void => {
      if (run !== this.transitionRun) return
      const linear = Math.min(1, (now - started) / 280)
      const eased = linear * linear * (3 - 2 * linear)
      this.transitionOpacity = 1 - eased
      if (this.transitionImage) this.transitionImage.style.opacity = String(this.transitionOpacity)
      if (revealPhysical) this.physicalTransitionOpacity = eased
      this.render()
      if (linear < 1) {
        requestAnimationFrame(tick)
      } else {
        this.physicalTransitionOpacity = 1
        this.clearTransitionCapture()
        this.render()
        done()
      }
    }
    requestAnimationFrame(tick)
  }

  private clearTransitionCapture(): void {
    this.transitionCaptured = false
    this.transitionOpacity = 0
    if (this.transitionImage) {
      this.transitionImage.style.display = 'none'
      this.transitionImage.style.opacity = '0'
      this.transitionImage.removeAttribute('src')
    }
  }

  /** Move the grid origin (world mm, y up); 0,0 puts the grid back on the document origin. */
  public setGridOrigin(x: number, y: number): void {
    if (this.gridOrigin.x === x && this.gridOrigin.y === y) return
    this.gridOrigin.set(x, y)
    this.updateGridUniforms()
    this.render()
  }

  public setGridSettings(settings: Partial<GridSettings>): void {
    this.gridSettings = { ...this.gridSettings, ...settings }
    if (this.mode === '2d') this.gridPlane.visible = this.gridSettings.visible
    this.updateGridUniforms()
    this.render()
  }

  public setGridAppearance(appearance: GridAppearance): void {
    const uniforms = (this.gridPlane.material as THREE.ShaderMaterial).uniforms
    if (appearance.gridColor !== undefined) {
      uniforms.gridColor.value = new THREE.Color(appearance.gridColor)
    }
    if (appearance.axisColorX !== undefined) {
      uniforms.axisColorX.value = new THREE.Color(appearance.axisColorX)
    }
    if (appearance.axisColorY !== undefined) {
      uniforms.axisColorY.value = new THREE.Color(appearance.axisColorY)
    }
    if (appearance.gridOpacity !== undefined) uniforms.gridOpacity.value = appearance.gridOpacity
    if (appearance.axisOpacity !== undefined) uniforms.axisOpacity.value = appearance.axisOpacity
    if (appearance.originOpacity !== undefined) {
      uniforms.originOpacity.value = appearance.originOpacity
    }
    if (appearance.dotScale !== undefined) uniforms.dotScale.value = appearance.dotScale
    if (appearance.majorDotScale !== undefined) {
      uniforms.majorDotScale.value = appearance.majorDotScale
    }
    this.render()
  }

  /** Re-read the CSS theme configuration after the application theme changes. */
  public applyTheme(): void {
    this.backgroundColor.set(themeColor('--vscode-bg-viewport', '#101513'))
    // A bare glyph over the canvas; a halo in the viewport's own color keeps its
    // thin lines readable over copper, silk or a light theme.
    const halo = themeColor('--vscode-bg-viewport', '#101513')
    this.selectionTooltipEl.style.filter = `drop-shadow(0 0 1px ${halo}) drop-shadow(0 0 2px ${halo})`
    const crosshair = this.crosshairLines?.material as THREE.LineBasicMaterial | undefined
    crosshair?.color.set(themeColor('--vscode-canvas-crosshair', '#a8c0b5'))
    this.setGridAppearance(themeGridAppearance())
  }

  public getGridSettings(): GridSettings {
    return this.gridSettings
  }

  /**
   * Whether an insert/draw tool is armed. The pointer says which of the two
   * modes an editor is in — pick things, or place them — and that answer is the
   * same in every editor, so it belongs here rather than in each viewport's CSS.
   *
   * It has to be here for a mechanical reason too: the canvas fills the
   * container and the engine writes its cursor INLINE, so a `cursor` rule on the
   * container is overridden from the engine's first write onwards — which is why
   * the editors' own `.tool-active` rules survived only until the first pan.
   *
   * `cursor` overrides the pick crosshair for a tool that deserves its own glyph
   * — the PCB router and the schematic wire tool pass `iconCursor('pencil', …)`,
   * since those two draw rather than place.
   */
  public setDrawMode(active: boolean, cursor?: string): void {
    if (this.drawMode === active && this.drawCursor === cursor) return
    this.drawMode = active
    this.drawCursor = cursor
    this.applyCursor()
  }

  /**
   * The one write; the rule itself is `viewportCursor`.
   *
   * Set on the CONTAINER as well as the canvas, because the mode belongs to the
   * whole viewport rather than to one element: the container also holds the
   * selection box, the tooltip and whatever chrome the editor renders over the
   * canvas, and the pointer must not change meaning as it crosses them. The
   * canvas still needs its own, since an inline style on the child would
   * otherwise win over the parent's.
   */
  private applyCursor(): void {
    const cursor = viewportCursor({
      panning: this.isPanning,
      drawMode: this.drawMode,
      drawCursor: this.drawCursor
    })
    this.canvas.style.cursor = cursor
    this.container.style.cursor = cursor
  }

  /**
   * Opt-in per editor: the symbol and schematic editors turn this on; the
   * every 2D editor enables it. A user-facing on/off setting is planned —
   * this is the switch it will drive.
   */
  /**
   * A canvas that is only a picture (the library chooser's previews): no press
   * picks, drags or box-selects anything, and a left drag pans like the middle
   * button — the gesture a picture is for. A click is still reported
   * (`onViewClick`), for a picture whose host picks from it (the visual diff).
   */
  public setViewOnly(viewOnly: boolean): void {
    this.viewOnly = viewOnly
  }

  public setSnapCrosshair(enabled: boolean): void {
    this.crosshairEnabled = enabled
    if (enabled && !this.crosshairLines) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
      // A LineBasicMaterial line is one device pixel at any zoom — exactly the
      // hairline wanted here, with no shader work. A small cross must read as
      // THE cursor, so it draws near-opaque (the old full-viewport hairlines
      // were faded to stay out of the way); depthTest off because its scene
      // renders after everything it must draw over.
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(themeColor('--vscode-canvas-crosshair', '#a8c0b5')),
        transparent: true,
        opacity: 0.85,
        depthTest: false
      })
      this.crosshairLines = new THREE.LineSegments(geometry, material)
      // The segments span the view and move every frame; culling them by a
      // stale bounding sphere would blink them out mid-pan.
      this.crosshairLines.frustumCulled = false
      this.crosshairScene.add(this.crosshairLines)
    }
    this.render()
  }

  /**
   * World-z plane where the split render divides base content from lifted
   * (selected) content — see render(). Null keeps the single-pass pipeline.
   * The schematic/symbol viewports set this (`LIFT_SPLIT_Z`) whenever a
   * selection exists, so the flattened glow quad composites ABOVE unselected
   * strokes and below the lifted selection.
   */
  private liftSplitZ: number | null = null

  public setLiftSplitZ(z: number | null): void {
    if (this.liftSplitZ === z) return
    this.liftSplitZ = z
    this.render()
  }

  /** Half-length of a crosshair arm, in screen pixels (constant at any zoom). */
  private static readonly CROSSHAIR_ARM_PX = 14

  /** Reposition the crosshair cross around the snapped cursor. */
  private updateCrosshair(): void {
    if (!this.crosshairLines) return
    const visible = this.crosshairEnabled && this.crosshairSeen && this.mode === '2d'
    this.crosshairLines.visible = visible
    if (!visible) return
    const arm = ViewportEngine.CROSSHAIR_ARM_PX / this.zoomFactor
    const { x, y } = this.mouseSnapped
    const positions = this.crosshairLines.geometry.getAttribute('position')
    positions.setXYZ(0, x - arm, y, 0)
    positions.setXYZ(1, x + arm, y, 0)
    positions.setXYZ(2, x, y - arm, 0)
    positions.setXYZ(3, x, y + arm, 0)
    positions.needsUpdate = true
  }

  public setVerticalResizeAnchor(anchor: 'center' | 'top'): void {
    this.verticalResizeAnchor = anchor
  }

  // ---------------------------------------------------------------------------
  // Camera Pan and Zoom math
  // ---------------------------------------------------------------------------

  private onMouseDown(e: MouseEvent): void {
    if (this.heldDrag && e.button === 0) {
      // The click that ends a keyboard drag is its drop, not a new pick.
      this.heldDrag = false
      this.isDragging = false
      this.onDragEndCallback?.(dragModifiersOf(e))
      this.render()
      e.preventDefault()
      return
    }
    // Middle-button double-click resets the view to fit the content
    // (dblclick events only fire for the primary button, so detect manually).
    // The second press still starts a pan; the fit fires on its release, and
    // only if the pointer stayed put.
    if (e.button === 1) {
      const now = performance.now()
      if (now - this.lastMiddleDownTime < MIDDLE_DOUBLE_CLICK_INTERVAL_MS) {
        this.lastMiddleDownTime = 0
        this.pendingMiddleFit = { x: e.clientX, y: e.clientY }
      } else {
        this.lastMiddleDownTime = now
        this.pendingMiddleFit = null
      }
    }

    if (this.mode === '3d') return

    // Pan with Middle Mouse Button (button 1) OR Ctrl + Left Mouse Button;
    // Ctrl+Shift / Cmd+Shift is the remove band below, not a pan.
    const removing = e.button === 0 && !this.viewOnly && isRemoveSelect(e)
    const isPanAction =
      e.button === 1 || (e.button === 0 && !removing && (e.ctrlKey || e.metaKey || this.viewOnly))

    this.modifierClick = null
    this.pendingDeselect = null
    this.pendingPick = null
    // Ctrl+Shift / Cmd+Shift press: a band that takes out of the selection,
    // wherever it starts — over an item too, since this press never drags. A
    // press that never moves is a click on what it was pressed on.
    if (removing && this.mode === '2d') {
      this.modifierClick = { x: e.clientX, y: e.clientY, event: e }
      this.isBoxSelecting = true
      this.boxStartScreen.set(e.clientX, e.clientY)
      this.boxStartWorld.copy(this.mouseWorld)
      e.preventDefault()
      return
    }
    if (isPanAction && this.mode === '2d') {
      if (e.button === 0 && !this.viewOnly)
        this.modifierClick = { x: e.clientX, y: e.clientY, event: e }
      this.viewClick =
        e.button === 0 && this.viewOnly ? { x: e.clientX, y: e.clientY, event: e } : null
      this.isPanning = true
      this.panStart.set(e.clientX, e.clientY)
      this.cameraStartPos.copy(this.camera2D.position)
      this.applyCursor()
      e.preventDefault()
      return
    }

    if (e.button === 0) {
      const rect = this.canvas.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      // 1. Raycast to find hits (used for vertex handles and exact fallbacks)
      const raycaster = new THREE.Raycaster()
      raycaster.params.Line = { threshold: 0.15 }
      raycaster.setFromCamera(new THREE.Vector2(x, y), this.activeCamera)

      const intersects = raycaster.intersectObjects(this.scene.children, true)
      const validIntersects = intersects.filter((i) => i.object !== this.gridPlane)

      // 2. Check for vertex handle hit first (highest priority)
      const vertexHit = validIntersects.find((i) => {
        let curr: THREE.Object3D | null = i.object
        while (curr) {
          if (curr.userData && curr.userData.type === 'vertex') return true
          curr = curr.parent
        }
        return false
      })

      if (vertexHit) {
        let curr: THREE.Object3D | null = vertexHit.object
        while (curr) {
          if (curr.userData && curr.userData.type === 'vertex') {
            this.dragStartMouse.copy(this.mouseWorld)
            // A 'move' handle (KiCad's center point) and an 'anchor' one (the
            // same drag, from a point the file stores) are handles only in how
            // they are drawn and raycast — what they start is an ordinary
            // object drag, so both take the path of grabbing the shape itself.
            if (curr.userData.role === 'move' || curr.userData.role === 'anchor') {
              this.isDragging = true
              this.grabAt(new THREE.Vector2(curr.position.x, curr.position.y))
              this.onDragStartCallback?.('object', curr.userData as Record<string, unknown>)
              return
            }
            this.isDraggingVertex = true
            this.dragStartVertexWorld.copy(curr.position)
            if (this.onDragStartCallback) {
              this.onDragStartCallback('vertex', curr.userData as Record<string, unknown>)
            }
            return
          }
          curr = curr.parent
        }
      }

      // 3. Proximity hit testing (first priority for selectable elements)
      let hitObject: THREE.Object3D | undefined
      if (this.customHitTestCallback) {
        const hitElement = this.customHitTestCallback(this.clientToWorld(e), this.hitRadius())
        if (hitElement) {
          this.scene.traverse((obj) => {
            if (
              obj.userData &&
              obj.userData.type === hitElement.type &&
              obj.userData.index === hitElement.index
            ) {
              hitObject = obj
            }
          })
          // A hit with no scene object of its own (the board's batched tracks,
          // the symbol's named parts): select and drag it as the hit names it.
          if (!hitObject) {
            const key = hitElement.key ?? `${hitElement.type}:${hitElement.index}`
            if (!this.currentlySelectedKeys.has(key)) {
              this.pickOrBand(hitElement.type, hitElement.index, e)
              return
            }
            if (e.shiftKey) {
              this.pendingDeselect = {
                x: e.clientX,
                y: e.clientY,
                type: hitElement.type,
                index: hitElement.index,
                event: e
              }
            }
            this.isDragging = true
            this.pressItem(e)
            this.grabAt(this.grabAnchor())
            this.onDragStartCallback?.('object', {
              type: hitElement.type,
              index: hitElement.index
            })
            return
          }
        }
      }

      // 4. Check for selectable element hit (fallback to standard raycast if proximity hit-test failed or wasn't set)
      if (!hitObject) {
        const selectable = (obj: THREE.Object3D): boolean =>
          !!obj.userData?.type &&
          obj.userData.type !== 'vertex' &&
          (this.raycastFilter?.(obj.userData.type, obj.userData.index) ?? true)
        const elementHit = validIntersects.find((i) => {
          let curr: THREE.Object3D | null = i.object
          while (curr) {
            if (selectable(curr)) return true
            curr = curr.parent
          }
          return false
        })

        if (elementHit) {
          let curr: THREE.Object3D | null = elementHit.object
          while (curr) {
            if (selectable(curr)) {
              hitObject = curr
              break
            }
            curr = curr.parent
          }
        }
      }

      // If we resolved a hit, update selection and begin dragging
      if (hitObject) {
        const key = `${hitObject.userData.type}:${hitObject.userData.index}`

        // An item not selected is a click or a band, never a drag.
        if (!this.currentlySelectedKeys.has(key)) {
          this.pickOrBand(hitObject.userData.type, hitObject.userData.index, e)
          return
        }
        if (e.shiftKey) {
          this.pendingDeselect = {
            x: e.clientX,
            y: e.clientY,
            type: hitObject.userData.type,
            index: hitObject.userData.index,
            event: e
          }
        }

        // Start dragging
        this.isDragging = true
        this.pressItem(e)
        this.grabAt(this.grabAnchor())

        if (this.onDragStartCallback) {
          this.onDragStartCallback('object', hitObject.userData as Record<string, unknown>)
        }
        return
      }

      // 4. Clicked empty space: start box selection
      this.isBoxSelecting = true
      this.boxStartScreen.set(e.clientX, e.clientY)
      this.boxStartWorld.copy(this.mouseWorld)

      // Clear selection if not pressing modifier key
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (this.onSelectCallback) {
          this.onSelectCallback(null, null, e)
        }
      }
    }
  }

  /** The world point under a client position. */
  public clientToWorld(at: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    const x = ((at.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((at.clientY - rect.top) / rect.height) * 2 + 1
    const point = new THREE.Vector3(x, y, 0).unproject(this.activeCamera)
    return new THREE.Vector2(point.x, point.y)
  }

  /**
   * How near, in world units, a click must land to hit an item: 10 px at the
   * current zoom. Every question "what is under the pointer" asks with this.
   */
  public hitRadius(): number {
    if (!(this.activeCamera instanceof THREE.OrthographicCamera)) return 0.25
    const frustumWidth = this.activeCamera.right - this.activeCamera.left
    return 10 * (frustumWidth / this.canvas.getBoundingClientRect().width)
  }

  /**
   * A press on an item not selected (`pendingPick`): a band in waiting that
   * the release turns into a click on the item if the pointer never left the
   * click slop. A plain press held there opens Select Other, as on a drag.
   */
  private pickOrBand(type: string, index: number, e: MouseEvent): void {
    this.pendingPick = { x: e.clientX, y: e.clientY, type, index, event: e }
    this.isBoxSelecting = true
    this.boxStartScreen.set(e.clientX, e.clientY)
    this.boxStartWorld.copy(this.mouseWorld)
    this.clearHold()
    if (!this.onSelectOtherCallback || e.shiftKey || e.altKey) return
    const client = { x: e.clientX, y: e.clientY }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      const pick = this.pendingPick
      if (!pick || !this.isBoxSelecting) return
      // The held press ends as the click it has been so far, and the list
      // opens where it is.
      this.pendingPick = null
      this.isBoxSelecting = false
      this.onSelectCallback?.(pick.type, pick.index, pick.event)
      this.render()
      this.onSelectOtherCallback?.(this.clientToWorld(e), this.hitRadius(), client)
    }, HOLD_MS)
  }

  /**
   * A press on an item began its drag: hold its moves until the pointer
   * leaves the click slop, and time a plain press for Select Other.
   */
  private pressItem(e: MouseEvent): void {
    this.dragPress = { x: e.clientX, y: e.clientY }
    this.clearHold()
    if (!this.onSelectOtherCallback || e.shiftKey || e.altKey) return
    const client = { x: e.clientX, y: e.clientY }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (!this.isDragging || !this.dragPress) return
      // The held press ends as the click it has been so far — the item it
      // landed on selected, nothing moved — and the list opens where it is.
      this.isDragging = false
      this.dragPress = null
      this.pendingDeselect = null
      this.onDragEndCallback?.(dragModifiersOf(e))
      this.render()
      this.onSelectOtherCallback?.(this.clientToWorld(e), this.hitRadius(), client)
    }, HOLD_MS)
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  /** The world point under the pointer, or null while it is off the canvas. */
  public pointerWorld(): THREE.Vector2 | null {
    return this.pointerClient ? this.mouseWorld.clone() : null
  }

  /**
   * Run `listener` on every press over the canvas before the engine handles
   * it — what a viewport needs to know about a press before it selects.
   */
  public onPressCapture(listener: (e: MouseEvent) => void): void {
    this.container.addEventListener('mousedown', listener, true)
    this.pressListeners.push(listener)
  }

  /**
   * Select Other at a client point (the canvas menu's Select Other, where the
   * menu was opened): the same list a held press opens.
   */
  public selectOtherAt(at: { x: number; y: number }): boolean {
    if (this.mode !== '2d' || !this.onSelectOtherCallback) return false
    if (this.isDragging || this.isDraggingVertex || this.isBoxSelecting || this.isPanning)
      return false
    const point = this.clientToWorld({ clientX: at.x, clientY: at.y })
    this.onSelectOtherCallback(point, this.hitRadius(), { ...at })
    return true
  }

  /**
   * What a held press or the menu's Select Other asks for: the world point, the
   * hit threshold there, and the client point to open the list at.
   */
  public onSelectOther(
    callback: (point: THREE.Vector2, threshold: number, client: { x: number; y: number }) => void
  ): void {
    this.onSelectOtherCallback = callback
  }

  /**
   * The selectable item a click at the event's point lands on — the editor's
   * own hit test where it has one, else the scene's — ignoring handles.
   */
  private selectableAt(e: MouseEvent): { type: string; index: number } | null {
    const rect = this.canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    if (this.customHitTestCallback) {
      const hit = this.customHitTestCallback(this.clientToWorld(e), this.hitRadius())
      if (hit) return { type: hit.type, index: hit.index }
    }
    const raycaster = new THREE.Raycaster()
    raycaster.params.Line = { threshold: 0.15 }
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.activeCamera)
    for (const intersect of raycaster.intersectObjects(this.scene.children, true)) {
      if (intersect.object === this.gridPlane) continue
      for (let obj: THREE.Object3D | null = intersect.object; obj; obj = obj.parent) {
        const data = obj.userData as { type?: string; index?: number }
        if (data?.type === 'vertex') break
        if (
          data?.type &&
          typeof data.index === 'number' &&
          (this.raycastFilter?.(data.type, data.index) ?? true)
        )
          return { type: data.type, index: data.index }
      }
    }
    return null
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.mode === '3d') return
    // Calculate world mouse position
    const rect = this.canvas.getBoundingClientRect()
    const mouseNormalizedX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const mouseNormalizedY = -((e.clientY - rect.top) / rect.height) * 2 + 1

    const mouseVec = new THREE.Vector3(mouseNormalizedX, mouseNormalizedY, 0)
    mouseVec.unproject(this.activeCamera)

    this.mouseWorld.set(mouseVec.x, mouseVec.y)
    this.pointerClient = { x: e.clientX, y: e.clientY }

    // Calculate snapped coordinates
    if (this.gridSettings.snap) {
      const snapped = this.snapPoint(this.mouseWorld)
      this.mouseSnapped.copy(snapped)
    } else {
      this.mouseSnapped.copy(this.mouseWorld)
    }
    // An item-snap override (the route tool's pad magnet) outranks the grid:
    // the crosshair and every emitted snapped position land where the click
    // will — the cursor never lies about what it is about to do.
    if (this.snapOverride) {
      const o = this.snapOverride(this.mouseWorld)
      if (o) this.mouseSnapped.set(o.x, o.y)
    }

    if (this.isPanning && this.mode === '2d') {
      const dx = e.clientX - this.panStart.x
      const dy = e.clientY - this.panStart.y

      // Translate pixels to world units
      const worldDx = dx / this.zoomFactor
      const worldDy = dy / this.zoomFactor

      this.camera2D.position.x = this.cameraStartPos.x - worldDx
      this.camera2D.position.y = this.cameraStartPos.y + worldDy
      if (dx !== 0 || dy !== 0) this.markViewFramedByUser()
      this.render()
      this.notifyViewChanged()
    } else if (
      this.isDragging &&
      this.dragPress &&
      Math.hypot(e.clientX - this.dragPress.x, e.clientY - this.dragPress.y) < CLICK_SLOP_PX
    ) {
      // Still a click (or a hold): nothing moves yet.
    } else if (this.isDragging) {
      this.dragPress = null
      this.clearHold()
      this.emitObjectDrag(dragModifiersOf(e))
    } else if (this.isDraggingVertex) {
      const mouseDelta = new THREE.Vector2().subVectors(this.mouseWorld, this.dragStartMouse)

      let dragDelta: THREE.Vector2
      if (this.gridSettings.snap) {
        const dx = this.snapCoordinateWithStart(
          this.dragStartVertexWorld.x,
          mouseDelta.x,
          this.gridSettings.spacing,
          this.gridOrigin.x
        )
        const dy = this.snapCoordinateWithStart(
          this.dragStartVertexWorld.y,
          mouseDelta.y,
          this.gridSettings.spacing,
          this.gridOrigin.y
        )
        dragDelta = new THREE.Vector2(dx, dy)
      } else {
        dragDelta = mouseDelta
      }

      if (this.onDragMoveCallback) {
        this.onDragMoveCallback(dragDelta, dragModifiersOf(e))
      }
      this.render()
    } else if (
      this.isBoxSelecting &&
      this.pendingPick &&
      Math.hypot(e.clientX - this.pendingPick.x, e.clientY - this.pendingPick.y) < CLICK_SLOP_PX
    ) {
      // A press on an item: still a click (or a hold).
    } else if (this.isBoxSelecting) {
      const pick = this.pendingPick
      if (pick) {
        // Out of the click slop: a band from the press, which starts as a
        // band from empty space does.
        this.pendingPick = null
        this.clearHold()
        const m = pick.event
        if (!m.shiftKey && !m.ctrlKey && !m.metaKey) this.onSelectCallback?.(null, null, m)
      }
      this.boxEndScreen.set(e.clientX, e.clientY)

      // Update HTML box selection overlay
      const x0 = this.boxStartScreen.x
      const y0 = this.boxStartScreen.y
      const x1 = e.clientX
      const y1 = e.clientY

      const containerRect = this.container.getBoundingClientRect()
      const rx0 = x0 - containerRect.left
      const ry0 = y0 - containerRect.top
      const rx1 = x1 - containerRect.left
      const ry1 = y1 - containerRect.top

      const left = Math.min(rx0, rx1)
      const top = Math.min(ry0, ry1)
      const width = Math.abs(rx1 - rx0)
      const height = Math.abs(ry1 - ry0)

      this.selectionBoxEl.style.left = left + 'px'
      this.selectionBoxEl.style.top = top + 'px'
      this.selectionBoxEl.style.width = width + 'px'
      this.selectionBoxEl.style.height = height + 'px'
      this.selectionBoxEl.style.display = 'block'

      const dx = x1 - x0

      // Down-Right is Window select (dx >= 0), Up-Left or Left is Crossing select (dx < 0)
      const isCrossing = dx < 0

      if (isCrossing) {
        this.selectionBoxEl.style.border = '1.5px dashed var(--vscode-canvas-select-crossing)'
        this.selectionBoxEl.style.background =
          'color-mix(in srgb, var(--vscode-canvas-select-crossing) 15%, transparent)'
        this.selectionTooltipEl.innerHTML = boxSelectIcon(true)
        this.selectionTooltipEl.style.color = 'var(--vscode-canvas-select-crossing)'
      } else {
        this.selectionBoxEl.style.border = '1.5px solid var(--vscode-canvas-select-window)'
        this.selectionBoxEl.style.background =
          'color-mix(in srgb, var(--vscode-canvas-select-window) 15%, transparent)'
        this.selectionTooltipEl.innerHTML = boxSelectIcon(false)
        this.selectionTooltipEl.style.color = 'var(--vscode-canvas-select-window)'
      }

      this.selectionTooltipEl.style.left = x1 - containerRect.left + 15 + 'px'
      this.selectionTooltipEl.style.top = y1 - containerRect.top + 15 + 'px'
      this.selectionTooltipEl.style.display = 'block'
    }

    if (this.crosshairEnabled && this.mode === '2d') {
      this.crosshairSeen = true
      if (!this.mouseSnapped.equals(this.crosshairLast)) {
        this.crosshairLast.copy(this.mouseSnapped)
        // The pan/drag branches above rendered already (and render() moves the
        // crosshair); a plain hover move has no other render, so without this
        // the crosshair would only catch up on the next unrelated redraw.
        if (!this.isPanning && !this.isDragging && !this.isDraggingVertex) this.render()
      }
    }

    if (this.onMouseMoveCallback) {
      this.onMouseMoveCallback(this.mouseWorld, this.mouseSnapped)
    }
  }

  private onMouseLeave(): void {
    this.pointerClient = null
    // KiCad drops the crosshair when the pointer leaves the canvas; a
    // crosshair parked at a stale snap point reads as a pending click.
    if (!this.crosshairSeen) return
    this.crosshairSeen = false
    this.crosshairLast.set(NaN, NaN)
    if (this.crosshairEnabled) this.render()
  }

  private onMouseUp(e: MouseEvent): void {
    const stayed = (from: { x: number; y: number } | null): boolean =>
      !!from && Math.hypot(e.clientX - from.x, e.clientY - from.y) < CLICK_SLOP_PX
    const click = stayed(this.modifierClick) ? this.modifierClick : null
    const viewClick = stayed(this.viewClick) ? this.viewClick : null
    this.viewClick = null
    const fit = e.button === 1 && stayed(this.pendingMiddleFit)
    if (e.button === 1) this.pendingMiddleFit = null
    const deselect = stayed(this.pendingDeselect) ? this.pendingDeselect : null
    const pick = stayed(this.pendingPick) ? this.pendingPick : null
    this.modifierClick = null
    this.pendingDeselect = null
    this.pendingPick = null
    this.dragPress = null
    this.clearHold()
    if (this.isPanning) {
      this.isPanning = false
      this.applyCursor()
      // Ctrl/Cmd+click: a pan that never moved toggles what it was pressed on.
      if (click) {
        const hit = this.selectableAt(click.event)
        if (hit) this.onSelectCallback?.(hit.type, hit.index, click.event)
      }
      if (viewClick)
        this.onViewClickCallback?.(this.clientToWorld(viewClick.event), viewClick.event)
    } else if ((this.isDragging && !this.heldDrag) || this.isDraggingVertex) {
      this.isDragging = false
      this.isDraggingVertex = false
      if (this.onDragEndCallback) {
        this.onDragEndCallback(dragModifiersOf(e))
      }
      // Shift+click on a selected item: a drag that never moved takes it out.
      if (deselect) this.onSelectCallback?.(deselect.type, deselect.index, deselect.event)
      this.render()
    } else if (this.isBoxSelecting) {
      this.isBoxSelecting = false
      this.selectionBoxEl.style.display = 'none'
      this.selectionTooltipEl.style.display = 'none'
      // A press on an item that never moved: a click on it.
      if (pick) {
        this.onSelectCallback?.(pick.type, pick.index, pick.event)
        this.render()
        return
      }
      // Ctrl+Shift+click: a remove band that never moved takes out what it was pressed on.
      if (click) {
        const hit = this.selectableAt(click.event)
        if (hit) this.onSelectCallback?.(hit.type, hit.index, click.event)
        return
      }

      const xMin = Math.min(this.boxStartWorld.x, this.mouseWorld.x)
      const xMax = Math.max(this.boxStartWorld.x, this.mouseWorld.x)
      const yMin = Math.min(this.boxStartWorld.y, this.mouseWorld.y)
      const yMax = Math.max(this.boxStartWorld.y, this.mouseWorld.y)
      const isCrossing = e.clientX - this.boxStartScreen.x < 0

      if (this.onBoxSelectCallback) {
        this.onBoxSelectCallback({ xMin, xMax, yMin, yMax }, isCrossing, e)
      }
    }
    if (fit) this.onResetViewCallback?.()
  }

  private onWheel(e: WheelEvent): void {
    if (this.mode !== '2d' || this.isPanning) return
    e.preventDefault()

    // On Linux, pressing the middle mouse button can fire a wheel event with
    // deltaY === 0. Ignore these so that middle-click only initiates panning.
    if (e.deltaY === 0) return

    const notchSize = NOTCH_PER_DELTA_MODE[e.deltaMode] ?? NOTCH_PER_DELTA_MODE[0]
    const gain = e.ctrlKey ? PINCH_GAIN : 1
    const notches = Math.max(
      -MAX_NOTCHES_PER_EVENT,
      Math.min(MAX_NOTCHES_PER_EVENT, (-e.deltaY / notchSize) * gain)
    )
    this.zoomAbout(Math.pow(ZOOM_STEP, notches), e.clientX, e.clientY)
  }

  /**
   * Scale the zoom by `factor`, keeping the world point under the client
   * position (a cursor) where it is on screen; with none, the view's center.
   */
  private zoomAbout(factor: number, clientX?: number, clientY?: number): void {
    const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoomFactor * factor))
    const rect = this.canvas.getBoundingClientRect()
    const anchored = clientX !== undefined && clientY !== undefined
    const ndcX = anchored ? ((clientX - rect.left) / rect.width) * 2 - 1 : 0
    const ndcY = anchored ? -((clientY - rect.top) / rect.height) * 2 + 1 : 0
    const before = new THREE.Vector3(ndcX, ndcY, 0).unproject(this.camera2D)

    this.markViewFramedByUser()
    this.zoomFactor = newZoom
    this.update2DCameraFrustum()

    // Shift the camera so the anchor lands back under the same screen point.
    const after = new THREE.Vector3(ndcX, ndcY, 0).unproject(this.camera2D)
    this.camera2D.position.x += before.x - after.x
    this.camera2D.position.y += before.y - after.y

    this.updateGridUniforms()
    this.render()
    this.notifyViewChanged()
  }

  /**
   * KiCad's Zoom In / Out at Cursor (Ctrl/Cmd + = / -): two wheel notches a
   * press, about the pointer while it is over the canvas, else the center.
   */
  public zoomStep(direction: 1 | -1): void {
    if (this.mode !== '2d' || this.isPanning) return
    const at = this.pointerClient
    this.zoomAbout(Math.pow(ZOOM_STEP, 2 * direction), at?.x, at?.y)
  }

  /**
   * KiCad's Center on Cursor (F4): the point under the pointer moves to the
   * middle of the view. KiCad warps the pointer along with it; a page cannot,
   * so the pointer stays and the world under it is read afresh.
   */
  public centerOnCursor(): void {
    const at = this.pointerClient
    if (this.mode !== '2d' || this.isPanning || !at) return
    this.markViewFramedByUser()
    this.camera2D.position.x = this.mouseWorld.x
    this.camera2D.position.y = this.mouseWorld.y
    this.camera2D.updateMatrixWorld()
    this.onMouseMove(new MouseEvent('mousemove', { clientX: at.x, clientY: at.y }))
    this.updateGridUniforms()
    this.render()
    this.notifyViewChanged()
  }

  /**
   * A picked finding, at world (x, y): centered at the current zoom, or with
   * `zoom`, framed `extent` mm across — as the user's own frame either way.
   */
  public showPoint(x: number, y: number, zoom: boolean, extent: number): void {
    if (this.mode !== '2d') return
    if (zoom) {
      const half = extent / 2
      this.frameBounds(
        new THREE.Box3(
          new THREE.Vector3(x - half, y - half, 0),
          new THREE.Vector3(x + half, y + half, 0)
        ),
        extent
      )
      return
    }
    this.markViewFramedByUser()
    this.camera2D.position.x = x
    this.camera2D.position.y = y
    this.camera2D.updateMatrixWorld()
    this.updateGridUniforms()
    this.render()
    this.notifyViewChanged()
  }

  /** Zoom to fit `bounds` as the user's own frame — zoom to selection. */
  public frameBounds(bounds: THREE.Box3, minExtent = 0): void {
    if (this.mode !== '2d' || bounds.isEmpty()) return
    this.zoomToFit(bounds, minExtent)
    this.markViewFramedByUser()
    this.notifyViewChanged()
  }

  // ---------------------------------------------------------------------------
  // Geometry Snap Math
  // ---------------------------------------------------------------------------

  public snapPoint(pt: THREE.Vector2): THREE.Vector2 {
    const spacing = spacingToMm(this.gridSettings.spacing, this.gridSettings.unit)
    return new THREE.Vector2(
      snapToGrid(pt.x, spacing, this.gridOrigin.x),
      snapToGrid(pt.y, spacing, this.gridOrigin.y)
    )
  }

  /**
   * A drag's snapped delta along one axis. Measured from the grid origin, so a
   * shifted grid moves things onto its own lines.
   */
  private snapCoordinateWithStart(
    absoluteStart: number,
    mouseDelta: number,
    spacingUnits: number,
    origin: number
  ): number {
    const startVal = absoluteStart - origin
    const spacing = spacingToMm(spacingUnits, this.gridSettings.unit)

    if (spacing <= 0) return mouseDelta

    const desiredVal = startVal + mouseDelta

    // If startVal is already on the grid, just snap desiredVal directly.
    // Both sides are integer nanometers under the mm floats (the domain is
    // integer-nm and grid steps are whole nm), so the test is exact there.
    const startNm = Math.round(startVal * 1e6)
    const stepNm = Math.round(spacing * 1e6)
    const isOnGrid = stepNm > 0 && startNm % stepNm === 0
    if (isOnGrid) {
      const snappedVal = Math.round(desiredVal / spacing) * spacing
      return snappedVal - startVal
    }

    // Find adjacent grid points to startVal
    const gLeft = Math.floor(startVal / spacing) * spacing
    const gRight = Math.ceil(startVal / spacing) * spacing

    // Midpoints
    const mLeft = (startVal + gLeft) / 2
    const mRight = (startVal + gRight) / 2

    if (desiredVal >= mLeft && desiredVal <= mRight) {
      // Snaps to startVal (delta = 0)
      return 0
    }

    // Otherwise, snap to standard grid
    const snappedVal = Math.round(desiredVal / spacing) * spacing
    return snappedVal - startVal
  }

  // ---------------------------------------------------------------------------
  // Callbacks hooks & selections
  // ---------------------------------------------------------------------------

  public setSelectedKeys(keys: Set<string>): void {
    this.currentlySelectedKeys = keys
  }

  /**
   * Abandon a drag in progress without a drop. The button is still down; its
   * release then lands nowhere. False when nothing was being dragged.
   */
  public cancelDrag(): boolean {
    this.clearHold()
    this.dragPress = null
    if (!this.isDragging && !this.isDraggingVertex) return false
    this.isDragging = false
    this.isDraggingVertex = false
    this.heldDrag = false
    this.render()
    return true
  }

  /**
   * Start an object drag with no button held — KiCad's Move (M) and Drag (G)
   * hotkeys: what the caller's drag-start picks up attaches to the pointer by
   * its grab anchor (`grabAnchor`) at once, the next left click drops it
   * through the ordinary drag-end, and `cancelDrag` abandons it. False when a
   * drag is already running.
   */
  public beginHeldDrag(info: Record<string, unknown>): boolean {
    if (this.isDragging || this.isDraggingVertex || this.mode !== '2d') return false
    this.grabAt(this.grabAnchor())
    this.isDragging = true
    this.heldDrag = true
    this.onDragStartCallback?.('object', info)
    this.emitObjectDrag(NO_MODIFIERS)
    return true
  }

  /**
   * Where a move grabs what it moves, KiCad's `BestDragOrigin`: the moved
   * items' anchor nearest the pointer — which, KiCad warping the pointer onto
   * it, then rides under the cursor. Items with no anchors move relative to the
   * snapped pointer.
   */
  private grabAnchor(): THREE.Vector2 {
    return (
      nearestTo(this.mouseWorld, this.dragAnchorsCallback?.() ?? []) ??
      this.dragTarget({ ...NO_MODIFIERS, shift: true })
    )
  }

  /** A move starts: what it grabbed, and what it may snap to while it runs. */
  private grabAt(anchor: THREE.Vector2): void {
    this.pivotStartPos.set(anchor.x, anchor.y, 0)
    this.dragTargets = this.dragTargetsCallback?.() ?? []
  }

  /**
   * Where a move's grab anchor goes for the pointer now, KiCad's
   * `BestSnapAnchor`: another item's anchor within reach (`onDragTargets`;
   * Shift turns it off), else the grid (Ctrl turns it off), else the pointer.
   */
  private dragTarget(modifiers: DragModifiers): THREE.Vector2 {
    const raw = this.mouseWorld.clone()
    const spacing = this.dragSpacing()
    const grid = this.gridSettings.snap && !modifiers.ctrl
    if (!modifiers.shift) {
      const reach = DRAG_SNAP_REACH_PX / this.zoomFactor
      const near = nearestTo(raw, this.dragTargets)
      if (near && near.distanceTo(raw) <= (grid ? Math.min(reach, spacing) : reach))
        return near.clone()
    }
    if (!grid) return raw
    return new THREE.Vector2(
      snapToGrid(raw.x, spacing, this.gridOrigin.x),
      snapToGrid(raw.y, spacing, this.gridOrigin.y)
    )
  }

  /** The grid a move snaps on, mm: the selection's override (`onDragGrid`), else the editor's. */
  private dragSpacing(): number {
    return (
      this.dragGridCallback?.() ?? spacingToMm(this.gridSettings.spacing, this.gridSettings.unit)
    )
  }

  /** An object drag's delta: its grab anchor to where the pointer now puts it. */
  private emitObjectDrag(modifiers: DragModifiers): void {
    const target = this.dragTarget(modifiers)
    // The crosshair and the readouts show where the anchor lands.
    this.mouseSnapped.copy(target)
    this.onDragMoveCallback?.(
      new THREE.Vector2(target.x - this.pivotStartPos.x, target.y - this.pivotStartPos.y),
      modifiers
    )
    this.render()
  }

  /** Where the running move grabbed what it moves, world space, before it moved; null when none runs. */
  public dragAnchorStart(): THREE.Vector2 | null {
    return this.isDragging ? new THREE.Vector2(this.pivotStartPos.x, this.pivotStartPos.y) : null
  }

  /**
   * The moved items' anchors, world space (KiCad's `BestDragOrigin`
   * candidates): read when a move starts, from the selection.
   */
  public onDragAnchors(callback: () => THREE.Vector2[]): void {
    this.dragAnchorsCallback = callback
  }

  /**
   * The anchors of items a move may snap to (KiCad's magnetic snapping), world
   * space, read when it starts. Editors without one snap to the grid alone.
   */
  public onDragTargets(callback: () => THREE.Vector2[]): void {
    this.dragTargetsCallback = callback
  }

  /** The grid the selection moves on, mm, when not the editor's (KiCad's grid overrides). */
  public onDragGrid(callback: () => number | null): void {
    this.dragGridCallback = callback
  }

  public onDragStart(
    callback: (type: 'object' | 'vertex', info?: Record<string, unknown>) => void
  ): void {
    this.onDragStartCallback = callback
  }

  public onDragMove(callback: (totalDelta: THREE.Vector2, modifiers: DragModifiers) => void): void {
    this.onDragMoveCallback = callback
  }

  public onDragEnd(callback: (modifiers: DragModifiers) => void): void {
    this.onDragEndCallback = callback
  }

  public onBoxSelect(
    callback: (
      bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
      isCrossing: boolean,
      e: MouseEvent
    ) => void
  ): void {
    this.onBoxSelectCallback = callback
  }

  public onSelect(
    callback: (type: string | null, index: number | null, event: MouseEvent) => void
  ): void {
    this.onSelectCallback = callback
  }

  public onMouseMoveCoords(
    callback: (worldPos: THREE.Vector2, snappedPos: THREE.Vector2) => void
  ): void {
    this.onMouseMoveCallback = callback
  }

  /**
   * A left click on a view-only canvas (`setViewOnly`): a press that pans, let
   * go where it began. Where it landed, in world space; what is there is the
   * host's question, since a view-only canvas selects nothing itself.
   */
  public onViewClick(callback: (world: THREE.Vector2, event: MouseEvent) => void): void {
    this.onViewClickCallback = callback
  }

  /** Fired on a middle-button double-click (reset view to fit content). */
  public onResetView(callback: () => void): void {
    this.onResetViewCallback = callback
  }

  /**
   * Told whenever the 2D camera moves under a frame the user owns. The engine's
   * own opening fit is not one of those, so a document nobody has touched is
   * never remembered as having been framed — it re-fits when it is next opened,
   * which is what a fit is for.
   */
  public onViewChanged(callback: () => void): void {
    this.onViewChangedCallback = callback
  }

  private notifyViewChanged(): void {
    if (this.viewFramedByUser) this.onViewChangedCallback?.()
  }

  public setCustomHitTest(
    callback: (point: THREE.Vector2, threshold: number) => CustomHitResult | null
  ): void {
    this.customHitTestCallback = callback
  }

  /**
   * What the raycast fallback may select, once the custom hit test has found
   * nothing: a scene whose own test applies the selection filter holds the
   * fallback to it too, or a click past the filter lands on a fill's anchor.
   */
  public setRaycastFilter(filter: (type: string, index: number) => boolean): void {
    this.raycastFilter = filter
  }
  private raycastFilter?: (type: string, index: number) => boolean

  /**
   * Fit the camera to the given bounds. `minExtent` (world mm) floors the
   * framed area per axis, so fitting something tiny — a lone symbol, a single
   * component — lands at a comfortable zoom instead of filling the screen.
   */
  public zoomToFit(bounds: THREE.Box3, minExtent = 0, padding = VIEW_FIT_PADDING): void {
    if (bounds.isEmpty()) return

    const size = new THREE.Vector3()
    bounds.getSize(size)

    const center = new THREE.Vector3()
    bounds.getCenter(center)

    // Position camera at center
    this.camera2D.position.set(center.x, center.y, 100)

    // Calculate optimal zoom factor; the default 30% border is what a person
    // wants after a fit, a capture framed by its caller wants none.
    const widthFit = this.container.clientWidth / (Math.max(size.x, minExtent) * padding)
    const heightFit = this.container.clientHeight / (Math.max(size.y, minExtent) * padding)

    // Avoid infinity or zero bounds fit
    const rawZoom = Math.min(widthFit, heightFit)
    this.zoomFactor = Math.min(
      this.maxZoom,
      Math.max(this.minZoom, isNaN(rawZoom) ? 40.0 : rawZoom)
    )

    this.update2DCameraFrustum()

    this.updateGridUniforms()
    this.render()
  }

  /**
   * Reveal `bounds` while keeping as much of the current view as it can:
   * nothing moves if it is already in sight, a pan if it is not, a zoom OUT
   * only if it cannot fit as framed. `bringIntoView.ts` holds the rule and the
   * reasoning; this applies its answer.
   *
   * Returns which of the three happened, for a caller that wants to react to a
   * reveal that moved nothing.
   */
  public bringIntoView(bounds: THREE.Box3, options: BringIntoViewOptions = {}): BringIntoViewMove {
    if (bounds.isEmpty() || this.mode !== '2d') return { kind: 'none' }

    const insets = options.insets ?? NO_INSETS
    const target = {
      minX: bounds.min.x,
      minY: bounds.min.y,
      maxX: bounds.max.x,
      maxY: bounds.max.y
    }

    // A view the engine composed on its own is not one the user is attached
    // to, so a probe arriving on it frames the part outright — the reveal a
    // freshly opened tab wants.
    //
    // And then the frame it just made counts as theirs, so the NEXT probe is
    // decided by the rule proper. Without that, a pane nobody has touched
    // re-fits on every click, which is the behaviour this replaced.
    if (!this.viewFramedByUser) {
      this.zoomToFit(bounds, options.minExtent ?? 0, options.padding ?? VIEW_FIT_PADDING)
      this.markViewFramedByUser()
      return { kind: 'fit', ...this.getCameraState2D() }
    }

    const move = bringIntoViewMove({
      target,
      visible: this.visibleWorldBox(),
      zoom: this.zoomFactor,
      viewport: { width: this.container.clientWidth, height: this.container.clientHeight },
      insets,
      minExtent: options.minExtent,
      padding: options.padding,
      minZoom: this.minZoom
    })

    // Applied outright, never glided. A reveal pans the whole field of view
    // under someone who did not move it themselves, which is the shape of
    // motion that provokes nausea in people sensitive to it — and the shape a
    // cut does not have, being over before there is anything to disagree with.
    // KiCad cuts too. If this is ever revisited it needs a motion preference
    // of its OWN, not just the OS-level `prefers-reduced-motion` the mode
    // transitions honour: "animate the app" and "throw the board across the
    // screen when I click a part" are not the same question, and one switch
    // cannot answer both (split-view-workstream.md §6).
    if (move.kind !== 'none') {
      this.setCameraState2D({
        x: move.x,
        y: move.y,
        zoom: move.kind === 'fit' ? move.zoom : this.zoomFactor
      })
      this.render()
    }
    return move
  }

  /**
   * Say that the view on screen is the user's own — after their zoom-to-fit,
   * or after restoring the camera they left a board at. Pan and wheel mark
   * themselves; anything else that means "this frame is theirs" says so here.
   */
  public markViewFramedByUser(): void {
    this.viewFramedByUser = true
  }

  /** Forget the user's frame: the next reveal may compose one from scratch. */
  public clearUserFramedView(): void {
    this.viewFramedByUser = false
  }

  /**
   * Scene objects that must hold a constant ON-SCREEN size — drag handles and
   * the like, which are chrome rather than document content and so should not
   * grow with zoom. Driven from `render()` and only when the zoom actually
   * changed, since the engine re-renders on every pan and drag frame too.
   */
  public registerScreenScaled(target: ScreenScaled): void {
    this.screenScaled.add(target)
    target.setWorldPerPixel(1 / this.zoomFactor)
  }

  public unregisterScreenScaled(target: ScreenScaled): void {
    this.screenScaled.delete(target)
  }

  private updateScreenScaled(): void {
    if (this.screenScaled.size === 0 || this.zoomFactor === this.lastScaledZoom) return
    this.lastScaledZoom = this.zoomFactor
    const worldPerPixel = 1 / this.zoomFactor
    for (const target of this.screenScaled) target.setWorldPerPixel(worldPerPixel)
  }

  public getCameraState2D(): { x: number; y: number; zoom: number } {
    return {
      x: this.camera2D.position.x,
      y: this.camera2D.position.y,
      zoom: this.zoomFactor
    }
  }

  public setCameraState2D(state: { x: number; y: number; zoom: number }): void {
    this.camera2D.position.set(state.x, state.y, 100)
    this.zoomFactor = state.zoom
    this.update2DCameraFrustum()
    this.updateGridUniforms()
    this.notifyViewChanged()
  }

  /**
   * Project a scene/world point to client (page) pixel coordinates — the same
   * space Playwright's `page.mouse` uses. Exposed for the test-hook bridge so an
   * automation runner can click a known board position without pixel-hunting the
   * canvas. 2D views only (the ortho camera is what selection runs against).
   */
  public worldToScreen(x: number, y: number): { x: number; y: number } {
    const ndc = new THREE.Vector3(x, y, 0).project(this.activeCamera)
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Render / Destroy
  // ---------------------------------------------------------------------------

  /**
   * Draw the view. Called while an input event is being handled, it draws once
   * on the next animation frame instead (`inFrame`); otherwise it draws now,
   * and a frame already asked for is dropped.
   */
  public render(): void {
    if (this.inInput) {
      this.pendingFrame ??= requestAnimationFrame(() => {
        this.pendingFrame = null
        this.render()
      })
      return
    }
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame)
      this.pendingFrame = null
    }
    if (this.mode === '2d' && this.gridPlane) {
      this.gridPlane.position.x = this.camera2D.position.x
      this.gridPlane.position.y = this.camera2D.position.y
    }
    // Before the camera key below is taken: the depth range is part of the
    // projection this frame is drawn with.
    if (this.mode === '3d') this.update3DDepthRange()
    this.updateScreenScaled()
    this.syncBatchPixelSize()
    this.renderer.getDrawingBufferSize(primitiveBatchUniforms.uResolution.value)
    primitiveBatchUniforms.uSnapStrokes.value = this.mode === '2d' ? 1 : 0
    const overlayActive = this.mode === '2d' && this.overlayHasContent()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false

    const visibleComposites =
      this.mode === '2d' ? this.compositeLayers.filter((layer) => layer.visible) : []
    if (visibleComposites.length > 0) {
      this.ensureCompositeResources(visibleComposites.length)
      for (let i = 0; i < visibleComposites.length; i++) {
        const target = this.compositeTargets[i]
        this.renderer.setRenderTarget(target)
        this.renderer.setClearColor(this.overlayClearColor, 0)
        this.renderer.clear(true, false, false)
        this.renderer.render(visibleComposites[i].scene, this.activeCamera)
      }
      this.renderer.setRenderTarget(null)
    }

    if (overlayActive) {
      // Flatten the overlay content (drawn opaque) offscreen.
      const target = this.ensureOverlayTarget()
      this.renderer.setRenderTarget(target)
      this.renderer.setClearColor(this.overlayClearColor, 0)
      this.renderer.clear(true, true, false)
      this.renderer.render(this.overlayScene, this.activeCamera)
      this.renderer.setRenderTarget(null)
    }

    const renderLayerActive = this.renderLayerActive()
    const layerCamera = renderLayerActive ? this.renderLayerCamera() : this.activeCamera
    if (renderLayerActive) {
      // Crosshair and selection updates also call render(). Only camera motion
      // invalidates a static assembly projection, so compare the handful of
      // orthographic values rather than repainting a dense PBR scene each time.
      // The 3D view turns, which those values do not record: its key is the
      // whole pose, in either projection.
      const c = layerCamera
      const cameraKey =
        this.mode === '2d' && c instanceof THREE.OrthographicCamera
          ? [c.position.x, c.position.y, c.position.z, c.left, c.right, c.top, c.bottom].join('|')
          : c.matrixWorld.elements.join('|') + c.projectionMatrix.elements.join('|')
      if (cameraKey !== this.renderLayerCameraKey) {
        this.renderLayerCameraKey = cameraKey
        this.renderLayerDirty = true
      }
    }
    if (renderLayerActive) {
      // Drawn offscreen so overlapping model meshes and their contact shadows
      // composite once at one uniform assembly-overlay opacity.
      const target = this.ensureRenderLayerResources()
      // These passes render linear HDR into half-float targets; the tone
      // mapping and output encode happen at the compositing quad below, the
      // only draw the renderer applies them to.
      if (this.renderLayerDirty) {
        // The far side first, alone, into its own image — see setRenderLayerFar.
        // Split by hiding rather than by scene, because the lighting and the
        // environment belong to the one scene both halves are lit by.
        const far = this.renderLayerFar
        const separateFarPass = this.farPassActive()
        if (separateFarPass && far) {
          const near = this.renderLayerNear
          if (near) near.visible = false
          this.renderer.setRenderTarget(this.ensureRenderLayerFarTarget())
          this.renderer.setClearColor(this.overlayClearColor, 0)
          this.renderer.clear(true, true, false)
          this.renderer.render(this.renderLayerScene, layerCamera)
          if (near) near.visible = true
        }

        // Then the near side. The far half is held out of it whenever it is not
        // meant to draw at full strength — either because it had its own pass
        // above, or because it is hidden outright.
        const holdFar = !!far && (separateFarPass || this.renderLayerFarScale === 0)
        if (holdFar && far) far.visible = false
        this.renderer.setRenderTarget(target)
        this.renderer.setClearColor(this.overlayClearColor, 0)
        this.renderer.clear(true, true, false)
        this.renderer.render(this.renderLayerScene, layerCamera)
        if (holdFar && far) far.visible = true

        this.renderer.setRenderTarget(null)
        this.renderLayerDirty = false
      }
    }

    // Layer stack, bottom to top: background → grid → composite layers →
    // flattened overlay at uniform opacity → document → physical render layer
    // → preview layers (each flattened, then laid down once) → snapped-cursor
    // crosshair (cursor feedback belongs above what it points at).
    this.renderer.setClearColor(this.backgroundColor, this.mode === '3d' ? 0 : 1)
    this.renderer.clear(true, true, true)
    if (this.mode === '2d') this.renderer.render(this.gridScene, this.activeCamera)
    if (visibleComposites.length > 0 && this.compositeQuadScene && this.compositeQuadMaterial) {
      const uniforms = this.compositeQuadMaterial.uniforms
      for (let i = 0; i < visibleComposites.length; i++) {
        uniforms.tCoverage.value = this.compositeTargets[i].texture
        uniforms.uColor.value.copy(visibleComposites[i].color)
        uniforms.uOpacity.value = visibleComposites[i].opacity
        this.renderer.render(this.compositeQuadScene, this.overlayQuadCamera)
      }
    }
    const splitZ =
      overlayActive && this.mode === '2d' && this.liftSplitZ !== null ? this.liftSplitZ : null
    if (this.mode === '3d') {
      // Full preview uses only the physical scene. The editable document stays
      // resident so returning to Layout is a camera/presentation switch.
    } else if (splitZ === null) {
      if (overlayActive) {
        this.renderer.render(this.overlayQuadScene, this.overlayQuadCamera)
      }
      this.renderer.render(this.scene, this.activeCamera)
    } else {
      // Split render: the document draws TWICE around the flattened overlay
      // quad, clipped by the camera's near/far planes at the split — so the
      // selection halo covers unselected content while everything z-lifted by
      // selection (and the vertex-handle chrome above the split) stays on top
      // of the halo. The depth buffer is cleared between passes: the two
      // projections map depth differently, and the lifted pass must win
      // everywhere regardless.
      const camera = this.camera2D
      const defaultNear = camera.near
      const defaultFar = camera.far
      const splitDistance = camera.position.z - splitZ
      camera.near = splitDistance
      camera.updateProjectionMatrix()
      this.renderer.render(this.scene, camera)
      this.renderer.render(this.overlayQuadScene, this.overlayQuadCamera)
      this.renderer.clear(false, true, false)
      camera.near = defaultNear
      camera.far = splitDistance
      camera.updateProjectionMatrix()
      this.renderer.render(this.scene, camera)
      camera.far = defaultFar
      camera.updateProjectionMatrix()
    }
    if (renderLayerActive && this.renderLayerQuadScene && this.renderLayerQuadMaterial) {
      const uniforms = this.renderLayerQuadMaterial.uniforms
      const opacity = this.renderLayerOpacity * this.physicalTransitionOpacity
      // Component materials are PBR; the rest of the document is not
      // tone-mapped and must not start being, so the operator is set only for
      // these two draws. Neutral preserves recognizable component colors in
      // the technical top-down overlay better than the cinematic shoulder of
      // ACES, which the full 3D view gets.
      const previousToneMapping = this.renderer.toneMapping
      this.renderer.toneMapping = this.mode === '3d' ? BOARD_TONE_MAPPING : THREE.NeutralToneMapping
      // Far side first and fainter, so the near side lands on top of a finished
      // image of what is behind the board rather than blending into it.
      if (this.farPassActive() && this.renderLayerFarTarget) {
        uniforms.tLayer.value = this.renderLayerFarTarget.texture
        uniforms.uOpacity.value = opacity * this.renderLayerFarScale
        this.renderer.render(this.renderLayerQuadScene, this.overlayQuadCamera)
      }
      uniforms.tLayer.value = this.renderLayerTarget?.texture ?? null
      uniforms.uOpacity.value = opacity
      this.renderer.render(this.renderLayerQuadScene, this.overlayQuadCamera)
      this.renderer.toneMapping = previousToneMapping
    }
    this.renderPreviewLayers()
    this.updateCrosshair()
    if (this.crosshairLines?.visible) {
      this.renderer.render(this.crosshairScene, this.activeCamera)
    }
    if (window.api?.testHooks) {
      this.canvas.dataset.viewportMode = this.mode
      this.canvas.dataset.camera3d = this.camera3D.position.toArray().join(',')
      this.canvas.dataset.cameraFlight = String(this.cameraFlight)
    }
    this.renderer.autoClear = previousAutoClear
  }

  public destroy(): void {
    if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame)
    this.pendingFrame = null
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }

    this.clearHold()
    for (const listener of this.pressListeners)
      this.container.removeEventListener('mousedown', listener, true)
    this.pressListeners = []
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown)
    this.canvas.removeEventListener('mousedown', this.boundMouseDown)
    this.canvas.removeEventListener('mousemove', this.boundMouseMove)
    this.canvas.removeEventListener('mouseleave', this.boundMouseLeave)
    window.removeEventListener('mouseup', this.boundMouseUp)
    this.canvas.removeEventListener('wheel', this.boundWheel)
    this.canvas.removeEventListener('contextmenu', preventDefault)

    if (this.selectionBoxEl && this.selectionBoxEl.parentNode) {
      this.container.removeChild(this.selectionBoxEl)
    }
    if (this.selectionTooltipEl && this.selectionTooltipEl.parentNode) {
      this.container.removeChild(this.selectionTooltipEl)
    }

    if (this.crosshairLines) {
      this.crosshairLines.geometry.dispose()
      ;(this.crosshairLines.material as THREE.Material).dispose()
    }
    this.overlayTarget?.dispose()
    this.overlayQuadMaterial.dispose()
    // The render layer's root belongs to the caller; only our own quad and
    // target are ours to release.
    this.renderLayerTarget?.dispose()
    this.renderLayerQuadMaterial?.dispose()
    this.renderLayerEnv?.dispose()
    for (const target of this.compositeTargets) target.dispose()
    this.flattenBuffer?.dispose()
    this.flattenBuffer = null
    this.renderLayerFarTarget?.dispose()
    this.renderLayerFarTarget = null
    this.flattenQuadMaterial?.dispose()
    this.compositeQuadMaterial?.dispose()
    this.transitionRun++
    this.clearTransitionCapture()
    this.transitionImage?.remove()
    this.transitionImage = null
    this.releaseControls()
    releaseSharedAtlas()
    this.renderer.dispose()
    // Release the WebGL context now instead of when the canvas is GC'd —
    // Chromium keeps every live context's GPU allocations, and only ~16
    // contexts exist before the oldest are force-lost anyway
    this.renderer.forceContextLoss()
    this.container.removeChild(this.canvas)
  }
}
