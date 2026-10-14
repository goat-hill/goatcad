import * as THREE from 'three'
import { OVERLAY_ORDER } from '../kicad/paintOrder'
import type { ScreenScaled } from './ViewportEngine'

/** Ring radius and cross half-length on screen, in pixels (constant across zoom). */
const RING_PIXELS = 7
const ARM_PIXELS = 11
const RING_SEGMENTS = 32

/**
 * A point marker drawn at a constant screen size: a ring crossed by two arms —
 * KiCad's mark for the drill / place file origin. The grid origin needs none,
 * since the grid's own axes and crosshair move with it (`GridShader`).
 *
 * The geometry is built in pixels and the object scaled by the world size of
 * one (`ViewportEngine.registerScreenScaled`), so one mesh serves every zoom.
 */
export class OriginMarker implements ScreenScaled {
  readonly object: THREE.LineSegments
  private readonly material = new THREE.LineBasicMaterial({
    depthTest: false,
    depthWrite: false
  })

  constructor(z: number) {
    const points: number[] = []
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = (i / RING_SEGMENTS) * Math.PI * 2
      const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2
      points.push(Math.cos(a0) * RING_PIXELS, Math.sin(a0) * RING_PIXELS, 0)
      points.push(Math.cos(a1) * RING_PIXELS, Math.sin(a1) * RING_PIXELS, 0)
    }
    points.push(-ARM_PIXELS, 0, 0, ARM_PIXELS, 0, 0, 0, -ARM_PIXELS, 0, 0, ARM_PIXELS, 0)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    this.object = new THREE.LineSegments(geometry, this.material)
    this.object.position.z = z
    // Over the document and the selection chrome, like the cursor it resembles.
    this.object.renderOrder = OVERLAY_ORDER.originMarker
    this.object.frustumCulled = false
    this.object.visible = false
  }

  setWorldPerPixel(worldPerPixel: number): void {
    this.object.scale.set(worldPerPixel, worldPerPixel, 1)
  }

  setColor(color: string): void {
    this.material.color.set(color)
  }

  /** Show the marker at a world point, or hide it (null). */
  place(at: { x: number; y: number } | null): void {
    this.object.visible = at !== null
    if (at) this.object.position.set(at.x, at.y, this.object.position.z)
  }

  dispose(): void {
    this.object.geometry.dispose()
    this.material.dispose()
  }
}
