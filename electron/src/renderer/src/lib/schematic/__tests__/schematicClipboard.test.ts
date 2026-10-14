import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  getSymbolProperty,
  parseKicadSchematic,
  referenceForSheetPath,
  serializeKicadSchematic,
  type KicadSchematic
} from '../../kicad/schematic'
import {
  findChild,
  getAtomValues,
  getToken,
  serializeSExpr,
  type SExprList
} from '../../kicad/sexpr'
import { nm } from '../../kicad/coordinates'
import {
  anchorPoints,
  copySchematicSelection,
  insertPaste,
  itemRefsForUuids,
  nearestAnchor,
  parseClipboard,
  pasteUuids,
  placePaste,
  preparePaste,
  refreshUuids,
  relativeSheetPath,
  serializeClipboard,
  sheetNamesOf,
  topLeftAnchor,
  uniqueSheetName,
  type PasteTarget,
  type SchematicClipboardContent
} from '../schematicClipboard'
import { incrementString, repeatContent } from '../schematicRepeat'

const ROOT = '/root-uuid'

const RESISTOR = `(symbol "Device:R" (pin_numbers hide) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`

/** The same part drawn differently — a pasted definition that must not overwrite the sheet's. */
const RESISTOR_WIDE = RESISTOR.replace(
  '(start -1.016 -2.54) (end 1.016 2.54)',
  '(start -2 -2.54) (end 2 2.54)'
)

const symbol = (
  reference: string,
  x: number,
  y: number,
  extra: { unit?: number; libId?: string; uuid?: string; path?: string } = {}
): string => {
  const unit = extra.unit ?? 1
  return `(symbol (lib_id "${extra.libId ?? 'Device:R'}") (at ${x} ${y} 0) (unit ${unit})
    (in_bom yes) (on_board yes) (dnp no)
    (uuid "${extra.uuid ?? `sym-${reference}-${unit}`}")
    (property "Reference" "${reference}" (at ${x + 2} ${y} 90) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at ${x - 2} ${y} 90) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "pin1-${reference}-${unit}"))
    (pin "2" (uuid "pin2-${reference}-${unit}"))
    (instances (project "demo" (path "${extra.path ?? ROOT}" (reference "${reference}") (unit ${unit})))))`
}

const sheetDoc = (body: string, libSymbols = RESISTOR): KicadSchematic =>
  parseKicadSchematic(`(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols ${libSymbols})
  ${body}
  (sheet_instances (path "/" (page "1")))
)
`)

const BODY = `${symbol('R1', 100, 50)}
  (wire (pts (xy 100 46.19) (xy 100 40)) (stroke (width 0) (type default)) (uuid "wire-a"))
  (junction (at 100 40) (diameter 0) (color 0 0 0 0) (uuid "junction-a"))
  (label "D0" (at 100 40 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "label-a"))
  (global_label "BUS7" (shape input) (at 90 40 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "glabel-a"))
  (netclass_flag "" (length 2.54) (shape round) (at 80 40 0) (effects (font (size 1.27 1.27)))
    (uuid "flag-a")
    (property "Netclass" "Power3" (at 80 37 0) (effects (font (size 1.27 1.27)))))
  (sheet (at 150 30) (size 20 15) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0))
    (uuid "sheet-a")
    (property "Sheetname" "Power" (at 150 29 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "power.kicad_sch" (at 150 46 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "VIN" input (at 150 35 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid "sheet-pin-a"))
    (instances (project "demo" (path "${ROOT}" (page "2")))))`

const target = (sheet: KicadSchematic, over: Partial<PasteTarget> = {}): PasteTarget => {
  let n = 0
  return {
    sources: [{ schematic: sheet, sheetPath: ROOT, filePath: '/p/root.kicad_sch' }],
    instancePaths: [ROOT],
    project: 'demo',
    libSymbols: sheet.libSymbols,
    sheetNames: sheetNamesOf(sheet),
    newUuid: () => `fresh-${(n += 1)}`,
    ...over
  }
}

/** Serialized, whitespace folded, so a test reads the nesting and not the layout. */
const flat = (node: SExprList): string =>
  serializeSExpr(node).replace(/\s+\)/g, ')').replace(/\s+/g, ' ')

const tokens = (content: SchematicClipboardContent): string[] =>
  content.items.map((item) => getToken(item) ?? '')

const propertyOf = (node: SExprList, key: string): string | undefined => {
  for (const child of node.children) {
    if (child.type !== 'list' || getToken(child) !== 'property') continue
    const [name, value] = getAtomValues(child)
    if (name === key) return value
  }
  return undefined
}

