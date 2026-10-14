import { describe, expect, it } from 'vitest'
import {
  buildSymbolPreviewSchematic,
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  symbolPreviewPartKey,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  addArc,
  addBezier,
  addSymbolProperty,
  changedSymbolName,
  addressKey,
  moveSymbolProperty,
  removeSymbolProperty,
  renameSymbolProperty,
  sameAddress,
  setSymbolPropertyVisible,
  symbolPropertyNode,
  translateSymbolPropertyNode,
  updateSymbolProperty,
  addCircle,
  addPin,
  addPinAlternate,
  addPolyline,
  addRectangle,
  addSymbol,
  addText,
  addTextBox,
  addUnit,
  appendNodeCopy,
  boundsCenter,
  defaultUnitNodeFor,
  graphicAnchorPoint,
  graphicVertexPoints,
  deleteGraphic,
  deletePin,
  maxPinNumber,
  mirrorGraphicNode,
  mirrorPinNode,
  movePartToUnit,
  owningUnitNode,
  removePinAlternate,
  removeSymbol,
  removeUnit,
  renameSymbol,
  rotateGraphicNode,
  rotatePinNode,
  setGraphicVertex,
  setSymbolFlag,
  setSymbolPinDisplay,
  setSymbolPower,
  setSymbolProperty,
  symbolGraphicNodes,
  symbolPartAddresses,
  symbolPartNode,
  symbolPartGraphic,
  addressOfPartNode,
  symbolItemsBounds,
  symbolPinNodes,
  symbolBodyStyleCount,
  symbolBodyStyleNumbers,
  symbolUnitCount,
  symbolUnitName,
  symbolUnitNumbers,
  unitLetter,
  translateGraphicNode,
  translatePinNode,
  updateArc,
  updateCircle,
  updatePinAlternate,
  updateSymbolTextBox,
  updatePin,
  updatePolyline,
  updateRectangle,
  updateSymbolText
} from '../symbolEdit'
import {
  findChildren,
  getFirstAtomValue,
  getToken,
  parseSExpr,
  serializeSExpr,
  type SExprList
} from '../../kicad/sexpr'
import { mmToSpacing, spacingToMm } from '../../kicad/coordinates'
import { setTypedGraphicVertex, toolItems } from '../../symbolTools'
import { schematicFieldKey, shownFieldText } from '../../kicad/schematic'
import type {
  KicadLibSymbol,
  SchematicProperty,
  SymbolGraphic,
  SymbolPin
} from '../../kicad/schematic'

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
  (symbol "R_Small"
    (extends "R")
    (property "Reference" "R" (at 0.762 0.508 0) (effects (font (size 1.27 1.27))))
    (property "Value" "R_Small" (at 0.762 -1.016 0) (effects (font (size 1.27 1.27))))
  )
)
`

/** Parse, edit the node the mutator picks, then serialize→reparse. */
const applied = (mutate: (lib: KicadSymbolLibrary) => void): KicadSymbolLibrary => {
  const library = parseKicadSymbolLibrary(LIBRARY)
  mutate(library)
  return parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
}

/** `applied`, but continuing from an already-parsed library. */
const appliedTo = (
  library: KicadSymbolLibrary,
  mutate: (lib: KicadSymbolLibrary) => void
): KicadSymbolLibrary => {
  mutate(library)
  return parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
}

const node = (library: KicadSymbolLibrary, name: string): SExprList =>
  library.symbols.get(name)!._node
const variant = (
  symbol: KicadLibSymbol,
  unit: number,
  style: number
): { pins: unknown[]; graphics: unknown[] } =>
  symbol.variants.find((v) => v.unit === unit && v.style === style)!
const unitNode = (symbolNode: SExprList, name: string): SExprList =>
  findChildren(symbolNode, 'symbol').find((n) => getFirstAtomValue(n) === name)!

describe('setSymbolProperty', () => {
  it('updates an existing property in place', () => {
    const lib = applied((l) => setSymbolProperty(node(l, 'R'), 'Value', '10k'))
    const value = lib.symbols.get('R')!.graphics // touch views to force derive
    expect(value).toBeDefined()
    expect(serializeKicadSymbolLibrary(lib)).toContain('"Value" "10k"')
  })

  it('appends a missing property after the last existing one', () => {
    const lib = applied((l) => setSymbolProperty(node(l, 'R'), 'Datasheet', 'http://x'))
    const props = findChildren(node(lib, 'R'), 'property').map((p) => p.children[1])
    expect(props.some((a) => a?.type === 'atom' && a.value === 'Datasheet')).toBe(true)
    expect(serializeKicadSymbolLibrary(lib)).toContain('"Datasheet" "http://x"')
  })
})

describe('addPin / updatePin / deletePin', () => {
  it('adds a pin to the _1_1 unit, not the top symbol node', () => {
    const lib = applied((l) =>
      addPin(node(l, 'R'), {
        name: 'A',
        number: '3',
        x: mm(5),
        y: mm(0),
        angle: 180,
        length: mm(2.54),
        electricalType: 'input',
        graphicStyle: 'line'
      })
    )
    const r = lib.symbols.get('R')!
    expect(r.pins.length).toBe(0) // still no pins directly on the top node
    expect(variant(r, 1, 1).pins.length).toBe(3)
  })

  it('edits an existing pin in place', () => {
    const lib = applied((l) => {
      const pin = findChildren(unitNode(node(l, 'R'), 'R_1_1'), 'pin')[0]
      updatePin(pin, { number: '9', length: mm(5.08), electricalType: 'output' })
    })
    const text = serializeKicadSymbolLibrary(lib)
    expect(text).toContain('"9"')
    expect(text).toContain('(length 5.08)')
    expect(text).toContain('pin output line')
  })

  it('sizes the pin name and number fonts separately', () => {
    // KiCad's "Name text size" / "Number text size": two independent fonts on
    // the pin's own text nodes, which is the only place a pin carries effects.
    const lib = applied((l) => {
      const pin = findChildren(unitNode(node(l, 'R'), 'R_1_1'), 'pin')[0]
      updatePin(pin, { nameSize: mm(0.508), numberSize: mm(0.762) })
    })
    const pin = variant(lib.symbols.get('R')!, 1, 1).pins[0] as SymbolPin
    expect(pin.nameEffects.fontSize).toEqual({ height: mm(0.508), width: mm(0.508) })
    expect(pin.numberEffects.fontSize).toEqual({ height: mm(0.762), width: mm(0.762) })
    // The name row itself is untouched by a font-only edit (the fixture's
    // KiCad 8 `~`, read as KiCad 10 does: empty).
    expect(pin.name).toBe('')
  })

  it('removes a pin', () => {
    const lib = applied((l) => {
      const symbolNode = node(l, 'R')
      const pin = findChildren(unitNode(symbolNode, 'R_1_1'), 'pin')[0]
      deletePin(symbolNode, pin)
    })
    expect(variant(lib.symbols.get('R')!, 1, 1).pins.length).toBe(1)
  })
})

describe('graphics', () => {
  it('adds a rectangle to the _0_1 body unit', () => {
    const lib = applied((l) => addRectangle(node(l, 'R')))
    const rects = variant(lib.symbols.get('R')!, 0, 1).graphics.filter(
      (g) => (g as { type: string }).type === 'rectangle'
    )
    expect(rects.length).toBe(2)
  })

  it('adds a polyline that reparses as a line graphic', () => {
    const lib = applied((l) => addPolyline(node(l, 'R')))
    expect(
      variant(lib.symbols.get('R')!, 0, 1).graphics.some(
        (g) => (g as { type: string }).type === 'line'
      )
    ).toBe(true)
  })

  it('adds a circle', () => {
    const lib = applied((l) => addCircle(node(l, 'R')))
    expect(
      variant(lib.symbols.get('R')!, 0, 1).graphics.some(
        (g) => (g as { type: string }).type === 'circle'
      )
    ).toBe(true)
  })

  it('adds an arc that reparses with its three points intact', () => {
    const start = { x: mm(-1.27), y: mm(0) }
    const mid = { x: mm(0), y: mm(1.27) }
    const end = { x: mm(1.27), y: mm(0) }
    const lib = applied((l) => addArc(node(l, 'R'), start, mid, end))
    const arc = variant(lib.symbols.get('R')!, 0, 1).graphics.find(
      (g) => (g as { type: string }).type === 'arc'
    )
    // Round-tripped through serialize + reparse, so this covers the token order
    // the writer emits as well as the values.
    expect(arc).toMatchObject({ start, mid, end })
  })

  it('adds text, storing its angle in the decidegrees the parser divides back', () => {
    const lib = applied((l) =>
      addText(node(l, 'R'), 'Note', { x: mm(2.54), y: mm(-2.54), angle: 90 })
    )
    expect(serializeKicadSymbolLibrary(lib)).toContain('(at 2.54 -2.54 900)')
    const text = variant(lib.symbols.get('R')!, 0, 1).graphics.find(
      (g) => (g as { type: string }).type === 'text'
    )
    expect(text).toMatchObject({ text: 'Note', position: { x: mm(2.54), y: mm(-2.54), angle: 90 } })
  })

  it('round-trips every text effect the format carries', () => {
    // Color lives on the FONT, beside size and thickness — not on the effects
    // node, and not where a graphic's stroke/fill colors go.
    const lib = applied((l) => {
      const text = addText(node(l, 'R'), 'Note', { x: mm(0), y: mm(0), angle: 0 })
      updateSymbolText(text, {
        bold: true,
        italic: true,
        hAlign: 'left',
        vAlign: 'top',
        thickness: mm(0.3),
        color: { r: 255, g: 64, b: 0, a: 1 }
      })
    })
    const serialized = serializeKicadSymbolLibrary(lib)
    expect(serialized).toContain('(color 255 64 0 1)')
    expect(serialized).toContain('(justify left top)')
    expect(graphicOfLib(lib, 'text')).toMatchObject({
      effects: {
        bold: true,
        italic: true,
        thickness: mm(0.3),
        horizontalAlign: 'left',
        verticalAlign: 'top',
        color: { r: 255, g: 64, b: 0, a: 1 }
      }
    })
  })

  it('clears a font color by removing the node, not by writing an unset tuple', () => {
    // What a KiCad-authored file looks like when a text takes the theme color,
    // and what the picker's "inherit" has to produce.
    const lib = applied((l) => {
      const text = addText(node(l, 'R'), 'Note')
      updateSymbolText(text, { color: { r: 1, g: 2, b: 3, a: 1 } })
      updateSymbolText(text, { color: null })
    })
    expect(serializeKicadSymbolLibrary(lib)).not.toContain('(color')
    expect((graphicOfLib(lib, 'text') as { effects: { color?: unknown } }).effects.color).toBe(
      undefined
    )
  })

  it('gives a polyline the same stroke/fill set every other shape has', () => {
    // The panel offers a line the full style set, and `updatePolyline` writes
    // all of it — the call site's cast used to name only width and fill, which
    // misdescribed the rows rather than the writer.
    const lib = applied((l) => {
      const line = addPolyline(node(l, 'R'), [
        { x: mm(0), y: mm(0) },
        { x: mm(1), y: mm(1) }
      ])
      updatePolyline(line, {
        strokeWidth: mm(0.3),
        strokeType: 'dash',
        strokeColor: { r: 200, g: 30, b: 40, a: 1 },
        fill: 'background'
      })
    })
    expect(graphicOfLib(lib, 'line')).toMatchObject({
      stroke: { width: mm(0.3), type: 'dash', color: { r: 200, g: 30, b: 40, a: 1 } },
      fill: 'background'
    })
  })

  it('clears a thickness by removing the node — the auto weight KiCad files carry', () => {
    // `(font (thickness …))` appears 13 times across the 223 standard
    // libraries: absent, meaning "derive from size and bold", is the normal
    // state, so the panel's Auto has to be able to get back to it.
    const lib = applied((l) => {
      const text = addText(node(l, 'R'), 'Note')
      updateSymbolText(text, { thickness: mm(0.3) })
      updateSymbolText(text, { thickness: null })
    })
    expect(serializeKicadSymbolLibrary(lib)).not.toContain('thickness')
    expect(
      (graphicOfLib(lib, 'text') as { effects: { thickness?: number } }).effects.thickness
    ).toBe(undefined)
  })

  it('center justification removes the token rather than writing "center"', () => {
    // KiCad has no `center` token: centerd IS the absence of a justify entry.
    const lib = applied((l) => {
      const text = addText(node(l, 'R'), 'Note')
      updateSymbolText(text, { hAlign: 'right' })
      updateSymbolText(text, { hAlign: 'center' })
    })
    expect(serializeKicadSymbolLibrary(lib)).not.toContain('justify')
  })

  it('inserts exactly the bezier its tool previews, in file order', () => {
    // The insert-path contract, and the reorder that makes it worth pinning: the
    // clicks are start, END, then the two handles, while `(pts …)` holds start,
    // handle, handle, end.
    const start = { x: mm(0), y: mm(0) }
    const end = { x: mm(5.08), y: mm(0) }
    const h1 = { x: mm(1.27), y: mm(2.54) }
    const h2 = { x: mm(3.81), y: mm(2.54) }
    const previewed = toolItems('bezier', [start, end, h1, h2]).graphics[0] as Extract<
      SymbolGraphic,
      { type: 'bezier' }
    >
    const lib = applied((l) => addBezier(node(l, 'R'), previewed.points))
    expect(graphicOfLib(lib, 'bezier')).toMatchObject({
      type: 'bezier',
      points: [start, h1, h2, end]
    })
  })

  it('parses a bezier and keeps it in the graphic index space', () => {
    // Adding a token to SYMBOL_GRAPHIC_TOKENS is the risky half: the AST walk and
    // the typed parse must agree on WHICH graphic is index N, or an edit lands on
    // the wrong shape. This pins both sides with a bezier in the middle.
    const source = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "B"
    (symbol "B_0_1"
      (rectangle (start -1 -1) (end 1 1) (stroke (width 0.254) (type default)) (fill (type none)))
      (bezier (pts (xy -0.381 2.032) (xy -0.635 1.27) (xy -0.635 0.508) (xy -0.381 0))
        (stroke (width 0) (type default)) (fill (type none)))
      (circle (center 0 0) (radius 1) (stroke (width 0.254) (type default)) (fill (type none)))
    )
  )
)
`
    const library = parseKicadSymbolLibrary(source)
    const graphics = library.symbols.get('B')!.variants.flatMap((v) => v.graphics)
    expect(graphics.map((g) => g.type)).toEqual(['rectangle', 'bezier', 'circle'])
    expect(graphics[1]).toMatchObject({
      type: 'bezier',
      points: [
        { x: mm(-0.381), y: mm(2.032) },
        { x: mm(-0.635), y: mm(1.27) },
        { x: mm(-0.635), y: mm(0.508) },
        { x: mm(-0.381), y: mm(0) }
      ]
    })
    // Index 1 must resolve to the bezier NODE too, not to the circle.
    const nodes = symbolGraphicNodes(node(library, 'B'))
    expect(getToken(nodes[1])).toBe('bezier')
    expect(
      symbolPartGraphic(library.symbols.get('B')!, {
        kind: 'graphic',
        unit: 0,
        style: 1,
        index: 1
      })?.type
    ).toBe('bezier')
  })

  it('moves a bezier control point through the same index space', () => {
    const source = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "B"
    (symbol "B_0_1"
      (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0))
        (stroke (width 0) (type default)) (fill (type none)))
    )
  )
)
`
    const library = parseKicadSymbolLibrary(source)
    setGraphicVertex(symbolGraphicNodes(node(library, 'B'))[0], 2, { x: mm(9), y: mm(9) })
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    const bezier = after.symbols.get('B')!.variants.flatMap((v) => v.graphics)[0]
    expect((bezier as { points: Array<{ x: number; y: number }> }).points[2]).toEqual({
      x: mm(9),
      y: mm(9)
    })
    // And translating moves every control point, so the curve keeps its shape.
    translateGraphicNode(symbolGraphicNodes(node(library, 'B'))[0], mm(1), mm(-1))
    const moved = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    const points = (
      moved.symbols.get('B')!.variants.flatMap((v) => v.graphics)[0] as {
        points: Array<{ x: number; y: number }>
      }
    ).points
    expect(points[0]).toEqual({ x: mm(1), y: mm(-1) })
    expect(points[3]).toEqual({ x: mm(4), y: mm(-1) })
  })

  it('removes a graphic', () => {
    const lib = applied((l) => {
      const symbolNode = node(l, 'R')
      const rect = findChildren(unitNode(symbolNode, 'R_0_1'), 'rectangle')[0]
      deleteGraphic(symbolNode, rect)
    })
    expect(variant(lib.symbols.get('R')!, 0, 1).graphics.length).toBe(0)
  })
})

describe('addSymbol / removeSymbol', () => {
  it('adds a minimal valid symbol with two units that previews', () => {
    const lib = applied((l) => addSymbol(l.root, 'MyPart'))
    expect(lib.names).toContain('MyPart')
    const sym = lib.symbols.get('MyPart')!
    expect(sym.variants.length).toBe(2)
    expect(sym.graphics.length).toBe(0)
  })

  it('removes a top-level symbol and leaves siblings intact', () => {
    const lib = applied((l) => removeSymbol(l.root, node(l, 'R_Small')))
    expect(lib.names).toEqual(['R'])
  })
})

describe('node enumeration + translation', () => {
  it('enumerates pin and graphic nodes in the same order the views parse them', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const symbolNode = node(library, 'R')
    expect(symbolPinNodes(symbolNode).length).toBe(2)
    expect(symbolGraphicNodes(symbolNode).length).toBe(1)
  })

  it('translates a pin, preserving its angle', () => {
    const lib = applied((l) =>
      translatePinNode(symbolPinNodes(node(l, 'R'))[0], mm(1.27), mm(-2.54))
    )
    // First pin was (at 0 3.81 270): x 0→1.27, y 3.81→1.27, angle 270 kept.
    expect(serializeKicadSymbolLibrary(lib)).toContain('(at 1.27 1.27 270)')
  })

  it('translates a rectangle graphic by shifting both corners', () => {
    const lib = applied((l) =>
      translateGraphicNode(symbolGraphicNodes(node(l, 'R'))[0], mm(2.54), mm(2.54))
    )
    const rect = variant(lib.symbols.get('R')!, 0, 1).graphics[0] as {
      start: { x: number; y: number }
      end: { x: number; y: number }
    }
    // start (-1.016 -2.54) + (2.54 2.54); end (1.016 2.54) + (2.54 2.54)
    expect(rect.start.x).toBe(mm(1.524))
    expect(rect.start.y).toBeCloseTo(0)
    expect(rect.end.x).toBe(mm(3.556))
    expect(rect.end.y).toBe(mm(5.08))
  })
})

describe('renameSymbol', () => {
  it('renames the top node and cascades to unit sub-symbols', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    renameSymbol(node(library, 'R'), 'RES')
    const reparsed = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    expect(reparsed.names).toContain('RES')
    const units = findChildren(node(reparsed, 'RES'), 'symbol').map((n) => getFirstAtomValue(n))
    expect(units).toEqual(['RES_0_1', 'RES_1_1'])
  })
})

// A fixture with an arc + text graphic and one text/arc unit, for the update
// helpers the R fixture above doesn't exercise.
const GEO_LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "G"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "G_0_1"
      (arc (start -1 0) (mid 0 1) (end 1 0)
        (stroke (width 0.254) (type default)) (fill (type none)))
      (text "hi" (at 0 0 0) (effects (font (size 1.27 1.27))))
    )
  )
)
`
const appliedGeo = (mutate: (lib: KicadSymbolLibrary) => void): KicadSymbolLibrary => {
  const library = parseKicadSymbolLibrary(GEO_LIBRARY)
  mutate(library)
  return parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
}
const graphicOf = (lib: KicadSymbolLibrary, name: string, type: string): unknown =>
  variant(lib.symbols.get(name)!, 0, 1).graphics.find((g) => (g as { type: string }).type === type)
