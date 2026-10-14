/**
 * A picture of a board, for a model that cannot see the editor.
 *
 * The board twin of `schematicCapture.ts` and `footprintCapture.ts`: one
 * `ViewportEngine` on a container nobody sees, one `BoardScene` rebuilt from
 * whatever board is asked for, and the engine's own `captureFramed` for the
 * picture — so it is what the PCB editor would draw, at the resolution asked
 * for. One engine for the window's lifetime, made on first use, for the reason
 * the other two give: a WebGL context per capture would evict the editor's.
 *
 * Each capture draws into a scene of its own, because a picture waits for its
 * own zone fills to triangulate (`BoardScene.finishFills`) and two renders in
 * flight must not redraw each other's scene during that wait.
 *
 * Every board is drawn here, including the one a tab has open. The editor's
 * scene carries the session's own state — selection, a route in flight, the
 * layer the user is on — and a picture is an audit of the DOCUMENT, so it is
 * drawn from the parsed board instead, in the display the request names.
 */
import * as THREE from 'three'
import { ViewportEngine } from './ViewportEngine'
import { BoardScene, type BoardDisplayOptions, type BoardEditDelta } from './BoardScene'
import { currentAppTheme } from '../theme'
import type { KicadBoard } from '../kicad/board'
import type { SExprNode } from '../kicad/sexpr'
import type { RouteOverlay, RouteWorkScene } from '../board/routeAgent'
import type { AgentCapture, WorldBox } from '../schematic/schematicAgent'
import { computeConnectivity } from '../board/boardConnectivity'
import { loadClipper } from '../geometry/clip'
import { BoardSpatialIndex } from '../board/spatialIndex'
import { DIM_ALPHA_FACTOR, PCB_LAYER_STACK, isCopperLayer } from '../kicad/layers'

/** mm; keeps one 0402 framed alone from zooming to the pixel cap. */
export const BOARD_FIT_MIN_EXTENT = 5

/** mm around the footprints a `footprints` frame names: room for their silk. */
export const BOARD_FRAME_MARGIN = 2

/** ms a picture waits for the zone fills its own drawing triangulates off the main thread. */
export const FILL_FINISH_MS = 10_000

let headless: ViewportEngine | null = null

const ensureHeadless = (): ViewportEngine => {
  if (headless) return headless
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-100000px'
  container.style.top = '0'
  container.style.width = '256px'
  container.style.height = '256px'
  container.style.overflow = 'hidden'
  container.style.pointerEvents = 'none'
  container.setAttribute('aria-hidden', 'true')
  document.body.appendChild(container)
  headless = new ViewportEngine(container)
  return headless
}

export interface BoardCaptureRequest {
  /** Frame this rectangle, engine space (mm, y up). Wins over `footprints`. */
  box?: WorldBox | null
  /** Frame these footprints — indices into `board.footprints` — with a margin. */
  footprints?: readonly number[]
  /** Draw only these layers; absent draws every one. */
  layers?: readonly string[]
  /** Pour zone fills; absent draws zones as outlines, KiCad's outline-only mode. */
  fills?: boolean
  /** Drawn on top, the others dimmed to `dim`, as the canvas draws its active layer. */
  activeLayer?: string
  /** How much of a non-active layer survives, 0–1; read only with `activeLayer`. */
  dim?: number
  /** Draw the board from the back, mirrored, as the editor's flip does. */
  flipped?: boolean
  maxPixels: number
}

/**
 * The world box holding `indices`, inflated by the frame margin, or null when
 * the scene measured none of them (a footprint drawn on no visible layer).
 *
 * A scene measures a footprint in DATA space — `BoardScene.sx` mirrors x at
 * draw time, so the stored bounds never are — and the capture frames in world
 * space, so the flip is applied here. Negating reverses which x is the minimum,
 * which is why they swap (`boardBoxSelect` mirrors its band the same way).
 */
export const framedFootprintBox = (
  boundsOf: (index: number) => Bounds2D | undefined,
  indices: readonly number[],
  flipped: boolean
): WorldBox | null => {
  let box: WorldBox | null = null
  for (const index of indices) {
    const bounds = boundsOf(index)
    if (!bounds) continue
    const minX = flipped ? -bounds.maxX : bounds.minX
    const maxX = flipped ? -bounds.minX : bounds.maxX
    box = box
      ? {
          minX: Math.min(box.minX, minX),
          maxX: Math.max(box.maxX, maxX),
          minY: Math.min(box.minY, bounds.minY),
          maxY: Math.max(box.maxY, bounds.maxY)
        }
      : { minX, maxX, minY: bounds.minY, maxY: bounds.maxY }
  }
  if (!box) return null
  return {
    minX: box.minX - BOARD_FRAME_MARGIN,
    maxX: box.maxX + BOARD_FRAME_MARGIN,
    minY: box.minY - BOARD_FRAME_MARGIN,
    maxY: box.maxY + BOARD_FRAME_MARGIN
  }
}

