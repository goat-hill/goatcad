import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { locateBoardItems } from '../boardLocate'

const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "A")
  (footprint "T:R" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pad-1")))
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "seg-1"))
  (arc (start 120 110) (mid 122 112) (end 124 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "arc-1"))
  (via (at 115 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-1"))
  (zone (net 1) (net_name "A") (layer "F.Cu") (uuid "zone-1") (polygon (pts (xy 100 100) (xy 140 100) (xy 140 140))))
  (gr_line (start 100 100) (end 140 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-1"))
)`)

describe('locateBoardItems', () => {
  test('maps uuids of every selectable kind to the editor selection, in kind order', () => {
    expect(
      locateBoardItems(board, ['via-1', 'fp-1', 'seg-1', 'arc-1', 'zone-1', 'edge-1'])
    ).toEqual([
      { type: 'footprint', index: 0 },
      { type: 'segment', index: 0 },
      { type: 'tarc', index: 0 },
      { type: 'via', index: 0 },
      { type: 'zone', index: 0 },
      { type: 'gr_line', index: 0 }
    ])
  })

  test("a pad's uuid and an unknown id select nothing", () => {
    expect(locateBoardItems(board, ['pad-1', 'nope'])).toEqual([])
  })
})
