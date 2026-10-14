import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { boardItemLabel } from '../boardItemLabel'

// Select Other's rows: a primitive's shared name, then what tells it from its
// neighbours under the pointer. The translator echoes the key, so a row reads
// as the keys it was built from.
const t = (key: string): string => key.replace('shared.primitives.', '')

const board = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (37 "F.SilkS" user)
  )
  (net 0 "")
  (net 1 "GND")
  (footprint "R:R_0603" (layer "F.Cu") (at 5 5)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu"))
  )
  (segment (start 2 5) (end 3 5) (width 0.3) (layer "B.Cu") (net 1) (uuid "s"))
  (segment (start 2 6) (end 3 6) (width 0.3) (layer "F.Cu") (net 0) (uuid "s0"))
  (via (at 4 4) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v"))
  (gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l"))
  (gr_text "A long line of silkscreen words\\nsecond" (at 1 1) (layer "F.SilkS") (uuid "t"))
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "k") (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)`)

describe('boardItemLabel', () => {
  test('copper names its layer and net', () => {
    expect(boardItemLabel(board, { type: 'segment', index: 0 }, t)).toBe('track · B.Cu · GND')
    expect(boardItemLabel(board, { type: 'via', index: 0 }, t)).toBe('via · GND')
  })

  test('a track on no net says nothing of one', () => {
    expect(boardItemLabel(board, { type: 'segment', index: 1 }, t)).toBe('track · F.Cu')
  })

  test('a footprint names its reference and side, a pad its number and part', () => {
    expect(boardItemLabel(board, { type: 'footprint', index: 0 }, t)).toBe('footprint · R1 · F.Cu')
    expect(boardItemLabel(board, { type: 'pad', index: 0, pad: 0 }, t)).toBe('pad · 2 · R1')
  })

  test('a graphic names its layer, a text its first words', () => {
    expect(boardItemLabel(board, { type: 'gr_line', index: 0 }, t)).toBe('line · F.SilkS')
    expect(boardItemLabel(board, { type: 'gr_text', index: 0 }, t)).toBe(
      'text · A long line of silkscre… · F.SilkS'
    )
  })

  test('a keepout zone is a rule area', () => {
    expect(boardItemLabel(board, { type: 'zone', index: 0 }, t)).toBe('ruleArea · F.Cu')
  })
})
