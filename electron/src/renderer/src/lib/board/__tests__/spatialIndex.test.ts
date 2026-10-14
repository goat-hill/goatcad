import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import {
  BoardSpatialIndex,
  padFrame,
  padHoleShape,
  polyShape,
  pointToShape,
  sampleArc,
  segmentToShape,
  shapeToShape,
  snapPointsOf,
  type CopperItem,
  type CopperShape
} from '../spatialIndex'

// 4 copper layers so via spans are observable. World space is y-up: the
// fixture's KiCad y values are all negated in the assertions below.
const boardSource = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" signal)
    (2 "In2.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (footprint "Test:FP"
    (layer "F.Cu")
    (uuid "fp-1")
    (at 10 10 90)
    (pad "1" smd rect (at 2 0) (size 1 0.5) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND"))
    (pad "2" thru_hole circle (at -2 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu" "*.Mask") (net 2 "VCC"))
    (pad "3" smd rect (at 0 2) (size 1 1) (layers "F.Paste" "F.Mask"))
  )
  (segment (start 20 10) (end 30 10) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1"))
  (arc (start 40 10) (mid 45 5) (end 50 10) (width 0.4) (layer "B.Cu") (net 1) (uuid "a1"))
  (via (at 25 20) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via blind (at 28 20) (size 0.6) (drill 0.3) (layers "F.Cu" "In2.Cu") (net 2) (uuid "v2"))
)`

const index = (): BoardSpatialIndex => BoardSpatialIndex.build(parseKicadBoard(boardSource))

describe('build', () => {
  test('indexes copper items only, with resolved layers and nets', () => {
    const idx = index()
    const types = idx.items.map((i) => i.ref.type).sort()
    // 1 segment + 1 track arc + 2 vias + 2 copper pads; pad "3" is paste/mask-only
    expect(types).toEqual(['pad', 'pad', 'segment', 'tarc', 'via', 'via'].sort())

    const seg = idx.items.find((i) => i.ref.type === 'segment')!
    expect(seg.net).toBe(1)
    expect(seg.layers).toEqual(['F.Cu'])

    const throughVia = idx.items.find((i) => i.ref.type === 'via' && i.net === 1)!
    expect(throughVia.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])

    const blindVia = idx.items.find((i) => i.ref.type === 'via' && i.net === 2)!
    expect(blindVia.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu'])

    const thPad = idx.items.find((i) => i.ref.type === 'pad' && i.net === 2)!
    expect(thPad.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })

  test('pad centers apply the footprint placement transform', () => {
    const idx = index()
    // Footprint at (10,10) rotated 90°: pad 1's local (2,0) lands at KiCad
    // (10, 8) — rotation is CCW in KiCad's y-down frame — world (10, -8).
    const pad1 = idx.items.find((i) => i.ref.type === 'pad' && i.net === 1)!
    expect(pad1.shape.kind).toBe('rrect')
    if (pad1.shape.kind === 'rrect') {
      expect(pad1.shape.cx).toBeCloseTo(10, 9)
      expect(pad1.shape.cy).toBeCloseTo(-8, 9)
    }
  })
})

describe('pointToShape', () => {
  test('capsule: zero inside, edge distance outside', () => {
    const capsule: CopperShape = { kind: 'capsule', x0: 0, y0: 0, x1: 10, y1: 0, halfWidth: 0.25 }
    expect(pointToShape(capsule, 5, 0)).toBe(0)
    expect(pointToShape(capsule, 5, 0.2)).toBe(0)
    expect(pointToShape(capsule, 5, 1.25)).toBeCloseTo(1.0, 9)
    expect(pointToShape(capsule, 12, 0)).toBeCloseTo(1.75, 9)
  })

  test('circle and rotated rounded rect', () => {
    const circle: CopperShape = { kind: 'circle', cx: 0, cy: 0, r: 0.4 }
    expect(pointToShape(circle, 1, 0)).toBeCloseTo(0.6, 9)

    // 2×1 rect rotated 90° → occupies 1×2; a point 1.0 above center is 0 (inside
    // the long axis now vertical), a point 1.0 to the right clears by 0.5.
    const rrect: CopperShape = {
      kind: 'rrect',
      cx: 0,
      cy: 0,
      halfW: 1,
      halfH: 0.5,
      cornerR: 0,
      rotation: Math.PI / 2
    }
    expect(pointToShape(rrect, 0, 0.9)).toBe(0)
    expect(pointToShape(rrect, 1.0, 0)).toBeCloseTo(0.5, 9)
  })

  test('arc: sampled centerline honors the bulge side', () => {
    const arc: CopperShape = {
      kind: 'arc',
      x0: 0,
      y0: 0,
      mx: 5,
      my: 5,
      x1: 10,
      y1: 0,
      halfWidth: 0.2
    }
    // The apex of the arc passes through (5,5); just above it is nearly touching.
    expect(pointToShape(arc, 5, 5)).toBe(0)
    expect(pointToShape(arc, 5, 6)).toBeCloseTo(0.8, 2)
    // The chord midpoint is far from the arc itself.
    expect(pointToShape(arc, 5, 0)).toBeGreaterThan(4)
  })

  test('sampleArc endpoints are exact', () => {
    const pts = sampleArc(0, 0, 5, 5, 10, 0)
    expect(pts[0].x).toBeCloseTo(0, 9)
    expect(pts[0].y).toBeCloseTo(0, 9)
    expect(pts[pts.length - 1].x).toBeCloseTo(10, 9)
    expect(pts[pts.length - 1].y).toBeCloseTo(0, 9)
  })
})

describe('segmentToShape', () => {
  test('capsule: parallel separation and crossing overlap', () => {
    const capsule: CopperShape = { kind: 'capsule', x0: 0, y0: 0, x1: 10, y1: 0, halfWidth: 0.25 }
    // Parallel track 1 mm above, 0.5 mm wide: edge gap = 1 - 0.25 - 0.25
    expect(segmentToShape(capsule, 0, 1, 10, 1, 0.25)).toBeCloseTo(0.5, 9)
    // Crossing track overlaps
    expect(segmentToShape(capsule, 5, -1, 5, 1, 0.1)).toBe(0)
  })

  test('rrect: pass-through is 0, near-miss measures to the rounded edge', () => {
    const pad: CopperShape = {
      kind: 'rrect',
      cx: 0,
      cy: 0,
      halfW: 1,
      halfH: 0.5,
      cornerR: 0.25,
      rotation: 0
    }
    expect(segmentToShape(pad, -2, 0, 2, 0, 0.1)).toBe(0)
    // Horizontal segment passing 1.0 above center: gap = 1.0 - 0.5(halfH) - 0.1
    expect(segmentToShape(pad, -2, 1.0, 2, 1.0, 0.1)).toBeCloseTo(0.4, 9)
  })
})

describe('queries', () => {
  test('near: layer filter, net filters, sorted by distance', () => {
    const idx = index()
    // World point just above the F.Cu segment's start (KiCad (20,10) → world (20,-10))
    const hits = idx.near(20, -10, 5, { layer: 'F.Cu' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].item.ref).toEqual({ type: 'segment', index: 0 })
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].dist).toBeGreaterThanOrEqual(hits[i - 1].dist)
    }
    // The B.Cu arc is invisible through the F.Cu filter even within radius
    expect(idx.near(45, -8, 6, { layer: 'F.Cu' }).some((h) => h.item.ref.type === 'tarc')).toBe(
      false
    )
    expect(idx.near(45, -8, 6, { layer: 'B.Cu' }).some((h) => h.item.ref.type === 'tarc')).toBe(
      true
    )
    // excludeNet drops net 1 (segment + through via), net filter keeps only it
    expect(idx.near(25, -15, 30, { excludeNet: 1 }).every((h) => h.item.net !== 1)).toBe(true)
    expect(idx.near(25, -15, 30, { net: 1 }).every((h) => h.item.net === 1)).toBe(true)
  })

  test('nearSegment gathers obstacles along a route candidate', () => {
    const idx = index()
    // A horizontal run on F.Cu at world y=-12, x 18..32: passes 2 mm below the
    // segment at y=-10 and 8 mm from the via at (25,-20).
    const hits = idx.nearSegment(18, -12, 32, -12, 3, { layer: 'F.Cu' })
    expect(hits.some((h) => h.item.ref.type === 'segment')).toBe(true)
    expect(hits.some((h) => h.item.ref.type === 'via')).toBe(false)
    const seg = hits.find((h) => h.item.ref.type === 'segment')!
    expect(seg.dist).toBeCloseTo(2 - 0.25, 9) // centerline query: 2 mm minus track half-width
  })

  test('violatesClearance: the routing guardrail, exclusive of the routed net', () => {
    const idx = index()
    // The F.Cu segment (net 1) runs KiCad (20,10)→(30,10), width 0.5 → world
    // y=-10. A 0.25-wide track at world y=-11 leaves 1 - 0.25 - 0.125 - 0.125
    // = 0.625 edge gap: violates a 0.7 clearance, holds a 0.6 one.
    expect(
      idx.violatesClearance(20, -11, 30, -11, 0.125, 0.7, { layer: 'F.Cu', excludeNet: 2 })
    ).toBe(true)
    expect(
      idx.violatesClearance(20, -11, 30, -11, 0.125, 0.6, { layer: 'F.Cu', excludeNet: 2 })
    ).toBe(false)
    // The same run is legal when net 1 is the one being routed.
    expect(
      idx.violatesClearance(20, -11, 30, -11, 0.125, 0.7, { layer: 'F.Cu', excludeNet: 1 })
    ).toBe(false)
    // And invisible from another layer.
    expect(
      idx.violatesClearance(20, -11, 30, -11, 0.125, 0.7, { layer: 'B.Cu', excludeNet: 2 })
    ).toBe(false)
  })

  test('snapPointsOf: connection points only', () => {
    const idx = index()
    const seg = idx.items.find((i) => i.ref.type === 'segment')!
    expect(snapPointsOf(seg)).toEqual([
      { x: 20, y: -10 },
      { x: 30, y: -10 }
    ])
    const via = idx.items.find((i) => i.ref.type === 'via' && i.net === 1)!
    expect(snapPointsOf(via)).toEqual([{ x: 25, y: -20 }])
    const pad = idx.items.find((i) => i.ref.type === 'pad' && i.net === 1)!
    expect(snapPointsOf(pad)).toHaveLength(1)
  })

  test('query returns a superset by AABB and dedups across cells', () => {
    const idx = index()
    const all = idx.query(-1000, -1000, 1000, 1000)
    expect(all.length).toBe(idx.items.length)
    const refs = new Set(all.map((i) => JSON.stringify(i.ref)))
    expect(refs.size).toBe(all.length)
  })
})

describe('shapeToShape', () => {
  const rrect = (
    cx: number,
    cy: number,
    halfW = 1,
    halfH = 0.5,
    cornerR = 0,
    rot = 0
  ): CopperShape => ({
    kind: 'rrect',
    cx,
    cy,
    halfW,
    halfH,
    cornerR,
    rotation: rot
  })
  const capsule = (x0: number, y0: number, x1: number, y1: number, hw: number): CopperShape => ({
    kind: 'capsule',
    x0,
    y0,
    x1,
    y1,
    halfWidth: hw
  })

  test('capsule ↔ circle: touching is 0, apart is the gap', () => {
    const circle: CopperShape = { kind: 'circle', cx: 5, cy: 0, r: 1 }
    expect(shapeToShape(capsule(0, 0, 3.5, 0, 0.5), circle)).toBe(0)
    expect(shapeToShape(capsule(0, 0, 3, 0, 0.5), circle)).toBeCloseTo(0.5)
    // Symmetric.
    expect(shapeToShape(circle, capsule(0, 0, 3, 0, 0.5))).toBeCloseTo(0.5)
  })

  test('rrect ↔ rrect: overlap, edge gap, and full containment', () => {
    expect(shapeToShape(rrect(0, 0), rrect(1.5, 0))).toBe(0)
    expect(shapeToShape(rrect(0, 0), rrect(3, 0))).toBeCloseTo(1)
    // A tiny pad fully inside a big one: edge distance would miss it.
    expect(shapeToShape(rrect(0, 0, 3, 3, 0), rrect(0.2, 0.1, 0.2, 0.2, 0))).toBe(0)
  })

  test('rrect ↔ rrect honors rotation and corner radius', () => {
    // A rect rotated 90° stands its width up: halfW 1 becomes vertical reach.
    const standing = rrect(3, 0, 1, 0.5, 0, Math.PI / 2)
    expect(shapeToShape(rrect(0, 0), standing)).toBeCloseTo(1.5)
    // Rounded corners shrink the diagonal reach relative to sharp ones.
    const sharp = shapeToShape(rrect(0, 0, 1, 1, 0), rrect(3, 3, 1, 1, 0))
    const round = shapeToShape(rrect(0, 0, 1, 1, 0.5), rrect(3, 3, 1, 1, 0.5))
    expect(round).toBeGreaterThan(sharp)
  })

  test('arc ↔ rrect reduces to sampled capsules', () => {
    const arc: CopperShape = {
      kind: 'arc',
      x0: 0,
      y0: 0,
      mx: 5,
      my: 5,
      x1: 10,
      y1: 0,
      halfWidth: 0.25
    }
    expect(shapeToShape(arc, rrect(5, 5, 0.5, 0.5, 0))).toBe(0)
    expect(shapeToShape(arc, rrect(5, 8, 0.5, 0.5, 0))).toBeGreaterThan(1.5)
  })
})

describe('KiCad 9+ layer numbering', () => {
  test('via spans follow stack order, not ordinal values', () => {
    // v9 renumbered copper: F.Cu 0, In1 4, In2 6, B.Cu 2 — an ordinal range
    // would read a through via as outer-layers-only.
    const board = parseKicadBoard(`(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (4 "In1.Cu" power)
    (6 "In2.Cu" power)
    (2 "B.Cu" signal)
  )
  (via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v1"))
  (via blind (at 12 10) (size 0.6) (drill 0.3) (layers "F.Cu" "In2.Cu") (net "GND") (uuid "v2"))
)`)
    const idx = BoardSpatialIndex.build(board)
    const through = idx.items.find((i) => i.ref.type === 'via' && i.ref.index === 0)!
    expect(through.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
    const blind = idx.items.find((i) => i.ref.type === 'via' && i.ref.index === 1)!
    expect(blind.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu'])
  })
})

describe('pad copper and holes', () => {
  const board = parseKicadBoard(`(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))
  (net 0 "") (net 1 "A")
  (footprint "Test:FP" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (pad "1" thru_hole oval (at 0 0 90) (size 2 1) (drill oval 1 0.5 (offset 0.5 0)) (layers "*.Cu") (net 1 "A") (uuid "p1"))
    (pad "2" thru_hole circle (at 5 0) (size 1.2 1.2) (drill 0.6) (layers "*.Cu") (remove_unused_layers yes) (keep_end_layers yes) (net 1 "A") (uuid "p2"))
    (pad "3" thru_hole circle (at 8 0) (size 1.2 1.2) (drill 0.6) (layers "*.Cu") (remove_unused_layers yes) (zone_layer_connections "In2.Cu") (net 1 "A") (uuid "p3"))
    (pad "4" smd rect (at 12 0) (size 1 1) (layers "F.Mask") (uuid "p4"))
  )
  (segment (start 15 10) (end 16.5 10) (width 0.3) (layer "In1.Cu") (net 1) (uuid "s1"))
)`)
  const idx = BoardSpatialIndex.build(board)
  const padOf = (n: number): CopperItem =>
    idx.items.find((i) => i.ref.type === 'pad' && i.ref.pad === n)!

  test("a pad's copper sits at the drill offset, turned with the pad; its hole stays put", () => {
    const shape = padOf(0).shape
    // Offset (0.5, 0) in the pad's frame at 90° lands at world (0, +0.5) from the hole.
    expect(shape.kind).toBe('rrect')
    if (shape.kind === 'rrect') {
      expect(shape.cx).toBeCloseTo(10, 9)
      expect(shape.cy).toBeCloseTo(-9.5, 9)
    }
    const pad = board.footprints[0].footprint.pads[0]
    const hole = padHoleShape(pad, { x: 10, y: -10 })
    // A 1 × 0.5 slot turned 90°: a capsule of width 0.5 along y, from −0.25 to +0.25.
    expect(hole).toMatchObject({ kind: 'capsule', halfWidth: 0.25 })
    if (hole?.kind === 'capsule') {
      expect(hole.x0).toBeCloseTo(10, 9)
      expect(Math.abs(hole.y0 - hole.y1)).toBeCloseTo(0.5, 9)
    }
    expect(padHoleShape(board.footprints[0].footprint.pads[3], { x: 0, y: 0 })).toBeNull()
  })

  test('a pad that removes unused layers keeps only what is flashed', () => {
    // Pad 2 keeps its end layers and In1.Cu, where a track of its net touches it.
    expect(padOf(1).layers).toEqual(['F.Cu', 'In1.Cu', 'B.Cu'])
    // Pad 3 keeps neither end; only the layer a zone connection forces.
    expect(padOf(2).layers).toEqual(['In2.Cu'])
    // A pad without the flag keeps every copper layer.
    expect(padOf(0).layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })
})

describe('polygons and compounds', () => {
  const square = polyShape([
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 }
    ]
  ])
  const holed = polyShape([
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ],
    [
      { x: 3, y: 3 },
      { x: 7, y: 3 },
      { x: 7, y: 7 },
      { x: 3, y: 7 }
    ]
  ])

  test('a point is inside, or its distance to the nearest edge; a hole is outside', () => {
    expect(pointToShape(square, 2, 2)).toBe(0)
    expect(pointToShape(square, 6, 2)).toBeCloseTo(2, 12)
    expect(pointToShape(holed, 5, 5)).toBeCloseTo(2, 12)
    expect(pointToShape(holed, 1, 1)).toBe(0)
  })

  test('a segment crossing an edge touches; one outside is its gap away', () => {
    expect(segmentToShape(square, -1, 2, 1, 2, 0)).toBe(0)
    expect(segmentToShape(square, 5, -1, 5, 5, 0.25)).toBeCloseTo(0.75, 12)
  })

  test('polygon against polygon and against a rounded rect', () => {
    const right = polyShape([
      [
        { x: 5, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 4 },
        { x: 5, y: 4 }
      ]
    ])
    expect(shapeToShape(square, right)).toBeCloseTo(1, 12)
    const pad: CopperShape = {
      kind: 'rrect',
      cx: 7,
      cy: 2,
      halfW: 1,
      halfH: 1,
      cornerR: 0.25,
      rotation: 0
    }
    expect(shapeToShape(square, pad)).toBeCloseTo(2, 12)
    // One wholly inside the other.
    expect(shapeToShape(square, { ...pad, cx: 2, cy: 2, halfW: 0.5, halfH: 0.5 })).toBe(0)
  })

  test('a compound is as near as its nearest part', () => {
    const compound: CopperShape = {
      kind: 'compound',
      parts: [
        { kind: 'circle', cx: 0, cy: 0, r: 0.5 },
        { kind: 'capsule', x0: 0, y0: 0, x1: 3, y1: 0, halfWidth: 0.25 }
      ]
    }
    expect(pointToShape(compound, 3, 1)).toBeCloseTo(0.75, 12)
    expect(shapeToShape(compound, { kind: 'circle', cx: 0, cy: 2, r: 0.5 })).toBeCloseTo(1, 12)
  })
})

describe('exact pad outlines', () => {
  const padBoard = (pad: string): CopperItem => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 1 "A")
  (footprint "T:T" (layer "F.Cu") (uuid "f") (at 0 0) ${pad}))`)
    return BoardSpatialIndex.build(board).items[0]
  }

  test('a trapezoid is its four corners, one side longer', () => {
    // 2 × 1 with rect_delta 0 0.5: the side at file y +0.5 spans ±1.25, the side at −0.5 ±0.75.
    const item = padBoard(
      '(pad "1" smd trapezoid (at 0 0) (size 2 1) (rect_delta 0 0.5) (layers "F.Cu") (net 1 "A"))'
    )
    expect(item.shape.kind).toBe('poly')
    // World y is the file's negated: the long side is at world y −0.5.
    expect(pointToShape(item.shape, 1.15, -0.45)).toBe(0)
    expect(pointToShape(item.shape, 1.15, 0.45)).toBeGreaterThan(0)
  })

  test('a custom pad is its anchor and its primitives', () => {
    const item = padBoard(`(pad "1" smd custom (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "A")
      (options (clearance outline) (anchor circle))
      (primitives (gr_rect (start 0 -0.25) (end 3 0.25) (width 0) (fill yes))))`)
    expect(item.shape.kind).toBe('compound')
    // The rectangle reaches 3 mm out; the anchor alone would not.
    expect(pointToShape(item.shape, 2.9, 0)).toBe(0)
    expect(padFrame(item.shape)?.halfW).toBeCloseTo(0.25, 12)
  })

  test('a chamfered pad is cut at its named corners', () => {
    const item = padBoard(
      '(pad "1" smd roundrect (at 0 0) (size 2 2) (roundrect_rratio 0) (chamfer_ratio 0.25) (chamfer top_left) (layers "F.Cu") (net 1 "A"))'
    )
    expect(item.shape.kind).toBe('poly')
    // Top left (y down in the file: world y up) is cut; the opposite corner is not.
    expect(pointToShape(item.shape, -0.95, 0.95)).toBeGreaterThan(0)
    expect(pointToShape(item.shape, 0.95, -0.95)).toBe(0)
  })
})

