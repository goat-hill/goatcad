import { describe, test, expect } from 'vitest'
import { getToken, parseSExpr, type SExprList } from '../sexpr'
import {
  expandFootprintText,
  parseKicadFootprint,
  serializeKicadFootprint,
  getReference,
  getValue,
  updateLineInAST,
  updatePolyInAST,
  updateModelInAST,
  addModelNode,
  removeModelNode,
  updateArcInAST,
  updateCircleInAST,
  updateRectInAST,
  updateTextInAST,
  updatePadInAST,
  updateFootprintMetaInAST,
  footprintTextDrawAngle,
  parsePointList,
  addFpLineToFootprintAST,
  addFpPolyToFootprintAST
} from '../footprint'
import { mmToNm as mm } from '../coordinates'
import { CURRENT_FORMAT_VERSION } from '../migrate'
import { symbolFieldTextAngle } from '../../engine/schematicTextOrientation'

// ---------------------------------------------------------------------------
// KiCad v8+ style footprint (properties, stroke, quoted layers)
// ---------------------------------------------------------------------------

const v8Footprint = `(footprint "R_0402_1005Metric"
  (version 20240108)
  (generator "pcbnew")
  (generator_version "8.0")
  (layer "F.Cu")
  (descr "Resistor SMD 0402 (1005 Metric)")
  (tags "resistor 0402")
  (attr smd)
  (property "Reference" "REF**"
    (at 0 -1.17 0)
    (layer "F.SilkS")
    (uuid "ref-uuid")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (property "Value" "R_0402_1005Metric"
    (at 0 1.17 0)
    (layer "F.Fab")
    (uuid "val-uuid")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (property "Footprint" ""
    (at 0 0 0)
    (layer "F.Fab")
    (hide yes)
    (uuid "fp-uuid")
    (effects (font (size 1.27 1.27) (thickness 0.15)))
  )
  (fp_line
    (start -0.153641 -0.38)
    (end 0.153641 -0.38)
    (stroke (width 0.12) (type default))
    (layer "F.SilkS")
    (uuid "line1-uuid")
  )
  (fp_line
    (start -0.153641 0.38)
    (end 0.153641 0.38)
    (stroke (width 0.12) (type default))
    (layer "F.SilkS")
    (uuid "line2-uuid")
  )
  (fp_rect
    (start -0.93 -0.47)
    (end 0.93 0.47)
    (stroke (width 0.05) (type default))
    (layer "F.CrtYd")
    (uuid "rect-uuid")
  )
  (pad "1" smd roundrect
    (at -0.48 0)
    (size 0.56 0.62)
    (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25)
    (uuid "pad1-uuid")
  )
  (pad "2" smd roundrect
    (at 0.48 0)
    (size 0.56 0.62)
    (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25)
    (uuid "pad2-uuid")
  )
  (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
    (offset (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)`

// ---------------------------------------------------------------------------
// KiCad v6 style footprint (fp_text, width, unquoted layers)
// ---------------------------------------------------------------------------

const v6Footprint = `(footprint "LED_0805_2012Metric"
  (version 20211014)
  (generator pcbnew)
  (layer F.Cu)
  (descr "LED SMD 0805 (2012 Metric)")
  (tags "LED 0805")
  (fp_text reference "REF**" (at 0 -1.65) (layer F.SilkS)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value "LED_0805" (at 0 1.65) (layer F.Fab)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_line (start -1.68 -0.95) (end 1.68 -0.95) (layer F.SilkS) (width 0.12))
  (fp_line (start -1.68 0.95) (end 1.68 0.95) (layer F.SilkS) (width 0.12))
  (fp_line (start -1.68 -0.95) (end -1.68 0.95) (layer F.SilkS) (width 0.12))
  (fp_line (start 1.68 -0.95) (end 1.68 0.95) (layer F.SilkS) (width 0.12))
  (pad 1 smd rect (at -1.0 0) (size 1.0 1.2) (layers F.Cu F.Paste F.Mask))
  (pad 2 smd rect (at 1.0 0) (size 1.0 1.2) (layers F.Cu F.Paste F.Mask))
  (model "\${KICAD6_3DMODEL_DIR}/LED_SMD.3dshapes/LED_0805_2012Metric.step"
    (offset (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)`

// ---------------------------------------------------------------------------
// Through-hole footprint with drill
// ---------------------------------------------------------------------------