/** `graphicOf` for the shared `R` fixture, whose body graphics are on unit 0. */
const graphicOfLib = (lib: KicadSymbolLibrary, type: string): unknown => graphicOf(lib, 'R', type)

describe('graphic + flag update helpers', () => {
  it('updateRectangle patches corners, stroke, and fill', () => {
    const lib = applied((l) =>
      updateRectangle(symbolGraphicNodes(node(l, 'R'))[0], {
        startX: mm(2),
        strokeWidth: mm(0.5),
        fill: 'background'
      })
    )
    const rect = graphicOf(lib, 'R', 'rectangle') as {
      start: { x: number }
      stroke: { width: number }
      fill: string
    }
    expect(rect.start.x).toBe(mm(2))
    expect(rect.stroke.width).toBe(mm(0.5))
    expect(rect.fill).toBe('background')
  })

  it('updateCircle sets center and radius', () => {
    const lib = applied((l) => {
      const c = addCircle(node(l, 'R'))
      updateCircle(c, { centerX: mm(1.5), radius: mm(3) })
    })
    const circle = graphicOf(lib, 'R', 'circle') as {
      center: { x: number }
      radius: number
    }
    expect(circle.center.x).toBe(mm(1.5))
    expect(circle.radius).toBe(mm(3))
  })

  it('updateArc moves the three points', () => {
    const lib = appliedGeo((l) =>
      updateArc(symbolGraphicNodes(node(l, 'G'))[0], { midY: mm(2), endX: mm(5) })
    )
    const arc = graphicOf(lib, 'G', 'arc') as {
      mid: { y: number }
      end: { x: number }
    }
    expect(arc.mid.y).toBe(mm(2))
    expect(arc.end.x).toBe(mm(5))
  })

  it('updateSymbolText edits text, angle (×10 stored), and size', () => {
    const lib = appliedGeo((l) => {
      const text = symbolGraphicNodes(node(l, 'G')).find((n) => getFirstAtomValue(n) === 'hi')!
      updateSymbolText(text, { text: 'bye', angle: 90, size: mm(2) })
    })
    const text = variant(lib.symbols.get('G')!, 0, 1).graphics.find(
      (g) => (g as { type: string }).type === 'text'
    ) as { text: string; position: { angle: number }; effects: { fontSize: { height: number } } }
    expect(text.text).toBe('bye')
    expect(text.position.angle).toBe(90) // parser divides the stored ×10 back
    expect(text.effects.fontSize.height).toBe(mm(2))
    expect(serializeKicadSymbolLibrary(lib)).toContain('(at 0 0 900)')
  })

  it('updatePin toggles the hidden flag', () => {
    const shown = applied((l) => updatePin(symbolPinNodes(node(l, 'R'))[0], { hidden: true }))
    expect(variant(shown.symbols.get('R')!, 1, 1).pins[0]).toMatchObject({ hidden: true })
    const hiddenAgain = applied((l) => {
      const pin = symbolPinNodes(node(l, 'R'))[0]
      updatePin(pin, { hidden: true })
    })
    const cleared = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(hiddenAgain))
    updatePin(symbolPinNodes(node(cleared, 'R'))[0], { hidden: false })
    const final = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(cleared))
    expect(variant(final.symbols.get('R')!, 1, 1).pins[0]).toMatchObject({ hidden: false })
  })

  it('setSymbolFlag and setSymbolPower toggle symbol-level flags', () => {
    const lib = applied((l) => {
      setSymbolFlag(node(l, 'R'), 'in_bom', false)
      setSymbolFlag(node(l, 'R'), 'exclude_from_sim', true)
      setSymbolPower(node(l, 'R'), true)
    })
    const r = lib.symbols.get('R')!
    expect(r.inBom).toBe(false)
    expect(r.excludeFromSim).toBe(true)
    expect(r.isPower).toBe(true)
    const off = applied((l) => setSymbolPower(node(l, 'R'), false))
    expect(off.symbols.get('R')!.isPower).toBe(false)
  })
})

