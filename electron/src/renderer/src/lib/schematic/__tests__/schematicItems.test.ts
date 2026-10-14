import { describe, expect, test } from 'vitest'
import { findChild, serializeSExpr } from '../../kicad/sexpr'
import {
  addSchematicRectangleToAST,
  addSchematicTextToAST,
  parseKicadSchematic,
  removeSchematicNodesFromAST,
  serializeKicadSchematic,
  setSchematicLabelPlacement,
  setSchematicPropertyHidden,
  type KicadSchematic,
  type KicadTextEffects,
  type Point
} from '../../kicad/schematic'
import { buildSheetConnectivity } from '../connectivity'
import { mmToNm } from '../../kicad/coordinates'
import { schematicFieldDrawn, schematicFieldTextAngle } from '../../engine/schematicTextOrientation'
import {
  attachedToSymbol,
  autoplaceFields,
  fieldAngleForSheetAngle,
  fieldExtent,
  getItems,
  junctionsForRoutedWire,
  labelExtent,
  pinsAfterTransform,
  queryItems,
  resolveItem,
  routeWire,
  sheetItems,
  symbolBox,
  type ItemsInput
} from '../schematicItems'

/** A resistor at the origin of a small sheet, wired to a label, with a
 *  junction, a no-connect on its free pin, a note, and a child sheet. */
