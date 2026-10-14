import { describe, expect, it } from 'vitest'
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  updateCircleInAST,
  updateCurveInAST,
  updateFootprintMetaInAST,
  updatePadInAST,
  updatePropertyInAST,
  updateRectInAST,
  updateTableInAST,
  updateTextBoxInAST,
  updateZoneInAST,
  type TextBoxPatch,
  updatePointInAST
} from '../../kicad/footprint'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  buildFootprintGroups,
  FOOTPRINT_ITEM_COLLECTIONS,
  footprintCollection,
  footprintLayerOptions,
  footprintPatch,
  ZONE_CONNECT_INHERIT,
  type FootprintContext
} from '../footprintPropertySchema'
import { isMixed, type PropertyField } from '../../propertyTable'

const t = (key: string): string => key
const ctx: FootprintContext = { layers: footprintLayerOptions() }

const FP = `(footprint "T"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (attr smd exclude_from_bom)
  (fp_line (start 0 0) (end 1 -0.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_text user "hi" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" thru_hole roundrect (at 2 -1 90) (size 1.5 1.5) (drill 0.6) (roundrect_rratio 0.25)
    (layers "*.Cu" "*.Mask"))
  (pad "2" smd rect (at -2 -1) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
)
`

type Groups = ReturnType<typeof buildFootprintGroups>
const fp = (): ReturnType<typeof parseKicadFootprint> => parseKicadFootprint(FP)
const group = (g: Groups, type: string): Groups[number] | undefined =>
  g.find((x) => x.type === type)
const fieldValue = (g: Groups, type: string, key: string): unknown =>
  group(g, type)?.fields.find((f) => f.key === key)?.value
const hasField = (g: Groups, type: string, key: string): boolean =>
  !!group(g, type)?.fields.some((f) => f.key === key)

