import { describe, expect, it } from 'vitest'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import {
  ADD_ALTERNATE_ACTION,
  alternateIndexOf,
  buildPendingGroups,
  buildSymbolGroups,
  REMOVE_ALTERNATE_ACTION,
  SYMBOL_GROUP_TYPES
} from '../symbolPropertySchema'
import { toolTemplate } from '../../symbolTools'
import { isMixed } from '../../propertyTable'
import { mmToNm as mm } from '../../kicad/coordinates'
import type { KicadLibSymbol } from '../../kicad/schematic'

const t = (key: string): string => key

const LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "R"
    (pin_names (offset 0))
    (in_bom yes)
    (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54)
        (stroke (width 0.254) (type default)) (fill (type none)))
      (text "Note" (at 1.27 -1.27 900) (effects (font (size 1.27 1.27))))
    )
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
)
`

/** Two gates plus a shared body — the shape "common to all units" is about. */
const DUAL_LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "DUAL"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_0_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "DUAL_1_1"
      (pin passive line (at 0 7.62 270) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_2_1"
      (pin passive line (at 0 -7.62 90) (length 2.54)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
)
`

type Groups = ReturnType<typeof buildSymbolGroups>
const symbol = (): KicadLibSymbol => parseKicadSymbolLibrary(LIBRARY).symbols.get('R')!
const group = (groups: Groups, type: string): Groups[number] | undefined =>
  groups.find((g) => g.type === type)
const fieldValue = (groups: Groups, type: string, key: string): unknown =>
  group(groups, type)?.fields.find((f) => f.key === key)?.value

