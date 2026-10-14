// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Gerber RS-274X / X2 writer — the exporter half of `lib/gerber/` (the reader
 * is parse.ts). Turns a `KicadBoard` domain model into one Gerber file per
 * plotted layer (fabrication-export-workstream.md).
 *
 * Correctness strategy: every string this writer emits is designed to round-trip
 * through our own `parseGerber` (parse.test / write.test lean on that), and the
 * Manufacture preview renders the writer's output through that same parser — so
 * "the demo is the product drawing the board." We deliberately emit only the
 * subset parse.ts accepts: %FS/%MO header, C/R/O standard apertures, D01/D02/D03
 * operations, G36/G37 regions, and X2 TF.* attributes.
 *
 * Coordinate space: Gerber is millimetres, y-up. KiCad is y-down, so world
 * y is negated on the way out. Footprint-relative geometry uses the exact same
 * placement transform BoardScene renders with (see `tfPoint`), so an exported
 * layer matches pixel-for-pixel what the board editor shows.
 */

import { viaMaskIsOpen, viaSizeOn } from '../kicad/board'
import {
  maskSettings,
  trackMaskMargin,
  padMaskMargin,
  padPasteMargin,
  padTouchesLayer,
  viaMaskMargin
} from '../board/maskExpansion'
import type {
  KicadBoard,
  KicadBoardFootprint,
  KicadTrackSegment,
  KicadTrackArc,
  KicadVia,
  KicadBoardZone
} from '../kicad/board'
import {
  footprintTextDrawAngle,
  padOnLayer,
  padstackKey,
  parsePointList,
  type KicadDimension,
  type KicadExtraGraphic,
  isSolidFill
} from '../kicad/footprint'
import {
  BoardSpatialIndex,
  padCopperCenter,
  padShape,
  type CopperItem
} from '../board/spatialIndex'
import { viaFlashedOn } from '../board/boardConnectivity'
import { parseFlag } from '../kicad/footprint'
import {
  findChild,
  findChildren,
  getAtomValues,
  getFirstAtomValue,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { resolveLayers } from '../board/keepouts'
import { expandLayerToken } from '../kicad/layers'
import { extraGraphicDrawing, extraGraphicKind } from '../board/extraGraphics'
import { shownTextOf, type TextScope } from '../board/boardTexts'
import { dimensionGeometry } from '../board/dimensionGeometry'
import type {
  KicadPad,
  KicadFpLine,
  KicadFpArc,
  KicadFpCircle,
  KicadFpRect
} from '../kicad/footprint'
import { getTextStrokes, strokeOptionsFromEffects, type FontEffectsLike } from '../kicad/newstroke'
import { difference, merged, offset, type ClipRegion } from '../geometry/clip'
import {
  applyShapeClips,
  KeepWithinRegions,
  singleContour,
  SubtractRegions,
  type ShapeClip
} from '../geometry/regionClips'
// The outline recovery is board geometry, not 3D rendering — the 3D board and
// this writer are simply its two consumers.
import { buildBoardOutline } from '../engine/board3d/boardOutline'
import { arcThroughPoints, capsuleOutline, tessellateArc } from './shapes'
import { dashPath, strokeDashPattern } from '../schematic/sheetGraphics'
import {
  footprintTransform,
  padLocal,
  tfPoint,
  worldPoint,
  type Pt,
  type FpTransform
} from '../schematic/placement'
import { mmAtomToNm, nm, nmToMm, type Nm } from '../kicad/coordinates'

/**
 * `placement.padLocal` for outline points this writer synthesizes in mm —
 * the domain-nm version would rescale what is already world-sized.
 */
const padLocalMm = (center: Pt, cos: number, sin: number, x: number, y: number): Pt => ({
  x: center.x + x * cos + y * sin,
  y: center.y + x * sin - y * cos
})

export interface GerberWriteOptions {
  /** Decimal digits in the coordinate format (%FS…X4n). 5 or 6; default 6. */
  decimals?: number
  /** GenerationSoftware TF attribute vendor/app/version triplet. */
  generationSoftware?: { vendor: string; app: string; version: string }
  /**
   * Subtract solder-mask openings (pads with their mask margin, plus any
   * graphics drawn on the mask layer) from silkscreen. Silk over an exposed
   * pad does not survive fabrication; plotting it as if it did hides the
   * collision until the boards arrive. Default true.
   */
  subtractMaskFromSilk?: boolean
  /**
   * Clip silkscreen at the board outline, when the outline closes. Default
   * true.
   */
  clipSilkToOutline?: boolean
  /** The project's `text_variables`, which board text resolves `${NAME}` from after the board's own. */
  textVariables?: Readonly<Record<string, string>>
}

const DEFAULT_SOFTWARE = { vendor: 'GoatCAD', app: 'GoatCAD', version: '0.0.0' }

/** A single generated plot layer, ready to name and write. */
export interface GeneratedGerberLayer {
  kicadLayer: string
  /** X2 TF.FileFunction value, e.g. "Copper,L1,Top" (null when unknown). */
  fileFunction: string | null
  content: string
  /** Soft issues encountered while plotting this layer (surfaced in the UI). */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Aperture dictionary + coordinate formatting
// ---------------------------------------------------------------------------

/** An aperture definition, keyed by its `%ADD` body so identical ones dedupe. */
interface ApertureDef {
  dCode: number
  body: string
  /** X2 aperture-function attribute for this aperture (TA.AperFunction). */
  aperFunction?: string
}

class Writer {
  private readonly scale: number
  private readonly apertures: ApertureDef[] = []
  private readonly apertureByKey = new Map<string, ApertureDef>()
  private nextDCode = 10
  /** Body of the graphics stream (draws/flashes/regions) after the header. */
  private body: string[] = []
  private currentAperture = -1
  readonly warnings: string[] = []
  private warned = new Set<string>()

  constructor(decimals: number) {
    this.scale = Math.pow(10, decimals)
    this.decimals = decimals
  }
  readonly decimals: number

  warn(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.warnings.push(message)
  }

  /** Format one millimetre value as a leading-zero fixed-point integer token. */
  private num(mm: number): string {
    return String(Math.round(mm * this.scale))
  }

  private coord(p: Pt): string {
    return `X${this.num(p.x)}Y${this.num(p.y)}`
  }

  /** Intern an aperture by its `%ADD` body; returns the D-code. */
  aperture(body: string, aperFunction?: string): number {
    const key = `${aperFunction ?? ''}|${body}`
    const existing = this.apertureByKey.get(key)
    if (existing) return existing.dCode
    const def: ApertureDef = { dCode: this.nextDCode++, body, aperFunction }
    this.apertures.push(def)
    this.apertureByKey.set(key, def)
    return def.dCode
  }

  circleAperture(diameter: number, aperFunction?: string): number {
    return this.aperture(`C,${fmt(diameter)}`, aperFunction)
  }

  rectAperture(w: number, h: number, aperFunction?: string): number {
    return this.aperture(`R,${fmt(w)}X${fmt(h)}`, aperFunction)
  }

  obroundAperture(w: number, h: number, aperFunction?: string): number {
    return this.aperture(`O,${fmt(w)}X${fmt(h)}`, aperFunction)
  }

  private select(dCode: number): void {
    if (dCode === this.currentAperture) return
    this.body.push(`D${dCode}*`)
    this.currentAperture = dCode
  }

  /** Flash the given aperture at a point (D03). */
  flash(dCode: number, p: Pt): void {
    this.select(dCode)
    this.body.push(`${this.coord(p)}D03*`)
  }

  /** Stroke a polyline with a circular aperture (a run of D01 draws). */
  strokePolyline(points: Pt[], width: number, aperFunction?: string): void {
    if (points.length < 2) return
    this.select(this.circleAperture(width, aperFunction))
    this.body.push(`${this.coord(points[0])}D02*`)
    for (let i = 1; i < points.length; i++) this.body.push(`${this.coord(points[i])}D01*`)
  }

  /** Fill a closed polygon as a G36/G37 region. */
  region(points: Pt[]): void {
    if (points.length < 3) return
    this.body.push('G36*')
    this.body.push(`${this.coord(points[0])}D02*`)
    for (let i = 1; i < points.length; i++) this.body.push(`${this.coord(points[i])}D01*`)
    // Close the contour back to the start (parser drops the duplicate).
    this.body.push(`${this.coord(points[0])}D01*`)
    this.body.push('G37*')
    // A region resets the current aperture context in most writers; keep our
    // model simple by forcing the next draw/flash to re-select.
    this.currentAperture = -1
  }

  raw(line: string): void {
    this.body.push(line)
  }

  /** Assemble the full Gerber file. */
  build(fileFunction: string | null, software: GerberWriteOptions['generationSoftware']): string {
    const sw = software ?? DEFAULT_SOFTWARE
    const lines: string[] = []
    lines.push('%TF.GenerationSoftware,' + `${sw.vendor},${sw.app},${sw.version}` + '*%')
    if (fileFunction) lines.push(`%TF.FileFunction,${fileFunction}*%`)
    lines.push('%TF.FilePolarity,Positive*%')
    // Leading-zero, absolute, 4 integer digits (KiCad's default) + N decimals.
    lines.push(`%FSLAX4${this.decimals}Y4${this.decimals}*%`)
    lines.push('%MOMM*%')
    lines.push('%LPD*%')
    for (const ap of this.apertures) {
      if (ap.aperFunction) lines.push(`%TA.AperFunction,${ap.aperFunction}*%`)
      lines.push(`%ADD${ap.dCode}${ap.body}*%`)
      if (ap.aperFunction) lines.push('%TD*%')
    }
    // Joined, not spread into push: a large board's layer holds more lines
    // than a call can take arguments.
    return [...lines, ...this.body, 'M02*'].join('\n') + '\n'
  }
}

/** Trim a millimetre value to a compact aperture-modifier string. */
function fmt(mm: number): string {
  return parseFloat(mm.toFixed(6)).toString()
}

// ---------------------------------------------------------------------------
// Pad geometry
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

/** Is an angle (degrees) an axis-aligned multiple of 90°? */
function isAxisAligned(angleDeg: number): boolean {
  const a = ((angleDeg % 90) + 90) % 90
  return a < 1e-6 || 90 - a < 1e-6
}

/** True when the (normalized) angle is a quarter turn (90° or 270°). */
function isQuarterTurn(angleDeg: number): boolean {
  const a = ((angleDeg % 180) + 180) % 180
  return Math.abs(a - 90) < 1e-6
}

/**
 * Outline of a rounded rectangle in the pad-local frame (center at origin),
 * corners tessellated. `r` is the corner radius.
 */
function roundRectLocalOutline(halfW: number, halfH: number, r: number): Pt[] {
  const rr = Math.max(0, Math.min(r, Math.min(halfW, halfH)))
  if (rr < 1e-6) {
    return [
      { x: -halfW, y: -halfH },
      { x: halfW, y: -halfH },
      { x: halfW, y: halfH },
      { x: -halfW, y: halfH }
    ]
  }
  const seg = 6
  const pts: Pt[] = []
  // Corner centers, CCW from bottom-right, with their arc start angles.
  const corners: Array<{ cx: number; cy: number; start: number }> = [
    { cx: halfW - rr, cy: -halfH + rr, start: -Math.PI / 2 },
    { cx: halfW - rr, cy: halfH - rr, start: 0 },
    { cx: -halfW + rr, cy: halfH - rr, start: Math.PI / 2 },
    { cx: -halfW + rr, cy: -halfH + rr, start: Math.PI }
  ]
  for (const c of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = c.start + (Math.PI / 2) * (i / seg)
      pts.push({ x: c.cx + rr * Math.cos(a), y: c.cy + rr * Math.sin(a) })
    }
  }
  return pts
}

/** Obround (stadium) outline in the pad-local frame, center at origin. */
function obroundLocalOutline(w: number, h: number): Pt[] {
  const r = Math.min(w, h) / 2
  const dx = Math.max(0, w / 2 - r)
  const dy = Math.max(0, h / 2 - r)
  const seg = 12
  const pts: Pt[] = []
  const cap = (ccx: number, ccy: number, from: number): void => {
    for (let i = 0; i <= seg; i++) {
      const a = from + (Math.PI * i) / seg
      pts.push({ x: ccx + r * Math.cos(a), y: ccy + r * Math.sin(a) })
    }
  }
  if (dx >= dy) {
    cap(dx, 0, -Math.PI / 2)
    cap(-dx, 0, Math.PI / 2)
  } else {
    cap(0, dy, 0)
    cap(0, -dy, Math.PI)
  }
  return pts
}

/**
 * A custom pad's real shape: the anchor primitive unioned with the pad's own
 * `(primitives …)`, in the pad's rotated frame.
 *
 * Two rules, both read back from KiCad 10's aperture macros for a probe pad:
 * a primitive's `(width w)` applies to a **filled** shape as well, so filled
 * copper is the polygon plus a `w`-wide outline — a 2×1 filled rect at width
 * 0.2 comes back 2.2×1.2 — and a pad with no `(options …)` at all anchors on a
 * **circle**, not a rect.
 *
 * `margin` (mask/paste) rides on each piece's stroke rather than on their union:
 * a Minkowski sum distributes over union, so inflating the parts and painting
 * them is the same region as inflating the whole.
 */
function plotCustomPad(
  w: GraphicsSink,
  pad: KicadPad,
  center: Pt,
  angleDeg: number,
  margin: number
): void {
  // Shrunk, the pad is its pieces merged and deflated with rounded corners,
  // as KiCad shrinks a custom pad for paste; widening each stroke would leave
  // a filled piece its full size.
  if (margin < 0) {
    const collector = new Collector()
    plotCustomPad(collector, pad, center, angleDeg, 0)
    const shrunk = offset(merged(collectedRegions(collector.prims)), nmToMm(nm(margin)), {
      join: 'round'
    })
    for (const region of shrunk) w.region(singleContour(region))
    return
  }
  const cos = Math.cos((angleDeg * Math.PI) / 180)
  const sin = Math.sin((angleDeg * Math.PI) / 180)
  const marginMm = nmToMm(nm(margin))
  const at = (p: { x: Nm; y: Nm }): Pt => padLocal(center, cos, sin, p.x, p.y)
  const strokeOf = (width: Nm | undefined): number =>
    (width !== undefined ? nmToMm(width) : 0) + 2 * marginMm

  // The anchor, drawn like the ordinary pad it is.
  const anchorLocal =
    pad.anchor === 'rect'
      ? roundRectLocalOutline(
          nmToMm(nm(pad.size.w + 2 * margin)) / 2,
          nmToMm(nm(pad.size.h + 2 * margin)) / 2,
          0
        )
      : tessellateArc(0, 0, nmToMm(nm(pad.size.w + 2 * margin)) / 2, 0, TAU).slice(0, -1)
  if (nmToMm(nm(pad.size.w + 2 * margin)) > 0) {
    w.region(anchorLocal.map((p) => padLocalMm(center, cos, sin, p.x, p.y)))
  }

  const prims = pad.primitives
  if (!prims) return
  for (const line of prims.lines) {
    w.strokePolyline([at(line.start), at(line.end)], strokeOf(line.strokeWidth))
  }
  for (const arc of prims.arcs) {
    w.strokePolyline(
      arcThroughPoints(at(arc.start), at(arc.mid), at(arc.end)),
      strokeOf(arc.strokeWidth)
    )
  }
  for (const circle of prims.circles) {
    const c = at(circle.center)
    const edge = at(circle.end)
    const radius = Math.hypot(edge.x - c.x, edge.y - c.y)
    if (radius <= 0) continue
    const ring = tessellateArc(c.x, c.y, radius, 0, TAU)
    // A filled circle is a disc plus its outline; an unfilled one is the ring
    // the outline traces, which is what the stroke already is.
    if (isSolidFill(circle.fill)) w.region(ring.slice(0, -1))
    w.strokePolyline(ring, strokeOf(circle.strokeWidth))
  }
  for (const rect of prims.rects) {
    const corners = [
      at({ x: rect.start.x, y: rect.start.y }),
      at({ x: rect.end.x, y: rect.start.y }),
      at({ x: rect.end.x, y: rect.end.y }),
      at({ x: rect.start.x, y: rect.end.y })
    ]
    if (isSolidFill(rect.fill)) w.region(corners)
    w.strokePolyline([...corners, corners[0]], strokeOf(rect.strokeWidth))
  }
  for (const poly of prims.polys) {
    const points = poly.points.map(at)
    if (points.length < 2) continue
    if (isSolidFill(poly.fill) && points.length >= 3) w.region(points)
    w.strokePolyline([...points, points[0]], strokeOf(poly.strokeWidth))
  }
}

/**
 * Plot one pad onto a layer: a standard-aperture flash where one draws it
 * exactly (fast, and what fabs expect for axis-aligned pads), else its outline
 * as G36 regions (`padOutline`). `margin` (domain nm, per axis) grows or
 * shrinks the pad — 0 for copper, the mask or paste margin for those layers.
 * `aperFunction` tags copper apertures with their X2 role.
 */
function plotPad(
  w: Writer,
  pad: KicadPad,
  center: Pt,
  angleDeg: number,
  margin: { x: number; y: number },
  aperFunction: string | undefined
): void {
  // A custom pad is its own union of shapes, not one outline.
  if (pad.shape === 'custom') {
    plotCustomPad(w, pad, center, angleDeg, margin.x)
    return
  }
  const pw = nmToMm(nm(pad.size.w + 2 * margin.x))
  const ph = nmToMm(nm(pad.size.h + 2 * margin.y))
  const cut = isCutPad(pad)
  if (!cut && (pw <= 0 || ph <= 0)) return
  if (pad.shape === 'circle') {
    w.flash(w.circleAperture(pw, aperFunction), center)
    return
  }
  const roundedRect = pad.shape === 'rect' && margin.x > 0
  if (
    !cut &&
    !roundedRect &&
    (pad.shape === 'rect' || pad.shape === 'oval') &&
    isAxisAligned(angleDeg)
  ) {
    const [fw, fh] = isQuarterTurn(angleDeg) ? [ph, pw] : [pw, ph]
    if (pad.shape === 'rect') w.flash(w.rectAperture(fw, fh, aperFunction), center)
    else w.flash(w.obroundAperture(fw, fh, aperFunction), center)
    return
  }
  for (const ring of padOutline(pad, center, angleDeg, margin)) w.region(ring)
}

/** A trapezoid with a delta, or a rectangle with chamfered corners: a pad no aperture draws. */
const isCutPad = (pad: KicadPad): boolean =>
  (pad.shape === 'trapezoid' &&
    !!pad.rectDelta &&
    (pad.rectDelta.x !== 0 || pad.rectDelta.y !== 0)) ||
  ((pad.shape === 'rect' || pad.shape === 'roundrect') && !!pad.chamfer?.length)

/**
 * A non-custom pad's outline grown or shrunk by `margin` (domain nm, per
 * axis), shape by shape as KiCad's `PlotStandardLayer` grows it: a rectangle
 * grown gets corners rounded by the margin; a rounded rectangle's radius moves
 * with an even margin and keeps its ratio under an uneven one; a trapezoid,
 * or a chamfered pad grown evenly, is its polygon grown with rounded corners;
 * a chamfered pad otherwise is re-chamfered at the new size. Only an oval or
 * rectangle takes a margin per axis; the rest take its x. World mm rings.
 */
function padOutline(
  pad: KicadPad,
  center: Pt,
  angleDeg: number,
  margin: { x: number; y: number }
): Pt[][] {
  const pw = nmToMm(nm(pad.size.w + 2 * margin.x))
  const ph = nmToMm(nm(pad.size.h + 2 * margin.y))
  const grow = nmToMm(nm(margin.x))
  const sameXY = margin.x === margin.y
  if (isCutPad(pad)) {
    const chamfered = pad.shape !== 'trapezoid'
    if (chamfered && !(margin.x > 0 && sameXY)) {
      const size = { w: nm(pad.size.w + 2 * margin.x), h: nm(pad.size.h + 2 * margin.y) }
      const outline = pw > 0 && ph > 0 ? cutPadOutline({ ...pad, size }, center) : null
      return outline ? [outline] : []
    }
    const outline = cutPadOutline(pad, center)
    if (!outline) return []
    if (grow === 0) return [outline]
    return offset([{ outer: outline, holes: [] }], grow, { join: 'round' }).map(singleContour)
  }
  if (pw <= 0 || ph <= 0) return []
  if (pad.shape === 'circle')
    return [tessellateArc(center.x, center.y, pw / 2, 0, TAU).slice(0, -1)]
  let local: Pt[]
  if (pad.shape === 'roundrect') {
    const ratio = pad.roundrectRatio ?? 0.25
    const own = nmToMm(nm(Math.min(pad.size.w, pad.size.h))) * ratio
    const r = sameXY ? Math.max(0, own + grow) : Math.min(pw, ph) * ratio
    local = roundRectLocalOutline(pw / 2, ph / 2, r)
  } else if (pad.shape === 'oval') {
    local = obroundLocalOutline(pw, ph)
  } else {
    // A rectangle, rounded by its margin when grown; a trapezoid with no
    // `(rect_delta …)` is its rectangle.
    local = roundRectLocalOutline(pw / 2, ph / 2, pad.shape === 'rect' && margin.x > 0 ? grow : 0)
  }
  const cos = Math.cos((angleDeg * Math.PI) / 180)
  const sin = Math.sin((angleDeg * Math.PI) / 180)
  return [local.map((p) => padLocalMm(center, cos, sin, p.x, p.y))]
}

/**
 * The polygon outline of a trapezoid or chamfered pad at its own size (world
 * mm, centered on its copper), as the board's geometry draws it; null when
 * the pad's shape is not a polygon.
 */
function cutPadOutline(pad: KicadPad, center: Pt): Pt[] | null {
  // `padShape` places from the hole; `center` already is the copper's.
  const shape = padShape({ ...pad, drill: undefined }, center)
  return shape.kind === 'poly' && shape.rings[0] ? [...shape.rings[0]] : null
}

// ---------------------------------------------------------------------------
// Layer classification
// ---------------------------------------------------------------------------

/** Does a pad's layer list touch `layer` (resolving the wildcards)? */

/**
 * Copper layers of the board, front→back, for FileFunction L-numbering. The
 * layer table is in stack order; its ids are not since KiCad 9 (B.Cu is 2).
 */
function copperLayerOrder(board: KicadBoard): string[] {
  const copper = board.layers.filter((l) => l.name.endsWith('.Cu')).map((l) => l.name)
  return copper.length ? copper : ['F.Cu', 'B.Cu']
}

/** Expand a via's layer span to the concrete copper layers it crosses. */
function viaCopperLayers(via: KicadVia, copper: string[]): string[] {
  // A through via lists its outer layers; treat [F.Cu, B.Cu] as spanning all.
  if (via.layers.length >= 2) {
    const a = copper.indexOf(via.layers[0])
    const b = copper.indexOf(via.layers[via.layers.length - 1])
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      return copper.slice(lo, hi + 1)
    }
  }
  return via.layers.filter((l) => copper.includes(l))
}

