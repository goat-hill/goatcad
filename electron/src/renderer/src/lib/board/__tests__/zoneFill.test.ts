import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { beforeAll, describe, expect, test } from 'vitest'
import { loadClipper } from '../../geometry/clip'
import { parseKicadBoard } from '../../kicad/board'
import { BoardSpatialIndex } from '../spatialIndex'
import { capsuleOutline, shapeOutlines } from '../shapeOutline'
import { computeZoneFill, fractureRegion, resolveZoneLayers, zoneFillOptions } from '../zoneFill'
import { boardRules } from '../rules/boardRules'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../kicad/project'
import { copperDrawings } from '../boardDrawings'
import { CANARY_BOARD } from '../../__tests__/canaryFixture'

// A 20×10 board: closed Edge.Cuts, a GND zone over everything on F.Cu, a
// foreign (VCC) track wall splitting the board at x≈14, a GND thru-hole pad
// at (5,5) for thermal spokes, and a VCC pad at (11,5) for clearance.
const boardSource = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (gr_rect (start 0 0) (end 20 10) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "edge"))
  (footprint "Test:GNDPAD"
    (layer "F.Cu")
    (uuid "fp-gnd")
    (at 5 5)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND"))
  )
  (footprint "Test:VCCPAD"
    (layer "F.Cu")
    (uuid "fp-vcc")
    (at 11 5)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "VCC"))
  )
  (segment (start 14 -1) (end 14 11) (width 0.5) (layer "F.Cu") (net 2) (uuid "wall"))
  (zone
    (net 1)
    (net_name "GND")
    (layer "F.Cu")
    (uuid "z1")
    (hatch edge 0.5)
    (connect_pads (clearance 0.5))
    (min_thickness 0.25)
    (filled_areas_thickness no)
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10)))
  )
)`

beforeAll(async () => {
  await loadClipper()
})

/**
 * Even-odd containment over the fractured outlines (bridges cancel out).
 * The probe is written in mm; the fills come back in domain nm.
 */
const inFill = (polys: Array<Array<{ x: number; y: number }>>, xMm: number, yMm: number): boolean =>
  inFillNm(polys, xMm * 1e6, yMm * 1e6)

const inFillNm = (polys: Array<Array<{ x: number; y: number }>>, x: number, y: number): boolean =>
  polys.some((pts) => {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]
      const b = pts[j]
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside
      }
    }
    return inside
  })

const fillBoard = (): Array<Array<{ x: number; y: number }>> => {
  const board = parseKicadBoard(boardSource)
  const index = BoardSpatialIndex.build(board)
  const fills = computeZoneFill(board, index, board.zones[0], {
    clearanceTo: () => 0.2,
    maxClearance: 0.2,
    edgeClearance: 0.3
  })
  expect(fills).toHaveLength(1)
  expect(fills[0].layer).toBe('F.Cu')
  return fills[0].polys
}

describe('computeZoneFill', () => {
  test('pours copper, honors edge clearance and the min-width erosion', () => {
    const polys = fillBoard()
    expect(polys.length).toBeGreaterThan(0)
    // Deep inside the left half: copper.
    expect(inFill(polys, 7.5, 2)).toBe(true)
    // The stored polygon is the copper, the edge clearance (plus KiCad's
    // 0.5 µm margin) from the board edge: 0.2 mm in is bare, 0.55 mm in copper.
    expect(inFill(polys, 7.5, 0.2)).toBe(false)
    expect(inFill(polys, 7.5, 0.55)).toBe(true)
  })

  test('foreign copper carves its clearance', () => {
    const polys = fillBoard()
    // On the VCC wall's centerline and just off its edge: no copper.
    expect(inFill(polys, 14, 5)).toBe(false)
    expect(inFill(polys, 14.35, 2)).toBe(false) // 0.25 half-width + 0.2 clearance
    // Inside the VCC pad's clearance ring: bare; 1 mm clear of it: copper.
    expect(inFill(polys, 11.6, 5)).toBe(false)
    expect(inFill(polys, 12.7, 5)).toBe(true)
  })

  test('thermal reliefs: gap around the pad, spokes across it', () => {
    const polys = fillBoard()
    // A round pad with no angle in the file takes KiCad's 45°: mid-gap (pad
    // r=0.8, gap 0.5) the spoke crosses on the diagonal, and the axis is bare.
    const d = 1.05 / Math.SQRT2
    expect(inFill(polys, 5 + d, 5 + d)).toBe(true)
    expect(inFill(polys, 5 + 1.05, 5)).toBe(false)
  })

  test("a pad's thermal_bridge_angle turns its spokes", () => {
    const board = parseKicadBoard(
      boardSource.replace('(drill 0.8)', '(drill 0.8) (thermal_bridge_angle 90)')
    )
    const polys = computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
      clearanceTo: () => 0.2,
      maxClearance: 0.2,
      edgeClearance: 0.3
    })[0].polys
    const d = 1.05 / Math.SQRT2
    expect(inFill(polys, 5 + 1.05, 5)).toBe(true)
    expect(inFill(polys, 5 + d, 5 + d)).toBe(false)
  })

  test('islands without a same-net anchor are removed', () => {
    const polys = fillBoard()
    // Right of the VCC wall there is no GND copper: island removed.
    expect(inFill(polys, 17, 5)).toBe(false)
    expect(inFill(polys, 19, 8)).toBe(false)
  })

  test("a footprint's keepout carves the pour, as a module's antenna area must", () => {
    // Board-absolute points, as a board file holds a footprint's zones.
    const keepout = `
  (footprint "Test:MODULE"
    (layer "F.Cu")
    (uuid "fp-mod")
    (at 7 7)
    (zone (layers "F.Cu" "B.Cu" "In1.Cu") (uuid "ko") (hatch full 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints not_allowed))
      (polygon (pts (xy 6 6) (xy 9 6) (xy 9 9) (xy 6 9))))
  )`
    const board = parseKicadBoard(boardSource.replace(/\)\s*$/, `${keepout}\n)`))
    const polys = computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
      clearanceTo: () => 0.2,
      maxClearance: 0.2,
      edgeClearance: 0.3
    })[0].polys
    expect(inFill(polys, 7.5, 7.5)).toBe(false)
    expect(inFill(polys, 7.5, 2)).toBe(true)
  })

  test("a straight clearance edge is exact: half the track, the clearance and KiCad's margin", () => {
    const polys = fillBoard()
    // The wall's left edge: 14 − 0.25 − 0.2 − 0.0005 = 13.5495.
    expect(inFill(polys, 13.547, 2)).toBe(true)
    expect(inFill(polys, 13.552, 2)).toBe(false)
  })

  test('copper text keeps the pour off its box, corners square', () => {
    const text = `
  (gr_text "O" (at 7.5 7.5 0) (layer "F.Cu") (uuid "t") (effects (font (size 1.5 1.5) (thickness 0.15))))`
    const board = parseKicadBoard(boardSource.replace(/\)\s*$/, `${text}\n)`))
    const box = copperDrawings(board).get('F.Cu')![0].shape
    if (box.kind !== 'rrect') throw new Error('a text is its box')
    const polys = computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
      clearanceTo: () => 0.2,
      maxClearance: 0.2,
      edgeClearance: 0.3
    })[0].polys
    // Just inside the grown box's corner, where a round inflation would leave copper.
    const cx = box.cx + box.halfW + 0.19
    const cy = box.cy + box.halfH + 0.19
    expect(inFill(polys, cx, -cy)).toBe(false)
    // Clear of it on either axis: copper.
    expect(inFill(polys, box.cx + box.halfW + 0.3, -box.cy)).toBe(true)
  })

  test('a text box keeps the pour off its area as it is, its border by the clearance', () => {
    const fill = (extra: string): Array<Array<{ x: number; y: number }>> => {
      const board = parseKicadBoard(boardSource.replace(/\)\s*$/, `${extra}\n)`))
      return computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
        clearanceTo: () => 0.2,
        maxClearance: 0.2,
        edgeClearance: 0.3
      })[0].polys
    }
    const box = (border: string): string => `
  (gr_text_box "" (start 6 6) (end 9 8) (margins 0.5 0.5 0.5 0.5) (layer "F.Cu") (uuid "b")
    (effects (font (size 1 1) (thickness 0.15))) ${border})`
    const bare = fill(box('(border no) (stroke (width 0.1) (type solid))'))
    expect(inFill(bare, 7.5, 7.9)).toBe(false)
    expect(inFill(bare, 7.5, 8.1)).toBe(true)
    // A border 0.1 mm wide: its edge, then the clearance.
    const bordered = fill(box('(border yes) (stroke (width 0.1) (type solid))'))
    expect(inFill(bordered, 7.5, 8.1)).toBe(false)
    expect(inFill(bordered, 7.5, 8.3)).toBe(true)
  })

  test("a footprint's fields other than its reference and value leave the pour alone", () => {
    const part = (key: string): string => `
  (footprint "Test:F" (layer "F.Cu") (uuid "fp-f") (at 7.5 7.5)
    (property "${key}" "O" (at 0 0) (layer "F.Cu") (uuid "f") (effects (font (size 1.5 1.5) (thickness 0.15)))))`
    const pour = (key: string): Array<Array<{ x: number; y: number }>> => {
      const board = parseKicadBoard(boardSource.replace(/\)\s*$/, `${part(key)}\n)`))
      return computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
        clearanceTo: () => 0.2,
        maxClearance: 0.2,
        edgeClearance: 0.3
      })[0].polys
    }
    // The ring of the O at its right: cut for a value, poured over for an MPN.
    expect(inFill(pour('Value'), 8.1, 7.5)).toBe(false)
    expect(inFill(pour('MPN'), 8.1, 7.5)).toBe(true)
  })

  test('a hatched pour: holes on a grid anchored to the board, webs between, a solid border', () => {
    // Web 1 mm, gap 1.5 mm: a 2.5 mm pitch from the origin. Each hole is cut
    // 1.75 mm (gap + minimum width) while the fill is shrunk by 0.124 mm, so
    // it spans k·2.5 + 0.124 … k·2.5 + 1.626 once grown back.
    const board = parseKicadBoard(
      boardSource.replace(
        '(fill (thermal_gap 0.5) (thermal_bridge_width 0.5))',
        '(fill yes (mode hatch) (thermal_gap 0.5) (thermal_bridge_width 0.5) (hatch_thickness 1) (hatch_gap 1.5) (hatch_orientation 0))'
      )
    )
    const polys = computeZoneFill(board, BoardSpatialIndex.build(board), board.zones[0], {
      clearanceTo: () => 0.2,
      maxClearance: 0.2,
      edgeClearance: 0.3
    })[0].polys
    expect(inFill(polys, 8.375, 5.875)).toBe(false) // a hole's center
    expect(inFill(polys, 9.6, 5.875)).toBe(true) // the web beside it
    expect(inFill(polys, 8.375, 0.8)).toBe(true) // the border along the board edge
  })

  test('resolveZoneLayers expands the *.Cu wildcard', () => {
    const board = parseKicadBoard(boardSource)
    expect(resolveZoneLayers(board.zones[0], board)).toEqual(['F.Cu'])
    board.zones[0].layers = ['*.Cu']
    expect(resolveZoneLayers(board.zones[0], board)).toEqual(['F.Cu', 'B.Cu'])
  })
})

describe('fractureRegion', () => {
  test('holes merge into a single even-odd-faithful outline', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const hole = [
      { x: 4, y: 4 },
      { x: 4, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 4 }
    ]
    const fractured = fractureRegion({ outer, holes: [hole] })
    // The ray lands mid-edge here, so the bridge foot is a new point, there and back.
    expect(fractured.length).toBe(outer.length + hole.length + 3)
    expect(inFillNm([fractured], 5, 5)).toBe(false) // inside the hole
    expect(inFillNm([fractured], 2, 2)).toBe(true) // solid
  })
})

/** Shoelace area of a ring, in the units it is given. */
const ringArea = (pts: ReadonlyArray<{ x: number; y: number }>): number => {
  let sum = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += pts[j].x * pts[i].y - pts[i].x * pts[j].y
  }
  return Math.abs(sum) / 2
}

/**
 * Area the scene's triangulator covers for an outline. It equals the outline's
 * own area only while no bridge crosses anything: a crossing makes triangles
 * overlap, and overlapping translucent triangles are what a pour shows as
 * darker fans.
 */
const triangulatedArea = (pts: ReadonlyArray<{ x: number; y: number }>): number => {
  const contour = pts.map((p) => new THREE.Vector2(p.x, p.y))
  let sum = 0
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    const [a, b, c] = [contour[i], contour[j], contour[k]]
    sum += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
  }
  return sum
}

describe('fractureRegion bridges', () => {
  const square = (cx: number, cy: number, r: number): Array<{ x: number; y: number }> => [
    { x: cx - r, y: cy - r },
    { x: cx - r, y: cy + r },
    { x: cx + r, y: cy + r },
    { x: cx + r, y: cy - r }
  ]

  test('a hole behind another bridges to it, not through it', () => {
    // Both holes sit on y = 5. The right one's nearest outer vertex is a
    // corner of the board, and the straight line to it runs through the left
    // hole's neighborhood; its ray meets the left hole first.
    const outer = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 0, y: 10 }
    ]
    const holes = [square(20, 5, 2), square(8, 5, 3)] // given right-to-left on purpose
    const fractured = fractureRegion({ outer, holes })
    const expected = ringArea(outer) - ringArea(holes[0]) - ringArea(holes[1])
    expect(ringArea(fractured)).toBeCloseTo(expected, 9)
    expect(triangulatedArea(fractured)).toBeCloseTo(expected, 9)
    expect(inFillNm([fractured], 20, 5)).toBe(false)
    expect(inFillNm([fractured], 8, 5)).toBe(false)
    expect(inFillNm([fractured], 14, 5)).toBe(true)
  })

  test('a hole wound the same way as its ring is still cut out', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const hole = square(5, 5, 1)
    for (const h of [hole, hole.slice().reverse()]) {
      const fractured = fractureRegion({ outer, holes: [h] })
      expect(triangulatedArea(fractured)).toBeCloseTo(100 - 4, 9)
    }
  })

  test('a real pour triangulates to its own area', () => {
    const board = parseKicadBoard(readFileSync(CANARY_BOARD, 'utf8'))
    const index = BoardSpatialIndex.build(board)
    // The densest front-copper pour: hundreds of thermal and clearance holes.
    const zone = board.zones
      .filter((z) => !z.isKeepout && z.layers.includes('F.Cu'))
      .reduce((a, b) => (ringArea(b.points) > ringArea(a.points) ? b : a))
    const fills = computeZoneFill(board, index, zone, {
      clearanceTo: () => 0.2,
      maxClearance: 0.2,
      edgeClearance: 0.3
    })
    const polys = fills.flatMap((f) => f.polys)
    expect(polys.length).toBeGreaterThan(0)
    for (const poly of polys) {
      const mm = poly.map((p) => ({ x: p.x / 1e6, y: p.y / 1e6 }))
      expect(triangulatedArea(mm) / ringArea(mm)).toBeCloseTo(1, 3)
    }
  })
})

describe('shapeOutlines', () => {
  test('sampled circles circumscribe the true radius (clearance-safe)', () => {
    const rings = shapeOutlines({ kind: 'circle', cx: 0, cy: 0, r: 1 }, 0.5)
    expect(rings).toHaveLength(1)
    for (const p of rings[0]) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(1.5 - 1e-9)
    }
  })

  test('capsule outline contains both grown endpoints', () => {
    const ring = capsuleOutline(0, 0, 10, 0, 1)
    const xs = ring.map((p) => p.x)
    const ys = ring.map((p) => p.y)
    expect(Math.min(...xs)).toBeLessThanOrEqual(-1 + 1e-6)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(11 - 1e-6)
    expect(Math.min(...ys)).toBeLessThanOrEqual(-1 + 1e-6)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(1 - 1e-6)
  })

  test('rotated rounded rect lands where the pad is', () => {
    const rings = shapeOutlines(
      { kind: 'rrect', cx: 5, cy: 5, halfW: 2, halfH: 1, cornerR: 0, rotation: Math.PI / 2 },
      0
    )
    const xs = rings[0].map((p) => p.x)
    const ys = rings[0].map((p) => p.y)
    // Rotated 90°: extents swap (2 wide becomes 2 tall).
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 6)
  })
})

describe('a physical clearance rule keeps the pour off a courtyard', () => {
  // A 6×4 front courtyard under a zone on both sides: KiCad 10.0.6 cuts it,
  // shrunk 5 µm and grown by the rule's 1 mm, on F.Cu only.
  const source = `(kicad_pcb (version 20250401) (generator "test")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
  (net 0 "") (net 1 "GND") (net 2 "SIG")
  (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "e"))
  (footprint "T:R" (layer "F.Cu") (uuid "fp1") (at 20 15)
    (fp_rect (start -3 -2) (end 3 2) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "c"))
    (pad "1" smd rect (at -1.5 0) (size 1 1) (layers "F.Cu") (net 2 "SIG") (uuid "p1")))
  (zone (net 1) (net_name "GND") (layers "F.Cu" "B.Cu") (uuid "z") (hatch edge 0.5)
    (connect_pads (clearance 0.3)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 2 2) (xy 38 2) (xy 38 28) (xy 2 28)))))`
  const areas = (dru?: string): Record<string, number> => {
    const board = parseKicadBoard(source)
    const rules = boardRules(
      board,
      {
        rules: { ...DEFAULT_DESIGN_RULES },
        classes: DEFAULT_NET_CLASSES.map((c) => ({ ...c })),
        patterns: [],
        assignments: []
      },
      dru
    )
    const zone = board.zones[0]
    const fills = computeZoneFill(
      board,
      BoardSpatialIndex.build(board),
      zone,
      zoneFillOptions(rules, zone)
    )
    return Object.fromEntries(
      fills.map((f) => [
        f.layer,
        f.polys.reduce((sum, poly) => {
          let a = 0
          poly.forEach((p, i) => {
            const q = poly[(i + 1) % poly.length]
            a += (p.x * q.y - q.x * p.y) / 1e12
          })
          return sum + Math.abs(a) / 2
        }, 0)
      ])
    )
  }

  test("cut on the courtyard side, held to KiCad's fill", () => {
    const cut = areas(`(version 1)
(rule cy (constraint physical_clearance (min 1mm)) (condition "A.Type == 'Zone' && B.Type == 'Footprint'"))`)
    expect(cut['F.Cu']).toBeCloseTo(889.003, 2)
    expect(cut['B.Cu']).toBeCloseTo(935.985, 2)
  })

  test('without the rule the pour keeps only from the pad', () => {
    expect(areas()['F.Cu']).toBeGreaterThan(930)
  })
})
