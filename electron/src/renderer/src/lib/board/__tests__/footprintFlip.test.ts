import { describe, expect, test } from 'vitest'
import {
  parseKicadBoard,
  remapKicadBoard,
  serializeKicadBoard,
  type KicadBoard
} from '../../kicad/board'
import { mmToNm as mm } from '../../kicad/coordinates'
import { findChild, getToken, serializeSExpr, type SExprList } from '../../kicad/sexpr'
import { flipBoardFootprintInAST, footprintFlipCenter, footprintFlippable } from '../footprintFlip'

// A four-layer board holding one footprint turned 30°: text kept upright and
// not, a chamfered, a trapezoid, an offset-drill and a custom pad, an arc, and
// the board-absolute items — a keepout and two dimensions. The expectations were checked against KiCad
// 10.0.6's own `FOOTPRINT::Flip` through its Python module: every value
// matches but the arc's mid, a nanometer off at 30° (the module header).
const source = `(kicad_pcb
	(version 20260206)
	(generator "pcbnew")
	(generator_version "10.0")
	(general
		(thickness 1.6)
	)
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(4 "In1.Cu" signal)
		(6 "In2.Cu" signal)
		(2 "B.Cu" signal)
		(13 "F.Paste" user)
		(15 "B.Paste" user)
		(5 "F.SilkS" user "F.Silkscreen")
		(7 "B.SilkS" user "B.Silkscreen")
		(1 "F.Mask" user)
		(3 "B.Mask" user)
		(17 "Dwgs.User" user "User.Drawings")
		(25 "Edge.Cuts" user)
		(35 "F.Fab" user)
		(33 "B.Fab" user)
	)
	(net 0 "")
	(net 1 "GND")
	(footprint "Test:Flip"
		(layer "F.Cu")
		(uuid "11111111-0000-0000-0000-000000000001")
		(at 50 40 30)
		(property "Reference" "U1"
			(at 1.5 -2.5 30)
			(layer "F.SilkS")
			(uuid "11111111-0000-0000-0000-000000000002")
			(effects
				(font
					(size 1 1)
					(thickness 0.15)
				)
				(justify left)
			)
		)
		(property "Value" "FLIP"
			(at 0 3 210)
			(unlocked yes)
			(layer "F.Fab")
			(uuid "11111111-0000-0000-0000-000000000003")
			(effects
				(font
					(size 1 1)
					(thickness 0.15)
				)
				(justify right top)
			)
		)
		(fp_text user "UP"
			(at -2 1 60)
			(layer "Dwgs.User")
			(uuid "11111111-0000-0000-0000-000000000004")
			(effects
				(font
					(size 1 1)
					(thickness 0.15)
				)
				(justify left bottom)
			)
		)
		(fp_line
			(start -3 -2)
			(end 3 -2.5)
			(stroke
				(width 0.12)
				(type solid)
			)
			(layer "F.SilkS")
			(uuid "11111111-0000-0000-0000-000000000005")
		)
		(fp_arc
			(start -1 -0.999999)
			(mid 0.3 -1.7)
			(end 1.199999 -0.4)
			(stroke
				(width 0.12)
				(type solid)
			)
			(layer "F.SilkS")
			(uuid "11111111-0000-0000-0000-000000000006")
		)
		(pad "1" smd roundrect
			(at -2 -1 30)
			(size 1 0.6)
			(layers "F.Cu" "F.Mask" "F.Paste")
			(roundrect_rratio 0.25)
			(net "GND")
			(uuid "11111111-0000-0000-0000-000000000009")
		)
		(pad "2" smd trapezoid
			(at 2 -1 75)
			(size 1 0.8)
			(rect_delta 0.2 0.1)
			(layers "F.Cu" "F.Mask")
			(uuid "11111111-0000-0000-0000-00000000000a")
		)
		(pad "3" smd roundrect
			(at 2 1 30)
			(size 1 1)
			(layers "F.Cu" "F.Mask")
			(roundrect_rratio 0.1)
			(chamfer_ratio 0.2)
			(chamfer top_left bottom_right)
			(uuid "11111111-0000-0000-0000-00000000000b")
		)
		(pad "4" thru_hole circle
			(at -2 1.5 30)
			(size 1.6 1.6)
			(drill 0.8
				(offset 0.1 0.2)
			)
			(layers "*.Cu" "*.Mask")
			(remove_unused_layers yes)
			(keep_end_layers yes)
			(zone_layer_connections "In1.Cu")
			(uuid "11111111-0000-0000-0000-00000000000c")
		)
		(pad "5" smd custom
			(at 0 2 30)
			(size 0.5 0.5)
			(layers "F.Cu" "F.Mask")
			(options
				(clearance outline)
				(anchor circle)
			)
			(primitives
				(gr_poly
					(pts
						(xy 0 0) (xy 0.6 0.2) (xy 0.1 0.7)
					)
					(width 0)
					(fill yes)
				)
				(gr_arc
					(start 0.5 0)
					(mid 0.1 0.45)
					(end -0.3 0.1)
					(width 0.1)
				)
			)
			(uuid "11111111-0000-0000-0000-00000000000d")
		)
		(pad "6" thru_hole roundrect
			(at 0 -2.5 30)
			(size 1.2 0.8)
			(drill 0.6
				(offset 0 0)
			)
			(layers "*.Cu" "*.Mask")
			(remove_unused_layers no)
			(roundrect_rratio 0.25)
			(uuid "11111111-0000-0000-0000-000000000013")
			(padstack
				(mode front_inner_back)
				(layer "Inner"
					(shape circle)
					(size 1 1)
				)
				(layer "B.Cu"
					(shape rect)
					(size 1.6 0.9)
					(offset 0 0.2)
					(zone_connect -1)
				)
			)
		)
		(zone
			(net 0)
			(net_name "")
			(layers "F.Cu" "In1.Cu")
			(uuid "11111111-0000-0000-0000-00000000000e")
			(hatch full 0.5)
			(min_thickness 0.25)
			(keepout
				(tracks not_allowed)
				(vias not_allowed)
				(pads allowed)
				(copperpour not_allowed)
				(footprints allowed)
			)
			(polygon
				(pts
					(xy 52 37) (xy 55 37.5) (xy 54 41)
				)
			)
		)
		(dimension
			(type orthogonal)
			(layer "Dwgs.User")
			(uuid "11111111-0000-0000-0000-00000000000f")
			(pts
				(xy 50 44) (xy 49.75 34)
			)
			(height 6.5)
			(orientation 1)
			(format
				(prefix "")
				(suffix "")
				(units 3)
				(units_format 0)
				(precision 4)
				(suppress_zeroes yes)
			)
			(style
				(thickness 0.1)
				(arrow_length 1.27)
				(text_position_mode 0)
				(arrow_direction outward)
				(extension_height 0.58642)
				(extension_offset 0.5)
				(keep_text_aligned yes)
			)
			(gr_text "10"
				(at 55.35 39 90)
				(layer "Dwgs.User")
				(uuid "11111111-0000-0000-0000-000000000010")
				(effects
					(font
						(size 1 1)
						(thickness 0.15)
					)
				)
			)
		)
		(dimension
			(type aligned)
			(layer "F.Fab")
			(uuid "11111111-0000-0000-0000-000000000011")
			(pts
				(xy 47 38) (xy 53 41)
			)
			(height -2)
			(format
				(prefix "")
				(suffix "")
				(units 3)
				(units_format 0)
				(precision 4)
				(suppress_zeroes yes)
			)
			(style
				(thickness 0.1)
				(arrow_length 1.27)
				(text_position_mode 0)
				(arrow_direction outward)
				(extension_height 0.58642)
				(extension_offset 0.5)
				(keep_text_aligned yes)
			)
			(gr_text "6.7082"
				(at 51.408723 36.682555 333.4349488)
				(layer "F.Fab")
				(uuid "11111111-0000-0000-0000-000000000012")
				(effects
					(font
						(size 1 1)
						(thickness 0.15)
					)
				)
			)
		)
	)
)
`