const thFootprint = `(footprint "DIP-8_W7.62mm"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (pad "1" thru_hole rect
    (at 0 0)
    (size 1.6 1.6)
    (drill 0.8)
    (layers "*.Cu" "*.Mask")
    (uuid "th-pad1")
  )
  (pad "2" thru_hole circle
    (at 2.54 0)
    (size 1.6 1.6)
    (drill 0.8)
    (layers "*.Cu" "*.Mask")
    (uuid "th-pad2")
  )
)`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KiCad Footprint Domain Model - v8+ format', () => {
  test('parses footprint name and metadata', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.name).toBe('R_0402_1005Metric')
    // Read as KiCad 10 writes it: the parser migrates an older file.
    expect(fp.version).toBe(CURRENT_FORMAT_VERSION.footprint)
    expect(fp.generator).toBe('pcbnew')
    expect(fp.generatorVersion).toBe('8.0')
    expect(fp.layer).toBe('F.Cu')
    expect(fp.description).toBe('Resistor SMD 0402 (1005 Metric)')
    expect(fp.tags).toBe('resistor 0402')
  })

  test('parses attributes', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.attributes).toContain('smd')
  })

  test('parses v8 properties', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.properties).toHaveLength(3)

    const refProp = fp.properties.find((p) => p.key === 'Reference')
    expect(refProp).toBeDefined()
    expect(refProp!.value).toBe('REF**')
    expect(refProp!.position).toEqual({ x: mm(0), y: mm(-1.17), angle: 0 })
    expect(refProp!.layer).toBe('F.SilkS')
    expect(refProp!.uuid).toBe('ref-uuid')

    const valProp = fp.properties.find((p) => p.key === 'Value')
    expect(valProp).toBeDefined()
    expect(valProp!.value).toBe('R_0402_1005Metric')
  })

  test('parses pads', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.pads).toHaveLength(2)

    const pad1 = fp.pads[0]
    expect(pad1.number).toBe('1')
    expect(pad1.type).toBe('smd')
    expect(pad1.shape).toBe('roundrect')
    expect(pad1.position).toEqual({ x: mm(-0.48), y: mm(0) })
    expect(pad1.size).toEqual({ w: mm(0.56), h: mm(0.62) })
    expect(pad1.layers).toEqual(['F.Cu', 'F.Paste', 'F.Mask'])
    expect(pad1.roundrectRatio).toBe(0.25)
    expect(pad1.uuid).toBe('pad1-uuid')
  })

  test('parses fp_lines with stroke (v7+)', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.fpLines).toHaveLength(2)

    const line1 = fp.fpLines[0]
    expect(line1.start.x).toBe(mm(-0.153641))
    expect(line1.start.y).toBe(mm(-0.38))
    expect(line1.end.x).toBe(mm(0.153641))
    expect(line1.end.y).toBe(mm(-0.38))
    expect(line1.strokeWidth).toBe(mm(0.12))
    expect(line1.strokeType).toBe('default')
    expect(line1.layer).toBe('F.SilkS')
  })

  test('parses fp_rect', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.fpRects).toHaveLength(1)

    const rect = fp.fpRects[0]
    expect(rect.start).toEqual({ x: mm(-0.93), y: mm(-0.47) })
    expect(rect.end).toEqual({ x: mm(0.93), y: mm(0.47) })
    expect(rect.layer).toBe('F.CrtYd')
  })

  test('parses 3D model', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.model).toBeDefined()
    expect(fp.model!.path).toContain('R_0402_1005Metric.step')
    expect(fp.model!.path).toContain('${KICAD8_3DMODEL_DIR}')
    expect(fp.model!.offset).toEqual({ x: mm(0), y: mm(0), z: mm(0) })
    expect(fp.model!.scale).toEqual({ x: 1, y: 1, z: 1 })
    expect(fp.model!.rotate).toEqual({ x: 0, y: 0, z: 0 })
  })

  test('convenience: getReference and getValue', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(getReference(fp)).toBe('REF**')
    expect(getValue(fp)).toBe('R_0402_1005Metric')
  })
})

describe('KiCad Footprint Domain Model - v6 format', () => {
  test('parses v6 footprint metadata', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(fp.name).toBe('LED_0805_2012Metric')
    expect(fp.version).toBe(CURRENT_FORMAT_VERSION.footprint)
    expect(fp.generator).toBe('pcbnew')
    expect(fp.layer).toBe('F.Cu')
  })

  test('parses v6 fp_text elements', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(fp.fpTexts).toHaveLength(2)

    const refText = fp.fpTexts.find((t) => t.type === 'reference')
    expect(refText).toBeDefined()
    expect(refText!.text).toBe('REF**')
    expect(refText!.layer).toBe('F.SilkS')

    const valText = fp.fpTexts.find((t) => t.type === 'value')
    expect(valText).toBeDefined()
    expect(valText!.text).toBe('LED_0805')
  })

  test('convenience functions work with v6 fp_text', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(getReference(fp)).toBe('REF**')
    expect(getValue(fp)).toBe('LED_0805')
  })

  test('parses v6 lines with width instead of stroke', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(fp.fpLines).toHaveLength(4)

    const line1 = fp.fpLines[0]
    expect(line1.strokeWidth).toBe(mm(0.12))
    expect(line1.strokeType).toBeUndefined() // v6 has no stroke type
    expect(line1.layer).toBe('F.SilkS')
  })

  test('parses v6 pads with unquoted numbers', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(fp.pads).toHaveLength(2)
    expect(fp.pads[0].number).toBe('1')
    expect(fp.pads[0].type).toBe('smd')
    expect(fp.pads[0].shape).toBe('rect')
    expect(fp.pads[0].position).toEqual({ x: mm(-1.0), y: mm(0) })
    expect(fp.pads[0].size).toEqual({ w: mm(1.0), h: mm(1.2) })
  })

  test('parses v6 3D model', () => {
    const fp = parseKicadFootprint(v6Footprint)
    expect(fp.model).toBeDefined()
    expect(fp.model!.path).toContain('LED_0805_2012Metric.step')
  })
})

