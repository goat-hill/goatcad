import { describe, expect, test } from 'vitest'
import { mmToNm, type Nm } from '../../kicad/coordinates'
import { parseKicadSchematic, serializeKicadSchematic, type Point } from '../../kicad/schematic'
import {
  alignableItems,
  alignDeltas,
  applyItemShifts,
  distributeDeltas,
  planItemShifts,
  type AlignBox
} from '../alignItems'

const mm = (value: number): Nm => mmToNm(value)
const GRID = mm(1.27)
const p = (x: number, y: number): Point => ({ x: mm(x), y: mm(y) })

/** A box from mm corners, anchored at its top-left unless told otherwise. */
const box = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  snaps = true,
  anchor?: Point
): AlignBox => ({
  box: { minX: mm(x0), minY: mm(y0), maxX: mm(x1), maxY: mm(y1) },
  anchor: anchor ?? p(x0, y0),
  snaps
})

describe('align', () => {
  test('left edges meet the leftmost', () => {
    const deltas = alignDeltas(
      [box(10.16, 0, 20, 5), box(2.54, 10, 8, 12), box(5.08, 20, 9, 25)],
      'left',
      GRID
    )
    expect(deltas).toEqual([p(-7.62, 0), p(0, 0), p(-2.54, 0)])
  })

  test('a connecting item lands with its anchor on the grid; a graphic lands exactly', () => {
    // 9.5 mm would put the anchor at 14.58, off grid: it lands on 13.97.
    const items = [box(0, 0, 10.5, 2, true, p(5.08, 1.27)), box(0, 5, 20, 7, true, p(10.16, 6.35))]
    expect(alignDeltas(items, 'right', GRID)).toEqual([p(8.89, 0), p(0, 0)])
    const graphics = [box(0, 0, 10.5, 2, false), box(0, 5, 20, 7, false)]
    expect(alignDeltas(graphics, 'right', GRID)).toEqual([p(9.5, 0), p(0, 0)])
  })

  test('centers meet the smallest center, as KiCad sorts them', () => {
    const items = [box(0, 0, 10, 5.08, false), box(0, 20, 10, 30, false)]
    expect(alignDeltas(items, 'centerY', GRID)).toEqual([p(0, 0), p(0, -22.46)])
    expect(alignDeltas(items, 'bottom', GRID)).toEqual([p(0, 24.92), p(0, 0)])
  })

  test('the item under the cursor is the target, as in KiCad', () => {
    const items = [box(10.16, 0, 20, 5), box(2.54, 10, 8, 12)]
    expect(alignDeltas(items, 'left', GRID, p(15, 2))).toEqual([p(0, 0), p(7.62, 0)])
    // Off every item, the extreme again.
    expect(alignDeltas(items, 'left', GRID, p(90, 90))).toEqual([p(-7.62, 0), p(0, 0)])
  })

  test('one item has nothing to align to', () => {
    expect(alignDeltas([box(1, 1, 2, 2)], 'top', GRID)).toEqual([p(0, 0)])
  })
})

describe('distribute', () => {
  test('the outer two stay and the gaps come out equal', () => {
    const items = [box(0, 0, 10, 1, false), box(40, 0, 50, 1, false), box(12, 0, 14, 1, false)]
    // Span 50, sizes 22: two gaps of 14 → the middle one starts at 24.
    expect(distributeDeltas(items, 'horizontal', GRID)).toEqual([p(0, 0), p(0, 0), p(12, 0)])
  })

  test('vertically too, and snapped where the item connects', () => {
    // Three 2.54 boxes over 22.86: gaps of 7.62, the middle one starting at 10.16.
    const items = [box(0, 0, 1, 2.54), box(0, 3.81, 1, 6.35), box(0, 20.32, 1, 22.86)]
    expect(distributeDeltas(items, 'vertical', GRID)).toEqual([p(0, 0), p(0, 6.35), p(0, 0)])
    // Anchored off the box, the even spot is held to the grid.
    const offset = [
      box(0, 0, 1, 2.54),
      box(0, 3.81, 1, 6.35, true, p(0, 4.5)),
      box(0, 20.32, 1, 22.86)
    ]
    expect(distributeDeltas(offset, 'vertical', GRID)).toEqual([p(0, 0), p(0, 6.93), p(0, 0)])
  })

  test('two items cannot be spread', () => {
    expect(distributeDeltas([box(0, 0, 1, 1), box(5, 0, 6, 1)], 'horizontal', GRID)).toEqual([
      p(0, 0),
      p(0, 0)
    ])
  })
})

const R = (
  uuid: string,
  x: number,
  y: number
): string => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (uuid "${uuid}")
    (property "Reference" "${uuid}" (at ${x + 1.27} ${y} 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "${uuid}-1")) (pin "2" (uuid "${uuid}-2")))`

/** Two resistors side by side, the right one lower, each with a wire up from pin 1. */
const SHEET = `(kicad_sch (version 20231120) (uuid "root") (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
  (wire (pts (xy 50.8 40.64) (xy 50.8 52.07)) (stroke (width 0) (type default)) (uuid "w1"))
  (wire (pts (xy 76.2 40.64) (xy 76.2 57.15)) (stroke (width 0) (type default)) (uuid "w2"))
  ${R('R1', 50.8, 55.88)}
  ${R('R2', 76.2, 60.96)}
  (sheet_instances (path "/" (page "1"))))`

describe('shifting a selection', () => {
  test('align top moves the lower part up, and its wire shortens to follow', () => {
    const doc = parseKicadSchematic(SHEET)
    const items = [
      { type: 'symbol' as const, index: 0 },
      { type: 'symbol' as const, index: 1 }
    ]
    const aligned = alignableItems(doc, items)
    const deltas = alignDeltas(
      aligned.map((entry) => entry.box),
      'top',
      GRID
    )
    expect(deltas).toEqual([p(0, 0), p(0, -5.08)])
    const shifts = aligned.map((entry, index) => ({ item: entry.item, delta: deltas[index] }))
    const plan = planItemShifts(doc, shifts, GRID)
    applyItemShifts(doc, shifts, plan)
    const after = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(after.symbols[1].position).toEqual({ ...p(76.2, 55.88), angle: 0 })
    // Its reference field rode along; the other part and its wire did not move.
    expect(after.symbols[1].properties[0].position).toEqual({ ...p(77.47, 55.88), angle: 0 })
    expect(after.wires[0].points).toEqual([p(50.8, 40.64), p(50.8, 52.07)])
    expect(after.wires[1].points).toEqual(expect.arrayContaining([p(76.2, 40.64), p(76.2, 52.07)]))
  })

  test('parts of an item are not aligned on their own', () => {
    const doc = parseKicadSchematic(SHEET)
    expect(alignableItems(doc, [{ type: 'field', index: 0, field: 'Reference' }])).toEqual([])
  })
})
