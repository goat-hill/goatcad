import { describe, expect, test } from 'vitest'
import {
  alignToStartAxes,
  arcGridCrossings,
  entryPoint,
  routeTarget,
  segmentGridCrossings
} from '../routeTarget'
import { pointToShape, type CopperItem, type CopperShape, type NearHit } from '../spatialIndex'

let nextId = 0
const item = (
  ref: CopperItem['ref'],
  shape: CopperShape,
  layers: string[] = ['F.Cu'],
  anchor?: { x: number; y: number }
): CopperItem => ({
  id: nextId++,
  ref,
  net: 1,
  layers,
  shape,
  ...(anchor ? { anchor } : {}),
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0
})

const pad = (cx: number, cy: number, halfW: number, halfH: number, layers?: string[]): CopperItem =>
  item(
    { type: 'pad', index: 0, pad: nextId },
    { kind: 'rrect', cx, cy, halfW, halfH, cornerR: 0, rotation: 0 },
    layers,
    { x: cx, y: cy }
  )
const track = (x0: number, y0: number, x1: number, y1: number, layers?: string[]): CopperItem =>
  item(
    { type: 'segment', index: nextId },
    { kind: 'capsule', x0, y0, x1, y1, halfWidth: 0.1 },
    layers
  )

const hitsAt = (items: CopperItem[], p: { x: number; y: number }): NearHit[] =>
  items.map((it) => ({ item: it, dist: pointToShape(it.shape, p.x, p.y) }))

const onGrid = (step: number) => (p: { x: number; y: number }) => ({
  x: Math.round(p.x / step) * step,
  y: Math.round(p.y / step) * step
})

const options = {
  reach: 0.5,
  pointable: (it: CopperItem) => it.layers,
  grid: onGrid(0.5)
}

describe('routeTarget (R28)', () => {
  test('the pad under the cursor wins over a nearer neighbour’s center', () => {
    // A long pad whose tip is nearer the next pad's center than its own.
    const long = pad(0, 0, 2, 0.3)
    const next = pad(2.6, 0, 0.3, 0.3)
    const cursor = { x: 1.9, y: 0 }
    expect(routeTarget(hitsAt([long, next], cursor), cursor, options)?.item).toBe(long)
  })

  test('near is measured from the outline, so a large pad captures from its edge', () => {
    const big = pad(0, 0, 3, 3)
    const cursor = { x: 3.3, y: 0 }
    expect(routeTarget(hitsAt([big], cursor), cursor, options)?.point).toEqual({ x: 0, y: 0 })
  })

  test('a pad outranks a track under the cursor with it', () => {
    const p = pad(0, 0, 0.5, 0.5)
    const t = track(-2, 0, 2, 0)
    const cursor = { x: 0.2, y: 0 }
    expect(routeTarget(hitsAt([t, p], cursor), cursor, options)?.item).toBe(p)
  })

  test('copper on the active layer outranks the other side’s', () => {
    const back = pad(0, 0, 0.5, 0.5, ['B.Cu'])
    const front = pad(0, 0, 0.5, 0.5, ['F.Cu'])
    const cursor = { x: 0, y: 0 }
    const target = routeTarget(hitsAt([back, front], cursor), cursor, {
      ...options,
      activeLayer: 'F.Cu'
    })
    expect(target?.item).toBe(front)
  })

  test('mid-route, copper off the routed layer is no target (R30)', () => {
    const back = pad(0, 0, 0.5, 0.5, ['B.Cu'])
    const cursor = { x: 0, y: 0 }
    expect(routeTarget(hitsAt([back], cursor), cursor, { ...options, layer: 'F.Cu' })).toBeNull()
  })

  test('a track pulls from as far as a pad: the reach, from its outline (KiCad’s grid step)', () => {
    const t = track(-2, 0, 2, 0)
    expect(routeTarget(hitsAt([t], { x: 0, y: 0.45 }), { x: 0, y: 0.45 }, options)).not.toBeNull()
    expect(routeTarget(hitsAt([t], { x: 0, y: 0.65 }), { x: 0, y: 0.65 }, options)).toBeNull()
  })

  test('near, the active layer’s track outranks another layer’s pad', () => {
    const back = pad(0, 0.6, 0.2, 0.2, ['B.Cu'])
    const t = track(-2, 0, 2, 0, ['F.Cu'])
    const cursor = { x: 0, y: 0.35 }
    const target = routeTarget(hitsAt([back, t], cursor), cursor, {
      ...options,
      activeLayer: 'F.Cu'
    })
    expect(target?.item).toBe(t)
  })

  test('within a rank, the nearest center wins, not the nearest outline', () => {
    // The big pad's outline is nearer the cursor; the small pad's center is.
    const big = pad(-1.6, 0, 1.4, 1.4)
    const small = pad(0.6, 0, 0.1, 0.1)
    const cursor = { x: 0.05, y: 0 }
    expect(routeTarget(hitsAt([big, small], cursor), cursor, options)?.item).toBe(small)
  })

  test('copper the person cannot point at is no target', () => {
    const p = pad(0, 0, 0.5, 0.5)
    const cursor = { x: 0, y: 0 }
    expect(routeTarget(hitsAt([p], cursor), cursor, { ...options, pointable: () => [] })).toBeNull()
  })
})

