import { describe, expect, test } from 'vitest'
import { footprintItemAnchors, footprintSnapTargets } from '../moveAnchors'
import { parseKicadFootprint } from '../kicad/footprint'

const footprint = parseKicadFootprint(`(footprint "T" (layer "F.Cu")
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "B.Cu"))
  (fp_line (start 0 2) (end 4 2) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
)`)
const mm = (x: number, y: number): { x: number; y: number } => ({ x: x * 1e6, y: y * 1e6 })

describe('footprint move anchors', () => {
  test('a line grabs by its ends and middle', () => {
    expect(footprintItemAnchors(footprint, { type: 'line', index: 0 })).toEqual([
      mm(0, 2),
      mm(4, 2),
      mm(2, 2)
    ])
  })

  test('a move snaps to the pads and drawings on the active layer, its own aside', () => {
    const onFront = (layers: readonly string[]): boolean => layers.includes('F.Cu')
    expect(footprintSnapTargets(footprint, [], onFront)).toEqual([mm(-1, 0)])
    expect(footprintSnapTargets(footprint, [{ type: 'pad', index: 0 }], onFront)).toEqual([])
  })
})