describe('Through-hole footprint', () => {
  test('parses thru_hole pads with drill', () => {
    const fp = parseKicadFootprint(thFootprint)
    expect(fp.pads).toHaveLength(2)

    const pad1 = fp.pads[0]
    expect(pad1.number).toBe('1')
    expect(pad1.type).toBe('thru_hole')
    expect(pad1.shape).toBe('rect')
    expect(pad1.drill).toBeDefined()
    expect(pad1.drill!.diameter).toBe(mm(0.8))

    const pad2 = fp.pads[1]
    expect(pad2.type).toBe('thru_hole')
    expect(pad2.shape).toBe('circle')
    expect(pad2.drill!.diameter).toBe(mm(0.8))
  })

  test('parses wildcard layers', () => {
    const fp = parseKicadFootprint(thFootprint)
    expect(fp.pads[0].layers).toContain('*.Cu')
    expect(fp.pads[0].layers).toContain('*.Mask')
  })
})

describe('Parsed graphic collections', () => {
  test('pads, lines and rects are parsed into separate collections', () => {
    const fp = parseKicadFootprint(v8Footprint)
    expect(fp.pads).toHaveLength(2)
    expect(fp.fpLines).toHaveLength(2)
    expect(fp.fpRects).toHaveLength(1)
  })
})

describe('Round-trip serialization', () => {
  test('round-trips v8 footprint', () => {
    const fp = parseKicadFootprint(v8Footprint)
    const serialized = serializeKicadFootprint(fp)
    const fp2 = parseKicadFootprint(serialized)

    expect(fp2.name).toBe(fp.name)
    expect(fp2.pads).toHaveLength(fp.pads.length)
    expect(fp2.fpLines).toHaveLength(fp.fpLines.length)
    expect(fp2.fpRects).toHaveLength(fp.fpRects.length)
    expect(fp2.properties).toHaveLength(fp.properties.length)
    expect(fp2.model?.path).toBe(fp.model?.path)
  })

  test('round-trips v6 footprint', () => {
    const fp = parseKicadFootprint(v6Footprint)
    const serialized = serializeKicadFootprint(fp)
    const fp2 = parseKicadFootprint(serialized)

    expect(fp2.name).toBe(fp.name)
    expect(fp2.pads).toHaveLength(fp.pads.length)
    expect(fp2.fpTexts).toHaveLength(fp.fpTexts.length)
    expect(fp2.fpLines).toHaveLength(fp.fpLines.length)
  })

  test('preserves unknown nodes through round-trip', () => {
    const withUnknown = `(footprint "test"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (some_future_token (data 1 2 3))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
)`
    const fp = parseKicadFootprint(withUnknown)
    expect(fp._unknownNodes).toHaveLength(1)

    const serialized = serializeKicadFootprint(fp)
    expect(serialized).toContain('some_future_token')
    expect(serialized).toContain('data')
  })
})