describe('buildSymbolGroups', () => {
  it('shows the symbol sections only when nothing else is selected', () => {
    // Split into KiCad's sections rather than one long group; all three write
    // the same symbol node, which is what SYMBOL_GROUP_TYPES tells the host.
    const groups = buildSymbolGroups(symbol(), [], t)
    expect(groups.map((g) => g.type)).toEqual([
      'symbolDefinition',
      'symbolFields',
      'symbolPinDisplay',
      'symbolAttributes'
    ])
    expect(groups.every((g) => SYMBOL_GROUP_TYPES.has(g.type))).toBe(true)
    // A field row is keyed by its PROPERTY key, not by a UI name mapped onto it
    // — which is what lets a custom field (MPN, Sim.Device) have a row at all.
    expect(fieldValue(groups, 'symbolFields', 'Reference')).toBe('R')
    expect(fieldValue(groups, 'symbolAttributes', 'inBom')).toBe(true)
    expect(fieldValue(groups, 'symbolAttributes', 'power')).toBe('none')
  })

  it('labels a custom field named like an Object member with its own name', () => {
    // The label lookup is keyed by user text; `constructor` must not find a
    // prototype member and build a key out of it.
    const custom = symbol()
    custom.properties.push({ ...custom.properties[0], key: 'constructor', value: 'x' })
    const row = group(buildSymbolGroups(custom, [], t), 'symbolFields')?.fields.find(
      (f) => f.key === 'constructor'
    )
    expect(row?.label).toBe('constructor')
    expect(row?.labelKey).toBeUndefined()
  })

  it('states pin display positively, inverting the file’s hide flags', () => {
    // The file stores "hide"; the panel asks "show", as KiCad does. A checkbox
    // labelled with a negative is one people tick backwards.
    const groups = buildSymbolGroups(symbol(), [], t)
    expect(fieldValue(groups, 'symbolPinDisplay', 'showPinNames')).toBe(true)
    expect(fieldValue(groups, 'symbolPinDisplay', 'showPinNumbers')).toBe(true)
    // The fixture sets `(pin_names (offset 0))`, so this reads the file's value
    // rather than the 0.508 KiCad defaults to when the node is absent.
    expect(fieldValue(groups, 'symbolPinDisplay', 'pinNameOffset')).toBe(0)
  })

  it('shows only the pin group for a selected pin (hides root symbol props)', () => {
    const groups = buildSymbolGroups(symbol(), [{ kind: 'pin', unit: 1, style: 1, index: 0 }], t)
    expect(groups.map((g) => g.type)).toEqual(['pin'])
    expect(group(groups, 'pin')?.count).toBe(1)
    expect(fieldValue(groups, 'pin', 'number')).toBe('1')
    expect(fieldValue(groups, 'pin', 'y')).toBe(mm(3.81))
    expect(fieldValue(groups, 'pin', 'hidden')).toBe(false)
  })

  it('offers "common to all units" only once a symbol has gates', () => {
    // On a single-unit symbol the two states are indistinguishable — and our own
    // insert rule already puts body graphics in unit 0 — so the row would be a
    // control for nothing. There is deliberately no body-style companion: we do
    // not draw De Morgan alternates, so that one would read as a delete.
    const single = buildSymbolGroups(symbol(), [{ kind: 'pin', unit: 1, style: 1, index: 0 }], t)
    expect(group(single, 'pin')?.fields.map((f) => f.key)).not.toContain('commonToAllUnits')

    const dual = parseKicadSymbolLibrary(DUAL_LIBRARY).symbols.get('DUAL')!
    const shared = buildSymbolGroups(dual, [{ kind: 'graphic', unit: 0, style: 1, index: 0 }], t)
    expect(fieldValue(shared, 'rectangle', 'commonToAllUnits')).toBe(true)
    const gate = buildSymbolGroups(dual, [{ kind: 'pin', unit: 1, style: 1, index: 0 }], t)
    expect(fieldValue(gate, 'pin', 'commonToAllUnits')).toBe(false)
  })

  it('exposes the pin name and number text sizes KiCad puts in its dialog', () => {
    // Both were parsed all along (nameEffects/numberEffects) and reachable from
    // nowhere in the panel — the gap a token census could not see, since a pin
    // font is just another `(size …)`.
    const groups = buildSymbolGroups(symbol(), [{ kind: 'pin', unit: 1, style: 1, index: 0 }], t)
    expect(fieldValue(groups, 'pin', 'nameSize')).toBe(mm(1.27))
    expect(fieldValue(groups, 'pin', 'numberSize')).toBe(mm(1.27))
  })

  const textGroups = (): Groups =>
    buildSymbolGroups(symbol(), [{ kind: 'graphic', unit: 0, style: 1, index: 1 }], t)

  it('shows the text group for a selected text, angle in degrees', () => {
    // The text tool made this reachable, so the panel has to answer for it: the
    // stored 900 decidegrees must arrive as 90 in the field a user edits.
    const groups = textGroups()
    expect(groups.map((g) => g.type)).toEqual(['text'])
    expect(fieldValue(groups, 'text', 'text')).toBe('Note')
    expect(fieldValue(groups, 'text', 'x')).toBe(mm(1.27))
    expect(fieldValue(groups, 'text', 'angle')).toBe(90)
    expect(fieldValue(groups, 'text', 'size')).toBe(mm(1.27))
  })

  it('exposes every text effect the format carries', () => {
    // Against the effects grammar in docs/references/kicad-format-spec.md:
    // size, thickness, bold, italic, justify and (KiCad 7+) font color. The
    // deliberate omissions are face, line_spacing and hide — see the workstream.
    const keys = group(textGroups(), 'text')?.fields.map((f) => f.key)
    expect(keys).toEqual([
      'text',
      'x',
      'y',
      'angle',
      'size',
      'thicknessAuto',
      'thickness',
      'bold',
      'italic',
      'hAlign',
      'vAlign',
      'color'
    ])
  })

  it('reads a text with no stored thickness as auto, and locks the weight row', () => {
    // The token is absent in all but 13 texts across the 223 standard
    // libraries, so "auto" is the state the panel mostly has to describe — and
    // a row you can type into would misreport a weight the file does not carry.
    const fields = group(textGroups(), 'text')?.fields ?? []
    expect(fields.find((f) => f.key === 'thicknessAuto')?.value).toBe(true)
    expect(fields.find((f) => f.key === 'thickness')?.readonly).toBe(true)
  })

  it('unlocks the weight row for a text that carries its own thickness', () => {
    const explicit = parseKicadSymbolLibrary(
      LIBRARY.replace(
        '(text "Note" (at 1.27 -1.27 900) (effects (font (size 1.27 1.27))))',
        '(text "Note" (at 1.27 -1.27 900) (effects (font (size 1.27 1.27) (thickness 0.3))))'
      )
    ).symbols.get('R')!
    const fields =
      group(
        buildSymbolGroups(explicit, [{ kind: 'graphic', unit: 0, style: 1, index: 1 }], t),
        'text'
      )?.fields ?? []
    expect(fields.find((f) => f.key === 'thicknessAuto')?.value).toBe(false)
    expect(fields.find((f) => f.key === 'thickness')?.value).toBeCloseTo(mm(0.3), 0)
    expect(fields.find((f) => f.key === 'thickness')?.readonly).toBe(false)
  })

  it('reports the thickness a text is drawn with when the file omits one', () => {
    // The renderer's own derivation (effectiveTextThickness — eeschema's flat
    // 6-mil default pen), so the row never shows a weight nothing draws.
    expect(fieldValue(textGroups(), 'text', 'thickness')).toBeCloseTo(mm(0.1524), 0)
  })

  it('defaults justification to center, as a file with no justify means', () => {
    expect(fieldValue(textGroups(), 'text', 'hAlign')).toBe('center')
    expect(fieldValue(textGroups(), 'text', 'vAlign')).toBe('center')
  })

  it('reads an unset font color as null, so the picker shows inherit', () => {
    expect(fieldValue(textGroups(), 'text', 'color')).toBeNull()
  })

  it('collapses agreeing values and marks disagreeing ones MIXED', () => {
    const groups = buildSymbolGroups(
      symbol(),
      [
        { kind: 'pin', unit: 1, style: 1, index: 0 },
        { kind: 'pin', unit: 1, style: 1, index: 1 }
      ],
      t
    )
    expect(group(groups, 'pin')?.count).toBe(2)
    expect(fieldValue(groups, 'pin', 'length')).toBe(mm(1.27)) // both agree
    expect(isMixed(fieldValue(groups, 'pin', 'y'))).toBe(true) // 3.81 vs -3.81
  })

  it('groups a mixed-type selection one group per primitive type', () => {
    const groups = buildSymbolGroups(
      symbol(),
      [
        { kind: 'pin', unit: 1, style: 1, index: 0 },
        { kind: 'graphic', unit: 0, style: 1, index: 0 }
      ],
      t
    )
    expect(groups.map((g) => g.type)).toEqual(['pin', 'rectangle'])
    expect(fieldValue(groups, 'rectangle', 'startX')).toBe(mm(-1.016))
    expect(fieldValue(groups, 'rectangle', 'strokeWidth')).toBe(mm(0.254))
    expect(fieldValue(groups, 'rectangle', 'fill')).toBe('none')
  })

  it('offers a stroke style on every graphic that has a stroke', () => {
    // Dashed and dotted body outlines are ordinary in KiCad symbols; the parse and
    // the writer both carried the type and only the row was missing.
    const groups = buildSymbolGroups(
      symbol(),
      [{ kind: 'graphic', unit: 0, style: 1, index: 0 }],
      t
    )
    expect(fieldValue(groups, 'rectangle', 'strokeType')).toBe('default')
    // Text is the exception: no stroke, so no style row.
    expect(group(textGroups(), 'text')?.fields.map((f) => f.key)).not.toContain('strokeType')
  })

  it('returns nothing without a definition', () => {
    expect(buildSymbolGroups(null, [], t)).toEqual([])
  })

  const ALT_LIBRARY = LIBRARY.replace(
    '(number "1" (effects (font (size 1.27 1.27)))))',
    `(number "1" (effects (font (size 1.27 1.27))))
        (alternate "ADC1_IN0" input line))`
  )
  const altSymbol = (): KicadLibSymbol => parseKicadSymbolLibrary(ALT_LIBRARY).symbols.get('R')!
  const pinSel = { kind: 'pin' as const, unit: 1, style: 1, index: 0 }

  it('gives each alternate its own group, with a unique id and a remove action', () => {
    const groups = buildSymbolGroups(altSymbol(), [pinSel], t)
    expect(groups.map((g) => g.type)).toEqual(['pin', 'alternate'])
    const alternate = group(groups, 'alternate')!
    // The id is what tells the host WHICH entry a header button or an edit hit —
    // the type alone repeats.
    expect(alternate.id).toBe('alternate:0')
    expect(alternate.actions?.map((a) => a.id)).toEqual([REMOVE_ALTERNATE_ACTION])
    expect(alternateIndexOf(alternate.id)).toBe(0)
    expect(fieldValue(groups, 'alternate', 'name')).toBe('ADC1_IN0')
    expect(fieldValue(groups, 'alternate', 'electricalType')).toBe('input')
  })

  it('hangs Add on the PIN header, so a pin with no alternates can still get one', () => {
    // The empty case is exactly when you need the button, and an empty list has
    // no header of its own to carry it.
    const groups = buildSymbolGroups(symbol(), [pinSel], t)
    expect(groups.map((g) => g.type)).toEqual(['pin'])
    expect(group(groups, 'pin')?.actions?.map((a) => a.id)).toEqual([ADD_ALTERNATE_ACTION])
  })

  it('offers neither alternates nor Add across a multi-pin selection', () => {
    // An alternate list cannot collapse across pins, and "add" would have to
    // mean adding to all of them.
    const groups = buildSymbolGroups(altSymbol(), [pinSel, { ...pinSel, index: 1 }], t)
    expect(groups.map((g) => g.type)).toEqual(['pin'])
    expect(group(groups, 'pin')?.actions).toBeUndefined()
  })

  it('rejects a group id that is not an alternate', () => {
    expect(alternateIndexOf('pin')).toBeNull()
    expect(alternateIndexOf(undefined)).toBeNull()
  })
})

