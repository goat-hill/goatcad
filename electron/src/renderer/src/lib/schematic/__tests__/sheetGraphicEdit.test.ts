import { describe, expect, it } from 'vitest'
import { parseKicadSchematic, serializeKicadSchematic } from '../../kicad/schematic'
import { mmToNm } from '../../kicad/coordinates'
import { setGraphicFillColor, setGraphicVertex } from '../../symbol/symbolEdit'
import { sheetGraphicOf } from '../sheetGraphicEdit'

const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
  (text "Note" (at 20 20 0) (effects (font (size 1.27 1.27))) (uuid "t1"))
  (rectangle (start 40 40) (end 50 50) (stroke (width 0) (type default)) (fill (type hatch)) (uuid "r1"))
  (circle (center 60 60) (radius 3) (stroke (width 0) (type default)) (fill (type none)) (uuid "c1"))
  (rule_area (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra1"))))`

const reread = (
  doc: ReturnType<typeof parseKicadSchematic>
): ReturnType<typeof parseKicadSchematic> => parseKicadSchematic(serializeKicadSchematic(doc))

describe('sheetGraphicOf', () => {
  it('reads a sheet rectangle as the graphic model, in sheet space', () => {
    const found = sheetGraphicOf(parseKicadSchematic(SOURCE), { type: 'shape', index: 0 })
    expect(found?.graphic).toMatchObject({
      type: 'rectangle',
      start: { x: mmToNm(40), y: mmToNm(40) },
      end: { x: mmToNm(50), y: mmToNm(50) },
      fill: 'hatch'
    })
  })

  it('names no graphic for a sheet text or a missing index', () => {
    const doc = parseKicadSchematic(SOURCE)
    expect(sheetGraphicOf(doc, { type: 'text', index: 0 })).toBeNull()
    expect(sheetGraphicOf(doc, { type: 'circle', index: 3 })).toBeNull()
  })

  it('hands back the node the shared writers reshape — a rule area’s polyline', () => {
    const doc = parseKicadSchematic(SOURCE)
    const rect = sheetGraphicOf(doc, { type: 'shape', index: 0 })
    const area = sheetGraphicOf(doc, { type: 'rule_area', index: 0 })
    if (!rect || !area) throw new Error('fixture')
    setGraphicVertex(rect.node, 1, { x: mmToNm(55), y: mmToNm(45) })
    setGraphicVertex(area.node, 2, { x: mmToNm(12), y: mmToNm(12) })
    const after = reread(doc)
    expect(after.shapes[0].end).toEqual({ x: mmToNm(55), y: mmToNm(45) })
    expect(after.ruleAreas[0].graphic.points[2]).toEqual({ x: mmToNm(12), y: mmToNm(12) })
  })

  it('keeps a hatch when a fill color is picked, and turns no fill into a color fill', () => {
    const doc = parseKicadSchematic(SOURCE)
    const red = { r: 255, g: 0, b: 0, a: 1 }
    const rect = sheetGraphicOf(doc, { type: 'shape', index: 0 })
    const circle = sheetGraphicOf(doc, { type: 'circle', index: 0 })
    if (!rect || !circle) throw new Error('fixture')
    setGraphicFillColor(rect.node, red)
    setGraphicFillColor(circle.node, red)
    const after = reread(doc)
    expect(after.shapes[0].fill).toBe('hatch')
    expect(after.circles[0].graphic.fill).toBe('color')
  })
})