describe('stroke type / color + fill color (Phase 0 gaps)', () => {
  const rectGraphic = (
    lib: KicadSymbolLibrary
  ): {
    stroke: { width: number; type?: string; color?: { r: number; g: number; b: number; a: number } }
    fillColor?: { r: number; g: number; b: number; a: number }
  } =>
    graphicOf(lib, 'R', 'rectangle') as {
      stroke: {
        width: number
        type?: string
        color?: { r: number; g: number; b: number; a: number }
      }
      fillColor?: { r: number; g: number; b: number; a: number }
    }

  it('parses stroke type + color and fill color when present', () => {
    const src = `(kicad_symbol_lib (version 20231120) (generator "x")
  (symbol "R" (symbol "R_0_1"
    (rectangle (start -1 -1) (end 1 1)
      (stroke (width 0.2) (type dash) (color 10 20 30 1))
      (fill (type color) (color 40 50 60 0.5))))))`
    const lib = parseKicadSymbolLibrary(src)
    const rect = rectGraphic(lib)
    expect(rect.stroke.type).toBe('dash')
    expect(rect.stroke.color).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(rect.fillColor).toEqual({ r: 40, g: 50, b: 60, a: 0.5 })
  })

  it('updateRectangle writes stroke type/color and fill color', () => {
    const lib = applied((l) =>
      updateRectangle(symbolGraphicNodes(node(l, 'R'))[0], {
        strokeType: 'dot',
        strokeColor: { r: 1, g: 2, b: 3, a: 1 },
        fillColor: { r: 4, g: 5, b: 6, a: 0.25 }
      })
    )
    const rect = rectGraphic(lib)
    expect(rect.stroke.type).toBe('dot')
    expect(rect.stroke.color).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(rect.fillColor).toEqual({ r: 4, g: 5, b: 6, a: 0.25 })
  })

  it('clearing a stroke color drops the (color …) node', () => {
    const src = `(kicad_symbol_lib (version 20231120) (generator "x")
  (symbol "R" (symbol "R_0_1"
    (rectangle (start -1 -1) (end 1 1)
      (stroke (width 0.2) (type default) (color 10 20 30 1)) (fill (type none))))))`
    const lib = parseKicadSymbolLibrary(src)
    updateRectangle(symbolGraphicNodes(lib.symbols.get('R')!._node)[0], { strokeColor: null })
    const round = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    expect(rectGraphic(round).stroke.color).toBeUndefined()
  })

  it('a geometry-only edit does not inject stroke type/color or fill color', () => {
    const lib = applied((l) =>
      updateRectangle(symbolGraphicNodes(node(l, 'R'))[0], { startX: mm(2) })
    )
    const out = serializeKicadSymbolLibrary(lib)
    expect(out).not.toContain('(color')
  })
})

describe('setTextEffects (Phase 0 gaps)', () => {
  it('sets bold/italic/justify/size on symbol text', () => {
    const src = `(kicad_symbol_lib (version 20231120) (generator "x")
  (symbol "G" (symbol "G_0_1"
    (text "hi" (at 0 0 0) (effects (font (size 1.27 1.27)))))))`
    const lib = parseKicadSymbolLibrary(src)
    const text = symbolGraphicNodes(lib.symbols.get('G')!._node).find(
      (n) => getFirstAtomValue(n) === 'hi'
    )!
    updateSymbolText(text, {
      bold: true,
      italic: true,
      hAlign: 'left',
      vAlign: 'top',
      fontHeight: mm(2)
    })
    const round = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    const g = round.symbols.get('G')!.variants.find((v) => v.unit === 0 && v.style === 1)!
    const t = g.graphics.find((x) => (x as { type: string }).type === 'text') as {
      effects: {
        bold: boolean
        italic: boolean
        horizontalAlign: string
        verticalAlign: string
        fontSize: { height: number }
      }
    }
    expect(t.effects.bold).toBe(true)
    expect(t.effects.italic).toBe(true)
    expect(t.effects.horizontalAlign).toBe('left')
    expect(t.effects.verticalAlign).toBe('top')
    expect(t.effects.fontSize.height).toBe(mm(2))
  })

  it('a plain text/position edit injects no (effects …) churn', () => {
    const src = `(kicad_symbol_lib (version 20231120) (generator "x")
  (symbol "G" (symbol "G_0_1"
    (text "hi" (at 0 0 0)))))`
    const lib = parseKicadSymbolLibrary(src)
    const text = symbolGraphicNodes(lib.symbols.get('G')!._node).find(
      (n) => getFirstAtomValue(n) === 'hi'
    )!
    updateSymbolText(text, { text: 'bye' })
    expect(serializeKicadSymbolLibrary(lib)).not.toContain('(effects')
  })
})

