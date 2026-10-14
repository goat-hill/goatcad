import { describe, expect, test } from 'vitest'
import { drillShape, holeAnnulus, holeWallWidth, padHoleShape } from '../holes'
import type { KicadPad } from '../../kicad/footprint'
import { mmToNm as mm } from '../../kicad/coordinates'

const pad = (over: Partial<KicadPad>): KicadPad =>
  ({
    number: '1',
    type: 'thru_hole',
    shape: 'circle',
    position: { x: mm(0), y: mm(0) },
    size: { w: mm(2), h: mm(2) },
    layers: ['*.Cu'],
    ...over
  }) as KicadPad

describe('padHoleShape', () => {
  test('a round drill is a rounded rect with a full corner radius', () => {
    const hole = padHoleShape(pad({ drill: { diameter: mm(1) } }), 0)
    expect(hole).toEqual({ dx: 0, dy: 0, offset: 0, halfW: 0.5, halfH: 0.5, cornerR: 0.5 })
  })

  test('an oval drill keeps both axes — the slot a fab actually routes', () => {
    const hole = padHoleShape(
      pad({ drill: { diameter: mm(1), oval: { width: mm(2), height: mm(1) } } }),
      0
    )
    expect(hole).toMatchObject({ halfW: 1, halfH: 0.5, cornerR: 0.5 })
  })

  test('a drill offset is mirrored into scene space and turns with the pad', () => {
    const drill = { diameter: mm(1), offset: { x: mm(0.5), y: mm(0.25) } }
    expect(padHoleShape(pad({ drill }), 0)).toMatchObject({ dx: 0.5, dy: -0.25 })

    // A quarter turn CCW sends +x to +y and the mirrored -y offset to +x.
    const turned = padHoleShape(pad({ drill }), Math.PI / 2)
    expect(turned?.dx).toBeCloseTo(0.25)
    expect(turned?.dy).toBeCloseTo(0.5)
    expect(turned?.offset).toBeCloseTo(Math.hypot(0.5, 0.25))
  })

  test('only thru-hole pads bore: an SMD pad with a stray drill node does not', () => {
    expect(padHoleShape(pad({ type: 'smd', drill: { diameter: mm(1) } }), 0)).toBeNull()
    expect(
      padHoleShape(pad({ type: 'np_thru_hole', drill: { diameter: mm(1) } }), 0)
    ).not.toBeNull()
    expect(padHoleShape(pad({}), 0)).toBeNull()
  })

  test('a zero-size drill draws nothing rather than a degenerate instance', () => {
    expect(drillShape({ diameter: mm(0) }, 0)).toBeNull()
    expect(drillShape({ diameter: mm(1), oval: { width: mm(1), height: mm(0) } }, 0)).toBeNull()
  })
})

describe('hole walls', () => {
  const hole = (halfW: number, halfH = halfW, offset = 0): ReturnType<typeof drillShape> => ({
    dx: offset,
    dy: 0,
    offset,
    halfW,
    halfH,
    cornerR: Math.min(halfW, halfH)
  })

  test('the wall scales with the bore, between a floor and a ceiling', () => {
    expect(holeWallWidth(hole(0.5)!, 1)).toBeCloseTo(0.125)
    expect(holeWallWidth(hole(0.05)!, 1)).toBeCloseTo(0.04)
    expect(holeWallWidth(hole(5)!, 5)).toBeCloseTo(0.15)
  })

  test('a thin annular ring keeps most of its copper', () => {
    expect(holeWallWidth(hole(0.5)!, 0.1)).toBeCloseTo(0.06)
  })

  test('a bore no smaller than its pad still gets an edge to read by', () => {
    expect(holeWallWidth(hole(0.5)!, 0)).toBeCloseTo(0.125)
    expect(holeWallWidth(hole(0.5)!, -0.2)).toBeCloseTo(0.125)
    // Squeezed by a hair of copper, the wall bottoms out rather than vanishing
    expect(holeWallWidth(hole(0.5)!, 0.001)).toBeCloseTo(0.04)
  })

  test('the annulus is the narrowest copper left, offset included', () => {
    expect(holeAnnulus(hole(0.5)!, 1, 1.5)).toBeCloseTo(0.5)
    expect(holeAnnulus(hole(0.5, 0.5, 0.2)!, 1, 1)).toBeCloseTo(0.3)
  })
})