/** A scene's measurement of one placed footprint, in data space. */
interface Bounds2D {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * The scene's display options for a capture. Zones are outlines unless asked
 * for; an active layer dims the rest (`BoardDisplayOptions.dimStrength`).
 */
export const captureDisplayOptions = (
  request: Pick<BoardCaptureRequest, 'fills' | 'activeLayer' | 'dim' | 'flipped'>
): BoardDisplayOptions => ({
  flipped: request.flipped ?? false,
  zoneFills: request.fills ?? false,
  ...(request.activeLayer
    ? { nonActiveDisplay: 'dim' as const, dimStrength: request.dim ?? DIM_ALPHA_FACTOR }
    : {})
})

const asBox3 = (box: WorldBox): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(box.minX, box.minY, 0), new THREE.Vector3(box.maxX, box.maxY, 0))

/**
 * Draw `board` into `scene` as a capture shows it, and finish the drawing: the
 * zone fills it hands to the triangulation workers land before this resolves,
 * or `unfinishedFills` says how many had not after `timeoutMs`. Fills, when
 * asked for, are drawn as stored; nothing is refilled.
 */
export const drawBoardForCapture = async (
  scene: BoardScene,
  board: KicadBoard,
  request: Pick<BoardCaptureRequest, 'layers' | 'flipped' | 'fills' | 'activeLayer' | 'dim'>,
  timeoutMs = FILL_FINISH_MS
): Promise<{ bounds: THREE.Box3; unfinishedFills: number }> => {
  scene.applyTheme(currentAppTheme())
  // A layer the scene is not told about is drawn, so a chosen few hide the rest by name.
  const visibility = request.layers
    ? Object.fromEntries(
        [...PCB_LAYER_STACK, ...board.layers.map((layer) => layer.name)].map((name) => [
          name,
          request.layers!.includes(name)
        ])
      )
    : undefined
  const bounds = scene.rebuild(
    board,
    visibility,
    request.activeLayer,
    captureDisplayOptions(request)
  )
  // The airwires the editor draws, from the same connectivity `board.describe`
  // counts `unrouted` with: what is still unrouted is most of what a placement
  // picture is read for. A picture of no copper has none to draw.
  const showsCopper = !request.layers || request.layers.some(isCopperLayer)
  scene.setRatsnest(
    showsCopper ? computeConnectivity(board, BoardSpatialIndex.build(board)).airwires : []
  )
  return { bounds, unfinishedFills: await scene.finishFills(timeoutMs) }
}

/**
 * Draw `board` framed to a box, to named footprints, or to everything it
 * holds, at up to `maxPixels` on the longest edge. Null when nothing could be
 * drawn.
 *
 * Asynchronous for two reasons, both waits on its own drawing: a custom pad is
 * drawn as the merged outline `padCopper.ts` builds with the boolean engine,
 * and zone fills not yet triangulated are computed off the main thread. An
 * editor draws both as they land; a picture waits for them.
 */
export const captureBoardDocument = async (
  board: KicadBoard,
  request: BoardCaptureRequest
): Promise<AgentCapture | null> => {
  await loadClipper()
  const engine = ensureHeadless()
  engine.applyTheme()
  const root = new THREE.Scene()
  const scene = new BoardScene(root)
  try {
    const { bounds, unfinishedFills } = await drawBoardForCapture(scene, board, request)
    const framed = request.box
      ? request.box
      : request.footprints?.length
        ? framedFootprintBox(
            (index) => scene.getFootprintBounds(index),
            request.footprints,
            request.flipped ?? false
          )
        : null
    const shot = engine.captureFramed(
      framed ? asBox3(framed) : bounds,
      BOARD_FIT_MIN_EXTENT,
      request.maxPixels,
      { scene: root }
    )
    return shot && unfinishedFills ? { ...shot, unfinishedFills } : shot
  } finally {
    scene.dispose()
  }
}

/** How a working view draws its board: the display options a person can toggle in the editor. */
export interface WorkSceneView {
  /** Layers drawn; absent draws every one. */
  layers?: readonly string[]
  activeLayer: string
  options: BoardDisplayOptions
}

/** A board command's change, for patching the scene in place (`BoardSession.lastChange`). */
export interface WorkSceneChange {
  fromBoard: KicadBoard
  raws: ReadonlySet<SExprNode>
}