describe('pad layer tokens', () => {
  test('F&B.Cu is the outer layers, and no inner one', () => {
    const board = parseKicadBoard(
      boardSource.replace(
        '(pad "3" smd rect (at 0 2) (size 1 1) (layers "F.Paste" "F.Mask"))',
        '(pad "3" np_thru_hole circle (at 0 2) (size 1 1) (drill 0.5) (layers "F&B.Cu" "*.Mask"))'
      )
    )
    const item = BoardSpatialIndex.build(board).items.find(
      (i) => i.ref.type === 'pad' && i.ref.pad === 2
    )
    expect(item?.layers).toEqual(['F.Cu', 'B.Cu'])
  })
})

describe('arcs, measured exactly', () => {
  // A quarter circle of radius 10 about the origin, from (10,0) through 45° to (0,10); no width.
  const s = Math.SQRT1_2 * 10
  const quarter: CopperShape = {
    kind: 'arc',
    x0: 10,
    y0: 0,
    mx: s,
    my: s,
    x1: 0,
    y1: 10,
    halfWidth: 0
  }

  test('a point: radially within the sweep, else to the nearer end', () => {
    expect(pointToShape(quarter, 0, 0)).toBeCloseTo(10, 12)
    expect(pointToShape(quarter, 20, 20)).toBeCloseTo(Math.hypot(20, 20) - 10, 12)
    expect(pointToShape(quarter, 10, -5)).toBeCloseTo(5, 12)
  })

  test('a segment: crossing is 0, a tangent line its gap, one inside the circle its far end', () => {
    expect(segmentToShape(quarter, 0, 0, 20, 20, 0)).toBe(0)
    // The line x + y = 20, parallel to the tangent at 45°, is 20/√2 − 10 from the arc.
    expect(segmentToShape(quarter, 20, 0, 0, 20, 0)).toBeCloseTo(20 / Math.SQRT2 - 10, 12)
    expect(segmentToShape(quarter, 1, 1, 2, 2, 0)).toBeCloseTo(10 - Math.hypot(2, 2), 12)
  })

  test('two arcs: concentric by the radii, crossing at 0, and the long way round through the mid', () => {
    const scaled = (r: number): CopperShape => ({
      kind: 'arc',
      x0: r,
      y0: 0,
      mx: Math.SQRT1_2 * r,
      my: Math.SQRT1_2 * r,
      x1: 0,
      y1: r,
      halfWidth: 0.5
    })
    expect(shapeToShape(quarter, scaled(12))).toBeCloseTo(1.5, 12)
    const crossing: CopperShape = {
      kind: 'arc',
      x0: 2,
      y0: 2,
      mx: 8,
      my: 8,
      x1: 14,
      y1: 2,
      halfWidth: 0
    }
    expect(shapeToShape(quarter, crossing)).toBe(0)
    // Mid past the end: the arc runs the long way round, so it reaches (−10, 0).
    const long: CopperShape = {
      kind: 'arc',
      x0: 10,
      y0: 0,
      mx: 0,
      my: -10,
      x1: 0,
      y1: 10,
      halfWidth: 0
    }
    expect(pointToShape(long, -12, 0)).toBeCloseTo(2, 12)
  })
})