describe('selection transforms', () => {
  /** The R symbol's two pins, in the document order the canvas indexes against. */
  const pinsOf = (lib: KicadSymbolLibrary): SymbolPin[] =>
    lib.symbols.get('R')!.variants.flatMap((v) => v.pins)
  const rectOf = (lib: KicadSymbolLibrary): Extract<SymbolGraphic, { type: 'rectangle' }> =>
    lib.symbols
      .get('R')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'rectangle') as Extract<SymbolGraphic, { type: 'rectangle' }>

  it('rotates a pin counter-clockwise about a pivot, turning its heading', () => {
    // Pin 1 sits at (0, 3.81) pointing 270°. A quarter turn about the origin in
    // y-up space sends (x, y) to (-y, x).
    const lib = applied((l) =>
      rotatePinNode(symbolPinNodes(node(l, 'R'))[0], { x: mm(0), y: mm(0) })
    )
    const pin = pinsOf(lib)[0]
    expect(pin.position.x).toBe(mm(-3.81))
    expect(pin.position.y).toBe(0)
    expect(pin.position.angle).toBe(0)
  })

  it('returns a pin to its exact original after four quarter turns', () => {
    // The round trip that would expose drift: four rotations off-origin, each
    // serialized and reparsed, must land byte-identically back where it started.
    const before = serializeKicadSymbolLibrary(parseKicadSymbolLibrary(LIBRARY))
    let lib = parseKicadSymbolLibrary(LIBRARY)
    for (let i = 0; i < 4; i++) {
      lib = appliedTo(lib, (l) =>
        rotatePinNode(symbolPinNodes(node(l, 'R'))[0], { x: mm(1.27), y: mm(-2.54) })
      )
    }
    expect(serializeKicadSymbolLibrary(lib)).toBe(before)
  })

  it('mirrors a pin horizontally, flipping the direction it points', () => {
    const lib = applied((l) =>
      mirrorPinNode(symbolPinNodes(node(l, 'R'))[1], { x: mm(0), y: mm(0) }, 'horizontal')
    )
    const pin = pinsOf(lib)[1]
    // Pin 2 is at (0, -3.81) heading 90° — a horizontal flip about x=0 leaves
    // both the position and the vertical heading untouched.
    expect(pin.position.x).toBe(0)
    expect(pin.position.y).toBe(mm(-3.81))
    expect(pin.position.angle).toBe(90)
  })

  it('mirrors a pin vertically, negating its heading', () => {
    const lib = applied((l) =>
      mirrorPinNode(symbolPinNodes(node(l, 'R'))[1], { x: mm(0), y: mm(0) }, 'vertical')
    )
    const pin = pinsOf(lib)[1]
    expect(pin.position.y).toBe(mm(3.81))
    expect(pin.position.angle).toBe(270)
  })

  it('keeps a rectangle axis-aligned through a quarter turn', () => {
    const lib = applied((l) =>
      rotateGraphicNode(symbolGraphicNodes(node(l, 'R'))[0], { x: mm(0), y: mm(0) })
    )
    const rect = rectOf(lib)
    // (-1.016,-2.54)-(1.016,2.54) rotated CCW about the origin swaps the extents.
    expect([rect.start.x, rect.start.y]).toEqual([mm(2.54), mm(-1.016)])
    expect([rect.end.x, rect.end.y]).toEqual([mm(-2.54), mm(1.016)])
  })

  it('mirrors a rectangle across the pivot', () => {
    const lib = applied((l) =>
      mirrorGraphicNode(symbolGraphicNodes(node(l, 'R'))[0], { x: mm(2), y: mm(0) }, 'horizontal')
    )
    const rect = rectOf(lib)
    expect(rect.start.x).toBe(mm(5.016))
    expect(rect.end.x).toBe(mm(2.984))
    expect(rect.start.y).toBe(mm(-2.54))
  })

  /**
   * A symbol text at `angle`, transformed, read back through a serialize/parse
   * round trip — the angle in DEGREES the file would hold.
   */
  const transformedTextAngleOf = (
    angle: number,
    transform: (textNode: ReturnType<typeof addText>) => void
  ): number => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    transform(addText(node(library, 'R'), 'hi', { x: mm(2.54), y: mm(1.27), angle }))
    return (
      parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
        .symbols.get('R')!
        .variants.flatMap((v) => v.graphics)
        .find((g) => g.type === 'text') as Extract<SymbolGraphic, { type: 'text' }>
    ).position.angle
  }

  it('mirrors a symbol text without turning it', () => {
    // KiCad's symbol text angle is two-state, not four: probed with `kicad-cli
    // sym export svg`, a `(text …)` draws horizontal at exactly 0 and vertical
    // bottom→top at every other angle. So a mirror moves a text, never turns it.
    for (const axis of ['horizontal', 'vertical'] as const) {
      expect(
        transformedTextAngleOf(0, (t) => mirrorGraphicNode(t, { x: mm(2), y: mm(0) }, axis))
      ).toBe(0)
      expect(
        transformedTextAngleOf(90, (t) => mirrorGraphicNode(t, { x: mm(2), y: mm(0) }, axis))
      ).toBe(90)
    }
  })

  it('still mirrors a text ACROSS the pivot, angle aside', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const textNode = addText(node(library, 'R'), 'hi', { x: mm(2.54), y: mm(1.27), angle: 0 })
    mirrorGraphicNode(textNode, { x: mm(2), y: mm(0) }, 'horizontal')
    const text = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
      .symbols.get('R')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'text') as Extract<SymbolGraphic, { type: 'text' }>
    expect(text.position).toMatchObject({ x: mm(1.46), y: mm(1.27), angle: 0 })
  })

  it('toggles a symbol text between the only two angles KiCad draws', () => {
    const turns = (count: number): number =>
      transformedTextAngleOf(0, (t) => {
        for (let i = 0; i < count; i++) rotateGraphicNode(t, { x: mm(0), y: mm(0) })
      })
    expect([turns(1), turns(2), turns(3), turns(4)]).toEqual([90, 0, 90, 0])
  })

  it('leaves a text_box free-angle, where KiCad honors 180 literally', () => {
    // The same probe draws a text_box at 180 upside down: the two-state snap is
    // a `text` rule only.
    const library = parseKicadSymbolLibrary(TEXT_BOX_LIBRARY)
    mirrorGraphicNode(
      symbolGraphicNodes(node(library, 'T'))[1],
      { x: mm(0), y: mm(0) },
      'horizontal'
    )
    const box = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
      .symbols.get('T')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'textBox') as Extract<SymbolGraphic, { type: 'textBox' }>
    expect(box.position.angle).toBe(180)
  })

  it('bounds a pin from its anchor to its far end', () => {
    const symbol = parseKicadSymbolLibrary(LIBRARY).symbols.get('R')!
    const pins = symbol.variants.flatMap((v) => v.pins)
    // Pin 1: anchor (0, 3.81), heading 270°, length 1.27 → far end (0, 2.54).
    const bounds = symbolItemsBounds([pins[0]], [])!
    expect(bounds.minY).toBe(mm(2.54))
    expect(bounds.maxY).toBe(mm(3.81))
    expect(boundsCenter(bounds).y).toBe(mm(3.175))
  })

  it('spans pins and graphics together, and is null for an empty selection', () => {
    const symbol = parseKicadSymbolLibrary(LIBRARY).symbols.get('R')!
    const pins = symbol.variants.flatMap((v) => v.pins)
    const graphics = symbol.variants.flatMap((v) => v.graphics)
    const bounds = symbolItemsBounds(pins, graphics)!
    expect(bounds.minX).toBe(mm(-1.016))
    expect(bounds.maxY).toBe(mm(3.81))
    expect(symbolItemsBounds([], [])).toBeNull()
  })
})

describe('copying items', () => {
  it('reports the highest integer pin number, ignoring non-numeric ones', () => {
    const lib = parseKicadSymbolLibrary(LIBRARY)
    expect(maxPinNumber(node(lib, 'R'))).toBe(2)
  })

  it('treats a symbol with no numeric pin numbers as starting from zero', () => {
    const lib = applied((l) => updatePin(symbolPinNodes(node(l, 'R'))[0], { number: 'A1' }))
    // Pin 2 still numbers 2; only the renamed one drops out of the running.
    expect(maxPinNumber(node(lib, 'R'))).toBe(2)
    const bare = applied((l) => {
      const pins = symbolPinNodes(node(l, 'R'))
      updatePin(pins[0], { number: 'A1' })
      updatePin(pins[1], { number: 'A2' })
    })
    expect(maxPinNumber(node(bare, 'R'))).toBe(0)
  })

  it('finds the unit that owns a node, and null for a stranger', () => {
    const lib = parseKicadSymbolLibrary(LIBRARY)
    const symbol = node(lib, 'R')
    const pin = symbolPinNodes(symbol)[0]
    expect(getFirstAtomValue(owningUnitNode(symbol, pin)!)).toBe('R_1_1')
    const rect = symbolGraphicNodes(symbol)[0]
    expect(getFirstAtomValue(owningUnitNode(symbol, rect)!)).toBe('R_0_1')
    expect(owningUnitNode(node(lib, 'R_Small'), pin)).toBeNull()
  })

  it('routes a fresh node to its conventional unit: pins _1_1, graphics _0_1', () => {
    const lib = parseKicadSymbolLibrary(LIBRARY)
    const symbol = node(lib, 'R')
    const pin = symbolPinNodes(symbol)[0]
    const rect = symbolGraphicNodes(symbol)[0]
    expect(getFirstAtomValue(defaultUnitNodeFor(symbol, pin))).toBe('R_1_1')
    expect(getFirstAtomValue(defaultUnitNodeFor(symbol, rect))).toBe('R_0_1')
  })

  it('appends an independent deep copy — editing the clone leaves the source alone', () => {
    const lib = applied((l) => {
      const symbol = node(l, 'R')
      const source = symbolPinNodes(symbol)[0]
      const clone = appendNodeCopy(owningUnitNode(symbol, source)!, source)
      updatePin(clone, { number: '99', x: mm(10) })
    })
    const pins = lib.symbols.get('R')!.variants.flatMap((v) => v.pins)
    expect(pins).toHaveLength(3)
    expect(pins[0].number).toBe('1')
    expect(pins[0].position.x).toBe(0)
    expect(pins[2].number).toBe('99')
    expect(pins[2].position.x).toBe(mm(10))
  })

  it('round-trips a copy through serialize/parse, the paste path', () => {
    const lib = parseKicadSymbolLibrary(LIBRARY)
    const source = symbolPinNodes(node(lib, 'R'))[0]
    const text = serializeSExpr(source)
    const reparsed = parseSExpr(text)
    expect(reparsed.type).toBe('list')
    const target = node(lib, 'R_Small')
    appendNodeCopy(defaultUnitNodeFor(target, reparsed as SExprList), reparsed as SExprList)
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    const pasted = after.symbols.get('R_Small')!.variants.flatMap((v) => v.pins)
    expect(pasted.some((p) => p.number === '1' && p.position.y === mm(3.81))).toBe(true)
  })
})

describe('spacingToMm / mmToSpacing', () => {
  it('converts a mil grid to millimeters and back', () => {
    expect(spacingToMm(50, 'mil')).toBe(1.27)
    expect(spacingToMm(1.27, 'mm')).toBe(1.27)
    expect(mmToSpacing(1.27, 'mil')).toBe(50)
    expect(mmToSpacing(1.27, 'mm')).toBe(1.27)
  })
})

