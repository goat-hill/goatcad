import { describe, expect, it } from 'vitest'
import { mmToNm as mm, nm } from '../../kicad/coordinates'
import type { SymbolGraphic } from '../../kicad/schematic'
import { parseKicadSymbolLibrary, serializeKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { applyGraphicEdit, graphicHandleSpecs, graphicPatchFor } from '../graphicEdit'
import { symbolPartGraphic, symbolPartNode } from '../symbolEdit'

const stroke = { width: nm(0) }
const identity = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x, y: p.y })

describe('graphicHandleSpecs', () => {
  it('puts a resize handle on each corner and a move handle at the center', () => {
    const rect: SymbolGraphic = {
      type: 'rectangle',
      start: { x: nm(0), y: nm(0) },
      end: { x: nm(10), y: nm(20) },
      stroke,
      fill: 'none'
    }
    const specs = graphicHandleSpecs(rect, identity, { id: 7 })
    expect(specs).toEqual([
      { x: 0, y: 0, data: { id: 7, vertexIndex: 0 } },
      { x: 10, y: 20, data: { id: 7, vertexIndex: 1 } },
      { x: 5, y: 10, role: 'move', data: { id: 7 } }
    ])
  })

  it('maps every point through the caller’s space — a sheet flips y', () => {
    const line: SymbolGraphic = {
      type: 'line',
      points: [
        { x: nm(0), y: nm(4) },
        { x: nm(2), y: nm(8) }
      ],
      stroke,
      fill: 'none'
    }
    const specs = graphicHandleSpecs(line, (p) => ({ x: p.x, y: -p.y }), {})
    expect(specs.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: -4 },
      { x: 2, y: -8 },
      { x: 1, y: -6 }
    ])
  })

  it('makes a circle’s center a move handle and adds no second one', () => {
    const circle: SymbolGraphic = {
      type: 'circle',
      center: { x: nm(5), y: nm(5) },
      radius: nm(2),
      stroke,
      fill: 'none'
    }
    const specs = graphicHandleSpecs(circle, identity, {})
    expect(specs.map((spec) => spec.role ?? 'resize')).toEqual(['move', 'resize'])
  })
})

describe('graphicPatchFor', () => {
  it('passes a row through as its own patch field', () => {
    expect(graphicPatchFor('fill', 'color')).toEqual({ fill: 'color' })
  })
})

describe('the KiCad parity rows a graphic writes', () => {
  const PARITY = `(kicad_symbol_lib
  (version 20241209)
  (generator "kicad_symbol_editor")
  (symbol "P"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "P_0_1"
      (rectangle (start -2 -1) (end 3 4) (stroke (width 0.254) (type default)) (fill (type none)))
      (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0.254) (type default)) (fill (type none)))
      (text_box "Box" (at 0 0 0) (size 5 -3) (margins 0.5 0.5 0.5 0.5)
        (stroke (width 0.1) (type solid)) (fill (type none))
        (effects (font (size 1.27 1.27)) (justify left top)))
    )
  )
)
`
  /** Apply one row edit to graphic `index`, then read that graphic back. */
  const edit = (index: number, key: string, value: number | string): SymbolGraphic => {
    const library = parseKicadSymbolLibrary(PARITY)
    const symbol = library.symbols.get('P')!
    const address = { kind: 'graphic' as const, unit: 0, style: 1, index }
    const graphic = symbolPartGraphic(symbol, address)!
    applyGraphicEdit(
      graphic.type,
      symbolPartNode(symbol._node, address)!,
      graphicPatchFor(key, value, graphic)
    )
    const back = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get('P')!
    return symbolPartGraphic(back, address)!
  }

  it('moves a rectangle’s far corner for its Width and Height', () => {
    const rect = edit(0, 'rectWidth', mm(10)) as Extract<SymbolGraphic, { type: 'rectangle' }>
    expect(rect.end).toEqual({ x: mm(8), y: mm(4) })
    const tall = edit(0, 'rectHeight', mm(-1)) as Extract<SymbolGraphic, { type: 'rectangle' }>
    expect(tall.end).toEqual({ x: mm(3), y: mm(-2) })
  })

  it('moves only a curve’s end point, keeping its other axis and its control points', () => {
    const curve = edit(1, 'endY', mm(2)) as Extract<SymbolGraphic, { type: 'bezier' }>
    expect(curve.points).toEqual([
      { x: mm(0), y: mm(0) },
      { x: mm(1), y: mm(1) },
      { x: mm(2), y: mm(1) },
      { x: mm(3), y: mm(2) }
    ])
  })

  it('writes a text box’s border and fill, which its rows show', () => {
    const box = edit(2, 'strokeType', 'dash') as Extract<SymbolGraphic, { type: 'textBox' }>
    expect(box.stroke.type).toBe('dash')
    const filled = edit(2, 'fill', 'background') as Extract<SymbolGraphic, { type: 'textBox' }>
    expect(filled.fill).toBe('background')
  })
})
