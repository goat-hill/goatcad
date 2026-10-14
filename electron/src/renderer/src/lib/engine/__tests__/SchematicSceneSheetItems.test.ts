import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SchematicScene,
  SCHEMATIC_PAINT_ORDER as Z,
  schematicItemKey,
  type SchematicItemRef
} from '../SchematicScene'
import { parseKicadSchematic } from '../../kicad/schematic'

const FIXTURE = resolve(
  process.cwd(),
  'src/renderer/src/lib/kicad/__tests__/fixtures/sheet_graphics.kicad_sch'
)

/** A batch row: [x0, y0, x1, y1, halfWidth, param1, z, type, r, g, b, a]. */
const rows = (elements: Map<string, string[]>, key: string): number[][] =>
  (elements.get(key) ?? []).map((row) => row.split(',').map(Number))

describe('SchematicScene draws the sheet items KiCad draws', () => {
  const document = parseKicadSchematic(readFileSync(FIXTURE, 'utf8'))
  const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
  scene.rebuild(document)
  const elements = scene.debugElements()

  test('every item has paint under a kind:index key', () => {
    const keys = [
      ...document.buses.map((_, i) => `bus:${i}`),
      ...document.busEntries.map((_, i) => `bus_entry:${i}`),
      ...document.polylines.map((_, i) => `polyline:${i}`),
      ...document.circles.map((_, i) => `circle:${i}`),
      ...document.arcs.map((_, i) => `arc:${i}`),
      ...document.beziers.map((_, i) => `bezier:${i}`),
      ...document.textBoxes.map((_, i) => `text_box:${i}`),
      ...document.tables.map((_, i) => `table:${i}`),
      ...document.directiveLabels.map((_, i) => `netclass_flag:${i}`),
      ...document.ruleAreas.map((_, i) => `rule_area:${i}`),
      ...document.shapes.map((_, i) => `shape:${i}`)
    ]
    for (const key of keys) expect(elements.get(key)?.length ?? 0, key).toBeGreaterThan(0)
  })

  test('a bus draws at 12 mil, under the wires', () => {
    const index = document.buses.findIndex((b) => b.strokeType === 'default')
    const [row] = rows(elements, `bus:${index}`)
    expect(row[4]).toBeCloseTo(0.1524, 6)
    expect(row[6]).toBeCloseTo(Z.bus, 6)
  })

  test('a dashed line is cut into KiCad-length dashes', () => {
    const index = document.polylines.findIndex(
      (p) => p.graphic.stroke.type === 'dash' && p.graphic.points.length === 2
    )
    const dashes = rows(elements, `polyline:${index}`)
    // 40 mm at an 11 + 4 pen period: 18 dashes, each 11 × 0.1524 long.
    expect(dashes).toHaveLength(18)
    expect(Math.hypot(dashes[0][2] - dashes[0][0], dashes[0][3] - dashes[0][1])).toBeCloseTo(
      1.6764,
      4
    )
  })

  test('fills paint under their outline, hatches as lines', () => {
    const color = document.shapes.findIndex((s) => s.fillColor?.a === 1 && s.fill === 'color')
    expect(rows(elements, `shape:${color}:fill`)).toHaveLength(1)
    const hatch = document.shapes.findIndex((s) => s.fill === 'hatch')
    expect(rows(elements, `shape:${hatch}:fill`)).toHaveLength(8)
  })

  test('a dot flag fills its head', () => {
    const dot = document.directiveLabels.findIndex((l) => l.shape === 'dot')
    expect(rows(elements, `netclass_flag:${dot}:fill`)).toHaveLength(1)
  })
})

