import { describe, expect, test } from 'vitest'
import {
  addGrCurveToBoardAST,
  addGrTextBoxToBoardAST,
  addPointToBoardAST,
  parseKicadBoard,
  remapKicadBoard,
  serializeKicadBoard,
  setBoardItemLockedInAST
} from '../board'
import {
  addFpCurveToFootprintAST,
  addFpTextBoxToFootprintAST,
  addPointToFootprintAST,
  legacyTextBoxMargin,
  parseKicadFootprint,
  serializeKicadFootprint,
  translateGraphicInAST,
  updateTextBoxInAST
} from '../footprint'
import { mmToNm as mm } from '../coordinates'

/**
 * A board carrying one of each: a Bézier, a text box, a table and a point on
 * the board, and the same four inside a footprint — written as KiCad 10 writes
 * them (`PCB_IO_KICAD_SEXPR::format`), so an untouched round trip is exact.
 */
const BOARD = `(kicad_pcb
	(version 20260206)
	(generator "pcbnew")
	(generator_version "10.0")
	(footprint "Lib:Part"
		(layer "F.Cu")
		(uuid "f0000000-0000-0000-0000-000000000001")
		(at 10 20 90)
		(fp_curve
			(pts
				(xy 0 0) (xy 1 -1) (xy 2 1) (xy 3 0)
			)
			(stroke
				(width 0.12)
				(type solid)
			)
			(layer "F.SilkS")
			(uuid "f0000000-0000-0000-0000-000000000002")
		)
		(fp_text_box "Note"
			(start -1 -1)
			(end 4 1)
			(margins 0.5 0.5 0.5 0.5)
			(layer "F.Fab")
			(uuid "f0000000-0000-0000-0000-000000000003")
			(effects
				(font
					(size 1 1)
					(thickness 0.15)
				)
				(justify left top)
			)
			(border yes)
			(stroke
				(width 0.1)
				(type solid)
			)
			(knockout no)
		)
		(point
			(at 1 2)
			(size 0.5)
			(layer "F.Fab")
			(uuid "f0000000-0000-0000-0000-000000000004")
		)
	)
	(gr_curve
		(pts
			(xy 10 10) (xy 12 8) (xy 14 12) (xy 16 10)
		)
		(stroke
			(width 0.2)
			(type default)
		)
		(layer "Dwgs.User")
		(uuid "b0000000-0000-0000-0000-000000000001")
	)
	(gr_text_box locked "Board note"
		(start 20 20)
		(end 30 25)
		(layer "F.SilkS")
		(uuid "b0000000-0000-0000-0000-000000000002")
		(effects
			(font
				(size 1.5 1.5)
				(thickness 0.3)
			)
		)
		(stroke
			(width 0.2)
			(type solid)
		)
	)
	(table
		(column_count 2)
		(uuid "b0000000-0000-0000-0000-000000000003")
		(layer "Dwgs.User")
		(border
			(external yes)
			(header no)
			(stroke
				(width 0.3)
				(type solid)
			)
		)
		(separators
			(rows yes)
			(cols no)
			(stroke
				(width 0.1)
				(type solid)
			)
		)
		(column_widths 10 20)
		(row_heights 5 6)
		(cells
			(table_cell "A"
				(start 40 40)
				(end 50 45)
				(margins 1 1 1 1)
				(span 2 1)
				(layer "Dwgs.User")
				(uuid "b0000000-0000-0000-0000-000000000004")
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(table_cell ""
				(start 50 40)
				(end 70 45)
				(margins 1 1 1 1)
				(span 0 0)
				(layer "Dwgs.User")
				(uuid "b0000000-0000-0000-0000-000000000005")
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(table_cell "C"
				(start 40 45)
				(end 50 51)
				(margins 1 1 1 1)
				(span 1 1)
				(layer "Dwgs.User")
				(uuid "b0000000-0000-0000-0000-000000000006")
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(table_cell "D"
				(start 50 45)
				(end 70 51)
				(margins 1 1 1 1)
				(span 1 1)
				(layer "Dwgs.User")
				(uuid "b0000000-0000-0000-0000-000000000007")
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
		)
	)
	(point
		(at 5 6)
		(size 1)
		(layer "User.1")
		(uuid "b0000000-0000-0000-0000-000000000008")
	)
)
`