describe('buildFootprintGroups', () => {
  it('shows the footprint group only when nothing is selected', () => {
    const groups = buildFootprintGroups(fp(), [], t, ctx)
    expect(groups.map((g) => g.type)).toEqual(['footprint'])
    expect(fieldValue(groups, 'footprint', 'name')).toBe('T')
    expect(fieldValue(groups, 'footprint', 'locked')).toBe(false)
    expect(fieldValue(groups, 'footprint', 'attr:smd')).toBe(true)
    expect(fieldValue(groups, 'footprint', 'attr:dnp')).toBe(false)
  })

  it('builds a pad group with Y-down raw coords and gated rows', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'pad', index: 0 }], t, ctx)
    expect(groups.map((g) => g.type)).toEqual(['pad'])
    expect(fieldValue(groups, 'pad', 'posY')).toBe(mm(-1)) // raw KiCad Y (negate is display-only)
    expect(fieldValue(groups, 'pad', 'angle')).toBe(90)
    // thru_hole roundrect → drill + roundRatio rows present
    expect(hasField(groups, 'pad', 'drill')).toBe(true)
    expect(hasField(groups, 'pad', 'roundRatio')).toBe(true)
  })

  it('hides drill/roundRatio for an smd rect pad', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'pad', index: 1 }], t, ctx)
    expect(hasField(groups, 'pad', 'drill')).toBe(false)
    expect(hasField(groups, 'pad', 'roundRatio')).toBe(false)
  })

  it('collapses agreeing values and marks disagreements MIXED', () => {
    const groups = buildFootprintGroups(
      fp(),
      [
        { type: 'pad', index: 0 },
        { type: 'pad', index: 1 }
      ],
      t,
      ctx
    )
    expect(group(groups, 'pad')?.count).toBe(2)
    expect(fieldValue(groups, 'pad', 'posY')).toBe(mm(-1)) // both agree
    expect(isMixed(fieldValue(groups, 'pad', 'number'))).toBe(true) // "1" vs "2"
    expect(isMixed(fieldValue(groups, 'pad', 'type'))).toBe(true) // thru_hole vs smd
  })

  it('builds a text group with font effects', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'text', index: 0 }], t, ctx)
    expect(fieldValue(groups, 'text', 'text')).toBe('hi')
    expect(fieldValue(groups, 'text', 'bold')).toBe(false)
    expect(fieldValue(groups, 'text', 'hAlign')).toBe('center')
  })

  it('builds a field group for a (property …), its value as the text row', () => {
    const withFields = parseKicadFootprint(`(footprint "T"
  (version 20240108)
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "T" (at 0 2 0) (layer "F.Fab") hide (effects (font (size 1 1) (thickness 0.15))))
)`)
    const groups = buildFootprintGroups(withFields, [{ type: 'property', index: 0 }], t, ctx)
    expect(groups.map((g) => g.type)).toEqual(['property'])
    expect(group(groups, 'property')?.title).toBe('shared.primitives.field')
    expect(fieldValue(groups, 'property', 'text')).toBe('REF**')
    expect(fieldValue(groups, 'property', 'layer')).toBe('F.SilkS')
    expect(fieldValue(groups, 'property', 'posY')).toBe(mm(-2))
    expect(footprintPatch('property', 'text', 'U1', withFields.properties[0])).toEqual({
      value: 'U1'
    })
    const both = buildFootprintGroups(
      withFields,
      [
        { type: 'property', index: 0 },
        { type: 'property', index: 1 }
      ],
      t,
      ctx
    )
    expect(isMixed(fieldValue(both, 'property', 'hidden'))).toBe(true)
  })

  it('gives a field KiCad’s text rows: name, width, height, thickness, knockout, keep upright', () => {
    const withFields = parseKicadFootprint(`(footprint "T"
  (version 20240108)
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1.2) (thickness 0.15))))
)`)
    const groups = buildFootprintGroups(withFields, [{ type: 'property', index: 0 }], t, ctx)
    expect(fieldValue(groups, 'property', 'name')).toBe('Reference')
    expect(fieldValue(groups, 'property', 'textHeight')).toBe(mm(1))
    expect(fieldValue(groups, 'property', 'textWidth')).toBe(mm(1.2))
    expect(fieldValue(groups, 'property', 'thickness')).toBe(mm(0.15))
    expect(fieldValue(groups, 'property', 'knockout')).toBe(false)
    expect(fieldValue(groups, 'property', 'keepUpright')).toBe(true)
    expect(fieldValue(groups, 'property', 'mirror')).toBe(false)
  })

  it('writes thickness, knockout and keep upright where KiCad does', () => {
    const footprint = parseKicadFootprint(`(footprint "T"
  (version 20240108)
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
)`)
    const prop = footprint.properties[0]
    for (const [key, value] of [
      ['thickness', mm(0.2)],
      ['knockout', true],
      ['keepUpright', false]
    ] as const) {
      updatePropertyInAST(prop, footprintPatch('property', key, value, prop))
    }
    const text = serializeKicadFootprint(footprint)
    expect(text).toMatch(/\(at 0 -2 0\)\s*\(unlocked yes\)\s*\(layer "F\.SilkS" knockout\)/)
    const back = parseKicadFootprint(text).properties[0]
    expect(back.fontEffects?.thickness).toBe(mm(0.2))
    expect(back.knockout).toBe(true)
    expect(back.keepUpright).toBe(false)
    updatePropertyInAST(prop, { knockout: false, keepUpright: true })
    expect(serializeKicadFootprint(footprint)).not.toMatch(/unlocked|knockout/)
  })

  it('shows Hidden on fields only, as KiCad writes hide on nothing else', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'text', index: 0 }], t, ctx)
    expect(group(groups, 'text')?.fields.some((f) => f.key === 'hidden')).toBe(false)
  })

  it('exposes stroke type/color + layer on a line', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'line', index: 0 }], t, ctx)
    expect(fieldValue(groups, 'line', 'strokeType')).toBe('solid')
    expect(fieldValue(groups, 'line', 'strokeColor')).toBeNull() // no explicit color
    expect(fieldValue(groups, 'line', 'layer')).toBe('F.SilkS')
  })
})

