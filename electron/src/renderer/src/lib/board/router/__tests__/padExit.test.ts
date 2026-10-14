import { describe, expect, test } from 'vitest'
import { padExit, padExits } from '../padExit'
import type { CopperItem, CopperShape } from '../../spatialIndex'

// docs/router-behavior.md R38.

const pad = (halfW: number, halfH: number, rotation = 0, cornerR = 0): CopperItem => {
  const shape: CopperShape = { kind: 'rrect', cx: 0, cy: 0, halfW, halfH, cornerR, rotation }
  return {
    id: 0,
    ref: { type: 'pad', index: 0, pad: 0 },
    net: 1,
    layers: ['F.Cu'],
    shape,
    anchor: { x: 0, y: 0 },
    minX: -2,
    minY: -2,
    maxX: 2,
    maxY: 2
  }
}
const O = { x: 0, y: 0 }
const near = (p: { x: number; y: number } | undefined, x: number, y: number): void => {
  expect(p?.x).toBeCloseTo(x, 9)
  expect(p?.y).toBeCloseTo(y, 9)
}

describe('padExit (R38)', () => {
  const wide = pad(1, 0.5)

  test('out along the axis pointing most nearly where the route goes, to the edge', () => {
    near(padExit(wide, O, { x: 5, y: 3 })?.at, 1, 0)
    near(padExit(wide, O, { x: 0.5, y: 5 })?.at, 0, 0.5)
    near(padExit(wide, O, { x: -4, y: -1 })?.at, -1, 0)
  })

  test('the long axis on a near tie', () => {
    near(padExit(wide, O, { x: 5, y: 5.2 })?.at, 1, 0)
  })

  test('the direction last taken holds until another is clearly nearer', () => {
    // Up through the short side, unless the long axis (direction 0) was taken last.
    near(padExit(wide, O, { x: 5, y: 6 })?.at, 0, 0.5)
    near(padExit(wide, O, { x: 5, y: 6 }, 0)?.at, 1, 0)
    near(padExit(wide, O, { x: 1, y: 6 }, 0)?.at, 0, 0.5)
  })

  test('turned with the pad', () => {
    const a = Math.PI / 6
    const p = padExit(pad(1, 0.5, a), O, { x: 5 * Math.cos(a), y: 5 * Math.sin(a) })
    near(p?.at, Math.cos(a), Math.sin(a))
  })

  test('from an anchor off the copper center, to the same edge', () => {
    near(padExit(wide, { x: 0.3, y: 0 }, { x: 5, y: 0.5 })?.at, 1, 0)
  })

  test('no direction: round, square at a multiple of 45°, or the far end inside it', () => {
    expect(padExit(pad(0.5, 0.5, 0, 0.5), O, { x: 5, y: 3 })).toBeNull()
    expect(padExit(pad(0.5, 0.5), O, { x: 5, y: 3 })).toBeNull()
    expect(padExit(pad(0.5, 0.5, Math.PI / 4), O, { x: 5, y: 3 })).toBeNull()
    expect(padExit(pad(0.5, 0.5, Math.PI / 6), O, { x: 5, y: 3 })).not.toBeNull()
    expect(padExit(wide, O, { x: 0.8, y: 0.2 })).toBeNull()
  })

  test('every exit: the four axes to the edge, and out through each corner at 45°', () => {
    const exits = padExits(wide, O)
    const key = (p: { x: number; y: number }): string => `${+p.x.toFixed(6)},${+p.y.toFixed(6)}`
    // Each ends on an edge's middle or a corner, all eight.
    expect(exits.map((e) => key(e.points[e.points.length - 1])).sort()).toEqual(
      ['1,0', '0,0.5', '-1,0', '0,-0.5', '1,0.5', '-1,0.5', '-1,-0.5', '1,-0.5'].sort()
    )
    for (const e of exits) near(e.points[0], 0, 0)
    // Along the long axis to x = 0.5, then 45° out through the corner (1, 0.5).
    const corner = exits.find((e) => key(e.points[e.points.length - 1]) === '1,0.5')!.points
    near(corner[1], 0.5, 0)
  })

  test('no exits where the pad sets no direction', () => {
    expect(padExits(pad(0.5, 0.5, 0, 0.5), O)).toEqual([])
    expect(padExits(pad(0.5, 0.5), O)).toEqual([])
  })
})
