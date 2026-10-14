import { describe, expect, test } from 'vitest'
import {
  copyBoardItems,
  copyFootprintItems,
  insertIntoBoard,
  insertIntoFootprint,
  itemsAnchor,
  pasteOffset,
  prepareBoardPaste,
  prepareFootprintPaste,
  translateItem
} from '../pcbClipboard'
import { parseKicadBoard, remapKicadBoard, serializeKicadBoard } from '../../kicad/board'
import { parseKicadFootprint, serializeKicadFootprint } from '../../kicad/footprint'
import { findChild, getToken, parseSExpr, serializeSExpr, type SExprList } from '../../kicad/sexpr'
import { mmToNm, nm } from '../../kicad/coordinates'

const list = (text: string): SExprList => parseSExpr(text) as SExprList
const one = (text: string): string => serializeSExpr(list(text))

/** A footprint's items, as a select-all would hand them to copy. */
const ITEM_TOKENS = new Set(['property', 'fp_line', 'fp_text', 'pad'])
const itemNodes = (root: SExprList): SExprList[] =>
  root.children.filter(
    (child): child is SExprList => child.type === 'list' && ITEM_TOKENS.has(getToken(child) ?? '')
  )

const NUMBERED = `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (footprint "R" (layer "F.Cu") (uuid "f1") (at 10 10)
    (property "Reference" "R1" (at 0 -1 0) (layer "F.SilkS") (uuid "p1"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "pad1")))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 2) (locked yes) (uuid "s1"))
)`

const NAMED = `(kicad_pcb
  (version 20250901)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "GND") (uuid "n1"))
)`

const FOOTPRINT = `(footprint "Test"
  (version 20240108)
  (generator "test")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (uuid "r"))
  (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.12) (type default)) (layer "F.SilkS") (uuid "l1"))
  (fp_text user "\${REFERENCE}" (at 0 2 0) (layer "F.Fab") (uuid "t1"))
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (uuid "pd1"))
)`

describe('translateItem', () => {
  test('moves every position a graphic owns', () => {
    const node = list('(gr_poly (pts (xy 0 0) (xy 1 0) (arc (start 1 0) (mid 2 1) (end 1 2))))')
    translateItem(node, mmToNm(1), mmToNm(2))
    expect(serializeSExpr(node)).toBe(
      one('(gr_poly (pts (xy 1 2) (xy 2 2) (arc (start 2 2) (mid 3 3) (end 2 4))))')
    )
  })

  test('a pad moves by its own at, never its primitives or drill offset', () => {
    const node = list(
      '(pad "1" smd custom (at 1 1 90) (drill 1 (offset 0.5 0)) (primitives (gr_line (start 0 0) (end 1 0))))'
    )
    translateItem(node, mmToNm(1), mmToNm(1))
    expect(serializeSExpr(node)).toBe(
      one(
        '(pad "1" smd custom (at 2 2 90) (drill 1 (offset 0.5 0)) (primitives (gr_line (start 0 0) (end 1 0))))'
      )
    )
  })

  test('a board footprint moves its at and its board-absolute zones, not its children', () => {
    const node = list(
      '(footprint "X" (at 10 10) (fp_line (start 0 0) (end 1 0)) (zone (polygon (pts (xy 10 10) (xy 11 10)))))'
    )
    translateItem(node, mmToNm(1), 0)
    expect(serializeSExpr(node)).toBe(
      one(
        '(footprint "X" (at 11 10) (fp_line (start 0 0) (end 1 0)) (zone (polygon (pts (xy 11 10) (xy 12 10)))))'
      )
    )
  })
})