const SOURCE = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )
  (junction (at 63.5 52.07) (diameter 0) (color 0 0 0 0))
  (no_connect (at 50.8 59.69) (uuid "nc-uuid"))
  (wire (pts (xy 50.8 52.07) (xy 63.5 52.07))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (label "VBUS" (at 63.5 52.07 0)
    (effects (font (size 1.27 1.27)) (justify left bottom))
    (uuid "label-uuid"))
  (text "note" (at 80 80 0)
    (effects (font (size 1.27 1.27)) (justify left bottom))
    (uuid "text-uuid"))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "MPN" "RC0402FR-0710KL" (at 50.8 55.88 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (sheet (at 100 100) (size 20 10)
    (stroke (width 0.1524) (type solid))
    (uuid "sheet-uuid")
    (property "Sheetname" "Power" (at 100 99 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" "power.kicad_sch" (at 100 111 0) (effects (font (size 1.27 1.27))))
    (pin "VIN" input (at 100 105 180) (effects (font (size 1.27 1.27)))))
  (rectangle (start 30 30) (end 70 70)
    (stroke (width 0) (type default))
    (fill (type none))
    (uuid "rect-uuid"))
  (sheet_instances (path "/" (page "1")))
)`

const parsed = (): KicadSchematic => parseKicadSchematic(SOURCE)

const input = (schematic = parsed()): ItemsInput => ({
  schematic,
  connectivity: buildSheetConnectivity(schematic),
  sheetPath: '/'
})

describe('sheetItems', () => {
  test('lists every kind on the sheet with the id §4.1 gives it', () => {
    const ids = sheetItems(input()).map((item) => `${item.kind}:${item.id}`)
    expect(ids).toEqual([
      'symbol:R1',
      'field:R1#Reference',
      'field:R1#Value',
      'label:label-uuid',
      'wire:wire-uuid',
      'junction:junction@63.5,52.07',
      'no_connect:no_connect@50.8,59.69',
      'text:text-uuid',
      'rect:rect-uuid',
      'sheet:sheet-uuid',
      'sheet_pin:sheet-uuid#VIN'
    ])
  })

  test('a hidden field is not an item, and never a ki_ one', () => {
    const fields = sheetItems(input()).filter((item) => item.kind === 'field')
    expect(fields.map((field) => field.id)).not.toContain('R1#MPN')
  })

  test('says which net a label, wire and junction lie on', () => {
    const nets = Object.fromEntries(
      sheetItems(input())
        .filter((item) => item.net)
        .map((item) => [item.kind, item.net])
    )
    // With no child loaded, the sheet pin names its net, scoped to this sheet as KiCad does.
    expect(nets).toEqual({
      label: '/VBUS',
      wire: '/VBUS',
      junction: '/VBUS',
      sheet_pin: '/VIN'
    })
  })
})

describe('symbolBox', () => {
  test('spans the body and both ends of every pin, in sheet space', () => {
    const schematic = parsed()
    const box = symbolBox(schematic, schematic.symbols[0])
    // Body ±1.016 wide; pins reach ±3.81 tall; y is flipped into the sheet.
    expect(box.minX / 1e6).toBeCloseTo(50.8 - 1.016, 3)
    expect(box.maxX / 1e6).toBeCloseTo(50.8 + 1.016, 3)
    expect(box.minY / 1e6).toBeCloseTo(55.88 - 3.81, 3)
    expect(box.maxY / 1e6).toBeCloseTo(55.88 + 3.81, 3)
  })

  test('turns with the symbol', () => {
    const schematic = parsed()
    schematic.symbols[0].position.angle = 90
    const box = symbolBox(schematic, schematic.symbols[0])
    expect((box.maxX - box.minX) / 1e6).toBeCloseTo(7.62, 3)
    expect((box.maxY - box.minY) / 1e6).toBeCloseTo(2.032, 3)
  })
})

describe('labelExtent', () => {
  const effects = (justify: 'left' | 'right'): KicadTextEffects => ({
    fontSize: { height: mmToNm(1.27), width: mmToNm(1.27) },
    bold: false,
    italic: false,
    lineSpacing: 1,
    horizontalAlign: justify,
    verticalAlign: 'bottom' as const,
    hidden: false
  })
  const at = (angle: number): Point & { angle: number } => ({ x: mmToNm(10), y: mmToNm(10), angle })

  test('runs rightward from a 0° anchor and sits above the line', () => {
    const { box, extends: runs } = labelExtent({
      text: 'GND',
      position: at(0),
      effects: effects('left')
    })
    expect(runs).toBe('right')
    expect(box.minX).toBeGreaterThan(mmToNm(10))
    expect(box.maxY).toBeLessThan(mmToNm(10))
    expect(box.maxX - box.minX).toBeGreaterThan(mmToNm(2))
  })

  test('a right-justified label ends at its anchor: KiCad folds 180° to 0°', () => {
    const { box, extends: runs } = labelExtent({
      text: 'GND',
      position: at(180),
      effects: effects('right')
    })
    expect(runs).toBe('left')
    expect(box.maxX).toBeLessThan(mmToNm(10))
  })

  test('vertical text never reads downward; the justification picks the side', () => {
    const up = labelExtent({ text: 'GND', position: at(90), effects: effects('left') })
    const down = labelExtent({ text: 'GND', position: at(270), effects: effects('right') })
    expect(up.extends).toBe('up')
    expect(up.box.maxY).toBeLessThan(mmToNm(10))
    expect(down.extends).toBe('down')
    expect(down.box.minY).toBeGreaterThan(mmToNm(10))
    // Both sit to the left of the anchor line.
    expect(up.box.maxX).toBeLessThan(mmToNm(10))
    expect(down.box.maxX).toBeLessThan(mmToNm(10))
  })

  test('a longer name is a longer box', () => {
    const short = labelExtent({ text: 'EN', position: at(0), effects: effects('left') })
    const long = labelExtent({ text: 'SLIC_SCLK', position: at(0), effects: effects('left') })
    expect(long.box.maxX - long.box.minX).toBeGreaterThan(2 * (short.box.maxX - short.box.minX))
  })
})

describe('fieldExtent', () => {
  test('a left-aligned horizontal field starts at its anchor', () => {
    const schematic = parsed()
    const value = schematic.symbols[0].properties.find((p) => p.key === 'Value')!
    const box = fieldExtent(value)
    expect(box.minX).toBe(value.position.x)
    expect(box.maxX).toBeGreaterThan(value.position.x)
  })

  /** A field's angle is stored in the symbol's frame, so a resistor turned a
   *  quarter turn carries `angle 90` on a value that is drawn along the sheet.
   *  Boxing it from its own angle boxed it running up the sheet instead. */
  test('a field on a turned symbol is boxed as drawn, not as stored', () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    symbol.position.angle = 90
    const value = symbol.properties.find((p) => p.key === 'Value')!
    value.position.angle = 90
    const box = fieldExtent(value, symbol.position)
    // Its `justify left` is the symbol's frame: turned a quarter, it runs leftward
    // from the anchor, as `kicad-cli sch export svg` draws it.
    expect(box.maxX).toBe(value.position.x)
    expect(box.minX).toBeLessThan(value.position.x)
    // Wider than tall: "10k" reads left to right on the sheet.
    expect(box.maxX - box.minX).toBeGreaterThan(box.maxY - box.minY)
  })

  test('and one drawn up the sheet is taller than it is wide', () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    symbol.position.angle = 90
    const value = symbol.properties.find((p) => p.key === 'Value')!
    value.position.angle = 0
    const box = fieldExtent(value, symbol.position)
    expect(box.maxY - box.minY).toBeGreaterThan(box.maxX - box.minX)
  })

  test("a sheet's own text is boxed from its own angle", () => {
    const schematic = parsed()
    const text = schematic.texts[0]
    expect(
      fieldExtent({ value: text.text, position: text.position, effects: text.effects })
    ).toEqual(
      fieldExtent(
        { value: text.text, position: text.position, effects: text.effects },
        { angle: 0 }
      )
    )
  })
})

describe('field angles are sheet space on the record', () => {
  test('the record reports the drawn angle, whatever the symbol carries', () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    symbol.position.angle = 90
    symbol.properties.find((p) => p.key === 'Value')!.position.angle = 90
    const result = getItems(input(schematic), ['R1#Value'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0].angle).toBe(0)
    expect(result.items[0].reference).toBe('R1')
  })

  test('and what is written for a sheet angle reads back as that angle', () => {
    for (const symbolAngle of [0, 90, 180, 270]) {
      for (const wanted of [0, 90]) {
        const stored = fieldAngleForSheetAngle(wanted, symbolAngle)
        expect(schematicFieldTextAngle(stored, symbolAngle)).toBe(wanted)
      }
    }
  })
})

describe('getItems', () => {
  test('a symbol record carries every pin with its position, free side, net and what sits on it', () => {
    const result = getItems(input(), ['R1'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const symbol = result.items[0]
    expect(symbol.kind).toBe('symbol')
    expect(symbol.pins).toEqual([
      {
        id: 'R1.1',
        number: '1',
        name: '~',
        type: 'passive',
        at: { x: 50.8, y: 52.07 },
        free: 'up',
        net: '/VBUS',
        // The wire end on the pin, by the id items_delete takes — the exact
        // answer to "what is on this pin", where a nearness query matched a
        // label's text box and the wrong label was deleted.
        attached: ['wire-uuid']
      },
      {
        id: 'R1.2',
        number: '2',
        name: '~',
        type: 'passive',
        at: { x: 50.8, y: 59.69 },
        free: 'down',
        net: null,
        attached: ['no_connect@50.8,59.69']
      }
    ])
    expect(symbol.box).toEqual({ x: 49.784, y: 52.07, width: 2.032, height: 7.62 })
    const fields = symbol.fields as { id: string; hidden?: boolean; box?: unknown }[]
    expect(fields.map((field) => field.id)).toEqual(['R1#Reference', 'R1#Value', 'R1#MPN'])
    expect(fields[2].hidden).toBe(true)
    expect(fields[0].box).toBeDefined()
  })

  test('a label says how it runs; a sheet lists its pins; a no-connect names its pin', () => {
    const result = getItems(input(), ['label-uuid', 'sheet-uuid', 'no_connect@50.8,59.69'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [label, sheet, flag] = result.items
    expect(label).toMatchObject({
      kind: 'label',
      labelKind: 'local',
      text: 'VBUS',
      extends: 'right',
      net: '/VBUS'
    })
    expect(sheet).toMatchObject({
      kind: 'sheet',
      name: 'Power',
      file: 'power.kicad_sch',
      size: { width: 20, height: 10 }
    })
    expect((sheet.pins as unknown[]).length).toBe(1)
    expect(flag).toMatchObject({ kind: 'no_connect', pin: 'R1.2' })
  })

  test('a turned item answers its angle beside at, not inside it', () => {
    const result = getItems(input(), ['R1', 'label-uuid'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const record of result.items) {
      expect(Object.keys(record.at as object).sort()).toEqual(['x', 'y'])
      expect(typeof record.angle).toBe('number')
    }
  })

  test('answers a hidden field by the id the symbol record lists for it', () => {
    // Footprint is hidden on almost every part; its id must not be refused.
    const result = getItems(input(), ['R1#MPN'])
    expect(result).toEqual({
      ok: true,
      items: [
        {
          id: 'R1#MPN',
          kind: 'field',
          reference: 'R1',
          name: 'MPN',
          value: 'RC0402FR-0710KL',
          at: { x: 50.8, y: 55.88 },
          angle: 0,
          hidden: true
        }
      ]
    })
  })

  test('names the first id that is nothing, with the ids that look like it', () => {
    const result = getItems(input(), ['R1', 'r1#value'])
    expect(result).toEqual({ ok: false, missing: 'r1#value', candidates: ['R1#Value'] })
  })
})

describe('queryItems', () => {
  test('filters by kind and answers rows in reading order', () => {
    const result = queryItems(input(), { kind: 'field' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((item) => item.id)).toEqual(['R1#Reference', 'R1#Value'])
    expect(result.total).toBe(2)
  })

  test('finds what lies near a pin, by box distance', () => {
    const result = queryItems(input(), { near: { pin: 'R1.1' }, radius: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const kinds = result.rows.map((item) => `${item.kind}:${item.id}`)
    expect(kinds).toContain('wire:wire-uuid')
    expect(kinds).toContain('symbol:R1')
    expect(kinds).not.toContain('text:text-uuid')
  })

  test('finds a label anchored on the pin at any radius, though its text sits off it', () => {
    const schematic = parsed()
    setSchematicLabelPlacement(schematic.labels[0], { x: mmToNm(50.8), y: mmToNm(52.07) })
    const result = queryItems(input(schematic), { kind: 'label', near: { pin: 'R1.1' }, radius: 0 })
    expect(result.ok && result.rows.map((item) => item.id)).toEqual(['label-uuid'])
  })

  test('refuses a pin it cannot resolve rather than searching around nothing', () => {
    const result = queryItems(input(), { near: { pin: 'R9.1' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('pin-not-found')
    expect(result.candidates).toContain('R1')
  })

  test('takes a box in the millimetres describe prints', () => {
    const result = queryItems(input(), { box: { x: 95, y: 95, width: 30, height: 20 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((item) => item.id)).toEqual(['sheet-uuid', 'sheet-uuid#VIN'])
  })

  test('matches a net with or without its sheet-path slash, symbols by their pins', () => {
    for (const net of ['VBUS', '/VBUS']) {
      const result = queryItems(input(), { net })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.rows.map((item) => item.kind).sort()).toEqual([
        'junction',
        'label',
        'symbol',
        'wire'
      ])
    }
  })

  test('caps the answer and says so', () => {
    const result = queryItems(input(), { limit: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.length).toBe(2)
    expect(result.total).toBe(11)
    expect(result.truncated).toBe(true)
    expect(result.narrowings[0]).toMatchObject({ arg: 'kind' })
  })

  test('reads on from offset, in the same order', () => {
    const all = queryItems(input(), {})
    const second = queryItems(input(), { limit: 4, offset: 8 })
    if (!all.ok || !second.ok) throw new Error('query failed')
    expect(second.rows.map((row) => row.id)).toEqual(all.rows.slice(8).map((row) => row.id))
    expect([second.offset, second.truncated]).toEqual([8, false])
  })
})

describe('resolveItem', () => {
  test('names the same things sheetItems lists', () => {
    const schematic = parsed()
    const items = sheetItems(input(schematic))
    for (const item of items) {
      const resolved = resolveItem(input(schematic), item.id)
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(resolved.item.kind).toBe(item.kind)
    }
  })

  test('hands back the parsed object a write mutates', () => {
    const schematic = parsed()
    const field = resolveItem(input(schematic), 'R1#Value')
    expect(field.ok && field.item.kind === 'field' && field.item.property.value).toBe('10k')
    const flag = resolveItem(input(schematic), 'no_connect@50.8,59.69')
    expect(flag.ok && flag.item.kind === 'no_connect' && flag.item.index).toBe(0)
  })

  test('a # in the reference, the key or a positional owner does not break the id', () => {
    const variants = [
      // A power symbol's reference starts with `#`, and a field key may carry one.
      SOURCE.replace('"Reference" "R1"', '"Reference" "#FLG1"').replace('"MPN"', '"LCSC Part #"'),
      // A sheet with no uuid is addressed positionally, and that id holds a `#` too.
      SOURCE.replace('(uuid "sheet-uuid")', '')
    ]
    for (const source of variants) {
      const schematic = parseKicadSchematic(source)
      for (const item of sheetItems(input(schematic))) {
        const resolved = resolveItem(input(schematic), item.id)
        expect(resolved.ok && resolved.item.kind).toBe(item.kind)
      }
    }
    const flag = input(parseKicadSchematic(variants[0]))
    const value = resolveItem(flag, '#FLG1#Value')
    expect(value.ok && value.item.kind === 'field' && value.item.property.value).toBe('10k')
    const hashKey = resolveItem(flag, '#FLG1#LCSC Part #')
    expect(hashKey.ok && hashKey.item.kind === 'field' && hashKey.item.property.key).toBe(
      'LCSC Part #'
    )
  })

  test('a miss carries candidates', () => {
    const result = resolveItem(input(), 'R1#value')
    expect(result).toEqual({ ok: false, missing: 'R1#value', candidates: ['R1#Value'] })
  })
})

