import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { VIEW_FIT_PADDING, fitOrbit, poseOrthoFromLens } from '../cameraFit'

const box = (min: [number, number, number], max: [number, number, number]): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))

/** A 60 x 40 board, 1.6 thick, and one tall part near its far (top) edge. */
const BOARD = box([0, 0, -0.8], [60, 40, 0.8])
const TALL = box([40, 30, 0.8], [52, 38, 9])
const TILTED = new THREE.Vector3(0.72, -0.82, 0.62)

/** Where the boxes land in a camera at the fit, in NDC. */
const extent = (
  fit: { position: THREE.Vector3; target: THREE.Vector3 },
  boxes: THREE.Box3[],
  aspect: number
): { x0: number; x1: number; y0: number; y1: number } => {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 10000)
  camera.up.set(0, 0, 1)
  camera.position.copy(fit.position)
  camera.lookAt(fit.target)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const out = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
  for (const b of boxes)
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera)
          out.x0 = Math.min(out.x0, p.x)
          out.x1 = Math.max(out.x1, p.x)
          out.y0 = Math.min(out.y0, p.y)
          out.y1 = Math.max(out.y1, p.y)
        }
  return out
}

describe('fitOrbit', () => {
  it('orbits a point on the board top, not the middle of the assembly', () => {
    const fit = fitOrbit([BOARD, TALL], TILTED, 45, 16 / 9, 0.8)!
    expect(fit.target.z).toBeCloseTo(0.8, 6)
  })

  it('centers what is drawn at a tilt, where a box round it all would not', () => {
    const aspect = 16 / 9
    const e = extent(fitOrbit([BOARD, TALL], TILTED, 45, aspect, 0.8)!, [BOARD, TALL], aspect)
    expect((e.x0 + e.x1) / 2).toBeCloseTo(0, 2)
    expect((e.y0 + e.y1) / 2).toBeCloseTo(0, 2)
  })

  it('leaves the same room on its tighter axis as the 2D fit', () => {
    const aspect = 16 / 9
    const e = extent(fitOrbit([BOARD, TALL], TILTED, 45, aspect, 0.8)!, [BOARD, TALL], aspect)
    const fill = Math.max((e.x1 - e.x0) / 2, (e.y1 - e.y0) / 2)
    expect(fill).toBeCloseTo(1 / VIEW_FIT_PADDING, 2)
  })

  it('looks straight down on the middle of a flat board', () => {
    const fit = fitOrbit([BOARD], new THREE.Vector3(0, -1e-6, 1), 45, 1.5, 0.8)!
    expect(fit.target.x).toBeCloseTo(30, 3)
    expect(fit.target.y).toBeCloseTo(20, 3)
    expect(fit.position.z).toBeGreaterThan(fit.target.z)
  })

  it('answers nothing for nothing drawn', () => {
    expect(fitOrbit([], TILTED, 45, 1, 0)).toBeNull()
  })
})

describe('poseOrthoFromLens', () => {
  const lensAt = (position: THREE.Vector3, target: THREE.Vector3): THREE.PerspectiveCamera => {
    const lens = new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000)
    lens.up.set(0, 0, 1)
    lens.position.copy(position)
    lens.lookAt(target)
    lens.updateMatrixWorld(true)
    lens.updateProjectionMatrix()
    return lens
  }
  const ndc = (camera: THREE.Camera, x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x, y, z).project(camera)
  const TARGET = new THREE.Vector3(30, 20, 0.8)
  const CONTENT = BOARD.clone().union(TALL).getBoundingSphere(new THREE.Sphere())

  it('frames the orbit target plane as the lens does', () => {
    // Straight down, so the board's top face is the plane through the target.
    const lens = lensAt(new THREE.Vector3(30, 20 - 1e-4, 90.8), TARGET)
    const ortho = new THREE.OrthographicCamera()
    poseOrthoFromLens(ortho, lens, TARGET, CONTENT)
    for (const [x, y] of [
      [0, 0],
      [60, 40],
      [45, 5]
    ]) {
      const a = ndc(lens, x, y, 0.8)
      const b = ndc(ortho, x, y, 0.8)
      expect(b.x).toBeCloseTo(a.x, 4)
      expect(b.y).toBeCloseTo(a.y, 4)
    }
  })

  it('draws height without converging: a tall point lands where its foot does', () => {
    const lens = lensAt(new THREE.Vector3(30, 20 - 1e-4, 90.8), TARGET)
    const ortho = new THREE.OrthographicCamera()
    poseOrthoFromLens(ortho, lens, TARGET, CONTENT)
    expect(ndc(ortho, 50, 35, 9).x).toBeCloseTo(ndc(ortho, 50, 35, 0.8).x, 6)
    expect(ndc(lens, 50, 35, 9).x).not.toBeCloseTo(ndc(lens, 50, 35, 0.8).x, 2)
  })

  it('keeps the whole board in its depth range when the orbit is zoomed inside it', () => {
    const position = TARGET.clone().addScaledVector(TILTED.clone().normalize(), 3)
    const lens = lensAt(position, TARGET)
    const ortho = new THREE.OrthographicCamera()
    poseOrthoFromLens(ortho, lens, TARGET, CONTENT)
    for (const corner of [
      [0, 0, -0.8],
      [60, 40, 0.8],
      [52, 38, 9]
    ]) {
      const z = ndc(ortho, corner[0], corner[1], corner[2]).z
      expect(z).toBeGreaterThan(-1)
      expect(z).toBeLessThan(1)
    }
  })
})
