import { describe, expect, test } from 'vitest'
import { transformBoardItemsById } from '../boardItemsTransform'
import { boardItems, itemRecord } from '../boardItems'
import { parseKicadBoard, type KicadBoard } from '../../kicad/board'
import type { McpItemsTransform } from '../../../../../preload/mcpTypes'

const part = (reference: string, x: number, extra = ''): string =>
  `(footprint "Lib:R" (layer "F.Cu") (uuid "${reference}-uuid") (at ${x} 10) ${extra}
    (property "Reference" "${reference}" (at 0 -1 0) (layer "F.SilkS") (uuid "${reference}-ref"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "${reference}-p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (uuid "${reference}-p2")))`

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user) (37 "F.SilkS" user) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "A")
  ${part('R1', 10, '(locked yes) (attr smd dnp)')}
  ${part('R2', 20)}
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (gr_line (start 0 20) (end 10 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "l1"))
  (gr_rect (start 0 30) (end 4 32) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts") (uuid "r1"))
  (gr_curve (pts (xy 0 40) (xy 1 41) (xy 2 41) (xy 3 40)) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "bz1"))
  (point (at 60 60) (size 1) (layer "F.SilkS") (uuid "pt1"))
)`

const run = (
  spec: Omit<McpItemsTransform, 'ids'> & { ids: string[] }
): { board: KicadBoard; answer: ReturnType<typeof transformBoardItemsById> } => {
  const board = parseKicadBoard(BOARD)
  return { board, answer: transformBoardItemsById(board, spec) }
}

const record = (board: KicadBoard, id: string): Record<string, unknown> => {
  const items = boardItems(board)
  return itemRecord(
    board,
    items,
    items.find((item) => item.id === id)!
  ) as Record<string, unknown>
}

const after = (answer: ReturnType<typeof transformBoardItemsById>): KicadBoard => {
  if (!answer.ok) throw new Error(answer.detail)
  return answer.board
}

describe('items.transform on a board', () => {
  test('move shifts every item by the offset, a locked footprint too, as the editor moves it', () => {
    const { answer } = run({ transform: 'move', ids: ['R1', 't1'], by: { x: 1, y: 2 } })
    expect(answer).toMatchObject({ ok: true, changed: { updated: ['R1', 't1'] } })
    const board = after(answer)
    expect(record(board, 'R1')).toMatchObject({ at: { x: 11, y: 12 }, locked: true })
    expect(record(board, 't1')).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 11, y: 2 } })
  })

  test('rotate turns several about the middle of their box, one about its own position', () => {
    const pair = after(run({ transform: 'rotate', ids: ['R1', 'R2'], angle: 90 }).answer)
    // The box runs over both anchors and pads: x 9..21, so the pivot is (15, 10).
    expect(record(pair, 'R1')).toMatchObject({ at: { x: 15, y: 15 }, angle: 90 })
    expect(record(pair, 'R2')).toMatchObject({ at: { x: 15, y: 5 }, angle: 90 })
    const one = after(run({ transform: 'rotate', ids: ['R2'], angle: 45 }).answer)
    expect(record(one, 'R2')).toMatchObject({ at: { x: 20, y: 10 }, angle: 45 })
    const about = after(
      run({ transform: 'rotate', ids: ['l1'], angle: 180, about: { x: 0, y: 20 } }).answer
    )
    expect(record(about, 'l1')).toMatchObject({ start: { x: 0, y: 20 }, end: { x: -10, y: 20 } })
  })

  test('move takes the kinds the editor selects beside the drawings: a bezier, a point', () => {
    const board = after(run({ transform: 'move', ids: ['bz1', 'pt1'], by: { x: 1, y: 1 } }).answer)
    expect(record(board, 'bz1')).toMatchObject({
      points: [{ x: 1, y: 41 }, {}, {}, { x: 4, y: 41 }]
    })
    expect(record(board, 'pt1')).toMatchObject({ at: { x: 61, y: 61 } })
  })

  test('a rect turns only in quarter turns', () => {
    expect(run({ transform: 'rotate', ids: ['r1'], angle: 45 }).answer).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
  })

  test('flip puts a footprint on the back, about its own anchor', () => {
    const board = after(run({ transform: 'flip', ids: ['R2'] }).answer)
    expect(record(board, 'R2')).toMatchObject({ at: { x: 20, y: 10 }, side: 'back' })
  })

  test('mirror takes graphics and refuses a footprint or a pad', () => {
    const board = after(run({ transform: 'mirror', ids: ['l1'], axis: 'y' }).answer)
    // A lone line mirrors about its start.
    expect(record(board, 'l1')).toMatchObject({ start: { x: 0, y: 20 }, end: { x: -10, y: 20 } })
    expect(run({ transform: 'mirror', ids: ['R1'], axis: 'y' }).answer).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
    expect(run({ transform: 'move', ids: ['R1.1'], by: { x: 1, y: 0 } }).answer).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
  })

  test('duplicate copies a footprint with its overrides under a free reference', () => {
    const { answer } = run({ transform: 'duplicate', ids: ['R1', 't1'], by: { x: 0, y: 5 } })
    expect(answer).toMatchObject({ ok: true, changed: { created: ['R3', expect.any(String)] } })
    const board = after(answer)
    const copy = board.footprints.find((fp) => fp.reference === 'R3')!
    expect(record(board, 'R3')).toMatchObject({ at: { x: 10, y: 15 } })
    // The copy keeps R1's attributes and comes unlocked, as a paste does.
    expect(copy.footprint.attributes).toContain('dnp')
    expect(copy.footprint.locked).toBe(false)
    expect(copy.uuid).not.toBe('R1-uuid')
    expect(board.segments).toHaveLength(2)
    expect(board.footprints.map((fp) => fp.reference)).toEqual(['R1', 'R2', 'R3'])
  })

  test("duplicate numbers on from the copy's own number to the first free one, as KiCad's unique paste does", () => {
    // R1 and R3 on the board: R1's copy takes the free R2, not R4.
    const board = parseKicadBoard(BOARD.replace(/R2/g, 'R3'))
    const answer = transformBoardItemsById(board, {
      transform: 'duplicate',
      ids: ['R1'],
      by: { x: 0, y: 5 }
    })
    expect(answer).toMatchObject({ ok: true, changed: { created: ['R2'] } })
  })

  test('an unannotated R? copies as the first free R, and copies number in reference order', () => {
    // R1 and R? on the board: R?'s copy takes R2, not R?1.
    const unannotated = parseKicadBoard(BOARD.replace(/R2/g, 'R?'))
    expect(
      transformBoardItemsById(unannotated, {
        transform: 'duplicate',
        ids: ['R?'],
        by: { x: 0, y: 5 }
      })
    ).toMatchObject({ ok: true, changed: { created: ['R2'] } })
    // Asked in reverse, R1 still copies first, as KiCad sorts by reference.
    const { answer } = run({ transform: 'duplicate', ids: ['R2', 'R1'], by: { x: 0, y: 5 } })
    const board = after(answer)
    expect(record(board, 'R3')).toMatchObject({ at: { x: 10, y: 15 } })
    expect(record(board, 'R4')).toMatchObject({ at: { x: 20, y: 15 } })
  })

  test('rotate and flip refuse a text box, which the board editor leaves in place', () => {
    const board = parseKicadBoard(
      BOARD.replace(
        '  (point',
        '  (gr_text_box "hi" (start 0 50) (end 5 52) (layer "F.SilkS") (uuid "tb1") (effects (font (size 1 1))))\n  (point'
      )
    )
    const id = boardItems(board).find((item) => item.kind === 'text_box')!.id
    const specs: McpItemsTransform[] = [
      { transform: 'rotate', ids: [id], angle: 90 },
      { transform: 'flip', ids: [id] }
    ]
    for (const spec of specs)
      expect(transformBoardItemsById(board, spec)).toMatchObject({
        ok: false,
        error: 'not-transformable'
      })
  })

  test('an unknown id is refused with candidates, and the board is untouched', () => {
    const { board, answer } = run({ transform: 'move', ids: ['R9'], by: { x: 1, y: 0 } })
    expect(answer).toMatchObject({ ok: false, error: 'item-not-found' })
    expect(record(board, 'R1')).toMatchObject({ at: { x: 10, y: 10 } })
  })
})
