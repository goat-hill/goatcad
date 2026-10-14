/**
 * The agent's picture of a 3D model: four fixed views in one PNG.
 *
 * Top catches a part turned
 * 180° and pin 1 on the wrong corner; front and right catch the ones a top
 * view cannot show at all — a model upside down, on its side, floating above
 * the board or sunk into it; the angled view is what a person recognizes the
 * part from. There are no camera options: what to frame is the caller's,
 * how to draw it is not (`agent-api.md`).
 *
 * All four tiles are drawn at one scale, so the bar under them measures every
 * one and the views can be compared with each other by eye.
 *
 * The 3D engine is headless and lives for the window, the reason
 * `footprintCapture.ts` gives: a WebGL context per capture would evict the
 * editor's.
 */
import * as THREE from 'three'
import { Viewport3DEngine, type ViewPreset } from '../Viewport3DEngine'
import { niceTickStep } from '../extentGauge'
import { board3dViewState } from '../../board3dView'
import { loadClipper } from '../../geometry/clip'
import type { KicadFootprint } from '../../kicad/footprint'
import { BoardScene3D } from './BoardScene3D'
import { ComponentModelLoader } from './componentModels'
import { boardFromFootprint } from './footprintBoard'
import { BoardModelAssetCache } from './modelAssetCache'

/** The views, in reading order of the 2×2 grid. */
export const MODEL_VIEWS: ViewPreset[] = ['top', 'front', 'right', 'iso']

/** What each tile's axes read as, in the footprint's own frame (y down). The
 *  angled view has no axis it can honestly label. */
const AXIS_LABEL: Partial<Record<ViewPreset, string>> = {
  top: 'x →   y ↓',
  front: 'x →   z ↑',
  right: 'y ←   z ↑'
}

/** Room around the part inside a tile, as a fraction of the tile. */
const TILE_PADDING = 0.12

export interface ModelCapture {
  dataUrl: string
  width: number
  height: number
  /** Millimeters per pixel, one scale for all four tiles. */
  mmPerPixel: number
  /** The bar drawn in each tile, in millimeters. */
  scaleBarMm: number
  views: ViewPreset[]
}

/**
 * Millimeters per pixel for a tile that must hold every view of a box.
 *
 * Each orthographic view shows two of the three dimensions, so the largest of
 * them decides the scale — and the angled view sees the diagonal, which is why
 * the bounding sphere is in the comparison too.
 */
export const commonScale = (
  size: { x: number; y: number; z: number },
  tilePixels: number
): number => {
  const diagonal = Math.hypot(size.x, size.y, size.z)
  const widest = Math.max(size.x, size.y, size.z, diagonal, 0.1)
  return widest / (tilePixels * (1 - 2 * TILE_PADDING))
}

/** A round bar, 1/5 of a tile or so, that a reader can count against. */
export const scaleBarFor = (tileMm: number): number => niceTickStep(tileMm / 2)

interface Headless {
  engine: Viewport3DEngine
  container: HTMLDivElement
}

let headless: Headless | null = null

/** Null when this window cannot give the engine a WebGL context — the caller
 *  answers `renderer-failed` rather than letting the failure cross the bridge.
 *  Shared with the board render (`boardCapture3D.ts`): one context per window. */
export const ensureHeadless = (): Headless | null => {
  if (headless) return headless
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-100000px'
  container.style.top = '0'
  container.style.width = '512px'
  container.style.height = '512px'
  container.style.overflow = 'hidden'
  container.style.pointerEvents = 'none'
  container.setAttribute('aria-hidden', 'true')
  document.body.appendChild(container)
  try {
    headless = { engine: new Viewport3DEngine(container), container }
  } catch (err) {
    console.error('No 3D context for an off-screen model render:', err)
    container.remove()
    return null
  }
  return headless
}

const LABEL_FONT = '600 15px system-ui, sans-serif'
const AXIS_FONT = '500 13px system-ui, sans-serif'
const INK = '#e6efe9'
const DIM_INK = '#9fb3a8'
const RULE = '#24302b'

/** A dark plate under a caption. The tile behind it is the part, not a
 *  background we chose: white silkscreen runs under these labels, and ink on
 *  ink is a caption nobody can read. */
const plate = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
): void => {
  context.fillStyle = 'rgba(13, 18, 16, 0.72)'
  context.beginPath()
  context.roundRect(x - 5, y - 4, width + 10, height + 8, 4)
  context.fill()
}

