/**
 * A picture of a fab set, for a model that cannot see the Gerber viewer.
 *
 * The Gerber twin of `boardCapture.ts`: one `ViewportEngine` on a container
 * nobody sees and one `GerberScene`, composited as the viewer composites a set,
 * so the picture is what the Gerber viewer would draw. One engine for the
 * window's lifetime, made on first use: a WebGL context per capture would
 * evict the editor's.
 */
import * as THREE from 'three'
import { ViewportEngine } from './ViewportEngine'
import { GerberScene } from './GerberScene'
import type { AgentCapture, WorldBox } from '../schematic/schematicAgent'
import type { GerberImage } from '../gerber/parse'
import { currentAppTheme, kicadLayerColorsForTheme, themeColor } from '../theme'

/** mm; keeps a tiny frame from zooming to the pixel cap. */
const GERBER_FIT_MIN_EXTENT = 5

interface Headless {
  engine: ViewportEngine
  scene: GerberScene
}

let headless: Headless | null = null

const ensureHeadless = (): Headless => {
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
  headless = { engine: new ViewportEngine(container), scene: new GerberScene() }
  return headless
}

/** One file of the set: its image and the KiCad layer it was identified as, if any. */
export interface GerberCaptureLayer {
  id: string
  image: GerberImage
  kicadLayer: string | null
  /** An Excellon file, drawn as the viewer draws holes. */
  drill?: boolean
}

/** The viewer's opacities: a layer lets the ones beneath show; the outline and holes do not. */
const LAYER_OPACITY = 0.75

export interface GerberCaptureRequest {
  /** Layers in stack order, bottom first. */
  layers: GerberCaptureLayer[]
  /** Frame this rectangle, in the files' own millimetres (y up); absent frames the whole set. */
  box?: WorldBox | null
  maxPixels: number
}

/** Draw a parsed fab set framed to a box or to everything it holds. Null when nothing could be drawn. */
export const captureGerberSet = (request: GerberCaptureRequest): AgentCapture | null => {
  const { engine, scene } = ensureHeadless()
  engine.applyTheme()
  const colors = kicadLayerColorsForTheme(currentAppTheme())
  const drill = themeColor('--vscode-canvas-drill', '#cfd6d2')
  const unknown = themeColor('--vscode-canvas-layer-unknown', '#ffffff')
  scene.build(
    request.layers.map((layer) => ({
      id: layer.id,
      image: layer.image,
      color: layer.drill
        ? drill
        : ((layer.kicadLayer ? colors[layer.kicadLayer] : undefined) ?? unknown),
      opacity: layer.drill || layer.kicadLayer === 'Edge.Cuts' ? 1 : LAYER_OPACITY
    }))
  )
  engine.setCompositeLayers(scene.getSpecs())
  const box = request.box
  const bounds = box
    ? new THREE.Box3(
        new THREE.Vector3(box.minX, box.minY, 0),
        new THREE.Vector3(box.maxX, box.maxY, 0)
      )
    : scene.getBounds()
  return engine.captureFramed(bounds, GERBER_FIT_MIN_EXTENT, request.maxPixels)
}
