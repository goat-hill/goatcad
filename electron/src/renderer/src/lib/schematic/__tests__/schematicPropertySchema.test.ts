import { describe, expect, it } from 'vitest'
import { parseKicadSchematic, serializeKicadSchematic } from '../../kicad/schematic'
import {
  applySheetItemEdit,
  buildSchematicGroups,
  screenSheetEdits,
  sheetItemSelection,
  strokePatch,
  type SchematicContext,
  type ScreenSheet,
  type SelectionItem
} from '../schematicPropertySchema'
import { isMixed, type PropertyEditValue, type PropertyField } from '../../propertyTable'
import { mmToNm } from '../../kicad/coordinates'

const t = (key: string): string => key

const SCH = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "root") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (symbol "R_0_1") (symbol "R_1_1")))
  (junction (at 50 50) (diameter 0) (color 0 0 0 0) (uuid "j1"))
  (wire (pts (xy 50 50) (xy 63 50)) (stroke (width 0) (type default)) (uuid "w1"))
  (label "SIG" (at 63 50 0) (effects (font (size 1.27 1.27))))
  (symbol (lib_id "Device:R") (at 50 55 90) (unit 1) (dnp yes) (in_bom yes) (on_board yes)
    (uuid "s1")
    (property "Reference" "R1" (at 52 54 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 52 57 0) (effects (font (size 1.27 1.27)))))
)`

const sch = (): ReturnType<typeof parseKicadSchematic> => parseKicadSchematic(SCH)
const ctx = (s: ReturnType<typeof parseKicadSchematic>): SchematicContext => ({
  symbols: s.symbols,
  labels: s.labels,
  wires: s.wires,
  junctions: s.junctions,
  noConnects: s.noConnects,
  netName: 'SIG'
})
type Groups = ReturnType<typeof buildSchematicGroups>
const group = (g: Groups, type: string): Groups[number] | undefined =>
  g.find((x) => x.type === type)
const fieldValue = (g: Groups, type: string, key: string): unknown =>
  group(g, type)?.fields.find((f) => f.key === key)?.value

describe('buildSchematicGroups', () => {
  it('builds a symbol group with fields, flags, transform', () => {
    const s = sch()
    const groups = buildSchematicGroups([{ type: 'symbol', index: 0 }], t, ctx(s))
    expect(groups.map((g) => g.type)).toEqual(['symbol'])
    expect(fieldValue(groups, 'symbol', 'Reference')).toBe('R1')
    expect(fieldValue(groups, 'symbol', 'Value')).toBe('10k')
    expect(fieldValue(groups, 'symbol', 'rotation')).toBe(90)
    expect(fieldValue(groups, 'symbol', 'dnp')).toBe(true)
    expect(fieldValue(groups, 'symbol', 'excludeFromBom')).toBe(false) // in_bom yes → not excluded
  })

  it('lists a part’s own fields, and offers Edit fields on a lone part', () => {
    const s = parseKicadSchematic(
      SCH.replace(
        '(property "Value" "10k" (at 52 57 0) (effects (font (size 1.27 1.27)))))',
        `(property "Value" "10k" (at 52 57 0) (effects (font (size 1.27 1.27))))
    (property "Description" "" (at 52 57 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "MPN" "RC0603" (at 52 57 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "ki_fp_filters" "R_*" (at 52 57 0) (hide yes) (effects (font (size 1.27 1.27)))))`
      )
    )
    const groups = buildSchematicGroups([{ type: 'symbol', index: 0 }], t, ctx(s))
    const rows = group(groups, 'symbol')!.fields.filter((f) => f.key.startsWith('userField:'))
    expect(rows.map((f) => [f.key, f.label, f.value])).toEqual([['userField:MPN', 'MPN', 'RC0603']])
    expect(group(groups, 'symbol')?.actions?.map((a) => a.id)).toEqual(['editFields'])
  })

  it('builds a label group with text + shape (global/hier only)', () => {
    const s = sch()
    const groups = buildSchematicGroups([{ type: 'label', index: 0 }], t, ctx(s))
    expect(fieldValue(groups, 'label', 'text')).toBe('SIG')
    // a local `label` has no shape row
    expect(group(groups, 'label')?.fields.some((f) => f.key === 'shape')).toBe(false)
    expect(fieldValue(groups, 'label', 'net')).toBe('SIG')
  })

  it('builds wire + junction groups', () => {
    const s = sch()
    const wireGroups = buildSchematicGroups([{ type: 'wire', index: 0 }], t, ctx(s))
    expect(fieldValue(wireGroups, 'wire', 'width')).toBe(0)
    expect(fieldValue(wireGroups, 'wire', 'length')).toBe('13.000')
    const jGroups = buildSchematicGroups([{ type: 'junction', index: 0 }], t, ctx(s))
    expect(fieldValue(jGroups, 'junction', 'diameter')).toBe(0)
    expect(fieldValue(jGroups, 'junction', 'color')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('gives a selected type with no rows an empty group, not a blank panel', () => {
    const s = sch()
    const groups = buildSchematicGroups(
      [
        { type: 'unknown', index: 0 },
        { type: 'symbol', index: 0 }
      ],
      t,
      ctx(s)
    )
    expect(groups.map((g) => [g.type, g.fields.length])).toEqual([
      ['symbol', group(groups, 'symbol')!.fields.length],
      ['unknown', 0]
    ])
    // A field answers through its symbol's group: no placeholder for it.
    const field = buildSchematicGroups([{ type: 'field', index: 0 }], t, ctx(s))
    expect(field.map((g) => g.type)).toEqual(['symbol'])
  })

  it('is empty for no selection and MIXED-aware', () => {
    const s = sch()
    expect(buildSchematicGroups([], t, ctx(s))).toEqual([])
    expect(isMixed(undefined)).toBe(false)
  })
})

describe('the text, graphic, sheet, directive label and bus groups', () => {
  const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
  (text "Note" (at 20 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t1"))
  (text_box "Box" (at 30 30 0) (size 10 5) (margins 0.9525 0.9525 0.9525 0.9525)
    (stroke (width 0) (type solid)) (fill (type none))
    (effects (font (size 1.27 1.27)) (justify left top)) (uuid "tb1"))
  (rectangle (start 40 40) (end 50 50) (stroke (width 0) (type default)) (fill (type none)) (uuid "r1"))
  (circle (center 60 60) (radius 3) (stroke (width 0.2) (type dash)) (fill (type background)) (uuid "c1"))
  (rule_area (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra1")))
  (polyline (pts (xy 0 90) (xy 20 90)) (stroke (width 0) (type default)) (uuid "l1"))
  (bus (pts (xy 0 80) (xy 20 80)) (stroke (width 0) (type default)) (uuid "b1"))
  (netclass_flag "" (length 2.54) (shape round) (at 70 70 0)
    (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "n1")
    (property "Netclass" "Power" (at 71 67 0) (effects (font (size 1.27 1.27)) (justify left))))
  (sheet (at 100 50) (size 25.4 20.32) (stroke (width 0.15) (type solid)) (fill (color 0 0 0 0)) (uuid "s1")
    (property "Sheetname" "Child" (at 100 49.3 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "child.kicad_sch" (at 100 71.02 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "IN" input (at 100 55.08 180) (uuid "p1") (effects (font (size 1.27 1.27)) (justify left))))
  (sheet_instances (path "/" (page "1"))))`

  const doc = (): ReturnType<typeof parseKicadSchematic> => parseKicadSchematic(SOURCE)
  const withDoc = (s: ReturnType<typeof parseKicadSchematic>): SchematicContext => ({
    ...ctx(s),
    document: s
  })
  /** Apply one edit, then read the file back. */
  const edited = (
    items: SelectionItem[],
    group: string,
    key: string,
    value: PropertyEditValue
  ): ReturnType<typeof parseKicadSchematic> => {
    const s = doc()
    expect(applySheetItemEdit(sheetItemSelection(s, items), group, key, value)).toBe(true)
    return parseKicadSchematic(serializeKicadSchematic(s))
  }

  it('builds one group per kind, a sheet field showing its sheet', () => {
    const s = doc()
    const groups = buildSchematicGroups(
      [
        { type: 'text', index: 0 },
        { type: 'text_box', index: 0 },
        { type: 'shape', index: 0 },
        { type: 'circle', index: 0 },
        { type: 'sheet_field', index: 0, field: 'Sheetname' },
        { type: 'sheet_pin', index: 0, pin: 0 },
        { type: 'netclass_flag', index: 0 },
        { type: 'bus', index: 0 }
      ],
      t,
      withDoc(s)
    )
    // Free graphics take the symbol editor's own groups, one per primitive.
    expect(groups.map((g) => g.type)).toEqual([
      'text',
      'text_box',
      'rectangle',
      'circle',
      'sheet',
      'sheet_pin',
      'netclass_flag',
      'bus'
    ])
    expect(fieldValue(groups, 'rectangle', 'endX')).toBe(mmToNm(50))
    expect(fieldValue(groups, 'circle', 'strokeType')).toBe('dash')
    expect(fieldValue(groups, 'circle', 'fill')).toBe('background')
    expect(fieldValue(groups, 'circle', 'fillColor')).toBeNull()
    expect(fieldValue(groups, 'text', 'hAlign')).toBe('left')
    expect(fieldValue(groups, 'sheet', 'Sheetfile')).toBe('child.kicad_sch')
    expect(fieldValue(groups, 'sheet_pin', 'shape')).toBe('input')
    expect(fieldValue(groups, 'netclass_flag', 'field:Netclass')).toBe('Power')
  })

  it('writes text content, size, weight, justification and angle', () => {
    const text = [{ type: 'text', index: 0 }]
    expect(edited(text, 'text', 'text', 'Hello').texts[0].text).toBe('Hello')
    expect(edited(text, 'text', 'size', mmToNm(2)).texts[0].effects.fontSize).toEqual({
      height: mmToNm(2),
      width: mmToNm(2)
    })
    expect(edited(text, 'text', 'bold', true).texts[0].effects.bold).toBe(true)
    expect(edited(text, 'text', 'italic', true).texts[0].effects.italic).toBe(true)
    expect(edited(text, 'text', 'hAlign', 'right').texts[0].effects.horizontalAlign).toBe('right')
    expect(edited(text, 'text', 'angle', 90).texts[0].position.angle).toBe(90)
  })

  it('writes a text box’s text and angle', () => {
    const box = [{ type: 'text_box', index: 0 }]
    expect(edited(box, 'text_box', 'text', 'Hi').textBoxes[0].graphic.text).toBe('Hi')
    expect(edited(box, 'text_box', 'angle', 90).textBoxes[0].graphic.position.angle).toBe(90)
    expect(
      edited(box, 'text_box', 'vAlign', 'bottom').textBoxes[0].graphic.effects.verticalAlign
    ).toBe('bottom')
  })

  it('writes an outline’s geometry, stroke and fill, a rule area’s on its polyline', () => {
    const shape = [{ type: 'shape', index: 0 }]
    expect(edited(shape, 'rectangle', 'strokeWidth', mmToNm(0.5)).shapes[0].strokeWidth).toBe(
      mmToNm(0.5)
    )
    expect(edited(shape, 'rectangle', 'strokeType', 'dot').shapes[0].strokeType).toBe('dot')
    expect(edited(shape, 'rectangle', 'fill', 'background').shapes[0].fill).toBe('background')
    expect(edited(shape, 'rectangle', 'endX', mmToNm(55)).shapes[0].end.x).toBe(mmToNm(55))
    const red = { r: 255, g: 0, b: 0, a: 1 }
    expect(edited(shape, 'rectangle', 'strokeColor', red).shapes[0].strokeColor).toEqual(red)
    // A fill color takes a kind that paints with it, as KiCad's dialog does.
    const filled = edited(shape, 'rectangle', 'fillColor', red).shapes[0]
    expect(filled.fillColor).toEqual(red)
    expect(filled.fill).toBe('color')
    const area = edited([{ type: 'rule_area', index: 0 }], 'line', 'strokeType', 'solid')
    expect(area.ruleAreas[0].graphic.stroke.type).toBe('solid')
  })

  it('gives a two-point line a stroke color but no fill, as KiCad’s line dialog does', () => {
    const rows = (items: SelectionItem[]): string[] =>
      group(buildSchematicGroups(items, t, withDoc(doc())), 'line')?.fields.map((f) => f.key) ?? []
    const line = rows([{ type: 'polyline', index: 0 }])
    expect(line).toContain('strokeColor')
    expect(line).not.toContain('fill')
    expect(line).not.toContain('fillColor')
    expect(rows([{ type: 'rule_area', index: 0 }])).toContain('fill')
  })

  it('leaves a sheet text alone on a graphic edit of another kind', () => {
    const s = doc()
    const items = [{ type: 'shape', index: 0 }]
    applySheetItemEdit(sheetItemSelection(s, items), 'circle', 'strokeType', 'dot')
    const after = parseKicadSchematic(serializeKicadSchematic(s))
    expect(after.shapes[0].strokeType).toBe('default')
    expect(after.circles[0].graphic.stroke.type).toBe('dash')
  })

  it('writes a sheet’s name, file and size', () => {
    const sheet = [{ type: 'sheet', index: 0 }]
    const named = edited(sheet, 'sheet', 'Sheetname', 'Power')
    expect(named.sheets[0].properties[0].value).toBe('Power')
    expect(
      edited(sheet, 'sheet', 'Sheetfile', 'power.kicad_sch').sheets[0].properties[1].value
    ).toBe('power.kicad_sch')
    const wider = edited(sheet, 'sheet', 'width', mmToNm(30.48)).sheets[0]
    expect(wider.size).toEqual({ width: mmToNm(30.48), height: mmToNm(20.32) })
    expect(wider.position).toEqual({ x: mmToNm(100), y: mmToNm(50) })
  })

  it('writes a sheet pin’s name and shape', () => {
    const pin = [{ type: 'sheet_pin', index: 0, pin: 0 }]
    expect(edited(pin, 'sheet_pin', 'name', 'OUT').sheets[0].pins[0].name).toBe('OUT')
    expect(edited(pin, 'sheet_pin', 'shape', 'output').sheets[0].pins[0].electricalType).toBe(
      'output'
    )
  })

  it('writes a directive label’s shape and fields, and a bus’s width', () => {
    const flag = [{ type: 'netclass_flag', index: 0 }]
    expect(edited(flag, 'netclass_flag', 'shape', 'diamond').directiveLabels[0].shape).toBe(
      'diamond'
    )
    expect(
      edited(flag, 'netclass_flag', 'field:Netclass', 'Signal').directiveLabels[0].properties[0]
        .value
    ).toBe('Signal')
    expect(edited([{ type: 'bus', index: 0 }], 'bus', 'width', mmToNm(0.5)).buses[0].width).toBe(
      mmToNm(0.5)
    )
  })

  it('a one-field edit diffs to that field alone', () => {
    const s = doc()
    const before = serializeKicadSchematic(s)
    applySheetItemEdit(
      sheetItemSelection(s, [{ type: 'netclass_flag', index: 0 }]),
      'netclass_flag',
      'shape',
      'dot'
    )
    const after = serializeKicadSchematic(s)
    expect(after).toBe(before.replace('(shape round)', '(shape dot)'))
  })

  it('leaves other groups to the caller', () => {
    expect(applySheetItemEdit(sheetItemSelection(doc(), []), 'symbol', 'Value', 'x')).toBe(false)
  })
})