describe('buildPendingGroups', () => {
  const groupsFor = (
    tool: Parameters<typeof toolTemplate>[0]
  ): ReturnType<typeof buildPendingGroups> => buildPendingGroups(toolTemplate(tool), t)

  it('describes the pending pin with the same rows a placed one gets', () => {
    const [group] = groupsFor('pin')
    expect(group.type).toBe('pin')
    const keys = group.fields.map((f) => f.key)
    expect(keys).toContain('electricalType')
    expect(keys).toContain('length')
    expect(keys).toContain('name')
  })

  it('keeps every row a placed item has — arming a tool must not reshape the panel', () => {
    for (const tool of ['pin', 'rectangle', 'circle', 'arc', 'text'] as const) {
      const pendingKeys = groupsFor(tool).flatMap((g) => g.fields.map((f) => f.key))
      const placedKeys = buildSymbolGroups(
        { ...symbol(), variants: [{ unit: 1, style: 1, ...toolTemplate(tool) }] } as KicadLibSymbol,
        [{ kind: tool === 'pin' ? 'pin' : 'graphic', unit: 1, style: 1, index: 0 }],
        t
      ).flatMap((g) => g.fields.map((f) => f.key))
      expect([tool, pendingKeys]).toEqual([tool, placedKeys])
    }
  })

  it('shows position rows read-only — the pointer owns them while a tool is armed', () => {
    // Present, so the panel keeps its shape, but not typeable: a row you could
    // edit would fight the ghost.
    const positional = ['x', 'y', 'angle']
    const pinFields = groupsFor('pin')[0].fields
    for (const key of positional) {
      expect([key, pinFields.find((f) => f.key === key)?.readonly]).toEqual([key, true])
    }
    // Everything else stays editable — that is the point of the feature.
    expect(pinFields.find((f) => f.key === 'electricalType')?.readonly).toBeFalsy()
    expect(pinFields.find((f) => f.key === 'length')?.readonly).toBeFalsy()
  })

  it('keeps the rows a tool can actually carry forward', () => {
    const rectKeys = groupsFor('rectangle').flatMap((g) => g.fields.map((f) => f.key))
    expect(rectKeys).toEqual(
      expect.arrayContaining(['strokeWidth', 'strokeType', 'fill', 'strokeColor', 'fillColor'])
    )
    const textKeys = groupsFor('text').flatMap((g) => g.fields.map((f) => f.key))
    expect(textKeys).toEqual(expect.arrayContaining(['text', 'size', 'bold', 'italic']))
    // Angle is positional for a text too, so it is present but read-only.
    expect(textKeys).toContain('angle')
  })

  it('reports one item, never a selection count', () => {
    for (const group of groupsFor('rectangle')) expect(group.count).toBe(1)
  })

  it('is empty for select, so the caller falls back to the selection panel', () => {
    expect(buildPendingGroups(toolTemplate('select'), t)).toEqual([])
  })
})