describe('itemsAnchor and pasteOffset', () => {
  test('the anchor is the top-left of every position', () => {
    const anchor = itemsAnchor([
      list('(gr_line (start 3 4) (end 5 1))'),
      list('(via (at 2 6) (size 0.6))')
    ])
    expect(anchor).toEqual({ x: mmToNm(2), y: mmToNm(1) })
  })

  test('at the cursor, the snapped anchor lands on it', () => {
    const offset = pasteOffset(
      { x: mmToNm(1.1), y: mmToNm(2) },
      { cursor: { x: mmToNm(5), y: mmToNm(5) }, gridStep: mmToNm(1), sameKind: true }
    )
    expect(offset).toEqual({ x: mmToNm(4), y: mmToNm(3) })
  })

  test('without a cursor: a grid step, or the origin from the other editor', () => {
    const anchor = { x: mmToNm(100), y: mmToNm(50) }
    const step = mmToNm(0.5)
    expect(pasteOffset(anchor, { cursor: null, gridStep: step, sameKind: true })).toEqual({
      x: step,
      y: step
    })
    expect(pasteOffset(anchor, { cursor: null, gridStep: step, sameKind: false })).toEqual({
      x: -mmToNm(100),
      y: -mmToNm(50)
    })
  })
})

describe('copy', () => {
  test('a board copy spells nets by name and drops the lock', () => {
    const board = parseKicadBoard(NUMBERED)
    const names = new Map(board.nets.map((net) => [net.number, net.name]))
    const [footprint, segment] = copyBoardItems(
      [board.footprints[0]._raw, board.segments[0]._raw],
      names
    )
    expect(segment).toContain('(net "VCC")')
    expect(segment).not.toContain('locked')
    expect(footprint).toContain('(net "GND")')
  })

  test('a footprint copy leaves the fields behind but keeps user text', () => {
    const fp = parseKicadFootprint(FOOTPRINT)
    const root = fp._raw as SExprList
    const items = copyFootprintItems(itemNodes(root))
    const tokens = items.map((text) => getToken(parseSExpr(text)))
    expect(tokens).toEqual(['fp_line', 'fp_text', 'pad'])
  })
})

describe('paste into a board', () => {
  test('a board-to-board paste maps nets by name, adding a missing one', () => {
    const board = parseKicadBoard(NUMBERED)
    const prepared = prepareBoardPaste({
      kind: 'board',
      items: ['(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "x"))']
    })
    const refs = insertIntoBoard(board, prepared.nodes, { x: nm(0), y: nm(0) })
    const next = remapKicadBoard(board)
    expect(refs).toEqual([{ type: 'segment', index: 1 }])
    expect(next.nets.find((net) => net.name === 'SIG')?.number).toBe(3)
    const text = serializeKicadBoard(next)
    expect(text).toContain('(net 3 "SIG")')
    // A numbered file's track carries the number alone.
    expect(serializeSExpr(next.segments[1]._raw)).toContain('(net 3)')
    expect(serializeSExpr(next.segments[1]._raw)).not.toContain('"x"')
  })

  test('a named board keeps the name, and an existing net is reused', () => {
    const board = parseKicadBoard(NAMED)
    const prepared = prepareBoardPaste({
      kind: 'board',
      items: ['(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v"))']
    })
    insertIntoBoard(board, prepared.nodes, { x: mmToNm(1), y: nm(0) })
    const next = remapKicadBoard(board)
    const via = serializeSExpr(next.vias[0]._raw)
    expect(via).toContain('(net "GND")')
    expect(via).toContain('(at 2 1)')
  })

  test('a footprint editor’s items land as one new footprint', () => {
    const board = parseKicadBoard(NUMBERED)
    const fp = parseKicadFootprint(FOOTPRINT)
    const items = copyFootprintItems(itemNodes(fp._raw as SExprList))
    const prepared = prepareBoardPaste({ kind: 'footprint', items })
    expect(prepared.nodes).toHaveLength(1)
    const [wrapper] = prepared.nodes
    expect(getToken(wrapper)).toBe('footprint')
    // It stands at the items' top-left and holds them relative to it.
    expect(serializeSExpr(findChild(wrapper, 'at')!)).toBe('(at -1 -1)')
    const refs = insertIntoBoard(board, prepared.nodes, { x: mmToNm(20), y: mmToNm(20) })
    expect(refs).toEqual([{ type: 'footprint', index: 1 }])
    const next = remapKicadBoard(board)
    expect(next.footprints).toHaveLength(2)
    expect(next.footprints[1].footprint.pads).toHaveLength(1)
    expect(serializeSExpr(findChild(next.footprints[1]._raw as SExprList, 'at')!)).toBe(
      '(at 19 19)'
    )
  })
})

