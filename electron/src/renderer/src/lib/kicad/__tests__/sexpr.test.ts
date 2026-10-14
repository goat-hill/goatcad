import { describe, test, expect } from 'vitest'
import {
  parseSExpr,
  parseSExprAsync,
  positionAt,
  PackedFpLineNode,
  PackedPtsNode,
  PackedSegmentNode,
  serializeSExpr,
  getToken,
  findChild,
  findChildren,
  getFirstAtomValue,
  getNumericValue,
  getXY,
  getSize,
  getAtomValues,
  type SExprList,
  type SExprAtom
} from '../sexpr'

// ---------------------------------------------------------------------------
// Tokenizer / Parser Basics
// ---------------------------------------------------------------------------

describe('S-Expression Parser', () => {
  test('parses a simple atom-only list', () => {
    const node = parseSExpr('(hello world)')
    expect(node.type).toBe('list')
    const list = node as SExprList
    expect(list.children).toHaveLength(2)
    expect((list.children[0] as SExprAtom).value).toBe('hello')
    expect((list.children[1] as SExprAtom).value).toBe('world')
  })

  test('parses nested lists', () => {
    const node = parseSExpr('(a (b c) (d (e f)))')
    expect(node.type).toBe('list')
    const root = node as SExprList
    expect(root.children).toHaveLength(3)
    expect(getToken(root)).toBe('a')

    const childB = root.children[1] as SExprList
    expect(getToken(childB)).toBe('b')
    expect((childB.children[1] as SExprAtom).value).toBe('c')

    const childD = root.children[2] as SExprList
    expect(getToken(childD)).toBe('d')
    const childE = childD.children[1] as SExprList
    expect(getToken(childE)).toBe('e')
  })

  test('parses quoted strings', () => {
    const node = parseSExpr('(footprint "LED_0805")')
    const list = node as SExprList
    expect(list.children).toHaveLength(2)
    const name = list.children[1] as SExprAtom
    expect(name.value).toBe('LED_0805')
    expect(name.quoted).toBe(true)
  })

  test('parses escaped characters in quoted strings', () => {
    const node = parseSExpr('(text "hello\\"world")')
    const list = node as SExprList
    const text = list.children[1] as SExprAtom
    expect(text.value).toBe('hello"world')
    expect(text.quoted).toBe(true)
  })

  test('parses numeric atoms', () => {
    const node = parseSExpr('(at 1.27 -3.81 90)')
    const list = node as SExprList
    expect(list.children).toHaveLength(4)
    expect((list.children[1] as SExprAtom).value).toBe('1.27')
    expect((list.children[2] as SExprAtom).value).toBe('-3.81')
    expect((list.children[3] as SExprAtom).value).toBe('90')
  })

  test('handles empty lists', () => {
    const node = parseSExpr('(empty)')
    const list = node as SExprList
    expect(list.children).toHaveLength(1)
    expect(getToken(list)).toBe('empty')
  })

  test('handles deeply empty lists', () => {
    const node = parseSExpr('(a (b ()) (c))')
    const root = node as SExprList
    expect(root.children).toHaveLength(3)
  })

  test('skips line comments with #', () => {
    const input = `# This is a comment
(footprint "test"
  # Another comment
  (pad "1" smd rect)
)`
    const node = parseSExpr(input)
    const root = node as SExprList
    expect(getToken(root)).toBe('footprint')
    expect(root.children).toHaveLength(3)
  })

  test('skips line comments with ;', () => {
    const input = `; Lisp-style comment
(data 42)`
    const node = parseSExpr(input)
    expect(getToken(node as SExprList)).toBe('data')
  })

  test('preserves source positions', () => {
    const source = '(at 1 2)'
    const node = parseSExpr(source)
    const list = node as SExprList
    expect(positionAt(source, list.start)).toMatchObject({ line: 1, col: 1 })
    const firstAtom = list.children[0] as SExprAtom
    expect(positionAt(source, firstAtom.start)).toMatchObject({ line: 1, col: 2 }) // after '('
  })

  test('tracks multi-line positions', () => {
    const input = `(root
  (child "value")
)`
    const node = parseSExpr(input) as SExprList
    const child = node.children[1] as SExprList
    expect(positionAt(input, child.start).line).toBe(2)
  })

  test('throws on empty input', () => {
    expect(() => parseSExpr('')).toThrow('Empty input')
    expect(() => parseSExpr('  \n  ')).toThrow('Empty input')
  })

  test('handles multiple top-level forms', () => {
    const node = parseSExpr('(a 1) (b 2)')
    // Should be wrapped in a synthetic list
    const root = node as SExprList
    expect(root.children).toHaveLength(2)
    expect(getToken(root.children[0] as SExprList)).toBe('a')
    expect(getToken(root.children[1] as SExprList)).toBe('b')
  })

  test('handles atoms with special characters in unquoted form', () => {
    const node = parseSExpr('(layer F.SilkS)')
    const list = node as SExprList
    expect((list.children[1] as SExprAtom).value).toBe('F.SilkS')
    expect((list.children[1] as SExprAtom).quoted).toBe(false)
  })

  test('handles KiCad layer names with quotes', () => {
    const node = parseSExpr('(layer "F.Cu")')
    const list = node as SExprList
    expect((list.children[1] as SExprAtom).value).toBe('F.Cu')
    expect((list.children[1] as SExprAtom).quoted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

describe('S-Expression Serializer', () => {
  test('serializes a simple list', () => {
    const node = parseSExpr('(hello world)')
    const out = serializeSExpr(node)
    expect(out).toBe('(hello world)')
  })

  test('serializes nested lists with indentation', () => {
    const node = parseSExpr('(footprint "test" (pad "1" smd rect))')
    const out = serializeSExpr(node)
    expect(out).toContain('footprint')
    expect(out).toContain('pad')
  })

  test('preserves quoted strings', () => {
    const node = parseSExpr('(name "hello world")')
    const out = serializeSExpr(node)
    expect(out).toContain('"hello world"')
  })

  test('escapes special characters in output', () => {
    const node = parseSExpr('(text "line1\\nline2")')
    const out = serializeSExpr(node)
    expect(out).toContain('"line1\\nline2"')
  })

  test('handles empty list', () => {
    const node = parseSExpr('(empty)')
    const out = serializeSExpr(node)
    expect(out).toBe('(empty)')
  })
})

// ---------------------------------------------------------------------------
// Round-trip Fidelity
// ---------------------------------------------------------------------------

describe('Round-trip', () => {
  const roundTrip = (input: string): void => {
    const ast1 = parseSExpr(input)
    const serialized = serializeSExpr(ast1)
    const ast2 = parseSExpr(serialized)

    // Compare structure (ignoring positions)
    const stripPositions = (node: ReturnType<typeof parseSExpr>): unknown => {
      if (node.type === 'atom') {
        return { type: 'atom', value: node.value, quoted: node.quoted }
      }
      return {
        type: 'list',
        children: (node as SExprList).children.map(stripPositions)
      }
    }

    expect(stripPositions(ast2)).toEqual(stripPositions(ast1))
  }

  test('round-trips a simple list', () => {
    roundTrip('(hello world)')
  })

  test('round-trips nested KiCad-like structure', () => {
    roundTrip(`(footprint "LED_0805"
  (version 20240101)
  (generator "kicad")
  (pad "1" smd rect (at -0.95 0) (size 0.9 1.2) (layers "F.Cu" "F.Paste" "F.Mask"))
  (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.12) (type default)) (layer "F.SilkS"))
)`)
  })

  test('round-trips deeply nested structures', () => {
    roundTrip('(a (b (c (d (e (f 1))))))')
  })

  test('round-trips quoted strings with escapes', () => {
    roundTrip('(text "hello\\"world" "tab\\there")')
  })

  test('round-trips numeric values', () => {
    roundTrip('(at -3.81 1.27 90)')
  })

  test('round-trips a realistic KiCad footprint pad', () => {
    roundTrip(`(pad "1" smd roundrect
  (at -2.5 0)
  (size 1.7 0.95)
  (layers "F.Cu" "F.Paste" "F.Mask")
  (roundrect_rratio 0.25)
  (uuid "abc-123")
)`)
  })
})

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

describe('AST Utilities', () => {
  const sampleAST = parseSExpr(`(footprint "LED_0805"
  (version 20240101)
  (generator "kicad")
  (layer "F.Cu")
  (at 10 20 45)
  (size 5 3)
  (pad "1" smd rect (at -0.95 0) (size 0.9 1.2))
  (pad "2" smd rect (at 0.95 0) (size 0.9 1.2))
  (fp_line (start 1 2) (end 3 4) (layer "F.SilkS"))
  (fp_line (start 5 6) (end 7 8) (layer "F.SilkS"))
)`) as SExprList

  test('getToken returns the first atom value', () => {
    expect(getToken(sampleAST)).toBe('footprint')
  })

  test('findChild returns the first matching child', () => {
    const version = findChild(sampleAST, 'version')
    expect(version).not.toBeNull()
    expect(getFirstAtomValue(version!)).toBe('20240101')
  })

  test('findChild returns null for non-existent token', () => {
    expect(findChild(sampleAST, 'nonexistent')).toBeNull()
  })

  test('findChildren returns all matching children', () => {
    const pads = findChildren(sampleAST, 'pad')
    expect(pads).toHaveLength(2)

    const lines = findChildren(sampleAST, 'fp_line')
    expect(lines).toHaveLength(2)
  })

  test('getAtomValues returns atoms after the token', () => {
    const pad = findChildren(sampleAST, 'pad')[0]
    const values = getAtomValues(pad)
    expect(values).toEqual(['1', 'smd', 'rect'])
  })

  test('getNumericValue parses float from child', () => {
    const version = findChild(sampleAST, 'version')!
    expect(getNumericValue(version)).toBe(20240101)
  })

  test('getXY extracts coordinates', () => {
    const pos = getXY(sampleAST, 'at')
    expect(pos).toEqual({ x: 10, y: 20, angle: 45 })
  })

  test('getXY without angle', () => {
    const pad = findChildren(sampleAST, 'pad')[0]
    const pos = getXY(pad, 'at')
    expect(pos).toEqual({ x: -0.95, y: 0 })
  })

  test('getSize extracts width/height', () => {
    const sz = getSize(sampleAST)
    expect(sz).toEqual({ w: 5, h: 3 })
  })

  test('getSize from pad child', () => {
    const pad = findChildren(sampleAST, 'pad')[0]
    const sz = getSize(pad)
    expect(sz).toEqual({ w: 0.9, h: 1.2 })
  })
})

// ---------------------------------------------------------------------------
// Real KiCad .kicad_mod Sample
// ---------------------------------------------------------------------------

describe('Real KiCad .kicad_mod parsing', () => {
  const realFootprint = `(footprint "R_0402_1005Metric"
  (version 20240108)
  (generator "pcbnew")
  (generator_version "8.0")
  (layer "F.Cu")
  (descr "Resistor SMD 0402 (1005 Metric)")
  (tags "resistor 0402")
  (property "Reference" "REF**"
    (at 0 -1.17 0)
    (layer "F.SilkS")
    (uuid "abc-ref")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (property "Value" "R_0402_1005Metric"
    (at 0 1.17 0)
    (layer "F.Fab")
    (uuid "abc-val")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (attr smd)
  (fp_line
    (start -0.153641 -0.38)
    (end 0.153641 -0.38)
    (stroke (width 0.12) (type default))
    (layer "F.SilkS")
    (uuid "abc-line1")
  )
  (fp_line
    (start -0.153641 0.38)
    (end 0.153641 0.38)
    (stroke (width 0.12) (type default))
    (layer "F.SilkS")
    (uuid "abc-line2")
  )
  (pad "1" smd roundrect
    (at -0.48 0)
    (size 0.56 0.62)
    (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25)
    (uuid "abc-pad1")
  )
  (pad "2" smd roundrect
    (at 0.48 0)
    (size 0.56 0.62)
    (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25)
    (uuid "abc-pad2")
  )
  (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"
    (offset (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)`

  test('parses a real KiCad v8 footprint', () => {
    const root = parseSExpr(realFootprint)
    expect(root.type).toBe('list')
    const fp = root as SExprList
    expect(getToken(fp)).toBe('footprint')
    expect(getFirstAtomValue(fp)).toBe('R_0402_1005Metric')
  })

  test('finds version and generator', () => {
    const fp = parseSExpr(realFootprint) as SExprList
    const version = findChild(fp, 'version')
    expect(getNumericValue(version!)).toBe(20240108)

    const gen = findChild(fp, 'generator')
    expect(getFirstAtomValue(gen!)).toBe('pcbnew')

    const genVer = findChild(fp, 'generator_version')
    expect(getFirstAtomValue(genVer!)).toBe('8.0')
  })

  test('finds properties (v8+ style)', () => {
    const fp = parseSExpr(realFootprint) as SExprList
    const props = findChildren(fp, 'property')
    expect(props).toHaveLength(2)
    expect(getFirstAtomValue(props[0])).toBe('Reference')
    expect(getFirstAtomValue(props[1])).toBe('Value')
  })

  test('finds pads', () => {
    const fp = parseSExpr(realFootprint) as SExprList
    const pads = findChildren(fp, 'pad')
    expect(pads).toHaveLength(2)

    // First pad
    const pad1 = pads[0]
    const atoms = getAtomValues(pad1)
    expect(atoms[0]).toBe('1')
    expect(atoms[1]).toBe('smd')
    expect(atoms[2]).toBe('roundrect')
    expect(getXY(pad1, 'at')).toEqual({ x: -0.48, y: 0 })
    expect(getSize(pad1)).toEqual({ w: 0.56, h: 0.62 })
  })

  test('finds graphic lines', () => {
    const fp = parseSExpr(realFootprint) as SExprList
    const lines = findChildren(fp, 'fp_line')
    expect(lines).toHaveLength(2)

    const line1 = lines[0]
    const start = getXY(line1, 'start')
    const end = getXY(line1, 'end')
    expect(start).toEqual({ x: -0.153641, y: -0.38 })
    expect(end).toEqual({ x: 0.153641, y: -0.38 })
  })

  test('finds 3D model reference', () => {
    const fp = parseSExpr(realFootprint) as SExprList
    const model = findChild(fp, 'model')
    expect(model).not.toBeNull()
    const modelPath = getFirstAtomValue(model!)
    expect(modelPath).toContain('R_0402_1005Metric.step')
    expect(modelPath).toContain('${KICAD8_3DMODEL_DIR}')
  })

  test('round-trips the real footprint', () => {
    const ast1 = parseSExpr(realFootprint)
    const serialized = serializeSExpr(ast1)
    const ast2 = parseSExpr(serialized)

    // Verify same structure
    const fp1 = ast1 as SExprList
    const fp2 = ast2 as SExprList
    expect(findChildren(fp2, 'pad')).toHaveLength(findChildren(fp1, 'pad').length)
    expect(findChildren(fp2, 'fp_line')).toHaveLength(findChildren(fp1, 'fp_line').length)
    expect(findChildren(fp2, 'property')).toHaveLength(findChildren(fp1, 'property').length)
    expect(findChild(fp2, 'model')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// KiCad v5/v6 style (fp_text instead of property)
// ---------------------------------------------------------------------------

describe('KiCad v5/v6 format compatibility', () => {
  const v6Footprint = `(footprint "LED_0805"
  (version 20211014)
  (generator pcbnew)
  (layer F.Cu)
  (fp_text reference "REF**" (at 0 -1.5) (layer F.SilkS)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value "LED_0805" (at 0 1.5) (layer F.Fab)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_line (start -1 -0.6) (end 1 -0.6) (layer F.SilkS) (width 0.12))
  (pad 1 smd rect (at -0.95 0) (size 0.9 1.2) (layers F.Cu F.Paste F.Mask))
  (pad 2 smd rect (at 0.95 0) (size 0.9 1.2) (layers F.Cu F.Paste F.Mask))
)`

  test('parses v6-style footprint with fp_text', () => {
    const fp = parseSExpr(v6Footprint) as SExprList
    expect(getToken(fp)).toBe('footprint')

    // v6 uses fp_text, not property
    const texts = findChildren(fp, 'fp_text')
    expect(texts).toHaveLength(2)
    expect(getFirstAtomValue(texts[0])).toBe('reference')
    expect(getFirstAtomValue(texts[1])).toBe('value')
  })

  test('parses v6-style unquoted layer names', () => {
    const fp = parseSExpr(v6Footprint) as SExprList
    const layer = findChild(fp, 'layer')
    expect(layer).not.toBeNull()
    expect(getFirstAtomValue(layer!)).toBe('F.Cu')
  })

  test('parses v6-style lines with width instead of stroke', () => {
    const fp = parseSExpr(v6Footprint) as SExprList
    const lines = findChildren(fp, 'fp_line')
    expect(lines).toHaveLength(1)

    const line = lines[0]
    // In v6, width is (width 0.12) — a direct child list, not nested in stroke
    const width = findChild(line, 'width')
    expect(width).not.toBeNull()
    expect(getNumericValue(width!)).toBeCloseTo(0.12)

    // No stroke wrapper in v6
    const stroke = findChild(line, 'stroke')
    expect(stroke).toBeNull()

    // Coordinates still parse fine
    expect(getXY(line, 'start')).toEqual({ x: -1, y: -0.6 })
    expect(getXY(line, 'end')).toEqual({ x: 1, y: -0.6 })
  })

  test('parses v6-style pads with unquoted pad numbers', () => {
    const fp = parseSExpr(v6Footprint) as SExprList
    const pads = findChildren(fp, 'pad')
    expect(pads).toHaveLength(2)

    // v6 uses unquoted pad numbers: (pad 1 smd rect ...)
    const atoms = getAtomValues(pads[0])
    expect(atoms[0]).toBe('1')
    expect(atoms[1]).toBe('smd')
    expect(atoms[2]).toBe('rect')
  })

  test('round-trips v6 footprint', () => {
    const ast1 = parseSExpr(v6Footprint) as SExprList
    const serialized = serializeSExpr(ast1)
    const ast2 = parseSExpr(serialized) as SExprList

    expect(findChildren(ast2, 'pad')).toHaveLength(2)
    expect(findChildren(ast2, 'fp_text')).toHaveLength(2)
    expect(findChildren(ast2, 'fp_line')).toHaveLength(1)
  })
})

describe('packed nodes', () => {
  const fpLineSrc = `(footprint "Test"
  (layer "F.Cu")
  (fp_line
    (start -0.3 -0.7)
    (end 0.3 -0.7)
    (stroke
      (width 0.15)
      (type solid)
    )
    (layer "F.SilkS")
    (uuid "59a6c815-c8d7-4a31-9242-c3d34b99cdbe")
  )
)`

  const ptsSrc = `(zone
  (polygon
    (pts
      (xy 92 52) (xy 118 52) (xy 118 73) (xy 92 73)
    )
  )
)`

  test('canonical fp_line packs and serializes byte-identically', () => {
    const root = parseSExpr(fpLineSrc) as SExprList
    const fpLine = findChild(root, 'fp_line')!
    expect(fpLine).toBeInstanceOf(PackedFpLineNode)
    expect(getToken(fpLine)).toBe('fp_line')
    const packedOut = serializeSExpr(root)
    // Force materialization, then serialize again — must not change a byte
    expect(fpLine.children.length).toBe(6)
    expect(serializeSExpr(root)).toBe(packedOut)
    // And the packed output equals a from-scratch generic parse of itself
    expect(serializeSExpr(parseSExpr(packedOut))).toBe(packedOut)
  })

  test('serializing leaves a packed node packed', () => {
    // The fp_line follows a list sibling, which the (xy …) packing rule reads.
    const root = parseSExpr(fpLineSrc) as SExprList
    const fpLine = findChild(root, 'fp_line') as PackedFpLineNode
    serializeSExpr(root)
    expect(fpLine.packedRecord()).not.toBeNull()
  })

  test('pts packs, reads without materializing, and round-trips', () => {
    const root = parseSExpr(ptsSrc) as SExprList
    const pts = findChild(findChild(root, 'polygon')!, 'pts')!
    expect(pts).toBeInstanceOf(PackedPtsNode)
    expect((pts as PackedPtsNode).packedCoords()).toHaveLength(8)
    const out = serializeSExpr(root)
    expect(serializeSExpr(parseSExpr(out))).toBe(out)
    // materialized serialization identical
    expect(pts.children.length).toBe(5)
    expect((pts as PackedPtsNode).packedCoords()).toBeNull()
    expect(serializeSExpr(root)).toBe(out)
  })

  test('non-canonical shapes fall back to generic nodes', () => {
    // locked flag, legacy width form, non-round-trip number, arc inside pts
    const cases = [
      '(fp_line locked (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (layer "F.Cu") (uuid "u"))',
      '(fp_line (start 0 0) (end 1 1) (layer F.CrtYd) (width 0.05))',
      '(fp_line (start 0.10 0) (end 1 1) (stroke (width 0.1) (type solid)) (layer "F.Cu") (uuid "u"))',
      '(pts (xy 0 0) (arc (start 1 1) (mid 2 2) (end 3 3)) (xy 4 4))',
      '(pts (xy 1.50 2))'
    ]
    for (const src of cases) {
      const node = parseSExpr(src) as SExprList
      expect(node).not.toBeInstanceOf(PackedFpLineNode)
      expect(node).not.toBeInstanceOf(PackedPtsNode)
      // still parses correctly as generic
      expect(node.type).toBe('list')
      expect(serializeSExpr(parseSExpr(serializeSExpr(node)))).toBe(serializeSExpr(node))
    }
  })

  test('small pts defers to the generic inline heuristics', () => {
    const src = '(polygon (pts (xy 0 0) (xy 1 1)))'
    const out = serializeSExpr(parseSExpr(src))
    // ≤2 xy: serializePacked declines, generic decides formatting
    expect(serializeSExpr(parseSExpr(out))).toBe(out)
  })

  test('children assignment on packed nodes works (setPointsChild path)', () => {
    const root = parseSExpr(ptsSrc) as SExprList
    const pts = findChild(findChild(root, 'polygon')!, 'pts')! as PackedPtsNode
    pts.children = [
      { type: 'atom', value: 'pts', quoted: false, start: 0, end: 0 },
      parseSExpr('(xy 5 6)')
    ]
    expect(pts.packedCoords()).toBeNull()
    expect(serializeSExpr(pts)).toContain('(xy 5 6)')
  })
})

describe('packed/materialized serialization invariant', () => {
  // The safety net for every packed shape, present and future: parse the same
  // source twice, force-materialize every node in one tree, and require both
  // trees to serialize byte-identically. Any drift between a packed emitter
  // and the generic serializer fails here.
  const materializeAll = (node: ReturnType<typeof parseSExpr>): void => {
    if (node.type !== 'list') return
    for (const child of node.children) materializeAll(child)
  }

  const corpus = [
    // canonical fp_line inside a footprint
    `(footprint "T" (layer "F.Cu")
      (fp_line (start -0.3 -0.7) (end 0.3 -0.7) (stroke (width 0.15) (type solid)) (layer "F.SilkS") (uuid "u1"))
      (fp_line
        (start 1 2)
        (end 3 4)
        (stroke
          (width 0.1)
          (type dash)
        )
        (layer "B.Fab")
        (uuid "u2")
      )
    )`,
    // canonical segment
    `(kicad_pcb (version 20240108) (net 0 "")
      (segment
        (start 182.325 143.525)
        (end 182.18 143.38)
        (width 0.2)
        (layer "F.Cu")
        (net 1)
        (uuid "seg-1")
      )
    )`,
    // pts runs: large (packed emit), small (generic inline decisions)
    `(zone (polygon (pts (xy 92 52) (xy 118 52) (xy 118 73) (xy 92 73) (xy 91 60))))`,
    `(zone (polygon (pts (xy 0 0) (xy 1 1))))`,
    `(polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))`,
    // fallback shapes mixed with packable ones
    `(kicad_pcb
      (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 1))
      (segment
        (start 5 5)
        (end 6 6)
        (width 0.25)
        (layer "B.Cu")
        (net 2)
        (uuid "ok")
      )
      (zone (polygon (pts (xy 1.50 2) (xy 3 4) (xy 5 6))))
    )`
  ]

  test('packed emit matches fully-materialized emit across the corpus', () => {
    for (const src of corpus) {
      const packedTree = parseSExpr(src)
      const materializedTree = parseSExpr(src)
      materializeAll(materializedTree)
      expect(serializeSExpr(packedTree)).toBe(serializeSExpr(materializedTree))
    }
  })

  test('canonical segment packs; deviations fall back', () => {
    const pcb = parseSExpr(
      '(kicad_pcb (segment (start 1 2) (end 3 4) (width 0.2) (layer "F.Cu") (net 7) (uuid "s")))'
    ) as SExprList
    const seg = findChild(pcb, 'segment')!
    expect(seg).toBeInstanceOf(PackedSegmentNode)
    expect(getToken(seg)).toBe('segment')

    // missing uuid, non-integer net, unquoted layer: all generic
    const fallbacks = [
      '(segment (start 1 2) (end 3 4) (width 0.2) (layer "F.Cu") (net 7))',
      '(segment (start 1 2) (end 3 4) (width 0.2) (layer "F.Cu") (net 7.5) (uuid "s"))',
      '(segment (start 1 2) (end 3 4) (width 0.2) (layer F.Cu) (net 7) (uuid "s"))'
    ]
    for (const src of fallbacks) {
      expect(parseSExpr(src)).not.toBeInstanceOf(PackedSegmentNode)
    }
  })
})

describe('parseSExprAsync', () => {
  const sample = `(kicad_pcb (version 20240108)
    (segment (start 1 2) (end 3 4) (width 0.2) (layer "F.Cu") (net 7) (uuid "s"))
    (zone (polygon (pts (xy 92 52) (xy 118 52) (xy 118 73) (xy 92 73) (xy 91 60))))
  )`

  test('produces identical output to the sync parser, with progress', async () => {
    const fractions: number[] = []
    const asyncRoot = await parseSExprAsync(sample, {
      chunkChars: 40, // force many chunks
      onProgress: (f) => fractions.push(f)
    })
    expect(serializeSExpr(asyncRoot)).toBe(serializeSExpr(parseSExpr(sample)))
    expect(fractions.length).toBeGreaterThan(2)
    expect(fractions[fractions.length - 1]).toBe(1)
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
    }
  })

  test('aborts between chunks', async () => {
    await expect(
      parseSExprAsync(sample, { chunkChars: 40, shouldAbort: () => true })
    ).rejects.toThrow('Parse aborted')
  })
})

describe('KiCad formatting parity', () => {
  // The rules were measured against files KiCad 9/10 wrote, not guessed, and
  // they are what makes a round trip byte-identical: until they matched,
  // opening a KiCad file and saving it rewrote every line.
  const rt = (src: string): string => serializeSExpr(parseSExpr(src))

  test('indents with a tab per level', () => {
    expect(rt('(a (b 1))')).toBe('(a\n\t(b 1)\n)')
  })

  test('breaks any list holding a sub-list, however short', () => {
    // The old serializer inlined this as `(effects (font (size 1.27 1.27)))`.
    expect(rt('(effects (font (size 1.27 1.27)))')).toBe(
      '(effects\n\t(font\n\t\t(size 1.27 1.27)\n\t)\n)'
    )
  })

  test('keeps an all-atom list on one line at any length', () => {
    // A footprint's `(descr …)` and `(tags …)` run well past 120 characters and
    // KiCad never breaks them; an 80-column cap used to.
    const long = `(descr "${'x'.repeat(200)}")`
    expect(rt(long)).toBe(long)
  })

  test('closes on its own line, at the opening line’s indent', () => {
    expect(rt('(a (b 1) (c 2))')).toBe('(a\n\t(b 1)\n\t(c 2)\n)')
  })

  test('keeps an atom that FOLLOWS a sub-list on the same line', () => {
    // Only a '(' starts a new line — this is the rule an "atoms first, then
    // sub-lists" model gets wrong, and a real board carries it
    // (`(loss_tangent 0.02) addsublayer` in a stackup).
    // And the close stays inline too: KiCad breaks before ')' only when the
    // previous non-whitespace was ')' or the list wrapped — here it is an atom.
    expect(rt('(a (b 1) trailing)')).toBe('(a\n\t(b 1) trailing)')
  })

  test('wraps a long atom run one level deeper', () => {
    const members = Array.from({ length: 8 }, (_, i) => `"NET.SIGNAL_NAME_${i}"`).join(' ')
    const lines = rt(`(members ${members})`).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1].startsWith('\t')).toBe(true)
    // Having wrapped, it closes on its own line.
    expect(lines[lines.length - 1]).toBe(')')
  })

  test('fills a (pts …) with as many points as fit the line', () => {
    const pts = '(pts ' + Array.from({ length: 12 }, (_, i) => `(xy ${i} ${i})`).join(' ') + ')'
    const lines = rt(pts).split('\n')
    expect(lines[0]).toBe('(pts')
    expect(lines[lines.length - 1]).toBe(')')
    // Several points per line. The column is tested BEFORE appending, so a
    // line overshoots the limit by up to one point — that is KiCad's rule, and
    // asserting a hard ceiling here would be asserting the wrong one.
    expect(lines[1].split('(xy').length - 1).toBeGreaterThan(1)
  })
})