// ---------------------------------------------------------------------------
// FileFunction attribute values
// ---------------------------------------------------------------------------

function fileFunctionFor(layer: string, copper: string[]): string | null {
  if (layer.endsWith('.Cu')) {
    const idx = copper.indexOf(layer)
    const n = idx >= 0 ? idx + 1 : layer === 'B.Cu' ? copper.length : 1
    const side = layer === 'F.Cu' ? 'Top' : layer === 'B.Cu' ? 'Bot' : 'Inr'
    return `Copper,L${n},${side}`
  }
  if (layer === 'F.Mask') return 'Soldermask,Top'
  if (layer === 'B.Mask') return 'Soldermask,Bot'
  if (layer === 'F.Paste') return 'Paste,Top'
  if (layer === 'B.Paste') return 'Paste,Bot'
  if (layer === 'F.SilkS') return 'Legend,Top'
  if (layer === 'B.SilkS') return 'Legend,Bot'
  if (layer === 'Edge.Cuts') return 'Profile,NP'
  if (layer === 'F.Fab') return 'AssemblyDrawing,Top'
  if (layer === 'B.Fab') return 'AssemblyDrawing,Bot'
  return null
}

// ---------------------------------------------------------------------------
// Per-category plotting
// ---------------------------------------------------------------------------