/**
 * A routing session's own scene (`lib/board/routeAgent.ts`): built once from
 * the session's parsed board — no re-parse — patched in place by a command's
 * change, and swapped into the window's one capture engine for each picture,
 * since a second engine would be a second WebGL context. What it draws over
 * the board — the route, pushed copper, violations, the route's ratsnest — is
 * the live view's own overlay calls, so the picture is the editor's.
 */
export class BoardWorkScene implements RouteWorkScene {
  private readonly root = new THREE.Scene()
  readonly scene: BoardScene
  private board: KicadBoard | null = null
  /** The shown board's copper arrays as they stood, which its domain writes and remap leave behind. */
  private arrays: BoardEditDelta['prev'] | null = null
  private bounds: THREE.Box3 | null = null
  private viewKey = ''
  private editId = 0

  constructor() {
    this.scene = new BoardScene(this.root)
  }

  /** Draw `board` as `view` says: a rebuild when either changed, else the change patched in. */
  show(board: KicadBoard, view: WorkSceneView, change?: WorkSceneChange | null): void {
    const key = JSON.stringify(view)
    if (this.board === board && this.viewKey === key) return
    const from = this.board
    const prev = this.arrays
    const patched =
      this.viewKey === key &&
      from !== null &&
      prev !== null &&
      change?.fromBoard === from &&
      this.scene.applyBoardEdit(
        { id: ++this.editId, fromBoard: from, raws: change.raws, prev },
        board
      )
    if (!patched) {
      this.scene.applyTheme(currentAppTheme())
      const visibility = view.layers
        ? Object.fromEntries(
            [...PCB_LAYER_STACK, ...board.layers.map((layer) => layer.name)].map((name) => [
              name,
              view.layers!.includes(name)
            ])
          )
        : undefined
      this.bounds = this.scene.rebuild(board, visibility, view.activeLayer, view.options)
    }
    this.board = board
    this.arrays = {
      segments: board.segments.slice(),
      trackArcs: board.trackArcs.slice(),
      vias: board.vias.slice(),
      footprints: board.footprints.slice(),
      zones: board.zones.slice()
    }
    this.viewKey = key
  }

  /**
   * The picture of `box` (engine space), or of the whole board, at up to
   * `maxPixels` on its longest edge, the preview layers flattened as the live
   * view does.
   */
  async capture(box: WorldBox | null, maxPixels: number): Promise<AgentCapture | null> {
    await loadClipper()
    const unfinishedFills = await this.scene.finishFills(FILL_FINISH_MS)
    const engine = ensureHeadless()
    engine.applyTheme()
    const shot = engine.captureFramed(
      box ? asBox3(box) : this.bounds,
      BOARD_FIT_MIN_EXTENT,
      maxPixels,
      {
        scene: this.root,
        preview: this.scene.previewLayerSpecs()
      }
    )
    return shot && unfinishedFills ? { ...shot, unfinishedFills } : shot
  }

  /**
   * What a routing session draws over the board, through the live view's own
   * calls (PcbViewport2D's route preview): the route, pushed copper, what it
   * violates, and the ratsnest. `markHalfWidth` is a pixel in mm at the
   * picture's scale.
   */
  overlay(overlay: RouteOverlay, markHalfWidth: number): void {
    const s = this.scene
    s.setRatsnest(overlay.airwires)
    s.setRoutePreview(overlay.placed, overlay.head, overlay.vias)
    s.setShovePreview(overlay.hidden, overlay.pushed, overlay.pushedVias)
    s.setViolationMarks(overlay.marks, markHalfWidth)
    s.setRouteRatsnest(overlay.ratsnest)
  }

  /** Shots side by side, top-aligned, as one picture. */
  async tile(
    shots: readonly AgentCapture[]
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    const images = await Promise.all(
      shots.map(
        (shot) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => reject(new Error('A capture could not be decoded.'))
            image.src = shot.dataUrl
          })
      )
    )
    const gap = TILE_GAP
    const width = shots.reduce((sum, shot) => sum + shot.width, 0) + gap * (shots.length - 1)
    const height = Math.max(...shots.map((shot) => shot.height))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas to tile the captures on.')
    let x = 0
    images.forEach((image, i) => {
      context.drawImage(image, x, 0)
      x += shots[i].width + gap
    })
    return { dataUrl: canvas.toDataURL('image/png'), width, height }
  }

  dispose(): void {
    this.scene.dispose()
    this.board = null
    this.arrays = null
    this.bounds = null
  }
}

/** Pixels between the tiles of a tiled capture. */
const TILE_GAP = 8