describe('text trimming opt-out', () => {
  const editorOf = (groups: Groups, type: string, key: string): { skipTrim?: boolean } =>
    group(groups, type)?.fields.find((f) => f.key === key)?.editor as { skipTrim?: boolean }

  it('leaves a DRAWN text untrimmed', () => {
    // Padding a label to nudge it clear of a pin is deliberate; trimming would
    // silently delete work the user did on purpose.
    const drawn = buildSymbolGroups(symbol(), [{ kind: 'graphic', unit: 0, style: 1, index: 1 }], t)
    expect(editorOf(drawn, 'text', 'text').skipTrim).toBe(true)
  })

  it('trims a field value, which is an identifier', () => {
    // A stray space here changes what a BOM row or a library lookup matches
    // while looking identical on screen — so this row must NOT opt out.
    const groups = buildSymbolGroups(symbol(), [], t)
    expect(editorOf(groups, 'symbolFields', 'Reference').skipTrim).toBeUndefined()
  })
})

describe('the selected-field group names its field', () => {
  // A Reference and an MPN produce identical styling rows, so without the key
  // the only way to tell which one the panel describes is to remember the click.
  const CUSTOM = LIBRARY.replace(
    '    (symbol "R_0_1"',
    '    (property "MPN" "RC0603" (at 0 0 0) (effects (font (size 1.27 1.27))))\n    (symbol "R_0_1"'
  )
  const fieldSel = (
    key: string
  ): { kind: 'field'; unit: number; style: number; index: number; field: string } => ({
    kind: 'field',
    unit: 0,
    style: 0,
    index: 0,
    field: key
  })
  const nameRow = (
    lib: string,
    ...keys: string[]
  ): { value: unknown; readonly?: boolean } | undefined => {
    const def = parseKicadSymbolLibrary(lib).symbols.get('R')!
    const groups = buildSymbolGroups(def, keys.map(fieldSel), t)
    return group(groups, 'field')?.fields.find((f) => f.key === 'name')
  }

  it('shows the key, as the first row', () => {
    const def = parseKicadSymbolLibrary(LIBRARY).symbols.get('R')!
    const fields = group(buildSymbolGroups(def, [fieldSel('Reference')], t), 'field')!.fields
    expect(fields[0].key).toBe('name')
    expect(fields[0].value).toBe('Reference')
  })

  // `renameSymbolProperty` refuses KiCad's mandatory five, so an editable row
  // there would be a control that silently does nothing.
  it('is read-only on a mandatory field', () => {
    expect(nameRow(LIBRARY, 'Reference')?.readonly).toBe(true)
    expect(nameRow(LIBRARY, 'Value')?.readonly).toBe(true)
  })

  it('is editable on a custom field', () => {
    const row = nameRow(CUSTOM, 'MPN')
    expect(row?.value).toBe('MPN')
    expect(row?.readonly).toBe(false)
  })

  // Renaming is one-at-a-time by nature — two fields cannot take one key.
  it('is read-only across a multi-field selection', () => {
    const row = nameRow(CUSTOM, 'MPN', 'Reference')
    expect(row?.readonly).toBe(true)
    expect(isMixed(row?.value)).toBe(true)
  })
})

