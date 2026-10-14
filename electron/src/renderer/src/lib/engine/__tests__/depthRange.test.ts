import { describe, expect, test } from 'vitest'
import { depthRangeFor } from '../ViewportEngine'

/**
 * The board's layer stack is microns thick — `BoardScene3D` puts a pad 10µm
 * above the track it covers — so what these tests really pin is the depth
 * RESOLUTION the range buys, not the numbers themselves.
 *
 * For a perspective projection with a 24-bit depth buffer, the smallest
 * resolvable world step at eye distance z is approximately
 *   z² · (1/near − 1/far) / 2²⁴
 * which is why the near plane, not the far one, is where the precision goes.
 */
const resolutionMm = (distance: number, near: number, far: number): number =>
  (distance * distance * (1 / near - 1 / far)) / 2 ** 24

/** The tightest gap in the stack: pad height minus track height. */
const PAD_OVER_TRACK_MM = 0.01

describe('depthRangeFor', () => {
  test('the range hugs the content', () => {
    const { near, far } = depthRangeFor(200, 50)
    expect(near).toBeCloseTo(200 - 52.5, 6)
    expect(far).toBeCloseTo(200 + 52.5, 6)
  })

  test('resolves the pad-over-track gap with room to spare, fitted', () => {
    // A 100mm board framed by fitView3D sits near this distance — the case the
    // old fixed 0.1/1000 range already failed at.
    const { near, far } = depthRangeFor(170, 70)
    expect(resolutionMm(170, near, far)).toBeLessThan(PAD_OVER_TRACK_MM / 100)
    // What it replaced, for the record: coarser than the gap it must resolve.
    expect(resolutionMm(170, 0.1, 1000)).toBeGreaterThan(PAD_OVER_TRACK_MM)
  })

  test('zooming out does not degrade the resolution', () => {
    // The whole point: precision follows the board's depth, not the distance to
    // it. Ten times further away must not cost an order of magnitude.
    const near = depthRangeFor(170, 70)
    const far = depthRangeFor(1700, 70)
    const ratio = resolutionMm(1700, far.near, far.far) / resolutionMm(170, near.near, near.far)
    expect(ratio).toBeLessThan(2)
    expect(resolutionMm(1700, far.near, far.far)).toBeLessThan(PAD_OVER_TRACK_MM / 100)
  })

  test('the near plane stays positive with the camera inside the content', () => {
    // Zoomed in among the parts, distance − radius goes negative; the floor
    // catches it and keeps the far/near ratio bounded at 10⁴.
    const { near, far } = depthRangeFor(2, 70)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeCloseTo(far * 1e-4, 12)
    expect(resolutionMm(2, near, far)).toBeLessThan(PAD_OVER_TRACK_MM / 100)
  })

  test('a degenerate bound still yields a usable frustum', () => {
    const { near, far } = depthRangeFor(10, 0)
    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
  })
})