describe('attachedToSymbol', () => {
  test('finds the flag on a pin, and not a label that only shares the net', () => {
    const schematic = parsed()
    const attached = attachedToSymbol(schematic, '/', schematic.symbols[0])
    expect(attached.pins.map((pin) => pin.number)).toEqual(['1', '2'])
    // VBUS sits at the far end of the wire, not on the pin.
    expect(attached.labels).toEqual([])
    expect(attached.noConnects.map((entry) => entry.pin.number)).toEqual(['2'])
  })

  test('finds a label whose anchor is the pin', () => {
    const schematic = parsed()
    setSchematicLabelPlacement(schematic.labels[0], { x: mmToNm(50.8), y: mmToNm(52.07) })
    const attached = attachedToSymbol(schematic, '/', schematic.symbols[0])
    expect(attached.labels.map((entry) => [entry.label.text, entry.pin.number])).toEqual([
      ['VBUS', '1']
    ])
  })
})

describe('pinsAfterTransform', () => {
  test('predicts where pins land after a move and a turn, without moving anything', () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    const after = pinsAfterTransform(schematic, symbol, {
      at: { x: mmToNm(100), y: mmToNm(100) },
      angle: 90
    })
    // At 90° pin 1 (lib +y) swings to -x on the sheet.
    expect(after.get('1')).toEqual({
      position: { x: mmToNm(100 - 3.81), y: mmToNm(100) },
      labelAngle: 180
    })
    expect(after.get('2')).toEqual({
      position: { x: mmToNm(100 + 3.81), y: mmToNm(100) },
      labelAngle: 0
    })
    expect(symbol.position.x).toBe(mmToNm(50.8))
  })
})