describe('footprintPatch', () => {
  it('maps coordinate keys into nested patches', () => {
    expect(footprintPatch('pad', 'posX', 3, null)).toEqual({ position: { x: 3 } })
    expect(footprintPatch('line', 'startY', -2, null)).toEqual({ start: { y: -2 } })
    expect(footprintPatch('pad', 'width', 1.2, null)).toEqual({ size: { w: 1.2 } })
    expect(footprintPatch('pad', 'drill', 0.8, null)).toEqual({ drill: { diameter: 0.8 } })
  })

  it('merges a single text-effect change onto the current effects', () => {
    const text = fp().fpTexts[0]
    const patch = footprintPatch('text', 'bold', true, text) as {
      fontEffects: { bold: boolean; height: number }
    }
    expect(patch.fontEffects.bold).toBe(true)
    expect(patch.fontEffects.height).toBe(mm(1)) // preserved from current
  })

  it('toggles a footprint attribute into the list', () => {
    const footprint = fp()
    expect(footprintPatch('footprint', 'attr:dnp', true, footprint)).toEqual({
      attributes: ['smd', 'exclude_from_bom', 'dnp']
    })
    expect(footprintPatch('footprint', 'attr:smd', false, footprint)).toEqual({
      attributes: ['exclude_from_bom']
    })
    expect(footprintPatch('footprint', 'side', 'B.Cu', footprint)).toEqual({ layer: 'B.Cu' })
  })
})

describe('footprint overrides (keywords, clearance, margins, zone connection)', () => {
  const withOverrides = FP.replace(
    '(attr smd exclude_from_bom)',
    '(tags "SOIC 8")\n  (solder_mask_margin 0.05)\n  (solder_paste_margin_ratio -0.1)\n  (zone_connect 3)\n  (attr smd exclude_from_bom)'
  )

  it('shows blank for an inherited override and the file’s value otherwise', () => {
    const plain = buildFootprintGroups(fp(), [], t, ctx)
    expect(fieldValue(plain, 'footprint', 'keywords')).toBe('')
    expect(fieldValue(plain, 'footprint', 'clearance')).toBeNull()
    expect(fieldValue(plain, 'footprint', 'solderPasteMarginRatio')).toBeNull()
    expect(fieldValue(plain, 'footprint', 'zoneConnect')).toBe(ZONE_CONNECT_INHERIT)

    const groups = buildFootprintGroups(parseKicadFootprint(withOverrides), [], t, ctx)
    expect(fieldValue(groups, 'footprint', 'keywords')).toBe('SOIC 8')
    expect(fieldValue(groups, 'footprint', 'solderMaskMargin')).toBe(mm(0.05))
    expect(fieldValue(groups, 'footprint', 'solderPasteMarginRatio')).toBe(-10)
    expect(fieldValue(groups, 'footprint', 'zoneConnect')).toBe('3')
    const zone = group(groups, 'footprint')?.fields.find((f) => f.key === 'zoneConnect')
    expect(zone?.editor.options?.map((o) => o.value)).toEqual(['inherit', '2', '1', '0', '3'])
  })

  it('maps the edits to the meta patch, blank clearing', () => {
    const footprint = fp()
    expect(footprintPatch('footprint', 'keywords', 'a b', footprint)).toEqual({ tags: 'a b' })
    expect(footprintPatch('footprint', 'clearance', null, footprint)).toEqual({ clearance: null })
    expect(footprintPatch('footprint', 'solderPasteMarginRatio', -5, footprint)).toEqual({
      solderPasteMarginRatio: -0.05
    })
    expect(footprintPatch('footprint', 'zoneConnect', 'inherit', footprint)).toEqual({
      zoneConnect: null
    })
    expect(footprintPatch('footprint', 'zoneConnect', '2', footprint)).toEqual({ zoneConnect: 2 })
  })

  it('writes the rows where KiCad would, and removes them when cleared', () => {
    const footprint = fp()
    updateFootprintMetaInAST(footprint, {
      tags: 'SOIC',
      clearance: mm(0.2),
      solderPasteMarginRatio: -0.05,
      zoneConnect: 2
    })
    const text = serializeKicadFootprint(footprint)
    const order = [
      '(tags "SOIC")',
      '(solder_paste_margin_ratio -0.05)',
      '(clearance 0.2)',
      '(zone_connect 2)',
      '(attr smd'
    ]
    const at = order.map((token) => text.indexOf(token))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const back = parseKicadFootprint(text)
    expect(back.tags).toBe('SOIC')
    expect(back.clearance).toBe(mm(0.2))
    expect(back.zoneConnect).toBe(2)

    updateFootprintMetaInAST(back, { tags: '', clearance: null, zoneConnect: null })
    const cleared = serializeKicadFootprint(back)
    expect(cleared).not.toContain('(tags')
    expect(cleared).not.toContain('(clearance')
    expect(cleared).not.toContain('(zone_connect')
    expect(cleared).toContain('(solder_paste_margin_ratio -0.05)')
  })
})

