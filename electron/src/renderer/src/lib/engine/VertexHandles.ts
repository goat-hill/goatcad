import * as THREE from 'three'
import {
  CHROME_CROSS,
  CHROME_STACK,
  SelectionChrome,
  selectionChromeColors
} from './SelectionChrome'

/**
 * On-canvas drag handles for the selected item — the shared mechanism behind
 * the symbol editor's graphic vertices, the footprint editor's, and the
 * schematic's sheet corners.
 *
 * The engine routes a drag here by raycasting `scene.children` for
 * `userData.type === 'vertex'`, which is what makes that drag resize rather
 * than move (ViewportEngine `onMouseDown` step 2).
 *
 * What differs per editor is which points a shape carries and how it names them
 * — that is the editor's own index space, so callers supply both the positions
 * and an opaque `data` payload. Everything about how a handle LOOKS is fixed
 * here, deliberately: a handle is a control, not document content, so its
 * appearance is a property of the interaction and should be learned once rather
 * than re-read per editor.
 */

/**
 * What grabbing a handle means, and — between `move` and `anchor` — whether the
 * point it sits on is real.
 *
 * `resize` moves the one point the handle sits on.
 *
 * `move` translates the whole shape from a point that exists only as a grab
 * target: the center of the item's bounding box. It earns its place because our
 * shape hit-tests measure distance to the OUTLINE, so an unfilled rectangle has
 * no interior to grab and its edge is the only target.
 *
 * `anchor` also translates the shape, and is reserved for the one case where
 * the anchor is the whole story: a TEXT, which has no geometry to resize and
 * lays its glyphs out relative to `(at …)` per justification, so the point is
 * genuinely not visible in the drawing. Everything else — including a circle's
 * stored `(center …)` — takes the diamond, because "this coordinate is in the
 * file" is a fact about the format rather than about what the handle does, and
 * one odd glyph among many reads as noise rather than as information. It is the
 * same mark `TextAnchors` draws for texts with no handle layer at all.
 */
export type VertexHandleRole = 'resize' | 'move' | 'anchor'

export interface VertexHandleSpec {
  /** Engine-space position (the scene's own coordinates, y-up). */
  x: number
  y: number
  /** Defaults to `resize`. */
  role?: VertexHandleRole
  /** The editor's own identification of what this handle writes back. */
  data: Record<string, unknown>
}

/** Side length on screen. Constant in pixels — see `setWorldPerPixel`. */
const CORE_PIXELS = 9
/** Rim thickness per side, in pixels. */
const RIM_PIXELS = 1.5

/** A quarter turn: a diamond is the square rotated, so one geometry serves both. */
const DIAMOND_ROTATION = Math.PI / 4

export class VertexHandles extends SelectionChrome {
  /** Unit square, scaled per handle — so one geometry serves every size and shape. */
  private readonly geometry = new THREE.PlaneGeometry(1, 1)
  private readonly coreMaterial: THREE.MeshBasicMaterial
  private readonly rimMaterial: THREE.MeshBasicMaterial
  /**
   * Invisible square behind an `anchor` cross, sized like an ordinary handle.
   *
   * A cross drawn as two 1.5 px bars would be a 1.5 px click target: the engine
   * raycasts the meshes themselves. A fully transparent mesh still raycasts
   * (only `visible = false` is skipped), so this gives the cross the grab area
   * of the square it replaces without drawing anything.
   */
  private readonly hitMaterial: THREE.MeshBasicMaterial

