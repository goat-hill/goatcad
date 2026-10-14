import { describe, expect, test } from 'vitest'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { parseSExpr, type SExprList } from '../../kicad/sexpr'
import { parseLibSymbol } from '../../kicad/schematic'
import {
  createSymbolItem,
  deleteSymbolItems,
  querySymbolItems,
  resolveSymbolItem,
  symbolItemRow,
  symbolItems,
  updateSymbolItem,
  type SymbolItem
} from '../symbolItems'

/**
 * Two units, a De Morgan style for unit 1 (pins 1 and 2 again), and two stacked
 * power pins numbered 4 in unit 2: every pin id form appears.
 */
const LIBRARY = `(kicad_symbol_lib
	(version 20251024)
	(generator "kicad_symbol_editor")
	(symbol "Gate"
		(pin_names
			(offset 0.254)
		)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U"
			(at 0 7.62 0)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "Gate"
			(at 0 -7.62 0)
			(effects
				(font
					(size 1.27 1.27)
				)
				(justify left)
			)
		)
		(property "Footprint" ""
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Datasheet" ""
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Description" "A gate"
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "ki_keywords" "logic"
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(symbol "Gate_0_1"
			(rectangle
				(start -5.08 5.08)
				(end 5.08 -5.08)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type background)
				)
			)
			(circle
				(center 0 0)
				(radius 1)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(text "G"
				(at 1 2 900)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(text_box "note"
				(at -2 3 0)
				(size 4 -2)
				(margins 0.3175 0.3175 0.3175 0.3175)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
				(effects
					(font
						(size 1 1)
					)
				)
			)
		)
		(symbol "Gate_1_1"
			(polyline
				(pts
					(xy -1 1) (xy 1 1) (xy 1 -1)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(pin input line
				(at -7.62 2.54 0)
				(length 2.54)
				(name "A"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin output line
				(at 7.62 0 180)
				(length 2.54)
				(name "Y"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
		(symbol "Gate_1_2"
			(arc
				(start -1 0)
				(mid 0 1)
				(end 1 0)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(pin input inverted
				(at -7.62 2.54 0)
				(length 2.54)
				(name "A"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin output line
				(at 7.62 0 180)
				(length 2.54)
				(name "Y"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
		(symbol "Gate_2_1"
			(bezier
				(pts
					(xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(pin power_in line
				(at 0 10.16 270)
				(length 2.54)
				(hide yes)
				(name "VCC"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "4"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin power_in line
				(at 0 10.16 270)
				(length 2.54)
				(hide yes)
				(name "VCC"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "4"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin power_in line
				(at 0 -10.16 90)
				(length 2.54)
				(name "GND"
					(effects
						(font
							(size 0.8 0.8)
						)
					)
				)
				(number "5"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
	)
)
`

const load = (): { library: KicadSymbolLibrary; node: SExprList } => {
  const library = parseKicadSymbolLibrary(LIBRARY)
  return { library, node: library.symbols.get('Gate')!._node }
}

const find = (node: SExprList, id: string): SymbolItem => {
  const found = resolveSymbolItem(symbolItems(node), id)
  if (!found.ok) throw new Error(found.detail)
  return found.item
}

/** Lines of `after` that differ from `before`, compared position by position. */
const changedLines = (before: string, after: string): string[] => {
  const a = before.split('\n')
  const b = after.split('\n')
  return b.filter((line, index) => a[index] !== line)
}

/** Reparse, so the reads below see what a save would have written. */
const reread = (library: KicadSymbolLibrary): SExprList =>
  parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get('Gate')!._node

