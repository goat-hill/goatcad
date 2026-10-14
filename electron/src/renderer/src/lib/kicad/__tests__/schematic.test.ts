import { describe, expect, test } from 'vitest'
import {
  addSchematicJunctionToAST,
  fieldPointThroughPose,
  setSchematicFieldsAutoplaced,
  setSchematicSymbolPoseInAST,
  addSchematicLabelToAST,
  labelHorizontalJustify,
  addSchematicNoConnectToAST,
  addSchematicSheetToAST,
  addSchematicSymbolToAST,
  addSchematicTextToAST,
  addSchematicWireToAST,
  ensureLibSymbolsInAST,
  getLibSymbolProperty,
  getSheetProperty,
  getSymbolProperty,
  libSymbolChain,
  libSymbolUnitPins,
  moveSchematicLabelInAST,
  moveSchematicPointItemInAST,
  moveSchematicSheetInAST,
  moveSchematicFieldInAST,
  moveSchematicSymbolInAST,
  resizeSchematicSheetInAST,
  addSheetPinToAST,
  removeSheetPinFromAST,
  setSheetPinFields,
  setSchematicPaper,
  sheetPinPoint,
  sheetSideOf,
  type KicadSheet,
  type KicadSchematic,
  moveSchematicWireInAST,
  parseKicadSchematic,
  referenceForSheetPath,
  removeSchematicItemsFromAST,
  resolveSymbolGeometry,
  type Point,
  type SymbolPartRef,
  serializeKicadSchematic,
  setSchematicSymbolFlag,
  setSchematicSymbolProperty,
  setSymbolInstanceReference,
  rotateSchematicSymbolInAST,
  mirrorSchematicSymbolInAST,
  updateSchematicWireInAST,
  updateSchematicJunctionInAST,
  setSchematicLabelText,
  setSchematicLabelShape,
  flattenLibSymbolChain,
  parseLibSymbol
} from '../schematic'
import { mmToNm, nm } from '../coordinates'

