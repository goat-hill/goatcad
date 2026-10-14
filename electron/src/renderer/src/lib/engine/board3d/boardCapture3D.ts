/**
 * The agent's picture of a whole board in 3D: the scene the PCB editor's 3D
 * mode builds — substrate, copper, mask, silk, paste, parts — drawn off-screen
 * from any camera the caller names.
 *
 * Where `modelCapture.ts` answers "is this one part right" with fixed views,
 * this one is a render: the caller owns the camera, the size, what is shown,
 * the light and the background. Zoom 1 always fits what is framed, so a
 * request that names nothing is the whole board, filling the picture.
 *
 * It draws on the window's one headless 3D engine (`modelCapture.ts`) and
 * builds its own scene and model cache, so the editor's 3D pane — its camera,
 * its view options, its loaded parts — is never touched.
 */
import * as THREE from 'three'
import type { KicadBoard } from '../../kicad/board'
import { loadClipper } from '../../geometry/clip'
import { FRAME_BUDGET_MS, yieldControl } from '../../cooperate'
import { defaultBoard3DViewState, type Board3DViewState } from '../../board3dView'
import { nmToMm } from '../../kicad/coordinates'
import { captureBackground, boxInView, type CaptureLighting } from '../Viewport3DEngine'
import { BoardScene3D } from './BoardScene3D'
import { ComponentModelLoader, type ComponentModelProgress } from './componentModels'
import { BoardModelAssetCache } from './modelAssetCache'
import { ensureHeadless } from './modelCapture'
export { VIEW_BEARINGS } from './viewBearings'
import { MASK_COLORS, SILK_COLORS, resolveStackupColor } from './boardPalette'
import {
  BOARD_TONE_MAPPING,
  applyBoardLighting,
  applyShadowRoles,
  createBoardRig
} from './boardLighting'

/** From the target toward the camera, Z up, for a bearing in degrees. */
export const bearingDirection = (azimuth: number, elevation: number): THREE.Vector3 => {
  const az = (azimuth * Math.PI) / 180
  const el = (Math.max(-90, Math.min(90, elevation)) * Math.PI) / 180
  // Straight up or down keeps a sliver of -y, as the pane's presets do, so the
  // picture's up is the board's top edge.
  const flat = Math.abs(Math.cos(el)) < 1e-6 ? 1e-6 : Math.cos(el)
  return new THREE.Vector3(Math.sin(az) * flat, -Math.cos(az) * flat, Math.sin(el)).normalize()
}

/** Longest edge when the caller gives no size. */
export const BOARD3D_DEFAULT_PIXELS = 1600

/** The layers and part classes a render can switch, named as the 3D pane's options. */
export type Board3DShow = Partial<Board3DViewState>

export interface Board3DCaptureRequest {
  azimuth: number
  elevation: number
  roll?: number
  projection: 'orthographic' | 'perspective'
  fov?: number
  zoom: number
  /** Frame this box, board millimetres, y down. Wins over `footprints`. */
  box?: { x: number; y: number; width: number; height: number } | null
  /** Frame these parts, by reference. */
  footprints?: readonly string[]
  /** Look at this board point (millimetres, y down; z above the top face). */
  center?: { x: number; y: number; z?: number } | null
  width?: number
  height?: number
  show?: Board3DShow
  /** Leave these parts' models out. */
  hide?: readonly string[]
  /** Draw only these parts' models. */
  only?: readonly string[]
  lighting: CaptureLighting
  exposure?: number
  /** 'theme', 'transparent' or a CSS hex color. */
  background: string
  /** Finishes to draw instead of the stackup's. */
  mask?: string
  silk?: string
}

export interface Board3DCapture {
  dataUrl: string
  width: number
  height: number
  /** Orthographic only: one scale across the picture. */
  mmPerPixel: number | null
  /** Straight down or up, orthographic, unrolled: the board rectangle shown,
   *  millimetres, y down — read a coordinate off the picture with it. */
  frame: { x: number; y: number; width: number; height: number } | null
  models: ComponentModelProgress
  palette: { mask: string; silk: string; backSilk: string }
  /** Set when the GPU could not draw the size asked for. */
  clampedFrom?: { width: number; height: number }
}

export type Board3DCaptureResult =
  { ok: true; capture: Board3DCapture } | { ok: false; error: string; detail: string }

/** Placed parts by reference: the loader names each `component:<ref>`. */
const placedParts = (components: THREE.Object3D): Map<string, THREE.Object3D[]> => {
  const parts = new Map<string, THREE.Object3D[]>()
  components.traverse((object) => {
    const match = /^(?:component|standin):(.+)$/.exec(object.name)
    if (!match) return
    const list = parts.get(match[1]) ?? []
    list.push(object)
    parts.set(match[1], list)
  })
  return parts
}

/** A board footprint's own box, when it has no model to measure: its origin,
 *  a few millimetres round. */