describe('entryPoint (R29)', () => {
  test('a pad is entered at its anchor, not its copper’s center', () => {
    const offset = item(
      { type: 'pad', index: 0, pad: 0 },
      { kind: 'circle', cx: 0.4, cy: 0, r: 1 },
      ['F.Cu'],
      { x: 0, y: 0 }
    )
    expect(entryPoint(offset, { x: 0.8, y: 0.2 }, options.grid)).toEqual({ x: 0, y: 0 })
  })

  test('a track end within its half width is entered at the end', () => {
    const t = track(0, 0, 4, 0)
    expect(entryPoint(t, { x: 3.95, y: 0.05 }, options.grid)).toEqual({ x: 4, y: 0 })
  })

  test('elsewhere a track is entered where the grid crosses it', () => {
    const t = track(0, 0, 4, 0)
    const p = entryPoint(t, { x: 1.2, y: 0.05 }, options.grid)
    expect(p.x).toBeCloseTo(1)
    expect(p.y).toBeCloseTo(0)
  })

  test('with the grid off, at the centerline point nearest the cursor', () => {
    const t = track(0, 0, 4, 0)
    expect(entryPoint(t, { x: 1.23, y: 0.05 }, () => null)).toEqual({ x: 1.23, y: 0 })
  })

  test('an arc is entered in its middle too', () => {
    const arc = item(
      { type: 'tarc', index: 0 },
      {
        kind: 'arc',
        x0: 1,
        y0: 0,
        mx: Math.SQRT1_2,
        my: Math.SQRT1_2,
        x1: 0,
        y1: 1,
        halfWidth: 0.05
      }
    )
    const p = entryPoint(arc, { x: 0.72, y: 0.69 }, () => null)
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1)
  })
})

describe('grid crossings', () => {
  test('a segment meets the row, the column and the diagonals through the point', () => {
    const crossings = segmentGridCrossings({ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 0 })
    expect(crossings.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)]).sort()).toEqual([
      [-1, 1],
      [0, 1],
      [1, 1]
    ])
  })

  test('an arc keeps only the crossings within its sweep', () => {
    // The quarter circle from (1,0) to (0,1): the column x=0.5 crosses it once, at y>0.
    const crossings = arcGridCrossings(
      { x0: 1, y0: 0, mx: Math.SQRT1_2, my: Math.SQRT1_2, x1: 0, y1: 1 },
      { x: 0.5, y: 5 }
    )
    expect(crossings.some((p) => Math.abs(p.x - 0.5) < 1e-9 && p.y > 0)).toBe(true)
    expect(crossings.every((p) => p.x >= -1e-9 && p.y >= -1e-9)).toBe(true)
  })
})

describe("the start point's axes (R47)", () => {
  // An off-grid pad at (1.13, 2.07) on a 0.25 grid.
  const start = { x: 1.13, y: 2.07 }

  test("a pointer nearer the start's y than the grid line takes the start's y", () => {
    const raw = { x: 3.02, y: 2.09 }
    expect(alignToStartAxes(raw, { x: 3, y: 2 }, start)).toEqual({ x: 3, y: 2.07 })
  })

  test('and its x likewise, each coordinate on its own', () => {
    const raw = { x: 1.15, y: 4.2 }
    expect(alignToStartAxes(raw, { x: 1.25, y: 4.25 }, start)).toEqual({ x: 1.13, y: 4.25 })
  })

  test('a grid line nearer than the axis keeps the grid; no start, the grid alone', () => {
    const raw = { x: 3.02, y: 2.2 }
    expect(alignToStartAxes(raw, { x: 3, y: 2.25 }, start)).toEqual({ x: 3, y: 2.25 })
    expect(alignToStartAxes({ x: 3.02, y: 2.09 }, { x: 3, y: 2 }, null)).toEqual({ x: 3, y: 2 })
  })
})