describe('units', () => {
  // A dual gate with a shared body, the shape of a real 74S140: unit 0 carries
  // the common outline, units 1 and 2 the two gates.
  const DUAL = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "DUAL"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_0_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "DUAL_1_1"
      (unit_name "NMOS")
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
  const dual = (): KicadSymbolLibrary => parseKicadSymbolLibrary(DUAL)
  const dualNode = (lib: KicadSymbolLibrary): SExprList => lib.symbols.get('DUAL')!._node

  it('enumerates units and counts gates, ignoring the common body', () => {
    const node = dualNode(dual())
    expect(symbolUnitNumbers(node)).toEqual([0, 1, 2])
    // Unit 0 is the shared body, not a gate — the package has two.
    expect(symbolUnitCount(node)).toBe(2)
  })

  it('counts one body style when the symbol has no alternate', () => {
    expect(symbolBodyStyleNumbers(dualNode(dual()))).toEqual([1])
    expect(symbolBodyStyleCount(dualNode(dual()))).toBe(1)
  })

  it('moves a pin into the shared unit and back, keeping its body style', () => {
    // KiCad's "Common to all units in symbol" is WHERE the part is stored, so
    // this re-parents the node between `DUAL_1_1` and `DUAL_0_1` rather than
    // writing a flag. Style stays 1 throughout: the editor draws styles 0 and 1
    // only, so a move must never land a part in a body style we cannot show.
    const lib = dual()
    const symbolNode = dualNode(lib)
    const pin = symbolPinNodes(symbolNode)[0]
    movePartToUnit(symbolNode, pin, 0, 1)
    const shared = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib)).symbols.get('DUAL')!
    expect(variant(shared, 0, 1).pins).toHaveLength(1)
    expect(variant(shared, 1, 1).pins).toHaveLength(0)

    movePartToUnit(symbolNode, pin, 2, 1)
    const gate2 = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib)).symbols.get('DUAL')!
    expect(variant(gate2, 0, 1).pins).toHaveLength(0)
    expect((variant(gate2, 2, 1).pins as SymbolPin[]).map((p) => p.number)).toEqual(['2', '1'])
  })

  it('re-addresses a moved part, since an address names the unit holding it', () => {
    // The reason the editor re-derives its selection after the move: index 0 of
    // unit 1 becomes index N of unit 0, and a stale address would retarget the
    // next edit at whatever now sits where the part used to be.
    const lib = dual()
    const symbolNode = dualNode(lib)
    const pin = symbolPinNodes(symbolNode)[0]
    expect(addressOfPartNode(symbolNode, pin)).toEqual({
      kind: 'pin',
      unit: 1,
      style: 1,
      index: 0
    })
    movePartToUnit(symbolNode, pin, 0, 1)
    expect(addressOfPartNode(symbolNode, pin)).toEqual({
      kind: 'pin',
      unit: 0,
      style: 1,
      index: 0
    })
  })

  it('treats a symbol with only a common body as single-unit', () => {
    const lib = parseKicadSymbolLibrary(LIBRARY)
    expect(symbolUnitCount(node(lib, 'R'))).toBe(1)
  })

  it('reads KiCad 7+ unit names, and reports null when absent', () => {
    const n = dualNode(dual())
    expect(symbolUnitName(n, 1)).toBe('NMOS')
    expect(symbolUnitName(n, 2)).toBeNull()
  })

  it('labels units by letter, matching the U1A / U1B suffix', () => {
    expect(unitLetter(1)).toBe('A')
    expect(unitLetter(2)).toBe('B')
    expect(unitLetter(4)).toBe('D')
  })

  it('adds the next unit and reports its number', () => {
    const lib = dual()
    const n = dualNode(lib)
    expect(addUnit(n)).toBe(3)
    expect(symbolUnitCount(n)).toBe(3)
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    expect(serializeKicadSymbolLibrary(after)).toContain('"DUAL_3_1"')
  })

  it('removes a unit and everything drawn on it, leaving the others intact', () => {
    const lib = dual()
    removeUnit(dualNode(lib), 1)
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    const text = serializeKicadSymbolLibrary(after)
    expect(text).not.toContain('"DUAL_1_1"')
    expect(text).not.toContain('"A"')
    expect(text).toContain('"DUAL_2_1"')
    expect(text).toContain('"DUAL_0_1"')
    expect(symbolUnitCount(dualNode(after))).toBe(2)
  })

  it('never removes unit 0 — the common body is not a gate', () => {
    const lib = dual()
    removeUnit(dualNode(lib), 0)
    expect(serializeKicadSymbolLibrary(lib)).toContain('"DUAL_0_1"')
  })

  it('adds pins and graphics into the unit being edited', () => {
    const lib = dual()
    const n = dualNode(lib)
    addPin(
      n,
      {
        name: 'C',
        number: '3',
        x: mm(0),
        y: mm(0),
        angle: 0,
        length: mm(2.54),
        electricalType: 'input',
        graphicStyle: 'line'
      },
      2
    )
    addCircle(n, undefined, undefined, 2)
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    const unit2 = after.symbols.get('DUAL')!.variants.find((v) => v.unit === 2)!
    expect(unit2.pins.map((p) => p.number)).toEqual(['2', '3'])
    expect(unit2.graphics.some((g) => g.type === 'circle')).toBe(true)
    // Unit 1 is untouched by an edit aimed at unit 2.
    const unit1 = after.symbols.get('DUAL')!.variants.find((v) => v.unit === 1)!
    expect(unit1.pins).toHaveLength(1)
  })
})

describe('body styles', () => {
  const libraryOf = (subSymbols: string): SExprList =>
    parseKicadSymbolLibrary(`(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "G"
    (body_styles demorgan)
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
${subSymbols}
  )
)
`).symbols.get('G')!._node

  const STANDARD_AND_ALTERNATE = `    (symbol "G_0_0"
      (polyline (pts (xy 0 0) (xy 1 0))
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "G_1_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "G_1_2"
      (circle (center 0 0) (radius 5)
        (stroke (width 0.254) (type default)) (fill (type none))))`

  it('enumerates the styles present, ignoring the common style 0', () => {
    const node = libraryOf(STANDARD_AND_ALTERNATE)
    expect(symbolBodyStyleNumbers(node)).toEqual([1, 2])
    expect(symbolBodyStyleCount(node)).toBe(2)
  })

  // `Interface:LTC1519` in KiCad 10's standard library declares `demorgan` — two
  // styles — and ships a `_3_3` sub-symbol anyway. Counting the sub-symbols that
  // exist rather than trusting the declaration is what keeps that geometry
  // reachable instead of silently unrenderable.
  it('counts geometry the (body_styles …) declaration does not cover', () => {
    const node = libraryOf(`${STANDARD_AND_ALTERNATE}
    (symbol "G_1_3"
      (circle (center 0 0) (radius 7)
        (stroke (width 0.254) (type default)) (fill (type none))))`)
    expect(symbolBodyStyleNumbers(node)).toEqual([1, 2, 3])
    expect(symbolBodyStyleCount(node)).toBe(3)
  })

  // A symbol whose own name ends in digits (`Raspberry_Pi_2_3` is real) must not
  // read as a variant of itself.
  it('does not mistake a trailing number in the symbol name for a variant', () => {
    const node = parseKicadSymbolLibrary(`(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "Raspberry_Pi_2_3"
    (property "Reference" "J" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "Raspberry_Pi_2_3_1_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none))))
  )
)
`).symbols.get('Raspberry_Pi_2_3')!._node
    expect(symbolBodyStyleNumbers(node)).toEqual([1])
    expect(symbolUnitNumbers(node)).toEqual([1])
  })
})

describe('vertex editing', () => {
  const graphicsOf = (lib: KicadSymbolLibrary): SymbolGraphic[] =>
    lib.symbols.get('R')!.variants.flatMap((v) => v.graphics)
  const rectOf = (lib: KicadSymbolLibrary): Extract<SymbolGraphic, { type: 'rectangle' }> =>
    graphicsOf(lib).find((g) => g.type === 'rectangle') as Extract<
      SymbolGraphic,
      { type: 'rectangle' }
    >

  it('lists a rectangle by its two corners', () => {
    const rect = rectOf(parseKicadSymbolLibrary(LIBRARY))
    expect(graphicVertexPoints(rect)).toEqual([rect.start, rect.end])
  })

  it('marks a text by its anchor and gives it no handle', () => {
    const text: SymbolGraphic = {
      type: 'text',
      text: 'REF',
      position: { x: mm(2), y: mm(-3), angle: 0 },
      effects: {
        fontSize: { height: mm(1.27), width: mm(1.27) },
        bold: false,
        italic: false,
        lineSpacing: 1,
        horizontalAlign: 'left',
        verticalAlign: 'center',
        hidden: false
      }
    }
    expect(graphicAnchorPoint(text)).toEqual({ x: mm(2), y: mm(-3), angle: 0 })
    // The two are alternatives, never both: a square handle at the anchor would
    // promise a resize, and writing that point moves the text.
    expect(graphicVertexPoints(text)).toHaveLength(1)
  })

  it('gives shapes no anchor — their points are already on the drawing', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    expect(graphicAnchorPoint(rectOf(library))).toBeNull()
    // A text box's `at` is its top-left CORNER, which its border draws and a
    // resize handle already marks — so it is not an invisible anchor either.
    const box = parseKicadSymbolLibrary(TEXT_BOX_LIBRARY)
      .symbols.get('T')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'textBox')!
    expect(graphicAnchorPoint(box)).toBeNull()
  })

  it('puts a circle handle on the rim, so dragging it sets the radius', () => {
    const circle: SymbolGraphic = {
      type: 'circle',
      center: { x: mm(2), y: mm(3) },
      radius: mm(1.5),
      stroke: { width: mm(0.254) },
      fill: 'none'
    }
    expect(graphicVertexPoints(circle)).toEqual([
      { x: mm(2), y: mm(3) },
      { x: mm(3.5), y: mm(3) }
    ])
  })

  it('moves the grabbed rectangle corner and leaves the other alone', () => {
    const before = rectOf(parseKicadSymbolLibrary(LIBRARY))
    const lib = applied((l) =>
      setGraphicVertex(symbolGraphicNodes(node(l, 'R'))[0], 1, { x: mm(5), y: mm(-5) })
    )
    const after = rectOf(lib)
    expect(after.end).toEqual({ x: mm(5), y: mm(-5) })
    expect(after.start).toEqual(before.start)
  })

  it('turns a rim drag into a radius, not a moved center', () => {
    const lib = applied((l) => {
      const symbol = node(l, 'R')
      const circle = addCircle(symbol, { x: mm(0), y: mm(0) }, mm(1))
      setGraphicVertex(circle, 1, { x: mm(4), y: mm(0) })
    })
    const circle = graphicsOf(lib).find((g) => g.type === 'circle') as Extract<
      SymbolGraphic,
      { type: 'circle' }
    >
    expect(circle.center).toEqual({ x: mm(0), y: mm(0) })
    expect(circle.radius).toBe(mm(4))
  })

  it('moves one polyline point and keeps the rest', () => {
    const lib = applied((l) => {
      const symbol = node(l, 'R')
      const line = addPolyline(
        symbol,
        [
          { x: mm(0), y: mm(0) },
          { x: mm(1), y: mm(0) },
          { x: mm(2), y: mm(0) }
        ],
        0
      )
      setGraphicVertex(line, 1, { x: mm(1), y: mm(5) })
    })
    const line = graphicsOf(lib).find((g) => g.type === 'line') as Extract<
      SymbolGraphic,
      { type: 'line' }
    >
    expect(line.points).toEqual([
      { x: mm(0), y: mm(0) },
      { x: mm(1), y: mm(5) },
      { x: mm(2), y: mm(0) }
    ])
  })

  // The whole point of the typed writer is that a resize can be PREVIEWED
  // without going through the AST. If the two ever disagree, the shape you drag
  // is not the shape you get — which is the bug it was written to fix.
  it('previews the same geometry the AST writer commits, for every vertex', () => {
    const target = { x: mm(3.5), y: mm(-1.25) }
    const withBody = (body: string): string => `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "G" (symbol "G_0_1" ${body}))
)`
    const stroke = '(stroke (width 0.254) (type default)) (fill (type none))'
    const cases: Array<{ body: string; vertices: number[] }> = [
      { body: `(rectangle (start -1 -2) (end 1 2) ${stroke})`, vertices: [0, 1] },
      { body: `(circle (center 1 2) (radius 1.5) ${stroke})`, vertices: [0, 1] },
      { body: `(arc (start -1 0) (mid 0 1) (end 1 0) ${stroke})`, vertices: [0, 1, 2] },
      {
        body: `(polyline (pts (xy 0 0) (xy 1 0) (xy 2 0)) ${stroke})`,
        vertices: [0, 1, 2]
      }
    ]

    for (const { body, vertices } of cases) {
      for (const vertexIndex of vertices) {
        const source = withBody(body)
        const graphicOf = (lib: KicadSymbolLibrary): SymbolGraphic =>
          lib.symbols.get('G')!.variants.flatMap((v) => v.graphics)[0]

        const typed = setTypedGraphicVertex(
          graphicOf(parseKicadSymbolLibrary(source)),
          vertexIndex,
          target
        )

        const library = parseKicadSymbolLibrary(source)
        setGraphicVertex(symbolGraphicNodes(node(library, 'G'))[0], vertexIndex, target)
        const committed = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))

        expect(graphicOf(committed)).toEqual(typed)
      }
    }
  })

  // The INSERT side of the same contract, for the two tools whose typed form and
  // stored form are ordered differently: an arc's clicks arrive start → end →
  // bulge while the file holds start/mid/end, and a text's angle is degrees in
  // the preview and decidegrees in the file. Either could disagree silently.
  it('inserts exactly the arc and text their tools preview', () => {
    const clicks = [
      { x: mm(-2.54), y: mm(0) },
      { x: mm(2.54), y: mm(0) },
      { x: mm(0), y: mm(2.54) }
    ]
    const arc = toolItems('arc', clicks).graphics[0] as Extract<SymbolGraphic, { type: 'arc' }>
    const arcLib = applied((l) => addArc(node(l, 'R'), arc.start, arc.mid, arc.end))
    expect(graphicOfLib(arcLib, 'arc')).toMatchObject({
      start: arc.start,
      mid: arc.mid,
      end: arc.end
    })

    const turned = toolItems('text', [{ x: mm(1.27), y: mm(-1.27) }], {
      quarterTurns: 1,
      mirror: null
    })
    const text = turned.graphics[0] as Extract<SymbolGraphic, { type: 'text' }>
    expect(text.position.angle).toBe(90) // degrees in the typed form
    const textLib = applied((l) => addText(node(l, 'R'), text.text, text.position))
    expect(graphicOfLib(textLib, 'text')).toMatchObject({
      text: text.text,
      position: text.position,
      effects: text.effects
    })
  })

  it('leaves a typed graphic untouched for an index it does not have', () => {
    const rect = rectOf(parseKicadSymbolLibrary(LIBRARY))
    expect(setTypedGraphicVertex(rect, 9, { x: mm(1), y: mm(1) })).toEqual(rect)
    expect(setTypedGraphicVertex(rect, -1, { x: mm(1), y: mm(1) })).toEqual(rect)
  })

  it('ignores a vertex index the graphic does not have', () => {
    const before = serializeKicadSymbolLibrary(parseKicadSymbolLibrary(LIBRARY))
    const lib = applied((l) =>
      setGraphicVertex(symbolGraphicNodes(node(l, 'R'))[0], 9, { x: mm(1), y: mm(1) })
    )
    // A rectangle has corners 0 and 1 only — index 9 must not fall through to
    // the last one, which would silently resize the wrong edge.
    expect(serializeKicadSymbolLibrary(lib)).toBe(before)

    const poly = applied((l) => {
      const line = addPolyline(node(l, 'R'), [{ x: mm(0), y: mm(0) }], 0)
      setGraphicVertex(line, 5, { x: mm(9), y: mm(9) })
    })
    const line = graphicsOf(poly).find((g) => g.type === 'line') as Extract<
      SymbolGraphic,
      { type: 'line' }
    >
    expect(line.points).toEqual([{ x: mm(0), y: mm(0) }])
  })
})