const FOOTPRINT_FALLBACK_MM = 2.5

const parseBackground = (value: string): THREE.Color | null | 'invalid' => {
  if (value === 'transparent') return null
  if (value === 'theme') return captureBackground()
  return /^#[0-9a-f]{6}$/i.test(value) ? new THREE.Color(value) : 'invalid'
}

export const captureBoard3D = async (
  board: KicadBoard,
  boardPath: string | null,
  projectDir: string | null,
  request: Board3DCaptureRequest
): Promise<Board3DCaptureResult> => {
  const background = parseBackground(request.background)
  if (background === 'invalid')
    return {
      ok: false,
      error: 'invalid-args',
      detail: `${request.background} is not 'theme', 'transparent' or a #RRGGBB color.`
    }
  for (const [key, value, named] of [
    ['mask', request.mask, MASK_COLORS],
    ['silk', request.silk, SILK_COLORS]
  ] as const) {
    if (value && !resolveStackupColor(value, named))
      return {
        ok: false,
        error: 'invalid-args',
        detail: `${value} is not a ${key} finish: ${Object.keys(named).join(', ')}, or #RRGGBB.`
      }
  }
  const known = new Set(board.footprints.map((footprint) => footprint.reference ?? ''))
  const unknown = [
    ...(request.footprints ?? []),
    ...(request.hide ?? []),
    ...(request.only ?? [])
  ].filter((reference) => !known.has(reference))
  if (unknown.length)
    return {
      ok: false,
      error: 'reference-not-found',
      detail: `No footprint on this board is called ${[...new Set(unknown)].join(', ')}.`
    }

  const headless = ensureHeadless()
  if (!headless)
    return { ok: false, error: 'renderer-failed', detail: 'This window has no 3D context.' }

  await loadClipper()
  const options: Board3DViewState = { ...defaultBoard3DViewState(), ...request.show, gauge: false }
  const scene = new BoardScene3D()
  const cache = new BoardModelAssetCache()
  const loader = new ComponentModelLoader(scene.components, cache)
  try {
    // The pane's cooperative drain: a dense board builds without freezing the window.
    const steps = scene.buildSteps(board, options, { mask: request.mask, silk: request.silk })
    let sliceStart = performance.now()
    for (let step = steps.next(); !step.done; step = steps.next()) {
      if (performance.now() - sliceStart > FRAME_BUDGET_MS) {
        await yieldControl()
        sliceStart = performance.now()
      }
    }

    let models: ComponentModelProgress = { total: 0, placed: 0, missing: 0, missingLinks: [] }
    if (options.models) {
      const only = request.only?.length ? new Set(request.only) : null
      const hide = new Set(request.hide ?? [])
      const drawn =
        only || hide.size
          ? {
              ...board,
              footprints: board.footprints.filter((footprint) => {
                const reference = footprint.reference ?? ''
                return (!only || only.has(reference)) && !hide.has(reference)
              })
            }
          : board
      await loader.load(
        drawn,
        boardPath,
        projectDir,
        {
          tht: options.modelsThroughHole,
          smd: options.modelsSmd,
          unspecified: options.modelsUnspecified,
          dnp: options.modelsDnp,
          notInPosFiles: options.modelsNotInPosFiles
        },
        (progress) => {
          models = progress
        }
      )
    }

    const topZ = scene.thickness / 2
    let focus: THREE.Box3 | null = null
    if (request.box) {
      const { x, y, width, height } = request.box
      focus = new THREE.Box3(
        new THREE.Vector3(x, -(y + height), -topZ),
        new THREE.Vector3(x + width, -y, topZ)
      )
    } else if (request.footprints?.length) {
      const parts = placedParts(scene.components)
      focus = new THREE.Box3()
      for (const reference of request.footprints) {
        const placed = parts.get(reference)
        if (placed?.length) {
          for (const object of placed) focus.expandByObject(object)
          continue
        }
        const footprint = board.footprints.find((entry) => entry.reference === reference)
        if (!footprint) continue
        const cx = nmToMm(footprint.position.x)
        const cy = -nmToMm(footprint.position.y)
        focus.union(
          new THREE.Box3(
            new THREE.Vector3(cx - FOOTPRINT_FALLBACK_MM, cy - FOOTPRINT_FALLBACK_MM, -topZ),
            new THREE.Vector3(cx + FOOTPRINT_FALLBACK_MM, cy + FOOTPRINT_FALLBACK_MM, topZ)
          )
        )
      }
    }
    const target = request.center
      ? new THREE.Vector3(request.center.x, -request.center.y, request.center.z ?? topZ)
      : null

    const { engine } = headless
    // The pane's own light (`boardLighting.ts`), parts casting onto the board.
    applyShadowRoles(scene.root)
    const rig = createBoardRig()
    const environment = applyBoardLighting(rig, request.lighting)
    const exposure = request.exposure ?? 1
    for (const light of [rig.key, rig.overhead, rig.fill, rig.ambient]) light.intensity *= exposure
    scene.root.add(rig.group)
    engine.setModel(scene.root, false)
    rig.fitShadow(engine.contentBounds() ?? new THREE.Box3())
    try {
      const framed = focus && !focus.isEmpty() ? focus : engine.contentBounds()
      if (!framed)
        return {
          ok: false,
          error: 'nothing-drawn',
          detail:
            'Nothing is drawn: the board has no outline or parts, or show, only and box leave none in view.'
        }
      const direction = bearingDirection(request.azimuth, request.elevation)
      const size = captureSize(
        framed,
        direction,
        target ?? framed.getCenter(new THREE.Vector3()),
        request
      )
      const limit = engine.maxCaptureSize()
      const scale = Math.min(1, limit / Math.max(size.width, size.height))
      const width = Math.max(1, Math.floor(size.width * scale))
      const height = Math.max(1, Math.floor(size.height * scale))

      const shot = engine.captureView({
        direction,
        roll: request.roll,
        projection: request.projection,
        fov: request.fov,
        width,
        height,
        // Only a region the caller named; the whole board is fitted object by
        // object, which a box round all of it would overstate.
        focus: focus && !focus.isEmpty() ? focus : null,
        target,
        zoom: request.zoom,
        background,
        lighting: { custom: { environment: environment * exposure } },
        toneMapping: BOARD_TONE_MAPPING,
        shadows: true
      })
      if (!shot)
        return {
          ok: false,
          error: 'nothing-drawn',
          detail:
            'Nothing is drawn: the board has no outline or parts, or show, only and box leave none in view.'
        }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context)
        return { ok: false, error: 'renderer-failed', detail: 'No 2D canvas to encode the PNG.' }
      context.putImageData(shot.image, 0, 0)
      const palette = scene.getPalette()
      return {
        ok: true,
        capture: {
          dataUrl: canvas.toDataURL('image/png'),
          width,
          height,
          mmPerPixel: shot.mmPerPixel,
          frame: flatFrame(shot.camera, request),
          models,
          palette: { mask: palette.mask, silk: palette.silk, backSilk: palette.backSilk },
          ...(scale < 1 ? { clampedFrom: size } : {})
        }
      }
    } finally {
      // The engine disposes what it was handed, the scene's geometry and the
      // model clones with it; the cache below is this capture's alone.
      engine.setModel(null)
    }
  } finally {
    loader.dispose()
    scene.dispose()
    cache.dispose()
  }
}