describe('Edge cases', () => {
  test('rejects non-footprint input', () => {
    expect(() => parseKicadFootprint('(kicad_pcb (version 1))')).toThrow('not a KiCad footprint')
  })

  test('handles minimal footprint', () => {
    const fp = parseKicadFootprint('(footprint "minimal")')
    expect(fp.name).toBe('minimal')
    expect(fp.pads).toHaveLength(0)
    expect(fp.fpLines).toHaveLength(0)
  })

  test('handles footprint with arc', () => {
    const withArc = `(footprint "arc_test"
  (fp_arc
    (start 1 0)
    (mid 0.707 0.707)
    (end 0 1)
    (stroke (width 0.1) (type default))
    (layer "F.SilkS")
  )
)`
    const fp = parseKicadFootprint(withArc)
    expect(fp.fpArcs).toHaveLength(1)
    expect(fp.fpArcs[0].start).toEqual({ x: mm(1), y: mm(0) })
    expect(fp.fpArcs[0].mid.x).toBe(mm(0.707))
    expect(fp.fpArcs[0].end).toEqual({ x: mm(0), y: mm(1) })
  })

  test('a pre-v6 arc (center, one end, sweep) yields the same three points', () => {
    // Center (10, 10), starting at (0, 10), a quarter turn: the corner rounding
    // of a board whose left edge is x = 0 and top edge is y = 0.
    const legacy = `(footprint "arc_test"
  (fp_arc (start 10 10) (end 0 10) (angle 90) (layer "Edge.Cuts") (width 0.1))
)`
    const arc = parseKicadFootprint(legacy).fpArcs[0]
    expect(arc.start).toEqual({ x: 0, y: 10_000_000 })
    expect(arc.end.x).toBeCloseTo(10_000_000, -1)
    expect(arc.end.y).toBeCloseTo(0, -1)
    expect(arc.mid.x).toBeCloseTo(10_000_000 - 7_071_068, -2)
    expect(arc.mid.y).toBeCloseTo(10_000_000 - 7_071_068, -2)
  })

  test('handles footprint with circle', () => {
    const withCircle = `(footprint "circle_test"
  (fp_circle
    (center 0 0)
    (end 1 0)
    (stroke (width 0.1) (type default))
    (layer "F.SilkS")
    (fill none)
  )
)`
    const fp = parseKicadFootprint(withCircle)
    expect(fp.fpCircles).toHaveLength(1)
    expect(fp.fpCircles[0].center).toEqual({ x: mm(0), y: mm(0) })
    expect(fp.fpCircles[0].end).toEqual({ x: mm(1), y: mm(0) })
    expect(fp.fpCircles[0].fill).toBe('none')
  })

  test('handles footprint with polygon', () => {
    const withPoly = `(footprint "poly_test"
  (fp_poly
    (pts
      (xy 0 0)
      (xy 1 0)
      (xy 1 1)
      (xy 0 1)
    )
    (stroke (width 0.1) (type default))
    (layer "F.SilkS")
    (fill solid)
  )
)`
    const fp = parseKicadFootprint(withPoly)
    expect(fp.fpPolys).toHaveLength(1)
    expect(fp.fpPolys[0].points).toHaveLength(4)
    expect(fp.fpPolys[0].points[0]).toEqual({ x: mm(0), y: mm(0) })
    expect(fp.fpPolys[0].points[2]).toEqual({ x: mm(1), y: mm(1) })
    expect(fp.fpPolys[0].fill).toBe('solid')
  })

  test('handles footprint with zone', () => {
    const withZone = `(footprint "zone_test"
  (zone
    (net 1)
    (net_name "GND")
    (layer "F.Cu")
    (hatch edge 0.5)
    (min_thickness 0.2)
    (polygon
      (pts
        (xy 0 0)
        (xy 10 0)
        (xy 10 10)
        (xy 0 10)
      )
    )
    (filled_polygon
      (pts
        (xy 1 1)
        (xy 9 1)
        (xy 9 9)
        (xy 1 9)
      )
    )
  )
)`
    const fp = parseKicadFootprint(withZone)
    expect(fp.zones).toHaveLength(1)
    expect(fp.zones[0].net).toBe(1)
    expect(fp.zones[0].netName).toBe('GND')
    expect(fp.zones[0].layer).toBe('F.Cu')
    expect(fp.zones[0].hatchStyle).toBe('edge')
    expect(fp.zones[0].hatchPitch).toBe(mm(0.5))
    expect(fp.zones[0].minThickness).toBe(mm(0.2))
    expect(fp.zones[0].points).toHaveLength(4)
    expect(fp.zones[0].points[0]).toEqual({ x: mm(0), y: mm(0) })
    expect(fp.zones[0].points[2]).toEqual({ x: mm(10), y: mm(10) })
    expect(fp.zones[0].filledPolys).toHaveLength(1)
    expect(fp.zones[0].filledPolys?.[0]).toHaveLength(4)
    expect(fp.zones[0].filledPolys?.[0][0]).toEqual({ x: mm(1), y: mm(1) })
  })

  test('updatePolyInAST modifies AST and properties correctly', () => {
    const withPoly = `(footprint "poly_test"
  (fp_poly
    (pts
      (xy 0 0)
      (xy 1 0)
      (xy 1 1)
      (xy 0 1)
    )
    (stroke (width 0.1) (type default))
    (layer "F.SilkS")
    (fill solid)
  )
)`
    const fp = parseKicadFootprint(withPoly)
    const poly = fp.fpPolys[0]
    updatePolyInAST(poly, { layer: 'B.SilkS', strokeWidth: mm(0.25), fill: 'none' })
    expect(poly.layer).toBe('B.SilkS')
    expect(poly.strokeWidth).toBe(mm(0.25))
    expect(poly.fill).toBe('none')

    const serialized1 = serializeKicadFootprint(fp)
    expect(serialized1).toContain('(layer "B.SilkS")')
    expect(serialized1).toContain('(width 0.25)')
    expect(serialized1).toContain('(fill none)')

    updatePolyInAST(poly, { fill: 'yes' })
    expect(poly.fill).toBe('yes')
    const serialized2 = serializeKicadFootprint(fp)
    expect(serialized2).toContain('(fill yes)')

    updatePolyInAST(poly, { fill: 'hatch' })
    expect(poly.fill).toBe('hatch')
    const serialized3 = serializeKicadFootprint(fp)
    expect(serialized3).toContain('(fill hatch)')
  })
})

