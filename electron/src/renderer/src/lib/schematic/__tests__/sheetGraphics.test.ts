import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dashPath,
  directiveLabelGlyph,
  hatchLineSpacing,
  hatchSegments,
  imagePpi,
  imageSizeNm,
  pngInfo,
  sheetTextBoxFrame,
  strokeDashPattern,
  tableBorderSegments,
  type XY
} from '../sheetGraphics'
import { textBoxLayout } from '../textBox'
import { strokeOptionsFromTextEffects } from '../../kicad/newstroke'
import { parseKicadSchematic } from '../../kicad/schematic'
import { NM_PER_MM } from '../../kicad/coordinates'

// Every expected number here was read off `kicad-cli sch export svg` (KiCad
// 10.0.6) of the same fixture — the probe sheet holding one of each item.
const FIXTURE = resolve(
  process.cwd(),
  'src/renderer/src/lib/kicad/__tests__/fixtures/sheet_graphics.kicad_sch'
)
const sheet = parseKicadSchematic(readFileSync(FIXTURE, 'utf8'))

const mm = (p: XY): XY => ({
  x: Math.round((p.x / NM_PER_MM) * 1e4) / 1e4,
  y: Math.round((p.y / NM_PER_MM) * 1e4) / 1e4
})
const pen = 0.1524

describe('strokeDashPattern', () => {
  test("KiCad's ISO 128-2 runs at the default pen", () => {
    // SVG: stroke-dasharray 1.6764,0.6096 (dash) and 0.030480,0.609600 (dot).
    expect(strokeDashPattern('dash', pen)?.map((v) => +v.toFixed(5))).toEqual([1.6764, 0.6096])
    expect(strokeDashPattern('dot', pen)?.map((v) => +v.toFixed(5))).toEqual([0.03048, 0.6096])
    expect(strokeDashPattern('dash_dot', pen)).toHaveLength(4)
    expect(strokeDashPattern('dash_dot_dot', pen)).toHaveLength(6)
    expect(strokeDashPattern('solid', pen)).toBeNull()
    expect(strokeDashPattern('default', pen)).toBeNull()
    expect(strokeDashPattern(undefined, pen)).toBeNull()
  })
})

describe('dashPath', () => {
  const square: XY[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 }
  ]
  test('restarts the pattern at every vertex of a polyline', () => {
    const pieces = dashPath(square, [3, 1], true)
    expect(pieces).toEqual([
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 }
      ],
      [
        { x: 4, y: 0 },
        { x: 5, y: 0 }
      ],
      [
        { x: 5, y: 0 },
        { x: 5, y: 3 }
      ],
      [
        { x: 5, y: 4 },
        { x: 5, y: 5 }
      ]
    ])
  })
  test('runs on round a vertex when continuous', () => {
    const pieces = dashPath(square, [3, 1], false)
    // 0-3 on, 3-4 off, 4-7 on (split at the corner), 7-8 off, 8-10 on.
    expect(pieces).toHaveLength(4)
    expect(pieces[2]).toEqual([
      { x: 5, y: 0 },
      { x: 5, y: 2 }
    ])
  })
  test('a degenerate pattern draws nothing rather than looping', () => {
    expect(dashPath(square, [0, 0], true)).toEqual([])
  })
})

describe('hatchSegments', () => {
  test('lands the hatch lines where KiCad does', () => {
    // The `hatch` rectangle (144,20)-(156,30), default pen: slope -1 (y-down),
    // lines y = -x + a with a on a 3.048 grid pinned to the sheet origin.
    const rect = [
      { x: 144, y: 20 },
      { x: 156, y: 20 },
      { x: 156, y: 30 },
      { x: 144, y: 30 }
    ]
    const lines = hatchSegments(rect, [-1], hatchLineSpacing(pen))
    const intercepts = lines.map(([a]) => +(a.x + a.y).toFixed(4))
    // SVG: the hatch strokes cross the edge at 164.592 … 185.928.
    expect(intercepts).toEqual([
      164.592, 167.64, 170.688, 173.736, 176.784, 179.832, 182.88, 185.928
    ])
    for (const [a, b] of lines) {
      expect(Math.min(a.x, b.x)).toBeGreaterThanOrEqual(144 - 1e-9)
      expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(156 + 1e-9)
    }
  })
  test('widens the spacing past 100 lines', () => {
    const big = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 }
    ]
    expect(hatchSegments(big, [1], 1).length).toBeLessThanOrEqual(201)
  })
})

