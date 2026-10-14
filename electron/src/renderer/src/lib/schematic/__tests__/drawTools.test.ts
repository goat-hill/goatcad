import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { mmToNm, nm } from '../../kicad/coordinates'
import { parseKicadSchematic, serializeKicadSchematic, type Point } from '../../kicad/schematic'
import {
  arcMidpoint,
  bezierDraft,
  BUS_ENTRY_SIZE,
  BUS_ENTRY_SIZE_FLIPPED,
  busEntryLanding,
  draftItem,
  draftSheet,
  rotateBusEntrySize,
  sheetPinTarget,
  spannedBox,
  tableDraft,
  unplacedSheetPins,
  writeDrawItem,
  type DraftOptions,
  type DrawItem
} from '../drawTools'

const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

const OPTIONS: DraftOptions = {
  posture: 'hv',
  busEntrySize: BUS_ENTRY_SIZE,
  directiveShape: 'round',
  buses: []
}

// A KiCad 10 sheet that round-trips byte-identically (schematicSheetItems.test.ts).
const FIXTURE = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/lib/kicad/__tests__/fixtures/sheet_graphics.kicad_sch'),
  'utf8'
)

/** The top-level nodes a write added, uuids blanked, as the file spells them. */
const added = (item: DrawItem): string[] => {
  const sheet = parseKicadSchematic(FIXTURE)
  const before = new Set(sheet._root.children)
  writeDrawItem(sheet, item)
  const written = serializeKicadSchematic(sheet)
  // Lossless: without what it added, the file is byte for byte what it was.
  const fresh = sheet._root.children.filter((child) => !before.has(child))
  sheet._root.children = sheet._root.children.filter((child) => before.has(child))
  expect(serializeKicadSchematic(sheet)).toBe(FIXTURE)
  expect(fresh.length).toBeGreaterThan(0)
  const original = new Set(FIXTURE.split(/\n(?=\t\()/))
  return written
    .split(/\n(?=\t\()/)
    .filter((block) => !original.has(block))
    .map((block) => block.replace(/\(uuid "[^"]*"\)/g, '(uuid)'))
}

describe('the arc KiCad 10 draws from two clicks', () => {
  test('subtends 90°, clockwise on screen from start to end', () => {
    // Left to right, it bulges up (y smaller): kicad-cli's SVG draws this
    // probe as `A7.1842 … 0 0 0` through y 28.3758.
    expect(arcMidpoint(p(91.44, 30.48), p(101.6, 30.48))).toEqual(p(96.52, 28.3758))
    // Top to bottom, it bulges right.
    expect(arcMidpoint(p(111.76, 20.32), p(111.76, 30.48))).toEqual(p(113.8642, 25.4))
  })

  test('lands its midpoint on the 100 nm schematic unit, as KiCad saves it', () => {
    const mid = arcMidpoint(p(0, 0), p(3.81, 1.27))
    expect(Math.abs(mid.x % 100)).toBe(0)
    expect(Math.abs(mid.y % 100)).toBe(0)
  })
})

describe('draft geometry', () => {
  test('a box spans two corners in either order', () => {
    expect(spannedBox(p(10, 20), p(4, 8))).toEqual({
      position: p(4, 8),
      size: { width: mmToNm(6), height: mmToNm(12) }
    })
  })

  test('a bus entry turns a quarter at a time and comes back', () => {
    let size = BUS_ENTRY_SIZE
    const seen = [size]
    for (let turn = 0; turn < 4; turn++) {
      size = rotateBusEntrySize(size)
      seen.push(size)
    }
    expect(seen[4]).toEqual(BUS_ENTRY_SIZE)
    expect(new Set(seen.slice(0, 4).map((entry) => `${entry.width},${entry.height}`)).size).toBe(4)
    expect(seen).toContainEqual(BUS_ENTRY_SIZE_FLIPPED)
  })

  test('a bus entry lands on the bus under the cursor, and stays put away from one', () => {
    const buses = [[p(40.64, 50.8), p(40.64, 101.6)]]
    expect(busEntryLanding(buses, p(41.2, 63.5))).toEqual(p(40.64, 63.5))
    expect(busEntryLanding(buses, p(50.8, 63.5))).toEqual(p(50.8, 63.5))
  })

  test('a run follows the posture for a bus and goes straight for a line', () => {
    expect(draftItem('bus', [p(0, 0)], p(10, 5), OPTIONS)).toEqual({
      kind: 'bus',
      points: [p(0, 0), p(10, 0), p(10, 5)]
    })
    expect(draftItem('line', [p(0, 0)], p(10, 5), OPTIONS)).toEqual({
      kind: 'polyline',
      points: [p(0, 0), p(10, 5)]
    })
    expect(draftItem('line', [], p(10, 5), OPTIONS)).toBeNull()
  })

  test('a second click that spans nothing makes nothing', () => {
    expect(draftItem('rectangle', [p(5, 5)], p(5, 9), OPTIONS)).toBeNull()
    expect(draftItem('text_box', [p(5, 5)], p(9, 5), OPTIONS)).toBeNull()
    expect(draftItem('circle', [p(5, 5)], p(5, 5), OPTIONS)).toBeNull()
    expect(draftItem('arc', [p(5, 5)], p(5, 5), OPTIONS)).toBeNull()
  })

  test('a circle is its center and the distance to the rim click', () => {
    expect(draftItem('circle', [p(76.2, 25.4)], p(81.28, 25.4), OPTIONS)).toEqual({
      kind: 'circle',
      center: p(76.2, 25.4),
      radius: mmToNm(5.08)
    })
  })
})

describe('a sheet pin', () => {
  const parent = parseKicadSchematic(`(kicad_sch (version 20250114) (generator "eeschema")
    (uuid "aaaaaaaa-0000-0000-0000-000000000000")
    (sheet (at 50.8 50.8) (size 20.32 15.24) (uuid "sheet-1")
      (property "Sheetname" "Child" (at 50.8 50 0))
      (property "Sheetfile" "child.kicad_sch" (at 50.8 67 0))
      (pin "SDA" bidirectional (at 50.8 53.34 180) (uuid "p1"))))`)
  const child = parseKicadSchematic(`(kicad_sch (version 20250114) (generator "eeschema")
    (uuid "bbbbbbbb-0000-0000-0000-000000000000")
    (hierarchical_label "SDA" (shape bidirectional) (at 10 10 0))
    (hierarchical_label "SCL" (shape output) (at 10 12 0))
    (hierarchical_label "SCL" (shape output) (at 10 14 0))
    (hierarchical_label "INT" (shape tri_state) (at 10 16 0))
    (label "LOCAL" (at 10 18 0)))`)

  test('lands on the nearest edge of the sheet clicked, at the pin pitch', () => {
    expect(sheetPinTarget(parent.sheets, p(71.5, 58.3))).toEqual({
      sheetIndex: 0,
      position: p(71.12, 58.42),
      side: 'right'
    })
    expect(sheetPinTarget(parent.sheets, p(20, 20))).toBeNull()
  })

  test('imports the child labels no pin carries yet, in order, with their shapes', () => {
    expect(unplacedSheetPins(parent.sheets[0], child)).toEqual([
      { name: 'SCL', shape: 'output' },
      { name: 'INT', shape: 'tri_state' }
    ])
    expect(unplacedSheetPins(parent.sheets[0], null)).toEqual([])
  })
})

// Each writer's output is what `kicad-cli sch upgrade` (KiCad 10.0.6) re-saves
// unchanged: a probe sheet holding every one was upgraded and diffed node by
// node, uuids aside, and `kicad-cli sch export svg` drew each where these say.
describe('the writers add only their nodes, in KiCad 10’s own form', () => {
  test('a line is one two-point polyline per segment', () => {
    expect(
      added({ kind: 'polyline', points: [p(20.32, 20.32), p(30.48, 20.32), p(35.56, 27.94)] })
    ).toEqual([
      '\t(polyline\n\t\t(pts\n\t\t\t(xy 20.32 20.32) (xy 30.48 20.32)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid)\n\t)',
      '\t(polyline\n\t\t(pts\n\t\t\t(xy 30.48 20.32) (xy 35.56 27.94)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
  })

  test('a bus is one bus node per segment', () => {
    const nodes = added({
      kind: 'bus',
      points: [p(40.64, 101.6), p(60.96, 101.6), p(60.96, 111.76)]
    })
    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toBe(
      '\t(bus\n\t\t(pts\n\t\t\t(xy 60.96 101.6) (xy 60.96 111.76)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid)\n\t)'
    )
  })

  test('a bus entry', () => {
    expect(
      added({ kind: 'bus_entry', position: p(40.64, 73.66), size: BUS_ENTRY_SIZE_FLIPPED })
    ).toEqual([
      '\t(bus_entry\n\t\t(at 40.64 73.66)\n\t\t(size 2.54 -2.54)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
  })

  test('a rectangle, a circle and an arc, unfilled', () => {
    expect(added({ kind: 'rectangle', start: p(50.8, 20.32), end: p(63.5, 30.48) })).toEqual([
      '\t(rectangle\n\t\t(start 50.8 20.32)\n\t\t(end 63.5 30.48)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(fill\n\t\t\t(type none)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
    expect(added({ kind: 'circle', center: p(76.2, 25.4), radius: mmToNm(5.08) })).toEqual([
      '\t(circle\n\t\t(center 76.2 25.4)\n\t\t(radius 5.08)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(fill\n\t\t\t(type none)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
    const start = p(91.44, 30.48)
    const end = p(101.6, 30.48)
    expect(added({ kind: 'arc', start, mid: arcMidpoint(start, end), end })).toEqual([
      '\t(arc\n\t\t(start 91.44 30.48)\n\t\t(mid 96.52 28.3758)\n\t\t(end 101.6 30.48)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(fill\n\t\t\t(type none)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
  })

  test('a text box, with the margins KiCad writes for a new one', () => {
    expect(
      added({
        kind: 'text_box',
        position: p(101.6, 50.8),
        size: { width: mmToNm(25.4), height: mmToNm(12.7) },
        text: 'Hello box'
      })
    ).toEqual([
      '\t(text_box "Hello box"\n\t\t(exclude_from_sim no)\n\t\t(at 101.6 50.8 0)\n\t\t(size 25.4 12.7)\n\t\t(margins 0.9525 0.9525 0.9525 0.9525)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(fill\n\t\t\t(type none)\n\t\t)\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t)\n\t\t\t(justify left top)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
  })

  test('a directive label, its Netclass field autoplaced beside the flag', () => {
    const [node] = added({
      kind: 'directive_label',
      position: p(76.2, 63.5),
      shape: 'round',
      netclass: 'Power'
    })
    expect(node).toBe(
      '\t(netclass_flag ""\n\t\t(length 2.54)\n\t\t(shape round)\n\t\t(at 76.2 63.5 0)\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t)\n\t\t\t(justify left bottom)\n\t\t)\n\t\t(uuid)\n\t\t(property "Netclass" "Power"\n\t\t\t(at 76.8985 60.96 0)\n\t\t\t(show_name no)\n\t\t\t(do_not_autoplace no)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t(italic yes)\n\t\t\t\t)\n\t\t\t\t(justify left)\n\t\t\t)\n\t\t)\n\t)'
    )
  })
})

describe('the preview', () => {
  test('is the item itself, read back from a scratch sheet', () => {
    const sheet = draftSheet({
      kind: 'directive_label',
      position: p(10, 10),
      shape: 'diamond',
      netclass: ''
    })
    expect(sheet.directiveLabels).toHaveLength(1)
    expect(sheet.directiveLabels[0].shape).toBe('diamond')
    expect(sheet.directiveLabels[0].properties).toEqual([])
    const entry = draftSheet({ kind: 'bus_entry', position: p(1, 2), size: BUS_ENTRY_SIZE })
    expect(entry.busEntries[0].size).toEqual({ width: nm(2_540_000), height: nm(2_540_000) })
  })
})

describe('a bezier, four clicks as KiCad takes them', () => {
  test('the second click is the end, dragging the second control point with it', () => {
    expect(bezierDraft([], p(1, 1))).toBeNull()
    expect(bezierDraft([p(0, 0)], p(0, 0))).toBeNull()
    expect(bezierDraft([p(0, 0)], p(10, 0))).toEqual([p(0, 0), p(0, 0), p(10, 0), p(10, 0)])
  })

  test('then the first control point, then the second', () => {
    expect(bezierDraft([p(0, 0), p(10, 0)], p(2, 5))).toEqual([
      p(0, 0),
      p(2, 5),
      p(10, 0),
      p(10, 0)
    ])
    expect(bezierDraft([p(0, 0), p(10, 0), p(2, 5)], p(8, -5))).toEqual([
      p(0, 0),
      p(2, 5),
      p(8, -5),
      p(10, 0)
    ])
  })

  test('is written as KiCad writes one', () => {
    expect(added({ kind: 'bezier', points: [p(10, 10), p(12, 5), p(18, 5), p(20, 10)] })).toEqual([
      '\t(bezier\n\t\t(pts\n\t\t\t(xy 10 10) (xy 12 5) (xy 18 5) (xy 20 10)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(fill\n\t\t\t(type none)\n\t\t)\n\t\t(uuid)\n\t)'
    ])
  })
})

describe('a table, sized as KiCad sizes one while it is dragged out', () => {
  const grid = mmToNm(1.27)

  test('a column per 15 text heights and a row per 2, each cell rounded to the grid', () => {
    // 50 mm × 10 mm: 50 / 19.05 → 2 columns of 25.4; 10 / 2.54 → 3 rows of 3.81.
    expect(tableDraft(p(0, 0), p(50, 10), grid)).toEqual({
      columnWidths: [mmToNm(25.4), mmToNm(25.4)],
      rowHeights: [mmToNm(3.81), mmToNm(3.81), mmToNm(3.81)]
    })
  })

  test('never smaller than one cell of 5 × 2 grid steps', () => {
    expect(tableDraft(p(10, 10), p(5, 5), grid)).toEqual({
      columnWidths: [mmToNm(6.35)],
      rowHeights: [mmToNm(2.54)]
    })
  })

  test('is written with its borders on and one empty cell per row and column', () => {
    const [written] = added({
      kind: 'table',
      position: p(10, 20),
      columnWidths: [mmToNm(25.4)],
      rowHeights: [mmToNm(2.54), mmToNm(2.54)]
    })
    expect(written).toContain('(column_count 1)')
    expect(written).toContain('(column_widths 25.4)')
    expect(written).toContain('(row_heights 2.54 2.54)')
    expect(written).toContain('(border\n\t\t\t(external yes)\n\t\t\t(header yes)')
    const table = draftSheet({
      kind: 'table',
      position: p(10, 20),
      columnWidths: [mmToNm(25.4)],
      rowHeights: [mmToNm(2.54), mmToNm(2.54)]
    }).tables[0]
    expect(table.columnCount).toBe(1)
    expect(table.cells.map((cell) => cell.position)).toEqual([
      { ...p(10, 20), angle: 0 },
      { ...p(10, 22.54), angle: 0 }
    ])
    expect(table.cells[1].size).toEqual({ width: mmToNm(25.4), height: mmToNm(2.54) })
  })
})

describe('a rule area', () => {
  test('previews its outline closing on the cursor', () => {
    expect(draftItem('rule_area', [], p(1, 1), OPTIONS)).toBeNull()
    expect(draftItem('rule_area', [p(0, 0), p(10, 0)], p(10, 10), OPTIONS)).toEqual({
      kind: 'rule_area',
      points: [p(0, 0), p(10, 0), p(10, 10)]
    })
  })

  test('is written as KiCad writes a new one: flags at their defaults, a dashed outline', () => {
    expect(added({ kind: 'rule_area', points: [p(0, 0), p(10, 0), p(10, 10)] })).toEqual([
      '\t(rule_area\n\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(polyline\n\t\t\t(pts\n\t\t\t\t(xy 0 0) (xy 10 0) (xy 10 10)\n\t\t\t)\n\t\t\t(stroke\n\t\t\t\t(width 0)\n\t\t\t\t(type dash)\n\t\t\t)\n\t\t\t(fill\n\t\t\t\t(type none)\n\t\t\t)\n\t\t\t(uuid)\n\t\t)\n\t)'
    ])
    expect(
      draftSheet({ kind: 'rule_area', points: [p(0, 0), p(10, 0), p(10, 10)] }).ruleAreas
    ).toHaveLength(1)
  })
})

describe('an image', () => {
  const png = parseKicadSchematic(FIXTURE).images[1].data

  test('rides the cursor only while the tool holds a picture', () => {
    expect(draftItem('image', [], p(5, 5), OPTIONS)).toBeNull()
    expect(draftItem('image', [], p(5, 5), { ...OPTIONS, image: png })).toEqual({
      kind: 'image',
      position: p(5, 5),
      data: png
    })
  })

  test('is written centered on the click, its PNG in 76-character atoms', () => {
    const [written] = added({ kind: 'image', position: p(30, 40), data: png })
    expect(written.startsWith('\t(image\n\t\t(at 30 40)\n\t\t(uuid)\n\t\t(data "')).toBe(true)
    const atoms = [...written.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((match) => match[1])
    expect(atoms.join('')).toBe(png)
    expect(atoms.slice(0, -1).every((atom) => atom.length === 76)).toBe(true)
    expect(draftSheet({ kind: 'image', position: p(30, 40), data: png }).images[0].data).toBe(png)
  })
})
