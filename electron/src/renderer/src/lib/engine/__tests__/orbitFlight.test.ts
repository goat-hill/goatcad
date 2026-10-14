import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { orbitFlightStep, view3DDirection, type OrbitPose } from '../ViewportEngine'

/**
 * The 3D view's preset flights. What matters is not the numbers but the path:
 * the camera has to go AROUND the board, and the board has to stay centered
 * and the same size while it does.
 */

const TARGET = new THREE.Vector3(0, 0, 0)

/** The same construction `flyCamera3D` uses: place a camera, aim it, keep its
 *  orientation. Directions mirror `viewPose3D`'s presets. */
const poseFor = (direction: THREE.Vector3, radius: number, target = TARGET): OrbitPose => {
  const camera = new THREE.PerspectiveCamera()
  camera.up.set(0, 0, 1)
  camera.position.copy(target).addScaledVector(direction.clone().normalize(), radius)
  camera.lookAt(target)
  return { quaternion: camera.quaternion.clone(), target: target.clone(), radius }
}

const TOP = view3DDirection('top')
const BOTTOM = view3DDirection('bottom')
const ISO = view3DDirection('iso')

/** The world direction that appears as up (or right) on screen, for a camera
 *  holding the given orientation. */
const screenAxis = (quaternion: THREE.Quaternion, axis: 'up' | 'right'): THREE.Vector3 =>
  new THREE.Vector3(axis === 'up' ? 0 : 1, axis === 'up' ? 1 : 0, 0).applyQuaternion(quaternion)

/** Where the target lands in the camera's own frame: (0, 0, −radius) means
 *  dead center and `radius` away. */
const targetInView = (
  pose: { position: THREE.Vector3; quaternion: THREE.Quaternion },
  target = TARGET
): THREE.Vector3 =>
  target.clone().sub(pose.position).applyQuaternion(pose.quaternion.clone().invert())

describe('orbitFlightStep', () => {
  test('top to bottom goes around the board, not through it', () => {
    const from = poseFor(TOP, 100)
    const to = poseFor(BOTTOM, 100)
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const { position } = orbitFlightStep(from, to, Math.min(1, t))
      expect(position.distanceTo(TARGET)).toBeCloseTo(100, 6)
    }
    // Halfway is an edge-on elevation — off the board's own axis entirely.
    const mid = orbitFlightStep(from, to, 0.5)
    expect(Math.abs(mid.position.z)).toBeLessThan(1)
  })

  test('it turns over right-side-to-left, not end-over-end', () => {
    const from = poseFor(TOP, 100)
    const to = poseFor(BOTTOM, 100)

    // Landing: the board's top edge is still at the top of the screen, and X is
    // mirrored — the board flipped about its vertical axis.
    const landed = orbitFlightStep(from, to, 1)
    expect(screenAxis(landed.quaternion, 'up').y).toBeCloseTo(1, 4)
    expect(screenAxis(landed.quaternion, 'right').x).toBeCloseTo(-1, 4)

    // Path: halfway is a SIDE elevation, so the camera passed over the board's
    // left/right edge rather than its near/far one.
    const mid = orbitFlightStep(from, to, 0.5)
    expect(Math.abs(mid.position.x)).toBeCloseTo(100, 3)
    expect(Math.abs(mid.position.y)).toBeLessThan(1)

    // And the top edge stays up for every frame in between, which is the point.
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const pose = orbitFlightStep(from, to, Math.min(1, t))
      expect(screenAxis(pose.quaternion, 'up').y).toBeGreaterThan(0.99)
    }
  })

  test('which is exactly what interpolating the positions could not do', () => {
    // The bug this replaced: opposed views are antipodal, so the straight line
    // between the two camera positions passes through the target.
    const fromPosition = new THREE.Vector3(0, 0, 100)
    const toPosition = new THREE.Vector3(0, 0, -100)
    const chord = fromPosition.clone().lerp(toPosition, 0.5)
    expect(chord.distanceTo(TARGET)).toBeLessThan(1e-9)
  })

  test('the board stays centered in frame throughout', () => {
    const from = poseFor(ISO, 80)
    const to = poseFor(BOTTOM, 80)
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const pose = orbitFlightStep(from, to, Math.min(1, t))
      const view = targetInView(pose)
      expect(Math.abs(view.x)).toBeLessThan(1e-6)
      expect(Math.abs(view.y)).toBeLessThan(1e-6)
      expect(view.z).toBeCloseTo(-80, 6)
    }
  })

  test('lands exactly on the destination pose', () => {
    const from = poseFor(TOP, 100)
    const to = poseFor(ISO, 140)
    const end = orbitFlightStep(from, to, 1)
    const expected = TARGET.clone().addScaledVector(ISO.clone().normalize(), 140)
    expect(end.position.distanceTo(expected)).toBeLessThan(1e-6)
    expect(end.quaternion.angleTo(to.quaternion)).toBeLessThan(1e-6)
  })

  test('starts exactly where the camera already is', () => {
    const from = poseFor(ISO, 55)
    const start = orbitFlightStep(from, poseFor(TOP, 120), 0)
    const expected = TARGET.clone().addScaledVector(ISO.clone().normalize(), 55)
    expect(start.position.distanceTo(expected)).toBeLessThan(1e-6)
  })

  test('a changed distance eases in step with the arc', () => {
    // fitView3D can fly to a different radius; it should sweep, not lunge.
    const mid = orbitFlightStep(poseFor(TOP, 50), poseFor(BOTTOM, 150), 0.5)
    expect(mid.position.distanceTo(TARGET)).toBeCloseTo(100, 6)
  })

  test('a moved target is carried along', () => {
    const to = new THREE.Vector3(20, 10, 0)
    const mid = orbitFlightStep(poseFor(TOP, 100), poseFor(BOTTOM, 100, to), 0.5)
    expect(mid.target.x).toBeCloseTo(10, 6)
    expect(mid.target.y).toBeCloseTo(5, 6)
    expect(mid.position.distanceTo(mid.target)).toBeCloseTo(100, 6)
  })
})