describe('directiveLabelGlyph', () => {
  const byField = (name: string): (typeof sheet.directiveLabels)[number] => {
    const label = sheet.directiveLabels.find((l) => l.properties.some((p) => p.value === name))
    if (!label) throw new Error(name)
    return label
  }
  test('round: a pin line to a circle on its end, pointing up at angle 0', () => {
    const glyph = directiveLabelGlyph(byField('NC0'))
    expect(glyph.polyline.map(mm)).toEqual([
      { x: 200, y: 40 },
      { x: 200, y: 37.968 }
    ])
    // SVG: <circle cx="200" cy="37.46" r="0.508">, unfilled.
    expect(mm(glyph.circle!.center)).toEqual({ x: 200, y: 37.46 })
    expect(glyph.circle!.radius / NM_PER_MM).toBeCloseTo(0.508, 6)
    expect(glyph.circle!.filled).toBe(false)
  })
  test('dot: filled, at 0.7 the size', () => {
    const glyph = directiveLabelGlyph(byField('NC1'))
    expect(glyph.circle!.filled).toBe(true)
    expect(glyph.circle!.radius / NM_PER_MM).toBeCloseTo(0.3556, 6)
  })
  test('diamond and rectangle are one closed outline', () => {
    // SVG: M 230,40 230,37.968 231.016,37.46 230,36.952 228.984,37.46 230,37.968 Z
    expect(directiveLabelGlyph(byField('NC2')).polyline.map(mm)).toEqual([
      { x: 230, y: 40 },
      { x: 230, y: 37.968 },
      { x: 231.016, y: 37.46 },
      { x: 230, y: 36.952 },
      { x: 228.984, y: 37.46 },
      { x: 230, y: 37.968 },
      { x: 230, y: 40 }
    ])
    // SVG: M 245,40 245,37.8664 245.8128,37.8664 245.8128,37.0536 244.1872,37.0536 …
    expect(directiveLabelGlyph(byField('NC3')).polyline.map(mm).slice(0, 4)).toEqual([
      { x: 245, y: 40 },
      { x: 245, y: 37.8664 },
      { x: 245.8128, y: 37.8664 },
      { x: 245.8128, y: 37.0536 }
    ])
  })
  test('the spin follows angle and justification', () => {
    // SVG circle centers: UP (90) points left, LEFT (180) down, DOWN (270) right.
    expect(mm(directiveLabelGlyph(byField('UP')).circle!.center)).toEqual({ x: 196.19, y: 60 })
    expect(mm(directiveLabelGlyph(byField('LEFT')).circle!.center)).toEqual({ x: 215, y: 62.54 })
    expect(mm(directiveLabelGlyph(byField('DOWN')).circle!.center)).toEqual({ x: 232.54, y: 60 })
  })
})

describe('tableBorderSegments', () => {
  const table = sheet.tables.find((t) => t.border.external)!
  const segments = tableBorderSegments(table).map(({ a, b, stroke }) => ({
    a: mm(a),
    b: mm(b),
    type: stroke.type
  }))
  test('column separators stop where a span reaches the side', () => {
    // SVG: x=160 from 90-95 (header, border stroke) and 95-100 (dashed); the
    // spanning bottom row has none.
    expect(segments.filter((s) => s.a.x === 160 && s.b.x === 160)).toEqual([
      { a: { x: 160, y: 90 }, b: { x: 160, y: 95 }, type: 'solid' },
      { a: { x: 160, y: 95 }, b: { x: 160, y: 100 }, type: 'dash' }
    ])
  })
  test('the header row separator takes the border stroke, the rest the separators', () => {
    const at = (y: number): Array<string | undefined> =>
      segments.filter((s) => s.a.y === y && s.b.y === y && s.a.x !== s.b.x).map((s) => s.type)
    expect(at(95)).toEqual(['solid', 'solid'])
    expect(at(100)).toEqual(['dash', 'dash'])
  })
  test('the external border rings the table', () => {
    expect(segments.slice(-4).map((s) => [s.a, s.b])).toEqual([
      [
        { x: 140, y: 90 },
        { x: 175, y: 90 }
      ],
      [
        { x: 175, y: 90 },
        { x: 175, y: 105 }
      ],
      [
        { x: 175, y: 105 },
        { x: 140, y: 105 }
      ],
      [
        { x: 140, y: 105 },
        { x: 140, y: 90 }
      ]
    ])
  })
  test('a table without external border or row lines draws only its columns', () => {
    const bare = sheet.tables.find((t) => !t.border.external)!
    expect(tableBorderSegments(bare).map(({ a, b }) => [mm(a), mm(b)])).toEqual([
      [
        { x: 200, y: 90 },
        { x: 200, y: 95 }
      ],
      [
        { x: 200, y: 95 },
        { x: 200, y: 100 }
      ]
    ])
  })
})