/** One child of the (only) footprint, compacted, found by its token and `match`. */
const child = (board: KicadBoard, token: string, match = ''): string => {
  const fp = board._raw as SExprList
  const node = fp.children.find((c) => c.type === 'list' && getToken(c) === 'footprint')
  const items = (node as SExprList).children.filter(
    (c): c is SExprList => c.type === 'list' && getToken(c) === token
  )
  const text = items.map((c) => serializeSExpr(c, 0, true)).find((t) => t.includes(match))
  if (text === undefined) throw new Error(`no ${token} ${match}`)
  return text.replace(/\s+/g, ' ').replace(/ \)/g, ')')
}

const flipped = (
  direction?: 'leftRight' | 'topBottom',
  center?: { x: number; y: number }
): KicadBoard => {
  const board = parseKicadBoard(source)
  const bfp = board.footprints[0]!
  flipBoardFootprintInAST(
    board,
    bfp,
    center ? { x: mm(center.x), y: mm(center.y) } : bfp.position,
    direction
  )
  return remapKicadBoard(board)
}

describe('flipBoardFootprintInAST — left-right, KiCad’s default', () => {
  const board = flipped()
  const fp = board.footprints[0]!

  test('the footprint changes side and its angle becomes 180° less itself', () => {
    expect(fp.layer).toBe('B.Cu')
    expect(fp.position).toEqual({ x: mm(50), y: mm(40), angle: 150 })
  })

  test('text mirrors onto the back; kept-upright text past 180° turns and swaps its justification', () => {
    expect(child(board, 'property', 'Reference')).toContain('(at 1.5 2.5 150)')
    expect(child(board, 'property', 'Reference')).toContain('(layer "B.SilkS")')
    expect(child(board, 'property', 'Reference')).toContain('(justify right mirror)')
    // Unlocked: no upright fold, justification kept.
    expect(child(board, 'property', 'Value')).toContain('(at 0 -3 150)')
    expect(child(board, 'property', 'Value')).toContain('(justify right top mirror)')
    // A layer with no side: no mirror; 300° folds to 120°, left-bottom to right-top.
    expect(child(board, 'fp_text', 'UP')).toContain('(at -2 -1 120)')
    expect(child(board, 'fp_text', 'UP')).toContain('(layer "Dwgs.User")')
    expect(child(board, 'fp_text', 'UP')).toContain('(justify right top)')
  })

  test('pads mirror in their own frame', () => {
    const pad = (n: string): string => child(board, 'pad', `(pad "${n}"`)
    expect(pad('1')).toContain('(at -2 1 150)')
    expect(pad('1')).toContain('(layers "B.Cu" "B.Mask" "B.Paste")')
    expect(pad('2')).toContain('(at 2 1 105)')
    expect(pad('2')).toContain('(rect_delta 0.2 -0.1)')
    expect(pad('3')).toContain('(chamfer top_right bottom_left)')
    expect(pad('4')).toContain('(offset 0.1 -0.2)')
    expect(pad('4')).toContain('(layers "*.Cu" "*.Mask")')
    // KiCad's flip leaves the zone-layer overrides where they were.
    expect(pad('4')).toContain('(zone_layer_connections "In1.Cu")')
    expect(pad('5')).toContain('(xy 0 0) (xy 0.6 -0.2) (xy 0.1 -0.7)')
    expect(pad('5')).toContain('(start -0.3 -0.1) (mid 0.14961 -0.446887) (end 0.5 0)')
  })

  test('a padstack’s front and back copper trade places', () => {
    const pad = child(board, 'pad', '(pad "6"')
    // The back's rectangle is the pad's own now, its copper offset moved to the drill.
    expect(pad).toContain('(pad "6" thru_hole rect (at 0 2.5 150) (size 1.6 0.9)')
    expect(pad).toContain('(drill 0.6 (offset 0 -0.2))')
    expect(pad).not.toContain('(roundrect_rratio 0.25) (uuid')
    // The front's rounded rectangle is the back's, with the zone connection KiCad writes for it.
    expect(pad).toContain(
      '(layer "B.Cu" (shape roundrect) (size 1.2 0.8) (roundrect_rratio 0.25) (zone_connect -1))'
    )
    expect(pad).toContain('(layer "Inner" (shape circle) (size 1 1))')
  })

  test('graphics mirror, and an arc swaps its ends and takes the mid KiCad computes', () => {
    expect(child(board, 'fp_line')).toContain('(start -3 2) (end 3 2.5)')
    expect(child(board, 'fp_line')).toContain('(layer "B.SilkS")')
    // KiCad writes (mid 0.368257 1.683612): its turn by 30° in and out rounds a
    // nanometer (the module header).
    expect(child(board, 'fp_arc')).toContain(
      '(start 1.199999 0.4) (mid 0.368257 1.683611) (end -1 0.999999)'
    )
  })

  test('a footprint zone is board-absolute: it mirrors about the flip center, inner copper end for end', () => {
    expect(child(board, 'zone')).toContain('(layers "B.Cu" "In2.Cu")')
    expect(child(board, 'zone')).toContain('(xy 48 37) (xy 45 37.5) (xy 46 41)')
  })

  test('a dimension mirrors its points about the flip center and places its text again', () => {
    const aligned = child(board, 'dimension', '(type aligned)')
    expect(aligned).toContain('(layer "B.Fab")')
    expect(aligned).toContain('(xy 53 38) (xy 47 41)')
    expect(aligned).toContain('(height 2)')
    expect(aligned).toContain('(at 48.591277 36.682555 26.56505118)')
    expect(aligned).toContain('(justify mirror)')
    // A vertical orthogonal one keeps its height's sign through the mirror, and
    // the half turn negates it; the text sits beside the crossbar again.
    const orthogonal = child(board, 'dimension', '(type orthogonal)')
    expect(orthogonal).toContain('(xy 50 44) (xy 50.25 34)')
    expect(orthogonal).toContain('(height -6.5)')
    expect(orthogonal).toContain('(at 42.35 39 90)')
    expect(orthogonal).not.toContain('mirror')
  })

  test('the parsed footprint follows the new node', () => {
    expect(fp.footprint.pads[0]!.layers).toEqual(['B.Cu', 'B.Mask', 'B.Paste'])
    expect(fp.footprint.pads[0]!.net?.name).toBe('GND')
    expect(fp.footprint.zones[0]!.points[0]).toEqual({ x: mm(48), y: mm(37) })
  })

  test('flipping twice gives the file back, an arc’s mid recomputed onto its circle', () => {
    const board = parseKicadBoard(source)
    const pristine = serializeKicadBoard(board)
    const at = board.footprints[0]!.position
    flipBoardFootprintInAST(board, board.footprints[0]!, at)
    const once = remapKicadBoard(board)
    flipBoardFootprintInAST(once, once.footprints[0]!, at)
    const mids = /\(mid [^)]*\)/g
    const twice = serializeKicadBoard(remapKicadBoard(once))
    expect(twice.replace(mids, '(mid)')).toBe(pristine.replace(mids, '(mid)'))
    expect(twice.match(mids)).toEqual(['(mid 0.368256 -1.683611)', '(mid 0.149611 0.446888)'])
  })

  test('about another center, the anchor and the zone mirror across it', () => {
    const board = flipped('leftRight', { x: 60, y: 0 })
    expect(board.footprints[0]!.position).toEqual({ x: mm(70), y: mm(40), angle: 150 })
    expect(child(board, 'zone')).toContain('(xy 68 37) (xy 65 37.5) (xy 66 41)')
    // Own-frame children do not care where the anchor went.
    expect(child(board, 'fp_line')).toContain('(start -3 2) (end 3 2.5)')
  })

  test('the old footprint node is left alone for the edit delta and undo', () => {
    const board = parseKicadBoard(source)
    const before = board.footprints[0]!
    const text = serializeSExpr(before._raw)
    flipBoardFootprintInAST(board, before, before.position)
    expect(serializeSExpr(before._raw)).toBe(text)
    expect((board._raw as SExprList).children).not.toContain(before._raw)
  })
})