/** `DEFAULT_LINE_WIDTH` (board_design_settings.h), mm. */
const KICAD_DEFAULT_LINE_WIDTH = 0.1
const DEFAULT_SILK_WIDTH = 0.12
const DEFAULT_GRAPHIC_WIDTH = 0.1

/**
 * Where graphics land: the `Writer` for direct output, or a collector when
 * the geometry needs a boolean pass (silk clipping) before it is emitted.
 */
interface GraphicsSink {
  strokePolyline(points: Pt[], width: number, aperFunction?: string): void
  region(points: Pt[]): void
}

/** Plot a footprint graphic line on the target layer. */
/**
 * A stroke in its line style: solid as one polyline, else the dashes KiCad's
 * plotter draws (`STROKE_PARAMS::Stroke`, through `dashPath`) — restarting the
 * pattern at each vertex of a straight-edged shape, running on round an arc.
 */
function plotStyledStroke(
  w: GraphicsSink,
  points: Pt[],
  width: number,
  style: string | undefined,
  restartEachSegment: boolean
): void {
  // KiCad reads a stroke of no width on an unfilled shape as its 0.1 mm default line.
  if (!(width > 0)) width = KICAD_DEFAULT_LINE_WIDTH
  const pattern = strokeDashPattern(style, width)
  if (!pattern) {
    w.strokePolyline(points, width)
    return
  }
  for (const [a, b] of dashPath(points, pattern, restartEachSegment))
    w.strokePolyline([a, b], width)
}

