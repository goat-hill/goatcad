/**
 * A picture of a schematic document that has no editor mounted.
 *
 * `render.schematic` draws the mounted editor's own scene when the sheet is the
 * active tab. For any other sheet there is no scene, so one is kept here: a
 * `ViewportEngine` on a container the user never sees, and one
 * `SchematicScene` rebuilt from whatever document is asked for. The capture
 * itself is the engine's `captureFramed`, which draws into an off-screen
 * target sized from the request — the same code path, so the picture is what
 * the editor would draw, at the resolution asked for.
 *
 * One engine for the window's lifetime, made on first use: a WebGL context is
 * a scarce resource (browsers cap them per page and evict the oldest), so a
 * context per capture would evict the editor's.
 */
import * as THREE from 'three'
import { ViewportEngine } from './ViewportEngine'
import { SchematicScene, applySchematicTheme } from './SchematicScene'
import type { KicadSchematic } from '../kicad/schematic'
import type { AgentCapture, WorldBox } from '../schematic/schematicAgent'
import type { SchematicSvg } from './schematicSvg'
import { themeColor } from '../theme'

/** mm; keeps a lone symbol or a focused 0603 from zooming to the cap. A real
 *  sheet's bounds dwarf this, so full-sheet fits are unaffected. */
export const SCHEMATIC_FIT_MIN_EXTENT = 25

interface Headless {
  engine: ViewportEngine
  scene: SchematicScene
}

let headless: Headless | null = null

const ensureHeadless = (): Headless => {
  if (headless) return headless
  const container = document.createElement('div')
  // In the document, so it has a size and the theme's CSS variables, and off
  // every screen, so it is never seen or hit.
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
  const scene = new SchematicScene(engine.scene, engine.overlayScene)
  headless = { engine, scene }
  return headless
}

/**
 * Draw `document` framed to `box` — or to everything it holds — at up to
 * `maxPixels` on the longest edge. Null when nothing could be drawn.
 */
export const captureSchematicDocument = (
  schematic: KicadSchematic,
  box: WorldBox | null,
  maxPixels: number
): AgentCapture | null => {
  const { engine, scene } = ensureHeadless()
  // The theme is read on every capture rather than once: it is cheap, and a
  // theme switched since the last picture would otherwise draw the old one.
  applySchematicTheme()
  engine.applyTheme()
  scene.applyTheme()
  scene.rebuild(schematic)
  const bounds = box
    ? new THREE.Box3(
        new THREE.Vector3(box.minX, box.minY, 0),
        new THREE.Vector3(box.maxX, box.maxY, 0)
      )
    : scene.getBounds()
  return engine.captureFramed(bounds, SCHEMATIC_FIT_MIN_EXTENT, maxPixels)
}

/**
 * `document` as SVG, framed to `box` — or to everything it holds — through the
 * same headless scene as the PNG, so the vector is the drawing the picture is.
 * Null when there is nothing to draw.
 */
export const exportSchematicSvg = (
  schematic: KicadSchematic,
  box: WorldBox | null,
  background: boolean
): SchematicSvg | null => {
  const { engine, scene } = ensureHeadless()
  applySchematicTheme()
  engine.applyTheme()
  scene.applyTheme()
  scene.rebuild(schematic)
  const bounds = box
    ? new THREE.Box3(
        new THREE.Vector3(box.minX, box.minY, 0),
        new THREE.Vector3(box.maxX, box.maxY, 0)
      )
    : scene.getBounds()
  if (bounds.isEmpty()) return null
  return scene.toSvg(bounds, background ? themeColor('--vscode-bg-viewport', '#101513') : undefined)
}