describe('board Béziers, text boxes, tables and points', () => {
  test('an untouched board round-trips byte for byte', () => {
    expect(serializeKicadBoard(parseKicadBoard(BOARD))).toBe(BOARD)
  })

  test('each parses into its collection, none left unknown', () => {
    const board = parseKicadBoard(BOARD)
    expect(board._unknownNodes).toHaveLength(0)
    expect(board.grCurves).toHaveLength(1)
    expect(board.grCurves[0].points.map((p) => [p.x, p.y])).toEqual([
      [mm(10), mm(10)],
      [mm(12), mm(8)],
      [mm(14), mm(12)],
      [mm(16), mm(10)]
    ])
    expect(board.grCurves[0].strokeWidth).toBe(mm(0.2))
    expect(board.grCurves[0].layer).toBe('Dwgs.User')

    const box = board.grTextBoxes[0]
    expect(box.text).toBe('Board note')
    expect(box.locked).toBe(true)
    expect(box.start).toEqual({ x: mm(20), y: mm(20) })
    expect(box.end).toEqual({ x: mm(30), y: mm(25) })
    // No (margins …) or (border …): an older file, read as KiCad reads it.
    expect(box.margins).toBeUndefined()
    expect(box.border).toBe(true)
    expect(box.angle).toBe(0)

    const table = board.tables[0]
    expect(table.columnCount).toBe(2)
    expect(table.borderExternal).toBe(true)
    expect(table.borderHeader).toBe(false)
    expect(table.borderStrokeWidth).toBe(mm(0.3))
    expect(table.separatorRows).toBe(true)
    expect(table.separatorCols).toBe(false)
    expect(table.columnWidths).toEqual([mm(10), mm(20)])
    expect(table.rowHeights).toEqual([mm(5), mm(6)])
    expect(table.cells.map((c) => [c.text, c.colSpan, c.rowSpan])).toEqual([
      ['A', 2, 1],
      ['', 0, 0],
      ['C', 1, 1],
      ['D', 1, 1]
    ])

    expect(board.points[0].position).toEqual({ x: mm(5), y: mm(6) })
    expect(board.points[0].size).toBe(mm(1))
    expect(board.points[0].layer).toBe('User.1')
  })

  test('a footprint carries its own four', () => {
    const fp = parseKicadBoard(BOARD).footprints[0].footprint
    expect(fp._unknownNodes).toHaveLength(0)
    expect(fp.fpCurves).toHaveLength(1)
    expect(fp.fpTextBoxes[0].text).toBe('Note')
    expect(fp.fpTextBoxes[0].margins).toEqual({
      left: mm(0.5),
      top: mm(0.5),
      right: mm(0.5),
      bottom: mm(0.5)
    })
    expect(fp.fpTextBoxes[0].fontEffects?.hAlign).toBe('left')
    expect(fp.points[0].position).toEqual({ x: mm(1), y: mm(2) })
    expect(fp.tables).toHaveLength(0)
  })

  test('the writers append what KiCad writes, and the remap sees it', () => {
    const board = parseKicadBoard(BOARD)
    const curve = addGrCurveToBoardAST(board, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(1), y: mm(1) },
        { x: mm(2), y: mm(1) },
        { x: mm(3), y: mm(0) }
      ],
      width: mm(0.1),
      layer: 'F.SilkS'
    })
    const box = addGrTextBoxToBoardAST(board, {
      text: 'Text',
      start: { x: mm(0), y: mm(0) },
      end: { x: mm(10), y: mm(5) },
      layer: 'B.SilkS',
      size: mm(1),
      thickness: mm(0.1),
      width: mm(0.1),
      mirror: true
    })
    const point = addPointToBoardAST(board, {
      position: { x: mm(7), y: mm(8) },
      size: mm(1),
      layer: 'F.Fab'
    })
    const next = remapKicadBoard(board)
    expect(next.grCurves[curve].points).toHaveLength(4)
    expect(next.grTextBoxes[box].text).toBe('Text')
    expect(next.grTextBoxes[box].border).toBe(true)
    expect(next.grTextBoxes[box].fontEffects?.mirror).toBe(true)
    expect(next.grTextBoxes[box].margins?.left).toBe(legacyTextBoxMargin(mm(0.1), mm(1)))
    expect(next.points[point].position).toEqual({ x: mm(7), y: mm(8) })

    // What was written reads back identically after a save and a fresh parse.
    const again = parseKicadBoard(serializeKicadBoard(next))
    expect(again.grCurves[curve].points).toEqual(next.grCurves[curve].points)
    expect(again.grTextBoxes[box].margins).toEqual(next.grTextBoxes[box].margins)
  })

  test('KiCad’s legacy margin: half the border plus three quarters of the text height', () => {
    expect(legacyTextBoxMargin(mm(0.1), mm(1))).toBe(mm(0.8))
    // An unset (-1) border adds nothing.
    expect(legacyTextBoxMargin(-1, mm(1.27))).toBe(mm(0.9525))
  })

  test('a move shifts every position and nothing else', () => {
    const board = parseKicadBoard(BOARD)
    const dx = mm(1)
    const dy = mm(-2)
    translateGraphicInAST(board.grCurves[0], dx, dy)
    translateGraphicInAST(board.grTextBoxes[0], dx, dy)
    translateGraphicInAST(board.tables[0], dx, dy)
    translateGraphicInAST(board.points[0], dx, dy)
    expect(board.grCurves[0].points[0]).toEqual({ x: mm(11), y: mm(8) })
    expect(board.grCurves[0].strokeWidth).toBe(mm(0.2))
    expect(board.grTextBoxes[0].start).toEqual({ x: mm(21), y: mm(18) })
    expect(board.grTextBoxes[0].end).toEqual({ x: mm(31), y: mm(23) })
    expect(board.tables[0].cells[3].start).toEqual({ x: mm(51), y: mm(43) })
    expect(board.tables[0].columnWidths).toEqual([mm(10), mm(20)])
    expect(board.points[0].position).toEqual({ x: mm(6), y: mm(4) })
    expect(board.points[0].size).toBe(mm(1))

    const text = serializeKicadBoard(remapKicadBoard(board))
    expect(text).toContain('(xy 11 8) (xy 13 6) (xy 15 10) (xy 17 8)')
    expect(text).toContain('(at 6 4)')
  })

  test('a text box’s string and layer edit in place, past an older bare locked', () => {
    const board = parseKicadBoard(BOARD)
    const box = board.grTextBoxes[0]
    updateTextBoxInAST(box, { text: 'Changed', layer: 'B.SilkS' })
    expect(box.text).toBe('Changed')
    const text = serializeKicadBoard(board)
    expect(text).toContain('(gr_text_box locked "Changed"')
    const again = parseKicadBoard(text).grTextBoxes[0]
    expect(again.text).toBe('Changed')
    expect(again.layer).toBe('B.SilkS')
    expect(again.locked).toBe(true)
  })

  test('locking a text box writes (locked yes) after its string, as KiCad does', () => {
    const board = parseKicadBoard(BOARD)
    const box = board.grTextBoxes[0]
    setBoardItemLockedInAST(box, false)
    setBoardItemLockedInAST(box, true)
    expect(serializeKicadBoard(board)).toContain('(gr_text_box "Board note"\n\t\t(locked yes)')
  })
})