function plotFpLine(w: GraphicsSink, tf: FpTransform, line: KicadFpLine): void {
  plotStyledStroke(
    w,
    [tfPoint(tf, line.start.x, line.start.y), tfPoint(tf, line.end.x, line.end.y)],
    line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : DEFAULT_SILK_WIDTH,
    line.strokeType,
    true
  )
}

function plotFpArc(w: GraphicsSink, tf: FpTransform, arc: KicadFpArc): void {
  const a = tfPoint(tf, arc.start.x, arc.start.y)
  const m = tfPoint(tf, arc.mid.x, arc.mid.y)
  const b = tfPoint(tf, arc.end.x, arc.end.y)
  plotStyledStroke(
    w,
    arcThroughPoints(a, m, b),
    arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : DEFAULT_SILK_WIDTH,
    arc.strokeType,
    false
  )
}

/**
 * A closed graphic: its fill when filled, then its outline stroked, as KiCad
 * plots it — a filled shape's stroke widens it by half the width all round.
 * A filled shape with no stroke width given has no outline; an unfilled one
 * falls back to `defaultWidth`. A dashed outline is drawn alone, unfilled, as
 * KiCad's plotter draws it (`BRDITEMS_PLOTTER::PlotShape`). `round` is a
 * circle's outline, whose dashes run on round it.
 */
function plotClosedShape(
  w: GraphicsSink,
  outline: Pt[],
  shape: { fill?: string; strokeWidth?: Nm; strokeType?: string },
  defaultWidth: number,
  round = false
): void {
  const filled = isSolidFill(shape.fill)
  const width =
    shape.strokeWidth !== undefined ? nmToMm(shape.strokeWidth) : filled ? 0 : defaultWidth
  const dashed = strokeDashPattern(shape.strokeType, width) !== null
  if (filled && !dashed && outline.length >= 3) w.region(outline)
  if (width > 0 && outline.length >= 2)
    plotStyledStroke(w, [...outline, outline[0]], width, shape.strokeType, !round)
}

function plotFpCircle(w: GraphicsSink, tf: FpTransform, circle: KicadFpCircle): void {
  const c = tfPoint(tf, circle.center.x, circle.center.y)
  const e = tfPoint(tf, circle.end.x, circle.end.y)
  const r = Math.hypot(e.x - c.x, e.y - c.y)
  if (r < 1e-6) return
  const outline = tessellateArc(c.x, c.y, r, 0, TAU).slice(0, -1)
  plotClosedShape(w, outline, circle, DEFAULT_SILK_WIDTH, true)
}

/**
 * A rectangle with KiCad 10's `(radius …)`: its outline with each corner a
 * quarter circle, built in the file's frame (nm, y down) and placed by `map`.
 */
function roundedRectOutline(rect: KicadFpRect, map: (x: Nm, y: Nm) => Pt): Pt[] {
  const r = rect.radius ?? 0
  const minX = Math.min(rect.start.x, rect.end.x)
  const maxX = Math.max(rect.start.x, rect.end.x)
  const minY = Math.min(rect.start.y, rect.end.y)
  const maxY = Math.max(rect.start.y, rect.end.y)
  const sag = 5000 // nm
  const steps = Math.max(2, Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - Math.min(sag / r, 1)))))
  const out: Pt[] = []
  const corners: Array<[number, number, number]> = [
    [maxX - r, minY + r, -Math.PI / 2],
    [maxX - r, maxY - r, 0],
    [minX + r, maxY - r, Math.PI / 2],
    [minX + r, minY + r, Math.PI]
  ]
  for (const [cx, cy, start] of corners)
    for (let i = 0; i <= steps; i++) {
      const t = start + ((Math.PI / 2) * i) / steps
      out.push(map(nm(cx + r * Math.cos(t)), nm(cy + r * Math.sin(t))))
    }
  return out
}

