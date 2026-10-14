import { describe, expect, test } from 'vitest'
import {
  footprintBoxSelect,
  footprintItemLocked,
  rankFootprintHits,
  type FootprintBoxSelectContext,
  type RankedFootprintHit
} from '../FootprintScene'
import { parseKicadFootprint } from '../../kicad/footprint'

/**
 * The footprint's band test, against a real parsed footprint. The band arrives
 * in engine space — millimetres, y up — so a file's `(at x y)` sits at y = -y.
 * Items keep to lanes of their own so a band can take one alone: pads at
 * y 0 and 10, the line at y 20, the text at y 30, the silk circle at y 40.
 */
const footprint = parseKicadFootprint(`(footprint "Test"
  (layer "F.Cu")
  (pad "1" smd rect (at 10 0) (size 4 1) (layers "F.Cu"))
  (pad "2" smd rect (at 10 10 90) (size 4 1) (layers "F.Cu") (locked yes))
  (fp_line (start 0 20) (end 5 20) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
  (fp_text user "HELLO" (at 5 30) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_circle (center 50 40) (end 52 40) (stroke (width 0.1) (type solid)) (fill none) (layer "B.SilkS"))
)`)

const everyLayer: FootprintBoxSelectContext = { isLayerVisible: () => true }

/** A band around a file-space rect (y down), handed over in engine space. */
const band = (
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { xMin: number; xMax: number; yMin: number; yMax: number } => ({
  xMin: Math.min(x0, x1),
  xMax: Math.max(x0, x1),
  yMin: -Math.max(y0, y1),
  yMax: -Math.min(y0, y1)
})

const types = (refs: Array<{ type: string; index: number }>): string[] =>
  refs.map((r) => `${r.type}:${r.index}`)

describe('footprintBoxSelect', () => {
  test('a pad is found where it is, in millimetres', () => {
    // The old band compared nanometre positions against a millimetre band,
    // so a pad 10 mm out was ten million units away from any band.
    const taken = footprintBoxSelect(footprint, band(7, -1, 13, 1), false, everyLayer)
    expect(types(taken)).toEqual(['pad:0'])
  })

  test('a turned pad is measured by its turned extent', () => {
    // Pad 2 is 4 × 1 turned 90°: 1 wide and 4 tall. A band 2 wide and 5 tall
    // encloses it; one 5 wide and 2 tall, which would hold it unturned, does not.
    expect(types(footprintBoxSelect(footprint, band(9, 7.5, 11, 12.5), false, everyLayer))).toEqual(
      ['pad:1']
    )
    expect(types(footprintBoxSelect(footprint, band(7.5, 9, 12.5, 11), false, everyLayer))).toEqual(
      []
    )
  })

  test('a window takes what it holds, a crossing band what it touches', () => {
    const halfOverLine = band(-1, 19, 2, 21)
    expect(types(footprintBoxSelect(footprint, halfOverLine, false, everyLayer))).toEqual([])
    expect(types(footprintBoxSelect(footprint, halfOverLine, true, everyLayer))).toEqual(['line:0'])
  })

  test('a text is taken by its glyphs, not by its anchor point alone', () => {
    // A band that holds the anchor but not the glyphs takes nothing as a
    // window; one round the whole word does.
    expect(
      types(footprintBoxSelect(footprint, band(4.5, 29.5, 5.5, 30.5), false, everyLayer))
    ).toEqual([])
    expect(types(footprintBoxSelect(footprint, band(0, 28, 10, 32), false, everyLayer))).toEqual([
      'text:0'
    ])
  })

  test('an item on a layer that cannot be selected is left out', () => {
    const noBackSilk: FootprintBoxSelectContext = {
      isLayerVisible: (layer) => layer !== 'B.SilkS'
    }
    const aroundCircle = band(45, 35, 55, 45)
    expect(types(footprintBoxSelect(footprint, aroundCircle, false, everyLayer))).toEqual([
      'circle:0'
    ])
    expect(types(footprintBoxSelect(footprint, aroundCircle, false, noBackSilk))).toEqual([])
  })
})

describe('footprintItemLocked', () => {
  test('reads the flag of the item named', () => {
    expect(footprintItemLocked(footprint, { type: 'pad', index: 0 })).toBe(false)
    expect(footprintItemLocked(footprint, { type: 'pad', index: 1 })).toBe(true)
    expect(footprintItemLocked(footprint, { type: 'zone', index: 0 })).toBe(false)
  })
})

describe('rankFootprintHits', () => {
  const hit = (type: string, dist: number, rank: number, order: number): RankedFootprintHit => ({
    ref: { type, index: 0 },
    kind: type,
    locked: false,
    dist,
    rank,
    order
  })

  test('nearest wins', () => {
    const ranked = rankFootprintHits([hit('pad', 0.2, 9.5, 0), hit('line', 0.5, 3, 1)])
    expect(ranked.map((h) => h.ref.type)).toEqual(['pad', 'line'])
  })

  test('at equal distance a graphic outranks the pad under it, whatever the order found', () => {
    const ranked = rankFootprintHits([hit('pad', 0, 9.5, 0), hit('line', 0, 3, 1)])
    expect(ranked.map((h) => h.ref.type)).toEqual(['line', 'pad'])
  })

  test('equal in distance and rank, the first found stays first', () => {
    const ranked = rankFootprintHits([hit('text', 0, 8, 0), hit('property', 0, 8, 1)])
    expect(ranked.map((h) => h.ref.type)).toEqual(['text', 'property'])
  })
})