describe('the sheet page number row', () => {
  const sheetNode = (uuid: string, page: string): string =>
    `(sheet (at 0 0) (size 10 10) (uuid "${uuid}")
    (property "Sheetname" "${uuid}" (at 0 0 0))
    (property "Sheetfile" "${uuid}.kicad_sch" (at 0 0 0))
    (instances (project "demo" (path "/root" (page "${page}")) (path "/root/x" (page "8")))))`
  const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "root") (paper "A4") (lib_symbols)
  ${sheetNode('a', '2')}
  ${sheetNode('b', '3')}
  (sheet_instances (path "/" (page "1"))))`
  const withPages = (
    s: ReturnType<typeof parseKicadSchematic>,
    designPages: string[]
  ): SchematicContext => ({
    ...ctx(s),
    document: s,
    sheetPages: { parentPath: '/root', designPages }
  })
  const pageField = (
    items: SelectionItem[],
    designPages: string[],
    source = SOURCE
  ): PropertyField | undefined =>
    group(
      buildSchematicGroups(items, t, withPages(parseKicadSchematic(source), designPages)),
      'sheet'
    )?.fields.find((f) => f.key === 'page')

  it('shows the page of the instance on screen, after the file row', () => {
    const s = parseKicadSchematic(SOURCE)
    const fields = group(
      buildSchematicGroups([{ type: 'sheet', index: 0 }], t, withPages(s, ['1', '2', '3'])),
      'sheet'
    )?.fields
    expect(fields?.map((f) => f.key)).toEqual([
      'Sheetname',
      'Sheetfile',
      'page',
      'width',
      'height',
      'strokeWidth'
    ])
    const page = fields?.find((f) => f.key === 'page')
    expect(page?.value).toBe('2')
    expect(page?.readonly).toBeFalsy()
    expect(page?.warning).toBeUndefined()
  })

  it('is mixed and read-only with several sheets selected, even on one page', () => {
    const both = [
      { type: 'sheet', index: 0 },
      { type: 'sheet', index: 1 }
    ]
    const page = pageField(both, ['1', '3', '3'], SOURCE.replace('(page "2")', '(page "3")'))
    expect(isMixed(page?.value)).toBe(true)
    expect(page?.readonly).toBe(true)
  })

  it('notes a page another sheet uses, and an empty one, without refusing either', () => {
    expect(pageField([{ type: 'sheet', index: 0 }], ['1', '2', '2'])?.warning).toBe(
      'schematicEditor.properties.pageDuplicate'
    )
    const empty = pageField(
      [{ type: 'sheet', index: 0 }],
      ['1', '', '3'],
      SOURCE.replace('(page "2")', '(page "")')
    )
    expect(empty?.value).toBe('')
    expect(empty?.warning).toBe('schematicEditor.properties.pageEmpty')
  })

  it('writes the page of the instance on screen only, as one sheet', () => {
    const s = parseKicadSchematic(SOURCE)
    const target = { parentPath: '/root', project: 'demo' }
    applySheetItemEdit(
      sheetItemSelection(s, [{ type: 'sheet', index: 0 }]),
      'sheet',
      'page',
      'B',
      target
    )
    const canonical = (text: string): string => serializeKicadSchematic(parseKicadSchematic(text))
    expect(serializeKicadSchematic(s)).toBe(canonical(SOURCE.replace('(page "2")', '(page "B")')))
    const two = parseKicadSchematic(SOURCE)
    const selection = sheetItemSelection(two, [
      { type: 'sheet', index: 0 },
      { type: 'sheet', index: 1 }
    ])
    applySheetItemEdit(selection, 'sheet', 'page', '5', target)
    expect(serializeKicadSchematic(two)).toBe(canonical(SOURCE))
  })
})

describe('the sheet on screen, with nothing selected', () => {
  const ROOT_FILE = '/p/root.kicad_sch'
  const CHILD_FILE = '/p/sub/child.kicad_sch'
  // The child is placed twice, each instance numbered on its own.
  const box = (uuid: string, page: string): string =>
    `(sheet (at 0 0) (size 10 10) (uuid "${uuid}")
    (property "Sheetname" "Sheet ${uuid}" (at 0 0 0))
    (property "Sheetfile" "sub/child.kicad_sch" (at 0 0 0))
    (instances (project "demo" (path "/root" (page "${page}")))))`
  const ROOT = `(kicad_sch (version 20250114) (generator "t") (uuid "root") (paper "A4")
  (title_block (title "Board") (rev "B") (comment 2 "second"))
  (lib_symbols)
  ${box('a', '2')}
  ${box('b', '3')}
  (sheet_instances (path "/" (page "1"))))`
  const CHILD = `(kicad_sch (version 20250114) (generator "t") (uuid "child") (paper "A3" portrait)
  (lib_symbols))`
  const canonical = (text: string): string => serializeKicadSchematic(parseKicadSchematic(text))
  const pages = ['1', '2', '3']

  const rootScreen = (source = ROOT): ScreenSheet => ({
    filePath: ROOT_FILE,
    document: parseKicadSchematic(source),
    root: true,
    designPages: pages,
    project: 'demo'
  })
  const childScreen = (uuid: string, root = parseKicadSchematic(ROOT)): ScreenSheet => ({
    filePath: CHILD_FILE,
    document: parseKicadSchematic(CHILD),
    root: false,
    parent: {
      filePath: ROOT_FILE,
      sheetPath: '/root',
      sheet: root.sheets.find((sheet) => sheet.uuid === uuid)!
    },
    designPages: pages,
    project: 'demo'
  })
  const screenGroup = (
    screen: ScreenSheet,
    items: SelectionItem[] = []
  ): Groups[number] | undefined =>
    group(
      buildSchematicGroups(items, t, {
        ...ctx(screen.document),
        document: screen.document,
        screen
      }),
      'screen_sheet'
    )
  const values = (screen: ScreenSheet): Record<string, unknown> =>
    Object.fromEntries(screenGroup(screen)?.fields.map((f) => [f.key, f.value]) ?? [])
  const COMMENTS = Array.from({ length: 9 }, (_, i) => `comment${i + 1}`)

  it('shows the root with its own page, its paper and title block, and no name', () => {
    const fields = screenGroup(rootScreen())?.fields ?? []
    expect(fields.map((f) => f.key)).toEqual([
      'sheetFile',
      'page',
      'paperSize',
      'orientation',
      'title',
      'date',
      'rev',
      'company',
      ...COMMENTS
    ])
    expect(fields.find((f) => f.key === 'sheetFile')?.readonly).toBe(true)
    expect(values(rootScreen())).toMatchObject({
      sheetFile: 'root.kicad_sch',
      page: '1',
      paperSize: 'A4',
      orientation: 'landscape',
      title: 'Board',
      rev: 'B',
      date: '',
      comment1: '',
      comment2: 'second'
    })
  })

  it('shows a subsheet with the name, file and page its box in the parent gives', () => {
    const fields = screenGroup(childScreen('a'))?.fields ?? []
    expect(fields.slice(0, 3).map((f) => f.key)).toEqual(['sheetName', 'sheetFile', 'page'])
    expect(values(childScreen('a'))).toMatchObject({
      sheetName: 'Sheet a',
      sheetFile: 'sub/child.kicad_sch',
      page: '2',
      paperSize: 'A3',
      orientation: 'portrait',
      title: ''
    })
    // The same file placed again is its own instance, with its own page.
    expect(values(childScreen('b'))).toMatchObject({ sheetName: 'Sheet b', page: '3' })
  })

  it('leaves out name and page while the parent is unread, and goes with a selection', () => {
    const unread = { ...childScreen('a'), parent: undefined }
    expect(screenGroup(unread)?.fields.map((f) => f.key)).not.toContain('page')
    expect(screenGroup(unread)?.fields.map((f) => f.key)).not.toContain('sheetName')
    expect(screenSheetEdits(unread, 'page', '9')).toEqual([])
    expect(screenGroup(rootScreen(), [{ type: 'sheet', index: 0 }])).toBeUndefined()
  })

  it('notes an empty page or one used twice, as the selected sheet does', () => {
    const screen = { ...childScreen('a'), designPages: ['1', '2', '2'] }
    expect(screenGroup(screen)?.fields.find((f) => f.key === 'page')?.warning).toBe(
      'schematicEditor.properties.pageDuplicate'
    )
    const empty = rootScreen(ROOT.replace('(page "1")', '(page "")'))
    expect(screenGroup(empty)?.fields.find((f) => f.key === 'page')?.warning).toBe(
      'schematicEditor.properties.pageEmpty'
    )
  })

  it("writes a subsheet's page and name into the parent file, that instance only", () => {
    const edits = screenSheetEdits(childScreen('b'), 'page', '9')
    expect(edits.map((edit) => edit.filePath)).toEqual([ROOT_FILE])
    const parent = parseKicadSchematic(ROOT)
    edits.forEach((edit) => edit.apply(parent))
    expect(serializeKicadSchematic(parent)).toBe(
      canonical(ROOT.replace('(page "3")', '(page "9")'))
    )
    const renamed = parseKicadSchematic(ROOT)
    screenSheetEdits(childScreen('a'), 'sheetName', 'Power').forEach((edit) => edit.apply(renamed))
    expect(serializeKicadSchematic(renamed)).toBe(canonical(ROOT.replace('"Sheet a"', '"Power"')))
    // KiCad names a sheet left unnamed rather than writing it empty.
    const cleared = parseKicadSchematic(ROOT)
    screenSheetEdits(childScreen('a'), 'sheetName', '').forEach((edit) => edit.apply(cleared))
    expect(cleared.sheets[0].properties[0].value).toBe('Untitled Sheet')
  })

  it("writes the root's page into its own sheet_instances", () => {
    const edits = screenSheetEdits(rootScreen(), 'page', 'i')
    expect(edits.map((edit) => edit.filePath)).toEqual([ROOT_FILE])
    const root = parseKicadSchematic(ROOT)
    edits.forEach((edit) => edit.apply(root))
    expect(serializeKicadSchematic(root)).toBe(
      canonical(ROOT.replace('(path "/" (page "1"))', '(path "/" (page "i"))'))
    )
  })

  it('writes the paper and the title block into the file on screen', () => {
    const apply = (screen: ScreenSheet, key: string, value: PropertyEditValue): string => {
      const edits = screenSheetEdits(screen, key, value)
      expect(edits.map((edit) => edit.filePath)).toEqual([screen.filePath])
      edits.forEach((edit) => edit.apply(screen.document))
      return serializeKicadSchematic(screen.document)
    }
    expect(apply(childScreen('a'), 'orientation', 'landscape')).toBe(
      canonical(CHILD.replace('(paper "A3" portrait)', '(paper "A3")'))
    )
    expect(apply(childScreen('a'), 'paperSize', 'USLetter')).toBe(
      canonical(CHILD.replace('(paper "A3" portrait)', '(paper "USLetter" portrait)'))
    )
    // Made custom, the page keeps the size it had.
    expect(apply(childScreen('a'), 'paperSize', 'User')).toBe(
      canonical(CHILD.replace('(paper "A3" portrait)', '(paper "User" 297 420)'))
    )
    const custom = childScreen('a')
    apply(custom, 'paperSize', 'User')
    expect(
      screenGroup(custom)
        ?.fields.map((f) => f.key)
        .filter((key) => key.startsWith('paper') || key === 'orientation')
    ).toEqual(['paperSize', 'paperWidth', 'paperHeight'])
    expect(apply(custom, 'paperWidth', mmToNm(250))).toBe(
      canonical(CHILD.replace('(paper "A3" portrait)', '(paper "User" 250 420)'))
    )
    expect(apply(childScreen('a'), 'company', 'Goat')).toBe(
      canonical(
        CHILD.replace(
          '(paper "A3" portrait)',
          '(paper "A3" portrait) (title_block (company "Goat"))'
        )
      )
    )
    expect(apply(rootScreen(), 'rev', '')).toBe(canonical(ROOT.replace(' (rev "B")', '')))
  })
})

describe('KiCad parity rows: stroke, text box, sheet border, pin length, bus entry, image, table', () => {
  const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
  (wire (pts (xy 50 50) (xy 63 50)) (stroke (width 0) (type dash)) (uuid "w1"))
  (bus (pts (xy 0 80) (xy 20 80)) (stroke (width 0) (type default)) (uuid "b1"))
  (bus_entry (at 20 80) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "be1"))
  (image (at 40 40) (scale 2) (uuid "i1") (data "iVBORw0KGgo="))
  (text_box "Box" (exclude_from_sim no) (at 30 30 0) (size 10 5) (margins 0.9525 0.9525 0.9525 0.9525)
    (stroke (width 0) (type solid)) (fill (type none))
    (effects (font (size 1.27 1.27)) (justify left top)) (uuid "tb1"))
  (netclass_flag "" (length 2.54) (shape round) (at 70 70 0)
    (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "n1")
    (property "Netclass" "Power" (at 71 67 0) (effects (font (size 1.27 1.27)) (justify left))))
  (sheet (at 100 50) (size 25.4 20.32) (stroke (width 0.15) (type solid)) (fill (color 0 0 0 0)) (uuid "s1")
    (property "Sheetname" "Child" (at 100 49.3 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "child.kicad_sch" (at 100 71.02 0) (effects (font (size 1.27 1.27)) (justify left top))))
  (table (column_count 1)
    (border (external yes) (header no) (stroke (width 0.3) (type solid)))
    (separators (rows yes) (cols no) (stroke (width 0.1) (type solid)))
    (column_widths 10) (row_heights 5)
    (cells (table_cell "A" (exclude_from_sim no) (at 0 0 0) (size 10 5) (margins 1 1 1 1) (span 1 1)
      (fill (type none)) (effects (font (size 1.27 1.27))) (uuid "c1")))
    (uuid "tab1"))
  (sheet_instances (path "/" (page "1"))))`

  const doc = (): ReturnType<typeof parseKicadSchematic> => parseKicadSchematic(SOURCE)
  const context = (s: ReturnType<typeof parseKicadSchematic>): SchematicContext => ({
    ...ctx(s),
    wires: s.wires,
    document: s
  })
  const groupOf = (type: string): Groups[number] | undefined => {
    const s = doc()
    return buildSchematicGroups([{ type, index: 0 }], t, context(s)).find((g) => g.type === type)
  }
  const value = (type: string, key: string): unknown =>
    groupOf(type)?.fields.find((f) => f.key === key)?.value
  const edited = (
    type: string,
    key: string,
    v: PropertyEditValue
  ): ReturnType<typeof parseKicadSchematic> => {
    const s = doc()
    expect(applySheetItemEdit(sheetItemSelection(s, [{ type, index: 0 }]), type, key, v)).toBe(true)
    return parseKicadSchematic(serializeKicadSchematic(s))
  }

  it('gives a wire and a bus their Wire Style and Color rows', () => {
    expect(value('wire', 'strokeType')).toBe('dash')
    expect(value('wire', 'strokeColor')).toBeNull()
    expect(value('bus', 'strokeType')).toBe('default')
    expect(strokePatch('strokeType', 'dot')).toEqual({ strokeType: 'dot' })
    expect(strokePatch('net', 'x')).toBeNull()
    expect(edited('bus', 'strokeType', 'dot').buses[0].strokeType).toBe('dot')
  })

  it('builds a bus entry group and writes its stroke', () => {
    expect(value('bus_entry', 'strokeType')).toBe('default')
    const back = edited('bus_entry', 'width', mmToNm(0.3))
    expect(back.busEntries[0].width).toBe(mmToNm(0.3))
    const colored = edited('bus_entry', 'strokeColor', { r: 255, g: 0, b: 0, a: 1 })
    expect(colored.busEntries[0].strokeColor).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('builds an image group and writes its position and scale', () => {
    expect(value('image', 'scale')).toBe(2)
    expect(value('image', 'posX')).toBe(mmToNm(40))
    expect(edited('image', 'scale', 0.5).images[0].scale).toBe(0.5)
    expect(edited('image', 'posY', mmToNm(12)).images[0].position).toEqual({
      x: mmToNm(40),
      y: mmToNm(12)
    })
  })

  it('builds a table group and writes its borders and separators', () => {
    expect(value('table', 'borderExternal')).toBe(true)
    expect(value('table', 'borderHeader')).toBe(false)
    expect(value('table', 'borderWidth')).toBe(mmToNm(0.3))
    expect(value('table', 'separatorCols')).toBe(false)
    expect(value('table', 'separatorWidth')).toBe(mmToNm(0.1))
    expect(edited('table', 'borderHeader', true).tables[0].border.header).toBe(true)
    expect(edited('table', 'separatorWidth', mmToNm(0.2)).tables[0].separators.stroke.width).toBe(
      mmToNm(0.2)
    )
  })

  it('creates a missing border where KiCad writes it, after the column count', () => {
    const s = parseKicadSchematic(SOURCE.replace(/\(border [^\n]*\n/, ''))
    applySheetItemEdit(
      sheetItemSelection(s, [{ type: 'table', index: 0 }]),
      'table',
      'borderExternal',
      false
    )
    expect(serializeKicadSchematic(s)).toMatch(
      /\(column_count 1\)\s*\(border\s*\(external no\)\s*\)\s*\(separators/
    )
  })

  it('gives a text box its margins, border and fill rows under KiCad’s sections', () => {
    const group = groupOf('text_box')
    const section = (key: string): unknown => group?.fields.find((f) => f.key === key)?.section
    expect(section('x')).toBeUndefined()
    expect(section('text')).toBe('text')
    expect(section('marginLeft')).toBe('margins')
    expect(section('strokeType')).toBe('shape')
    expect(value('text_box', 'fill')).toBe('none')
    expect(edited('text_box', 'marginLeft', mmToNm(2)).textBoxes[0].graphic.margins.left).toBe(
      mmToNm(2)
    )
    expect(edited('text_box', 'strokeType', 'dash').textBoxes[0].graphic.stroke.type).toBe('dash')
    expect(edited('text_box', 'text', 'Hi').textBoxes[0].graphic.text).toBe('Hi')
  })

  it('edits a sheet’s border width and a directive label’s pin length', () => {
    expect(value('sheet', 'strokeWidth')).toBe(mmToNm(0.15))
    expect(edited('sheet', 'strokeWidth', mmToNm(0.3)).sheets[0].strokeWidth).toBe(mmToNm(0.3))
    expect(value('netclass_flag', 'length')).toBe(mmToNm(2.54))
    expect(edited('netclass_flag', 'length', mmToNm(5.08)).directiveLabels[0].length).toBe(
      mmToNm(5.08)
    )
    const fieldRow = groupOf('netclass_flag')?.fields.find((f) => f.key === 'field:Netclass')
    expect(fieldRow?.section).toBe('fields')
  })

  it('orders a placed symbol as KiCad does: position, then Fields, then Attributes', () => {
    const s = sch()
    const fields = buildSchematicGroups([{ type: 'symbol', index: 0 }], t, ctx(s))[0].fields
    const keys = fields.map((f) => f.key)
    expect(keys.indexOf('posX')).toBeLessThan(keys.indexOf('Reference'))
    expect(fields.find((f) => f.key === 'Reference')?.section).toBe('fields')
    expect(fields.find((f) => f.key === 'dnp')?.section).toBe('attributes')
    expect(fields.find((f) => f.key === 'posX')?.section).toBeUndefined()
  })
})