function plotFpRect(w: GraphicsSink, tf: FpTransform, rect: KicadFpRect): void {
  if (rect.radius) {
    const outline = roundedRectOutline(rect, (x, y) => tfPoint(tf, x, y))
    plotClosedShape(w, outline, rect, DEFAULT_SILK_WIDTH, true)
    return
  }
  const a = tfPoint(tf, rect.start.x, rect.start.y)
  const b = tfPoint(tf, rect.end.x, rect.end.y)
  // At a right angle KiCad turns the two stored corners and walks the outline
  // from them in board axes (`EDA_SHAPE::GetRectCorners`); a dash pattern
  // restarts at each corner, so the walk's start shows.
  const cardinal = Math.abs(tf.sin) < 1e-9 || Math.abs(tf.cos) < 1e-9
  const corners = cardinal
    ? [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
    : [a, tfPoint(tf, rect.end.x, rect.start.y), b, tfPoint(tf, rect.start.x, rect.end.y)]
  plotClosedShape(w, corners, rect, DEFAULT_SILK_WIDTH)
}

/** Plot every footprint graphic that sits on `layer`. */
function plotFootprintGraphics(w: GraphicsSink, bfp: KicadBoardFootprint, layer: string): void {
  const tf = footprintTransform(bfp)
  const fp = bfp.footprint
  for (const line of fp.fpLines) if (line.layer === layer) plotFpLine(w, tf, line)
  for (const arc of fp.fpArcs) if (arc.layer === layer) plotFpArc(w, tf, arc)
  for (const circle of fp.fpCircles) if (circle.layer === layer) plotFpCircle(w, tf, circle)
  for (const rect of fp.fpRects) if (rect.layer === layer) plotFpRect(w, tf, rect)
  for (const poly of fp.fpPolys) {
    if (poly.layer !== layer) continue
    const pts = poly.points.map((p) => tfPoint(tf, p.x, p.y))
    plotClosedShape(w, pts, poly, DEFAULT_SILK_WIDTH)
  }
}

/**
 * Plot a footprint's visible fields and texts on a layer, their `${…}`
 * resolved from the footprint — on whatever layer they sit, copper and mask
 * included, as KiCad's `PlotFootprintTextItems` plots them.
 */
function plotFootprintText(w: GraphicsSink, board: KicadBoard, fp: number, layer: string): void {
  const bfp = board.footprints[fp]
  const tf = footprintTransform(bfp)
  for (const prop of bfp.footprint.properties) {
    if (prop.hide || !prop.position || (prop.layer ?? 'F.SilkS') !== layer) continue
    const text = shownTextOf(board, prop.value, layer, fp, textScopeOf(board))
    const knockout = isKnockout(prop._raw)
    plotStrokeText(
      w,
      tf,
      text,
      prop.position,
      prop.keepUpright,
      prop.fontEffects,
      knockout,
      prop._raw
    )
  }
  for (const item of bfp.footprint.fpTexts) {
    if (item.hide || !item.position || (item.layer ?? 'F.SilkS') !== layer) continue
    const text = shownTextOf(board, item.text, layer, fp, textScopeOf(board))
    const knockout = isKnockout(item._raw)
    plotStrokeText(
      w,
      tf,
      text,
      item.position,
      item.keepUpright,
      item.fontEffects,
      knockout,
      item._raw
    )
  }
}

/**
 * Plot the graphics that draw from a layout rather than one shape — Béziers,
 * text boxes, tables and dimensions — on a layer, the board's and each
 * footprint's, as KiCad's plotter does (points it never plots). A footprint's
 * are footprint-local with their text angles relative to the part; its
 * dimensions are in board coordinates, as every dimension is.
 */
function plotLayoutGraphics(w: GraphicsSink, board: KicadBoard, layer: string): void {
  const worldTf: FpTransform = { tx: 0, ty: 0, cos: 1, sin: 0 }
  const draw = (item: KicadExtraGraphic, tf: FpTransform, angleOffset: number): void => {
    if ((item.layer ?? 'F.SilkS') !== layer || extraGraphicKind(item) === 'point') return
    const drawing = extraGraphicDrawing(item)
    const at = (p: { x: number; y: number }): Pt => tfPoint(tf, nm(p.x), nm(p.y))
    for (const stroke of drawing.strokes) {
      const points = stroke.points.map(at)
      if (points.length < 2 || stroke.width <= 0) continue
      w.strokePolyline(stroke.closed ? [...points, points[0]] : points, nmToMm(nm(stroke.width)))
    }
    for (const text of drawing.texts) {
      const position = {
        x: nm(text.anchor.x),
        y: nm(text.anchor.y),
        angle: text.angle + angleOffset
      }
      plotStrokeText(w, tf, text.text, position, false, text.effects)
    }
  }
  for (const item of [...board.grCurves, ...board.grTextBoxes, ...board.tables])
    draw(item, worldTf, 0)
  for (const dim of board.dimensions) plotDimension(w, dim, layer)
  for (const bfp of board.footprints) {
    const tf = footprintTransform(bfp)
    const fp = bfp.footprint
    for (const item of [...fp.fpCurves, ...fp.fpTextBoxes, ...fp.tables])
      draw(item, tf, bfp.position.angle ?? 0)
    for (const dim of fp.dimensions) plotDimension(w, dim, layer)
  }
}

/** A dimension's lines (`dimensionGeometry`, which DRC measures too) and its text. */
function plotDimension(w: GraphicsSink, dim: KicadDimension, layer: string): void {
  if ((dim.layer ?? 'Dwgs.User') !== layer) return
  const width = dim.style?.thickness !== undefined ? nmToMm(dim.style.thickness) : 0.2
  const at = (p: { x: number; y: number }): Pt => worldPoint({ x: nm(p.x), y: nm(p.y) })
  const { lines, circles } = dimensionGeometry(dim)
  for (const { a, b } of lines) w.strokePolyline([at(a), at(b)], width)
  for (const { center, radius } of circles) {
    const c = at(center)
    w.strokePolyline(tessellateArc(c.x, c.y, nmToMm(nm(radius)), 0, TAU), width)
  }
  const text = dim.text
  if (text?.position && (text.layer ?? layer) === layer) {
    const worldTf: FpTransform = { tx: 0, ty: 0, cos: 1, sin: 0 }
    plotStrokeText(w, worldTf, text.text, text.position, false, text.fontEffects)
  }
}

/** Plot the board's own texts on a layer. */
function plotBoardTexts(w: GraphicsSink, board: KicadBoard, layer: string): void {
  // Board texts are in absolute world coords; the identity transform (cos 1,
  // sin 0) with tfPoint maps (x, y) → (x, −y).
  const worldTf: FpTransform = { tx: 0, ty: 0, cos: 1, sin: 0 }
  for (const text of board.grTexts) {
    if (text.hide || (text.layer ?? '') !== layer || !text.position) continue
    // `keepUpright: false` — a board-level text has no parent footprint, and
    // KiCad plots it literally: probed, a `(gr_text …)` at 180 comes back R→L.
    const shown = shownTextOf(board, text.text, layer, undefined, textScopeOf(board))
    const knockout = isKnockout(text._raw)
    plotStrokeText(w, worldTf, shown, text.position, false, text.fontEffects, knockout, text._raw)
  }
}

/**
 * What a board's text resolves `${NAME}` from beyond the board itself: the
 * project's variables the caller passed (`GerberWriteOptions.textVariables`),
 * held per board for the layer being written so every text path reads them.
 */
const textScopes = new WeakMap<KicadBoard, TextScope>()
const textScopeOf = (board: KicadBoard): TextScope => textScopes.get(board) ?? { variables: {} }

/**
 * Render a text string as stroke-font draws on the current layer. `position` is
 * footprint-local; the stroke layout is placed relative to the KiCad anchor then
 * transformed to Gerber world space. A text in a TrueType face plots from the
 * glyph outlines KiCad saved with it (`render_cache`), when they are still for
 * this text at this angle, as KiCad plots one whose face it does not have; with
 * none it falls back to the stroke font. `raw` is the text's file node.
 */
function plotStrokeText(
  w: GraphicsSink,
  tf: FpTransform,
  text: string,
  position: { x: Nm; y: Nm; angle?: number },
  keepUpright: boolean,
  fontEffects: FontEffectsLike | undefined,
  knockout = false,
  raw?: SExprNode
): void {
  if (!text) return
  const opts = strokeOptionsFromEffects(fontEffects)
  const thickness = opts.thickness || DEFAULT_SILK_WIDTH
  // The stroke layout is in the text's own frame (y-up already, relative to the
  // anchor). The text angle rotates that frame; then the footprint transform
  // places it. KiCad text angle is absolute (includes footprint rotation) and
  // plots through the keep-upright fold.
  const angle = footprintTextDrawAngle(position.angle, keepUpright)
  const angleRad = (angle * Math.PI) / 180
  const tcos = Math.cos(angleRad)
  const tsin = Math.sin(angleRad)
  const anchor = tfPoint(tf, position.x, position.y)
  // Stroke coords are y-up in the text frame; rotate by the text angle and
  // translate to the anchor. Because the layout is already y-up but the
  // footprint transform expects y-down local input, place directly in world.
  const place = (x: number, y: number): Pt => ({
    x: anchor.x + x * tcos - y * tsin,
    y: anchor.y + x * tsin + y * tcos
  })
  // A world point back in the text's frame, for the knockout box.
  const unplace = (p: Pt): Pt => {
    const dx = p.x - anchor.x
    const dy = p.y - anchor.y
    return { x: dx * tcos + dy * tsin, y: -dx * tsin + dy * tcos }
  }
  const knockoutMargin = Math.max(thickness / 2, opts.height / 9)
  // Only a TrueType text carries a cache.
  const cached = raw ? renderCacheGlyphs(raw, text, angle) : null
  if (cached) {
    if (knockout) plotKnockout(w, cached, knockoutMargin, place, unplace)
    else for (const region of cached) w.region(singleContour(region))
    return
  }
  const layout = getTextStrokes(text, opts)
  if (knockout && layout.strokes.length > 0) {
    const glyphs = layout.strokes.map((s) => ({
      outer: capsuleOutline(place(s.x1, s.y1), place(s.x2, s.y2), thickness / 2),
      holes: []
    }))
    plotKnockout(w, glyphs, knockoutMargin, place, unplace)
    return
  }
  for (const s of layout.strokes)
    w.strokePolyline([place(s.x1, s.y1), place(s.x2, s.y2)], thickness)
}

/**
 * A TrueType text's saved glyph outlines (`(render_cache "text" angle (polygon
 * (pts …) (pts …)…)…)`: an outline, then its holes), in world mm — or null
 * when there are none, or they were saved for other text or another angle
 * (KiCad's `EDA_TEXT::GetRenderCache` check).
 */
function renderCacheGlyphs(raw: SExprNode, text: string, angle: number): ClipRegion[] | null {
  if (raw.type !== 'list') return null
  const cache = findChild(raw, 'render_cache')
  if (!cache) return null
  const [cachedText, cachedAngle] = getAtomValues(cache)
  const turn = (a: number): number => ((a % 360) + 360) % 360
  if (cachedText !== text || Math.abs(turn(parseFloat(cachedAngle ?? '0')) - turn(angle)) > 1e-6)
    return null
  const glyphs: ClipRegion[] = []
  for (const polygon of findChildren(cache, 'polygon')) {
    const rings = findChildren(polygon, 'pts').map((pts) => parsePointList(pts).map(worldPoint))
    if (rings[0] && rings[0].length >= 3) glyphs.push({ outer: rings[0], holes: rings.slice(1) })
  }
  return glyphs.length ? glyphs : null
}

/**
 * Knockout text, as KiCad's `PCB_TEXT::TransformTextToPolySet` builds it: the
 * glyphs' box in the text's own frame, grown by `GetKnockoutTextMargin` (half
 * the pen, or a ninth of the height if more), turned back, with the glyphs cut
 * out of it.
 */
function plotKnockout(
  w: GraphicsSink,
  glyphs: ClipRegion[],
  margin: number,
  place: (x: number, y: number) => Pt,
  unplace: (p: Pt) => Pt
): void {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const glyph of glyphs)
    for (const p of glyph.outer) {
      const q = unplace(p)
      minX = Math.min(minX, q.x)
      maxX = Math.max(maxX, q.x)
      minY = Math.min(minY, q.y)
      maxY = Math.max(maxY, q.y)
    }
  const box = [
    place(minX - margin, minY - margin),
    place(maxX + margin, minY - margin),
    place(maxX + margin, maxY + margin),
    place(minX - margin, maxY + margin)
  ]
  for (const region of difference([{ outer: box, holes: [] }], merged(glyphs)))
    w.region(singleContour(region))
}

/** Whether a text's file node marks it knockout: `(layer "F.SilkS" knockout)`. */
const isKnockout = (raw: SExprNode): boolean => {
  if (raw.type !== 'list') return false
  const layer = findChild(raw, 'layer')
  return !!layer && getAtomValues(layer).includes('knockout')
}

// ---------------------------------------------------------------------------
// Board-level graphics (segments, arcs, gr_* on a layer)
// ---------------------------------------------------------------------------