describe('symbolItems', () => {
  test('the fixture round-trips byte for byte', () => {
    const { library } = load()
    expect(serializeKicadSymbolLibrary(library)).toBe(LIBRARY)
  })

  test('ids: by number, by unit and style when shared, by address when still ambiguous', () => {
    const ids = symbolItems(load().node).map((item) => item.id)
    expect(ids).toEqual([
      'pin:1@1.1',
      'pin:2@1.1',
      'pin:1@1.2',
      'pin:2@1.2',
      'pin@2.1.0',
      'pin@2.1.1',
      'pin:5',
      'rect:0.1.0',
      'circle:0.1.1',
      'text:0.1.2',
      'text_box:0.1.3',
      'polyline:1.1.0',
      'arc:1.2.0',
      'bezier:2.1.0',
      'field:Reference',
      'field:Value',
      'field:Footprint',
      'field:Datasheet',
      'field:Description',
      'symbol'
    ])
  })

  test('an ambiguous pin number lists its candidates; aliases resolve', () => {
    const items = symbolItems(load().node)
    const ambiguous = resolveSymbolItem(items, 'pin:1')
    expect(ambiguous).toMatchObject({ ok: false, error: 'item-not-found' })
    expect(!ambiguous.ok && ambiguous.candidates).toEqual(['pin:1@1.1', 'pin:1@1.2'])
    const stacked = resolveSymbolItem(items, 'pin:4')
    expect(!stacked.ok && stacked.candidates).toEqual(['pin@2.1.0', 'pin@2.1.1'])
    expect(resolveSymbolItem(items, 'pin:5@2.1')).toMatchObject({ ok: true })
    expect(resolveSymbolItem(items, 'pin@2.1.2')).toMatchObject({ ok: true, item: { id: 'pin:5' } })
    const missing = resolveSymbolItem(items, 'field:Valu')
    expect(missing).toMatchObject({ ok: false, error: 'item-not-found' })
    expect(!missing.ok && missing.candidates).toContain('field:Value')
  })

  test('records read y down, in millimeters', () => {
    const { node } = load()
    expect(symbolItemRow(find(node, 'pin:1@1.1'))).toMatchObject({
      number: '1',
      name: 'A',
      type: 'input',
      shape: 'line',
      at: { x: -7.62, y: -2.54 },
      angle: 0,
      length: 2.54,
      hidden: false,
      unit: 1,
      style: 1,
      nameSize: 1.27,
      numberSize: 1.27,
      box: { x: -7.62, y: -2.54, width: 2.54, height: 0 }
    })
    expect(find(node, 'pin:5').record).toMatchObject({
      at: { x: 0, y: 10.16 },
      angle: 90,
      nameSize: 0.8
    })
    expect(find(node, 'rect:0.1.0').record).toEqual({
      start: { x: -5.08, y: -5.08 },
      end: { x: 5.08, y: 5.08 },
      width: 0.254,
      strokeType: 'default',
      strokeColor: null,
      fill: 'background',
      fillColor: null,
      unit: 0,
      style: 1
    })
    expect(find(node, 'circle:0.1.1').record).toMatchObject({ center: { x: 0, y: 0 }, radius: 1 })
    expect(find(node, 'text:0.1.2').record).toEqual({
      text: 'G',
      at: { x: 1, y: -2 },
      angle: 90,
      size: 1.27,
      thickness: null,
      bold: false,
      italic: false,
      justify: 'center',
      verticalJustify: 'center',
      color: null,
      unit: 0,
      style: 1
    })
    expect(find(node, 'text_box:0.1.3').record).toMatchObject({
      text: 'note',
      start: { x: -2, y: -3 },
      end: { x: 2, y: -1 },
      angle: 0,
      size: 1
    })
    expect(find(node, 'arc:1.2.0').record).toMatchObject({ mid: { x: 0, y: -1 }, style: 2 })
    expect(find(node, 'field:Value').record).toEqual({
      key: 'Value',
      value: 'Gate',
      at: { x: 0, y: 7.62 },
      angle: 0,
      hidden: false,
      showName: false,
      doNotAutoplace: false,
      private: false,
      size: 1.27,
      thickness: null,
      bold: false,
      italic: false,
      justify: 'left',
      verticalJustify: 'center',
      color: null
    })
    expect(find(node, 'field:Footprint').box).toBeNull()
  })

  test('a pin written back with the at it read leaves the file unchanged', () => {
    const { library, node } = load()
    const pin = find(node, 'pin:5')
    expect(updateSymbolItem(node, pin, { at: pin.record.at, angle: pin.record.angle })).toEqual({
      ok: true
    })
    expect(serializeKicadSymbolLibrary(library)).toBe(LIBRARY)
  })

  test('an edit changes only the edited pin', () => {
    const { library, node } = load()
    const before = serializeKicadSymbolLibrary(library)
    const pin = find(node, 'pin:5')
    expect(updateSymbolItem(node, pin, { at: { x: 2.54, y: 12.7 }, name: 'VSS' })).toEqual({
      ok: true
    })
    const after = serializeKicadSymbolLibrary(library)
    expect(changedLines(before, after).map((line) => line.trim())).toEqual([
      '(at 2.54 -12.7 90)',
      '(name "VSS"'
    ])
    expect(find(reread(library), 'pin:5').record).toMatchObject({
      at: { x: 2.54, y: 12.7 },
      name: 'VSS'
    })
  })

  test('pin update: every writable key, read back', () => {
    const { library, node } = load()
    const result = updateSymbolItem(node, find(node, 'pin:5'), {
      number: '6',
      type: 'power_out',
      shape: 'inverted',
      angle: 270,
      length: 5.08,
      hidden: true,
      nameSize: 1,
      numberSize: 1.5
    })
    expect(result).toEqual({ ok: true })
    expect(find(reread(library), 'pin:6').record).toMatchObject({
      number: '6',
      type: 'power_out',
      shape: 'inverted',
      angle: 270,
      length: 5.08,
      hidden: true,
      nameSize: 1,
      numberSize: 1.5
    })
  })

  test('update refusals', () => {
    const { library, node } = load()
    const before = serializeKicadSymbolLibrary(library)
    const pin = find(node, 'pin:1@1.1')
    expect(updateSymbolItem(node, pin, { number: '2' })).toMatchObject({
      ok: false,
      error: 'refused'
    })
    expect(updateSymbolItem(node, pin, { unit: 4 })).toMatchObject({
      ok: false,
      error: 'refused'
    })
    expect(updateSymbolItem(node, pin, { style: 2 })).toMatchObject({
      ok: false,
      error: 'refused'
    })
    expect(updateSymbolItem(node, pin, { color: 'red' })).toMatchObject({
      ok: false,
      error: 'not-applicable',
      detail: expect.stringContaining('color')
    })
    expect(updateSymbolItem(node, pin, { angle: 45 })).toMatchObject({ error: 'invalid-record' })
    expect(updateSymbolItem(node, pin, { at: { x: 1 } })).toMatchObject({ error: 'invalid-record' })
    expect(updateSymbolItem(node, pin, { type: 'analog' })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateSymbolItem(node, pin, {})).toMatchObject({ error: 'invalid-record' })
    expect(updateSymbolItem(node, find(node, 'field:Value'), { key: 'X' })).toMatchObject({
      error: 'refused'
    })
    expect(updateSymbolItem(node, find(node, 'symbol'), { styles: 2 })).toMatchObject({
      error: 'not-applicable'
    })
    expect(updateSymbolItem(node, find(node, 'symbol'), { unitNames: ['A'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateSymbolItem(node, find(node, 'rect:0.1.0'), { strokeColor: 'red' })).toMatchObject({
      error: 'invalid-record'
    })
    expect(
      updateSymbolItem(node, find(node, 'bezier:2.1.0'), {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ]
      })
    ).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateSymbolItem(node, find(node, 'rect:0.1.0'), { fill: 'solid' })).toMatchObject({
      error: 'invalid-record'
    })
    // The same number in another body style is not a duplicate.
    expect(updateSymbolItem(node, find(node, 'pin:5'), { number: '1' })).toEqual({ ok: true })
    expect(changedLines(before, serializeKicadSymbolLibrary(library))).toHaveLength(1)
  })

  test('graphic and field updates, read back', () => {
    const { library, node } = load()
    const ok = { ok: true }
    expect(
      updateSymbolItem(node, find(node, 'rect:0.1.0'), {
        end: { x: 6, y: 6 },
        fill: 'none',
        width: 0.1
      })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'circle:0.1.1'), { radius: 2, center: { x: 1, y: 1 } })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'text:0.1.2'), { text: 'H', angle: 0, size: 2 })
    ).toEqual(ok)
    expect(updateSymbolItem(node, find(node, 'text_box:0.1.3'), { end: { x: 4, y: 1 } })).toEqual(
      ok
    )
    expect(
      updateSymbolItem(node, find(node, 'polyline:1.1.0'), {
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 3 }
        ]
      })
    ).toEqual(ok)
    expect(updateSymbolItem(node, find(node, 'arc:1.2.0'), { mid: { x: 0, y: 2 } })).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'bezier:2.1.0'), {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: -1 },
          { x: 2, y: -1 },
          { x: 3, y: 0 }
        ]
      })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'field:Reference'), {
        value: 'IC',
        at: { x: 1, y: -9 },
        angle: 90,
        size: 1,
        hidden: true,
        justify: 'right'
      })
    ).toEqual(ok)
    expect(updateSymbolItem(node, find(node, 'field:Footprint'), { hidden: false })).toEqual(ok)

    const again = reread(library)
    expect(find(again, 'rect:0.1.0').record).toMatchObject({
      start: { x: -5.08, y: -5.08 },
      end: { x: 6, y: 6 },
      fill: 'none',
      width: 0.1
    })
    expect(find(again, 'circle:0.1.1').record).toMatchObject({ center: { x: 1, y: 1 }, radius: 2 })
    expect(find(again, 'text:0.1.2').record).toMatchObject({ text: 'H', angle: 0, size: 2 })
    expect(find(again, 'text_box:0.1.3').record).toMatchObject({
      start: { x: -2, y: -3 },
      end: { x: 4, y: 1 }
    })
    expect(find(again, 'polyline:1.1.0').record).toMatchObject({
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 3 }
      ]
    })
    expect(find(again, 'arc:1.2.0').record).toMatchObject({ mid: { x: 0, y: 2 } })
    expect(find(again, 'bezier:2.1.0').record).toMatchObject({
      points: [
        { x: 0, y: 0 },
        { x: 1, y: -1 },
        { x: 2, y: -1 },
        { x: 3, y: 0 }
      ]
    })
    expect(find(again, 'field:Reference').record).toMatchObject({
      key: 'Reference',
      value: 'IC',
      at: { x: 1, y: -9 },
      angle: 90,
      size: 1,
      hidden: true,
      justify: 'right'
    })
    expect(find(again, 'field:Footprint').record).toMatchObject({ hidden: false })
    // The file stores y up.
    expect(serializeKicadSymbolLibrary(library)).toContain('(at 1 9 90)')
  })

  test('create: each kind lands where asked and answers with its id', () => {
    const { library, node } = load()
    const created = (
      kind: Parameters<typeof createSymbolItem>[1],
      record: Record<string, unknown>
    ): string => {
      const result = createSymbolItem(node, kind, record)
      if (!result.ok) throw new Error(result.detail)
      return result.id
    }
    expect(
      created('pin', {
        number: '7',
        name: 'B',
        at: { x: -7.62, y: 2.54 },
        type: 'input',
        hidden: true
      })
    ).toBe('pin:7')
    expect(created('pin', { number: '8', at: { x: 0, y: 0 }, unit: 2, style: 2 })).toBe('pin:8')
    expect(
      created('polyline', {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ],
        width: 0.2
      })
    ).toBe('polyline:1.1.1')
    expect(
      created('bezier', {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 3, y: 0 }
        ],
        unit: 0
      })
    ).toBe('bezier:0.1.4')
    expect(
      created('rect', { start: { x: -1, y: -1 }, end: { x: 1, y: 1 }, fill: 'background' })
    ).toBe('rect:1.1.2')
    expect(created('circle', { center: { x: 0, y: 0 }, radius: 0.5 })).toBe('circle:1.1.3')
    expect(
      created('arc', {
        start: { x: -1, y: 0 },
        mid: { x: 0, y: -1 },
        end: { x: 1, y: 0 },
        style: 2
      })
    ).toBe('arc:1.2.1')
    expect(created('text', { text: 'T', at: { x: 0, y: 3 }, angle: 90, size: 1 })).toBe(
      'text:1.1.4'
    )
    expect(created('text_box', { text: 'box', start: { x: 0, y: 0 }, end: { x: 3, y: 2 } })).toBe(
      'text_box:1.1.5'
    )
    expect(created('field', { key: 'MPN', value: 'X1', at: { x: 0, y: 12 }, hidden: true })).toBe(
      'field:MPN'
    )

    const again = reread(library)
    expect(find(again, 'pin:7').record).toMatchObject({
      number: '7',
      name: 'B',
      at: { x: -7.62, y: 2.54 },
      type: 'input',
      shape: 'line',
      length: 2.54,
      hidden: true,
      unit: 1,
      style: 1
    })
    expect(find(again, 'pin:8').record).toMatchObject({ unit: 2, style: 2, type: 'passive' })
    expect(find(again, 'polyline:1.1.1').record).toMatchObject({ width: 0.2, fill: 'none' })
    expect(find(again, 'rect:1.1.2').record).toMatchObject({
      start: { x: -1, y: -1 },
      fill: 'background'
    })
    expect(find(again, 'arc:1.2.1').record).toMatchObject({ mid: { x: 0, y: -1 } })
    expect(find(again, 'text:1.1.4').record).toMatchObject({
      at: { x: 0, y: 3 },
      angle: 90,
      size: 1
    })
    expect(find(again, 'text_box:1.1.5').record).toMatchObject({
      start: { x: 0, y: 0 },
      end: { x: 3, y: 2 }
    })
    expect(find(again, 'field:MPN').record).toMatchObject({
      value: 'X1',
      at: { x: 0, y: 12 },
      hidden: true
    })
    // A new body style went in a sub-symbol named for it; no stray one was left.
    const text = serializeKicadSymbolLibrary(library)
    expect(text).toContain('(symbol "Gate_2_2"')
    expect(text.match(/\(symbol "Gate_2_1"/g)).toHaveLength(1)
  })

  test('create refusals', () => {
    const { library, node } = load()
    const before = serializeKicadSymbolLibrary(library)
    expect(createSymbolItem(node, 'pin', { number: '1', at: { x: 0, y: 0 } })).toMatchObject({
      error: 'refused'
    })
    expect(createSymbolItem(node, 'pin', { at: { x: 0, y: 0 } })).toMatchObject({
      error: 'invalid-record',
      detail: 'A new pin needs number.'
    })
    expect(
      createSymbolItem(node, 'pin', { number: '9', at: { x: 0, y: 0 }, unit: 5 })
    ).toMatchObject({ error: 'refused' })
    expect(createSymbolItem(node, 'field', { key: 'Value' })).toMatchObject({ error: 'refused' })
    expect(createSymbolItem(node, 'field', { key: 'ki_fp_filters' })).toMatchObject({
      error: 'not-applicable'
    })
    expect(createSymbolItem(node, 'field', { key: 'X', unit: 1 })).toMatchObject({
      error: 'not-applicable'
    })
    expect(createSymbolItem(node, 'circle', { center: { x: 0, y: 0 }, radius: 0 })).toMatchObject({
      error: 'invalid-record'
    })
    expect(serializeKicadSymbolLibrary(library)).toBe(before)
  })

  test('create in a schematic copy names sub-symbols after the bare symbol', () => {
    const copy = parseSExpr(`(symbol "Lib:Gate"
  (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (symbol "Gate_1_1"
    (pin input line (at 0 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
  )
)`) as SExprList
    expect(createSymbolItem(copy, 'pin', { number: '2', at: { x: 0, y: 2.54 } })).toEqual({
      ok: true,
      id: 'pin:2'
    })
    expect(createSymbolItem(copy, 'pin', { number: '3', at: { x: 0, y: 5.08 }, unit: 2 })).toEqual({
      ok: true,
      id: 'pin:3'
    })
    const names = parseLibSymbol(copy).variants.map((variant) => [
      variant.unit,
      variant.style,
      variant.pins.length
    ])
    expect(names).toEqual([
      [1, 1, 2],
      [2, 1, 1]
    ])
    expect(JSON.stringify(copy)).not.toContain('Lib:Gate_')
  })

  test('delete: atomic, and the mandatory fields stay', () => {
    const { library, node } = load()
    const before = serializeKicadSymbolLibrary(library)
    const refused = deleteSymbolItems(node, [find(node, 'pin:5'), find(node, 'field:Datasheet')])
    expect(refused).toMatchObject({
      ok: false,
      error: 'refused',
      detail: expect.stringContaining('hidden')
    })
    expect(serializeKicadSymbolLibrary(library)).toBe(before)

    expect(createSymbolItem(node, 'field', { key: 'MPN', value: 'X' })).toMatchObject({ ok: true })
    const doomed = [
      'pin:5',
      'pin@2.1.0',
      'rect:0.1.0',
      'text_box:0.1.3',
      'arc:1.2.0',
      'field:MPN'
    ].map((id) => find(node, id))
    expect(deleteSymbolItems(node, doomed)).toEqual({ ok: true })
    const ids = symbolItems(reread(library)).map((item) => item.id)
    expect(ids).not.toContain('pin:5')
    expect(ids).not.toContain('field:MPN')
    expect(ids).toContain('pin:4')
    expect(ids).toContain('circle:0.1.0')
    expect(ids).toContain('text:0.1.1')
    expect(ids.filter((id) => id.startsWith('arc'))).toEqual([])
  })

  test('the symbol record reads Symbol Properties', () => {
    expect(find(load().node, 'symbol').record).toEqual({
      name: 'Gate',
      power: 'none',
      inBom: true,
      onBoard: true,
      inPositionFiles: true,
      excludeFromSim: false,
      duplicatePinNumbersAreJumpers: false,
      showPinNames: true,
      showPinNumbers: true,
      pinNameOffset: 0.254,
      description: 'A gate',
      keywords: 'logic',
      datasheet: '',
      footprintFilters: [],
      units: 2,
      unitNames: ['', ''],
      unitsInterchangeable: true,
      styles: 2
    })
  })

  test('the symbol record writes back through the panel writers', () => {
    const { library, node } = load()
    const result = updateSymbolItem(node, find(node, 'symbol'), {
      name: 'Gate2',
      power: 'local',
      inBom: false,
      excludeFromSim: true,
      duplicatePinNumbersAreJumpers: true,
      showPinNames: false,
      showPinNumbers: false,
      pinNameOffset: 0.5,
      description: 'Two inputs',
      keywords: 'logic nand',
      datasheet: 'https://example.com/ds.pdf',
      footprintFilters: ['SOIC*', 'TSSOP*'],
      units: 3,
      unitNames: ['A', '', 'PWR'],
      unitsInterchangeable: false
    })
    expect(result).toEqual({ ok: true })
    const again = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    const renamed = again.symbols.get('Gate2')!._node
    expect(find(renamed, 'symbol').record).toMatchObject({
      name: 'Gate2',
      power: 'local',
      inBom: false,
      excludeFromSim: true,
      duplicatePinNumbersAreJumpers: true,
      showPinNames: false,
      showPinNumbers: false,
      pinNameOffset: 0.5,
      description: 'Two inputs',
      keywords: 'logic nand',
      datasheet: 'https://example.com/ds.pdf',
      footprintFilters: ['SOIC*', 'TSSOP*'],
      units: 3,
      unitNames: ['A', '', 'PWR'],
      unitsInterchangeable: false
    })
    // Fewer units drops the last ones with their items.
    expect(updateSymbolItem(renamed, find(renamed, 'symbol'), { units: 1 })).toEqual({ ok: true })
    expect(symbolItems(renamed).some((item) => item.record.unit === 2)).toBe(false)
    expect(find(renamed, 'symbol').record).toMatchObject({ units: 1, unitNames: ['A'] })
  })

  test('style keys on graphics, text, text boxes and fields, read back', () => {
    const { library, node } = load()
    const ok = { ok: true }
    expect(
      updateSymbolItem(node, find(node, 'rect:0.1.0'), {
        strokeType: 'dash',
        strokeColor: '#ff000080',
        fillColor: '#00ff00'
      })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'text:0.1.2'), {
        bold: true,
        italic: true,
        justify: 'left',
        verticalJustify: 'top',
        color: '#112233',
        thickness: 0.3
      })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'text_box:0.1.3'), {
        margins: { left: 1 },
        strokeType: 'dot',
        verticalJustify: 'bottom'
      })
    ).toEqual(ok)
    expect(
      updateSymbolItem(node, find(node, 'field:Value'), {
        showName: true,
        doNotAutoplace: true,
        bold: true,
        color: '#abcdef'
      })
    ).toEqual(ok)
    const again = reread(library)
    expect(find(again, 'rect:0.1.0').record).toMatchObject({
      strokeType: 'dash',
      strokeColor: '#ff000080',
      fill: 'color',
      fillColor: '#00ff00'
    })
    expect(find(again, 'text:0.1.2').record).toMatchObject({
      bold: true,
      italic: true,
      justify: 'left',
      verticalJustify: 'top',
      color: '#112233',
      thickness: 0.3
    })
    expect(find(again, 'text_box:0.1.3').record).toMatchObject({
      margins: { left: 1, top: 0.3175, right: 0.3175, bottom: 0.3175 },
      strokeType: 'dot',
      verticalJustify: 'bottom'
    })
    expect(find(again, 'field:Value').record).toMatchObject({
      showName: true,
      doNotAutoplace: true,
      bold: true,
      color: '#abcdef'
    })
    // null clears back to the theme.
    expect(updateSymbolItem(again, find(again, 'rect:0.1.0'), { strokeColor: null })).toEqual(ok)
    expect(find(again, 'rect:0.1.0').record).toMatchObject({ strokeColor: null })
  })

  test('pin alternates are written whole and read back', () => {
    const { library, node } = load()
    const alternates = [
      { name: 'SDA', type: 'bidirectional', shape: 'line' },
      { name: 'TX', type: 'output', shape: 'line' }
    ]
    expect(updateSymbolItem(node, find(node, 'pin:5'), { alternates })).toEqual({ ok: true })
    expect(find(reread(library), 'pin:5').record.alternates).toEqual(alternates)
    expect(updateSymbolItem(node, find(node, 'pin:5'), { alternates: [{ name: 'SDA' }] })).toEqual({
      ok: true
    })
    expect(find(reread(library), 'pin:5').record.alternates).toEqual([
      { name: 'SDA', type: 'passive', shape: 'line' }
    ])
    expect(
      updateSymbolItem(node, find(node, 'pin:5'), { alternates: [{ name: 'A' }, { name: 'A' }] })
    ).toMatchObject({ error: 'invalid-record' })
    expect(updateSymbolItem(node, find(node, 'pin:5'), { alternates: [] })).toEqual({ ok: true })
    expect(find(reread(library), 'pin:5').record.alternates).toBeUndefined()
  })

  test('a part moves between units and body styles; jumpers allow a repeated number', () => {
    const { library, node } = load()
    expect(updateSymbolItem(node, find(node, 'pin:5'), { unit: 1, style: 2 })).toEqual({
      ok: true
    })
    expect(find(reread(library), 'pin:5').record).toMatchObject({ unit: 1, style: 2 })
    expect(updateSymbolItem(node, find(node, 'circle:0.1.1'), { unit: 2 })).toEqual({ ok: true })
    expect(find(reread(library), 'circle:2.1.1')).toBeTruthy()
    // Pin 2 already exists in unit 1, style 2.
    expect(updateSymbolItem(node, find(node, 'pin:5'), { number: '2' })).toMatchObject({
      error: 'refused'
    })
    updateSymbolItem(node, find(node, 'symbol'), { duplicatePinNumbersAreJumpers: true })
    expect(updateSymbolItem(node, find(node, 'pin:5'), { number: '2' })).toEqual({ ok: true })
  })

  test('a user field is renamed by its key', () => {
    const { library, node } = load()
    expect(createSymbolItem(node, 'field', { key: 'MPN', value: 'X' })).toMatchObject({ ok: true })
    expect(updateSymbolItem(node, find(node, 'field:MPN'), { key: 'PartNumber' })).toEqual({
      ok: true
    })
    expect(find(reread(library), 'field:PartNumber').record).toMatchObject({ value: 'X' })
    expect(updateSymbolItem(node, find(node, 'field:PartNumber'), { key: 'Value' })).toMatchObject({
      error: 'refused'
    })
  })

  test('the definition is neither created nor deleted as an item', () => {
    const { node } = load()
    expect(createSymbolItem(node, 'symbol', {})).toMatchObject({ error: 'not-applicable' })
    expect(deleteSymbolItems(node, [find(node, 'symbol')])).toMatchObject({
      error: 'not-applicable'
    })
  })

  test('query: kind, unit, number, box, near and limit combine', () => {
    const items = symbolItems(load().node)
    const ids = (query: Parameters<typeof querySymbolItems>[1]): string[] =>
      querySymbolItems(items, query).rows.map((item) => item.id)
    expect(ids({ kind: 'pin', unit: 1 })).toEqual([
      'pin:1@1.1',
      'pin:2@1.1',
      'pin:1@1.2',
      'pin:2@1.2'
    ])
    expect(ids({ number: '4' })).toEqual(['pin@2.1.0', 'pin@2.1.1'])
    expect(ids({ unit: 0 })).toEqual(['rect:0.1.0', 'circle:0.1.1', 'text:0.1.2', 'text_box:0.1.3'])
    // Pin 5 points up from y = 10.16 (y down) to 7.62.
    expect(ids({ kind: 'pin', box: { x: -1, y: 7, width: 2, height: 1 } })).toEqual(['pin:5'])
    expect(ids({ kind: 'pin', near: { x: 0, y: -10.16 } })).toEqual(['pin@2.1.0', 'pin@2.1.1'])
    expect(ids({ kind: 'pin', near: { x: 0, y: -12 }, radius: 0.5 })).toEqual([])
    const limited = querySymbolItems(items, { kind: 'field', limit: 2 })
    expect(limited.rows).toHaveLength(2)
    expect(limited.total).toBe(5)
    expect(querySymbolItems(items, { limit: 10_000 }).rows).toHaveLength(items.length)
  })
})