describe('SchematicScene hits every sheet item on its outline', () => {
  const document = parseKicadSchematic(readFileSync(FIXTURE, 'utf8'))
  const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
  scene.rebuild(document)
  /** Sheet (y-down, mm) to engine (y-up). */
  const at = (x: number, y: number): THREE.Vector2 => new THREE.Vector2(x, -y)
  const hits = (point: THREE.Vector2, threshold = 0.3): string[] =>
    scene.hitCandidates(point, threshold).map((c) => schematicItemKey(c.levels[0].ref))
  const types = [
    'bus',
    'bus_entry',
    'polyline',
    'circle',
    'arc',
    'bezier',
    'text_box',
    'table',
    'image',
    'netclass_flag',
    'rule_area',
    'shape'
  ] as const

  test('an unfilled rectangle is hit on its edge, not in its middle', () => {
    const index = document.shapes.findIndex((s) => s.fill === 'none')
    const shape = document.shapes[index]
    const x0 = shape.start.x / 1e6
    const y0 = shape.start.y / 1e6
    const x1 = shape.end.x / 1e6
    const y1 = shape.end.y / 1e6
    expect(hits(at((x0 + x1) / 2, y0))).toContain(`shape:${index}`)
    expect(hits(at((x0 + x1) / 2, (y0 + y1) / 2))).not.toContain(`shape:${index}`)
  })

  test('a filled one is hit inside, ranked behind every stroke', () => {
    // The red rectangle at (96,20)-(108,30).
    const index = document.shapes.findIndex((s) => s.fill === 'color' && s.start.x === 96e6)
    const inside = hits(at(102, 25))
    expect(inside).toContain(`shape:${index}`)
    const edge = scene.hitCandidates(at(102, 20), 0.3)
    expect(schematicItemKey(edge[0].levels[0].ref)).toBe(`shape:${index}`)
  })

  test('a circle is hit on its ring', () => {
    // center (90,45) radius 5, filled: its ring AND its body.
    const index = document.circles.findIndex((c) => c.graphic.center.x === 90e6)
    expect(hits(at(95, 45))).toContain(`circle:${index}`)
    expect(hits(at(90, 45))).toContain(`circle:${index}`)
    expect(hits(at(97, 45))).not.toContain(`circle:${index}`)
  })

  test('the filter kind of each hit is its coarse kind', () => {
    const start = document.buses[0].points[0]
    const bus = scene
      .hitCandidates(at(start.x / 1e6, start.y / 1e6), 0.3)
      .find((c) => c.levels[0].ref.type === 'bus')
    expect(bus?.levels[0].kind).toBe('wire')
  })

  test('a crossing band takes what it touches; a window what it encloses', () => {
    const everything = scene.boxSelect({ xMin: -1000, xMax: 1000, yMin: -1000, yMax: 1000 }, false)
    for (const type of types) {
      expect(everything.map(schematicItemKey), type).toContain(`${type}:0`)
    }
    // A small band inside an unfilled rectangle touches nothing of it; inside
    // a filled one it takes it.
    const middle = (index: number): { x: number; y: number } => {
      const shape = document.shapes[index]
      return {
        x: (shape.start.x + shape.end.x) / 2e6,
        y: -(shape.start.y + shape.end.y) / 2e6
      }
    }
    const band = (point: { x: number; y: number }): string[] =>
      scene
        .boxSelect(
          { xMin: point.x - 0.5, xMax: point.x + 0.5, yMin: point.y - 0.5, yMax: point.y + 0.5 },
          true
        )
        .map(schematicItemKey)
    const unfilled = document.shapes.findIndex((s) => s.fill === 'none')
    expect(band(middle(unfilled))).not.toContain(`shape:${unfilled}`)
    const filled = document.shapes.findIndex((s) => s.fill === 'color')
    expect(band(middle(filled))).toContain(`shape:${filled}`)
  })

  test('text boxes and directive labels carry an anchor cross; graphics do not', () => {
    expect(scene.textAnchor({ type: 'text_box', index: 0 })).not.toBeNull()
    expect(scene.textAnchor({ type: 'netclass_flag', index: 0 })).toEqual({
      x: document.directiveLabels[0].position.x / 1e6,
      y: -document.directiveLabels[0].position.y / 1e6
    })
    expect(scene.textAnchor({ type: 'polyline', index: 0 })).toBeNull()
  })
})