describe('the symbol-definition section', () => {
  // It leads the no-selection panel because it names the SUBJECT — the other
  // three titles say what kind of setting they hold, not whose.
  it('names the symbol, editably', () => {
    const groups = buildSymbolGroups(symbol(), [], t)
    const row = group(groups, 'symbolDefinition')?.fields[0]
    expect(row?.key).toBe('symbolName')
    expect(row?.value).toBe('R')
    expect(row?.readonly).toBeFalsy()
  })

  // A derived symbol draws an inherited body and has its geometry tools gated
  // off; without this row nothing on screen accounts for either.
  it('reports the parent of a derived symbol, read-only', () => {
    const derived = parseKicadSymbolLibrary(`(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "R"
    (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
  )
  (symbol "R_Small"
    (extends "R")
    (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
  )
)
`).symbols.get('R_Small')!
    const rows = group(buildSymbolGroups(derived, [], t), 'symbolDefinition')!.fields
    const parent = rows.find((f) => f.key === 'derivedFrom')
    expect(parent?.value).toBe('R')
    expect(parent?.readonly).toBe(true)
  })

  it('omits the parent row on a symbol that has none', () => {
    const rows = group(buildSymbolGroups(symbol(), [], t), 'symbolDefinition')!.fields
    expect(rows.some((f) => f.key === 'derivedFrom')).toBe(false)
  })
})