describe('sheetTextBoxFrame', () => {
  const box = (text: string): (typeof sheet.textBoxes)[number]['graphic'] =>
    sheet.textBoxes.find((t) => t.graphic.text === text)!.graphic
  const anchor = (text: string): XY => {
    const graphic = box(text)
    const layout = textBoxLayout(
      sheetTextBoxFrame(graphic),
      graphic.text,
      strokeOptionsFromTextEffects(graphic.effects)
    )
    // Frame space is y-up; report y-down like the SVG.
    return mm({ x: layout.anchor.x, y: -layout.anchor.y })
  }
  test('an unrotated box anchors its text by its margins', () => {
    // SVG: "Right bottom" text-anchor end at (89.0475, 101.0475).
    expect(anchor('Right bottom')).toEqual({ x: 89.0475, y: 101.0475 })
  })
  test('a 90° box keeps its rectangle and runs its text up the left edge', () => {
    // SVG: the rect stays (100,105) 12x20; the text anchors at
    // (100.9525, 124.0475), rotated -90 in SVG's y-down frame.
    expect(anchor('Rotated left top')).toEqual({ x: 100.9525, y: 124.0475 })
    expect(anchor('Rot center')).toEqual({ x: 126, y: 115 })
    const frame = sheetTextBoxFrame(box('Rotated left top'))
    const corners = textBoxLayout(
      frame,
      '',
      strokeOptionsFromTextEffects(box('Rotated left top').effects)
    ).corners.map((p) => mm({ x: p.x, y: -p.y }))
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([
      100, 112, 105, 125
    ])
  })
})

describe('image size', () => {
  test('300 PPI without a pHYs chunk, times the scale', () => {
    const image = sheet.images.find((i) => i.scale === 1.5)!
    const info = pngInfo(image.data)!
    expect([info.width, info.height, info.phys]).toEqual([48, 48, undefined])
    // SVG: width="6.0960" height="6.0960".
    expect(imageSizeNm(info, image.scale, sheet.version).width / NM_PER_MM).toBeCloseTo(6.096, 4)
  })
  test("a pHYs resolution, through the version's PPI rule", () => {
    const image = sheet.images.find((i) => i.scale === 1)!
    const info = pngInfo(image.data)!
    expect(info.phys).toEqual({ perUnit: 3780, unit: 1 })
    // 37.8 px/cm: truncated to 37 before 20260623 (94 PPI), exact after (96).
    expect(imagePpi(info, 20260306)).toBe(94)
    expect(imagePpi(info, 20260623)).toBe(96)
    expect(imagePpi(info, 20230121)).toBe(300)
    // SVG: width="10.8085" height="5.4043".
    const size = imageSizeNm(info, 1, sheet.version)
    expect(size.width / NM_PER_MM).toBeCloseTo(10.8085, 4)
    expect(size.height / NM_PER_MM).toBeCloseTo(5.4043, 4)
  })
  test('data that is not a PNG has no size', () => {
    expect(pngInfo('not base64 at all!')).toBeNull()
    expect(pngInfo(btoa('GIF89a0123456789012345678'))).toBeNull()
  })
})