const firstOf = (content: SchematicClipboardContent, token: string): SExprList => {
  const node = content.items.find((item) => getToken(item) === token)
  if (!node) throw new Error(`no ${token}`)
  return node
}

describe('copy', () => {
  const sheet = sheetDoc(BODY)

  test('writes KiCad clipboard text: the definitions, then the items, no file around them', () => {
    const content = copySchematicSelection(
      sheet,
      [
        { type: 'label', index: 0 },
        { type: 'symbol', index: 0 },
        { type: 'wire', index: 0 }
      ],
      ROOT
    )
    const text = serializeClipboard(content)
    expect(text.startsWith('(lib_symbols\n')).toBe(true)
    expect(text).not.toContain('kicad_sch')
    // The sheet's own order, not the selection's.
    expect(tokens(content)).toEqual(['symbol', 'wire', 'label'])
    expect(content.libSymbols.map((node) => getAtomValues(node)[0])).toEqual(['Device:R'])
  })

  test('reads back to the same text', () => {
    const text = serializeClipboard(
      copySchematicSelection(
        sheet,
        [
          { type: 'symbol', index: 0 },
          { type: 'junction', index: 0 }
        ],
        ROOT
      )
    )
    const parsed = parseClipboard(text)
    expect(parsed).not.toBeNull()
    expect(serializeClipboard(parsed!)).toBe(text)
  })

  test('names the symbol as this sheet instance does, with instance paths relative to it', () => {
    const reused = sheetDoc(
      symbol('R1', 100, 50).replace(
        `(path "${ROOT}" (reference "R1") (unit 1))`,
        `(path "${ROOT}/a" (reference "R7") (unit 1)) (path "${ROOT}/b" (reference "R9") (unit 1))`
      )
    )
    const content = copySchematicSelection(reused, [{ type: 'symbol', index: 0 }], `${ROOT}/b`)
    const node = content.items[0]
    expect(propertyOf(node, 'Reference')).toBe('R9')
    expect(flat(findChild(node, 'instances')!)).toContain('(path "" (reference "R9")')
    expect(flat(findChild(node, 'instances')!)).toContain(`(path "${ROOT}/a"`)
  })

  test('a field copies its symbol, and a sheet pin its sheet, once each', () => {
    const content = copySchematicSelection(
      sheet,
      [
        { type: 'field', index: 0, field: 'Reference' },
        { type: 'symbol', index: 0 },
        { type: 'sheet_pin', index: 0, pin: 0 }
      ],
      ROOT
    )
    expect(tokens(content)).toEqual(['symbol', 'sheet'])
  })

  test('relativeSheetPath is KiCad’s MakeRelativeTo', () => {
    expect(relativeSheetPath('/a/b', '/a/b')).toBe('')
    expect(relativeSheetPath('/a/b/c', '/a/b')).toBe('/c')
    expect(relativeSheetPath('/x/y', '/a')).toBe('/x/y')
  })
})

describe('parseClipboard', () => {
  test('takes one node, a node run, or a whole file', () => {
    expect(tokens(parseClipboard('(junction (at 1 2) (uuid "j"))')!)).toEqual(['junction'])
    expect(
      tokens(parseClipboard('(wire (pts (xy 0 0) (xy 1 0)))\n(no_connect (at 1 0))')!)
    ).toEqual(['wire', 'no_connect'])
    const file = parseClipboard(serializeKicadSchematic(sheetDoc(BODY)))!
    expect(tokens(file)).toEqual([
      'symbol',
      'wire',
      'junction',
      'label',
      'global_label',
      'netclass_flag',
      'sheet'
    ])
    expect(file.libSymbols).toHaveLength(1)
  })

  test('refuses what is not a schematic', () => {
    expect(parseClipboard('hello')).toBeNull()
    expect(parseClipboard('(footprint "R_0603" (layer "F.Cu"))')).toBeNull()
    expect(parseClipboard('(unbalanced')).toBeNull()
  })
})

