import * as THREE from 'three'
import { themeColor } from '../theme'
import type { ScreenScaled } from './ViewportEngine'

/**
 * Chrome drawn ON a selection — vertex handles, text-anchor crosses — as
 * opposed to document content.
 *
 * Two properties every such layer needs, neither of them about the shape drawn:
 * a constant size in SCREEN pixels (world-sized chrome vanishes zoomed out and
 * covers the geometry it is positioning zoomed in), and the
 * `saveOrigins`/`translate`/`clearOrigins` trio — `PrimitiveBatch`'s shape — so
 * a mark stays on the geometry it describes while that geometry is dragged.
 *
 * These live in the DOCUMENT scene, not an overlay, because `ViewportEngine`
 * raycasts `scene.children`: a handle has to be reachable there for the engine
 * to route a drag to it (`userData.type === 'vertex'`), and a purely passive
 * marker simply carries no `userData.type`, which the same raycast skips.
 */
export abstract class SelectionChrome implements ScreenScaled {
  protected readonly group = new THREE.Group()
  /** Overwritten from the first `render()` frame; a placeholder until then. */
  protected worldPerPixel = 1 / 40

  /**
   * @param parent Scene to add this layer's group to — the document scene.
   */
  constructor(parent: THREE.Object3D) {
    parent.add(this.group)
  }

  /** Registered with `ViewportEngine.registerScreenScaled`. */
  setWorldPerPixel(worldPerPixel: number): void {
    if (worldPerPixel === this.worldPerPixel) return
    this.worldPerPixel = worldPerPixel
    this.rescale()
  }

  /** Re-apply the pixel sizes to whatever is currently on screen. */
  protected abstract rescale(): void

  /**
   * Drop what is drawn but keep the geometry and materials — they are shared by
   * every mark and by every future render, so disposing here would free
   * resources the next call needs. Disposal happens once, in `dispose`.
   */
  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child)
  }

  /** Snapshot positions so `translate` can move in lockstep with a drag. */
  saveOrigins(): void {
    for (const child of this.group.children) {
      child.userData._dragOrigin = { x: child.position.x, y: child.position.y }
    }
  }

  clearOrigins(): void {
    for (const child of this.group.children) delete child.userData._dragOrigin
  }

  /** Offset from the saved origins; marks with no snapshot stay put. */
  translate(delta: { x: number; y: number }): void {
    for (const child of this.group.children) {
      const origin = child.userData._dragOrigin
      if (!origin) continue
      child.position.x = origin.x + delta.x
      child.position.y = origin.y + delta.y
    }
  }

  dispose(): void {
    this.clear()
    this.group.removeFromParent()
    this.disposeResources()
  }

  /** Free the geometry and materials shared across renders. */
  protected abstract disposeResources(): void
}

/**
 * Core and rim. The pair is what makes ONE chrome design work in every editor:
 * whatever a mark lands on, one of the two tones contrasts with it, so the
 * color never has to be tuned per document. That matters concretely — the
 * footprint and PCB editors recolor a selected element to white, and the KiCad
 * layer palette already contains near-teal (`#00cccc`, `#99d8c8`, `#89d0a0`),
 * so neither a white nor a bare teal mark survives on its own.
 *
 * The core is the schematic's selection blue (`SchematicScene` `COLORS.selected`)
 * rather than the copper accent, because chrome exists only on a selection and
 * so belongs to the selection's visual language — and because copper is
 * `COLORS.symbol` and the `F.Fab` layer color, so a copper mark would disappear
 * into the symbol it annotates.
 */
const CHROME_CORE_FALLBACK = '#66b3ff'
const CHROME_RIM_FALLBACK = '#0b0f0d'

export const selectionChromeColors = (): { core: string; rim: string } => ({
  core: themeColor('--vscode-canvas-selection', CHROME_CORE_FALLBACK),
  rim: themeColor('--vscode-canvas-selection-rim', CHROME_RIM_FALLBACK)
})

/**
 * The anchor cross, in screen pixels — one shape for both layers that draw it:
 * `TextAnchors` for items with no handles, and `VertexHandles`' `anchor` role
 * for those that have them. The glyph means the same thing in both ("the point
 * the file stores"), so it cannot be allowed to differ in size between them.
 */
export const CHROME_CROSS = {
  /** Arm span, tip to tip. */
  span: 11,
  /** Bar width. */
  bar: 1.5,
  /** Rim thickness per side. */
  rim: 1
} as const

/**
 * Where chrome sits among the z-lifted selection (`Z.selectedLift` puts
 * selected paint at ~0.5–0.65). Chrome exists only on selected items, and
 * everything here sits above `LIFT_SPLIT_Z`, so it lands in the split render's
 * lifted pass, above the halo quad.
 *
 * Handles are topmost: a handle is something to grab, and one hidden under
 * the geometry it grabs is no handle. The anchor MARKER sits BELOW the lifted
 * text (0.58) and above every lifted stroke, fill and glyph under it (≤ 0.568):
 * it says where a text is pinned, and drawn over the glyphs it hid the very
 * characters that read which end the anchor is at. Its materials are opaque,
 * so it draws in three.js's opaque pass, before the transparent stroke batch —
 * the order `SchematicScene`'s depth-write caveat asks for, so a glyph's
 * antialiased fringe blends over the mark rather than being cut by it.
 *
 * Each entry carries its draw order too, so the depth buffer is never left to
 * settle a tie on its own. Sized in screen pixels (`CHROME_CROSS`), not world.
 */
export const CHROME_STACK = {
  markerRim: { z: 0.57, renderOrder: 2000 },
  markerCore: { z: 0.571, renderOrder: 2001 },
  handleRim: { z: 0.7, renderOrder: 2002 },
  handleCore: { z: 0.71, renderOrder: 2003 }
} as const