  /**
   * @param parent Scene to add the handle group to — the document scene.
   */
  constructor(parent: THREE.Object3D) {
    super(parent)
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(),
      side: THREE.DoubleSide
    })
    this.rimMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(),
      side: THREE.DoubleSide
    })
    // No theme: an anchor's grab pad is invisible in every palette.
    this.hitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    this.applyTheme()
  }

  /** Keep selection handles legible when the canvas theme changes live. */
  public applyTheme(): void {
    const { core, rim } = selectionChromeColors()
    this.coreMaterial.color.set(core)
    this.rimMaterial.color.set(rim)
  }

  protected rescale(): void {
    for (const handle of this.group.children) this.scaleHandle(handle)
  }

  private scaleHandle(handle: THREE.Object3D): void {
    if (handle.userData.role === 'anchor') {
      for (const part of handle.children) this.scaleCrossBar(part)
      return
    }
    const core = handle.children[1]
    const rim = handle.children[0]
    const coreSide = CORE_PIXELS * this.worldPerPixel
    const rimSide = (CORE_PIXELS + RIM_PIXELS * 2) * this.worldPerPixel
    core?.scale.set(coreSide, coreSide, 1)
    rim?.scale.set(rimSide, rimSide, 1)
  }

  /** One arm of an `anchor` cross, or its invisible grab pad. */
  private scaleCrossBar(part: THREE.Object3D): void {
    if (part.userData.pad) {
      const side = (CORE_PIXELS + RIM_PIXELS * 2) * this.worldPerPixel
      part.scale.set(side, side, 1)
      return
    }
    const pad = part.userData.rim ? CHROME_CROSS.rim * 2 : 0
    const long = (CHROME_CROSS.span + pad) * this.worldPerPixel
    const short = (CHROME_CROSS.bar + pad) * this.worldPerPixel
    if (part.userData.vertical) part.scale.set(short, long, 1)
    else part.scale.set(long, short, 1)
  }

  /** Replace the handles on screen. `null` or `[]` clears them. */
  render(specs: VertexHandleSpec[] | null): void {
    this.clear()
    if (!specs) return
    for (const spec of specs) {
      const role = spec.role ?? 'resize'
      // The group carries the payload, and the engine walks up from whichever
      // of the two meshes the ray struck — so both tones are one target.
      const handle = new THREE.Group()
      handle.position.set(spec.x, spec.y, 0)
      handle.userData = { ...spec.data, type: 'vertex', role }

      if (role === 'anchor') {
        // A cross rather than a filled shape: an anchor names a coordinate, so
        // the mark has to show the point instead of covering it. Grab area
        // comes from the invisible pad — see `hitMaterial`.
        const pad = new THREE.Mesh(this.geometry, this.hitMaterial)
        pad.position.z = CHROME_STACK.handleRim.z
        pad.userData = { pad: true }
        handle.add(pad)
        for (const rimmed of [true, false]) {
          for (const vertical of [false, true]) {
            const layer = rimmed ? CHROME_STACK.handleRim : CHROME_STACK.handleCore
            const bar = new THREE.Mesh(this.geometry, rimmed ? this.rimMaterial : this.coreMaterial)
            bar.position.z = layer.z
            bar.renderOrder = layer.renderOrder
            bar.userData = { rim: rimmed, vertical }
            handle.add(bar)
          }
        }
        this.scaleHandle(handle)
        this.group.add(handle)
        continue
      }

      const rim = new THREE.Mesh(this.geometry, this.rimMaterial)
      rim.position.z = CHROME_STACK.handleRim.z
      rim.renderOrder = CHROME_STACK.handleRim.renderOrder
      const core = new THREE.Mesh(this.geometry, this.coreMaterial)
      core.position.z = CHROME_STACK.handleCore.z
      core.renderOrder = CHROME_STACK.handleCore.renderOrder

      // Shape says what the handle DOES, so the two roles stay distinguishable
      // where hue fails — on a stroke of a similar color, or to a colorblind
      // reader. Square resizes, diamond moves. Neither is a filled circle or a
      // ring, both of which already mean something (junction; warning marker).
      if (role === 'move') {
        rim.rotation.z = DIAMOND_ROTATION
        core.rotation.z = DIAMOND_ROTATION
      }

      handle.add(rim)
      handle.add(core)
      this.scaleHandle(handle)
      this.group.add(handle)
    }
  }

  /**
   * Move the handles already on screen, in `render` order, without rebuilding
   * them — for a live resize, where the shape changes under the cursor but its
   * handles are still the same handles meaning the same things.
   *
   * Takes specs rather than bare points so callers derive handle positions from
   * the shape ONE way, through whatever builds their `render` specs. Positions
   * are all that change: a resize cannot alter what a handle writes back, and
   * re-rendering per mouse move would churn a mesh pair per handle per frame.
   *
   * Deriving the position from the resized SHAPE rather than offsetting by the
   * drag delta is what keeps a handle honest: a circle's rim handle belongs on
   * the new rim, not under the cursor, and the resized shape is already
   * quantized to the grid the commit will write.
   */
  setPositions(specs: VertexHandleSpec[]): void {
    this.group.children.forEach((handle, index) => {
      const spec = specs[index]
      if (spec) handle.position.set(spec.x, spec.y, 0)
    })
  }

  protected disposeResources(): void {
    this.geometry.dispose()
    this.coreMaterial.dispose()
    this.rimMaterial.dispose()
    this.hitMaterial.dispose()
  }
}

/**
 * The selected item, but only when it is the only one.
 *
 * Handles are a single-item affordance: KiCad's point editor activates on a
 * one-item selection and stays out of the way otherwise. On a multi-selection
 * the operation you want is moving the group, and because the engine raycasts
 * handles BEFORE the object-drag path, every handle in reach is one that would
 * silently turn that group move into a resize of one shape.
 */
export function soleSelection<T>(items: readonly T[]): T | null {
  return items.length === 1 ? (items[0] ?? null) : null
}
