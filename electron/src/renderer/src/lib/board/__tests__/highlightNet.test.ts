import { describe, expect, test } from 'vitest'
import { pickHighlightNet, type NetPickInput } from '../highlightNet'
import { nm, type Nm } from '../../kicad/coordinates'

const square = (x0: number, y0: number, x1: number, y1: number): Array<{ x: Nm; y: Nm }> =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ].map(([x, y]) => ({ x: nm(x), y: nm(y) }))

/** A pour on one layer, 0..100 nm square: the point 50,50 is inside it. */
const pour = (net: number, layer: string): NetPickInput['zones'][number] => ({
  net,
  isKeepout: false,
  layers: [layer],
  filledPolys: [{ layer, points: square(0, 0, 100, 100) }]
})

const pick = (over: Partial<NetPickInput>): number =>
  pickHighlightNet({
    copper: [],
    zones: [],
    at: { x: 50, y: 50 },
    activeLayer: 'F.Cu',
    interactable: () => true,
    ...over
  })

describe('pickHighlightNet', () => {
  test('copper on the active layer before nearer copper on another', () => {
    const copper = [
      { net: 3, layers: ['B.Cu'], dist: 0 },
      { net: 4, layers: ['F.Cu'], dist: 0.2 }
    ]
    expect(pick({ copper })).toBe(4)
    expect(pick({ copper, activeLayer: 'B.Cu' })).toBe(3)
  })

  test('copper before the pour it sits in, and netless copper not at all', () => {
    const zones = [pour(1, 'F.Cu')]
    expect(pick({ copper: [{ net: 5, layers: ['F.Cu'], dist: 0 }], zones })).toBe(5)
    expect(pick({ copper: [{ net: 0, layers: ['F.Cu'], dist: 0 }], zones })).toBe(1)
  })

  test("a pour's fill under the point, the active layer's first", () => {
    const zones = [pour(2, 'B.Cu'), pour(1, 'F.Cu')]
    expect(pick({ zones })).toBe(1)
    expect(pick({ zones, activeLayer: 'B.Cu' })).toBe(2)
    expect(pick({ zones, at: { x: 150, y: 50 } })).toBe(0)
  })

  test('nothing on a layer that cannot be picked, and no keepout', () => {
    expect(pick({ zones: [pour(1, 'F.Cu')], interactable: () => false })).toBe(0)
    expect(pick({ zones: [{ ...pour(1, 'F.Cu'), isKeepout: true }] })).toBe(0)
  })
})
