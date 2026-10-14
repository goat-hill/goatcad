import { describe, expect, it } from 'vitest'
import { parseKicadFootprint } from '../../../kicad/footprint'
import { buildBoardLayers } from '../boardLayers'
import { buildBoardOutline } from '../boardOutline'
import {
  boardFromFootprint,
  boardMarginFor,
  footprintExtent,
  hasOwnBoardEdge
} from '../footprintBoard'
import { signedArea } from '../flatMesh'
import { mmToNm as mm, nm as nmi } from '../../../kicad/coordinates'

const SMD = parseKicadFootprint(`
(footprint "R_0603" (version 20240108) (layer "F.Cu")
  (attr smd)
  (property "Reference" "R1" (at 0 -1.5 0) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -1.5 -0.7) (end 1.5 -0.7) (layer "F.SilkS") (stroke (width 0.12)))
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask")
    (roundrect_rratio 0.25))
  (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.wrl"))
`)

/** Pads only, so the pad-extent assertions are not answering for a silk line. */
const PADS_ONLY = parseKicadFootprint(`
(footprint "PadsOnly" (layer "F.Cu")
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (roundrect_rratio 0.25)))
`)

/** Pads and a silk line, no text — isolates the graphics contribution. */
const NO_TEXT = parseKicadFootprint(`
(footprint "NoText" (layer "F.Cu")
  (fp_line (start -1.5 -0.7) (end 1.5 -0.7) (layer "F.SilkS") (stroke (width 0.12)))
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (roundrect_rratio 0.25)))
`)

describe('boardMarginFor', () => {
  it('gives a tiny passive a readable minimum rather than a hairline', () => {
    expect(boardMarginFor(1, 0.5)).toBe(1.5)
  })

  it('scales with the part in the middle of the range', () => {
    expect(boardMarginFor(12, 8)).toBe(3)
  })

  it('caps, so a big connector does not come with a placemat', () => {
    expect(boardMarginFor(100, 40)).toBe(5)
  })
})

describe('footprintExtent', () => {
  it('covers pads by their longer side, so a rotated pad still fits', () => {
    const extent = footprintExtent(PADS_ONLY)!
    // Pads at x = ±0.8, half-extent max(0.9, 0.95) / 2 = 0.475.
    expect(extent.minX).toBe(mm(-1.275))
    expect(extent.maxX).toBe(mm(1.275))
    expect(extent.minY).toBe(mm(-0.475))
  })

  it('includes silkscreen graphics, which often reach past the pads', () => {
    const extent = footprintExtent(NO_TEXT)!
    // The silk line runs -1.5 … 1.5 in x and sits at y = -0.7, both outside
    // the single pad's own box.
    expect(extent.minX).toBe(mm(-1.5))
    expect(extent.maxX).toBe(mm(1.5))
    expect(extent.minY).toBe(mm(-0.7))
  })

  it('includes silkscreen text — it is printed, so it has to be on the board', () => {
    // "R1" is centered at y = -1.5 with a 1mm font, so the extent has to reach
    // past it; otherwise the designator floats off the edge of the substrate.
    expect(footprintExtent(SMD)!.minY).toBeLessThan(mm(-1.5))
  })

  it('skips hidden text, which is never printed', () => {
    const hidden = parseKicadFootprint(`
(footprint "Hidden" (layer "F.Cu")
  (property "Reference" "R1" (at 0 -12 0) (layer "F.SilkS") hide
    (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
`)
    expect(footprintExtent(hidden)!.minY).toBe(mm(-0.5))
  })

  it('has nothing to report for an empty footprint', () => {
    expect(footprintExtent(parseKicadFootprint('(footprint "Empty" (layer "F.Cu"))'))).toBeNull()
  })
})

describe('hasOwnBoardEdge', () => {
  it('is false for an ordinary part', () => {
    expect(hasOwnBoardEdge(SMD)).toBe(false)
  })

  it('is true when the footprint draws Edge.Cuts itself', () => {
    const outlinePart = parseKicadFootprint(`
(footprint "Board" (layer "F.Cu")
  (fp_circle (center 0 0) (end 5 0) (layer "Edge.Cuts") (stroke (width 0.1))))
`)
    expect(hasOwnBoardEdge(outlinePart)).toBe(true)
  })
})

describe('boardFromFootprint', () => {
  it('places the part at the origin on the front side', () => {
    const board = boardFromFootprint(SMD)
    expect(board.footprints).toHaveLength(1)
    expect(board.footprints[0].position).toEqual({ x: mm(0), y: mm(0) })
    expect(board.footprints[0].layer).toBe('F.Cu')
    expect(board.footprints[0].reference).toBe('R1')
    expect(board.footprints[0].footprint).toBe(SMD)
  })

  it('surrounds the part with an Edge.Cuts rectangle the outline builder accepts', () => {
    const board = boardFromFootprint(SMD)
    const outline = buildBoardOutline(board)
    expect(outline.fallback).toBe(false)
    expect(outline.regions).toHaveLength(1)
    expect(outline.regions[0].holes).toEqual([])

    // The rectangle is the extent plus one margin on every side, and the whole
    // part — reference text included — sits inside it.
    const extent = footprintExtent(SMD)!
    const margin = mm(
      boardMarginFor((extent.maxX - extent.minX) / 1e6, (extent.maxY - extent.minY) / 1e6)
    )
    const rect = board.grRects[0]
    expect(rect.start).toEqual({ x: nmi(extent.minX - margin), y: nmi(extent.minY - margin) })
    expect(rect.end).toEqual({ x: nmi(extent.maxX + margin), y: nmi(extent.maxY + margin) })
    // The outline is world mm; the extent and margin are nm — scale the area.
    expect(Math.abs(signedArea(outline.regions[0].outer))).toBeCloseTo(
      ((extent.maxX - extent.minX + 2 * margin) / 1e6) *
        ((extent.maxY - extent.minY + 2 * margin) / 1e6),
      4
    )
  })

  it('renders the part on it through the ordinary board path', () => {
    // The point of the wrapper: pads, silk and paste come out of the same
    // builder the real board uses, so they cannot look different.
    const layers = buildBoardLayers(boardFromFootprint(SMD))
    expect(layers.pads.get('F.Cu')?.isEmpty).toBe(false)
    expect(layers.paste.get('F.Paste')?.isEmpty).toBe(false)
    expect(layers.silk.get('F.SilkS')?.isEmpty).toBe(false)
  })

  it('leaves a board-outline footprint to define its own edge', () => {
    // Adding our rectangle around it would nest, and the part's own outline
    // would come out as a cutout in ours.
    const outlinePart = parseKicadFootprint(`
(footprint "Board" (layer "F.Cu")
  (fp_circle (center 0 0) (end 5 0) (layer "Edge.Cuts") (stroke (width 0.1))))
`)
    const board = boardFromFootprint(outlinePart)
    expect(board.grRects).toEqual([])
    const outline = buildBoardOutline(board)
    expect(outline.regions).toHaveLength(1)
    expect(outline.regions[0].holes).toEqual([])
  })

  it('falls back to no edge at all for an empty footprint', () => {
    const board = boardFromFootprint(parseKicadFootprint('(footprint "Empty" (layer "F.Cu"))'))
    expect(board.grRects).toEqual([])
  })
})
