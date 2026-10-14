import * as THREE from 'three'
import {
  CHROME_CROSS,
  CHROME_STACK,
  SelectionChrome,
  selectionChromeColors
} from './SelectionChrome'

/**
 * A cross at the stored point a text item is positioned by, shown while that
 * item is selected — KiCad's text anchor.
 *
 * It earns screen space because the drawing cannot show it: glyphs lay out
 * *relative* to that point per horizontal/vertical justification, so two texts
 * with identical coordinates render in visibly different places, and the same
 * point is what a rotation pivots about and what snaps to the grid on a drag.
 *
 * Passive by construction — no `userData.type`, which is what `ViewportEngine`
 * looks for in both its raycast passes, so this can never take a click. That
 * is the difference from a `VertexHandles` mark, and the reason the two show at
 * different times: a handle says "grab me", an anchor says "here is the point
 * you are moving".
 *
 * (Not the `anchorMap` groups in `SchematicScene` — those are invisible objects
 * the engine resolves hits through. Same word, unrelated mechanism.)
 */

const { span: CROSS_PIXELS, bar: CORE_PIXELS, rim: RIM_PIXELS } = CHROME_CROSS

export class TextAnchors extends SelectionChrome {
  /** Unit square, scaled per bar — one geometry serves both arms and tones. */
  private readonly geometry = new THREE.PlaneGeometry(1, 1)
  private readonly coreMaterial: THREE.MeshBasicMaterial
  private readonly rimMaterial: THREE.MeshBasicMaterial

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
    this.applyTheme()
  }

  /** Keep selected-text anchors legible when the canvas theme changes live. */
  public applyTheme(): void {
    const { core, rim } = selectionChromeColors()
    this.coreMaterial.color.set(core)
    this.rimMaterial.color.set(rim)
  }

  /** Replace the crosses on screen. `null` or `[]` clears them. */
  render(points: Array<{ x: number; y: number }> | null): void {
    this.clear()
    if (!points) return
    for (const point of points) {
      const cross = new THREE.Group()
      cross.position.set(point.x, point.y, 0)
      // Four bars: the dark pair beneath the bright pair, so the mark reads on
      // a stroke of either tone.
      for (const rimmed of [true, false]) {
        for (const vertical of [false, true]) {
          const layer = rimmed ? CHROME_STACK.markerRim : CHROME_STACK.markerCore
          const bar = new THREE.Mesh(this.geometry, rimmed ? this.rimMaterial : this.coreMaterial)
          bar.position.z = layer.z
          bar.renderOrder = layer.renderOrder
          bar.userData = { rimmed, vertical }
          cross.add(bar)
        }
      }
      this.scaleCross(cross)
      this.group.add(cross)
    }
  }

  protected rescale(): void {
    for (const cross of this.group.children) this.scaleCross(cross)
  }

  private scaleCross(cross: THREE.Object3D): void {
    for (const bar of cross.children) {
      const pad = bar.userData.rimmed ? RIM_PIXELS * 2 : 0
      const long = (CROSS_PIXELS + pad) * this.worldPerPixel
      const short = (CORE_PIXELS + pad) * this.worldPerPixel
      if (bar.userData.vertical) bar.scale.set(short, long, 1)
      else bar.scale.set(long, short, 1)
    }
  }

  protected disposeResources(): void {
    this.geometry.dispose()
    this.coreMaterial.dispose()
    this.rimMaterial.dispose()
  }
}