describe('KiCad’s own clipboard', () => {
  // Captured from KiCad 10's eeschema: the power-supply fixture, Select All, Copy.
  const text = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/lib/schematic/__tests__/fixtures/kicad10_clipboard.txt'
    ),
    'utf8'
  )

  test('reads as the definitions and the items', () => {
    const content = parseClipboard(text)!
    expect(content.libSymbols.map((node) => getAtomValues(node)[0])).toEqual(['Device:R'])
    expect(tokens(content)).toEqual(['label', 'wire', 'symbol'])
    expect(serializeClipboard(content)).toBe(text)
  })

  test('pastes: its empty-path instance names the part, filed under this sheet', () => {
    const empty = sheetDoc('', '')
    const prepared = preparePaste(parseClipboard(text)!, target(empty))
    expect(prepared.libSymbols).toHaveLength(1)
    const node = firstOf(prepared, 'symbol')
    expect(propertyOf(node, 'Reference')).toBe('R1')
    expect(flat(findChild(node, 'instances')!)).toBe(
      `(instances (project "demo" (path "${ROOT}" (reference "R1") (unit 1))))`
    )
    const holding = sheetDoc(symbol('R1', 0, 0))
    const again = preparePaste(parseClipboard(text)!, target(holding))
    expect(propertyOf(firstOf(again, 'symbol'), 'Reference')).toBe('R2')
  })
})