// Naming parts instead of counting them. See ARCHITECTURE.md §3.7: the symbol
// editor's flat cross-unit index was replaced, because
// a name describes where a part lives rather than how many precede it.
describe('addressing parts by name', () => {
  const MULTI = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "U"
    (symbol "U_0_1"
      (rectangle (start -1 -2) (end 1 2)
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "U_1_1"
      (pin passive line (at 0 3 270) (length 1)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "U_2_1"
      (pin passive line (at 0 -3 90) (length 1)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))))
)`
  const parse = (): KicadSymbolLibrary => parseKicadSymbolLibrary(MULTI)
  const numberOf = (n: SExprList | null): string | undefined =>
    n ? getFirstAtomValue(findChildren(n, 'number')[0]) : undefined

  it('enumerates every part with the unit it lives in', () => {
    const addresses = symbolPartAddresses(node(parse(), 'U'))
    expect(addresses).toEqual([
      { kind: 'graphic', unit: 0, style: 1, index: 0 },
      { kind: 'pin', unit: 1, style: 1, index: 0 },
      { kind: 'pin', unit: 2, style: 1, index: 0 }
    ])
  })

  it('resolves a name to the node it addresses, and back again', () => {
    const symbol = node(parse(), 'U')
    const address = { kind: 'pin' as const, unit: 2, style: 1, index: 0 }
    const pin = symbolPartNode(symbol, address)
    expect(numberOf(pin)).toBe('2')
    expect(addressOfPartNode(symbol, pin!)).toEqual(address)
  })

  it('returns null for a part the symbol does not have', () => {
    const symbol = node(parse(), 'U')
    expect(symbolPartNode(symbol, { kind: 'pin', unit: 9, style: 1, index: 0 })).toBeNull()
    expect(symbolPartNode(symbol, { kind: 'pin', unit: 1, style: 1, index: 7 })).toBeNull()
    expect(symbolPartNode(symbol, { kind: 'graphic', unit: 1, style: 1, index: 0 })).toBeNull()
  })

  // The reason this exists. A flat index counts across units, so anything added
  // to an earlier unit renumbers every later part — and a selection held across
  // that add silently retargets. A name does not move.
  it('a name survives an add to an earlier unit; a flat index does not', () => {
    const library = parse()
    const symbol = node(library, 'U')
    const address = { kind: 'pin' as const, unit: 2, style: 1, index: 0 }

    const flatBefore = symbolPinNodes(symbol).indexOf(symbolPartNode(symbol, address)!)
    expect(numberOf(symbolPinNodes(symbol)[flatBefore])).toBe('2')

    addPin(symbol, {
      name: 'C',
      number: '3',
      x: mm(5),
      y: mm(0),
      angle: 180,
      length: mm(2.54),
      electricalType: 'input',
      graphicStyle: 'line'
    })

    // Same flat index, different pin — the selection moved without being asked.
    expect(numberOf(symbolPinNodes(symbol)[flatBefore])).toBe('3')
    // Same name, same pin.
    expect(numberOf(symbolPartNode(symbol, address))).toBe('2')
  })
})

// ---------------------------------------------------------------------------
// text_box — the last symbol graphic that rendered as nothing.
//
// It was PARSED by no one and drawn by no one, so opening AD574A silently lost
// 14 internal labels. Layout rules (margins, wrap, justification) live in
// textBox.test.ts; these cover the AST side: index space, round-trip, and the
// two units the format uses for an angle.
// ---------------------------------------------------------------------------

const TEXT_BOX_LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "T"
    (symbol "T_0_1"
      (rectangle (start -1 -1) (end 1 1) (stroke (width 0.254) (type default)) (fill (type none)))
      (text_box "10V\\nREF"
        (at -17.78 6.35 0)
        (size 7.62 -7.62)
        (margins 1.016 1.016 1.016 1.016)
        (stroke (width 0.254) (type default))
        (fill (type none))
        (effects (font (size 1.27 1.27) (bold yes)))
      )
      (circle (center 0 0) (radius 1) (stroke (width 0.254) (type default)) (fill (type none)))
    )
  )
)
`

describe('text_box', () => {
  const parsed = (): KicadSymbolLibrary => parseKicadSymbolLibrary(TEXT_BOX_LIBRARY)
  const boxOf = (lib: KicadSymbolLibrary): Extract<SymbolGraphic, { type: 'textBox' }> =>
    lib.symbols
      .get('T')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'textBox') as Extract<SymbolGraphic, { type: 'textBox' }>

  it('parses the anchor, extent and margins', () => {
    expect(boxOf(parsed())).toMatchObject({
      type: 'textBox',
      text: '10V\nREF',
      position: { x: mm(-17.78), y: mm(6.35), angle: 0 },
      size: { width: mm(7.62), height: mm(-7.62) },
      margins: { left: mm(1.016), top: mm(1.016), right: mm(1.016), bottom: mm(1.016) }
    })
  })

  it('keeps it in the graphic index space', () => {
    // The risky half of adding a token to SYMBOL_GRAPHIC_TOKENS: the AST walk
    // and the typed parse must agree on WHICH graphic is index N, or an edit
    // lands on the wrong shape. Pinned with the box between two other graphics.
    const library = parsed()
    const graphics = library.symbols.get('T')!.variants.flatMap((v) => v.graphics)
    expect(graphics.map((g) => g.type)).toEqual(['rectangle', 'textBox', 'circle'])
    expect(getToken(symbolGraphicNodes(node(library, 'T'))[1])).toBe('text_box')
    expect(
      symbolPartGraphic(library.symbols.get('T')!, {
        kind: 'graphic',
        unit: 0,
        style: 1,
        index: 1
      })?.type
    ).toBe('textBox')
  })

  it('round-trips losslessly — serialize is a fixpoint, and nothing is dropped', () => {
    // The RULES.md §7 invariant on the primitive most likely to lose data.
    // Asserted as a FIXPOINT rather than against the source text above, because
    // the source is hand-written and not in KiCad's canonical layout — the
    // serializer reflows it once, which is a formatting difference and not a
    // loss. What must hold is that a second pass changes nothing further, and
    // that every field of the box survives the trip.
    const once = serializeKicadSymbolLibrary(parsed())
    expect(serializeKicadSymbolLibrary(parseKicadSymbolLibrary(once))).toBe(once)
    expect(once).toContain('text_box')
    expect(once).toContain('(margins 1.016 1.016 1.016 1.016)')
    expect(boxOf(parseKicadSymbolLibrary(once))).toMatchObject(boxOf(parsed()))
  })

  it('reads its angle as DEGREES, not the decidegrees a text uses', () => {
    // Verified against KiCad 10: `(at x y 90)` on a text_box renders a quarter
    // turn, where the same atom on a `text` would mean 9°.
    const library = parseKicadSymbolLibrary(
      TEXT_BOX_LIBRARY.replace('(at -17.78 6.35 0)', '(at -17.78 6.35 90)')
    )
    expect(boxOf(library).position.angle).toBe(90)
  })

  it('rotates by turning the stored angle a whole quarter turn', () => {
    const library = parsed()
    rotateGraphicNode(symbolGraphicNodes(node(library, 'T'))[1], { x: mm(0), y: mm(0) })
    const rotated = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    expect(boxOf(rotated).position.angle).toBe(90)
  })

  it('rotates a symbol TEXT in decidegrees, its own unit', () => {
    // Regression: this used to add 90 straight onto the raw atom, so a quarter
    // turn wrote 90 decidegrees — 9°, a barely visible tilt — while the
    // properties panel (which divides by 10) reported the right number.
    const library = parseKicadSymbolLibrary(LIBRARY)
    const textNode = addText(node(library, 'R'), 'hi', { x: mm(0), y: mm(0), angle: 0 })
    rotateGraphicNode(textNode, { x: mm(0), y: mm(0) })
    const rotated = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    const text = rotated.symbols
      .get('R')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'text') as Extract<SymbolGraphic, { type: 'text' }>
    expect(text.position.angle).toBe(90)
  })

  it('drags its far corner to a resize, and its anchor corner without moving the far one', () => {
    // The AST writer and the typed previewer must agree, or a corner drag
    // previews one operation and commits another — the slice-8d failure.
    const library = parsed()
    const boxNode = symbolGraphicNodes(node(library, 'T'))[1]
    setGraphicVertex(boxNode, 1, { x: mm(-5), y: mm(0) })
    const after = boxOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)))
    expect(after.position).toMatchObject({ x: mm(-17.78), y: mm(6.35) })
    expect(after.size).toEqual({ width: mm(12.78), height: mm(-6.35) })

    const typed = setTypedGraphicVertex(boxOf(parsed()), 1, { x: mm(-5), y: mm(0) })
    expect(typed).toMatchObject({ size: after.size, position: after.position })
  })

  it('previews an anchor-corner drag the same way the AST writes it', () => {
    const library = parsed()
    setGraphicVertex(symbolGraphicNodes(node(library, 'T'))[1], 0, { x: mm(-20), y: mm(8) })
    const after = boxOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)))
    // Far corner (-10.16, -1.27) held; anchor and extent both moved to keep it.
    expect(after.position).toMatchObject({ x: mm(-20), y: mm(8) })
    expect(after.size.width).toBe(mm(9.84))
    expect(after.size.height).toBe(mm(-9.27))

    const typed = setTypedGraphicVertex(boxOf(parsed()), 0, { x: mm(-20), y: mm(8) })
    expect(typed).toMatchObject({ position: after.position })
    expect((typed as Extract<SymbolGraphic, { type: 'textBox' }>).size.width).toBeCloseTo(
      after.size.width
    )
  })

  it('is spanned corner-to-corner by the tool, as an anchor plus a negative extent', () => {
    // Dragged bottom-right to top-left: the tool must still write KiCad's shape
    // — top-left anchor, positive width, negative height.
    const built = toolItems('textBox', [
      { x: mm(10), y: mm(-10) },
      { x: mm(0), y: mm(0) }
    ]).graphics[0] as Extract<SymbolGraphic, { type: 'textBox' }>
    expect(built.position).toMatchObject({ x: mm(0), y: mm(0) })
    expect(built.size).toEqual({ width: mm(10), height: mm(-10) })
  })

  it('writes a box the parser reads back unchanged', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    addTextBox(
      node(library, 'R'),
      'hello',
      { x: mm(1), y: mm(2), angle: 90 },
      { width: mm(8), height: mm(-4) }
    )
    const box = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
      .symbols.get('R')!
      .variants.flatMap((v) => v.graphics)
      .find((g) => g.type === 'textBox') as Extract<SymbolGraphic, { type: 'textBox' }>
    expect(box).toMatchObject({
      text: 'hello',
      position: { x: mm(1), y: mm(2), angle: 90 },
      size: { width: mm(8), height: mm(-4) }
    })
  })

  it('edits one margin without resetting the other three', () => {
    const library = parsed()
    updateSymbolTextBox(symbolGraphicNodes(node(library, 'T'))[1], { marginTop: mm(2) })
    expect(boxOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))).margins).toEqual({
      left: mm(1.016),
      top: mm(2),
      right: mm(1.016),
      bottom: mm(1.016)
    })
  })
})