function plotTracks(w: Writer, board: KicadBoard, layer: string): void {
  const aper = 'Conductor'
  for (const seg of board.segments as KicadTrackSegment[]) {
    if (seg.layer !== layer) continue
    w.strokePolyline([worldPoint(seg.start), worldPoint(seg.end)], nmToMm(seg.width), aper)
  }
  for (const arc of board.trackArcs as KicadTrackArc[]) {
    if (arc.layer !== layer) continue
    const pts = arcThroughPoints(worldPoint(arc.start), worldPoint(arc.mid), worldPoint(arc.end))
    w.strokePolyline(pts, nmToMm(arc.width), aper)
  }
}

/**
 * The tracks a mask layer opens over: those the file marks as exposed on
 * that side (`(layers "F.Cu" "F.Mask")`), grown by their mask margin.
 */
function plotMaskedTracks(w: GraphicsSink, board: KicadBoard, maskLayer: string): void {
  const copper = maskLayer === 'B.Mask' ? 'B.Cu' : 'F.Cu'
  for (const track of [...board.segments, ...board.trackArcs] as Array<
    KicadTrackSegment | KicadTrackArc
  >) {
    if (track.layer !== copper) continue
    const margin = trackMaskMargin(board, track)
    if (margin === null) continue
    const width = nmToMm(nm(track.width + 2 * margin))
    if (width <= 0) continue
    const points =
      'mid' in track
        ? arcThroughPoints(worldPoint(track.start), worldPoint(track.mid), worldPoint(track.end))
        : [worldPoint(track.start), worldPoint(track.end)]
    w.strokePolyline(points, width)
  }
}

/**
 * A zone's fill on a layer other than copper — a mask opening, a stencil
 * window, a silk area drawn as a zone — as KiCad plots every zone on its layers.
 */
function plotLayerZones(w: GraphicsSink, board: KicadBoard, layer: string): void {
  for (const zone of board.zones as KicadBoardZone[]) {
    if (zone.isKeepout) continue
    // `*.Mask` and the like name a side pair, beyond the copper tokens `resolveLayers` expands.
    if (!resolveLayers(zone.layers, board).some((l) => expandLayerToken(l).includes(layer)))
      continue
    for (const fill of zone.filledPolys)
      if ((fill.layer ?? layer) === layer) w.region(fill.points.map(worldPoint))
  }
}

/**
 * Which pads and vias leave a layer bare: those marked `remove_unused_layers`
 * (or a via's `start_end_only`) have a ring only where KiCad flashes one — the
 * spatial index's pad layers, `viaFlashedOn` for a via. Built once per board,
 * and only for a board that marks any.
 */
interface FlashPlan {
  /** A pruned pad's copper layers, by `footprint/pad` index. */
  padLayers: Map<string, readonly string[]>
  viaFlashed: (via: number, layer: string) => boolean
}

const flashPlans = new WeakMap<KicadBoard, FlashPlan | null>()

function flashPlan(board: KicadBoard): FlashPlan | null {
  if (flashPlans.has(board)) return flashPlans.get(board)!
  const marked = (raw: SExprNode): boolean =>
    raw.type === 'list' &&
    (parseFlag(raw, 'remove_unused_layers') || parseFlag(raw, 'start_end_only'))
  const any =
    board.vias.some((via) => marked(via._raw)) ||
    board.footprints.some((bfp) => bfp.footprint.pads.some((pad) => marked(pad._raw)))
  if (!any) {
    flashPlans.set(board, null)
    return null
  }
  const index = BoardSpatialIndex.build(board)
  const copper = copperLayerOrder(board)
  const padLayers = new Map<string, readonly string[]>()
  const viaItems = new Map<number, CopperItem>()
  for (const item of index.items) {
    if (item.ref.type === 'via') viaItems.set(item.ref.index, item)
    if (item.ref.type !== 'pad') continue
    const pad = board.footprints[item.ref.index].footprint.pads[item.ref.pad]
    if (marked(pad._raw)) padLayers.set(`${item.ref.index}/${item.ref.pad}`, item.layers)
  }
  // A plated pad's hole passes every copper layer, so a via joined to it flashes on all.
  const layersOf = (item: CopperItem): readonly string[] =>
    item.ref.type === 'pad' &&
    board.footprints[item.ref.index].footprint.pads[item.ref.pad].type === 'thru_hole'
      ? copper
      : item.layers
  const plan: FlashPlan = {
    padLayers,
    viaFlashed: (via, layer) => {
      const item = viaItems.get(via)
      return !item || viaFlashedOn(board, index, item, layer, layersOf)
    }
  }
  flashPlans.set(board, plan)
  return plan
}

function plotVias(w: Writer, board: KicadBoard, layer: string, copper: string[]): void {
  const plan = flashPlan(board)
  for (const [i, via] of (board.vias as KicadVia[]).entries()) {
    if (!viaCopperLayers(via, copper).includes(layer)) continue
    if (plan && !plan.viaFlashed(i, layer)) continue
    // A padstack via has its own size per layer; none at all where it is 0.
    const size = viaSizeOn(via, layer)
    if (size <= 0) continue
    w.flash(w.circleAperture(nmToMm(size), 'ViaPad'), worldPoint(via.position))
  }
}

function plotZones(w: Writer, board: KicadBoard, layer: string): void {
  for (const zone of board.zones as KicadBoardZone[]) {
    if (zone.isKeepout) continue
    if (!resolveLayers(zone.layers, board).includes(layer)) continue
    const fills = zone.filledPolys.filter((f) => (f.layer ?? layer) === layer)
    if (fills.length === 0) {
      w.warn(`Zone on ${layer} has no computed fill — recompute pours before export`)
      continue
    }
    for (const fill of fills) w.region(fill.points.map(worldPoint))
  }
}

/**
 * The board's alignment targets (`(target plus|x …)`) on a layer, as KiCad's
 * `PlotPcbTarget` draws one: a circle a third of its size across (half, for
 * an x) and a cross of its full size. The board model does not read them, so
 * they come from the file.
 */
function plotTargets(w: GraphicsSink, board: KicadBoard, layer: string): void {
  if (board._raw.type !== 'list') return
  const childValue = (node: SExprList, token: string): string | undefined => {
    const child = findChild(node, token)
    return child ? getFirstAtomValue(child) : undefined
  }
  for (const node of findChildren(board._raw, 'target')) {
    if (childValue(node, 'layer') !== layer) continue
    const at = findChild(node, 'at')
    const atoms = at ? getAtomValues(at) : []
    if (atoms.length < 2) continue
    const c = worldPoint({ x: mmAtomToNm(atoms[0]), y: mmAtomToNm(atoms[1]) })
    const size = nmToMm(mmAtomToNm(childValue(node, 'size') ?? '5'))
    const width = nmToMm(mmAtomToNm(childValue(node, 'width') ?? '0.15'))
    const x = getAtomValues(node)[0] === 'x'
    const ring = tessellateArc(c.x, c.y, x ? size / 2 : size / 3, 0, TAU)
    w.strokePolyline(ring, width)
    const r = size / 2
    const arms: Array<[number, number, number, number]> = x
      ? [
          [-r, -r, r, r],
          [-r, r, r, -r]
        ]
      : [
          [-r, 0, r, 0],
          [0, -r, 0, r]
        ]
    for (const [x0, y0, x1, y1] of arms)
      w.strokePolyline(
        [
          { x: c.x + x0, y: c.y + y0 },
          { x: c.x + x1, y: c.y + y1 }
        ],
        width
      )
  }
}

/** Plot board-level gr_* graphics that sit on `layer` (edge cuts, silk notes). */
function plotBoardGraphics(w: GraphicsSink, board: KicadBoard, layer: string): void {
  plotTargets(w, board, layer)
  for (const line of board.grLines) {
    if ((line.layer ?? '') !== layer) continue
    plotStyledStroke(
      w,
      [worldPoint(line.start), worldPoint(line.end)],
      line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : DEFAULT_GRAPHIC_WIDTH,
      line.strokeType,
      true
    )
  }
  for (const arc of board.grArcs) {
    if ((arc.layer ?? '') !== layer) continue
    plotStyledStroke(
      w,
      arcThroughPoints(worldPoint(arc.start), worldPoint(arc.mid), worldPoint(arc.end)),
      arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : DEFAULT_GRAPHIC_WIDTH,
      arc.strokeType,
      false
    )
  }
  for (const circle of board.grCircles) {
    if ((circle.layer ?? '') !== layer) continue
    const c = worldPoint(circle.center)
    const e = worldPoint(circle.end)
    const r = Math.hypot(e.x - c.x, e.y - c.y)
    if (r < 1e-6) continue
    const outline = tessellateArc(c.x, c.y, r, 0, TAU).slice(0, -1)
    plotClosedShape(w, outline, circle, DEFAULT_GRAPHIC_WIDTH, true)
  }
  for (const rect of board.grRects) {
    if ((rect.layer ?? '') !== layer) continue
    if (rect.radius) {
      const outline = roundedRectOutline(rect, (x, y) => worldPoint({ x, y }))
      plotClosedShape(w, outline, rect, DEFAULT_GRAPHIC_WIDTH, true)
      continue
    }
    const p0 = worldPoint({ x: rect.start.x, y: rect.start.y })
    const p1 = worldPoint({ x: rect.end.x, y: rect.start.y })
    const p2 = worldPoint({ x: rect.end.x, y: rect.end.y })
    const p3 = worldPoint({ x: rect.start.x, y: rect.end.y })
    plotClosedShape(w, [p0, p1, p2, p3], rect, DEFAULT_GRAPHIC_WIDTH)
  }
  for (const poly of board.grPolys) {
    if ((poly.layer ?? '') !== layer) continue
    plotClosedShape(w, poly.points.map(worldPoint), poly, DEFAULT_GRAPHIC_WIDTH)
  }
}