const drawTileChrome = (
  context: CanvasRenderingContext2D,
  view: ViewPreset,
  originX: number,
  originY: number,
  tile: number,
  barPixels: number,
  barMm: number
): void => {
  context.save()
  context.translate(originX, originY)

  context.font = LABEL_FONT
  context.textBaseline = 'top'
  plate(context, 12, 10, context.measureText(view).width, 16)
  context.fillStyle = INK
  context.fillText(view, 12, 10)

  const axes = AXIS_LABEL[view]
  if (axes) {
    context.font = AXIS_FONT
    const width = context.measureText(axes).width
    plate(context, tile - 12 - width, 10, width, 15)
    context.fillStyle = DIM_INK
    context.textAlign = 'right'
    context.fillText(axes, tile - 12, 10)
    context.textAlign = 'left'
  }

  // The bar, bottom left, with its length written above it.
  const barY = tile - 20
  const barX = 12
  context.font = AXIS_FONT
  plate(context, barX, barY - 24, Math.max(barPixels, context.measureText(`${barMm} mm`).width), 32)
  context.strokeStyle = INK
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(barX, barY)
  context.lineTo(barX + barPixels, barY)
  context.moveTo(barX, barY - 4)
  context.lineTo(barX, barY + 4)
  context.moveTo(barX + barPixels, barY - 4)
  context.lineTo(barX + barPixels, barY + 4)
  context.stroke()
  context.font = AXIS_FONT
  context.fillStyle = INK
  context.textBaseline = 'bottom'
  context.fillText(`${barMm} mm`, barX, barY - 6)

  context.restore()
}

/**
 * Draw `content` from the four fixed views into one PNG.
 *
 * The content becomes the engine's and is disposed with it on the next
 * capture — hand over a group nothing else holds (`modelFacts.decodeModel`),
 * never a cached template or a clone of one, since a clone shares its
 * geometry with the original.
 */
export const captureModelViews = (
  content: THREE.Object3D,
  maxPixels: number,
  /** Frame on this instead of the whole content — the part rather than the
   *  preview board it stands on. The board is still drawn, around it. */
  focus?: THREE.Object3D | null
): ModelCapture | null => {
  const ready = ensureHeadless()
  if (!ready) return null
  const { engine } = ready
  engine.setModel(content, false)
  const focusBox = focus ? new THREE.Box3().setFromObject(focus) : null
  const bounds = focusBox && !focusBox.isEmpty() ? focusBox : engine.contentBounds()
  if (!bounds) {
    engine.setModel(null)
    return null
  }
  const tile = Math.max(128, Math.floor(maxPixels / 2))
  const size = bounds.getSize(new THREE.Vector3())
  const mmPerPixel = commonScale(size, tile)
  const barMm = scaleBarFor(tile * mmPerPixel)
  const barPixels = Math.round(barMm / mmPerPixel)

  const canvas = document.createElement('canvas')
  canvas.width = tile * 2
  canvas.height = tile * 2
  const context = canvas.getContext('2d')
  if (!context) {
    engine.setModel(null)
    return null
  }

  try {
    for (const [index, view] of MODEL_VIEWS.entries()) {
      const shot = engine.captureOrthoView(view, tile, mmPerPixel, focusBox)
      if (!shot) return null
      const x = (index % 2) * tile
      const y = Math.floor(index / 2) * tile
      context.putImageData(shot, x, y)
      drawTileChrome(context, view, x, y, tile, barPixels, barMm)
    }
    // Rules last, so no tile's pixels sit on top of them.
    context.strokeStyle = RULE
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(tile, 0)
    context.lineTo(tile, tile * 2)
    context.moveTo(0, tile)
    context.lineTo(tile * 2, tile)
    context.stroke()

    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      mmPerPixel,
      scaleBarMm: barMm,
      views: [...MODEL_VIEWS]
    }
  } finally {
    // The engine holds no geometry between captures: a model is drawn once and
    // the next call brings its own.
    engine.setModel(null)
  }
}

/**
 * The same four views of a footprint as the one-part board the 3D pane draws:
 * the part standing on its own copper, with its model on it.
 *
 * `placed` is false when the link did not resolve or the file would not
 * decode — the caller refuses rather than answering with a picture of a bare
 * land pattern, which looks like a model that renders as nothing.
 */
export const captureFootprintModel = async (
  footprint: KicadFootprint,
  footprintFile: string | null,
  projectPath: string | null,
  maxPixels: number
): Promise<{ capture: ModelCapture | null; placed: boolean }> => {
  await loadClipper()
  const board = boardFromFootprint(footprint)
  const scene = new BoardScene3D()
  const cache = new BoardModelAssetCache()
  const loader = new ComponentModelLoader(scene.components, cache)
  try {
    scene.setBoard(board, board3dViewState().value)
    let placed = 0
    await loader.load(
      board,
      footprintFile,
      projectPath,
      // One part, and the point is to see it: a class filter here would read as
      // a broken render rather than a filtered one (`FootprintViewport3D.vue`).
      { tht: true, smd: true, unspecified: true, dnp: true, notInPosFiles: true },
      (progress) => {
        placed = progress.placed
      }
    )
    if (!placed) return { capture: null, placed: false }
    // Framed on the part, not on the board we invented to stand it on — the
    // same distinction the 3D pane's dimensions pill makes (`footprintBoard.ts`).
    return {
      capture: captureModelViews(scene.root, maxPixels, scene.components),
      placed: true
    }
  } finally {
    loader.dispose()
    scene.dispose()
    cache.dispose()
  }
}
