// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
// Geometry for the sheet items KiCad draws but the schematic model holds no
// shape for: dashed strokes, hatch fills, the directive-label glyph, table
// borders, a rotated text box's frame and an image's size.
//
// Pure, so the renderer and a later hit-test measure the same thing. Every
// rule here is transcribed from KiCad's source (the file and function are
// named at each) and was checked against `kicad-cli sch export svg` output
// of a probe sheet holding each item.

import { mmToNm, NM_PER_MIL, spacingToMm } from '../kicad/coordinates'
import type {
  DirectiveLabelShape,
  KicadSchematicTable,
  KicadTextEffects,
  SymbolStroke
} from '../kicad/schematic'
import type { TextBoxFrame } from './textBox'

/** An unbranded point; units are the caller's. */
export interface XY {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Dashed strokes — `STROKE_PARAMS::Stroke` (common/stroke_params.cpp)
// ---------------------------------------------------------------------------

/**
 * ISO 128-2's ratios (dash 12, gap 3), `RENDER_SETTINGS`' defaults that the
 * schematic and the board plotter both keep (the Gerber writer dashes with
 * these too), run through
 * `RENDER_SETTINGS`' round-cap `correction` of 1: the drawn dash is 11 widths
 * long and the gap 4, so with the round caps a dash reads as 12 and a gap as 3.
 */
const DASH_RATIO = 12 - 1
const GAP_RATIO = 3 + 1
/** `GetDotLength`: `max(1 - correction, 0.2)` widths — a dot is a stub, not a point. */
const DOT_RATIO = 0.2

/**
 * The on/off run lengths of a line style at a pen width, starting with an ON
 * run, or null for a solid stroke (`solid`, `default` and anything unknown).
 */
export function strokeDashPattern(style: string | undefined, width: number): number[] | null {
  const dash = DASH_RATIO * width
  const gap = GAP_RATIO * width
  const dot = DOT_RATIO * width
  switch (style) {
    case 'dash':
      return [dash, gap]
    case 'dot':
      return [dot, gap]
    case 'dash_dot':
      return [dash, gap, dot, gap]
    case 'dash_dot_dot':
      return [dash, gap, dot, gap, dot, gap]
    default:
      return null
  }
}

/**
 * The ON pieces of `path` under `pattern`. KiCad strokes a polyline, rectangle
 * or polygon one SEGMENT at a time, restarting the pattern at every vertex
 * (`restartEachSegment`), but an arc or circle as one continuous run.
 */
export function dashPath(
  path: XY[],
  pattern: number[],
  restartEachSegment: boolean
): Array<[XY, XY]> {
  const pieces: Array<[XY, XY]> = []
  if (pattern.length === 0 || pattern.some((run) => !(run > 0))) return pieces
  let index = 0
  let remaining = pattern[0]
  // KiCad caps the walk at 10000 runs a segment; this caps the whole path, so
  // a hairline pen on a long line cannot stall the frame.
  let budget = 10000
  for (let s = 1; s < path.length && budget > 0; s++) {
    const a = path[s - 1]
    const b = path[s]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (restartEachSegment) {
      index = 0
      remaining = pattern[0]
    }
    if (length === 0) continue
    const at = (t: number): XY => ({
      x: a.x + ((b.x - a.x) * t) / length,
      y: a.y + ((b.y - a.y) * t) / length
    })
    for (let t = 0; t < length && budget > 0; budget--) {
      const step = Math.min(remaining, length - t)
      if (index % 2 === 0) pieces.push([at(t), at(t + step)])
      t += step
      remaining -= step
      if (remaining <= 0) {
        index++
        remaining = pattern[index % pattern.length]
      }
    }
  }
  return pieces
}

// ---------------------------------------------------------------------------
// Hatch fills — `EDA_SHAPE::UpdateHatching` + `SHAPE_POLY_SET::GenerateHatchLines`
// ---------------------------------------------------------------------------

/**
 * KiCad's slopes, in its y-DOWN sheet space: `hatch` runs -1, `reverse_hatch`
 * +1, `cross_hatch` both. Null for a fill that is not a hatch.
 */
export function hatchSlopes(fill: string): number[] | null {
  if (fill === 'hatch') return [-1]
  if (fill === 'reverse_hatch') return [1]
  if (fill === 'cross_hatch') return [1, -1]
  return null
}

/** `SCH_SHAPE::GetHatchLineWidth`: half the outline's pen. */
export const hatchLineWidth = (penWidth: number): number => penWidth / 2
/** `SCH_SHAPE::GetHatchLineSpacing`: forty hatch widths. */
export const hatchLineSpacing = (penWidth: number): number => hatchLineWidth(penWidth) * 40

/**
 * Hatch lines clipped to `polygon` (y-down sheet space). Lines are
 * `y = slope·x + a`, with `a` stepping by `spacing` from a multiple of it —
 * which is what pins the hatch to the sheet rather than to the shape. More
 * than 100 lines across the shape's longest side widens the spacing to fit.
 */
export function hatchSegments(polygon: XY[], slopes: number[], spacing: number): Array<[XY, XY]> {
  const out: Array<[XY, XY]> = []
  if (polygon.length < 3 || !(spacing > 0)) return out
  const xs = polygon.map((p) => p.x)
  const ys = polygon.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const major = Math.max(maxX - minX, maxY - minY)
  const step = major / spacing > 100 ? major / 100 : spacing
  for (const slope of slopes) {
    const maxA = slope > 0 ? maxY - slope * minX : maxY - slope * maxX
    let a = slope > 0 ? minY - slope * maxX : minY - slope * minX
    a = Math.trunc(a / step) * step
    for (; a < maxA; a += step) {
      const hits: XY[] = []
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i]
        const q = polygon[(i + 1) % polygon.length]
        // Where the edge p→q crosses y = slope·x + a.
        const dp = p.y - (slope * p.x + a)
        const dq = q.y - (slope * q.x + a)
        if (dp === dq || (dp > 0 && dq > 0) || (dp < 0 && dq < 0)) continue
        const t = dp / (dp - dq)
        hits.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      }
      hits.sort((m, n) => m.x - n.x)
      for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Directive labels — `SCH_DIRECTIVE_LABEL::CreateGraphicShape` (sch_label.cpp)
// ---------------------------------------------------------------------------

/** `m_symbolSize`, a constant 20 mil — the glyph's scale; the file never stores it. */
const DIRECTIVE_SYMBOL_SIZE = 20 * NM_PER_MIL

type SpinStyle = 'left' | 'up' | 'right' | 'bottom'

/**
 * `SCH_LABEL_BASE::GetSpinStyle`: which way the flag points is read from the
 * text angle (horizontal or vertical) and the horizontal justification, not
 * from the angle alone.
 */
const directiveSpin = (angle: number, align: KicadTextEffects['horizontalAlign']): SpinStyle => {
  const vertical = Math.abs((((angle % 180) + 180) % 180) - 90) < 1e-6
  if (vertical) return align === 'right' ? 'bottom' : 'up'
  return align === 'right' ? 'left' : 'right'
}

/** KiCad's `RotatePoint` per spin, on the y-down template. */
const spinPoint = (p: XY, spin: SpinStyle): XY => {
  switch (spin) {
    case 'up':
      return { x: -p.y, y: p.x }
    case 'right':
      return { x: -p.x, y: -p.y }
    case 'bottom':
      return { x: p.y, y: -p.x }
    default:
      return p
  }
}

/**
 * The flag glyph in y-down sheet nanometers. Round and dot are a pin line and
 * a circle on its end (the dot filled and 0.7 the size); diamond and
 * rectangle are one closed polyline that runs up the pin and round the head.
 */
export interface DirectiveGlyph {
  polyline: XY[]
  circle?: { center: XY; radius: number; filled: boolean }
}

export function directiveLabelGlyph(label: {
  position: XY & { angle: number }
  effects: Pick<KicadTextEffects, 'horizontalAlign'>
  shape: DirectiveLabelShape
  length: number
}): DirectiveGlyph {
  const spin = directiveSpin(label.position.angle, label.effects.horizontalAlign)
  const place = (x: number, y: number): XY => {
    const p = spinPoint({ x, y }, spin)
    return { x: label.position.x + p.x, y: label.position.y + p.y }
  }
  const pin = label.length
  const size = DIRECTIVE_SYMBOL_SIZE
  switch (label.shape) {
    case 'diamond':
      return {
        polyline: [
          place(0, 0),
          place(0, pin - size),
          place(-2 * size, pin),
          place(0, pin + size),
          place(2 * size, pin),
          place(0, pin - size),
          place(0, 0)
        ]
      }
    case 'rectangle': {
      const s = Math.round(size * 0.8)
      return {
        polyline: [
          place(0, 0),
          place(0, pin - s),
          place(-2 * s, pin - s),
          place(-2 * s, pin + s),
          place(2 * s, pin + s),
          place(2 * s, pin - s),
          place(0, pin - s),
          place(0, 0)
        ]
      }
    }
    default: {
      const s = label.shape === 'dot' ? Math.round(size * 0.7) : size
      return {
        polyline: [place(0, 0), place(0, pin - s)],
        circle: { center: place(0, pin), radius: s, filled: label.shape === 'dot' }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tables — `SCH_TABLE::DrawBorders` (sch_table.cpp)
// ---------------------------------------------------------------------------

export interface TableBorderSegment {
  a: XY
  b: XY
  stroke: SymbolStroke
}

/**
 * Every border and separator line of a table, y-down sheet nanometers. A
 * column separator is a cell's right edge and a row separator its bottom
 * edge, skipped where the cell's span reaches the table's side; the header
 * row's lines take the BORDER stroke, the rest the separators'.
 */
export function tableBorderSegments(table: KicadSchematicTable): TableBorderSegment[] {
  const cols = table.columnCount
  const rows = Math.ceil(table.cells.length / cols)
  const out: TableBorderSegment[] = []
  if (table.cells.length === 0) return out
  const cell = (row: number, col: number): KicadSchematicTable['cells'][number] | undefined =>
    table.cells[row * cols + col]
  const corners = (row: number, col: number): XY[] | null => {
    const c = cell(row, col)
    if (!c) return null
    const { x, y } = c.position
    const { width, height } = c.size
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ]
  }
  for (let col = 0; col < cols - 1; col++) {
    for (let row = 0; row < rows; row++) {
      const stroke =
        row === 0 && table.border.header
          ? table.border.stroke
          : table.separators.cols
            ? table.separators.stroke
            : null
      const c = cell(row, col)
      const k = corners(row, col)
      if (!stroke || !c || !k || c.span.cols === 0 || col + c.span.cols === cols) continue
      out.push({ a: k[1], b: k[2], stroke })
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    const stroke =
      row === 0 && table.border.header
        ? table.border.stroke
        : table.separators.rows
          ? table.separators.stroke
          : null
    if (!stroke) continue
    for (let col = 0; col < cols; col++) {
      const c = cell(row, col)
      const k = corners(row, col)
      if (!c || !k || c.span.rows === 0 || row + c.span.rows === rows) continue
      out.push({ a: k[2], b: k[3], stroke })
    }
  }
  if (table.border.external && table.border.stroke.width >= 0) {
    const topLeft = corners(0, 0)
    const topRight = corners(0, cols - 1)
    const bottomLeft = corners(rows - 1, 0)
    const bottomRight = corners(rows - 1, cols - 1)
    if (topLeft && topRight && bottomLeft && bottomRight) {
      const stroke = table.border.stroke
      out.push({ a: topLeft[0], b: topRight[1], stroke })
      out.push({ a: topRight[1], b: bottomRight[2], stroke })
      out.push({ a: bottomRight[2], b: bottomLeft[3], stroke })
      out.push({ a: bottomLeft[3], b: topLeft[0], stroke })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Sheet text boxes and table cells
// ---------------------------------------------------------------------------

/**
 * A sheet `text_box` (or table cell) as the y-UP frame `textBoxLayout` reads.
 *
 * On a sheet the box itself never turns: `(at …)` and `(size …)` are the
 * drawn rectangle whatever the angle, and only the TEXT runs at it. So the
 * frame is the box seen from the text's side — for 90°, its top-left is the
 * box's bottom-left and its width the box's height — which makes the frame's
 * corners the box's and its justification read along the text. Probed with
 * kicad-cli: a `left top` box at 90° sets its text up the box's left edge,
 * reading from the bottom.
 */
export function sheetTextBoxFrame(box: {
  position: XY & { angle: number }
  size: { width: number; height: number }
  margins: TextBoxFrame['margins']
}): TextBoxFrame {
  const width = Math.abs(box.size.width)
  const height = Math.abs(box.size.height)
  // y-up center of the drawn box.
  const cx = box.position.x + box.size.width / 2
  const cy = -(box.position.y + box.size.height / 2)
  const angle = box.position.angle
  const quarter = Math.round(angle / 90) % 2 !== 0
  const along = quarter ? height : width
  const across = quarter ? width : height
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const hx = -along / 2
  const hy = across / 2
  return {
    position: { x: cx + hx * cos - hy * sin, y: cy + hx * sin + hy * cos, angle },
    size: { width: along, height: -across },
    margins: box.margins
  }
}

// ---------------------------------------------------------------------------
// Images — `BITMAP_BASE` / `REFERENCE_IMAGE` and the sexpr parser's PPI fixups
// ---------------------------------------------------------------------------

export interface PngInfo {
  width: number
  height: number
  /** pHYs pixels per unit along x, and its unit (1 = meter); absent without one. */
  phys?: { perUnit: number; unit: number }
}

const decodeBase64 = (data: string): Uint8Array | null => {
  try {
    const binary = atob(data.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** The header facts of a base64 PNG, or null when the data is not one. */
export function pngInfo(data: string): PngInfo | null {
  const bytes = decodeBase64(data)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!bytes || bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info: PngInfo = { width: view.getUint32(16), height: view.getUint32(20) }
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (type === 'pHYs' && at + 17 <= bytes.length) {
      info.phys = { perUnit: view.getUint32(at + 8), unit: bytes[at + 16] }
    }
    if (type === 'IDAT' || type === 'IEND') break
    at += 12 + length
  }
  return info
}

/** KiCad's PPI when an image carries no resolution of its own. */
const DEFAULT_PPI = 300
/** Files at or before this version were written assuming 300 PPI. */
const LEGACY_300_PPI_VERSION = 20230121
/** Files before this version truncated pixels/cm before converting to PPI. */
const TRUNCATED_PPI_VERSION = 20260623

/**
 * The PPI an image draws at in a file of `version`. wxWidgets reads a
 * meter-unit pHYs as pixels/cm; KiCad converts that to PPI (`updatePPI`), and
 * the parser rescales older files so they keep the size they were saved at —
 * which comes to drawing at 300 PPI up to 20230121 and at the truncated
 * pixels/cm conversion (`GetLegacyPPI`) until 20260623.
 */
export function imagePpi(info: PngInfo, version: number | undefined): number {
  const v = version ?? Number.POSITIVE_INFINITY
  if (v <= LEGACY_300_PPI_VERSION || !info.phys) return DEFAULT_PPI
  const { perUnit, unit } = info.phys
  if (unit !== 1) return perUnit > 1 ? perUnit : DEFAULT_PPI
  const perCm = perUnit / 100
  const legacy = v < TRUNCATED_PPI_VERSION
  const counted = legacy ? Math.trunc(perCm) : perCm
  return counted > 1 ? Math.round(counted * 2.54) : DEFAULT_PPI
}

/** An image's drawn size in nanometers — pixels at its PPI, times `(scale …)`. */
export function imageSizeNm(
  info: PngInfo,
  scale: number,
  version: number | undefined
): { width: number; height: number } {
  const inch = mmToNm(spacingToMm(1000, 'mil'))
  const ppi = imagePpi(info, version)
  return { width: (info.width / ppi) * inch * scale, height: (info.height / ppi) * inch * scale }
}