// ---------------------------------------------------------------------------
// Layer plot dispatch
// ---------------------------------------------------------------------------

/**
 * A non-plated pad its hole swallows has no copper, by either of KiCad's two
 * rules: `PAD::FlashLayer` (a round pad on a round hole, or an oval on a slot,
 * no larger than the hole and not offset from it) and the plotter's own skip
 * of a round or oval pad exactly its drill's size (`PlotStandardLayer`).
 */
function holeTakesPad(pad: KicadPad): boolean {
  const drill = pad.drill
  if (pad.type !== 'np_thru_hole' || !drill) return false
  const drillW = drill.oval?.width ?? drill.diameter
  const drillH = drill.oval?.height ?? drill.diameter
  if (
    (pad.shape === 'circle' || pad.shape === 'oval') &&
    pad.size.w === drillW &&
    pad.size.h === drillH
  )
    return true
  if (drill.offset && (drill.offset.x !== 0 || drill.offset.y !== 0)) return false
  if (pad.shape === 'circle' && !drill.oval) return drill.diameter >= pad.size.w
  if (pad.shape === 'oval' && drill.oval)
    return drill.oval.width >= pad.size.w && drill.oval.height >= pad.size.h
  return false
}

/**
 * A pad as a layer plots it: its padstack's copper on that layer (a mask or
 * paste layer reads its own side's copper), centered where that copper sits —
 * the hole plus the drill offset, turned with the pad.
 */
function padOn(
  tf: FpTransform,
  pad: KicadPad,
  layer: string
): { pad: KicadPad; center: Pt; angle: number } {
  const copperLayer = layer.endsWith('.Cu') ? layer : layer.startsWith('B.') ? 'B.Cu' : 'F.Cu'
  // A padstack layer written with a size of no extent plots nothing there,
  // where the model reads a negative extent as the same rectangle.
  const key = pad.padstack ? padstackKey(pad.padstack.mode, copperLayer) : null
  const stored = key !== null ? pad.padstack?.layers[key]?.size : undefined
  const onLayer = padOnLayer(pad, copperLayer)
  if (stored && (stored.w <= 0 || stored.h <= 0)) {
    return {
      pad: { ...onLayer, size: { w: nm(0), h: nm(0) } },
      center: tfPoint(tf, pad.position.x, pad.position.y),
      angle: pad.position.angle ?? 0
    }
  }
  const angle = pad.position.angle ?? 0
  const hole = tfPoint(tf, pad.position.x, pad.position.y)
  return { pad: onLayer, center: padCopperCenter(onLayer, hole, (angle * Math.PI) / 180), angle }
}

function plotCopperLayer(w: Writer, board: KicadBoard, layer: string, copper: string[]): void {
  const plan = flashPlan(board)
  for (const [fp, bfp] of board.footprints.entries()) {
    const tf = footprintTransform(bfp)
    for (const [index, fpPad] of bfp.footprint.pads.entries()) {
      if (!padTouchesLayer(fpPad, layer)) continue
      const pruned = plan?.padLayers.get(`${fp}/${index}`)
      if (pruned && !pruned.includes(layer)) continue
      const { pad, center, angle } = padOn(tf, fpPad, layer)
      if (holeTakesPad(pad)) continue
      const aperFn = pad.type === 'smd' ? 'SMDPad,CuDef' : 'ComponentPad'
      plotPad(w, pad, center, angle, { x: 0, y: 0 }, aperFn)
    }
    plotFootprintGraphics(w, bfp, layer)
    plotFootprintText(w, board, fp, layer)
  }
  plotTracks(w, board, layer)
  plotVias(w, board, layer, copper)
  plotZones(w, board, layer)
  plotBoardGraphics(w, board, layer)
  plotBoardTexts(w, board, layer)
  plotLayoutGraphics(w, board, layer)
}

function plotMaskOrPaste(w: Writer, board: KicadBoard, layer: string): void {
  const paste = layer === 'F.Paste' || layer === 'B.Paste'
  board.footprints.forEach((bfp, fp) => {
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((fpPad, index) => {
      if (!padTouchesLayer(fpPad, layer)) return
      const { pad, center, angle } = padOn(tf, fpPad, layer)
      if (!paste) {
        // Domain nm, like every other margin here: `plotPad` converts.
        const margin = padMaskMargin(board, fp, index, layer)
        plotPad(w, pad, center, angle, { x: margin, y: margin }, undefined)
        return
      }
      // A paste margin can differ by axis (its ratio of each side).
      plotPad(w, pad, center, angle, padPasteMargin(board, fp, index, layer), undefined)
    })
    plotFootprintGraphics(w, bfp, layer)
    plotFootprintText(w, board, fp, layer)
  })
  // Vias open the mask only where they are not tented — the board default from
  // `(setup (tenting …))`, overridden per via. A tented via is the common case
  // and plots nothing, which is why this layer looked right for so long.
  if (!paste) {
    const side = layer === 'B.Mask' ? 'back' : 'front'
    const aper = 'ViaMask'
    for (const via of board.vias) {
      if (!viaMaskIsOpen(via, side, board.tenting)) continue
      const copperSize = viaSizeOn(via, side === 'back' ? 'B.Cu' : 'F.Cu')
      const diameter = nmToMm(nm(copperSize + 2 * viaMaskMargin(board)))
      if (diameter <= 0) continue
      w.flash(w.circleAperture(diameter, aper), worldPoint(via.position))
    }
    plotMaskedTracks(w, board, layer)
  }
  plotLayerZones(w, board, layer)
  plotBoardGraphics(w, board, layer)
  plotBoardTexts(w, board, layer)
  plotLayoutGraphics(w, board, layer)
}

function plotSilkLayer(w: GraphicsSink, board: KicadBoard, layer: string): void {
  for (const [fp, bfp] of board.footprints.entries()) {
    // A pad that lists this layer draws its shape on it, as KiCad plots it.
    const tf = footprintTransform(bfp)
    for (const fpPad of bfp.footprint.pads) {
      if (!padTouchesLayer(fpPad, layer)) continue
      const { pad, center, angle } = padOn(tf, fpPad, layer)
      if (pad.shape === 'custom') plotCustomPad(w, pad, center, angle, 0)
      else for (const ring of padOutline(pad, center, angle, { x: 0, y: 0 })) w.region(ring)
    }
    plotFootprintGraphics(w, bfp, layer)
    plotFootprintText(w, board, fp, layer)
  }
  plotBoardGraphics(w, board, layer)
  plotBoardTexts(w, board, layer)
  plotLayoutGraphics(w, board, layer)
  plotLayerZones(w, board, layer)
}

// ---------------------------------------------------------------------------
// Silkscreen clipping
// ---------------------------------------------------------------------------

/** One collected graphic, held back so a boolean pass can run before emit. */
type CollectedPrim =
  | { kind: 'stroke'; points: Pt[]; width: number; aperFunction?: string }
  | { kind: 'region'; points: Pt[] }

/** A `GraphicsSink` that records instead of writing. */
class Collector implements GraphicsSink {
  readonly prims: CollectedPrim[] = []

  strokePolyline(points: Pt[], width: number, aperFunction?: string): void {
    if (points.length >= 2) this.prims.push({ kind: 'stroke', points, width, aperFunction })
  }

  region(points: Pt[]): void {
    if (points.length >= 3) this.prims.push({ kind: 'region', points })
  }
}

/**
 * Everything the mask layer opens, as clip regions: pads that touch it (at
 * their mask margin) plus any graphics drawn directly on it.
 *
 * Exported for the 3D board, which subtracts the same openings from its silk
 * and mask meshes — one computation, so the preview and the plot agree.
 */