/** One of every item the footprint editor selects. */
const EVERY_ITEM = `(footprint "T"
  (version 20260206)
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start 0 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_arc (start 0 0) (mid 1 1) (end 2 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_circle (center 0 0) (end 1 0) (stroke (width 0.12) (type solid)) (fill no) (layer "F.SilkS"))
  (fp_rect (start 0 0) (end 1 1) (stroke (width 0.12) (type solid)) (fill no) (layer "F.SilkS"))
  (fp_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (stroke (width 0.12) (type solid)) (fill yes) (layer "F.SilkS"))
  (fp_curve (pts (xy 0 0) (xy 1 -1) (xy 2 1) (xy 3 0)) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_text user "hi" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_text_box "Note" (start -1 -1) (end 4 1) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (table (column_count 2) (layer "F.Fab") (column_widths 10 20) (row_heights 5)
    (cells
      (table_cell "A" (start 0 0) (end 10 5) (layer "F.Fab") (effects (font (size 1 1))))
      (table_cell "B" (start 10 0) (end 30 5) (layer "F.Fab") (effects (font (size 1 1))))))
  (point (at 1 2) (size 0.5) (layer "F.Fab"))
  (pad "1" smd rect (at -2 -1) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)`

describe('every selectable footprint item has a property group', () => {
  it.each(Object.keys(FOOTPRINT_ITEM_COLLECTIONS))('%s', (type) => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    expect(footprintCollection(footprint, type)?.length).toBeGreaterThan(0)
    const groups = buildFootprintGroups(footprint, [{ type, index: 0 }], t, ctx)
    expect(groups.map((g) => g.type)).toEqual([type])
    expect(groups[0].fields.length).toBeGreaterThan(0)
  })

  it('gives a type with no group an empty one, never the footprint group', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'unknown', index: 0 }], t, ctx)
    expect(groups).toEqual([
      { type: 'unknown', title: 'shared.properties.selection', count: 1, fields: [] }
    ])
  })

  it('edits a curve’s stroke and a point’s position and size in place', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const curve = footprint.fpCurves[0]
    updateCurveInAST(curve, footprintPatch('curve', 'strokeWidth', mm(0.3), curve))
    const point = footprint.points[0]
    updatePointInAST(point, footprintPatch('point', 'posY', mm(-3), point))
    updatePointInAST(point, footprintPatch('point', 'size', mm(2), point))
    const back = parseKicadFootprint(serializeKicadFootprint(footprint))
    expect(back.fpCurves[0].strokeWidth).toBe(mm(0.3))
    expect(back.points[0].position).toEqual({ x: mm(1), y: mm(-3) })
    expect(back.points[0].size).toBe(mm(2))
  })
})

