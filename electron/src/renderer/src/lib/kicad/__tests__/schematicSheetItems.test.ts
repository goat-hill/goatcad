import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseKicadSchematic, serializeKicadSchematic } from '../schematic'

// A KiCad 10 sheet holding one or more of every item that draws but does not
// connect (buses aside): written by hand, then re-saved by `kicad-cli sch
// upgrade` so the bytes are KiCad's own.
const FIXTURE = resolve(
  process.cwd(),
  'src/renderer/src/lib/kicad/__tests__/fixtures/sheet_graphics.kicad_sch'
)
const source = readFileSync(FIXTURE, 'utf8')

describe('sheet graphics in the schematic model', () => {
  const sheet = parseKicadSchematic(source)

  test('every item kind is typed, and nothing is left unknown', () => {
    expect(sheet._unknownNodes).toEqual([])
    expect({
      buses: sheet.buses.length,
      busEntries: sheet.busEntries.length,
      polylines: sheet.polylines.length,
      circles: sheet.circles.length,
      arcs: sheet.arcs.length,
      beziers: sheet.beziers.length,
      textBoxes: sheet.textBoxes.length,
      images: sheet.images.length,
      tables: sheet.tables.length,
      directiveLabels: sheet.directiveLabels.length,
      ruleAreas: sheet.ruleAreas.length,
      shapes: sheet.shapes.length
    }).toEqual({
      buses: 2,
      busEntries: 3,
      polylines: 9,
      circles: 2,
      arcs: 2,
      beziers: 2,
      textBoxes: 5,
      images: 2,
      tables: 2,
      directiveLabels: 8,
      ruleAreas: 2,
      shapes: 7
    })
  })

  test('parsing leaves the file byte-identical', () => {
    expect(serializeKicadSchematic(sheet)).toBe(source)
  })

  test('every item keeps its node and uuid', () => {
    const all = [
      ...sheet.buses,
      ...sheet.busEntries,
      ...sheet.polylines,
      ...sheet.circles,
      ...sheet.arcs,
      ...sheet.beziers,
      ...sheet.textBoxes,
      ...sheet.images,
      ...sheet.tables,
      ...sheet.directiveLabels,
      ...sheet.ruleAreas
    ]
    for (const item of all) {
      expect(sheet._root.children).toContain(item._node)
      expect(item.uuid).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  test('bus entries, rectangle fills and polyline strokes', () => {
    expect(sheet.busEntries.map((e) => [e.size.width, e.size.height])).toContainEqual([
      2_540_000, -2_540_000
    ])
    // KiCad's save orders items by uuid, so compare as sets. It also writes an
    // `outline` fill as `color` with the unset (0 0 0 0) — "the outline's color".
    expect(sheet.shapes.map((s) => s.fill).sort()).toEqual([
      'background',
      'color',
      'color',
      'cross_hatch',
      'hatch',
      'none',
      'reverse_hatch'
    ])
    expect(sheet.shapes.map((s) => s.fillColor)).toContainEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(sheet.shapes.map((s) => s.fillColor)).toContainEqual({ r: 255, g: 64, b: 87, a: 1 })
    expect(sheet.polylines.map((p) => p.graphic.stroke.type)).toContain('dash_dot_dot')
  })

  test('text boxes, images and tables', () => {
    const rotated = sheet.textBoxes.find((t) => t.graphic.text === 'Rotated left top')!.graphic
    expect(rotated.position).toEqual({ x: 100_000_000, y: 105_000_000, angle: 90 })
    expect(rotated.size).toEqual({ width: 12_000_000, height: 20_000_000 })
    expect(rotated.effects.horizontalAlign).toBe('left')

    expect(sheet.images.map((i) => i.scale).sort()).toEqual([1, 1.5])
    expect(sheet.images[0].data.startsWith('iVBORw0KGgo')).toBe(true)
    expect(sheet.images[0].data).not.toMatch(/\s/)

    const table = sheet.tables.find((t) => t.border.external)!
    expect(table.columnCount).toBe(2)
    expect(table.border).toMatchObject({ external: true, header: true })
    expect(table.border.stroke.width).toBe(300_000)
    expect(table.separators).toMatchObject({ rows: true, cols: true })
    expect(table.separators.stroke.type).toBe('dash')
    expect(table.cells.map((c) => c.text)).toEqual([
      'Head A',
      'Head B',
      'a1',
      'b1',
      'span both',
      ''
    ])
    expect(table.cells[4].span).toEqual({ cols: 2, rows: 1 })
    expect(table.cells[5].span).toEqual({ cols: 0, rows: 0 })
  })

  test('directive labels and rule areas', () => {
    const colored = sheet.directiveLabels.find((l) => l.properties[0]?.value === 'COL')!
    expect(colored.shape).toBe('diamond')
    expect(colored.length).toBe(3_810_000)
    expect(colored.effects.color).toEqual({ r: 236, g: 104, b: 255, a: 1 })
    expect(new Set(sheet.directiveLabels.map((l) => l.shape))).toEqual(
      new Set(['round', 'dot', 'diamond', 'rectangle'])
    )
    expect(sheet.ruleAreas[0].graphic.points).toHaveLength(4)
    expect(sheet.ruleAreas.map((r) => r.graphic.stroke.type)).toContain('dash')
  })

  test('a flag without a length takes the 100 mil default', () => {
    const minimal = parseKicadSchematic(
      '(kicad_sch (version 20250114) (netclass_flag "" (at 1 2 0) (effects (font (size 1.27 1.27)))))'
    )
    expect(minimal.directiveLabels[0]).toMatchObject({ shape: 'round', length: 2_540_000 })
  })
})
