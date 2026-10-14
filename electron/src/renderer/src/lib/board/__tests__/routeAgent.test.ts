import { describe, expect, test } from 'vitest'
import { violationOf } from '../routeAgent'
import type { ViolationMark } from '../router/engine'

const mark = (o: Partial<ViolationMark>): ViolationMark => ({
  shape: { kind: 'circle', cx: 0, cy: 0, r: 0.3 },
  layer: 'F.Cu',
  clearance: 0.2,
  copper: true,
  ...o
})

describe('a route violation reads as a board_check finding', () => {
  test('with its gap, the clearance is a floor in millimeters', () => {
    expect(violationOf('U1.2', mark({ actual: 0.123456 }))).toEqual({
      items: ['U1.2'],
      layer: 'F.Cu',
      measure: { actual: 0.1235, limit: 0.2, bound: 'min', unit: 'mm' }
    })
  })

  test('without one, the item and layer alone', () => {
    expect(violationOf('U1.2', mark({}))).toEqual({ items: ['U1.2'], layer: 'F.Cu' })
  })
})
