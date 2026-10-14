import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import type { KicadFpTextBox } from '../../kicad/footprint'
import { mmToNm as mm, nm } from '../../kicad/coordinates'
import {
  DEFAULT_GRAPHIC_WIDTH,
  curvePolyline,
  extraGraphicArea,
  extraGraphicDistance,
  extraGraphicDrawing,
  extraGraphicExtent,
  extraGraphicKind,
  pointDrawing,
  tableCorners,
  tableDrawing,
  tableGrid,
  textBoxCorners,
  textBoxMargins,
  textBoxText
} from '../extraGraphics'

const BOARD = `(kicad_pcb
	(version 20260206)
	(generator "pcbnew")
	(gr_curve
		(pts
			(xy 0 0) (xy 0 -10) (xy 10 -10) (xy 10 0)
		)
		(stroke
			(width 0.2)
			(type default)
		)
		(layer "Dwgs.User")
	)
	(table
		(column_count 2)
		(layer "Dwgs.User")
		(border
			(external yes)
			(header yes)
			(stroke
				(width 0.3)
				(type solid)
			)
		)
		(separators
			(rows yes)
			(cols yes)
			(stroke
				(width 0.1)
				(type solid)
			)
		)
		(column_widths 10 20)
		(row_heights 5 6 7)
		(cells
			(table_cell "H"
				(start 0 0)
				(end 10 5)
				(span 2 1)
				(layer "Dwgs.User")
			)
			(table_cell ""
				(start 10 0)
				(end 30 5)
				(span 0 0)
				(layer "Dwgs.User")
			)
			(table_cell "a"
				(start 0 5)
				(end 10 11)
				(span 1 2)
				(layer "Dwgs.User")
			)
			(table_cell "b"
				(start 10 5)
				(end 30 11)
				(span 1 1)
				(layer "Dwgs.User")
			)
			(table_cell ""
				(start 0 11)
				(end 10 18)
				(span 0 0)
				(layer "Dwgs.User")
			)
			(table_cell "d"
				(start 10 11)
				(end 30 18)
				(span 1 1)
				(layer "Dwgs.User")
			)
		)
	)
	(point
		(at 5 6)
		(size 2)
		(layer "User.1")
	)
)
`

const box = (over: Partial<KicadFpTextBox> = {}): KicadFpTextBox => ({
  text: 'Hi',
  start: { x: mm(0), y: mm(0) },
  end: { x: mm(20), y: mm(10) },
  margins: { left: mm(1), top: mm(2), right: mm(3), bottom: mm(4) },
  angle: 0,
  layer: 'F.SilkS',
  fontEffects: { width: mm(1), height: mm(1), thickness: mm(0.15), hAlign: 'left', vAlign: 'top' },
  border: true,
  strokeWidth: mm(0.1),
  knockout: false,
  locked: false,
  _raw: { type: 'list', children: [], start: 0, end: 0 },
  ...over
})

