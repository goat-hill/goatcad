/**
 * A board's own copy of a placed footprint (`footprintCopy.ts`): brought to
 * the library frame for the footprint editor and placed back as the board had
 * it, front or back, at any angle.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard, type KicadBoard } from '../../kicad/board'
import { parseKicadFootprint } from '../../kicad/footprint'
import { findChild, findChildren, getAtomValues, serializeSExpr } from '../../kicad/sexpr'
import { flipBoardFootprintInAST } from '../footprintFlip'
import { projectFootprintCopy, writeFootprintCopy } from '../footprintCopy'

const placed = (angle: number): string => `
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp-1") (at 120 80${angle ? ` ${angle}` : ''})
    (property "Reference" "R7" (at 0 -1.5 ${angle}) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (attr smd)
    (fp_line (start -1 -0.5) (end 1 -0.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (pad "1" smd rect (at -1 0 ${angle}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VCC"))
    (pad "2" smd rect (at 1 0 ${angle + 90}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "GND")))`

const boardOf = (body: string): KicadBoard =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)
    (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user)
    (35 "F.Fab" user) (37 "B.Fab" user) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "VCC") (net 2 "GND")
  ${body}
)`)

const reparse = (board: KicadBoard): KicadBoard => parseKicadBoard(serializeSExpr(board._raw))

const padsOf = (
  board: KicadBoard
): Array<{ number: string; x: number; y: number; angle: number }> =>
  board.footprints[0].footprint.pads.map((pad) => ({
    number: pad.number,
    x: Math.round(pad.position.x),
    y: Math.round(pad.position.y),
    angle: Math.round((pad.position.angle ?? 0) * 1000) / 1000
  }))

describe('a board’s footprint copy', () => {
  test.each([
    ['front', 0, false],
    ['front, turned', 30, false],
    ['back, turned', 30, true]
  ])(
    '%s: opens at the origin on the front, and an unedited write changes nothing',
    (_, angle, back) => {
      let board = boardOf(placed(angle))
      if (back) {
        flipBoardFootprintInAST(board, board.footprints[0], {
          x: board.footprints[0].position.x,
          y: board.footprints[0].position.y
        })
        board = reparse(board)
      }
      const before = board.footprints[0]
      const text = projectFootprintCopy(board, 'fp-1')!
      const copy = parseKicadFootprint(text)
      expect(copy.layer ?? 'F.Cu').toBe('F.Cu')
      expect(getAtomValues(findChild(parseSExprList(text), 'at')!)).toEqual(['0', '0'])

      const beforePads = padsOf(board)
      expect(writeFootprintCopy(board, 'fp-1', text)).toBe(true)
      const after = reparse(board)
      expect(after.footprints[0].layer).toBe(before.layer)
      expect(after.footprints[0].position).toEqual(before.position)
      expect(padsOf(after)).toEqual(beforePads)
      const nets = findChildren(after.footprints[0]._raw, 'pad').map((pad) =>
        getAtomValues(findChild(pad, 'net')!)
      )
      expect(nets).toEqual([
        ['1', 'VCC'],
        ['2', 'GND']
      ])
    }
  )

  test('an edit in the library frame lands on the placed footprint', () => {
    const board = boardOf(placed(90))
    const text = projectFootprintCopy(board, 'fp-1')!.replace('(size 0.6 0.8)', '(size 0.9 0.8)')
    expect(writeFootprintCopy(board, 'fp-1', text)).toBe(true)
    const pad = reparse(board).footprints[0].footprint.pads[0]
    expect(pad.size.w).toBeCloseTo(900_000)
    expect(projectFootprintCopy(board, 'nope')).toBeNull()
    expect(writeFootprintCopy(board, 'fp-1', '(not a footprint)')).toBe(false)
  })
})

function parseSExprList(text: string): Parameters<typeof findChild>[0] {
  return parseKicadFootprint(text)._raw as Parameters<typeof findChild>[0]
}
