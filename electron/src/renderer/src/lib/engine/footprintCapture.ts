/**
 * A picture of a library footprint that no editor has open.
 *
 * The footprint twin of `schematicCapture.ts`: one `ViewportEngine` on a
 * container nobody sees, one `FootprintScene` rebuilt from whatever footprint
 * is asked for, and the engine's own `captureFramed` for the picture — so it
 * is what the footprint editor would draw. One engine for the window's
 * lifetime, made on first use, for the reason the schematic one gives: a WebGL
 * context per capture would evict the editor's.
 */
import * as THREE from 'three'
import { ViewportEngine } from './ViewportEngine'
import { FootprintScene } from './FootprintScene'
import { currentAppTheme } from '../theme'
import type { KicadFootprint } from '../kicad/footprint'
import type { AgentCapture } from '../schematic/schematicAgent'
import { footprintExtents, type FootprintExtent } from '../footprint/footprintExtent'
import { NM_PER_MM } from '../kicad/coordinates'

/** mm; keeps an 0201 from zooming to the cap. */
export const FOOTPRINT_FIT_MIN_EXTENT = 4

interface Headless {
  engine: ViewportEngine
  scene: FootprintScene
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
  const engine = new ViewportEngine(container)
  const scene = new FootprintScene(engine.scene)
  headless = { engine, scene }
  return headless
}

/** mm around the part's box: room for the reference above the courtyard. */
export const FOOTPRINT_FRAME_MARGIN = 2

/**
 * The part itself — courtyard, else fab and pads — in engine space (mm, y up),
 * or null for a footprint that draws none of them. The Value is left to the
 * margin: it is the footprint's name, and a library name is long enough to
 * shrink the pads to specks if the frame has to hold it.
 */
const partFrame = (footprint: KicadFootprint): THREE.Box3 | null => {
  const extents = footprintExtents(footprint)
  const boxes = extents.courtyard
    ? [extents.courtyard]
    : [extents.fab, extents.pads].filter((box): box is FootprintExtent => box !== null)
  if (!boxes.length) return null
  const margin = FOOTPRINT_FRAME_MARGIN * NM_PER_MM
  const minX = Math.min(...boxes.map((box) => box.minX)) - margin
  const maxX = Math.max(...boxes.map((box) => box.maxX)) + margin
  const minY = Math.min(...boxes.map((box) => box.minY)) - margin
  const maxY = Math.max(...boxes.map((box) => box.maxY)) + margin
  return new THREE.Box3(
    new THREE.Vector3(minX / NM_PER_MM, -maxY / NM_PER_MM, 0),
    new THREE.Vector3(maxX / NM_PER_MM, -minY / NM_PER_MM, 0)
  )
}

/** Draw `footprint` alone, framed to the part with a margin, at up to
 *  `maxPixels` on the longest edge. Null when nothing could be drawn. */
export const captureFootprint = (
  footprint: KicadFootprint,
  maxPixels: number
): AgentCapture | null => {
  const { engine, scene } = ensureHeadless()
  scene.applyTheme(currentAppTheme())
  engine.applyTheme()
  const bounds = scene.rebuild(footprint)
  return engine.captureFramed(partFrame(footprint) ?? bounds, FOOTPRINT_FIT_MIN_EXTENT, maxPixels)
}
