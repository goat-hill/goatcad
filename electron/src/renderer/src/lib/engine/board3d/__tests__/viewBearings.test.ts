import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { bearingDirection } from '../boardCapture3D'
import { VIEW_BEARINGS } from '../viewBearings'

const close = (a: THREE.Vector3, b: [number, number, number]): void => {
  expect(a.x).toBeCloseTo(b[0], 3)
  expect(a.y).toBeCloseTo(b[1], 3)
  expect(a.z).toBeCloseTo(b[2], 3)
}

describe('bearingDirection', () => {
  it('points the camera from the front, the right, above and below', () => {
    close(bearingDirection(0, 0), [0, -1, 0])
    close(bearingDirection(90, 0), [1, 0, 0])
    close(bearingDirection(-90, 0), [-1, 0, 0])
    close(bearingDirection(0, 90), [0, 0, 1])
    close(bearingDirection(0, -90), [0, 0, -1])
  })

  it("matches the PCB editor's iso preset", () => {
    const { azimuth, elevation } = VIEW_BEARINGS.iso
    const direction = bearingDirection(azimuth, elevation)
    const pane = new THREE.Vector3(0.72, -0.82, 0.62).normalize()
    expect(direction.distanceTo(pane)).toBeLessThan(1e-3)
  })

  it('keeps straight down a unit vector the camera can orient to', () => {
    expect(bearingDirection(45, 90).length()).toBeCloseTo(1, 6)
  })
})