describe('T4: a tuning pattern copied with its tracks', () => {
  const PATTERN = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 1 "SIG")
  (segment (start 2 0) (end 2 -1) (width 0.2) (layer "F.Cu") (net 1) (uuid "m1"))
  (segment (start 2 -1) (end 4 -1) (width 0.2) (layer "F.Cu") (net 1) (uuid "m2"))
  (generated (uuid "pat") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
    (base_line (pts (xy 2 0) (xy 4 0))) (end (xy 4 0)) (origin (xy 2 0)) (tuning_mode "single")
    (members "m1" "m2"))
)`
  const copied = (b: ReturnType<typeof parseKicadBoard>, raws: SExprList[]): SExprList[] =>
    prepareBoardPaste({
      kind: 'board',
      items: copyBoardItems(raws, new Map(b.nets.map((n) => [n.number, n.name])))
    }).nodes

  test("pastes as a pattern over the tracks' copies, moved with them", () => {
    const b = parseKicadBoard(PATTERN)
    const raws = [b.tuningPatterns[0]._raw, ...b.segments.map((s) => s._raw)] as SExprList[]
    const refs = insertIntoBoard(b, copied(b, raws), { x: mmToNm(10), y: nm(0) })
    expect(refs).toEqual([
      { type: 'tuning_pattern', index: 1 },
      { type: 'segment', index: 2 },
      { type: 'segment', index: 3 }
    ])
    const next = remapKicadBoard(b)
    const pasted = next.tuningPatterns[1]
    const copies = next.segments.slice(2).map((s) => s.uuid)
    expect(pasted.uuid).not.toBe('pat')
    expect([...pasted.members].sort()).toEqual([...copies].sort())
    expect(pasted.origin).toEqual({ x: mmToNm(12), y: nm(0) })
    expect(pasted.end).toEqual({ x: mmToNm(14), y: nm(0) })
    expect(pasted.baseLine[1]).toEqual({ x: mmToNm(14), y: nm(0) })
    // The original keeps its own.
    expect(next.tuningPatterns[0].members).toEqual(['m1', 'm2'])
  })

  test('a pattern none of whose tracks came with it is not pasted', () => {
    const b = parseKicadBoard(PATTERN)
    const refs = insertIntoBoard(b, copied(b, [b.tuningPatterns[0]._raw as SExprList]), {
      x: nm(0),
      y: nm(0)
    })
    expect(refs).toEqual([])
    expect(remapKicadBoard(b).tuningPatterns).toHaveLength(1)
  })
})

test('a footprint zone’s (net 0) lands as no net, not a net named "0"', () => {
  const board = parseKicadBoard(NUMBERED)
  const prepared = prepareBoardPaste({
    kind: 'footprint',
    items: [
      '(zone (net 0) (net_name "") (layers "F.Cu") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))'
    ]
  })
  insertIntoBoard(board, prepared.nodes, { x: nm(0), y: nm(0) })
  const next = remapKicadBoard(board)
  expect(next.nets.map((net) => net.name)).not.toContain('0')
  expect(serializeSExpr(next.footprints[1]._raw)).toContain('(net 0)')
})

describe('paste into a footprint', () => {
  test('tracks and vias are dropped and counted; graphics are renamed', () => {
    const prepared = prepareFootprintPaste({
      kind: 'board',
      items: [
        '(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "GND"))',
        '(via (at 0 0) (size 0.6))',
        '(gr_line (start 0 0) (end 1 0) (stroke (width 0.1) (type default)) (layer "F.SilkS"))',
        '(gr_text "HI" (at 1 1 0) (layer "F.SilkS") (effects (font (size 1 1))))'
      ]
    })
    expect(prepared.dropped).toBe(2)
    expect(prepared.nodes.map((node) => getToken(node))).toEqual(['fp_line', 'fp_text'])
    expect(serializeSExpr(prepared.nodes[1])).toMatch(/^\(fp_text user "HI"/)
  })

  test('a board footprint pastes as its pads and graphics, unrotated and without nets', () => {
    const prepared = prepareFootprintPaste({
      kind: 'board',
      items: [
        `(footprint "R" (layer "F.Cu") (at 10 10 90)
          (property "Reference" "R1" (at 0 -1 90) (layer "F.SilkS"))
          (fp_line (start 0 0) (end 1 0) (layer "F.SilkS"))
          (pad "1" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu") (net 1 "GND") (pinfunction "A")))`
      ]
    })
    expect(prepared.nodes.map((node) => getToken(node))).toEqual(['fp_line', 'pad'])
    const pad = serializeSExpr(prepared.nodes[1])
    expect(pad).toContain('(at 9 10)')
    expect(pad).not.toContain('net')
    expect(pad).not.toContain('pinfunction')
  })

  test('inserting appends and names the new items for the selection', () => {
    const fp = parseKicadFootprint(FOOTPRINT)
    const items = copyFootprintItems(itemNodes(fp._raw as SExprList))
    const prepared = prepareFootprintPaste({ kind: 'footprint', items })
    const refs = insertIntoFootprint(fp, prepared.nodes, { x: mmToNm(1), y: mmToNm(1) })
    expect(refs).toEqual([
      { type: 'line', index: 1 },
      { type: 'text', index: 1 },
      { type: 'pad', index: 1 }
    ])
    const next = parseKicadFootprint(serializeKicadFootprint(fp))
    expect(next.pads).toHaveLength(2)
    expect(next.pads[1].position).toEqual({ x: 0, y: mmToNm(1) })
    expect(next.pads[1].uuid).not.toBe('pd1')
  })
})

