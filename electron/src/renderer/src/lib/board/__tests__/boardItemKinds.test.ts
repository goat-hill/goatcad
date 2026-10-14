import { describe, expect, test } from 'vitest'
import {
  boardItems,
  createItem,
  deleteItems,
  itemRecord,
  resolveItem,
  updateItem,
  type BoardEditDefaults,
  type BoardItem
} from '../boardItems'
import { boardField, updateBoardField } from '../boardFields'
import {
  parseKicadBoard,
  remapKicadBoard,
  serializeKicadBoard,
  type KicadBoard
} from '../../kicad/board'

// What the board editor edits beyond tracks and outlines, as an agent reads
// and writes it: via types, the drawings KiCad 10 added, text formatting,
// strokes, zone fill and islands, a tuning pattern, a part's own names.

const seg = (uuid: string, x0: number, y0: number, x1: number, y1: number): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.2) (layer "F.Cu") (net 2) (uuid "${uuid}"))`

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)
    (37 "F.SilkS" user) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "GND")
  (net 2 "SIG")
  (footprint "Lib:R" (layer "F.Cu") (uuid "r1") (at 10 10) (path "/aaaa/bbbb")
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "r1-r"))
    (property "Value" "10k" (at 0 1 0) (layer "F.SilkS") (uuid "r1-v")))
  (footprint "Lib:H" (layer "F.Cu") (uuid "h1") (at 30 10)
    (property "Reference" "H1" (at 0 0 0) (layer "F.SilkS") (uuid "h1-r"))
    (property "Value" "Hole" (at 0 1 0) (layer "F.SilkS") (uuid "h1-v")))
  (via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (gr_rect (start 0 0) (end 4 2) (stroke (width 0.1) (type dash) (color 255 0 0 1)) (fill none) (layer "F.Cu") (net 1) (uuid "gr1"))
  (gr_line (start 0 5) (end 4 5) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "gl1"))
  (gr_curve (pts (xy 0 30) (xy 1 31) (xy 2 31) (xy 3 30)) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "bz1"))
  (gr_text "HI" (at 20 20) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))
  (gr_text_box "BOX" (start 40 40) (end 50 45) (margins 0.5 0.5 0.5 0.5) (layer "F.SilkS") (uuid "tb1")
    (effects (font (size 1 1) (thickness 0.15))) (border yes) (stroke (width 0.1) (type solid)))
  (point (at 60 60) (size 1) (layer "F.SilkS") (uuid "pt1"))
  (table (column_count 1) (layer "F.SilkS") (column_widths 10) (row_heights 5)
    (cells (table_cell "A" (start 70 70) (end 80 75) (layer "F.SilkS") (uuid "c1"))) (uuid "tab1"))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5)
    (connect_pads (clearance 0.5)) (min_thickness 0.25)
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))))
  ${seg('l1', 100, 0, 102, 0)}
  ${seg('m1', 102, 0, 102, -1)}
  ${seg('m2', 102, -1, 104, -1)}
  ${seg('m3', 104, -1, 104, 0)}
  ${seg('l2', 104, 0, 106, 0)}
  (generated (uuid "pat") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
    (base_line (pts (xy 102 0) (xy 104 0))) (corner_radius_percent 80) (end (xy 104 0))
    (initial_side "left") (last_netname "SIG") (last_status "tuned") (last_track_width 0.2)
    (last_tuning_length 8) (max_amplitude 1) (min_amplitude 0.2) (min_spacing 0.6)
    (origin (xy 102 0)) (override_custom_rules no) (rounded yes) (single_sided no)
    (target_length 8) (target_length_max 8.1) (target_length_min 7.9) (tuning_mode "single")
    (members "m1" "m2" "m3"))
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

const item = (b: KicadBoard, id: string): BoardItem => {
  const found = resolveItem(boardItems(b), id)
  if (!found.ok) throw new Error(found.detail)
  return found.item
}

const record = (b: KicadBoard, id: string): Record<string, unknown> =>
  itemRecord(b, boardItems(b), item(b, id))

/**
 * Write a record and read the item back: from the board the write answered,
 * as the session's next read sees it, and from the file it saves, which agree.
 */
const written = (id: string, change: Record<string, unknown>): Record<string, unknown> => {
  const b = board()
  const outcome = updateItem(b, item(b, id), change)
  if (!outcome.ok) throw new Error(outcome.detail)
  const live = record(remapKicadBoard(outcome.board), outcome.id)
  const saved = record(parseKicadBoard(serializeKicadBoard(outcome.board)), outcome.id)
  expect(live).toEqual(saved)
  return saved
}

describe('fill', () => {
  test("reads as the editor names it, in KiCad 10's yes/no and KiCad 8's solid/none alike", () => {
    const b = parseKicadBoard(`(kicad_pcb (version 20250000) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (37 "F.SilkS" user))
  (gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS") (uuid "r10no"))
  (gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.SilkS") (uuid "r10yes"))
  (gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.SilkS") (uuid "r8none"))
)`)
    expect(['r10no', 'r10yes', 'r8none'].map((id) => record(b, id).fill)).toEqual([
      'none',
      'solid',
      'none'
    ])
  })
})

describe('the drawings KiCad 10 added', () => {
  test('each is an item of its own kind, by its uuid', () => {
    const kinds = Object.fromEntries(boardItems(board()).map((entry) => [entry.id, entry.kind]))
    expect(kinds).toMatchObject({
      tb1: 'text_box',
      bz1: 'bezier',
      pt1: 'point',
      tab1: 'table',
      pat: 'tuning_pattern'
    })
  })

  test('a text box, a table and a point read as the footprint door reads them', () => {
    const b = board()
    expect(record(b, 'tb1')).toMatchObject({
      text: 'BOX',
      start: { x: 40, y: 40 },
      end: { x: 50, y: 45 },
      border: true,
      margins: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
      locked: false
    })
    expect(record(b, 'tab1')).toMatchObject({ columns: 1, rows: 1, cells: ['A'] })
    expect(record(b, 'pt1')).toMatchObject({ at: { x: 60, y: 60 }, size: 1, layer: 'F.SilkS' })
  })

  test('a tuning pattern reads its settings and its tracks', () => {
    expect(record(board(), 'pat')).toMatchObject({
      net: 'SIG',
      mode: 'single',
      length: 8,
      target: 8,
      maxAmplitude: 1,
      tracks: ['m1', 'm2', 'm3']
    })
  })

  test('a tuning pattern is not written; deleted alone, it gives back the track it replaced', () => {
    const b = board()
    expect(updateItem(b, item(b, 'pat'), { rounded: false })).toMatchObject({ error: 'refused' })
    const outcome = deleteItems(b, [item(b, 'pat')])
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.deleted).toEqual(['m1', 'm2', 'm3'])
    expect(outcome.created).toHaveLength(1)
    expect(outcome.board.tuningPatterns).toHaveLength(0)
    const back = outcome.board.segments.find((s) => !['l1', 'l2'].includes(s.uuid ?? ''))
    expect(back).toMatchObject({ start: { x: 102e6, y: 0 }, end: { x: 104e6, y: 0 } })
  })

  test('a tuning pattern deleted beside another item takes its tracks with it', () => {
    const b = board()
    const outcome = deleteItems(b, [item(b, 'pat'), item(b, 'pt1')])
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.created).toEqual([])
    expect(outcome.board.segments.map((s) => s.uuid)).toEqual(['l1', 'l2'])
  })

  test('a text box, a point and a bezier are created as the editor draws them', () => {
    const b = board()
    const box = createItem(
      b,
      'text_box',
      {
        text: 'NOTE',
        start: { x: 0, y: 50 },
        end: { x: 10, y: 55 },
        layer: 'F.SilkS',
        bold: true,
        border: false
      },
      defaults
    )
    if (!box.ok) throw new Error(box.detail)
    expect(record(box.board, box.ids[0])).toMatchObject({ text: 'NOTE', bold: true, border: false })
    const point = createItem(box.board, 'point', { at: { x: 1, y: 2 }, layer: 'F.SilkS' }, defaults)
    if (!point.ok) throw new Error(point.detail)
    expect(record(point.board, point.ids[0])).toMatchObject({ kind: 'point', size: 1 })
    const curve = { layer: 'F.SilkS', strokeType: 'dot' }
    const four = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 0 }
    ]
    expect(createItem(b, 'bezier', { ...curve, points: four.slice(0, 3) }, defaults)).toMatchObject(
      {
        error: 'invalid-record'
      }
    )
    const made = createItem(point.board, 'bezier', { ...curve, points: four }, defaults)
    if (!made.ok) throw new Error(made.detail)
    expect(record(made.board, made.ids[0])).toMatchObject({ points: four, strokeType: 'dot' })
  })

  test("a table's cells are read-only; its borders are written", () => {
    const b = board()
    expect(updateItem(b, item(b, 'tab1'), { cells: ['B'] })).toMatchObject({
      error: 'not-applicable'
    })
    expect(written('tab1', { borderExternal: false })).toMatchObject({ borderExternal: false })
  })
})

describe('strokes, corners and nets on board drawings', () => {
  test('a drawing on copper reads its net, stroke style and color', () => {
    expect(record(board(), 'gr1')).toMatchObject({
      net: 'GND',
      strokeType: 'dash',
      strokeColor: '#ff0000'
    })
  })

  test('a rectangle takes a corner radius, and a stroke back to its defaults', () => {
    const after = written('gr1', { radius: 0.5, strokeType: 'default', strokeColor: null })
    expect(after).toMatchObject({ radius: 0.5 })
    expect(after.strokeType).toBeUndefined()
    expect(after.strokeColor).toBeUndefined()
  })

  test('a net goes on copper only', () => {
    expect(written('gr1', { net: 'SIG' })).toMatchObject({ net: 'SIG' })
    const b = board()
    expect(updateItem(b, item(b, 'gl1'), { net: 'GND' })).toMatchObject({
      error: 'not-applicable'
    })
  })
})

describe('text formatting', () => {
  test('a text reads and writes its font and switches, only what is not the default', () => {
    expect(record(board(), 't1').bold).toBeUndefined()
    expect(
      written('t1', {
        bold: true,
        italic: true,
        justify: 'left',
        verticalJustify: 'top',
        mirror: true,
        knockout: true,
        size: { width: 2, height: 1 }
      })
    ).toMatchObject({
      bold: true,
      italic: true,
      justify: 'left',
      verticalJustify: 'top',
      mirror: true,
      knockout: true,
      size: { width: 2, height: 1 }
    })
  })

  test('a new text takes its format with it', () => {
    const b = board()
    const outcome = createItem(
      b,
      'text',
      { text: 'REV', at: { x: 1, y: 1 }, layer: 'F.SilkS', italic: true },
      defaults
    )
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(record(outcome.board, outcome.ids[0])).toMatchObject({ italic: true })
  })

  test('a malformed justify is refused', () => {
    const b = board()
    expect(updateItem(b, item(b, 't1'), { justify: 'middle' })).toMatchObject({
      error: 'invalid-record'
    })
  })
})

describe('via types', () => {
  test('a blind via joins an outer layer to an inner one, and is written so', () => {
    const b = board()
    expect(updateItem(b, item(b, 'v1'), { type: 'blind' })).toMatchObject({
      error: 'invalid-record'
    })
    expect(written('v1', { type: 'blind', layers: ['In1.Cu', 'F.Cu'] })).toMatchObject({
      type: 'blind',
      layers: ['F.Cu', 'In1.Cu']
    })
  })

  test('each type keeps to its layer pair', () => {
    const b = board()
    const via = item(b, 'v1')
    expect(updateItem(b, via, { type: 'buried', layers: ['F.Cu', 'In1.Cu'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateItem(b, via, { type: 'blind', layers: ['In1.Cu', 'In2.Cu'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateItem(b, via, { type: 'micro', layers: ['F.Cu', 'B.Cu'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateItem(b, via, { layers: ['F.Cu', 'In1.Cu'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(written('v1', { type: 'buried', layers: ['In1.Cu', 'In2.Cu'] })).toMatchObject({
      type: 'buried'
    })
  })

  test('a via made through again spans the outer layers', () => {
    const b = board()
    const blind = updateItem(b, item(b, 'v1'), { type: 'blind', layers: ['F.Cu', 'In1.Cu'] })
    if (!blind.ok) throw new Error(blind.detail)
    const back = updateItem(blind.board, item(blind.board, 'v1'), { type: 'through' })
    if (!back.ok) throw new Error(back.detail)
    const after = record(parseKicadBoard(serializeKicadBoard(back.board)), 'v1')
    expect(after.type).toBeUndefined()
    expect(after.layers).toEqual(['F.Cu', 'B.Cu'])
  })

  test("a new microvia takes its net class's microvia size", () => {
    const b = board()
    const outcome = createItem(
      b,
      'via',
      { at: { x: 1, y: 1 }, net: 'GND', type: 'micro', layers: ['F.Cu', 'In1.Cu'] },
      defaults
    )
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(record(outcome.board, outcome.ids[0])).toMatchObject({
      type: 'micro',
      size: 0.3,
      drill: 0.1
    })
  })
})

describe('zone fill and islands', () => {
  test("islands below an area keep KiCad's 10 mm² until one is given", () => {
    expect(written('z1', { islands: 'below_area' })).toMatchObject({
      islands: 'below_area',
      minIslandArea: 10
    })
    expect(written('z1', { islands: 'below_area', minIslandArea: 4 })).toMatchObject({
      minIslandArea: 4
    })
    const b = board()
    expect(updateItem(b, item(b, 'z1'), { minIslandArea: 4 })).toMatchObject({
      error: 'not-applicable'
    })
  })

  test('a hatched pour reads its web, gap and turn', () => {
    expect(record(board(), 'z1')).toMatchObject({ fillMode: 'solid', hatchStyle: 'edge' })
    expect(
      written('z1', { fillMode: 'hatch', hatchGap: 2, hatchOrientation: 45, hatchStyle: 'full' })
    ).toMatchObject({ fillMode: 'hatch', hatchGap: 2, hatchOrientation: 45, hatchStyle: 'full' })
    const b = board()
    expect(updateItem(b, item(b, 'z1'), { hatchGap: 2 })).toMatchObject({
      error: 'not-applicable'
    })
  })
})

describe("a placed part's own names", () => {
  test('a footprint no symbol owns takes a new reference and value, and its id follows', () => {
    const b = board()
    const outcome = updateItem(b, item(b, 'H1'), { reference: 'H9', value: 'M3' })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.id).toBe('H9')
    expect(record(parseKicadBoard(serializeKicadBoard(outcome.board)), 'H9')).toMatchObject({
      reference: 'H9',
      value: 'M3'
    })
  })

  test("a symbol's part keeps the schematic's names, on the record and on its fields", () => {
    const b = board()
    expect(updateItem(b, item(b, 'R1'), { value: '22k' })).toMatchObject({ error: 'refused' })
    expect(updateBoardField(b, boardField(b, 'R1#Value')!, { value: '22k' })).toMatchObject({
      error: 'refused'
    })
  })

  test('a reference another part has is refused', () => {
    const b = board()
    expect(updateItem(b, item(b, 'H1'), { reference: 'R1' })).toMatchObject({
      error: 'reference-taken'
    })
  })
})
