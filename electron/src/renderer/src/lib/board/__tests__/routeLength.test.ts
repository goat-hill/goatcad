import { describe, expect, test } from 'vitest'
import { chordsLength, pendingRouteLength } from '../routeLength'

describe('a route in progress, measured', () => {
  test('straight pieces and a quarter arc', () => {
    expect(chordsLength([{ x0: 0, y0: 0, x1: 3, y1: 4 }])).toBeCloseTo(5, 9)
    const r = 2
    const mid = { x: r * Math.SQRT1_2, y: r - r * Math.SQRT1_2 }
    expect(chordsLength([{ x0: 0, y0: 0, x1: r, y1: r, mid }])).toBeCloseTo((Math.PI * r) / 2, 9)
  })

  test('a via adds the height between the layers its tracks join, only where heights count', () => {
    const draft = {
      segments: [{ x0: 0, y0: 0, x1: 10, y1: 0, layer: 'F.Cu' }],
      vias: [{ x: 10, y: 0 }],
      tail: { x: 10, y: 0 }
    }
    const head = { length: 4, layer: 'B.Cu' }
    const distance = (a: string, b: string): number => (a === b ? 0 : 1.6)
    expect(pendingRouteLength(draft, head, distance)).toBeCloseTo(15.6, 9)
    expect(pendingRouteLength(draft, head, null)).toBeCloseTo(14, 9)
  })
})
