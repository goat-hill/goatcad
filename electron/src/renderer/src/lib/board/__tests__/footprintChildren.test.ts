import { describe, expect, it } from 'vitest'
import { parseKicadBoard, serializeKicadBoard } from '../../kicad/board'
import { updatePropertyInAST } from '../../kicad/footprint'
import { markNodeDirty } from '../../kicad/sexpr'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  boardDeltaInFootprint,
  boardPointInFootprint,
  footprintPointOnBoard,
  footprintTextOf
} from '../footprintChildren'

const board = (angle: number): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (37 "F.SilkS" user))
  (footprint "R:R_0603" (layer "F.Cu") (at 100 60 ${angle}) (uuid "u1")
    (property "Reference" "R1" (at 0 -1.5 ${angle}) (layer "F.SilkS") (effects (font (size 1 1))))
    (fp_text user "hi" (at 1 0 ${angle}) (layer "F.SilkS") (effects (font (size 1 1)))))
)`)

describe('a footprint’s fields and texts on the board', () => {
  it('resolves a field and a text by their refs, and nothing for a stale one', () => {
    const b = board(0)
    expect(footprintTextOf(b, { type: 'fp_field', index: 0, child: 0 })?.item).toBe(
      b.footprints[0].footprint.properties[0]
    )
    expect(footprintTextOf(b, { type: 'fp_text', index: 0, child: 0 })?.kind).toBe('text')
    expect(footprintTextOf(b, { type: 'fp_text', index: 0, child: 5 })).toBeUndefined()
    expect(footprintTextOf(b, { type: 'via', index: 0 })).toBeUndefined()
  })

  it('places a child on the board through its footprint’s turn, and back', () => {
    const b = board(90)
    const bfp = b.footprints[0]
    // KiCad's 90° is counterclockwise on screen: the footprint's +x points up the board (−y).
    expect(footprintPointOnBoard(bfp, { x: mm(1), y: mm(0) })).toEqual({ x: mm(100), y: mm(59) })
    expect(boardPointInFootprint(bfp, { x: mm(100), y: mm(59) })).toEqual({ x: mm(1), y: mm(0) })
    // A move right on the board is a move along the footprint's +y.
    expect(boardDeltaInFootprint(bfp, mm(1), 0)).toEqual({ x: 0, y: mm(1) })
  })
})

describe('editing a footprint’s child on the board', () => {
  it('reaches the saved file once the footprint, the top-level node, is dirtied', () => {
    const b = board(0)
    serializeKicadBoard(b) // fills the per-node cache, as a loaded board has
    const prop = b.footprints[0].footprint.properties[0]
    markNodeDirty(b.footprints[0].footprint._raw)
    updatePropertyInAST(prop, { position: { x: mm(2), y: mm(-1.5), angle: 0 } })
    expect(serializeKicadBoard(b)).toMatch(/\(property "Reference" "R1"\s*\(at 2 -1\.5/)
  })
})
