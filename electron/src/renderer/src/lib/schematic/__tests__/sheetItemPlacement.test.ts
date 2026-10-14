import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseKicadSchematic,
  removeSchematicItemsFromAST,
  schematicItemExists,
  schematicItemsOf,
  serializeKicadSchematic,
  type KicadSchematic,
  type Point
} from '../../kicad/schematic'
import { mmToNm } from '../../kicad/coordinates'
import {
  placedSheetItem,
  sheetItemAt,
  sheetItemOrigin,
  SHEET_ITEM_TYPES,
  translation,
  turnedText,
  type SheetItemType
} from '../sheetItemPlacement'
import {
  applyTransform,
  planTransform,
  transformedItemCount,
  translateSchematicItems,
  type MoveItem
} from '../schematicMove'

const FIXTURE = resolve(
  process.cwd(),
  'src/renderer/src/lib/kicad/__tests__/fixtures/sheet_graphics.kicad_sch'
)
const GRAPHICS = readFileSync(FIXTURE, 'utf8')

/** A free text and a child sheet with a pin, written as KiCad 9 writes them. */
const SHEET = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(text "Hello"
\t\t(exclude_from_sim no)
\t\t(at 50.8 30.48 0)
\t\t(effects
\t\t\t(font
\t\t\t\t(size 1.27 1.27)
\t\t\t)
\t\t\t(justify left bottom)
\t\t)
\t\t(uuid "22222222-2222-2222-2222-222222222222")
\t)
\t(sheet
\t\t(at 101.6 50.8)
\t\t(size 25.4 20.32)
\t\t(exclude_from_sim no)
\t\t(in_bom yes)
\t\t(on_board yes)
\t\t(dnp no)
\t\t(stroke
\t\t\t(width 0.1524)
\t\t\t(type solid)
\t\t)
\t\t(fill
\t\t\t(color 0 0 0 0.0000)
\t\t)
\t\t(uuid "33333333-3333-3333-3333-333333333333")
\t\t(property "Sheetname" "Child"
\t\t\t(at 101.6 50.0884 0)
\t\t\t(effects
\t\t\t\t(font
\t\t\t\t\t(size 1.27 1.27)
\t\t\t\t)
\t\t\t\t(justify left bottom)
\t\t\t)
\t\t)
\t\t(property "Sheetfile" "child.kicad_sch"
\t\t\t(at 101.6 71.7046 0)
\t\t\t(effects
\t\t\t\t(font
\t\t\t\t\t(size 1.27 1.27)
\t\t\t\t)
\t\t\t\t(justify left top)
\t\t\t)
\t\t)
\t\t(pin "IN" input
\t\t\t(at 101.6 55.88 180)
\t\t\t(uuid "44444444-4444-4444-4444-444444444444")
\t\t\t(effects
\t\t\t\t(font
\t\t\t\t\t(size 1.27 1.27)
\t\t\t\t)
\t\t\t\t(justify left)
\t\t\t)
\t\t)
\t)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
\t(embedded_fonts no)
)
`

const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

/** The lines an edit changed, each as [before, after]; the count must hold. */
const changedLines = (before: string, after: string): Array<[string, string]> => {
  const a = before.split('\n')
  const b = after.split('\n')
  expect(b).toHaveLength(a.length)
  return a.flatMap((line, i): Array<[string, string]> => (line === b[i] ? [] : [[line, b[i]]]))
}

/** The line span a node occupies in its source. */
const lineSpan = (source: string, node: { start: number; end: number }): [number, number] => [
  source.slice(0, node.start).split('\n').length - 1,
  source.slice(0, node.end).split('\n').length - 1
]

const numbersOut = (line: string): string => line.replace(/-?\d+(\.\d+)?/g, '#')

describe('the fixtures round-trip before anything moves', () => {
  test.each([
    ['graphics', GRAPHICS],
    ['sheet', SHEET]
  ])('%s', (_, source) => {
    expect(serializeKicadSchematic(parseKicadSchematic(source))).toBe(source)
  })
})

describe('a move diffs to only the moved item’s coordinates', () => {
  test.each(SHEET_ITEM_TYPES.filter((type) => type !== 'text'))('%s', (type: SheetItemType) => {
    const doc = parseKicadSchematic(GRAPHICS)
    const entry = sheetItemAt(doc, type, 0)
    if (!entry) throw new Error(`no ${type} in the fixture`)
    const span = lineSpan(GRAPHICS, entry.item._node)
    const origin = sheetItemOrigin(entry)
    translateSchematicItems(doc, [{ type, index: 0 }], p(2.54, 1.27))
    const after = serializeKicadSchematic(doc)
    const changes = changedLines(GRAPHICS, after)
    expect(changes.length).toBeGreaterThan(0)
    const lines = GRAPHICS.split('\n')
    for (const [before, next] of changes) {
      const line = lines.indexOf(before)
      expect(line).toBeGreaterThanOrEqual(span[0])
      expect(line).toBeLessThanOrEqual(span[1])
      // Only numbers changed on the line.
      expect(numbersOut(next)).toBe(numbersOut(before))
    }
    // And the file reads back moved by exactly the delta.
    const moved = sheetItemAt(parseKicadSchematic(after), type, 0)
    const at = moved && sheetItemOrigin(moved)
    expect(at).toMatchObject({ x: origin!.x + mmToNm(2.54), y: origin!.y + mmToNm(1.27) })
  })

  test('a free text, and a sheet’s name field on its own', () => {
    const doc = parseKicadSchematic(SHEET)
    translateSchematicItems(
      doc,
      [
        { type: 'text', index: 0 },
        { type: 'sheet_field', index: 0, field: 'Sheetname' }
      ],
      p(2.54, 0)
    )
    expect(changedLines(SHEET, serializeKicadSchematic(doc))).toEqual([
      ['\t\t(at 50.8 30.48 0)', '\t\t(at 53.34 30.48 0)'],
      ['\t\t\t(at 101.6 50.0884 0)', '\t\t\t(at 104.14 50.0884 0)']
    ])
  })

  test('a field whose sheet moves too is carried once, by the sheet', () => {
    const doc = parseKicadSchematic(SHEET)
    translateSchematicItems(
      doc,
      [
        { type: 'sheet', index: 0 },
        { type: 'sheet_field', index: 0, field: 'Sheetname' },
        { type: 'sheet_pin', index: 0, pin: 0 }
      ],
      p(2.54, 0)
    )
    const back = parseKicadSchematic(serializeKicadSchematic(doc)).sheets[0]
    expect(back.properties[0].position.x).toBe(mmToNm(104.14))
    expect(back.pins[0].position).toMatchObject(p(104.14, 55.88))
  })
})

describe('a sheet pin slides along its sheet', () => {
  test('dragged down its edge, it stays on the edge at pin pitch', () => {
    const doc = parseKicadSchematic(SHEET)
    translateSchematicItems(doc, [{ type: 'sheet_pin', index: 0, pin: 0 }], p(-3, 5.3))
    const after = serializeKicadSchematic(doc)
    expect(changedLines(SHEET, after)).toEqual([
      ['\t\t\t(at 101.6 55.88 180)', '\t\t\t(at 101.6 60.96 180)']
    ])
  })

  test('dragged past a corner, it turns onto the next edge', () => {
    const doc = parseKicadSchematic(SHEET)
    // To the bottom edge, below the box.
    translateSchematicItems(doc, [{ type: 'sheet_pin', index: 0, pin: 0 }], p(10.16, 17))
    const pin = parseKicadSchematic(serializeKicadSchematic(doc)).sheets[0].pins[0]
    expect(pin.position).toEqual({ ...p(111.76, 71.12), angle: 270 })
    expect(pin.effects.horizontalAlign).toBe('left')
  })
})

describe('turning and flipping', () => {
  test("KiCad's text turns: upright, the anchor end flipping instead", () => {
    expect(turnedText(0, 'left', 'rotateCCW')).toEqual({ angle: 90, align: 'left' })
    expect(turnedText(0, 'left', 'rotateCW')).toEqual({ angle: 90, align: 'right' })
    expect(turnedText(90, 'left', 'rotateCCW')).toEqual({ angle: 0, align: 'right' })
    expect(turnedText(90, 'left', 'rotateCW')).toEqual({ angle: 0, align: 'left' })
    expect(turnedText(0, 'left', 'mirrorHorizontal')).toEqual({ angle: 0, align: 'right' })
    expect(turnedText(0, 'left', 'mirrorVertical')).toEqual({ angle: 0, align: 'left' })
    expect(turnedText(0, 'center', 'rotateCW')).toEqual({ angle: 90, align: 'center' })
  })

  test('a polyline turns about the middle of what is selected', () => {
    const doc = parseKicadSchematic(GRAPHICS)
    const items: MoveItem[] = [{ type: 'polyline', index: 0 }]
    const before = doc.polylines[0].graphic.points
    const plan = planTransform(doc, items, 'rotateCCW', mmToNm(1.27))
    if (!plan) throw new Error('no plan')
    applyTransform(doc, '/', plan)
    const after = parseKicadSchematic(serializeKicadSchematic(doc)).polylines[0].graphic.points
    // A quarter turn keeps the length of every segment.
    const length = (points: Point[]): number =>
      Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
    expect(length(after)).toBeCloseTo(length(before), 0)
    expect(after).not.toEqual(before)
  })

  test('a text turned in place turns about its anchor and flips its end', () => {
    const doc = parseKicadSchematic(SHEET)
    const plan = planTransform(doc, [{ type: 'text', index: 0 }], 'rotateCW', mmToNm(1.27))
    if (!plan) throw new Error('no plan')
    applyTransform(doc, '/', plan)
    const text = parseKicadSchematic(serializeKicadSchematic(doc)).texts[0]
    expect(text.position).toEqual({ ...p(50.8, 30.48), angle: 90 })
    expect(text.effects.horizontalAlign).toBe('right')
  })

  test('an image is carried by the shift but does not turn', () => {
    const doc = parseKicadSchematic(GRAPHICS)
    const entry = sheetItemAt(doc, 'image', 0)
    if (entry?.type !== 'image') throw new Error('no image')
    const turned = placedSheetItem(entry, {
      place: () => p(0, 0),
      shift: translation(p(1.27, 0)).shift,
      ops: ['rotateCCW']
    })
    expect(turned.type === 'image' && turned.item.position).toEqual({
      x: entry.item.position.x + mmToNm(1.27),
      y: entry.item.position.y
    })
  })

  test('a bus entry turns as a stub, its size following its far end', () => {
    const doc = parseKicadSchematic(GRAPHICS)
    const entry = sheetItemAt(doc, 'bus_entry', 0)
    if (!entry || entry.type !== 'bus_entry') throw new Error('no entry')
    const turned = placedSheetItem(entry, {
      place: (point) => ({ x: point.y, y: point.x }) as Point,
      shift: (point) => point,
      ops: ['mirrorHorizontal']
    })
    if (turned.type !== 'bus_entry') throw new Error('type')
    expect(turned.item.size).toEqual({
      width: entry.item.size.height,
      height: entry.item.size.width
    })
  })

  test('the undo label counts every selected item, a covered part once', () => {
    expect(
      transformedItemCount([
        { type: 'sheet', index: 0 },
        { type: 'sheet_pin', index: 0, pin: 0 },
        { type: 'text', index: 0 },
        { type: 'symbol', index: 2 },
        { type: 'field', index: 2, field: 'Reference' },
        { type: 'field', index: 3, field: 'Value' }
      ])
    ).toBe(4)
  })
})

describe('selection refs across an undo', () => {
  const doc: KicadSchematic = parseKicadSchematic(SHEET)

  test('fields and sheet parts survive while their owner has them', () => {
    expect(schematicItemExists(doc, { type: 'sheet', index: 0 })).toBe(true)
    expect(schematicItemExists(doc, { type: 'sheet', index: 1 })).toBe(false)
    expect(schematicItemExists(doc, { type: 'sheet_field', index: 0, field: 'Sheetfile' })).toBe(
      true
    )
    expect(schematicItemExists(doc, { type: 'sheet_field', index: 0, field: 'Nope' })).toBe(false)
    expect(schematicItemExists(doc, { type: 'sheet_pin', index: 0, pin: 0 })).toBe(true)
    expect(schematicItemExists(doc, { type: 'sheet_pin', index: 0, pin: 1 })).toBe(false)
    expect(schematicItemExists(doc, { type: 'text', index: 0 })).toBe(true)
    // A symbol's field needs the symbol; this sheet has none.
    expect(schematicItemExists(doc, { type: 'field', index: 0, field: 'Reference' })).toBe(false)
    expect(schematicItemExists(doc, { type: 'no_connect', index: 0 })).toBe(false)
    expect(schematicItemExists(doc, { type: 'whatever', index: 0 })).toBe(false)
  })

  test('every new kind is checked against its own array', () => {
    const graphics = parseKicadSchematic(GRAPHICS)
    for (const type of SHEET_ITEM_TYPES) {
      const length = schematicItemsOf(graphics, type).length
      expect(schematicItemExists(graphics, { type, index: length }), type).toBe(false)
      if (length)
        expect(schematicItemExists(graphics, { type, index: length - 1 }), type).toBe(true)
    }
  })
})

describe('deleting', () => {
  test('a sheet pin leaves its sheet; a field is not deleted', () => {
    const doc = parseKicadSchematic(SHEET)
    removeSchematicItemsFromAST(doc, [
      { type: 'sheet_pin', index: 0, pin: 0 },
      { type: 'sheet_field', index: 0 }
    ])
    const back = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(back.sheets[0].pins).toHaveLength(0)
    expect(back.sheets[0].properties).toHaveLength(2)
  })

  test('every new kind removes its own node', () => {
    for (const type of SHEET_ITEM_TYPES.filter((type) => type !== 'text')) {
      const doc = parseKicadSchematic(GRAPHICS)
      const count = schematicItemsOf(doc, type).length
      removeSchematicItemsFromAST(doc, [{ type, index: 0 }])
      expect(
        schematicItemsOf(parseKicadSchematic(serializeKicadSchematic(doc)), type)
      ).toHaveLength(count - 1)
    }
  })
})