describe('footprint Béziers, text boxes and points', () => {
  const FOOTPRINT = `(footprint "Part"
	(version 20260206)
	(generator "pcbnew")
	(layer "F.Cu")
	(attr smd)
)
`

  test('the footprint writers append nodes the parser reads back', () => {
    const fp = parseKicadFootprint(FOOTPRINT)
    addFpCurveToFootprintAST(fp, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(1), y: mm(1) },
        { x: mm(2), y: mm(1) },
        { x: mm(3), y: mm(0) }
      ],
      width: mm(0.12),
      layer: 'F.SilkS'
    })
    addFpTextBoxToFootprintAST(fp, {
      text: 'Text',
      start: { x: mm(0), y: mm(0) },
      end: { x: mm(4), y: mm(2) },
      layer: 'F.Fab',
      size: mm(1),
      thickness: mm(0.15),
      width: mm(0.1)
    })
    addPointToFootprintAST(fp, { position: { x: mm(1), y: mm(1) }, size: mm(1), layer: 'F.Fab' })
    const text = serializeKicadFootprint(fp)
    const again = parseKicadFootprint(text)
    expect(again.fpCurves[0].points[3]).toEqual({ x: mm(3), y: mm(0) })
    expect(again.fpCurves[0].layer).toBe('F.SilkS')
    expect(again.fpTextBoxes[0].text).toBe('Text')
    expect(again.fpTextBoxes[0].fontEffects?.vAlign).toBe('top')
    expect(again.points[0].size).toBe(mm(1))
    expect(text).toContain('(fp_curve')
    expect(text).toContain('(fp_text_box "Text"')
    expect(text).toContain('(point\n\t\t(at 1 1)')
  })
})