describe('font effects parsing', () => {
  const fpWithText = (effects: string, extra = ''): string => `(footprint "T"
  (layer "F.Cu")
  (fp_text user "label"
    (at 0 0)
    (layer "F.SilkS")${extra}
    ${effects}
  )
)`

  test('font size is (size HEIGHT WIDTH) per spec', () => {
    const fp = parseKicadFootprint(fpWithText('(effects (font (size 2 1) (thickness 0.3)))'))
    expect(fp.fpTexts[0].fontEffects?.height).toBe(mm(2))
    expect(fp.fpTexts[0].fontEffects?.width).toBe(mm(1))
    expect(fp.fpTexts[0].fontEffects?.thickness).toBe(mm(0.3))
  })

  test('justify atoms map to alignment; absent means center', () => {
    const fp = parseKicadFootprint(
      fpWithText('(effects (font (size 1 1)) (justify left bottom mirror))')
    )
    const fe = fp.fpTexts[0].fontEffects
    expect(fe?.hAlign).toBe('left')
    expect(fe?.vAlign).toBe('bottom')
    expect(fe?.mirror).toBe(true)

    const centered = parseKicadFootprint(fpWithText('(effects (font (size 1 1)))'))
    expect(centered.fpTexts[0].fontEffects?.hAlign).toBeUndefined()
    expect(centered.fpTexts[0].fontEffects?.vAlign).toBeUndefined()
  })

  test('bold parses from atom or (bold yes) and drives the default pen width', () => {
    const boldAtom = parseKicadFootprint(fpWithText('(effects (font (size 1 1) bold))'))
    expect(boldAtom.fpTexts[0].fontEffects?.bold).toBe(true)
    expect(boldAtom.fpTexts[0].fontEffects?.thickness).toBe(mm(1 / 5))

    const boldList = parseKicadFootprint(fpWithText('(effects (font (size 1 1) (bold yes)))'))
    expect(boldList.fpTexts[0].fontEffects?.bold).toBe(true)

    const normal = parseKicadFootprint(fpWithText('(effects (font (size 1 1)))'))
    expect(normal.fpTexts[0].fontEffects?.bold).toBe(false)
    expect(normal.fpTexts[0].fontEffects?.thickness).toBe(mm(1 / 8))
  })

  test('hide parses bare atom, (hide yes), and (hide no)', () => {
    const bare = parseKicadFootprint(fpWithText('(effects (font (size 1 1)))', '\n    hide'))
    expect(bare.fpTexts[0].hide).toBe(true)

    const yes = parseKicadFootprint(fpWithText('(effects (font (size 1 1)))', '\n    (hide yes)'))
    expect(yes.fpTexts[0].hide).toBe(true)

    const no = parseKicadFootprint(fpWithText('(effects (font (size 1 1)))', '\n    (hide no)'))
    expect(no.fpTexts[0].hide).toBe(false)

    // A text whose literal value is "hide" must not read as hidden
    const literal = parseKicadFootprint(`(footprint "T"
  (layer "F.Cu")
  (fp_text user "hide"
    (at 0 0)
    (layer "F.SilkS")
    (effects (font (size 1 1)))
  )
)`)
    expect(literal.fpTexts[0].hide).toBe(false)
  })
})

describe('packed fp_line mutation', () => {
  const src = `(footprint "Test"
  (layer "F.Cu")
  (fp_line
    (start -0.3 -0.7)
    (end 0.3 -0.7)
    (stroke
      (width 0.15)
      (type solid)
    )
    (layer "F.SilkS")
    (uuid "aaaa-bbbb")
  )
)`

  test('updateLineInAST on a packed fp_line materializes and writes through', () => {
    const fp = parseKicadFootprint(src)
    expect(fp.fpLines).toHaveLength(1)
    const line = fp.fpLines[0]
    expect(line.start).toEqual({ x: mm(-0.3), y: mm(-0.7) })
    expect(line.strokeWidth).toBe(mm(0.15))
    expect(line.uuid).toBe('aaaa-bbbb')

    updateLineInAST(line, { start: { x: mm(1.5), y: mm(2.5) }, strokeWidth: mm(0.2) })
    const out = serializeKicadFootprint(fp)
    expect(out).toContain('(start 1.5 2.5)')
    expect(out).toContain('(width 0.2)')
    expect(out).toContain('(uuid "aaaa-bbbb")')

    const reparsed = parseKicadFootprint(out)
    expect(reparsed.fpLines[0].start).toEqual({ x: mm(1.5), y: mm(2.5) })
    expect(reparsed.fpLines[0].strokeWidth).toBe(mm(0.2))
    // and the mutated document still round-trips stably
    expect(serializeKicadFootprint(reparsed)).toBe(out)
  })
})

