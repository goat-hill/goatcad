import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { boardEdgeShapes, footprintShapes } from '../outlineShapes'
import { outlineProblems } from '../outlineValidation'

// Each board's count is what kicad-cli 10.0.6 reports for it
// (invalid_outline, malformed_courtyard).

let uuid = 0
const id = (): string => `00000000-0000-0000-0000-${String(++uuid).padStart(12, '0')}`
type P = [number, number]
const line = (a: P, b: P, layer = 'Edge.Cuts', fp = false): string =>
  `(${fp ? 'fp' : 'gr'}_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.05)) (layer "${layer}") (uuid "${id()}"))\n`
const arc = (s: P, m: P, e: P): string =>
  `(gr_arc (start ${s[0]} ${s[1]}) (mid ${m[0]} ${m[1]}) (end ${e[0]} ${e[1]}) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "${id()}"))\n`
const rect = (a: P, b: P, layer = 'Edge.Cuts', fp = false): string =>
  `(${fp ? 'fp' : 'gr'}_rect (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.05)) (fill no) (layer "${layer}") (uuid "${id()}"))\n`
const circle = (c: P, r: number, fp = false): string =>
  `(${fp ? 'fp' : 'gr'}_circle (center ${c[0]} ${c[1]}) (end ${c[0] + r} ${c[1]}) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "${id()}"))\n`
const box = (x0: number, y0: number, x1: number, y1: number): string =>
  line([x0, y0], [x1, y0]) +
  line([x1, y0], [x1, y1]) +
  line([x1, y1], [x0, y1]) +
  line([x0, y1], [x0, y0])
const footprint = (at: P, body: string, pad: string): string =>
  `(footprint "L:F" (layer "F.Cu") (uuid "${id()}") (at ${at[0]} ${at[1]})
    (property "Reference" "U1" (at 0 -3) (layer "F.SilkS") (uuid "${id()}") (effects (font (size 1 1) (thickness 0.15))))
    ${body}${pad})\n`
const smd = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "${id()}"))`
const hole = `(pad "1" thru_hole circle (at 0 0) (size 5.6 5.6) (drill 3.2) (layers "*.Cu") (uuid "${id()}"))`
const crt = (a: P, b: P, layer = 'F.CrtYd'): string => line(a, b, layer, true)

const board = rect([0, 0], [60, 40])
const rounded =
  line([5, 0], [55, 0]) +
  arc([55, 0], [58.5355, 1.4645], [60, 5]) +
  line([60, 5], [60, 35]) +
  arc([60, 35], [58.5355, 38.5355], [55, 40]) +
  line([55, 40], [5, 40]) +
  arc([5, 40], [1.4645, 38.5355], [0, 35]) +
  line([0, 35], [0, 5]) +
  arc([0, 5], [1.4645, 1.4645], [5, 0])
const slot = (x0: number, x1: number): string =>
  line([x0, 10], [x1, 10]) +
  arc([x1, 10], [x1 + 1, 11], [x1, 12]) +
  line([x1, 12], [x0, 12]) +
  arc([x0, 12], [x0 - 1, 11], [x0, 10])

const counts = (body: string): { outline: number; courtyard: number } => {
  const b = parseKicadBoard(`(kicad_pcb (version 20250401) (generator "test")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (30 "B.CrtYd" user))
  (net 0 "")
  ${body})`)
  const { all, outline } = boardEdgeShapes(b)
  let courtyard = 0
  for (const bfp of b.footprints)
    for (const layer of ['F.CrtYd', 'B.CrtYd'])
      courtyard += outlineProblems(footprintShapes(bfp, layer), { epsilon: 0.02 }).length
  return { outline: outlineProblems(outline, { epsilon: 0.01, board: { all } }).length, courtyard }
}

describe('the board outline, as kicad-cli reports it', () => {
  test.each([
    ['two rectangles overlapping', rect([0, 0], [50, 40]) + rect([30, 20], [80, 60]), 1],
    ['a rectangle drawn twice', rect([0, 0], [50, 40]) + rect([0, 0], [50, 40]), 5],
    ['a segment under a micron', rect([0, 0], [50, 40]) + line([60, 60], [60.0005, 60]), 2],
    [
      'a box with two gaps',
      line([0, 0], [50, 0]) +
        line([50, 0], [50, 18]) +
        line([50, 22], [50, 40]) +
        line([50, 40], [0, 40]) +
        line([0, 40], [0, 22]) +
        line([0, 18], [0, 0]),
      2
    ],
    [
      'a box with one gap',
      line([0, 0], [50, 0]) +
        line([50, 0], [50, 40]) +
        line([50, 40], [0, 40]) +
        line([0, 40], [0, 2]),
      1
    ],
    [
      'three cutouts in a row, two pairs meeting',
      rect([0, 0], [50, 40]) + circle([10, 10], 2) + circle([13, 10], 2) + circle([16, 10], 2),
      2
    ],
    ['a line from the edge into the board', box(0, 0, 50, 40) + line([25, 0], [25, 20]), 1],
    ['a line across the board', box(0, 0, 50, 40) + line([-10, 20], [60, 20]), 1],
    ['a rectangle across a box of lines', box(0, 0, 50, 40) + rect([40, 10], [70, 30]), 1],
    ['a side drawn twice', box(0, 0, 50, 40) + line([0, 0], [50, 0]), 4],
    ['a circle under a micron', rect([0, 0], [50, 40]) + circle([10, 10], 0.0004), 1],
    ['rounded corners', rounded, 0],
    ['a slot inside', rounded + slot(20, 30), 0],
    ['a slot across the edge', board + slot(50, 70), 1],
    ['two boards', rect([0, 0], [20, 20]) + rect([40, 0], [60, 20]), 0],
    ['a mounting hole footprint', board + footprint([10, 10], circle([0, 0], 1.6, true), hole), 0],
    [
      'a hole footprint off the board',
      board + footprint([70, 10], circle([0, 0], 1.6, true), hole),
      0
    ],
    ['a cutout touching the edge', board + circle([10, 5], 5), 1]
  ])('%s', (_, body, expected) => {
    expect(counts(body).outline).toBe(expected)
  })
})

describe('a courtyard, as kicad-cli reports it', () => {
  const square = rect([-5, -5], [5, 5], 'F.CrtYd', true)
  test.each([
    [
      'a cross mark inside',
      square +
        crt([0, 0.5], [0, 0]) +
        crt([-0.5, 0], [0, 0]) +
        crt([0, 0], [0.5, 0]) +
        crt([0, 0], [0, -0.5]),
      6
    ],
    ['three sides', crt([-5, -5], [5, -5]) + crt([5, -5], [5, 5]) + crt([5, 5], [-5, 5]), 2],
    ['two rectangles overlapping', square + rect([3, -2], [8, 2], 'F.CrtYd', true), 0],
    ['a side drawn twice', square + crt([-5, -5], [5, -5]), 2],
    ['an open line on each side', crt([-5, -5], [5, -5]) + crt([-5, -5], [5, -5], 'B.CrtYd'), 2],
    [
      'a box of lines round a rectangle',
      crt([-5, -5], [5, -5]) +
        crt([5, -5], [5, 5]) +
        crt([5, 5], [-5, 5]) +
        crt([-5, 5], [-5, -5]) +
        rect([-2, -2], [2, 2], 'F.CrtYd', true),
      0
    ]
  ])('%s', (_, body, expected) => {
    expect(counts(board + footprint([20, 20], body, smd)).courtyard).toBe(expected)
  })
})