describe('KiCad’s rows and sections', () => {
  const rowOf = (g: Groups, type: string, key: string): PropertyField | undefined =>
    group(g, type)?.fields.find((f) => f.key === key)

  it('groups a pad’s rows as KiCad does, overrides blank until set', () => {
    const groups = buildFootprintGroups(fp(), [{ type: 'pad', index: 0 }], t, ctx)
    expect(rowOf(groups, 'pad', 'posX')?.section).toBeUndefined()
    expect(rowOf(groups, 'pad', 'number')?.section).toBe('pad')
    expect(rowOf(groups, 'pad', 'holeShape')?.section).toBe('hole')
    expect(fieldValue(groups, 'pad', 'holeShape')).toBe('circle')
    expect(rowOf(groups, 'pad', 'clearance')?.section).toBe('overrides')
    expect(fieldValue(groups, 'pad', 'clearance')).toBeNull()
  })

  it('writes and clears a pad override, and makes a hole oblong', () => {
    const footprint = fp()
    const pad = footprint.pads[0]
    updatePadInAST(pad, footprintPatch('pad', 'clearance', mm(0.2), pad))
    updatePadInAST(pad, footprintPatch('pad', 'solderPasteMarginRatio', -10, pad))
    updatePadInAST(pad, footprintPatch('pad', 'holeShape', 'oblong', pad))
    updatePadInAST(pad, footprintPatch('pad', 'drillY', mm(1.2), pad))
    let back = parseKicadFootprint(serializeKicadFootprint(footprint)).pads[0]
    expect(back.clearance).toBe(mm(0.2))
    expect(back.solderPasteMarginRatio).toBe(-0.1)
    expect(back.drill?.oval).toEqual({ width: mm(0.6), height: mm(1.2) })
    updatePadInAST(pad, footprintPatch('pad', 'clearance', null, pad))
    back = parseKicadFootprint(serializeKicadFootprint(footprint)).pads[0]
    expect(back.clearance).toBeUndefined()
  })

  it('shows a circle’s radius and a rectangle’s size, and writes them back', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const circle = buildFootprintGroups(footprint, [{ type: 'circle', index: 0 }], t, ctx)
    expect(fieldValue(circle, 'circle', 'radius')).toBe(mm(1))
    expect(rowOf(circle, 'circle', 'radius')?.section).toBe('shape')
    expect(rowOf(circle, 'circle', 'layer')?.section).toBeUndefined()
    const c = footprint.fpCircles[0]
    updateCircleInAST(c, footprintPatch('circle', 'radius', mm(2), c))
    expect(c.end).toEqual({ x: mm(2), y: mm(0) })
    const r = footprint.fpRects[0]
    updateRectInAST(r, footprintPatch('rect', 'rectWidth', mm(3), r))
    updateRectInAST(r, footprintPatch('rect', 'cornerRadius', mm(0.25), r))
    updateRectInAST(r, footprintPatch('rect', 'strokeType', 'dash', r))
    const back = parseKicadFootprint(serializeKicadFootprint(footprint)).fpRects[0]
    expect(back.end.x).toBe(mm(3))
    expect(back.radius).toBe(mm(0.25))
    expect(back.strokeType).toBe('dash')
  })

  it('moves a Bézier’s ends from its start and end rows', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const curve = footprint.fpCurves[0]
    updateCurveInAST(curve, footprintPatch('curve', 'endX', mm(5), curve))
    expect(parseKicadFootprint(serializeKicadFootprint(footprint)).fpCurves[0].points[3]).toEqual({
      x: mm(5),
      y: mm(0)
    })
  })

  it('edits a text box’s border and margins, and a table’s lines and layer', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const box = footprint.fpTextBoxes[0]
    updateTextBoxInAST(box, footprintPatch('textbox', 'border', true, box) as TextBoxPatch)
    updateTextBoxInAST(box, footprintPatch('textbox', 'marginLeft', mm(0.5), box) as TextBoxPatch)
    const table = footprint.tables[0]
    updateTableInAST(table, footprintPatch('table', 'borderHeader', false, table))
    updateTableInAST(table, footprintPatch('table', 'separatorStrokeWidth', mm(0.2), table))
    updateTableInAST(table, footprintPatch('table', 'layer', 'F.SilkS', table))
    const back = parseKicadFootprint(serializeKicadFootprint(footprint))
    expect(back.fpTextBoxes[0].border).toBe(true)
    expect(back.fpTextBoxes[0].margins?.left).toBe(mm(0.5))
    expect(back.tables[0].borderHeader).toBe(false)
    expect(back.tables[0].separatorStrokeWidth).toBe(mm(0.2))
    expect(back.tables[0].cells.map((c) => c.layer)).toEqual(['F.SilkS', 'F.SilkS'])
  })

  it('shows and writes a footprint rule area’s keepouts', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const groups = buildFootprintGroups(footprint, [{ type: 'zone', index: 0 }], t, ctx)
    expect(fieldValue(groups, 'zone', 'blockTracks')).toBe(true)
    expect(fieldValue(groups, 'zone', 'blockPads')).toBe(false)
    const zone = footprint.zones[0]
    updateZoneInAST(zone, footprintPatch('zone', 'blockPads', true, zone))
    expect(
      parseKicadFootprint(serializeKicadFootprint(footprint)).zones[0].keepoutRules?.pads
    ).toBe(false)
  })

  it('puts a field’s text rows under Text', () => {
    const footprint = parseKicadFootprint(EVERY_ITEM)
    const groups = buildFootprintGroups(footprint, [{ type: 'property', index: 0 }], t, ctx)
    expect(rowOf(groups, 'property', 'layer')?.section).toBeUndefined()
    expect(rowOf(groups, 'property', 'text')?.section).toBe('text')
    expect(rowOf(groups, 'property', 'thickness')?.section).toBe('text')
  })
})