describe('Béziers, text boxes, tables and points', () => {
  const TABLE =
    '(table (column_count 1) (column_widths 2) (row_heights 1) (cells (table_cell "A" (start 0 0) (end 2 1) (layer "F.SilkS") (uuid "c1"))) (layer "F.SilkS") (uuid "tb"))'

  test('a table moves its cells', () => {
    const node = list(TABLE)
    translateItem(node, mmToNm(1), mmToNm(1))
    const text = serializeSExpr(node)
    expect(text).toContain('(start 1 1)')
    expect(text).toContain('(end 3 2)')
  })

  test('board to footprint: renamed or carried as is, and selected once landed', () => {
    const prepared = prepareFootprintPaste({
      kind: 'board',
      items: [
        '(gr_curve (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "cv"))',
        '(gr_text_box "T" (start 0 0) (end 2 1) (layer "F.SilkS") (effects (font (size 1 1))) (uuid "bx"))',
        TABLE,
        '(point (at 1 1) (size 0.5) (layer "F.SilkS") (uuid "pt"))'
      ]
    })
    expect(prepared.dropped).toBe(0)
    expect(prepared.nodes.map((node) => getToken(node))).toEqual([
      'fp_curve',
      'fp_text_box',
      'table',
      'point'
    ])
    const fp = parseKicadFootprint(FOOTPRINT)
    const refs = insertIntoFootprint(fp, prepared.nodes, { x: nm(0), y: nm(0) })
    expect(refs).toEqual([
      { type: 'curve', index: 0 },
      { type: 'textbox', index: 0 },
      { type: 'table', index: 0 },
      { type: 'point', index: 0 }
    ])
  })

  test('board to board: the pasted items are selected', () => {
    const board = parseKicadBoard(NUMBERED)
    const prepared = prepareBoardPaste({
      kind: 'board',
      items: [
        '(gr_curve (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0.1) (type default)) (layer "F.SilkS"))',
        '(point (at 1 1) (size 0.5) (layer "F.SilkS"))'
      ]
    })
    const refs = insertIntoBoard(board, prepared.nodes, { x: nm(0), y: nm(0) })
    expect(refs).toEqual([
      { type: 'gr_curve', index: 0 },
      { type: 'point', index: 0 }
    ])
    const next = remapKicadBoard(board)
    expect(next.grCurves).toHaveLength(1)
    expect(next.points).toHaveLength(1)
  })
})