describe('the write helpers round-trip through the file', () => {
  const roundTrip = (schematic: KicadSchematic): KicadSchematic =>
    parseKicadSchematic(serializeKicadSchematic(schematic))

  test('a rect is listed with its box, and one written reads back', () => {
    const schematic = parsed()
    const listed = sheetItems(input(schematic)).find((item) => item.kind === 'rect')!
    expect(listed.record()).toMatchObject({
      kind: 'rect',
      at: { x: 30, y: 30 },
      box: { x: 30, y: 30, width: 40, height: 40 }
    })
    addSchematicRectangleToAST(
      schematic,
      { x: mmToNm(80), y: mmToNm(80) },
      { x: mmToNm(90), y: mmToNm(95) }
    )
    const again = roundTrip(schematic)
    expect(again.shapes).toHaveLength(2)
    expect(again.shapes[1].end).toEqual({ x: mmToNm(90), y: mmToNm(95) })
    expect(again.shapes[1].uuid).toBeTruthy()
    expect(resolveItem(input(again), again.shapes[1].uuid!).ok).toBe(true)
  })

  test('a text takes a size and a weight, and keeps its newlines', () => {
    const schematic = parsed()
    addSchematicTextToAST(
      schematic,
      'TITLE\nsecond line',
      { x: mmToNm(10), y: mmToNm(10) },
      { size: mmToNm(2.5), bold: true }
    )
    const again = roundTrip(schematic)
    const made = again.texts[again.texts.length - 1]
    expect(made.text).toBe('TITLE\nsecond line')
    expect(made.effects.fontSize.height).toBe(mmToNm(2.5))
    expect(made.effects.bold).toBe(true)
  })

  test('setSchematicLabelPlacement rewrites the justification with the angle', () => {
    const schematic = parsed()
    setSchematicLabelPlacement(schematic.labels[0], { x: mmToNm(70), y: mmToNm(60), angle: 180 })
    const again = roundTrip(schematic)
    expect(again.labels[0].position).toEqual({ x: mmToNm(70), y: mmToNm(60), angle: 180 })
    expect(again.labels[0].effects.horizontalAlign).toBe('right')
    expect(again.labels[0].effects.verticalAlign).toBe('bottom')
  })

  test('setSchematicPropertyHidden hides and shows a field', () => {
    const schematic = parsed()
    const value = schematic.symbols[0].properties.find((p) => p.key === 'Value')!
    setSchematicPropertyHidden(value, true)
    expect(roundTrip(schematic).symbols[0].properties.find((p) => p.key === 'Value')!.hidden).toBe(
      true
    )
    // KiCad 10's spelling: on the field, before its effects, none inside them.
    const written = serializeSExpr(value._node)
    expect(written).toMatch(/\(hide yes\)\s*\(effects/)
    expect(serializeSExpr(findChild(value._node, 'effects')!)).not.toContain('hide')
    setSchematicPropertyHidden(value, false)
    expect(roundTrip(schematic).symbols[0].properties.find((p) => p.key === 'Value')!.hidden).toBe(
      false
    )
  })

  test('removeSchematicNodesFromAST takes a text, which the typed removal never could', () => {
    const schematic = parsed()
    removeSchematicNodesFromAST(schematic, [schematic.texts[0]._node, schematic.labels[0]._node])
    const again = roundTrip(schematic)
    expect(again.texts).toHaveLength(0)
    expect(again.labels).toHaveLength(0)
    expect(again.symbols).toHaveLength(1)
  })
})

describe('routeWire', () => {
  test('a straight run when the ends align, ending on the pins it names', () => {
    const result = routeWire(input(), { pin: 'R1.1' }, { x: 50.8, y: 40 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wire.points).toEqual([
      { x: mmToNm(50.8), y: mmToNm(52.07) },
      { x: mmToNm(50.8), y: mmToNm(40) }
    ])
    expect(result.wire.fromPin?.number).toBe('1')
  })

  test('one bend, leaving a vertical pin vertically first', () => {
    const result = routeWire(input(), { pin: 'R1.1' }, { x: 70, y: 40 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Pin 1's free side is up, so the first leg is vertical.
    expect(result.wire.points).toEqual([
      { x: mmToNm(50.8), y: mmToNm(52.07) },
      { x: mmToNm(50.8), y: mmToNm(40) },
      { x: mmToNm(70), y: mmToNm(40) }
    ])
  })

  test('two vertical pins facing each other get a Z, leaving both along their free sides', () => {
    // A second resistor below and to the right, so R1.2 (free down) faces R2.1 (free up).
    const schematic = parseKicadSchematic(
      SOURCE.replace(
        '(sheet_instances',
        `(symbol (lib_id "Device:R") (at 60.96 80 0) (unit 1) (uuid "r2")
           (property "Reference" "R2" (at 62 78 0))
           (property "Value" "1k" (at 62 82 0)))
         (sheet_instances`
      )
    )
    const result = routeWire(input(schematic), { pin: 'R1.2' }, { pin: 'R2.1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ys = result.wire.points.map((p) => p.y)
    expect(result.wire.points).toHaveLength(4)
    expect(result.wire.points[1].x).toBe(mmToNm(50.8))
    expect(result.wire.points[2].x).toBe(mmToNm(60.96))
    expect(ys[1]).toBe(ys[2])
    expect(ys[1]).toBeGreaterThan(mmToNm(59.69))
    expect(ys[1]).toBeLessThan(mmToNm(76.19))
  })

  test('the posture argument overrides the pin', () => {
    const result = routeWire(input(), { pin: 'R1.1' }, { x: 70, y: 40 }, 'hv')
    expect(result.ok && result.wire.points[1]).toEqual({ x: mmToNm(70), y: mmToNm(52.07) })
  })

  test('refuses a run through another symbol, naming it', () => {
    // Straight across R1's body from left to right.
    const result = routeWire(input(), { x: 40, y: 55.88 }, { x: 60, y: 55.88 })
    expect(result).toMatchObject({ ok: false, error: 'would-cross', candidates: ['R1'] })
  })

  test('refuses a run whose interior passes over another pin', () => {
    // Vertical through x = 50.8, from above pin 1 to below pin 2.
    const result = routeWire(input(), { x: 50.8, y: 40 }, { x: 50.8, y: 70 })
    expect(result).toMatchObject({ ok: false, error: 'would-cross' })
    // Far enough away not to cross the body, but landing on pin 2's point mid-run.
    const across = routeWire(input(), { x: 40, y: 59.69 }, { x: 60, y: 59.69 })
    expect(across).toMatchObject({ ok: false, error: 'would-touch-pin', candidates: ['R1.2'] })
  })

  test('refuses a bend whose corner sits on another pin', () => {
    // Horizontal-first from the left at pin 2's height, turning up at pin 2's x.
    const result = routeWire(input(), { x: 40, y: 59.69 }, { x: 50.8, y: 70 }, 'hv')
    expect(result).toMatchObject({ ok: false, error: 'would-touch-pin', candidates: ['R1.2'] })
  })

  test('refuses an end it cannot resolve', () => {
    const result = routeWire(input(), { pin: 'R9.1' }, { x: 0, y: 0 })
    expect(result).toMatchObject({ ok: false, error: 'pin-not-found' })
  })
})

describe('junctionsForRoutedWire', () => {
  test('a wire between two lone pins needs no dot', () => {
    const schematic = parsed()
    const points = [
      { x: mmToNm(50.8), y: mmToNm(59.69) },
      { x: mmToNm(50.8), y: mmToNm(70) }
    ]
    expect(junctionsForRoutedWire(input(schematic), points)).toEqual([])
  })

  test('a wire ending on the interior of another gets a dot there', () => {
    const points = [
      { x: mmToNm(57.15), y: mmToNm(52.07) },
      { x: mmToNm(57.15), y: mmToNm(45) }
    ]
    expect(junctionsForRoutedWire(input(), points)).toEqual([points[0]])
  })
})

describe('autoplaceFields', () => {
  test('puts the visible fields on the side with no pins, stacked', () => {
    const schematic = parsed()
    const placements = autoplaceFields(schematic, '/', schematic.symbols[0])
    // R1's pins are up and down; the first empty side in preference order is right.
    expect(placements.map((p) => p.property.key)).toEqual(['Reference', 'Value'])
    for (const placement of placements) {
      expect(placement.horizontal).toBe('left')
      expect(placement.at.x).toBeGreaterThan(mmToNm(50.8 + 1.016))
    }
    expect(placements[1].at.y - placements[0].at.y).toBe(mmToNm(2.54))
  })

  /** What the file stores is the symbol's frame: on a quarter-turned body a
   *  field reading along the sheet is stored at 90, and one running rightward
   *  from its anchor is stored `justify right`. */
  test("stores a quarter-turned symbol's fields in its frame", () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    symbol.position.angle = 90
    const placements = autoplaceFields(schematic, '/', symbol)
    expect(placements.length).toBeGreaterThan(0)
    for (const placement of placements) {
      expect(placement.angle).toBe(90)
      const drawn = schematicFieldDrawn(
        placement.angle,
        placement.horizontal,
        placement.vertical,
        symbol.position
      )
      expect(drawn.angle).toBe(0)
    }
  })

  test('and a half-turned one flips the stored justification', () => {
    const schematic = parsed()
    const symbol = schematic.symbols[0]
    symbol.position.angle = 180
    const placements = autoplaceFields(schematic, '/', symbol)
    // Pins still up and down: the fields go right, drawn left-justified,
    // which a half-turned symbol stores as right.
    for (const placement of placements) {
      expect(placement.angle).toBe(0)
      expect(placement.horizontal).toBe('right')
      expect(placement.at.x).toBeGreaterThan(mmToNm(50.8 + 1.016))
    }
  })

  test('leaves hidden fields alone', () => {
    const schematic = parsed()
    const keys = autoplaceFields(schematic, '/', schematic.symbols[0]).map((p) => p.property.key)
    expect(keys).not.toContain('MPN')
  })
})

describe('pruneUnusedLibSymbols', () => {
  const LIB = `(lib_symbols
    (symbol "Device:R" (property "Reference" "R" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "Device:R_Base" (property "Reference" "R" (at 0 0 0))
      (symbol "R_Base_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "Device:R_Derived" (extends "Device:R_Base"))
    (symbol "Device:C" (property "Reference" "C" (at 0 0 0))
      (symbol "C_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
  )`
  const placed = (libId: string, reference: string, x: number): string =>
    `(symbol (lib_id "${libId}") (at ${x} 50.8 0) (unit 1) (uuid "${reference}")
      (property "Reference" "${reference}" (at ${x} 50 0)))`
  const source = (...symbols: string[]): KicadSchematic =>
    parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "root") ${LIB} ${symbols.join(' ')})`
    )
  const namesAfterRemoving = (schematic: KicadSchematic, references: string[]): string[] => {
    const nodes = schematic.symbols
      .filter((symbol) => references.includes(symbol.uuid ?? ''))
      .map((symbol) => symbol._node)
    removeSchematicNodesFromAST(schematic, nodes)
    return [...parseKicadSchematic(serializeKicadSchematic(schematic)).libSymbols.keys()].sort()
  }

  test('removing the last instance drops its definition, as KiCad does on save', () => {
    const schematic = source(placed('Device:R', 'R1', 50), placed('Device:C', 'C1', 60))
    expect(namesAfterRemoving(schematic, ['R1'])).toEqual(['Device:C'])
    expect([...schematic.libSymbols.keys()].sort()).toEqual(['Device:C'])
  })

  test('a definition still placed stays', () => {
    const schematic = source(placed('Device:R', 'R1', 50), placed('Device:R', 'R2', 60))
    expect(namesAfterRemoving(schematic, ['R1'])).toEqual(['Device:R'])
  })

  test('a parent a kept definition extends stays with it', () => {
    const schematic = source(placed('Device:R_Derived', 'R1', 50), placed('Device:C', 'C1', 60))
    expect(namesAfterRemoving(schematic, ['C1'])).toEqual(['Device:R_Base', 'Device:R_Derived'])
  })

  test('removing something that is not a symbol leaves lib_symbols alone', () => {
    const schematic = source(placed('Device:R', 'R1', 50))
    removeSchematicNodesFromAST(schematic, [schematic.symbols[0]._node].slice(0, 0))
    expect(parseKicadSchematic(serializeKicadSchematic(schematic)).libSymbols.size).toBe(4)
  })
})