const schematicSource = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
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
  (junction (at 50.8 50.8) (diameter 0) (color 0 0 0 0) (uuid "junction-uuid"))
  (no_connect (at 50.8 63.5) (uuid "nc-uuid"))
  (wire (pts (xy 50.8 50.8) (xy 63.5 50.8))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (label "SIGNAL" (at 63.5 50.8 0)
    (effects (font (size 1.27 1.27)) (justify left bottom)))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0)
      (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 52.07 57.15 0)
      (effects (font (size 1.27 1.27))))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 50.8 55.88 0)
      (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (text "Section title\nsecond line"
    (at 40.64 45.72 90)
    (effects
      (font (face "KiCad Font") (size 1.524 1.27) (thickness 0.254) (bold yes))
      (justify right top))
    (uuid "text-uuid"))
  (sheet
    (at 76.2 63.5)
    (size 25.4 12.7)
    (stroke (width 0.1524) (type solid))
    (fill (color 0 0 0 0))
    (uuid "sheet-uuid")
    (property "Sheetname" "USB" (at 76.2 62.8 0)
      (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "usb.kicad_sch" (at 76.2 76.9 0)
      (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "D+" input (at 76.2 68.58 180)
      (effects (font (size 1.27 1.27)) (justify left))
      (uuid "sheet-pin-uuid")))
  (some_future_token (nested "preserve me"))
  (sheet_instances (path "/" (page "1")))
)`

describe('KiCad schematic domain model', () => {
  test('parses metadata, embedded symbols, placements, and connectivity graphics', () => {
    const schematic = parseKicadSchematic(schematicSource)
    expect(schematic.version).toBe(20231120)
    expect(schematic.generator).toBe('eeschema')
    expect(schematic.uuid).toBe('root-uuid')
    expect(schematic.libSymbols.has('Device:R')).toBe(true)
    expect(schematic.symbols).toHaveLength(1)
    expect(
      schematic.symbols[0].properties.find((property) => property.key === 'Footprint')?.hidden
    ).toBe(true)
    // Field positions are absolute sheet coordinates, not symbol-relative.
    expect(
      schematic.symbols[0].properties.find((property) => property.key === 'Value')
    ).toMatchObject({
      value: '10k',
      position: { x: 52_070_000, y: 57_150_000, angle: 0 },
      hidden: false
    })
    expect(schematic.wires[0].points).toEqual([
      { x: 50_800_000, y: 50_800_000 },
      { x: 63_500_000, y: 50_800_000 }
    ])
    expect(schematic.junctions).toMatchObject([{ x: 50_800_000, y: 50_800_000 }])
    expect(schematic.noConnects).toMatchObject([{ x: 50_800_000, y: 63_500_000 }])
    expect(schematic.labels[0].text).toBe('SIGNAL')
    expect(schematic.labels[0].effects.horizontalAlign).toBe('left')
    expect(schematic.labels[0].effects.verticalAlign).toBe('bottom')
    expect(schematic.texts).toHaveLength(1)
    expect(schematic.texts[0].text).toBe('Section title\nsecond line')
    expect(schematic.texts[0].effects).toMatchObject({
      face: 'KiCad Font',
      fontSize: { height: 1_524_000, width: 1_270_000 },
      thickness: 254_000,
      bold: true,
      horizontalAlign: 'right',
      verticalAlign: 'top'
    })
    expect(schematic.sheets).toHaveLength(1)
    expect(schematic.sheets[0].properties.map((property) => property.value)).toEqual([
      'USB',
      'usb.kicad_sch'
    ])
    expect(schematic.sheets[0].pins[0]).toMatchObject({ name: 'D+', electricalType: 'input' })
    expect(schematic._unknownNodes).toHaveLength(1)
  })

  test('resolves only common and selected-unit embedded symbol geometry', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const geometry = resolveSymbolGeometry(schematic, schematic.symbols[0])
    expect(geometry.graphics).toHaveLength(1)
    expect(geometry.graphics[0].graphic.type).toBe('rectangle')
    expect(geometry.pins.map(({ pin }) => pin.number)).toEqual(['1', '2'])
    expect(geometry.pinNameOffset).toBe(0)
    expect(geometry.pinNumbersHidden).toBe(false)
  })

  // A NAND drawn two ways — the De Morgan alternate. Style 0 is the body common
  // to both, so it draws whichever style is placed.
  describe('body styles', () => {
    const source = (placement: string): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (lib_symbols
    (symbol "Logic:NAND"
      (body_styles demorgan)
      (symbol "NAND_0_0"
        (polyline (pts (xy 0 0) (xy 1 0))
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "NAND_1_1"
        (rectangle (start -1 -2) (end 1 2)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin input line (at -3 1 0) (length 2)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))
      (symbol "NAND_1_2"
        (circle (center 0 0) (radius 2)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin input inverted (at -3 1 0) (length 2)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Logic:NAND") (at 10 10 0) (unit 1) ${placement}
    (uuid "u-nand")
    (property "Reference" "U1" (at 0 0 0) (effects (font (size 1.27 1.27)))))
)`

    const shapesOf = (placement: string): string[] => {
      const schematic = parseKicadSchematic(source(placement))
      return resolveSymbolGeometry(schematic, schematic.symbols[0]).graphics.map(
        ({ graphic }) => graphic.type
      )
    }

    test('an absent body_style draws the standard style', () => {
      const schematic = parseKicadSchematic(source(''))
      expect(schematic.symbols[0].bodyStyle).toBe(1)
      expect(shapesOf('')).toEqual(['line', 'rectangle'])
    })

    test('body_style 2 draws the alternate instead of the standard', () => {
      const schematic = parseKicadSchematic(source('(body_style 2)'))
      expect(schematic.symbols[0].bodyStyle).toBe(2)
      // The style-0 polyline stays; the rectangle is replaced by the circle.
      expect(shapesOf('(body_style 2)')).toEqual(['line', 'circle'])
    })

    // KiCad 10 renamed the token; files written before it still say `convert`.
    test('reads a pre-KiCad-10 (convert N) as the body style', () => {
      const schematic = parseKicadSchematic(source('(convert 2)'))
      expect(schematic.symbols[0].bodyStyle).toBe(2)
      expect(shapesOf('(convert 2)')).toEqual(['line', 'circle'])
    })

    test('the alternate carries its own pins', () => {
      const schematic = parseKicadSchematic(source('(body_style 2)'))
      const geometry = resolveSymbolGeometry(schematic, schematic.symbols[0])
      expect(geometry.pins.map(({ pin }) => pin.graphicStyle)).toEqual(['inverted'])
    })
  })

  // Provenance is what makes a part addressable at all: flattened, the only
  // nameable thing is the whole symbol, which is why nothing can highlight one
  // pin or move one body line. See ARCHITECTURE.md §3.7.
  describe('resolved part provenance', () => {
    // A dual part: shared body in unit 0, one pin per gate, and a derived
    // symbol inheriting the lot — the three cases where "where did this come
    // from" is not obvious from the flattened list.
    const dualSource = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (lib_symbols
    (symbol "Device:Dual"
      (symbol "Dual_0_1"
        (rectangle (start -1 -2) (end 1 2)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "Dual_1_1"
        (pin passive line (at 0 3 270) (length 1)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))
      (symbol "Dual_2_1"
        (pin passive line (at 0 -3 90) (length 1)
          (name "B" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "Device:DualDerived"
      (extends "Device:Dual"))
  )
  (symbol (lib_id "Device:Dual") (at 10 10 0) (unit 2)
    (uuid "u-dual")
    (property "Reference" "U1" (at 0 0 0) (effects (font (size 1.27 1.27)))))
  (symbol (lib_id "Device:DualDerived") (at 30 10 0) (unit 1)
    (uuid "u-derived")
    (property "Reference" "U2" (at 0 0 0) (effects (font (size 1.27 1.27)))))
)`

    test('names the unit a part came from, not the order it was drawn in', () => {
      const schematic = parseKicadSchematic(dualSource)
      const geometry = resolveSymbolGeometry(schematic, schematic.symbols[0])

      // Unit 2 is placed, so unit 1's pin must not appear at all — and the
      // common unit-0 body must.
      expect(geometry.graphics.map(({ part }) => part)).toEqual([
        { source: 'Device:Dual', depth: 0, unit: 0, style: 1, index: 0 }
      ])
      expect(geometry.pins.map(({ pin, part }) => [pin.number, part.unit])).toEqual([['2', 2]])
    })

    test('an inherited part is named against the parent that defines it', () => {
      const schematic = parseKicadSchematic(dualSource)
      const geometry = resolveSymbolGeometry(schematic, schematic.symbols[1])

      // The derived symbol draws the parent's body and owns none of it, so
      // every ref points at the parent's lib_id rather than the placed one.
      expect(geometry.graphics.every(({ part }) => part.source === 'Device:Dual')).toBe(true)
      expect(geometry.pins.every(({ part }) => part.source === 'Device:Dual')).toBe(true)
      expect(geometry.pins.map(({ pin }) => pin.number)).toEqual(['1'])
    })

    test('a ref identifies exactly one part', () => {
      const schematic = parseKicadSchematic(dualSource)
      const geometry = resolveSymbolGeometry(schematic, schematic.symbols[0])
      const key = ({ source, unit, style, index }: SymbolPartRef): string =>
        `${source}:${unit}:${style}:${index}`
      const keys = [
        ...geometry.graphics.map(({ part }) => key(part)),
        ...geometry.pins.map(({ part }) => key(part))
      ]
      expect(new Set(keys).size).toBe(keys.length)
    })

    test('indices count within a group, so a part keeps its name as units change', () => {
      const schematic = parseKicadSchematic(dualSource)
      const unitTwo = resolveSymbolGeometry(schematic, schematic.symbols[0])
      const placed = { ...schematic.symbols[0], unit: 1 }
      const unitOne = resolveSymbolGeometry(schematic, placed)

      // The shared body is index 0 of unit 0 whichever gate is on screen. Were
      // indices assigned across the flattened list, switching units would
      // renumber it — the drawing-order dependency the model forbids.
      const body = ({ graphics }: typeof unitOne): SymbolPartRef => graphics[0].part
      expect(body(unitOne)).toEqual(body(unitTwo))
      // And each gate's pin is index 0 of its own unit, not 0 and 1 of a run.
      expect(unitOne.pins[0].part.index).toBe(0)
      expect(unitTwo.pins[0].part.index).toBe(0)
    })
  })

  test('moves a symbol and its absolute properties while preserving unknown nodes', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const symbol = schematic.symbols[0]
    moveSchematicSymbolInAST(symbol, { x: 2_540_000, y: -1_270_000 } as Point)

    const serialized = serializeKicadSchematic(schematic)
    const reparsed = parseKicadSchematic(serialized)
    const moved = reparsed.symbols[0]
    expect(moved.position).toEqual({ x: 53_340_000, y: 54_610_000, angle: 0 })
    expect(moved.properties[0].position).toEqual({ x: 54_610_000, y: 53_340_000, angle: 0 })
    expect(getSymbolProperty(moved, 'Reference')).toBe('R1')
    expect(serialized).toContain('some_future_token')
    expect(serialized).toContain('preserve me')
  })

  // Dragging a Reference off a crowded body, without moving the part it names.
  // KiCad stores a field's (at) in absolute sheet space, so this is the same
  // write moving the symbol performs on every property — applied to just one.
  test('moves one field, leaving the symbol and its other fields put', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const symbol = schematic.symbols[0]
    const before = { ...symbol.position }
    const others = symbol.properties
      .filter((property) => property.key !== 'Reference')
      .map((property) => ({ key: property.key, position: { ...property.position } }))

    moveSchematicFieldInAST(symbol, 'Reference', { x: 2_540_000, y: -1_270_000 } as Point)

    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    const moved = reparsed.symbols[0]
    expect(moved.position).toEqual(before)
    const reference = moved.properties.find((property) => property.key === 'Reference')!
    expect(reference.position.x).toBe(54_610_000)
    expect(reference.position.y).toBe(53_340_000)
    for (const other of others) {
      const found = moved.properties.find((property) => property.key === other.key)!
      expect(found.position, other.key).toEqual(other.position)
    }
  })

  test('moving a field the symbol does not have changes nothing', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const before = serializeKicadSchematic(schematic)
    moveSchematicFieldInAST(schematic.symbols[0], 'Nonexistent', {
      x: 5_000_000,
      y: 5_000_000
    } as Point)
    expect(serializeKicadSchematic(schematic)).toBe(before)
  })

  test('rejects legacy mock text that is not a KiCad schematic document', () => {
    expect(() => parseKicadSchematic('R1 10k resistor')).toThrow('Expected a KiCad')
  })

  test('moves wires, labels, and point items with write-through round-trips', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const delta = { x: 2_540_000, y: -1_270_000 } as Point
    moveSchematicWireInAST(schematic.wires[0], delta)
    moveSchematicLabelInAST(schematic.labels[0], delta)
    moveSchematicPointItemInAST(schematic.junctions[0], delta)
    moveSchematicPointItemInAST(schematic.noConnects[0], delta)

    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    expect(reparsed.wires[0].points).toEqual([
      { x: 53_340_000, y: 49_530_000 },
      { x: 66_040_000, y: 49_530_000 }
    ])
    expect(reparsed.labels[0].position).toMatchObject({ x: 66_040_000, y: 49_530_000 })
    expect(reparsed.junctions[0]).toMatchObject({ x: 53_340_000, y: 49_530_000 })
    expect(reparsed.noConnects[0]).toMatchObject({ x: 53_340_000, y: 62_230_000 })
    // Angle-less (at x y) nodes must not grow an angle atom.
    expect(serializeKicadSchematic(schematic)).toMatch(/\(junction\s*\(at 53\.34 49\.53\)/)
  })

  test('removes items by type and index, preserving everything else', () => {
    const schematic = parseKicadSchematic(schematicSource)
    removeSchematicItemsFromAST(schematic, [
      { type: 'wire', index: 0 },
      { type: 'junction', index: 0 },
      { type: 'label', index: 0 }
    ])

    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    expect(reparsed.wires).toHaveLength(0)
    expect(reparsed.junctions).toHaveLength(0)
    expect(reparsed.labels).toHaveLength(0)
    expect(reparsed.symbols).toHaveLength(1)
    expect(reparsed.noConnects).toHaveLength(1)
    expect(reparsed._unknownNodes).toHaveLength(1)
  })

  test('parses placement flags with KiCad defaults when tokens are absent', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const symbol = schematic.symbols[0]
    expect(symbol.dnp).toBe(false)
    expect(symbol.inBom).toBe(true)
    expect(symbol.onBoard).toBe(true)
    expect(symbol.excludeFromSim).toBe(false)

    const flagged = parseKicadSchematic(
      schematicSource.replace('(in_bom yes)\n    (on_board yes)', '(dnp yes)\n    (in_bom no)')
    )
    expect(flagged.symbols[0].dnp).toBe(true)
    expect(flagged.symbols[0].inBom).toBe(false)
    expect(flagged.symbols[0].onBoard).toBe(true)
  })

  test('updates an existing property value in place and round-trips', () => {
    const schematic = parseKicadSchematic(schematicSource)
    setSchematicSymbolProperty(schematic.symbols[0], 'Value', '4.7k')

    const serialized = serializeKicadSchematic(schematic)
    const reparsed = parseKicadSchematic(serialized)
    expect(getSymbolProperty(reparsed.symbols[0], 'Value')).toBe('4.7k')
    expect(getSymbolProperty(reparsed.symbols[0], 'Reference')).toBe('R1')
    expect(serialized).toContain('"4.7k"')
    expect(serialized).toContain('some_future_token')
  })

  test('creates a missing property as hidden at the symbol position, before pins', () => {
    const schematic = parseKicadSchematic(schematicSource)
    setSchematicSymbolProperty(schematic.symbols[0], 'Datasheet', 'https://example.com/r.pdf')

    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    const symbol = reparsed.symbols[0]
    const datasheet = symbol.properties.find((property) => property.key === 'Datasheet')
    expect(datasheet?.value).toBe('https://example.com/r.pdf')
    expect(datasheet?.hidden).toBe(true)
    expect(datasheet?.position).toMatchObject({ x: 50_800_000, y: 55_880_000 })
    // Property block stays contiguous: new property serializes before the pins.
    const serialized = serializeKicadSchematic(schematic)
    expect(serialized.indexOf('"Datasheet"')).toBeLessThan(serialized.indexOf('(pin "1"'))
    expect(serialized.indexOf('"Datasheet"')).toBeGreaterThan(serialized.indexOf('"Footprint"'))
  })

  test('toggles existing flags and creates missing ones before the uuid', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const symbol = schematic.symbols[0]
    setSchematicSymbolFlag(symbol, 'in_bom', false)
    setSchematicSymbolFlag(symbol, 'dnp', true)
    expect(symbol.inBom).toBe(false)
    expect(symbol.dnp).toBe(true)

    const serialized = serializeKicadSchematic(schematic)
    const reparsed = parseKicadSchematic(serialized)
    expect(reparsed.symbols[0].inBom).toBe(false)
    expect(reparsed.symbols[0].dnp).toBe(true)
    expect(reparsed.symbols[0].onBoard).toBe(true)
    const placedSymbol = serialized.slice(serialized.indexOf('(lib_id "Device:R")'))
    expect(placedSymbol.indexOf('(dnp yes)')).toBeLessThan(
      placedSymbol.indexOf('(uuid "symbol-uuid")')
    )
    expect(serialized).toContain('(in_bom no)')
  })
})

const instanceSymbol = (paths: Array<[string, string]>): string => `
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (uuid "sym-1")
    (property "Reference" "${paths[0]?.[1] ?? '?'}" (at 52 54 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 52 57 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "pin-1"))
    (instances
      (project "canary"
${paths
  .map(([path, reference]) => `        (path "${path}" (reference "${reference}") (unit 1))`)
  .join('\n')}
      )))`

const withSymbol = (symbol: string): string =>
  `(kicad_sch (version 20231120) (uuid "root")\n${symbol}\n)`

describe('the page a sheet is drawn on', () => {
  const paperOf = (node: string): unknown =>
    parseKicadSchematic(`(kicad_sch (version 20231120) ${node} (lib_symbols))`).paper

  test('a standard size is landscape, as KiCad stores it', () => {
    expect(paperOf('(paper "A3")')).toEqual({
      size: 'A3',
      portrait: false,
      width: mmToNm(420),
      height: mmToNm(297)
    })
  })

  test('the portrait token swaps the two', () => {
    expect(paperOf('(paper "A4" portrait)')).toEqual({
      size: 'A4',
      portrait: true,
      width: mmToNm(210),
      height: mmToNm(297)
    })
  })

  test('a User page carries its own millimetres', () => {
    expect(paperOf('(paper "User" 200 150)')).toEqual({
      size: 'User',
      portrait: false,
      width: mmToNm(200),
      height: mmToNm(150)
    })
  })

  test('an inch page is read too', () => {
    expect(paperOf('(paper "USLetter")')).toEqual({
      size: 'USLetter',
      portrait: false,
      width: mmToNm(279.4),
      height: mmToNm(215.9)
    })
  })

  // A file from a newer KiCad than this parser must not come back with a page
  // this code invented: no page reads better than a wrong one.
  test('a name that is not a page is no page at all', () => {
    expect(paperOf('(paper "A9")')).toBeUndefined()
    expect(paperOf('')).toBeUndefined()
  })

  test('reading the page changes nothing in the file', () => {
    const written = serializeKicadSchematic(
      parseKicadSchematic('(kicad_sch (version 20231120) (paper "A3") (lib_symbols))')
    )
    expect(written).toContain('(paper "A3")')
    expect(serializeKicadSchematic(parseKicadSchematic(written))).toBe(written)
  })
})

describe('hierarchical sheet pins', () => {
  const SHEET = `(kicad_sch
	(version 20231120)
	(generator "goatcad")
	(uuid "root-uuid")
	(paper "A4")
	(lib_symbols)
	(sheet
		(at 100 100)
		(size 40 30)
		(stroke (width 0.1524) (type solid))
		(uuid "sheet-uuid")
		(property "Sheetname" "Block" (at 100 99.2 0) (effects (font (size 1.27 1.27))))
		(property "Sheetfile" "child.kicad_sch" (at 100 130.7 0) (effects (font (size 1.27 1.27)))))
	(sheet_instances (path "/" (page "1")))
)`
  const asMmPair = (point: { x: number; y: number }): [number, number] => [
    point.x / 1_000_000,
    point.y / 1_000_000
  ]
  const sheetOf = (source = SHEET): { doc: KicadSchematic; sheet: KicadSheet } => {
    const doc = parseKicadSchematic(source)
    return { doc, sheet: doc.sheets[0] }
  }

  // KiCad's own pairs: the angle names the edge's outward side and the
  // justification runs the glyph and name back into the box (canary.kicad_sch
  // writes a left-edge pin as `180` + `justify left`).
  test('a pin faces out of the edge it is on and reads into the box', () => {
    const { doc, sheet } = sheetOf()
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      addSheetPinToAST(sheet, {
        name: side.toUpperCase(),
        shape: 'input',
        position: sheetPinPoint(sheet, side, mmToNm(5)),
        side
      })
    }
    const written = parseKicadSchematic(serializeKicadSchematic(doc)).sheets[0]
    expect(
      written.pins.map((pin) => [pin.name, pin.position.angle, pin.effects.horizontalAlign])
    ).toEqual([
      ['LEFT', 180, 'left'],
      ['RIGHT', 0, 'right'],
      ['TOP', 90, 'right'],
      ['BOTTOM', 270, 'left']
    ])
  })

  test('a pin lands on its edge, on the grid, off the corners', () => {
    const { sheet } = sheetOf()
    expect(sheetPinPoint(sheet, 'left', mmToNm(5.08))).toEqual({
      x: mmToNm(100),
      y: mmToNm(105.08)
    })
    expect(sheetPinPoint(sheet, 'right', mmToNm(5))).toEqual({
      x: mmToNm(140),
      y: mmToNm(105.08)
    })
    // Past the far edge, and before the near one, both clamp inside.
    expect(sheetPinPoint(sheet, 'top', mmToNm(400)).x).toBe(mmToNm(100 + 35.56))
    expect(sheetPinPoint(sheet, 'bottom', mmToNm(0)).x).toBe(mmToNm(102.54))
  })

  test('sheetSideOf names the edge a pin sits on', () => {
    const { sheet } = sheetOf()
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(sheetSideOf(sheet, sheetPinPoint(sheet, side, mmToNm(7.62)))).toBe(side)
    }
  })

  test('a resize carries its pins along the edges they were on', () => {
    const { doc, sheet } = sheetOf()
    addSheetPinToAST(sheet, {
      name: 'VIN',
      shape: 'input',
      position: sheetPinPoint(sheet, 'left', mmToNm(5.08)),
      side: 'left'
    })
    addSheetPinToAST(sheet, {
      name: 'OUT',
      shape: 'output',
      position: sheetPinPoint(sheet, 'right', mmToNm(25.4)),
      side: 'right'
    })
    const reparsed = parseKicadSchematic(serializeKicadSchematic(doc))
    resizeSchematicSheetInAST(
      reparsed.sheets[0],
      { x: mmToNm(200), y: mmToNm(50) },
      {
        width: mmToNm(20),
        height: mmToNm(20)
      }
    )
    const after = parseKicadSchematic(serializeKicadSchematic(reparsed)).sheets[0]
    const at = Object.fromEntries(after.pins.map((pin) => [pin.name, pin.position]))
    // VIN keeps its 5.08 mm down the left edge; OUT was 25.4 mm down a 30 mm
    // edge and clamps into the 20 mm one rather than hanging off it.
    expect(at.VIN).toEqual({ x: mmToNm(200), y: mmToNm(55.08), angle: 180 })
    expect(at.OUT).toEqual({ x: mmToNm(220), y: mmToNm(65.24), angle: 0 })
  })

  // The sheet's parsed `pins` array does not exist until the document is
  // re-parsed, so a caller cannot add them afterwards — the writer takes them.
  test('a sheet is written with its pins, stacked down each edge', () => {
    const doc = parseKicadSchematic(
      '(kicad_sch (version 20231120) (uuid "root") (paper "A4") (lib_symbols))'
    )
    addSchematicSheetToAST(doc, {
      position: { x: mmToNm(100), y: mmToNm(100) },
      size: { width: mmToNm(50.8), height: mmToNm(25.4) },
      sheetName: 'Power',
      sheetFile: 'power.kicad_sch',
      pins: [
        { name: 'VBUS', shape: 'input', side: 'left' },
        { name: 'EN', shape: 'input', side: 'left' },
        { name: '+3V3', shape: 'output', side: 'right' }
      ]
    })
    const written = parseKicadSchematic(serializeKicadSchematic(doc)).sheets[0]
    expect(
      written.pins.map((pin) => [pin.name, asMmPair(pin.position), pin.position.angle])
    ).toEqual([
      ['VBUS', [100, 102.54], 180],
      ['EN', [100, 105.08], 180],
      ['+3V3', [150.8, 102.54], 0]
    ])
  })

  // Sheetname and Sheetfile are both anchored at the left corners, so a
  // bottom pin filled from the left ran its name through the file name.
  test('top and bottom pins fill inward from the right', () => {
    const doc = parseKicadSchematic(
      '(kicad_sch (version 20231120) (uuid "root") (paper "A4") (lib_symbols))'
    )
    addSchematicSheetToAST(doc, {
      position: { x: mmToNm(100), y: mmToNm(100) },
      size: { width: mmToNm(50.8), height: mmToNm(25.4) },
      sheetName: 'Power',
      sheetFile: 'power.kicad_sch',
      pins: [
        { name: 'GND', shape: 'passive', side: 'bottom' },
        { name: 'AGND', shape: 'passive', side: 'bottom' }
      ]
    })
    const written = parseKicadSchematic(serializeKicadSchematic(doc)).sheets[0]
    expect(written.pins.map((pin) => [pin.name, asMmPair(pin.position)])).toEqual([
      ['GND', [148.26, 125.4]],
      ['AGND', [145.72, 125.4]]
    ])
  })

  test('a pin can be renamed, reshaped and removed', () => {
    const { doc, sheet } = sheetOf()
    addSheetPinToAST(sheet, {
      name: 'OLD',
      shape: 'input',
      position: sheetPinPoint(sheet, 'left', mmToNm(5.08)),
      side: 'left'
    })
    let reparsed = parseKicadSchematic(serializeKicadSchematic(doc))
    setSheetPinFields(reparsed.sheets[0].pins[0], { name: 'NEW', shape: 'bidirectional' })
    reparsed = parseKicadSchematic(serializeKicadSchematic(reparsed))
    expect(reparsed.sheets[0].pins[0].name).toBe('NEW')
    expect(reparsed.sheets[0].pins[0].electricalType).toBe('bidirectional')
    removeSheetPinFromAST(reparsed.sheets[0], reparsed.sheets[0].pins[0])
    expect(parseKicadSchematic(serializeKicadSchematic(reparsed)).sheets[0].pins).toEqual([])
  })
})

describe('setting the page', () => {
  const paperOf = (doc: KicadSchematic): unknown =>
    parseKicadSchematic(serializeKicadSchematic(doc)).paper

  test('replaces the existing node, by name', () => {
    const doc = parseKicadSchematic('(kicad_sch (version 20231120) (paper "A4") (lib_symbols))')
    setSchematicPaper(doc, { size: 'A3' })
    expect(serializeKicadSchematic(doc)).toContain('(paper "A3")')
    expect(paperOf(doc)).toEqual({
      size: 'A3',
      portrait: false,
      width: mmToNm(420),
      height: mmToNm(297)
    })
  })

  test('writes the portrait token, and a User page with its millimetres', () => {
    const doc = parseKicadSchematic('(kicad_sch (version 20231120) (paper "A4") (lib_symbols))')
    setSchematicPaper(doc, { size: 'A3', portrait: true })
    expect(serializeKicadSchematic(doc)).toContain('(paper "A3" portrait)')
    setSchematicPaper(doc, { size: 'User', width: 200, height: 150 })
    expect(serializeKicadSchematic(doc)).toContain('(paper "User" 200 150)')
    expect(paperOf(doc)).toEqual({
      size: 'User',
      portrait: false,
      width: mmToNm(200),
      height: mmToNm(150)
    })
  })

  test('a file with no page gets one where KiCad keeps it', () => {
    const doc = parseKicadSchematic('(kicad_sch (version 20231120) (uuid "u") (lib_symbols))')
    setSchematicPaper(doc, { size: 'A3' })
    const written = serializeKicadSchematic(doc)
    expect(written.indexOf('(paper')).toBeGreaterThan(written.indexOf('(uuid'))
    expect(written.indexOf('(paper')).toBeLessThan(written.indexOf('(lib_symbols'))
  })
})

describe('KiCad schematic per-path instances', () => {
  test('parses the instances block into per-path references', () => {
    const schematic = parseKicadSchematic(
      withSymbol(
        instanceSymbol([
          ['/root/sheet-a', 'R8'],
          ['/root/sheet-b', 'R42']
        ])
      )
    )
    const symbol = schematic.symbols[0]
    expect(symbol.instances).toHaveLength(2)
    expect(referenceForSheetPath(symbol, '/root/sheet-a')).toBe('R8')
    expect(referenceForSheetPath(symbol, '/root/sheet-b')).toBe('R42')
  })

  test('falls back to the Reference property when no path matches', () => {
    const schematic = parseKicadSchematic(withSymbol(instanceSymbol([['/root/sheet-a', 'R8']])))
    expect(referenceForSheetPath(schematic.symbols[0], '/unknown')).toBe('R8')
  })

  test('edits only the targeted path and round-trips', () => {
    const schematic = parseKicadSchematic(
      withSymbol(
        instanceSymbol([
          ['/root/sheet-a', 'R8'],
          ['/root/sheet-b', 'R42']
        ])
      )
    )
    setSymbolInstanceReference(schematic.symbols[0], '/root/sheet-b', 'R99')
    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    const symbol = reparsed.symbols[0]
    expect(referenceForSheetPath(symbol, '/root/sheet-a')).toBe('R8')
    expect(referenceForSheetPath(symbol, '/root/sheet-b')).toBe('R99')
  })
})

describe('adding schematic items to the AST', () => {
  const roundTrip = (
    schematic: Parameters<typeof serializeKicadSchematic>[0]
  ): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(serializeKicadSchematic(schematic))

  test('adds a wire with fresh uuid, grouped next to existing wires', () => {
    const schematic = parseKicadSchematic(schematicSource)
    addSchematicWireToAST(schematic, [
      { x: 10_160_000, y: 10_160_000 },
      { x: 10_160_000, y: 20_320_000 },
      { x: 30_480_000, y: 20_320_000 }
    ] as Point[])
    const serialized = serializeKicadSchematic(schematic)
    const reparsed = parseKicadSchematic(serialized)
    // One node per segment: KiCad's parser reads a wire as exactly two points,
    // and a three-point node made the whole file unloadable.
    expect(reparsed.wires).toHaveLength(3)
    expect(reparsed.wires[1].points).toEqual([
      { x: 10_160_000, y: 10_160_000 },
      { x: 10_160_000, y: 20_320_000 }
    ])
    expect(reparsed.wires[2].points).toEqual([
      { x: 10_160_000, y: 20_320_000 },
      { x: 30_480_000, y: 20_320_000 }
    ])
    expect(reparsed.wires[1].uuid).toBeTruthy()
    expect(reparsed.wires[1].uuid).not.toBe(reparsed.wires[0].uuid)
    expect(reparsed.wires[2].uuid).not.toBe(reparsed.wires[1].uuid)
    // Grouped with its siblings: after the existing wire, before the labels.
    expect(serialized.indexOf('(xy 10.16 10.16)')).toBeGreaterThan(serialized.indexOf('wire-uuid'))
    expect(serialized.indexOf('(xy 10.16 10.16)')).toBeLessThan(serialized.indexOf('"SIGNAL"'))
  })

  test('rejects degenerate wires', () => {
    const schematic = parseKicadSchematic(schematicSource)
    addSchematicWireToAST(schematic, [{ x: 1_000_000, y: 1_000_000 }] as Point[])
    expect(roundTrip(schematic).wires).toHaveLength(1)
  })

  test('adds junctions and no-connects at points', () => {
    const schematic = parseKicadSchematic(schematicSource)
    addSchematicJunctionToAST(schematic, { x: 63_500_000, y: 50_800_000 } as Point)
    addSchematicNoConnectToAST(schematic, { x: 76_200_000, y: 50_800_000 } as Point)
    const reparsed = roundTrip(schematic)
    expect(reparsed.junctions).toMatchObject([
      { x: 50_800_000, y: 50_800_000 },
      { x: 63_500_000, y: 50_800_000 }
    ])
    expect(reparsed.noConnects).toMatchObject([
      { x: 50_800_000, y: 63_500_000 },
      { x: 76_200_000, y: 50_800_000 }
    ])
  })

  test('adds labels of each kind; only non-local kinds carry a shape', () => {
    const schematic = parseKicadSchematic(schematicSource)
    addSchematicLabelToAST(schematic, 'label', 'CLK', { x: 10_000_000, y: 10_000_000 } as Point)
    addSchematicLabelToAST(schematic, 'global_label', 'VBUS', {
      x: 20_000_000,
      y: 10_000_000
    } as Point)
    addSchematicLabelToAST(schematic, 'hierarchical_label', 'SDA', {
      x: nm(30_000_000),
      y: nm(10_000_000),
      angle: 180
    })
    const reparsed = roundTrip(schematic)
    const added = reparsed.labels.filter((label) => label.text !== 'SIGNAL')
    expect(added).toMatchObject([
      { type: 'label', text: 'CLK', position: { x: 10_000_000, y: 10_000_000, angle: 0 } },
      { type: 'global_label', text: 'VBUS', shape: 'input' },
      { type: 'hierarchical_label', text: 'SDA', position: { angle: 180 } }
    ])
    expect(added[0].shape).toBeUndefined()
    expect(added[0].effects.horizontalAlign).toBe('left')
    // KiCad's spin rule: a label facing left is right-justified, so its text
    // grows away from the anchor instead of back across the pin it sits on.
    expect(added[2].effects.horizontalAlign).toBe('right')
  })

  test('label justification follows KiCad spin styles per cardinal angle', () => {
    expect(labelHorizontalJustify(0)).toBe('left')
    expect(labelHorizontalJustify(90)).toBe('left')
    expect(labelHorizontalJustify(180)).toBe('right')
    expect(labelHorizontalJustify(270)).toBe('right')
    expect(labelHorizontalJustify(-90)).toBe('right')
    expect(labelHorizontalJustify(450)).toBe('left')
  })

  test('adds a child sheet with name/file properties, a fresh uuid, and instances', () => {
    const blank = parseKicadSchematic(
      '(kicad_sch (version 20231120) (generator "goatcad") (uuid "root-uuid") (lib_symbols) (sheet_instances (path "/" (page "1"))))'
    )
    addSchematicSheetToAST(blank, {
      position: { x: 50_800_000, y: 50_800_000 } as Point,
      size: { width: nm(25_400_000), height: nm(15_240_000) },
      sheetName: 'Power',
      sheetFile: 'power.kicad_sch',
      instances: [{ project: 'canary', path: '/root-uuid', page: '2' }]
    })
    const serialized = serializeKicadSchematic(blank)
    // First-of-kind sheet lands before sheet_instances (the document tail).
    expect(serialized.indexOf('(sheet ')).toBeLessThan(serialized.indexOf('(sheet_instances'))
    const reparsed = parseKicadSchematic(serialized)
    expect(reparsed.sheets).toHaveLength(1)
    const sheet = reparsed.sheets[0]
    expect(sheet.position).toMatchObject({ x: 50_800_000, y: 50_800_000 })
    expect(sheet.size).toEqual({ width: 25_400_000, height: 15_240_000 })
    expect(getSheetProperty(sheet, 'Sheetname')).toBe('Power')
    expect(getSheetProperty(sheet, 'Sheetfile')).toBe('power.kicad_sch')
    expect(sheet.uuid).toBeTruthy()
    expect(serialized).toContain('(path "/root-uuid"')
    expect(serialized).toContain('(page "2")')
  })

  test('a child sheet without instances still round-trips', () => {
    const blank = parseKicadSchematic(
      '(kicad_sch (version 20231120) (generator "goatcad") (uuid "u") (lib_symbols) (sheet_instances (path "/" (page "1"))))'
    )
    addSchematicSheetToAST(blank, {
      position: { x: 10_000_000, y: 10_000_000 } as Point,
      size: { width: nm(20_000_000), height: nm(12_000_000) },
      sheetName: 'Sub',
      sheetFile: 'sub.kicad_sch'
    })
    const reparsed = parseKicadSchematic(serializeKicadSchematic(blank))
    expect(reparsed.sheets).toHaveLength(1)
    expect(getSheetProperty(reparsed.sheets[0], 'Sheetfile')).toBe('sub.kicad_sch')
  })

  /** A one-sheet schematic for the move/resize/delete cases. */
  const withSheet = (): ReturnType<typeof parseKicadSchematic> => {
    const doc = parseKicadSchematic(
      '(kicad_sch (version 20231120) (generator "goatcad") (uuid "u") (lib_symbols) (sheet_instances (path "/" (page "1"))))'
    )
    addSchematicSheetToAST(doc, {
      position: { x: 50_000_000, y: 50_000_000 } as Point,
      size: { width: nm(25_400_000), height: nm(15_240_000) },
      sheetName: 'Power',
      sheetFile: 'power.kicad_sch'
    })
    return parseKicadSchematic(serializeKicadSchematic(doc))
  }

  test('moves a sheet box and both fields by the delta', () => {
    const schematic = withSheet()
    moveSchematicSheetInAST(schematic.sheets[0], { x: 5_000_000, y: -2_540_000 } as Point)
    const sheet = parseKicadSchematic(serializeKicadSchematic(schematic)).sheets[0]
    expect(sheet.position).toMatchObject({ x: 55_000_000, y: 47_460_000 })
    // Fields keep their offsets from the box (they moved with it).
    const namePos = sheet.properties.find((p) => p.key === 'Sheetname')?.position
    expect(namePos).toMatchObject({ x: 55_000_000 })
  })

  test('resizes a sheet: box, size, and re-anchored name/file fields', () => {
    const schematic = withSheet()
    resizeSchematicSheetInAST(schematic.sheets[0], { x: 40_000_000, y: 40_000_000 } as Point, {
      width: nm(50_000_000),
      height: nm(30_000_000)
    })
    const sheet = parseKicadSchematic(serializeKicadSchematic(schematic)).sheets[0]
    expect(sheet.position).toMatchObject({ x: 40_000_000, y: 40_000_000 })
    expect(sheet.size).toEqual({ width: 50_000_000, height: 30_000_000 })
    // Sheetname re-anchors above the top-left; Sheetfile below the bottom-left.
    expect(sheet.properties.find((p) => p.key === 'Sheetname')?.position).toMatchObject({
      x: 40_000_000,
      y: 40_000_000 - 712_800
    })
    expect(sheet.properties.find((p) => p.key === 'Sheetfile')?.position).toMatchObject({
      x: 40_000_000,
      y: 40_000_000 + 30_000_000 + 712_800
    })
  })

  test('deleting a sheet removes only its node (never the child file)', () => {
    const schematic = withSheet()
    const fileRef = getSheetProperty(schematic.sheets[0], 'Sheetfile')
    removeSchematicItemsFromAST(schematic, [{ type: 'sheet', index: 0 }])
    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    expect(reparsed.sheets).toHaveLength(0)
    // The helper touches the AST only; the referenced file is untouched on disk.
    expect(fileRef).toBe('power.kicad_sch')
  })

  test('adds free text and inserts a first-of-kind before sheet_instances', () => {
    const blank = parseKicadSchematic(
      '(kicad_sch (version 20231120) (generator "goatcad") (uuid "u") (lib_symbols) (sheet_instances (path "/" (page "1"))))'
    )
    addSchematicTextToAST(blank, 'hello "world"', { x: 5_000_000, y: 5_000_000 } as Point)
    const serialized = serializeKicadSchematic(blank)
    expect(serialized.indexOf('(text')).toBeLessThan(serialized.indexOf('(sheet_instances'))
    const reparsed = parseKicadSchematic(serialized)
    expect(reparsed.texts).toMatchObject([
      { text: 'hello "world"', position: { x: 5_000_000, y: 5_000_000, angle: 0 } }
    ])
  })
})

describe('placing symbols from lib definitions', () => {
  const powerSource = `(kicad_sch
  (version 20231120)
  (generator "goatcad")
  (uuid "power-sheet-uuid")
  (lib_symbols
    (symbol "power:GND"
      (power)
      (pin_names (offset 0))
      (property "Reference" "#PWR" (at 0 -6.35 0)
        (effects (font (size 1.27 1.27)) hide))
      (property "Value" "GND" (at 0 -3.81 0)
        (effects (font (size 1.27 1.27))))
      (property "ki_keywords" "global power" (at 0 0 0)
        (effects (font (size 1.27 1.27)) hide))
      (symbol "GND_0_1"
        (polyline (pts (xy -1.27 0) (xy 1.27 0))
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) hide
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
  )
  (sheet_instances (path "/" (page "1")))
)`

  test('adds a placed symbol with annotated reference, pins, and instances', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const definition = schematic.libSymbols.get('Device:R')
    expect(definition).toBeDefined()
    if (!definition) return
    const chain = libSymbolChain(definition, (name) => schematic.libSymbols.get(name))
    const pins = libSymbolUnitPins(chain)
    expect(pins.map((pin) => pin.number)).toEqual(['1', '2'])
    addSchematicSymbolToAST(
      schematic,
      definition,
      { x: nm(76_200_000), y: nm(76_200_000), angle: 90 },
      'R2',
      pins,
      [{ project: 'demo', path: '/root-uuid' }]
    )
    const serialized = serializeKicadSchematic(schematic)
    const reparsed = parseKicadSchematic(serialized)
    expect(reparsed.symbols).toHaveLength(2)
    const placed = reparsed.symbols[1]
    expect(placed.libId).toBe('Device:R')
    expect(placed.position).toEqual({ x: 76_200_000, y: 76_200_000, angle: 90 })
    expect(placed.uuid).toBeTruthy()
    expect(placed.inBom).toBe(true)
    expect(placed.dnp).toBe(false)
    expect(referenceForSheetPath(placed, '/root-uuid')).toBe('R2')
    expect(placed.instances).toMatchObject([
      { project: 'demo', path: '/root-uuid', reference: 'R2', unit: 1 }
    ])
    expect(serialized).toContain('(pin "1"')
    expect(serialized).toContain('(pin "2"')
  })

  test('copies lib properties to sheet space, skipping ki_* and renaming Reference', () => {
    const source = parseKicadSchematic(powerSource)
    const target = parseKicadSchematic(schematicSource)
    const definition = source.libSymbols.get('power:GND')
    expect(definition?.isPower).toBe(true)
    if (!definition) return
    const chain = libSymbolChain(definition, (name) => source.libSymbols.get(name))
    ensureLibSymbolsInAST(target, chain)
    addSchematicSymbolToAST(
      target,
      definition,
      { x: 100_000_000, y: 50_000_000 } as Point,
      '#PWR7',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/root-uuid' }]
    )
    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    expect(reparsed.libSymbols.has('power:GND')).toBe(true)
    const placed = reparsed.symbols[1]
    const keys = placed.properties.map((property) => property.key)
    expect(keys).toContain('Reference')
    expect(keys).toContain('Value')
    expect(keys).not.toContain('ki_keywords')
    const reference = placed.properties.find((property) => property.key === 'Reference')
    // Lib offset (0, -6.35) is y-up; sheet space is y-down: 50 - (-6.35).
    expect(reference).toMatchObject({
      value: '#PWR7',
      hidden: true,
      position: { x: 100_000_000, y: 56_350_000 }
    })
    expect(getSymbolProperty(placed, 'Value')).toBe('GND')
  })

  test('places a flipped symbol as a placed one flipped where it stands, its fields with it', () => {
    // Mirror in hand, then a click, is a click, then the mirror on the placed part.
    const source = parseKicadSchematic(powerSource)
    const definition = source.libSymbols.get('power:GND')
    if (!definition) throw new Error('no GND')
    const chain = libSymbolChain(definition, (name) => source.libSymbols.get(name))
    const place = (mirror?: 'x' | 'y'): KicadSchematic => {
      const doc = parseKicadSchematic(schematicSource)
      ensureLibSymbolsInAST(doc, chain)
      addSchematicSymbolToAST(
        doc,
        definition,
        { x: nm(100_000_000), y: nm(50_000_000), angle: 90, mirror },
        '#PWR7',
        libSymbolUnitPins(chain),
        [{ project: 'demo', path: '/root-uuid' }]
      )
      return parseKicadSchematic(serializeKicadSchematic(doc))
    }
    for (const mirror of ['x', 'y'] as const) {
      const inHand = place(mirror).symbols[1]
      const afterwards = place().symbols[1]
      setSchematicSymbolPoseInAST(afterwards, { position: afterwards.position, mirror })
      expect(inHand.mirror).toBe(mirror)
      expect(inHand.position).toEqual(afterwards.position)
      expect(inHand.properties.map((p) => p.position)).toEqual(
        afterwards.properties.map((p) => p.position)
      )
    }
  })

  test('writes field overrides onto the placement it inserts, not onto the last one', () => {
    // The trap this guards: `addSchematicSymbolToAST` inserts into the AST and
    // leaves `schematic.symbols` to be re-derived on the next reparse. A caller
    // that placed a symbol and then set fields on `symbols[symbols.length - 1]`
    // branded the PREVIOUS symbol with the new part's identity — on an empty
    // sheet it wrote nothing at all, and on a populated one it overwrote a
    // neighbour's Value and MPN. Only a live run caught it, so it is pinned here.
    const target = parseKicadSchematic(schematicSource)
    const definition = target.libSymbols.get('Device:R')
    if (!definition) throw new Error('fixture lost Device:R')
    const chain = libSymbolChain(definition, (name) => target.libSymbols.get(name))
    const existingValue = getSymbolProperty(target.symbols[0], 'Value')

    addSchematicSymbolToAST(
      target,
      definition,
      { x: 100_000_000, y: 50_000_000 } as Point,
      'R9',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/root-uuid' }],
      1,
      1,
      { Value: '4k7', MPN: 'RC0402FR-074K7L', Manufacturer: 'Yageo' }
    )

    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    // Identify by the instances block, which is where the reference really
    // lives: this fixture's lib definition carries no properties at all.
    const placed = reparsed.symbols.find((symbol) =>
      symbol.instances.some((instance) => instance.reference === 'R9')
    )
    expect(placed).toBeDefined()
    expect(getSymbolProperty(placed!, 'Value')).toBe('4k7')
    expect(getSymbolProperty(placed!, 'MPN')).toBe('RC0402FR-074K7L')
    expect(getSymbolProperty(placed!, 'Manufacturer')).toBe('Yageo')

    // The symbol that was already on the sheet keeps its own identity. Found by
    // uuid: the fixture's placement predates hierarchical instances, so it has
    // its reference as a property and no instances block at all.
    const neighbour = reparsed.symbols.find((symbol) => symbol.uuid === 'symbol-uuid')
    expect(neighbour).toBeDefined()
    expect(getSymbolProperty(neighbour!, 'Value')).toBe(existingValue)
    expect(getSymbolProperty(neighbour!, 'MPN')).toBeUndefined()
  })

  test('keeps appended fields inside the property block, before the pins', () => {
    // KiCad writes properties as one run ahead of the pins; a field emitted
    // after them round-trips but is not the file KiCad would have written.
    const target = parseKicadSchematic(schematicSource)
    const definition = target.libSymbols.get('Device:R')
    if (!definition) throw new Error('fixture lost Device:R')
    const chain = libSymbolChain(definition, (name) => target.libSymbols.get(name))
    addSchematicSymbolToAST(
      target,
      definition,
      { x: 100_000_000, y: 50_000_000 } as Point,
      'R9',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/root-uuid' }],
      1,
      1,
      { MPN: 'RC0402FR-074K7L' }
    )
    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    const placed = reparsed.symbols.find((symbol) =>
      symbol.instances.some((instance) => instance.reference === 'R9')
    )!
    const tokens = placed._node.children
      .filter((child) => child.type === 'list')
      .map((child) => (child.children[0] as { value?: string }).value)
    expect(tokens.lastIndexOf('property')).toBeLessThan(tokens.indexOf('pin'))
  })

  test('ensureLibSymbolsInAST skips definitions already present', () => {
    const schematic = parseKicadSchematic(schematicSource)
    const definition = schematic.libSymbols.get('Device:R')
    expect(definition).toBeDefined()
    if (!definition) return
    ensureLibSymbolsInAST(schematic, [definition])
    const reparsed = parseKicadSchematic(serializeKicadSchematic(schematic))
    expect(reparsed.libSymbols.size).toBe(1)
  })

  test('getLibSymbolProperty reads lib-level property values', () => {
    const source = parseKicadSchematic(powerSource)
    const definition = source.libSymbols.get('power:GND')
    expect(definition && getLibSymbolProperty(definition, 'Reference')).toBe('#PWR')
    expect(definition && getLibSymbolProperty(definition, 'Value')).toBe('GND')
    expect(definition && getLibSymbolProperty(definition, 'Missing')).toBeUndefined()
  })

  // The self-contained-file invariant that lets GoatCAD ignore sym-lib-table:
  // every placed instance must resolve to a definition cached in this file's own
  // (lib_symbols ...) block, including every `extends` parent in the chain. When
  // it holds, opening the design never consults a library table; a break renders
  // a ghost symbol (empty body/pins) here and identically in KiCad — the
  // `return empty()` miss branch in resolveSymbolGeometry.
  const danglingLibIds = (schematic: ReturnType<typeof parseKicadSchematic>): string[] => {
    const missing = new Set<string>()
    const visited = new Set<string>()
    const requireDefined = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)
      const definition = schematic.libSymbols.get(id)
      if (!definition) {
        missing.add(id)
        return
      }
      if (definition.extends) requireDefined(definition.extends)
    }
    for (const placed of schematic.symbols) requireDefined(placed.libId)
    return [...missing]
  }

  // A derived symbol whose parent lives only in a foreign library: placing it
  // must copy the whole extends chain, not just the leaf.
  const derivedLibSource = `(kicad_sch
  (version 20231120)
  (generator "goatcad")
  (uuid "derived-lib-uuid")
  (lib_symbols
    (symbol "Custom:BaseR"
      (pin_names (offset 0))
      (symbol "BaseR_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "BaseR_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "Custom:DerivedR"
      (extends "Custom:BaseR")
      (property "Value" "DerivedR" (at 0 0 0)
        (effects (font (size 1.27 1.27)))))
  )
  (sheet_instances (path "/" (page "1")))
)`

  test('placing a symbol from a foreign library leaves no dangling lib_id', () => {
    const source = parseKicadSchematic(powerSource)
    const target = parseKicadSchematic(schematicSource)
    const definition = source.libSymbols.get('power:GND')
    expect(definition).toBeDefined()
    if (!definition) return
    const chain = libSymbolChain(definition, (name) => source.libSymbols.get(name))
    ensureLibSymbolsInAST(target, chain)
    addSchematicSymbolToAST(
      target,
      definition,
      { x: 100_000_000, y: 50_000_000 } as Point,
      '#PWR7',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/root-uuid' }]
    )
    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    expect(reparsed.symbols).toHaveLength(2)
    expect(danglingLibIds(reparsed)).toEqual([])
  })

  test('placing a derived symbol caches it flat, the way KiCad writes a sheet', () => {
    const source = parseKicadSchematic(derivedLibSource)
    const target = parseKicadSchematic(schematicSource)
    const definition = source.libSymbols.get('Custom:DerivedR')
    expect(definition?.extends).toBe('Custom:BaseR')
    if (!definition) return
    const chain = libSymbolChain(definition, (name) => source.libSymbols.get(name))
    ensureLibSymbolsInAST(target, chain)
    addSchematicSymbolToAST(
      target,
      definition,
      { x: 120_000_000, y: 60_000_000 } as Point,
      'R9',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/root-uuid' }]
    )
    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    // KiCad never resolves `extends` inside a schematic's lib_symbols, so the
    // leaf must carry the parent's body and pins itself and the parent must
    // not be cached at all.
    const flat = reparsed.libSymbols.get('Custom:DerivedR')
    expect(flat?.extends).toBeUndefined()
    expect(reparsed.libSymbols.has('Custom:BaseR')).toBe(false)
    expect(flat && libSymbolUnitPins([flat]).map((pin) => pin.number)).toEqual(['1', '2'])
    expect(flat && getLibSymbolProperty(flat, 'Value')).toBe('DerivedR')
    expect(danglingLibIds(reparsed)).toEqual([])
    // Unit sub-symbols are renamed after the leaf; KiCad refuses the file otherwise.
    const text = serializeKicadSchematic(target)
    expect(text).toContain('(symbol "DerivedR_1_1"')
    expect(text).not.toContain('(symbol "BaseR_1_1"')
  })

  test("flattening applies fields the way KiCad's Flatten does", () => {
    const source = parseKicadSchematic(`(kicad_sch
  (version 20231120)
  (generator "goatcad")
  (uuid "flatten-uuid")
  (lib_symbols
    (symbol "Lib:Root"
      (property "Reference" "U" (at 0 0 0))
      (property "Value" "Root" (at 0 0 0))
      (property "Footprint" "Pkg:SOT" (at 0 0 0))
      (property "ki_keywords" "root words" (at 0 0 0))
      (symbol "Root_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "Lib:Mid"
      (extends "Lib:Root")
      (property "Value" "Mid" (at 0 0 0))
      (property "MPN" "MID-1" (at 0 0 0)))
    (symbol "Lib:Leaf"
      (extends "Lib:Mid")
      (property "Value" "Leaf" (at 0 0 0))
      (property "Footprint" "" (at 0 0 0))
      (property "ki_keywords" "leaf words" (at 0 0 0)))
  )
  (sheet_instances (path "/" (page "1")))
)`)
    const leaf = source.libSymbols.get('Lib:Leaf')!
    const chain = libSymbolChain(leaf, (name) => source.libSymbols.get(name))
    expect(chain.map((entry) => entry.name)).toEqual(['Lib:Leaf', 'Lib:Mid', 'Lib:Root'])
    const flat = parseLibSymbol(flattenLibSymbolChain(chain))
    expect(flat.name).toBe('Lib:Leaf')
    expect(flat.extends).toBeUndefined()
    expect(getLibSymbolProperty(flat, 'Value')).toBe('Leaf')
    // An empty mandatory field keeps the parent's; a non-mandatory one from the
    // middle of the chain survives; the leaf's keywords win.
    expect(getLibSymbolProperty(flat, 'Footprint')).toBe('Pkg:SOT')
    expect(getLibSymbolProperty(flat, 'MPN')).toBe('MID-1')
    expect(getLibSymbolProperty(flat, 'ki_keywords')).toBe('leaf words')
    expect(flat.variants.map((variant) => variant.pins.length)).toEqual([1])
  })

  test('a cached derived entry is replaced on the next placement, repairing the file', () => {
    const target = parseKicadSchematic(derivedLibSource)
    const definition = target.libSymbols.get('Custom:DerivedR')!
    expect(definition.extends).toBe('Custom:BaseR')
    const chain = libSymbolChain(definition, (name) => target.libSymbols.get(name))
    ensureLibSymbolsInAST(target, chain)
    const reparsed = parseKicadSchematic(serializeKicadSchematic(target))
    expect(reparsed.libSymbols.get('Custom:DerivedR')?.extends).toBeUndefined()
    expect(libSymbolUnitPins([reparsed.libSymbols.get('Custom:DerivedR')!])).toHaveLength(2)
  })

  test('danglingLibIds catches an instance whose definition is not cached', () => {
    // Guards the guard: an instance pointing at Device:C while only Device:R is
    // cached is the exact ghost-symbol state the placement path must prevent.
    const broken = parseKicadSchematic(schematicSource)
    broken.symbols[0] = { ...broken.symbols[0], libId: 'Device:C' }
    expect(danglingLibIds(broken)).toEqual(['Device:C'])
  })
})

describe('Phase 0 schematic gaps', () => {
  test('parses wire stroke type + junction diameter/color', () => {
    const sch = parseKicadSchematic(schematicSource)
    expect(sch.wires[0].strokeType).toBe('default')
    expect(sch.junctions[0].diameter).toBe(0)
    expect(sch.junctions[0].color).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  test('edits wire stroke width/type/color', () => {
    const sch = parseKicadSchematic(schematicSource)
    updateSchematicWireInAST(sch.wires[0], {
      width: nm(300_000),
      strokeType: 'dash',
      strokeColor: { r: 1, g: 2, b: 3, a: 1 }
    })
    const round = parseKicadSchematic(serializeKicadSchematic(sch))
    expect(round.wires[0].width).toBe(300_000)
    expect(round.wires[0].strokeType).toBe('dash')
    expect(round.wires[0].strokeColor).toEqual({ r: 1, g: 2, b: 3, a: 1 })
  })

  test('edits junction diameter + color', () => {
    const sch = parseKicadSchematic(schematicSource)
    updateSchematicJunctionInAST(sch.junctions[0], {
      diameter: nm(1_000_000),
      color: { r: 200, g: 0, b: 0, a: 1 }
    })
    const round = parseKicadSchematic(serializeKicadSchematic(sch))
    expect(round.junctions[0].diameter).toBe(1_000_000)
    expect(round.junctions[0].color).toEqual({ r: 200, g: 0, b: 0, a: 1 })
  })

  test('rotates + mirrors a placed symbol', () => {
    const sch = parseKicadSchematic(schematicSource)
    rotateSchematicSymbolInAST(sch.symbols[0], 90)
    mirrorSchematicSymbolInAST(sch.symbols[0], 'y')
    const round = parseKicadSchematic(serializeKicadSchematic(sch))
    expect(round.symbols[0].position.angle).toBe(90)
    expect(round.symbols[0].mirror).toBe('y')
    // clearing mirror drops the node
    mirrorSchematicSymbolInAST(round.symbols[0], undefined)
    const round2 = parseKicadSchematic(serializeKicadSchematic(round))
    expect(round2.symbols[0].mirror).toBeUndefined()
  })

  test('renames a label and sets its shape', () => {
    const sch = parseKicadSchematic(schematicSource)
    setSchematicLabelText(sch.labels[0], 'NEW_NET')
    setSchematicLabelShape(sch.labels[0], 'input')
    const round = parseKicadSchematic(serializeKicadSchematic(sch))
    expect(round.labels[0].text).toBe('NEW_NET')
    expect(round.labels[0].shape).toBe('input')
  })

  test('a wire width edit does not fabricate a color', () => {
    const sch = parseKicadSchematic(schematicSource)
    updateSchematicWireInAST(sch.wires[0], { width: nm(200_000) })
    const round = parseKicadSchematic(serializeKicadSchematic(sch))
    expect(round.wires[0].strokeColor).toBeUndefined()
  })
})

// The bitclock project's root schematic — the round-trip canary over a real
// KiCad-authored file, sibling of the board canary in board.test.ts: token
// identity against the raw file (the serializer canonicalizes whitespace by
// contract), byte identity over the canonical form. Absent in isolated
// checkouts.
import { readFileSync } from 'node:fs'
import { sexprTokens } from './sexprTokens'
import { CANARY_SCHEMATIC } from '../../__tests__/canaryFixture'

const CANARY = CANARY_SCHEMATIC

describe('canary schematic round-trip', () => {
  test('parse → serialize preserves every token of the KiCad-authored file', () => {
    const source = readFileSync(CANARY, 'utf8')
    const out = serializeKicadSchematic(parseKicadSchematic(source))
    expect(sexprTokens(out)).toStrictEqual(sexprTokens(source))
  })

  test('canonical form is a byte-identical fixpoint', () => {
    const source = readFileSync(CANARY, 'utf8')
    const canonical = serializeKicadSchematic(parseKicadSchematic(source))
    expect(serializeKicadSchematic(parseKicadSchematic(canonical))).toBe(canonical)
  })
})

describe('fields_autoplaced and a symbol pose', () => {
  const PLACED = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(uuid "root")
	(paper "A4")
	(lib_symbols)
	(symbol
		(lib_id "Device:D")
		(at 40.64 50.8 90)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(fields_autoplaced yes)
		(uuid "s")
		(property "Reference" "D1"
			(at 43.18 49.7839 90)
			(effects
				(font
					(size 1.27 1.27)
				)
				(justify right)
			)
		)
	)
	(sheet_instances
		(path "/"
			(page "1")
		)
	)
	(embedded_fonts no)
)
`

  test('reads the flag and clears it as KiCad writes a clear one: not at all', () => {
    const doc = parseKicadSchematic(PLACED)
    expect(doc.symbols[0].fieldsAutoplaced).toBe(true)
    setSchematicFieldsAutoplaced(doc.symbols[0], false)
    const cleared = serializeKicadSchematic(doc)
    expect(cleared).toBe(PLACED.replace('\t\t(fields_autoplaced yes)\n', ''))
    expect(parseKicadSchematic(cleared).symbols[0].fieldsAutoplaced).toBe(false)
  })

  test('sets it back where KiCad puts it, just before the uuid', () => {
    const doc = parseKicadSchematic(PLACED.replace('\t\t(fields_autoplaced yes)\n', ''))
    setSchematicFieldsAutoplaced(doc.symbols[0], true)
    expect(serializeKicadSchematic(doc)).toBe(PLACED)
  })

  test('a pose that changes nothing writes nothing', () => {
    const doc = parseKicadSchematic(PLACED)
    const symbol = doc.symbols[0]
    setSchematicSymbolPoseInAST(symbol, { position: { ...symbol.position }, mirror: undefined })
    expect(serializeKicadSchematic(doc)).toBe(PLACED)
  })

  test('a new mirror goes right after the position, where KiCad writes it', () => {
    const doc = parseKicadSchematic(PLACED)
    const symbol = doc.symbols[0]
    setSchematicSymbolPoseInAST(symbol, { position: { ...symbol.position }, mirror: 'x' })
    expect(serializeKicadSchematic(doc)).toContain(
      '(at 40.64 50.8 90)\n\t\t(mirror x)\n\t\t(unit 1)'
    )
  })

  test('a field point turns and flips with the body and back again', () => {
    const origin = { x: mmToNm(40.64), y: mmToNm(50.8) }
    const point = { x: mmToNm(43.18), y: mmToNm(49.53) }
    const poses = [0, 90, 180, 270].flatMap((angle) =>
      ([undefined, 'x', 'y'] as const).map((mirror) => ({
        position: { ...origin, angle },
        mirror
      }))
    )
    const start = { position: { ...origin, angle: 0 } }
    for (const pose of poses) {
      const there = fieldPointThroughPose(point, start, pose)
      expect(fieldPointThroughPose(there, pose, start)).toEqual(point)
    }
    // A quarter turn counter-clockwise carries a point right of the origin above it.
    expect(fieldPointThroughPose(point, start, poses[3])).toEqual({
      x: nm(origin.x - mmToNm(1.27)),
      y: nm(origin.y - mmToNm(2.54))
    })
  })
})