// ---------------------------------------------------------------------------
// Alternate pin functions — `(alternate "NAME" type style)`.
//
// 876k occurrences across the standard library and the single most common thing
// we did not parse. A repeating child list, so unlike every other pin property
// it needs add and remove as well as edit.
// ---------------------------------------------------------------------------

const ALT_LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "MCU"
    (symbol "MCU_1_1"
      (pin bidirectional line (at 0 0 0) (length 2.54)
        (name "PA0" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))
        (alternate "ADC1_IN0" input line)
        (alternate "TIM2_CH1" output clock)
      )
    )
  )
)
`

describe('alternate pin functions', () => {
  const lib = (): KicadSymbolLibrary => parseKicadSymbolLibrary(ALT_LIBRARY)
  const pinOf = (l: KicadSymbolLibrary): SymbolPin =>
    l.symbols.get('MCU')!.variants.flatMap((v) => v.pins)[0]

  it('parses each alternate’s name, electrical type and graphic style', () => {
    expect(pinOf(lib()).alternates).toEqual([
      { name: 'ADC1_IN0', electricalType: 'input', graphicStyle: 'line' },
      { name: 'TIM2_CH1', electricalType: 'output', graphicStyle: 'clock' }
    ])
  })

  it('leaves a pin without alternates with an empty list, not undefined', () => {
    // Every consumer maps over this; an absent array would be a crash per pin.
    expect(
      parseKicadSymbolLibrary(LIBRARY).symbols.get('R')!.variants[1].pins[0].alternates
    ).toEqual([])
  })

  it('round-trips them untouched', () => {
    const once = serializeKicadSymbolLibrary(lib())
    expect(serializeKicadSymbolLibrary(parseKicadSymbolLibrary(once))).toBe(once)
    expect(pinOf(parseKicadSymbolLibrary(once)).alternates).toEqual(pinOf(lib()).alternates)
  })

  it('appends one without disturbing the existing entries', () => {
    const library = lib()
    addPinAlternate(symbolPinNodes(node(library, 'MCU'))[0], 'I2C1_SDA', 'bidirectional', 'line')
    expect(pinOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))).alternates).toEqual(
      [
        { name: 'ADC1_IN0', electricalType: 'input', graphicStyle: 'line' },
        { name: 'TIM2_CH1', electricalType: 'output', graphicStyle: 'clock' },
        { name: 'I2C1_SDA', electricalType: 'bidirectional', graphicStyle: 'line' }
      ]
    )
  })

  it('removes by index, keeping the others in order', () => {
    const library = lib()
    removePinAlternate(symbolPinNodes(node(library, 'MCU'))[0], 0)
    expect(pinOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))).alternates).toEqual(
      [{ name: 'TIM2_CH1', electricalType: 'output', graphicStyle: 'clock' }]
    )
  })

  it('ignores an out-of-range remove rather than dropping the last one', () => {
    const library = lib()
    removePinAlternate(symbolPinNodes(node(library, 'MCU'))[0], 7)
    expect(
      pinOf(parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))).alternates
    ).toHaveLength(2)
  })

  it('edits one field of one entry, leaving its siblings alone', () => {
    const library = lib()
    updatePinAlternate(symbolPinNodes(node(library, 'MCU'))[0], 1, { name: 'TIM2_CH1_RENAMED' })
    const alternates = pinOf(
      parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    ).alternates
    expect(alternates[0]).toEqual({
      name: 'ADC1_IN0',
      electricalType: 'input',
      graphicStyle: 'line'
    })
    // The other two atoms of the edited entry survive a name-only patch.
    expect(alternates[1]).toEqual({
      name: 'TIM2_CH1_RENAMED',
      electricalType: 'output',
      graphicStyle: 'clock'
    })
  })

  it('keeps the name quoted, so a name with a space stays one atom', () => {
    const library = lib()
    updatePinAlternate(symbolPinNodes(node(library, 'MCU'))[0], 0, { name: 'SPI 1 MOSI' })
    expect(serializeKicadSymbolLibrary(library)).toContain('(alternate "SPI 1 MOSI"')
  })
})

describe('symbol pin display', () => {
  it('writes the offset and both hide flags', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    setSymbolPinDisplay(node(library, 'R'), {
      nameOffset: mm(1.016),
      namesHidden: true,
      numbersHidden: true
    })
    const def = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get('R')!
    expect(def.pinNameOffset).toBe(mm(1.016))
    expect(def.pinNamesHidden).toBe(true)
    expect(def.pinNumbersHidden).toBe(true)
  })

  it('clears a hide flag it previously set', () => {
    // The round trip that matters: "show" must actually undo "hide", including
    // the legacy bare-atom spelling the parser also accepts.
    const library = parseKicadSymbolLibrary(LIBRARY)
    setSymbolPinDisplay(node(library, 'R'), { namesHidden: true })
    setSymbolPinDisplay(node(library, 'R'), { namesHidden: false })
    expect(
      parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get('R')!.pinNamesHidden
    ).toBe(false)
  })

  it('creates the pin_numbers node when the file has none', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    setSymbolPinDisplay(node(library, 'R'), { numbersHidden: true })
    expect(serializeKicadSymbolLibrary(library)).toContain('pin_numbers')
  })
})

describe('field structure', () => {
  const keys = (lib: KicadSymbolLibrary): string[] =>
    lib.symbols.get('R')!.properties.map((p) => p.key)

  it('adds a custom field and refuses a duplicate key', () => {
    // The gap this closes: `SYMBOL_FIELDS` was a fixed six, so an MPN that
    // reaches the BOM could not exist at all.
    const lib = applied((l) => {
      expect(addSymbolProperty(node(l, 'R'), 'MPN', 'RC0805')).toBe(true)
      expect(addSymbolProperty(node(l, 'R'), 'MPN', 'other')).toBe(false)
    })
    expect(keys(lib)).toEqual(['Reference', 'Value', 'MPN'])
    expect(lib.symbols.get('R')!.properties[2].value).toBe('RC0805')
  })

  it('refuses to remove or rename a field KiCad requires', () => {
    const lib = applied((l) => {
      expect(removeSymbolProperty(node(l, 'R'), 'Reference')).toBe(false)
      expect(renameSymbolProperty(node(l, 'R'), 'Value', 'Val')).toBe(false)
    })
    expect(keys(lib)).toEqual(['Reference', 'Value'])
  })

  it('removes and renames a user field', () => {
    const lib = applied((l) => {
      addSymbolProperty(node(l, 'R'), 'MPN', 'x')
      addSymbolProperty(node(l, 'R'), 'Vendor', 'y')
      expect(renameSymbolProperty(node(l, 'R'), 'Vendor', 'Supplier')).toBe(true)
      expect(removeSymbolProperty(node(l, 'R'), 'MPN')).toBe(true)
    })
    expect(keys(lib)).toEqual(['Reference', 'Value', 'Supplier'])
  })

  it('refuses a rename onto a key already in use', () => {
    const lib = applied((l) => {
      addSymbolProperty(node(l, 'R'), 'MPN', 'x')
      addSymbolProperty(node(l, 'R'), 'Vendor', 'y')
      expect(renameSymbolProperty(node(l, 'R'), 'Vendor', 'MPN')).toBe(false)
    })
    expect(keys(lib)).toEqual(['Reference', 'Value', 'MPN', 'Vendor'])
  })

  it('reorders user fields but will not move one into the mandatory head', () => {
    // KiCad's own rule: `OnMoveUp` refuses any row at or below
    // `GetMandatoryRowCount()`, so the five it requires keep their places.
    const lib = applied((l) => {
      addSymbolProperty(node(l, 'R'), 'MPN', 'x')
      addSymbolProperty(node(l, 'R'), 'Vendor', 'y')
      expect(moveSymbolProperty(node(l, 'R'), 'Vendor', -1)).toBe(true)
      // Vendor now heads the user tail, so up would cross into Value.
      expect(moveSymbolProperty(node(l, 'R'), 'Vendor', -1)).toBe(false)
      // MPN now ends it, so down runs off the end.
      expect(moveSymbolProperty(node(l, 'R'), 'MPN', 1)).toBe(false)
    })
    expect(keys(lib)).toEqual(['Reference', 'Value', 'Vendor', 'MPN'])
  })
})

describe('field flags and styling', () => {
  const field = (lib: KicadSymbolLibrary, key: string): SchematicProperty =>
    lib.symbols.get('R')!.properties.find((p) => p.key === key)!

  it('round-trips show_name and do_not_autoplace', () => {
    const lib = applied((l) =>
      updateSymbolProperty(symbolPropertyNode(node(l, 'R'), 'Reference')!, {
        showName: true,
        doNotAutoplace: true
      })
    )
    expect(field(lib, 'Reference').showName).toBe(true)
    expect(field(lib, 'Reference').doNotAutoplace).toBe(true)
  })

  it('writes the flags before the effects block, as KiCad does', () => {
    // Cosmetic, but it keeps our output diffable against files KiCad wrote.
    const lib = applied((l) =>
      updateSymbolProperty(symbolPropertyNode(node(l, 'R'), 'Reference')!, { showName: true })
    )
    const text = serializeKicadSymbolLibrary(lib)
    expect(text.indexOf('show_name')).toBeLessThan(text.indexOf('(effects'))
  })

  it('clears a legacy hide nested in effects, not just the property-level one', () => {
    // `parseTextEffects` honours both spellings, so showing a field has to clear
    // both — otherwise an older file keeps reading hidden with the box ticked.
    const source = LIBRARY.replace(
      '(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))',
      '(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27)) (hide yes)))'
    )
    const library = parseKicadSymbolLibrary(source)
    expect(library.symbols.get('R')!.properties[1].hidden).toBe(true)
    setSymbolPropertyVisible(symbolPropertyNode(node(library, 'R'), 'Value')!, true)
    const after = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    expect(after.symbols.get('R')!.properties[1].hidden).toBe(false)
  })

  it('hides a field and shows it again', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    setSymbolPropertyVisible(symbolPropertyNode(node(library, 'R'), 'Value')!, false)
    const hidden = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    expect(hidden.symbols.get('R')!.properties[1].hidden).toBe(true)
    setSymbolPropertyVisible(symbolPropertyNode(node(hidden, 'R'), 'Value')!, true)
    const shown = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(hidden))
    expect(shown.symbols.get('R')!.properties[1].hidden).toBe(false)
  })

  it('stores a field angle in DEGREES, not the decidegrees a text uses', () => {
    // The format's third angle convention: `(text …)` is ×10, `(text_box …)` and
    // a property are not. Writing 90 must read back as 90, not as 9.
    const lib = applied((l) =>
      updateSymbolProperty(symbolPropertyNode(node(l, 'R'), 'Reference')!, { angle: 90 })
    )
    expect(field(lib, 'Reference').position.angle).toBe(90)
  })

  it('moves a field by a delta without disturbing its angle', () => {
    const lib = applied((l) =>
      translateSymbolPropertyNode(symbolPropertyNode(node(l, 'R'), 'Reference')!, mm(1), mm(-2))
    )
    const reference = field(lib, 'Reference')
    expect(reference.position.x).toBe(mm(3.032))
    expect(reference.position.y).toBe(mm(-2))
    expect(reference.position.angle).toBe(90)
  })
})

describe('field addressing', () => {
  it('gives each field its own name, so two cannot collide', () => {
    // Every field is unit 0 / style 0 / index 0, so the positional spelling
    // would call a Reference and a Value the same part.
    const reference = { kind: 'field' as const, unit: 0, style: 0, index: 0, field: 'Reference' }
    const value = { ...reference, field: 'Value' }
    expect(addressKey(reference)).not.toBe(addressKey(value))
    expect(sameAddress(reference, value)).toBe(false)
    expect(sameAddress(reference, { ...reference })).toBe(true)
  })

  it('resolves a field name to its property node', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const found = symbolPartNode(node(library, 'R'), {
      kind: 'field',
      unit: 0,
      style: 0,
      index: 0,
      field: 'Value'
    })
    expect(found).toBe(symbolPropertyNode(node(library, 'R'), 'Value'))
  })

  it('spells the preview key the way the renderer files a field’s paint', () => {
    // `SchematicScene` writes `${symbolKey}/${schematicFieldKey(key)}`; if these
    // two drifted, selecting a field would halo nothing.
    expect(
      symbolPreviewPartKey({ kind: 'field', unit: 0, style: 0, index: 0, field: 'Reference' })
    ).toBe(`symbol:0/${schematicFieldKey('Reference')}`)
  })
})

describe('field flags survive the preview build', () => {
  it('carries show_name, do_not_autoplace and hide onto the placed symbol', () => {
    // The preview document is what the canvas draws, and it is rebuilt from the
    // definition on every command — so a token this copier drops is a token the
    // editor cannot appear to change. `hide` was the sharp one: hiding a field
    // wrote `(hide yes)` on the property and the canvas kept drawing it.
    const source = LIBRARY.replace(
      '(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))',
      `(property "Value" "R" (at 0 0 90) (show_name yes) (do_not_autoplace yes) (hide yes)
        (effects (font (size 1.27 1.27))))`
    )
    const library = parseKicadSymbolLibrary(source)
    const preview = buildSymbolPreviewSchematic(library, 'R')!
    const placed = preview.symbols[0].properties.find((p) => p.key === 'Value')!
    expect(placed.showName).toBe(true)
    expect(placed.doNotAutoplace).toBe(true)
    expect(placed.hidden).toBe(true)
  })

  it('draws a show_name field as "Key: Value"', () => {
    const property = {
      key: 'MPN',
      value: 'RC0805',
      showName: true
    } as SchematicProperty
    expect(shownFieldText(property)).toBe('MPN: RC0805')
    expect(shownFieldText({ ...property, showName: false })).toBe('RC0805')
  })
})

describe('private fields (KiCad 9 `(property private …)`)', () => {
  const PRIVATE = `(kicad_symbol_lib
  (version 20241209)
  (generator "kicad_symbol_editor")
  (symbol "P"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property private "Note" "internal" (at 0 2 0) (effects (font (size 1.27 1.27))))
    (property "MPN" "X1" (at 0 4 0) (effects (font (size 1.27 1.27))))
  )
)
`
  const fieldOf = (
    lib: ReturnType<typeof parseKicadSymbolLibrary>,
    key: string
  ): ReturnType<typeof symbolPropertyNode> => symbolPropertyNode(node(lib, 'P'), key)

  it('finds a private field by its key, past the keyword', () => {
    expect(fieldOf(parseKicadSymbolLibrary(PRIVATE), 'Note')).not.toBeNull()
  })

  it('edits a private field’s value without touching its key', () => {
    const lib = parseKicadSymbolLibrary(PRIVATE)
    updateSymbolProperty(fieldOf(lib, 'Note')!, { value: 'changed' })
    expect(serializeKicadSymbolLibrary(lib)).toContain('(property private "Note" "changed"')
  })

  it('makes a field private and public again, and never a mandatory one', () => {
    const lib = parseKicadSymbolLibrary(PRIVATE)
    updateSymbolProperty(fieldOf(lib, 'MPN')!, { private: true })
    expect(serializeKicadSymbolLibrary(lib)).toContain('(property private "MPN" "X1"')
    updateSymbolProperty(fieldOf(lib, 'Note')!, { private: false })
    expect(serializeKicadSymbolLibrary(lib)).toContain('(property "Note" "internal"')
    updateSymbolProperty(fieldOf(lib, 'Reference')!, { private: true })
    expect(serializeKicadSymbolLibrary(lib)).toContain('(property "Reference" "U"')
  })
})

describe('changedSymbolName', () => {
  const LIB = (
    value: string
  ): string => `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
  (symbol "A" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))))
  (symbol "B" (property "Reference" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27)))))
)`

  it('names the symbol holding the first change, in the library as it is now', () => {
    const now = LIB('U')
    expect(changedSymbolName(parseKicadSymbolLibrary(now), now, LIB('R'))).toBe('B')
    expect(changedSymbolName(parseKicadSymbolLibrary(now), now, now)).toBeNull()
    const renamed = now.replace('"U" (at', '"V" (at')
    expect(changedSymbolName(parseKicadSymbolLibrary(renamed), renamed, now)).toBe('A')
  })
})
