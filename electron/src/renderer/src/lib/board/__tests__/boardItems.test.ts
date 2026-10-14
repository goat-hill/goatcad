import { describe, expect, test } from 'vitest'
import {
  boardItems,
  createItem,
  deleteItems,
  itemRecord,
  itemRow,
  queryItems,
  resolveItem,
  resolveWritable,
  updateItem,
  type BoardEditDefaults
} from '../boardItems'
import { parseKicadBoard, serializeKicadBoard, type KicadBoard } from '../../kicad/board'
import { nmToMm } from '../../kicad/coordinates'

const fp = (reference: string, uuid: string, x: number, pads: string): string =>
  `(footprint "Lib:Part" (layer "F.Cu") (uuid "${uuid}") (at ${x} 10)
    (property "Reference" "${reference}" (at 0 0 0) (layer "F.SilkS") (uuid "${uuid}-r"))
    ${pads})`

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "/A")
  ${fp('U1', 'u1', 10, '(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "p1")) (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "p2")) (pad "" np_thru_hole circle (at -2 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "p3"))')}
  ${fp('J1', 'j1a', 30, '')}
  ${fp('J1', 'j1b', 40, '')}
  (gr_line (start 0 0) (end 50 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
)`

const defaults: BoardEditDefaults = {
  classOf: () => ({
    trackWidth: 0.25,
    viaDiameter: 0.6,
    viaDrill: 0.3,
    microviaDiameter: 0.3,
    microviaDrill: 0.1
  })
}

const board = (): KicadBoard => parseKicadBoard(BOARD)

describe('board item records', () => {
  test('a pad names its part as reference, sizes as width and height, its hole as drill', () => {
    const b = board()
    const items = boardItems(b)
    const pad = items.find((item) => item.id === 'p2')!
    expect(itemRecord(b, items, pad)).toMatchObject({
      reference: 'U1',
      angle: 0,
      size: { width: 1, height: 1 },
      drill: { diameter: 1 }
    })
  })

  test('a footprint at no turn still answers angle 0, beside its side', () => {
    const b = board()
    const items = boardItems(b)
    const record = itemRecord(
      b,
      items,
      items.find((item) => item.id === 'U1')!
    )
    expect(record).toMatchObject({ at: { x: 10, y: 10 }, angle: 0, side: 'front' })
  })
})

describe('board item ids', () => {
  test('a reference two footprints share falls back to their uuids', () => {
    const ids = boardItems(board())
      .filter((item) => item.kind === 'footprint')
      .map((item) => item.id)
    expect(ids).toEqual(['U1', 'j1a', 'j1b'])
  })

  test('a pad is <reference>.<number>; unnumbered pads fall back to their uuids', () => {
    const ids = boardItems(board())
      .filter((item) => item.kind === 'pad')
      .map((item) => item.id)
    expect(ids).toEqual(['U1.1', 'p2', 'p3'])
  })

  test('an item the file gave no uuid is its kind at its first point', () => {
    const line = boardItems(board()).find((item) => item.kind === 'line')
    expect(line?.id).toBe('line@0,0')
  })

  test('a footprint is also reached by its uuid', () => {
    const found = resolveItem(boardItems(board()), 'u1')
    expect(found.ok && found.item.id).toBe('U1')
  })

  test("a footprint's own drawing reads as its footprint, and a write naming it is refused", () => {
    const items = boardItems(board())
    const read = resolveItem(items, 'u1-r')
    expect(read.ok && read.item.id).toBe('U1')
    const write = resolveWritable(items, 'u1-r')
    expect(write.ok).toBe(false)
    expect(!write.ok && write.error).toBe('refused')
    expect(resolveWritable(items, 'u1').ok).toBe(true)
  })

  const switchBoard = (): KicadBoard =>
    parseKicadBoard(
      BOARD.replace(
        '(gr_line',
        `${fp('SW2', 'sw2', 60, '(pad "1" smd rect (at -3 0) (size 1 1) (layers "F.Cu") (uuid "s1a")) (pad "1" smd rect (at 3 0) (size 1 1) (layers "F.Cu") (uuid "s1b")) (pad "2" smd rect (at 0 2) (size 1 1) (layers "F.Cu") (uuid "s2"))')}
  (gr_line`
      )
    )

  test('a pad number that repeats is refused with each pad by id and position', () => {
    const found = resolveItem(boardItems(switchBoard()), 'SW2.1')
    expect(found).toMatchObject({
      ok: false,
      error: 'pad-ambiguous',
      candidates: ['s1a', 's1b']
    })
    expect(!found.ok && found.detail).toContain('s1a at 57,10; s1b at 63,10')
  })

  test('a miss on a footprint offers its pads, uuid-named ones too', () => {
    const found = resolveItem(boardItems(switchBoard()), 'SW2.7')
    expect(!found.ok && found.candidates).toEqual(['SW2', 's1a', 's1b', 'SW2.2'])
  })

  test("a footprint's record lists its pads with their ids and numbers", () => {
    const b = switchBoard()
    const items = boardItems(b)
    const record = itemRecord(
      b,
      items,
      items.find((item) => item.id === 'SW2')!
    )
    expect(
      (record.pads as Array<{ id: string; number: string }>).map(({ id, number }) => [id, number])
    ).toEqual([
      ['s1a', '1'],
      ['s1b', '1'],
      ['SW2.2', '2']
    ])
  })
})

describe('board item query', () => {
  test('near an item measures from the center of its box, not from its outline', () => {
    const b = board()
    const found = queryItems(b, boardItems(b), { kind: 'pad', near: { id: 'U1' }, radius: 0.1 })
    // p2 and p3 lie inside U1's box, but 1.5 mm from its center.
    expect('rows' in found && found.rows.map((item) => item.id)).toEqual(['U1.1'])
  })

  test("a pad row carries box and layers, as the pad's record does", () => {
    const b = board()
    const items = boardItems(b)
    const found = queryItems(b, items, { kind: 'pad', net: 'A' })
    const record = itemRecord(
      b,
      items,
      items.find((item) => item.id === 'U1.1')!
    )
    expect('rows' in found && itemRow(b, found.rows[0])).toMatchObject({
      id: 'U1.1',
      layers: ['F.Cu'],
      box: { x: 9.5, y: 9.5, width: 1, height: 1 }
    })
    expect('rows' in found && itemRow(b, found.rows[0])).toMatchObject({
      box: record.box,
      layers: record.layers
    })
  })

  test('a net matches with or without its leading slash', () => {
    const b = board()
    const found = queryItems(b, boardItems(b), { net: 'A' })
    expect('rows' in found && found.rows.map((item) => item.id)).toEqual(['U1.1'])
  })

  test('a box keeps what touches it, and the cap says how many matched', () => {
    const b = board()
    const found = queryItems(b, boardItems(b), {
      box: { x: 29, y: 9, width: 12, height: 2 },
      kind: 'footprint',
      limit: 1
    })
    expect('rows' in found && [found.rows.map((item) => item.id), found.total]).toEqual([
      ['j1a'],
      2
    ])
  })
})

describe('board item writes', () => {
  test('a circle is created from its center and radius and read back the same way', () => {
    const b = board()
    const made = createItem(
      b,
      'circle',
      { layer: 'F.SilkS', center: { x: 5, y: 5 }, radius: 2 },
      defaults
    )
    if (!made.ok) throw new Error(made.detail)
    const items = boardItems(made.board)
    const circle = items.find((item) => item.id === made.ids[0])!
    expect(itemRecord(made.board, items, circle)).toMatchObject({
      kind: 'circle',
      center: { x: 5, y: 5 },
      radius: 2,
      width: 0.1
    })
  })

  test('a zone lands with its properties; a rule area carries its rules', () => {
    const b = board()
    const made = createItem(
      b,
      'zone',
      {
        keepout: true,
        layers: ['F.Cu', 'B.Cu'],
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 }
        ],
        rules: { tracks: 'not_allowed', footprints: 'allowed' },
        priority: 2
      },
      defaults
    )
    if (!made.ok) throw new Error(made.detail)
    const items = boardItems(made.board)
    const zone = items.find((item) => item.id === made.ids[0])!
    expect(itemRecord(made.board, items, zone)).toMatchObject({
      keepout: true,
      priority: 2,
      rules: { tracks: 'not_allowed', footprints: 'allowed' }
    })
  })

  test('a via whose drill is not smaller than its size is refused', () => {
    const b = board()
    const made = createItem(
      b,
      'via',
      { at: { x: 1, y: 1 }, net: '', size: 0.3, drill: 0.3 },
      defaults
    )
    expect(made).toMatchObject({ ok: false, error: 'invalid-record' })
  })

  test('a text takes the layer default size', () => {
    const b = board()
    const made = createItem(
      b,
      'text',
      { text: 'REV A', at: { x: 1, y: 1 }, layer: 'F.SilkS' },
      defaults
    )
    if (!made.ok) throw new Error(made.detail)
    const text = made.board.grTexts[0]
    expect([text.text, nmToMm(text.fontEffects!.height)]).toEqual(['REV A', 1])
  })

  test('a layer the board lacks is refused with the ones it has', () => {
    const b = board()
    const line = boardItems(b).find((item) => item.kind === 'line')!
    const outcome = updateItem(b, line, { layer: 'User.9' })
    expect(outcome).toMatchObject({ ok: false, error: 'layer-not-found' })
    expect(!outcome.ok && outcome.candidates).toContain('Edge.Cuts')
  })

  test('a pad is not written on its own', () => {
    const b = board()
    const pad = resolveItem(boardItems(b), 'U1.1')
    if (!pad.ok) throw new Error(pad.detail)
    expect(updateItem(b, pad.item, { at: { x: 0, y: 0 } })).toMatchObject({
      ok: false,
      error: 'refused'
    })
  })
})

describe('a KiCad 10 board, nets by name', () => {
  const V10 = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "GND") (uuid "s1"))
)`

  test('a zone on no net is written with no net node, as KiCad 10 writes one', () => {
    const b = parseKicadBoard(V10)
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 }
    ]
    const made = createItem(b, 'zone', { keepout: true, layers: ['F.Cu'], points }, defaults)
    if (!made.ok) throw new Error(made.detail)
    const zone = made.board.zones[0]
    expect(serializeKicadBoard(made.board)).not.toContain('(net ""')
    // Given a net, the node comes back first; taken away, it goes.
    const items = boardItems(made.board)
    const item = items.find((entry) => entry.id === made.ids[0])!
    const withNet = updateItem(made.board, item, { net: 'GND' })
    if (!withNet.ok) throw new Error(withNet.detail)
    expect(serializeKicadBoard(withNet.board)).toMatch(/\(zone\s+\(net "GND"\)/)
    updateItem(withNet.board, item, { net: '' })
    expect(zone.net).toBe(0)
    expect(serializeKicadBoard(withNet.board)).not.toMatch(/\(zone\s+\(net/)
  })
})

describe("a footprint's zones on the board", () => {
  const WITH_KEEPOUT = BOARD.replace(
    '(pad "1" smd rect',
    `(zone (net 0) (net_name "") (layers "F.Cu") (uuid "kz") (hatch edge 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
      (polygon (pts (xy 8 4) (xy 12 4) (xy 12 6) (xy 8 6))))
    (pad "1" smd rect`
  )

  test('are listed as zones, as its pads are, naming the footprint as reference', () => {
    const b = parseKicadBoard(WITH_KEEPOUT)
    const items = boardItems(b)
    const found = queryItems(b, items, { kind: 'zone' })
    if ('ok' in found) throw new Error(found.detail)
    expect(found.rows.map((item) => itemRow(b, item))).toEqual([
      {
        id: 'kz',
        kind: 'zone',
        reference: 'U1',
        net: '',
        layers: ['F.Cu'],
        keepout: true,
        box: { x: 8, y: 4, width: 4, height: 2 }
      }
    ])
    expect(itemRecord(b, items, found.rows[0])).toMatchObject({
      rules: { tracks: 'not_allowed', pads: 'allowed' },
      points: [
        { x: 8, y: 4 },
        { x: 12, y: 4 },
        { x: 12, y: 6 },
        { x: 8, y: 6 }
      ]
    })
  })

  test('are read-only: they go with their footprint', () => {
    const b = parseKicadBoard(WITH_KEEPOUT)
    const found = resolveItem(boardItems(b), 'kz')
    if (!found.ok) throw new Error(found.detail)
    expect(updateItem(b, found.item, { name: 'x' })).toMatchObject({ ok: false, error: 'refused' })
    expect(deleteItems(b, [found.item])).toMatchObject({ ok: false, error: 'refused' })
    expect(serializeKicadBoard(b)).toBe(serializeKicadBoard(parseKicadBoard(WITH_KEEPOUT)))
  })
})