describe('flipBoardFootprintInAST — top-bottom', () => {
  const board = flipped('topBottom')

  test('the angle negates, folded into (-180°, 180°]; text turns to 180° less itself', () => {
    expect(board.footprints[0]!.position).toEqual({ x: mm(50), y: mm(40), angle: -30 })
    expect(findChild(board.footprints[0]!._raw, 'at')?.children.length).toBe(4)
    expect(child(board, 'property', 'Reference')).toContain('(at 1.5 2.5 150)')
    // No half turn, so no upright fold: the justification stays.
    expect(child(board, 'property', 'Reference')).toContain('(justify left mirror)')
    expect(child(board, 'fp_text', 'UP')).toContain('(at -2 -1 120)')
  })

  test('dimensions mirror across the anchor’s row', () => {
    expect(child(board, 'dimension', '(type aligned)')).toContain('(xy 47 42) (xy 53 39)')
    expect(child(board, 'dimension', '(type aligned)')).toContain(
      '(at 50.380131 41.260263 26.56505118)'
    )
    expect(child(board, 'dimension', '(type orthogonal)')).toContain('(xy 50 36) (xy 49.75 46)')
    expect(child(board, 'dimension', '(type orthogonal)')).toContain('(height 6.5)')
    expect(child(board, 'dimension', '(type orthogonal)')).toContain('(at 55.35 41 90)')
  })

  test('pad angles negate into [0°, 360°) and the zone mirrors across the anchor’s row', () => {
    expect(child(board, 'pad', '(pad "1"')).toContain('(at -2 1 330)')
    expect(child(board, 'pad', '(pad "2"')).toContain('(at 2 1 285)')
    expect(child(board, 'zone')).toContain('(xy 52 43) (xy 55 42.5) (xy 54 39)')
  })
})