describe('paste', () => {
  const sheet = sheetDoc(BODY)
  const everything = (): SchematicClipboardContent =>
    parseClipboard(serializeKicadSchematic(sheetDoc(BODY)))!

  test('every uuid is fresh — the items’, their pins’, a sheet pin’s', () => {
    const prepared = preparePaste(everything(), target(sheet))
    const text = prepared.items.map((item) => serializeSExpr(item)).join('\n')
    for (const old of ['sym-R1-1', 'pin1-R1-1', 'wire-a', 'junction-a', 'sheet-a', 'sheet-pin-a'])
      expect(text).not.toContain(old)
    expect(pasteUuids(prepared)).toHaveLength(prepared.items.length)
  })

  test('refreshUuids leaves instance paths alone', () => {
    const node = parseClipboard(symbol('R1', 0, 0))!.items[0]
    let n = 0
    refreshUuids(node, () => `u${(n += 1)}`)
    const text = flat(node)
    expect(text).toContain('(uuid "u1")')
    expect(text).toContain('(pin "2" (uuid "u3"))')
    expect(text).toContain(`(path "${ROOT}"`)
  })

  test('a reference someone else holds takes the next free number; a free one is kept', () => {
    const content = parseClipboard(
      [symbol('R1', 0, 0), symbol('R5', 10, 0), symbol('R?', 20, 0, { uuid: 'unannotated' })].join(
        '\n'
      )
    )!
    const prepared = preparePaste(content, target(sheet))
    const pasted = parseKicadSchematic(
      `(kicad_sch ${prepared.items.map((item) => serializeSExpr(item)).join(' ')})`
    )
    const references = pasted.symbols.map((s) => referenceForSheetPath(s, ROOT))
    expect(references).toEqual(['R2', 'R5', 'R3'])
    expect(pasted.symbols.map((s) => getSymbolProperty(s, 'Reference'))).toEqual(['R2', 'R5', 'R3'])
  })

  test('the units of one package stay one package', () => {
    const content = parseClipboard(
      [
        symbol('U1', 0, 0, { libId: 'Amp:Dual', unit: 1 }),
        symbol('U1', 20, 0, { libId: 'Amp:Dual', unit: 2 })
      ].join('\n')
    )!
    const design = sheetDoc(symbol('U1', 50, 50, { libId: 'Amp:Dual' }))
    const prepared = preparePaste(content, target(design))
    const text = prepared.items.map((item) => serializeSExpr(item)).join('\n')
    expect(text.match(/\(reference "U2"\)/g)).toHaveLength(2)
    expect(text).toContain('(unit 2)')
  })

  test('each symbol is filed under this sheet’s instance paths and project', () => {
    const content = parseClipboard(symbol('R1', 0, 0, { path: '/other-project-root' }))!
    const prepared = preparePaste(
      content,
      target(sheet, { instancePaths: [`${ROOT}/a`, `${ROOT}/b`] })
    )
    const instances = serializeSExpr(findChild(prepared.items[0], 'instances')!)
    expect(instances).toContain(`(path "${ROOT}/a"`)
    expect(instances).toContain(`(path "${ROOT}/b"`)
    expect(instances).toContain('(project "demo"')
    expect(instances).not.toContain('other-project-root')
  })

  test('carries a definition the sheet lacks', () => {
    const empty = sheetDoc('', '')
    const prepared = preparePaste(
      copySchematicSelection(sheet, [{ type: 'symbol', index: 0 }], ROOT),
      target(empty)
    )
    expect(prepared.libSymbols.map((node) => getAtomValues(node)[0])).toEqual(['Device:R'])
  })

  test('adds nothing for a definition the sheet already holds', () => {
    const prepared = preparePaste(
      copySchematicSelection(sheet, [{ type: 'symbol', index: 0 }], ROOT),
      target(sheet)
    )
    expect(prepared.libSymbols).toEqual([])
    expect(findChild(prepared.items[0], 'lib_name')).toBeNull()
  })

  test('a different definition by the same name is renamed, units and all, and the symbol points at it', () => {
    const elsewhere = sheetDoc(symbol('R1', 0, 0), RESISTOR_WIDE)
    const content = copySchematicSelection(elsewhere, [{ type: 'symbol', index: 0 }], ROOT)
    const prepared = preparePaste(content, target(sheet))
    expect(prepared.libSymbols).toHaveLength(1)
    const definition = serializeSExpr(prepared.libSymbols[0])
    expect(definition.startsWith('(symbol "R_1"')).toBe(true)
    expect(definition).toContain('(symbol "R_1_0_1"')
    expect(definition).toContain('(symbol "R_1_1_1"')
    expect(getAtomValues(findChild(prepared.items[0], 'lib_name')!)).toEqual(['R_1'])
    // KiCad's order: lib_name right after lib_id.
    expect(getToken(prepared.items[0].children[2])).toBe('lib_name')
  })

  test('a renamed copy already on the sheet is reused', () => {
    const renamed = RESISTOR_WIDE.replace('"Device:R"', '"R_1"')
      .replace('"R_0_1"', '"R_1_0_1"')
      .replace('"R_1_1"', '"R_1_1_1"')
    const holding = sheetDoc(symbol('R1', 0, 0), `${RESISTOR} ${renamed}`)
    const elsewhere = sheetDoc(symbol('R1', 0, 0), RESISTOR_WIDE)
    const prepared = preparePaste(
      copySchematicSelection(elsewhere, [{ type: 'symbol', index: 0 }], ROOT),
      target(holding)
    )
    expect(prepared.libSymbols).toEqual([])
    expect(getAtomValues(findChild(prepared.items[0], 'lib_name')!)).toEqual(['R_1'])
  })

  test('a sheet keeps its file, takes a free name and this sheet’s instance', () => {
    const prepared = preparePaste(
      copySchematicSelection(sheet, [{ type: 'sheet', index: 0 }], ROOT),
      target(sheet)
    )
    const node = prepared.items[0]
    expect(propertyOf(node, 'Sheetname')).toBe('Power1')
    expect(propertyOf(node, 'Sheetfile')).toBe('power.kicad_sch')
    expect(flat(findChild(node, 'instances')!)).toContain(`(path "${ROOT}" (page "3"))`)
  })

  test('uniqueSheetName follows KiCad', () => {
    expect(uniqueSheetName('Power', new Set())).toBe('Power')
    expect(uniqueSheetName('Power', new Set(['Power']))).toBe('Power1')
    expect(uniqueSheetName('Amp2', new Set(['Amp2', 'Amp3']))).toBe('Amp4')
  })

  test('inserting only adds nodes: the sheet as it was is untouched', () => {
    const destination = sheetDoc(BODY)
    const before = serializeKicadSchematic(destination)
    const elsewhere = sheetDoc(symbol('R1', 0, 0), RESISTOR_WIDE)
    const prepared = preparePaste(
      copySchematicSelection(elsewhere, [{ type: 'symbol', index: 0 }], ROOT),
      target(destination)
    )
    insertPaste(destination, prepared)
    const after = serializeKicadSchematic(destination)
    const reparsed = parseKicadSchematic(after)
    const uuids = new Set(pasteUuids(prepared))
    // Take the added nodes back out and the text is byte-for-byte what it was.
    reparsed._root.children = reparsed._root.children.filter((child) => {
      if (child.type !== 'list') return true
      const uuid = findChild(child, 'uuid')
      return !(uuid && uuids.has(getAtomValues(uuid)[0] ?? ''))
    })
    const lib = findChild(reparsed._root, 'lib_symbols')!
    lib.children = lib.children.filter(
      (child) => child.type !== 'list' || getAtomValues(child)[0] !== 'R_1'
    )
    expect(serializeKicadSchematic(reparsed)).toBe(before)
    expect(parseKicadSchematic(after).symbols).toHaveLength(2)
  })

  test('the floating move’s shift and turn land on the pasted nodes alone', () => {
    const prepared = preparePaste(
      copySchematicSelection(
        sheet,
        [
          { type: 'symbol', index: 0 },
          { type: 'wire', index: 0 },
          { type: 'sheet', index: 0 }
        ],
        ROOT
      ),
      target(sheet)
    )
    const shifted = placePaste(
      prepared,
      [],
      { x: nm(10_000_000), y: nm(5_000_000) },
      {
        sheetPath: ROOT,
        grid: nm(1_270_000)
      }
    )
    const moved = parseKicadSchematic(
      `(kicad_sch (lib_symbols ${RESISTOR}) ${shifted.items.map((item) => serializeSExpr(item)).join(' ')})`
    )
    expect(moved.symbols[0].position).toMatchObject({ x: 110_000_000, y: 55_000_000 })
    expect(moved.wires[0].points[1]).toEqual({ x: 110_000_000, y: 45_000_000 })
    expect(moved.sheets[0].position).toEqual({ x: 160_000_000, y: 35_000_000 })
    // Placing never touches what it was given.
    expect(pasteUuids(shifted)).toEqual(pasteUuids(prepared))

    const turned = placePaste(
      prepared,
      [{ op: 'rotateCCW', pivot: { x: nm(100_000_000), y: nm(50_000_000) } }],
      { x: nm(0), y: nm(0) },
      { sheetPath: ROOT, grid: nm(1_270_000) }
    )
    const turnedSheet = parseKicadSchematic(
      `(kicad_sch (lib_symbols ${RESISTOR}) ${turned.items.map((item) => serializeSExpr(item)).join(' ')})`
    )
    expect(turnedSheet.symbols[0].position.angle).toBe(90)
  })

  test('the pasted items are found again by uuid, junctions included', () => {
    const refs = itemRefsForUuids(sheet, ['junction-a', 'wire-a', 'sheet-a'])
    expect(refs).toEqual([
      { type: 'wire', index: 0 },
      { type: 'junction', index: 0 },
      { type: 'sheet', index: 0 }
    ])
  })

  test('hangs from the top-left point, or a duplicate from the one nearest the cursor', () => {
    const points = anchorPoints(sheet, [
      { type: 'symbol', index: 0 },
      { type: 'label', index: 0 },
      { type: 'netclass_flag', index: 0 }
    ])
    expect(topLeftAnchor(points)).toEqual({ x: 80_000_000, y: 40_000_000 })
    expect(nearestAnchor(points, { x: nm(99_000_000), y: nm(49_000_000) })).toEqual({
      x: 100_000_000,
      y: 50_000_000
    })
    expect(topLeftAnchor([])).toBeNull()
  })
})