/**
 * The picture's size: the caller's, or the framed content's own shape at the
 * default length when one or both sides are left open.
 */
const captureSize = (
  framed: THREE.Box3,
  direction: THREE.Vector3,
  target: THREE.Vector3,
  request: Board3DCaptureRequest
): { width: number; height: number } => {
  if (request.width && request.height) return { width: request.width, height: request.height }
  let halfX = 0
  let halfY = 0
  for (const corner of boxInView(framed, direction, target, request.roll ?? 0)) {
    halfX = Math.max(halfX, Math.abs(corner.x))
    halfY = Math.max(halfY, Math.abs(corner.y))
  }
  const aspect = Math.min(4, Math.max(0.25, halfX / Math.max(halfY, 1e-3)))
  if (request.width) return { width: request.width, height: Math.round(request.width / aspect) }
  if (request.height) return { width: Math.round(request.height * aspect), height: request.height }
  return aspect >= 1
    ? { width: BOARD3D_DEFAULT_PIXELS, height: Math.round(BOARD3D_DEFAULT_PIXELS / aspect) }
    : { width: Math.round(BOARD3D_DEFAULT_PIXELS * aspect), height: BOARD3D_DEFAULT_PIXELS }
}

/** The board rectangle a straight-down (or straight-up) orthographic picture
 *  shows, in board millimetres; null for any other camera. */
const flatFrame = (
  camera: THREE.Camera,
  request: Board3DCaptureRequest
): Board3DCapture['frame'] => {
  if (!(camera instanceof THREE.OrthographicCamera)) return null
  if (Math.abs(request.elevation) !== 90 || (request.roll ?? 0) % 360 !== 0) return null
  const round = (value: number): number => Math.round(value * 1000) / 1000
  // The frustum is off-axis (fitted to the content), so its edges are read
  // from the camera, not assumed symmetric. From below, screen right is world
  // -x; up is world +y either way, which the board's y-down negates.
  const { x: px, y: py } = camera.position
  const minX = request.elevation > 0 ? px + camera.left : px - camera.right
  const maxX = request.elevation > 0 ? px + camera.right : px - camera.left
  return {
    x: round(minX),
    y: round(-(py + camera.top)),
    width: round(maxX - minX),
    height: round(camera.top - camera.bottom)
  }
}

/**
 * Set the rig for a lighting preset; returns the environment intensity to draw
 * with. `studio` is the pane's rig unchanged.
 */