describe('SchematicScene lifts label text the way KiCad does', () => {
  // KiCad's GetSchematicTextOffset: a local label clears its wire by the text
  // offset (0.15 of a height) plus the pen; a global label drops 0.0715 of one.
  const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
    (label "A" (at 40 40 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
    (label "B" (at 60 40 90) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l2"))
    (sheet_instances (path "/" (page "1"))))`
  const document = parseKicadSchematic(SOURCE)
  const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
  scene.rebuild(document)
  const elements = scene.debugElements()
  const offset = 1.27 * 0.15

  test('a horizontal local label sits above its wire', () => {
    const strokes = rows(elements, 'label:0')
    const bottom = Math.min(...strokes.map((r) => Math.min(r[1], r[3]) - r[4]))
    expect(bottom).toBeGreaterThan(-40 + offset)
  })

  test('a vertical local label sits left of its wire', () => {
    const strokes = rows(elements, 'label:1')
    const right = Math.max(...strokes.map((r) => Math.max(r[0], r[2]) + r[4]))
    expect(right).toBeLessThan(60 - offset)
  })
})

describe('SchematicScene: labels, texts and a sheet’s parts', () => {
  const SOURCE = `(kicad_sch (version 20250114) (generator "t") (uuid "u") (paper "A4") (lib_symbols)
    (text "Note" (at 20 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "t1"))
    (global_label "BUS" (shape input) (at 40 40 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "g1"))
    (hierarchical_label "H" (shape output) (at 40 50 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "h1"))
    (sheet (at 100 50) (size 25 20) (stroke (width 0.15) (type solid)) (fill (color 0 0 0 0)) (uuid "s1")
      (property "Sheetname" "Child" (at 100 49.3 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
      (property "Sheetfile" "child.kicad_sch" (at 100 70.7 0) (effects (font (size 1.27 1.27)) (justify left top)))
      (pin "IN" input (at 100 55 180) (uuid "p1") (effects (font (size 1.27 1.27)) (justify left))))
    (sheet_instances (path "/" (page "1"))))`
  const document = parseKicadSchematic(SOURCE)
  const scene = new SchematicScene(new THREE.Scene(), new THREE.Scene())
  scene.rebuild(document)
  const first = (x: number, y: number): SchematicItemRef[] =>
    scene.hitCandidates(new THREE.Vector2(x, -y), 0.3)[0]?.levels.map((l) => l.ref) ?? []

  test('a click on a sheet pin lands on the pin, then its sheet', () => {
    // Just inside the box, on the pin's name.
    expect(first(101.5, 55)).toEqual([
      { type: 'sheet_pin', index: 0, pin: 0 },
      { type: 'sheet', index: 0 }
    ])
  })

  test('a click on the sheet name lands on the field, then the sheet', () => {
    expect(first(101.5, 48.8)).toEqual([
      { type: 'sheet_field', index: 0, field: 'Sheetname' },
      { type: 'sheet', index: 0 }
    ])
  })

  test('a free text is hit on its glyphs', () => {
    expect(first(21, 19.5)).toEqual([{ type: 'text', index: 0 }])
  })

  test('every kind of label, a text and a sheet pin show their anchor', () => {
    expect(scene.textAnchor({ type: 'label', index: 0 })).toEqual({ x: 40, y: -40 })
    expect(scene.textAnchor({ type: 'label', index: 1 })).toEqual({ x: 40, y: -50 })
    expect(scene.textAnchor({ type: 'text', index: 0 })).toEqual({ x: 20, y: -20 })
    expect(scene.textAnchor({ type: 'sheet_pin', index: 0, pin: 0 })).toEqual({ x: 100, y: -55 })
    expect(scene.textAnchor({ type: 'sheet_field', index: 0, field: 'Sheetfile' })).toEqual({
      x: 100,
      y: -70.7
    })
  })

  test('a sheet’s pin and name are parts of it, so the sheet’s paint covers them', () => {
    const elements = scene.debugElements()
    expect(elements.get('sheet:0/pin:0')?.length ?? 0).toBeGreaterThan(0)
    expect(elements.get('sheet:0/field:Sheetname')?.length ?? 0).toBeGreaterThan(0)
  })

  test('a band takes the sheet and the text, never the sheet’s parts', () => {
    const swept = scene.boxSelect({ xMin: 0, xMax: 200, yMin: -200, yMax: 0 }, true)
    expect(swept.some((ref) => ref.type === 'sheet_pin' || ref.type === 'sheet_field')).toBe(false)
    expect(swept).toContainEqual({ type: 'text', index: 0 })
  })
})