export function maskOpenings(board: KicadBoard, maskLayer: string): ClipRegion[] {
  const openings: ClipRegion[] = []
  // Custom pads have no single outline, so they go through the same collector
  // the mask graphics use, below — one shape per primitive.
  const collector = new Collector()
  board.footprints.forEach((bfp, fp) => {
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((fpPad, index) => {
      if (!padTouchesLayer(fpPad, maskLayer)) return
      const { pad, center, angle } = padOn(tf, fpPad, maskLayer)
      const margin = padMaskMargin(board, fp, index, maskLayer)
      if (pad.shape === 'custom') {
        plotCustomPad(collector, pad, center, angle, margin)
        return
      }
      for (const ring of padOutline(pad, center, angle, { x: margin, y: margin }))
        if (ring.length >= 3) openings.push({ outer: ring, holes: [] })
    })
  })
  // An untented via opens the mask like a pad does, so silk gets clipped off it
  // and the 3D board shows bare finish rather than green.
  const side = maskLayer === 'B.Mask' ? 'back' : 'front'
  for (const via of board.vias) {
    if (!viaMaskIsOpen(via, side, board.tenting)) continue
    const copperSize = viaSizeOn(via, side === 'back' ? 'B.Cu' : 'F.Cu')
    const radius = nmToMm(nm(copperSize + 2 * viaMaskMargin(board))) / 2
    if (radius <= 0) continue
    const p = worldPoint(via.position)
    const ring = tessellateArc(p.x, p.y, radius, 0, TAU).slice(0, -1)
    if (ring.length >= 3) openings.push({ outer: ring, holes: [] })
  }
  // Graphics on the mask layer are openings too. Collect them through the
  // same plot path the mask Gerber uses, then treat strokes as capsules.
  board.footprints.forEach((bfp, fp) => {
    plotFootprintGraphics(collector, bfp, maskLayer)
    plotFootprintText(collector, board, fp, maskLayer)
  })
  plotBoardGraphics(collector, board, maskLayer)
  plotBoardTexts(collector, board, maskLayer)
  plotLayoutGraphics(collector, board, maskLayer)
  plotMaskedTracks(collector, board, maskLayer)
  plotLayerZones(collector, board, maskLayer)
  return openings.concat(collectedRegions(collector.prims))
}

/**
 * A mask layer whose board sets a minimum web (`solder_mask_min_width`): the
 * openings grown by half the web, merged and shrunk back, so two openings
 * closer than the web join and the sliver between them is not left to peel —
 * then the exact openings added again, which the round trip may have nicked.
 * KiCad's `GenerateLayerPoly`.
 */
function plotHealedMask(w: Writer, board: KicadBoard, layer: string, web: number): void {
  const exact = maskOpenings(board, layer)
  // Less a nanometer, as KiCad takes it, so openings exactly a web apart stay apart.
  const half = web / 2 - 1e-6
  const grown = offset(exact, half, { join: 'round' })
  // KiCad's CHAMFER_ALL_CORNERS is Clipper's square join.
  const healed = offset(merged(grown), -half, { join: 'square' })
  for (const region of merged([...healed, ...exact])) w.region(singleContour(region))
}

/** Collected graphics as the areas they cover: regions as they are, strokes as capsules. */
function collectedRegions(prims: readonly CollectedPrim[]): ClipRegion[] {
  const out: ClipRegion[] = []
  for (const prim of prims) {
    if (prim.kind === 'region') {
      out.push({ outer: prim.points, holes: [] })
      continue
    }
    for (let i = 0; i + 1 < prim.points.length; i++) {
      const ring = capsuleOutline(prim.points[i], prim.points[i + 1], prim.width / 2)
      if (ring.length >= 3) out.push({ outer: ring, holes: [] })
    }
  }
  return out
}

/**
 * The clip stack for a silk layer under the given options, or `null` with a
 * reason when clipping was requested but cannot run.
 */
function buildSilkClips(
  board: KicadBoard,
  layer: string,
  options: GerberWriteOptions
): { clips: ShapeClip[]; warning?: string } {
  const wantMask = options.subtractMaskFromSilk ?? true
  const wantOutline = options.clipSilkToOutline ?? true
  if (!wantMask && !wantOutline) return { clips: [] }
  const clips: ShapeClip[] = []
  if (wantMask) {
    const openings = maskOpenings(board, layer === 'B.SilkS' ? 'B.Mask' : 'F.Mask')
    if (openings.length > 0) clips.push(new SubtractRegions(openings))
  }
  if (wantOutline) {
    const outline = buildBoardOutline(board)
    // Only a complete, closed outline is trusted to eat geometry — a fallback
    // box or half-closed sketch would clip real silk against a wrong border.
    if (!outline.fallback && outline.openCount === 0 && outline.regions.length > 0) {
      clips.push(new KeepWithinRegions(outline.regions))
    }
  }
  return { clips }
}

/**
 * Emit collected silk with the clip stack applied. Untouched graphics keep
 * their native form (stroked draws, plain regions) so the common output is
 * byte-identical to the unclipped writer; only graphics that actually meet a
 * mask opening or the board edge become boolean-clipped G36 regions.
 */
function emitClippedSilk(
  w: Writer,
  prims: readonly CollectedPrim[],
  clips: readonly ShapeClip[]
): void {
  for (const prim of prims) {
    if (prim.kind === 'region') {
      const replaced = applyShapeClips({ outer: prim.points, holes: [] }, clips)
      if (replaced === null) w.region(prim.points)
      else for (const region of replaced) w.region(singleContour(region))
      continue
    }
    // A stroke clips per segment; consecutive untouched segments re-chain so
    // the unclipped parts of a polyline still emit as one draw run.
    let run: Pt[] = []
    const flush = (): void => {
      if (run.length >= 2) w.strokePolyline(run, prim.width, prim.aperFunction)
      run = []
    }
    for (let i = 0; i + 1 < prim.points.length; i++) {
      const a = prim.points[i]
      const b = prim.points[i + 1]
      const capsule: ClipRegion = { outer: capsuleOutline(a, b, prim.width / 2), holes: [] }
      const replaced = capsule.outer.length >= 3 ? applyShapeClips(capsule, clips) : null
      if (replaced === null) {
        if (run.length === 0) run.push(a)
        run.push(b)
      } else {
        flush()
        for (const region of replaced) w.region(singleContour(region))
      }
    }
    flush()
  }
}

/** The outline: every graphic, board text and zone on Edge.Cuts — no footprint text, as KiCad skips it there. */
function plotEdgeCuts(w: Writer, board: KicadBoard): void {
  for (const bfp of board.footprints) plotFootprintGraphics(w, bfp, 'Edge.Cuts')
  plotBoardGraphics(w, board, 'Edge.Cuts')
  plotBoardTexts(w, board, 'Edge.Cuts')
  plotLayoutGraphics(w, board, 'Edge.Cuts')
  plotLayerZones(w, board, 'Edge.Cuts')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate the Gerber for one KiCad layer of the board. */
export function writeGerberLayer(
  board: KicadBoard,
  layer: string,
  options: GerberWriteOptions = {}
): GeneratedGerberLayer {
  const decimals = options.decimals ?? 6
  const w = new Writer(decimals)
  textScopes.set(board, { variables: options.textVariables ?? {} })
  const copper = copperLayerOrder(board)

  if (layer.endsWith('.Cu')) plotCopperLayer(w, board, layer, copper)
  else if (layer === 'F.Mask' || layer === 'B.Mask') {
    const web = nmToMm(maskSettings(board).webWidth)
    if (web > 0) plotHealedMask(w, board, layer, web)
    else plotMaskOrPaste(w, board, layer)
  } else if (layer === 'F.Paste' || layer === 'B.Paste') plotMaskOrPaste(w, board, layer)
  else if (layer === 'F.SilkS' || layer === 'B.SilkS') {
    const { clips, warning } = buildSilkClips(board, layer, options)
    if (warning) w.warn(warning)
    if (clips.length === 0) plotSilkLayer(w, board, layer)
    else {
      const collector = new Collector()
      plotSilkLayer(collector, board, layer)
      emitClippedSilk(w, collector.prims, clips)
    }
  } else if (layer === 'Edge.Cuts') plotEdgeCuts(w, board)
  else {
    // Fab/user layers: graphics + text only.
    plotSilkLayer(w, board, layer)
  }

  const fileFunction = fileFunctionFor(layer, copper)
  return {
    kicadLayer: layer,
    fileFunction,
    content: w.build(fileFunction, options.generationSoftware),
    warnings: w.warnings
  }
}

/** Generate every requested layer. Unknown/empty layers still produce a file. */
export function writeGerberSet(
  board: KicadBoard,
  layers: string[],
  options: GerberWriteOptions = {}
): GeneratedGerberLayer[] {
  return layers.map((layer) => writeGerberLayer(board, layer, options))
}