describe('KiCad parity rows: private field, rectangle extent, curve ends, arc, text box', () => {
  const PARITY = `(kicad_symbol_lib
  (version 20241209)
  (generator "kicad_symbol_editor")
  (symbol "P"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property private "Note" "internal" (at 0 2 0) (effects (font (size 1.27 1.27))))
    (property "MPN" "X1" (at 0 4 0) (effects (font (size 1.27 1.27))))
    (symbol "P_0_1"
      (rectangle (start -2 -1) (end 3 4) (stroke (width 0.254) (type default)) (fill (type none)))
      (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0.254) (type default)) (fill (type none)))
      (arc (start 0 1) (mid 1 0) (end 0 -1) (stroke (width 0.254) (type default)) (fill (type none)))
      (text_box "Box" (at 0 0 0) (size 5 -3) (margins 0.5 0.5 0.5 0.5)
        (stroke (width 0.1) (type solid)) (fill (type none))
        (effects (font (size 1.27 1.27)) (justify left top)))
    )
  )
)
`
  const def = (): KicadLibSymbol => parseKicadSymbolLibrary(PARITY).symbols.get('P')!
  const graphicAt = (
    index: number
  ): { kind: 'graphic'; unit: number; style: number; index: number } => ({
    kind: 'graphic',
    unit: 0,
    style: 1,
    index
  })
  const fieldAt = (
    key: string
  ): { kind: 'field'; unit: number; style: number; index: number; field: string } => ({
    kind: 'field',
    unit: 0,
    style: 0,
    index: 0,
    field: key
  })
  const row = (groups: Groups, type: string, key: string): Groups[number]['fields'][number] =>
    group(groups, type)!.fields.find((f) => f.key === key)!

  it('shows Private on a field, read-only on a mandatory one', () => {
    const d = def()
    expect(row(buildSymbolGroups(d, [fieldAt('Note')], t), 'field', 'private').value).toBe(true)
    expect(row(buildSymbolGroups(d, [fieldAt('MPN')], t), 'field', 'private').value).toBe(false)
    expect(row(buildSymbolGroups(d, [fieldAt('Reference')], t), 'field', 'private').readonly).toBe(
      true
    )
  })

  it('puts a field’s styling under its Text section, its placement above', () => {
    const fields = group(buildSymbolGroups(def(), [fieldAt('MPN')], t), 'field')!.fields
    expect(fields.find((f) => f.key === 'x')?.section).toBeUndefined()
    expect(fields.find((f) => f.key === 'size')?.section).toBe('text')
  })

  it('reads a rectangle’s Width and Height from its corners', () => {
    const groups = buildSymbolGroups(def(), [graphicAt(0)], t)
    expect(row(groups, 'rectangle', 'rectWidth').value).toBe(mm(5))
    expect(row(groups, 'rectangle', 'rectHeight').value).toBe(mm(5))
  })

  it('reads a curve’s Start and End from its first and last points', () => {
    const groups = buildSymbolGroups(def(), [graphicAt(1)], t)
    expect(row(groups, 'bezier', 'startX').value).toBe(mm(0))
    expect(row(groups, 'bezier', 'endX').value).toBe(mm(3))
  })

  it('offers no Fill on an arc, as KiCad offers none', () => {
    const groups = buildSymbolGroups(def(), [graphicAt(2)], t)
    expect(group(groups, 'arc')!.fields.some((f) => f.key === 'fill')).toBe(false)
  })

  it('splits a text box into Text, Margins and Shape sections', () => {
    const fields = group(buildSymbolGroups(def(), [graphicAt(3)], t), 'textBox')!.fields
    const sectionOf = (key: string): unknown => fields.find((f) => f.key === key)?.section
    expect(sectionOf('x')).toBeUndefined()
    expect(sectionOf('bold')).toBe('text')
    expect(sectionOf('marginTop')).toBe('margins')
    expect(sectionOf('fill')).toBe('shape')
  })
})