describe('footprintFlipCenter', () => {
  test('one footprint flips about its anchor; several about the middle of their pads', () => {
    const board = parseKicadBoard(source)
    const fp = board.footprints[0]!
    expect(footprintFlipCenter([fp])).toEqual({ x: fp.position.x, y: fp.position.y })
    expect(footprintFlipCenter([])).toBeNull()
    const two = footprintFlipCenter([fp, { ...fp, position: { x: mm(60), y: mm(40) } }])!
    expect(two.y).toBeGreaterThan(mm(37))
    expect(two.y).toBeLessThan(mm(43))
    expect(two.x).toBeGreaterThan(mm(50))
    expect(two.x).toBeLessThan(mm(60))
  })
})

describe('footprintFlippable', () => {
  test('a footprint holding a table is left out', () => {
    const board = parseKicadBoard(source)
    const fp = board.footprints[0]!
    expect(footprintFlippable(fp)).toBe(true)
    const table = {} as KicadBoard['footprints'][number]['footprint']['tables'][number]
    const withTable = { ...fp, footprint: { ...fp.footprint, tables: [table] } }
    expect(footprintFlippable(withTable)).toBe(false)
  })
})

describe('flipBoardFootprintInAST — what KiCad’s writer puts back in order', () => {
  const board = (body: string): KicadBoard =>
    parseKicadBoard(`(kicad_pcb (version 20260206) (generator "x")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
    (5 "F.SilkS" user) (7 "B.SilkS" user))
  (footprint "T:T" (layer "F.Cu") (uuid "f") (at 10 10)
    ${body}))`)

  test('a layer list goes back to id order, wildcards first', () => {
    const b = board(`(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu" "In1.Cu" "In2.Cu") (uuid "z")
      (polygon (pts (xy 9 9) (xy 11 9) (xy 11 11)))
      (filled_polygon (layer "F.Cu") (pts (xy 9 9) (xy 11 9) (xy 11 11)))
      (filled_polygon (layer "In1.Cu") (pts (xy 9 9) (xy 11 9) (xy 11 11))))
    (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "F.SilkS" "B.Mask"))`)
    flipBoardFootprintInAST(b, b.footprints[0]!, b.footprints[0]!.position)
    const flippedBoard = remapKicadBoard(b)
    expect(child(flippedBoard, 'zone')).toContain('(layers "F.Cu" "B.Cu" "In1.Cu" "In2.Cu")')
    const fills = child(flippedBoard, 'zone').match(/\(filled_polygon \(layer "[^"]+"\)/g)
    expect(fills).toEqual(['(filled_polygon (layer "B.Cu")', '(filled_polygon (layer "In2.Cu")'])
    expect(child(flippedBoard, 'pad')).toContain('(layers "*.Cu" "F.Mask" "B.SilkS")')
  })

  test('a TrueType text’s cached outline mirrors about the flip center and takes the new angle', () => {
    const b = board(`(fp_text user "T" (at 1 0 90) (unlocked yes) (layer "F.SilkS") (uuid "t")
      (effects (font (face "Liberation Mono") (size 1 1) (thickness 0.15)))
      (render_cache "T" 90 (polygon (pts (xy 11 9) (xy 12 9) (xy 12 11)))))`)
    flipBoardFootprintInAST(b, b.footprints[0]!, b.footprints[0]!.position)
    const text = child(remapKicadBoard(b), 'fp_text')
    expect(text).toContain('(at 1 0 270)')
    expect(text).toContain('(render_cache "T" 270 (polygon (pts (xy 9 9) (xy 8 9) (xy 8 11))))')
  })

  test('the cache is dropped when keep-upright folds the text, which then draws otherwise', () => {
    const b = board(`(fp_text user "T" (at 1 0 90) (layer "F.SilkS") (uuid "t")
      (effects (font (face "Liberation Mono") (size 1 1) (thickness 0.15)))
      (render_cache "T" 90 (polygon (pts (xy 11 9) (xy 12 9) (xy 12 11)))))`)
    flipBoardFootprintInAST(b, b.footprints[0]!, b.footprints[0]!.position)
    const text = child(remapKicadBoard(b), 'fp_text')
    expect(text).toContain('(at 1 0 90)')
    expect(text).not.toContain('render_cache')
  })
})

describe('flipBoardFootprintInAST — a dimension a nanometer off vertical', () => {
  // KiCad keeps an aligned dimension's text along its crossbar, so a crossbar
  // 1 nm off vertical writes its angle a hair off 90°; the crossbar's center is
  // KiROUNDed (`VECTOR2I / 2`), not truncated, which is what puts it there.
  const source = `(kicad_pcb (version 20260206) (generator "x")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (17 "Dwgs.User" user "User.Drawings"))
  (footprint "T:T" (layer "F.Cu") (uuid "f") (at 10 10)
    (dimension (type aligned) (layer "Dwgs.User") (uuid "d")
      (pts (xy 20.000001 5) (xy 20 25)) (height -3)
      (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0)
        (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes))
      (gr_text "20.00 mm" (at 21.85 15 89.99999427) (layer "Dwgs.User") (uuid "d")
        (effects (font (size 1 1) (thickness 0.15)))))))`

  test.each([
    ['leftRight', '(xy -0.000001 5) (xy 0 25)', '(height 3)', '(at -1.85 15 270.0000057)'],
    ['topBottom', '(xy 20.000001 15) (xy 20 -5)', '(height 3)', '(at 24.15 5 -89.99999427)']
  ] as const)('%s, as KiCad writes it', (direction, pts, height, at) => {
    const board = parseKicadBoard(source)
    const fp = board.footprints[0]!
    flipBoardFootprintInAST(board, fp, fp.position, direction)
    const dim = child(remapKicadBoard(board), 'dimension')
    expect(dim).toContain(pts)
    expect(dim).toContain(height)
    expect(dim).toContain(at)
  })
})