describe('3D model link mutation', () => {
  const bare = `(footprint "Test"
  (layer "F.Cu")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
)`

  test('addModelNode links a model with default transform', () => {
    const fp = parseKicadFootprint(bare)
    expect(fp.model).toBeUndefined()

    const model = addModelNode(fp, '${KICAD8_3DMODEL_DIR}/LED.step')
    expect(fp.model).toBe(model)
    expect(model.path).toBe('${KICAD8_3DMODEL_DIR}/LED.step')
    expect(model.offset).toEqual({ x: mm(0), y: mm(0), z: mm(0) })
    expect(model.scale).toEqual({ x: 1, y: 1, z: 1 })
    expect(model.rotate).toEqual({ x: 0, y: 0, z: 0 })

    const out = serializeKicadFootprint(fp)
    expect(out).toContain('(model "${KICAD8_3DMODEL_DIR}/LED.step"')
    expect(out).toContain('(offset')
    expect(out).toContain('(xyz 0 0 0)')
    // re-parsing the serialized document sees the same model
    expect(parseKicadFootprint(out).model!.path).toBe('${KICAD8_3DMODEL_DIR}/LED.step')
  })

  test('updateModelInAST patches path and transform', () => {
    const fp = parseKicadFootprint(bare)
    const model = addModelNode(fp, 'a.wrl')

    updateModelInAST(model, {
      path: 'b.step',
      offset: { x: mm(1), y: mm(2), z: mm(3) },
      scale: { x: 2, y: 2, z: 2 },
      rotate: { x: 0, y: 0, z: 90 }
    })

    const out = serializeKicadFootprint(fp)
    expect(out).toContain('(model "b.step"')
    expect(out).toContain('(xyz 1 2 3)')
    expect(out).toContain('(xyz 2 2 2)')
    expect(out).toContain('(xyz 0 0 90)')

    const reparsed = parseKicadFootprint(out)
    expect(reparsed.model!.path).toBe('b.step')
    expect(reparsed.model!.offset).toEqual({ x: mm(1), y: mm(2), z: mm(3) })
    expect(reparsed.model!.rotate).toEqual({ x: 0, y: 0, z: 90 })
    // stable round-trip
    expect(serializeKicadFootprint(reparsed)).toBe(out)
  })

  test('partial update leaves other transform fields intact', () => {
    const fp = parseKicadFootprint(bare)
    const model = addModelNode(fp, 'a.step')
    updateModelInAST(model, { offset: { x: mm(5), y: mm(0), z: mm(0) } })
    expect(model.offset).toEqual({ x: mm(5), y: mm(0), z: mm(0) })
    expect(model.scale).toEqual({ x: 1, y: 1, z: 1 })
    updateModelInAST(model, { rotate: { x: 0, y: 0, z: 45 } })
    // the earlier offset survives the second, unrelated patch
    expect(parseKicadFootprint(serializeKicadFootprint(fp)).model!.offset).toEqual({
      x: mm(5),
      y: mm(0),
      z: mm(0)
    })
  })

  test('removeModelNode drops the model and round-trips back to bare', () => {
    const fp = parseKicadFootprint(bare)
    addModelNode(fp, 'a.step')
    expect(fp.model).toBeDefined()

    removeModelNode(fp)
    expect(fp.model).toBeUndefined()
    const out = serializeKicadFootprint(fp)
    expect(out).not.toContain('(model')
    expect(parseKicadFootprint(out).model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Phase 0 parser/model gaps: stroke color, pad margins/drill, locked, attrs, effects
// ---------------------------------------------------------------------------

const gapFp = `(footprint "T"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (attr smd)
  (fp_line (start 0 0) (end 1 0) (stroke (width 0.12) (type solid) (color 10 20 30 1)) (layer "F.SilkS"))
  (fp_circle (center 0 0) (end 1 0) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS"))
  (fp_rect (start 0 0) (end 2 2) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS"))
  (fp_arc (start 0 0) (mid 1 1) (end 2 0) (stroke (width 0.1) (type default)) (layer "F.SilkS"))
  (fp_text user "hi" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu")
    (solder_mask_margin 0.05) (clearance 0.1))
)
`

describe('Phase 0 footprint gaps', () => {
  test('parses stroke color, pad margins/clearance, and locked', () => {
    const fp = parseKicadFootprint(gapFp)
    expect(fp.fpLines[0].strokeColor).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(fp.fpLines[0].strokeType).toBe('solid')
    expect(fp.pads[0].solderMaskMargin).toBe(mm(0.05))
    expect(fp.pads[0].clearance).toBe(mm(0.1))
    expect(fp.locked).toBe(false)
    expect(parseKicadFootprint('(footprint "X" (layer "F.Cu") locked)').locked).toBe(true)
  })

  test('writes stroke color/type on graphics + fill', () => {
    const fp = parseKicadFootprint(gapFp)
    updateCircleInAST(fp.fpCircles[0], {
      strokeColor: { r: 1, g: 2, b: 3, a: 1 },
      fill: 'solid'
    })
    updateRectInAST(fp.fpRects[0], { strokeColor: { r: 4, g: 5, b: 6, a: 1 } })
    updateArcInAST(fp.fpArcs[0], { strokeWidth: mm(0.3) })
    const round = parseKicadFootprint(serializeKicadFootprint(fp))
    expect(round.fpCircles[0].strokeColor).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(round.fpCircles[0].fill).toBe('solid')
    expect(round.fpRects[0].strokeColor).toEqual({ r: 4, g: 5, b: 6, a: 1 })
    expect(round.fpArcs[0].strokeWidth).toBe(mm(0.3))
  })

  test('writes pad margins + oval drill', () => {
    const fp = parseKicadFootprint(gapFp)
    updatePadInAST(fp.pads[0], {
      solderPasteMargin: mm(-0.02),
      drill: { diameter: mm(0.6), oval: { width: mm(0.6), height: mm(0.8) } }
    })
    const round = parseKicadFootprint(serializeKicadFootprint(fp))
    expect(round.pads[0].solderPasteMargin).toBe(mm(-0.02))
    expect(round.pads[0].drill?.oval).toEqual({ width: mm(0.6), height: mm(0.8) })
  })

  test('toggles footprint locked + attributes and writes text effects', () => {
    const fp = parseKicadFootprint(gapFp)
    updateFootprintMetaInAST(fp, { locked: true, attributes: ['smd', 'exclude_from_bom'] })
    updateTextInAST(fp.fpTexts[0], {
      hide: true,
      fontEffects: { width: mm(1), height: mm(1), thickness: mm(0.15), bold: true, hAlign: 'left' }
    })
    const out = serializeKicadFootprint(fp)
    const round = parseKicadFootprint(out)
    expect(round.locked).toBe(true)
    expect(round.attributes).toEqual(['smd', 'exclude_from_bom'])
    expect(round.fpTexts[0].hide).toBe(true)
    expect(round.fpTexts[0].fontEffects?.bold).toBe(true)
    expect(round.fpTexts[0].fontEffects?.hAlign).toBe('left')
  })

  test('writes attributes in KiCad’s order, after the properties', () => {
    const fp =
      parseKicadFootprint(`(footprint "T" (version 20240108) (generator "pcbnew") (layer "F.Cu")
  (property "Reference" "REF**" (at 0 0 0) (layer "F.SilkS") (effects (font (size 1 1))))
  (fp_line (start 0 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS")))`)
    updateFootprintMetaInAST(fp, { attributes: ['allow_soldermask_bridges', 'dnp', 'smd'] })
    const out = serializeKicadFootprint(fp)
    expect(out).toContain('(attr smd dnp allow_soldermask_bridges)')
    const tokens = (parseSExpr(out) as SExprList).children.map((child) => getToken(child))
    expect(tokens.indexOf('attr')).toBe(tokens.indexOf('property') + 1)
  })

  test('a geometry-only arc edit injects no stroke color', () => {
    const fp = parseKicadFootprint(gapFp)
    updateArcInAST(fp.fpArcs[0], { start: { x: mm(5), y: mm(5) } })
    const round = parseKicadFootprint(serializeKicadFootprint(fp))
    // the arc had no color; a coord edit must not add one
    expect(round.fpArcs[0].strokeColor).toBeUndefined()
    expect(round.fpArcs[0].start).toEqual({ x: mm(5), y: mm(5) })
  })
})

describe('custom pad anchor', () => {
  const padSrc = (options: string): string => `(footprint "C"
  (version 20240108) (generator "pcbnew") (layer "F.Cu")
  (pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu")
    ${options}
    (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)))))
`

  test('reads the anchor shape, and leaves it absent to mean circle', () => {
    expect(
      parseKicadFootprint(padSrc('(options (clearance outline) (anchor rect))')).pads[0].anchor
    ).toBe('rect')
    expect(parseKicadFootprint(padSrc('(options (anchor circle))')).pads[0].anchor).toBe('circle')
    expect(parseKicadFootprint(padSrc('')).pads[0].anchor).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Keep upright — the fold between the angle a footprint text stores and the one
// it draws at. Ground truth is KiCad 10, probed with `kicad-cli pcb export svg`
// and `fp export svg` at 0/90/180/270/45, upright and `(unlocked yes)`.
// ---------------------------------------------------------------------------

const uprightFp = `(footprint "U"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (property "Reference" "U1"
    (at 0 -1 180)
    (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text user "free" (at 0 2 180) (unlocked yes) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
  (fp_text user "held" (at 0 4 270) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
)
`

describe('footprint text keep-upright', () => {
  test('reads the `unlocked` token as keep-upright, inverted', () => {
    const fp = parseKicadFootprint(uprightFp)
    expect(fp.properties[0].keepUpright).toBe(true)
    expect(fp.fpTexts.find((t) => t.text === 'free')?.keepUpright).toBe(false)
    expect(fp.fpTexts.find((t) => t.text === 'held')?.keepUpright).toBe(true)
  })

  test('folds a kept-upright angle into (-90, 90], as KiCad plots it', () => {
    // 180 → 0 reads L→R; 270 → 90 reads bottom→top; 90 and 45 are already
    // readable and stay put.
    expect([0, 45, 90, 180, 270, 360, -90].map((a) => footprintTextDrawAngle(a, true))).toEqual([
      0, 45, 90, 0, 90, 0, 90
    ])
  })

  test('plots an unlocked text literally', () => {
    expect([0, 180, 270].map((a) => footprintTextDrawAngle(a, false))).toEqual([0, 180, 270])
  })

  test('is not the symbol-field readability rule', () => {
    // Both fold 180 to 0; they part company at 270, where a symbol field
    // straightens to -90 and footprint text turns to 90.
    expect(footprintTextDrawAngle(270, true)).toBe(90)
    expect(symbolFieldTextAngle(270)).toBe(-90)
  })

  test('treats a missing angle as 0 either way', () => {
    expect(footprintTextDrawAngle(undefined, true)).toBe(0)
    expect(footprintTextDrawAngle(undefined, false)).toBe(0)
  })
})

describe('Graphic writers', () => {
  test('a drawn line and polygon land on the footprint and read back', () => {
    const fp = parseKicadFootprint(v8Footprint)
    const lines = fp.fpLines.length
    const polys = fp.fpPolys.length
    addFpLineToFootprintAST(fp, {
      start: { x: mm(-1), y: mm(-2.5) },
      end: { x: mm(1), y: mm(-2.5) },
      width: mm(0.12),
      layer: 'F.SilkS'
    })
    addFpPolyToFootprintAST(fp, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(1), y: mm(0) },
        { x: mm(1), y: mm(1) }
      ],
      width: mm(0.1),
      layer: 'F.Fab',
      fill: 'solid'
    })
    const again = parseKicadFootprint(serializeKicadFootprint(fp))
    expect(again.fpLines).toHaveLength(lines + 1)
    const line = again.fpLines[again.fpLines.length - 1]
    expect(line.start).toEqual({ x: mm(-1), y: mm(-2.5) })
    expect(line.end).toEqual({ x: mm(1), y: mm(-2.5) })
    expect(line.layer).toBe('F.SilkS')
    expect(line.strokeWidth).toBe(mm(0.12))
    expect(again.fpPolys).toHaveLength(polys + 1)
    const poly = again.fpPolys[again.fpPolys.length - 1]
    expect(poly.points).toHaveLength(3)
    expect(poly.layer).toBe('F.Fab')
    expect(serializeKicadFootprint(fp)).toContain('(fp_poly')
  })
})

describe('expandFootprintText', () => {
  test('resolves the variables a footprint text can carry, and leaves the rest as written', () => {
    const scope = { name: 'SOT-23-5', layer: 'F.Cu', reference: 'REF**', value: 'SOT-23-5' }
    // The fab-layer text every KiCad footprint carries; drawn literally it is
    // twelve glyphs through the pads, resolved it is the five KiCad draws.
    expect(expandFootprintText('${REFERENCE}', scope)).toBe('REF**')
    expect(expandFootprintText('${VALUE} on ${LAYER}', scope)).toBe('SOT-23-5 on F.Cu')
    expect(expandFootprintText('${FOOTPRINT_NAME}', scope)).toBe('SOT-23-5')
    expect(expandFootprintText('${PROJECTNAME}', scope)).toBe('${PROJECTNAME}')
    expect(expandFootprintText('${REFERENCE}', {})).toBe('${REFERENCE}')
    expect(expandFootprintText('plain', scope)).toBe('plain')
  })
})

describe('point lists with arcs', () => {
  test('an (arc) in (pts) is flattened in place, every point on it', () => {
    // A half disc: a straight edge from (-1,0) to (1,0), closed by an arc through (0,1).
    const pts = parseSExpr(
      '(pts (xy -1 0) (xy 1 0) (arc (start 1 0) (mid 0 1) (end -1 0)))'
    ) as SExprList
    const points = parsePointList(pts)
    expect(points.length).toBeGreaterThan(10)
    // The arc's own end is where the outline began, so it is not repeated.
    expect(points[points.length - 1]).not.toEqual(points[0])
    for (const p of points.slice(2)) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 1e6)).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
  })
})