describe('extra graphics geometry', () => {
  const board = parseKicadBoard(BOARD)

  test('each item names its kind', () => {
    expect(extraGraphicKind(board.grCurves[0])).toBe('curve')
    expect(extraGraphicKind(board.tables[0])).toBe('table')
    expect(extraGraphicKind(board.points[0])).toBe('point')
    expect(extraGraphicKind(box())).toBe('textbox')
  })

  test('a curve runs from its start to its end through its sampled body', () => {
    const line = curvePolyline(board.grCurves[0])
    expect(line[0]).toEqual({ x: 0, y: 0 })
    expect(line[line.length - 1]).toEqual({ x: mm(10), y: 0 })
    // Halfway along, a symmetric curve sits at its middle, 3/4 of the way to the controls.
    const mid = line[(line.length - 1) / 2]
    expect(mid.x).toBeCloseTo(mm(5))
    expect(mid.y).toBeCloseTo(mm(-7.5))
    // A curve has no inside to click.
    expect(extraGraphicArea(board.grCurves[0])).toBeNull()
  })

  test('a text box: its corners, and left/top text inset by those margins', () => {
    const b = box()
    expect(textBoxCorners(b)).toEqual([
      { x: 0, y: 0 },
      { x: mm(20), y: 0 },
      { x: mm(20), y: mm(10) },
      { x: 0, y: mm(10) }
    ])
    const text = textBoxText(b)!
    expect(text.anchor.x).toBeCloseTo(mm(1))
    expect(text.anchor.y).toBeCloseTo(mm(2))
    expect(text.angle).toBe(0)
  })

  test('right/bottom insets from the far edges; centered text ignores the margins', () => {
    const right = textBoxText(
      box({
        fontEffects: {
          width: mm(1),
          height: mm(1),
          thickness: 0 as never,
          hAlign: 'right',
          vAlign: 'bottom'
        }
      })
    )!
    expect(right.anchor.x).toBeCloseTo(mm(17))
    expect(right.anchor.y).toBeCloseTo(mm(6))
    const centered = textBoxText(box({ fontEffects: undefined }))!
    expect(centered.anchor.x).toBeCloseTo(mm(10))
    expect(centered.anchor.y).toBeCloseTo(mm(5))
  })

  test('mirrored text anchors on the opposite side, as it reads right to left', () => {
    const text = textBoxText(
      box({
        fontEffects: {
          width: mm(1),
          height: mm(1),
          thickness: mm(0.1),
          hAlign: 'left',
          vAlign: 'top',
          mirror: true
        }
      })
    )!
    expect(text.anchor.x).toBeCloseTo(mm(17))
  })

  test('text at 90° takes the box’s bottom-left as its top-left', () => {
    // Turned a quarter counterclockwise on screen, the text's "top" is the box's
    // left edge and its "left" the bottom one: y-down, that corner is (0, 10).
    const text = textBoxText(box({ angle: 90 }))!
    expect(text.anchor.x).toBeCloseTo(mm(2))
    expect(text.anchor.y).toBeCloseTo(mm(10 - 1))
    expect(text.angle).toBe(90)
  })

  test('a box without margins takes KiCad’s legacy one', () => {
    const m = textBoxMargins(box({ margins: undefined }))
    expect(m.left).toBe(nm(Math.round(mm(0.1) / 2) + Math.round(mm(1) * 0.75)))
    expect(m.left).toBe(m.bottom)
  })

  test('a box with no border draws only its text; an unset width draws the default', () => {
    expect(extraGraphicDrawing(box({ border: false })).strokes).toHaveLength(0)
    const unset = extraGraphicDrawing(box({ strokeWidth: -1 as never }))
    expect(unset.strokes[0].width).toBe(DEFAULT_GRAPHIC_WIDTH)
  })

  test('a table’s grid starts at its first cell and steps by its sizes', () => {
    const table = board.tables[0]
    expect(tableGrid(table)).toEqual({
      xs: [0, mm(10), mm(30)],
      ys: [0, mm(5), mm(11), mm(18)]
    })
    expect(tableCorners(table)[2]).toEqual({ x: mm(30), y: mm(18) })
  })

  test('a table rules its border, header and the separators spans leave', () => {
    const drawing = tableDrawing(board.tables[0])
    const [border, header, ...separators] = drawing.strokes
    expect(border.closed).toBe(true)
    expect(border.width).toBe(mm(0.3))
    expect(header.points).toEqual([
      { x: 0, y: mm(5) },
      { x: mm(30), y: mm(5) }
    ])
    // The spanning header draws no column line through itself, and cell "a"
    // (two rows) no row line: left are a's right edge, b's right-and-bottom
    // (only its bottom, the right being the table's), and d's nothing.
    const lines = separators.map((s) => s.points.map((p) => [p.x / 1e6, p.y / 1e6]))
    expect(lines).toEqual([
      [
        [10, 5],
        [10, 18]
      ],
      [
        [10, 11],
        [30, 11]
      ]
    ])
    expect(separators.every((s) => s.width === mm(0.1))).toBe(true)
    // Four cells have text; the two covered by spans draw none.
    expect(drawing.texts.map((t) => t.text)).toEqual(['H', 'a', 'b', 'd'])
  })

  test('a point is an X across its size and a ring half as wide', () => {
    const drawing = pointDrawing(board.points[0])
    expect(drawing.strokes[0].points).toEqual([
      { x: mm(4), y: mm(5) },
      { x: mm(6), y: mm(7) }
    ])
    expect(drawing.rings[0]).toMatchObject({ center: { x: mm(5), y: mm(6) }, radius: mm(0.5) })
    expect(extraGraphicExtent(board.points[0])).toHaveLength(4)
  })

  test('a click inside a box or table is on it; beside a curve, measured to its edge', () => {
    const toMm = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: p.x / 1e6,
      y: p.y / 1e6
    })
    expect(extraGraphicDistance(board.tables[0], { x: 15, y: 9 }, toMm, 1e-6)).toBe(0)
    expect(extraGraphicDistance(box(), { x: 5, y: 5 }, toMm, 1e-6)).toBe(0)
    // 1 mm right of the curve's end, less half its 0.2 mm stroke.
    expect(extraGraphicDistance(board.grCurves[0], { x: 11, y: 0 }, toMm, 1e-6)).toBeCloseTo(0.9)
  })
})