describe('repeat', () => {
  test('incrementString is KiCad’s: the last number steps, its width and any suffix kept', () => {
    expect(incrementString('D0', 1)).toBe('D1')
    expect(incrementString('D9', 1)).toBe('D10')
    expect(incrementString('D07', 1)).toBe('D08')
    expect(incrementString('D09', 1)).toBe('D10')
    expect(incrementString('A1B', 1)).toBe('A2B')
    expect(incrementString('DATA12_N', 2)).toBe('DATA14_N')
    expect(incrementString('A12B3C', 1)).toBe('A12B4C')
    expect(incrementString('VCC', 1)).toBe('VCC')
    expect(incrementString('', 1)).toBe('')
    expect(incrementString('D0', -1)).toBeNull()
  })

  test('labels count on, a directive label’s net class too, and a symbol is unannotated', () => {
    const sheet = sheetDoc(BODY)
    const source = copySchematicSelection(
      sheet,
      [
        { type: 'label', index: 0 },
        { type: 'label', index: 1 },
        { type: 'netclass_flag', index: 0 },
        { type: 'symbol', index: 0 }
      ],
      ROOT
    )
    const next = repeatContent(source)
    expect(getAtomValues(firstOf(next, 'label'))[0]).toBe('D1')
    expect(getAtomValues(firstOf(next, 'global_label'))[0]).toBe('BUS8')
    expect(propertyOf(firstOf(next, 'netclass_flag'), 'Netclass')).toBe('Power4')
    const repeated = firstOf(next, 'symbol')
    expect(propertyOf(repeated, 'Reference')).toBe('R?')
    expect(findChild(repeated, 'instances')).toBeNull()
    // The source is not touched, so the next repeat counts from the copy.
    expect(getAtomValues(firstOf(source, 'label'))[0]).toBe('D0')

    const prepared = preparePaste(next, target(sheet))
    const pasted = parseKicadSchematic(
      `(kicad_sch ${prepared.items.map((item) => serializeSExpr(item)).join(' ')})`
    )
    expect(referenceForSheetPath(pasted.symbols[0], ROOT)).toBe('R2')
  })
})
