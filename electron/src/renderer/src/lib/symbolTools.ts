// Symbol insert-tool geometry. Previews and inserted items share these values.
//
// Coordinates are the domain model's integer nanometers (`Nm`); angles stay
// plain degrees. Derived values that pass through trig, division or hypot are
// re-branded with `nm()` so every draft and committed point stays on the
// integer grid — which is also why the old write-boundary quantization is
// gone: integer nm needs no snap to match what the AST writer saves.

import type { KicadTextEffects, SymbolGraphic, SymbolPin, SymbolStroke } from './kicad/schematic'
import type { Rgba } from './kicad/color'
import { mmToNm, nm, NM_PER_MIL, pointsEqualNm, type Nm } from './kicad/coordinates'
import { gestureClick, gestureFinish, type ToolGesture } from './toolGesture'
import {
  mirrorAngle,
  mirrorPoint,
  normalizeAngle,
  rotatePoint,
  snapSymbolTextAngle,
  unrotateAbout,
  type MirrorAxis
} from './symbol/symbolEdit'
import { DEFAULT_TEXT_BOX_MARGIN_NM } from './schematic/textBox'

export type SymbolTool =
  | 'select'
  | 'pin'
  | 'rectangle'
  | 'line'
  | 'polygon'
  | 'circle'
  | 'arc'
  | 'bezier'
  | 'text'
  | 'textBox'
  // KiCad's Move Symbol Anchor: one click names the point that becomes the
  // symbol's origin. It places nothing, so it builds no items.
  | 'anchor'

/** Tools that place something; `select` is the ordinary pick/drag mode. */
export const INSERT_TOOLS: SymbolTool[] = [
  'pin',
  'rectangle',
  'line',
  'polygon',
  'circle',
  'arc',
  'bezier',
  'text',
  'textBox'
]

export interface Point2 {
  x: Nm
  y: Nm
}

const ZERO: Nm = 0 as Nm

/**
 * How many points a tool collects before it has something to commit, and
 * therefore what a click means while it is armed.
 *
 * - `drop` — one click, because the thing has no size to draw out: a pin is
 *   KiCad's fixed 100 mil and its length is a property, not a gesture, and a
 *   text's size is its font. Orient it with R/X/Y first if you want it turned.
 * - `span` — a fixed number of points, each click setting one: corner→corner for
 *   a rectangle, center→rim for a circle, start→end→bulge for an arc,
 *   start→end→handle→handle for a bezier. Ends before shape in both curves, so the
 *   thing being drawn is on screen before you bend it. KiCad's
 *   own, and the case that motivates the distinction — a body outline is always
 *   sized to the part. `toolPointCount` says how many.
 * - `chain` — a point per vertex, unbounded, because a body outline is usually
 *   several connected segments and a fixed count would mean re-arming for each
 *   one. Ends by clicking the last point placed, right-clicking, or
 *   double-clicking.
 *
 * Points come from clicks only, never a press-drag-release, as in KiCad: a
 * click made while the pointer is still moving must not read as a drag that
 * draws.
 *
 * The click/finish folding rules live in `toolGesture.ts`, shared with
 * the board editor's tools; this module maps each SymbolTool onto them.
 */
export type { ToolGesture } from './toolGesture'

export const toolGesture = (tool: SymbolTool): ToolGesture => {
  switch (tool) {
    // `textBox` spans like the rectangle it is shaped as — corner to corner. Its
    // text is a property, not a gesture.
    case 'rectangle':
    case 'circle':
    case 'arc':
    case 'bezier':
    case 'textBox':
      return 'span'
    case 'line':
    case 'polygon':
      return 'chain'
    // `select` places nothing; naming it a drop keeps this total without a
    // meaningless fourth case. The anchor is one click, like a pin.
    case 'pin':
    case 'text':
    case 'anchor':
    case 'select':
      return 'drop'
  }
}

/**
 * How many points the tool needs before it commits — `Infinity` for a chain,
 * which ends on a gesture rather than on a count.
 *
 * Separate from the gesture because it is the only thing that differs between a
 * rectangle and an arc: both set every point by clicking, one just needs a third.
 * Keeping the count out of the gesture name is what let the arc tool arrive
 * without a new branch in `toolClick`.
 */
export const toolPointCount = (tool: SymbolTool): number => {
  switch (toolGesture(tool)) {
    case 'drop':
      return 1
    case 'chain':
      return Infinity
    case 'span':
      // An arc is the three points it passes through; a bezier its four control
      // points; everything else spans two.
      if (tool === 'arc') return 3
      if (tool === 'bezier') return 4
      return 2
  }
}

/**
 * What a click or a drag does to the points a tool has collected. `commit` is
 * the chain to insert, or null while the tool is still gathering.
 */
export interface ToolClickResult {
  draft: Point2[]
  commit: Point2[] | null
}

/** Fold a click into an armed tool's draft. */
export function toolClick(tool: SymbolTool, draft: Point2[], point: Point2): ToolClickResult {
  if (tool === 'select') return { draft: [], commit: null }
  // A chain committed by clicking back on its start keeps the repeated point:
  // KiCad stores a closed symbol body as a polyline whose last point repeats
  // its first, which is exactly the shape gestureClick hands back.
  // Points are domain nm, so the same-spot test is the nm one.
  return polygonGuard(
    tool,
    gestureClick(toolGesture(tool), toolPointCount(tool), draft, point, pointsEqualNm)
  )
}

/**
 * A polygon is an area, so it needs three corners: a chain that ends with
 * fewer — a double-click after one segment — places nothing rather than a
 * closed out-and-back line.
 */
const polygonGuard = (tool: SymbolTool, result: ToolClickResult): ToolClickResult =>
  tool === 'polygon' && result.commit && polygonVertices(result.commit).length < 3
    ? { draft: [], commit: null }
    : result

/**
 * A chain's distinct corners: repeated clicks on one spot collapse, and a last
 * point back on the first is the closing edge, not a corner of its own.
 */
export const polygonVertices = (points: Point2[]): Point2[] => {
  const out: Point2[] = []
  for (const p of points) {
    if (!out.length || !pointsEqualNm(out[out.length - 1], p)) out.push(p)
  }
  if (out.length > 1 && pointsEqualNm(out[0], out[out.length - 1])) out.pop()
  return out
}

/**
 * The polyline a polygon is stored as: its corners, then the first again —
 * how KiCad writes a closed symbol body, and what its polygon tool closes a
 * shape into when it is finished. Two corners are still a draw in progress,
 * so they come back as the open segment, which is what the preview shows
 * before the third click. Null with nothing to draw.
 */
export const polygonFrom = (points: Point2[]): Point2[] | null => {
  const corners = polygonVertices(points).map((p) => ({ x: p.x, y: p.y }))
  if (corners.length < 2) return null
  return corners.length === 2 ? corners : [...corners, { ...corners[0] }]
}

/**
 * End a chain in progress without adding a point — what right-click does, the
 * wire tool's idiom. Anything else keeps its points, so the caller can tell
 * "finished" from "there was nothing to finish" and unwind a level instead.
 */
export function toolFinish(tool: SymbolTool, draft: Point2[]): ToolClickResult {
  if (tool === 'select') return { draft, commit: null }
  const result = gestureFinish(toolGesture(tool), draft)
  // Too few corners to close: keep them, so the right-click unwinds a level
  // (abandons the points) instead of committing nothing and claiming it did.
  return tool === 'polygon' && result.commit && polygonVertices(result.commit).length < 3
    ? { draft, commit: null }
    : result
}

/** Default pin length — KiCad's 100 mil (2.54 mm), the length a fresh pin is drawn at. */
export const PIN_LENGTH: Nm = nm(100 * NM_PER_MIL)

/**
 * Extent two points must span before they describe a shape at all — 0.01 mm.
 * Below it there is nothing to draw and nothing to insert — a span tool holds its
 * anchor and waits rather than substituting a default size.
 *
 * Well under the 1.27 mm symbol grid, so it can only ever catch a cursor still
 * sitting on the anchor: a real drag is at least one grid step.
 */
const MIN_SPAN = mmToNm(0.01)

/** Stroke every fresh graphic is drawn with — KiCad's 0.254 mm symbol default. */
const DEFAULT_STROKE = { width: mmToNm(0.254) }

const HIDDEN_TEXT: KicadTextEffects = {
  // KiCad's default 1.27 mm font.
  fontSize: { height: mmToNm(1.27), width: mmToNm(1.27) },
  bold: false,
  italic: false,
  lineSpacing: 1,
  horizontalAlign: 'center',
  verticalAlign: 'center',
  hidden: true
}

/** KiCad's 1.27 mm symbol text, visible — what a fresh text item is drawn with. */
const VISIBLE_TEXT: KicadTextEffects = { ...HIDDEN_TEXT, hidden: false }

/** The `(margins …)` a fresh text box carries when none are chosen: KiCad's 40 mil. */
const DEFAULT_TEXT_BOX_MARGINS_NM = {
  left: DEFAULT_TEXT_BOX_MARGIN_NM,
  top: DEFAULT_TEXT_BOX_MARGIN_NM,
  right: DEFAULT_TEXT_BOX_MARGIN_NM,
  bottom: DEFAULT_TEXT_BOX_MARGIN_NM
}

/**
 * The string a fresh text item carries. Deliberately **not** localized: it is
 * document content that gets written into the `.kicad_sym` and read by KiCad, not
 * UI copy — the same reason `addSymbol` scaffolds the literal `NewSymbol`. The
 * point of placing it is to type over it in the properties panel.
 */
const DEFAULT_TEXT = 'Text'

/**
 * What a tool places, minus where it places it.
 *
 * The split this whole module turns on is **what a thing IS versus where it
 * GOES**: a pin's electrical type, a rectangle's stroke and a text's string are
 * properties of the item, while its coordinates come from the clicks.
 *
 * Holding it here rather than in the editor is what lets the properties panel
 * show the PENDING item: the panel edits this, `toolTemplate` renders it, and
 * `toolItems` positions the same value. So what the panel says is about to land
 * is the thing that lands, by the same route the ghost is drawn.
 *
 * Everything is optional and merged over the defaults below, so a caller that
 * sets nothing gets those defaults untouched.
 */
export interface ToolDefaults {
  pin?: Partial<
    Pick<
      SymbolPin,
      | 'name'
      | 'number'
      | 'electricalType'
      | 'graphicStyle'
      | 'length'
      | 'hidden'
      // Name/number text size is a per-pin font, so it is a template setting
      // like the rest: choose it once, place the whole row with it.
      | 'nameEffects'
      | 'numberEffects'
    >
  >
  graphic?: {
    stroke?: Partial<SymbolStroke>
    fill?: string
    fillColor?: Rgba
  }
  text?: { text?: string; effects?: Partial<KicadTextEffects> }
  /**
   * Text-box-only settings. Just the margins: everything else a box carries is
   * already shared — its string and font come from `text`, its border and fill
   * from `graphic` — and duplicating those here would let the panel edit one
   * copy while the ghost drew the other.
   */
  textBox?: { margins?: Partial<{ left: Nm; top: Nm; right: Nm; bottom: Nm }> }
  /**
   * Place into the shared unit 0 rather than the gate being edited — KiCad's
   * "Common to all units in symbol", chosen before the click like every other
   * template setting. It carries no geometry, so `toolItems` ignores it; the
   * insert commands read it to pick the destination unit.
   */
  commonToAllUnits?: boolean
}

/**
 * A fresh pin, before the click says where its connection point is.
 *
 * **An unnamed pin is `''`, not `'~'`.** The tilde is the pre-v6 `.lib` spelling
 * of "no name" and KiCad has not written it since: a token census over the 222
 * standard libraries finds 0 occurrences of `(name "~")` against 6424 of
 * `(name "")`. `SchematicScene` still declines to draw a `~` because converted
 * old files carry it — reading it is right, emitting it is not.
 */
const templatePin = (defaults: ToolDefaults): SymbolPin => ({
  electricalType: 'passive',
  graphicStyle: 'line',
  name: '',
  number: '',
  nameEffects: HIDDEN_TEXT,
  numberEffects: HIDDEN_TEXT,
  position: { x: ZERO, y: ZERO, angle: 0 },
  length: PIN_LENGTH,
  hidden: false,
  // Never carried on a template: alternates are per-pin authoring, not a
  // default worth repeating onto the next pin you place.
  alternates: [],
  ...defaults.pin
})

/** Stroke + fill every fresh graphic carries, before its points are known. */
const templateStyle = (
  defaults: ToolDefaults
): { stroke: SymbolStroke; fill: string; fillColor?: Rgba } => ({
  stroke: { ...DEFAULT_STROKE, ...defaults.graphic?.stroke },
  fill: defaults.graphic?.fill ?? 'none',
  ...(defaults.graphic?.fillColor ? { fillColor: defaults.graphic.fillColor } : {})
})

const templateText = (defaults: ToolDefaults): Extract<SymbolGraphic, { type: 'text' }> => ({
  type: 'text',
  text: defaults.text?.text ?? DEFAULT_TEXT,
  position: { x: ZERO, y: ZERO, angle: 0 },
  effects: { ...VISIBLE_TEXT, ...defaults.text?.effects }
})

/**
 * A fresh text box. Shares `defaults.text` with the text tool deliberately: both
 * place a string, so a size or a weight chosen for one is the obvious starting
 * point for the other, and splitting them would mean setting the same font twice.
 */
const templateTextBox = (
  defaults: ToolDefaults,
  at: Point2,
  size: { width: Nm; height: Nm }
): Extract<SymbolGraphic, { type: 'textBox' }> => ({
  type: 'textBox',
  text: defaults.text?.text ?? DEFAULT_TEXT,
  position: { x: at.x, y: at.y, angle: 0 },
  size,
  margins: { ...DEFAULT_TEXT_BOX_MARGINS_NM, ...defaults.textBox?.margins },
  effects: { ...VISIBLE_TEXT, ...defaults.text?.effects },
  ...templateStyle(defaults)
})

/**
 * The item a tool would place, at a nominal position — what the properties panel
 * shows while the tool is armed, before any click has said where it goes.
 *
 * Geometry here is a placeholder and deliberately not shown by the panel (the
 * cursor owns it). `buildToolItems` takes the same templates and positions them,
 * so the panel and the ghost cannot describe different objects.
 */
export function toolTemplate(
  tool: SymbolTool,
  defaults: ToolDefaults = {},
  at: Point2 = { x: ZERO, y: ZERO }
): { graphics: SymbolGraphic[]; pins: SymbolPin[] } {
  const style = templateStyle(defaults)
  // A fresh copy per anchor: two corners of one rectangle must not alias, or
  // moving one would silently move the other.
  const p = (): Point2 => ({ x: at.x, y: at.y })
  switch (tool) {
    case 'pin':
      return { graphics: [], pins: [{ ...templatePin(defaults), position: { ...p(), angle: 0 } }] }
    case 'text':
      return {
        graphics: [{ ...templateText(defaults), position: { ...p(), angle: 0 } }],
        pins: []
      }
    case 'rectangle':
      return { graphics: [{ type: 'rectangle', start: p(), end: p(), ...style }], pins: [] }
    case 'circle':
      return { graphics: [{ type: 'circle', center: p(), radius: ZERO, ...style }], pins: [] }
    case 'arc':
      return { graphics: [{ type: 'arc', start: p(), mid: p(), end: p(), ...style }], pins: [] }
    case 'line':
    case 'polygon':
      return { graphics: [{ type: 'line', points: [p()], ...style }], pins: [] }
    case 'bezier':
      return { graphics: [{ type: 'bezier', points: [p()], ...style }], pins: [] }
    case 'textBox':
      return {
        graphics: [templateTextBox(defaults, p(), { width: ZERO, height: ZERO })],
        pins: []
      }
    case 'anchor':
    case 'select':
      return { graphics: [], pins: [] }
  }
}

/** Normalized rectangle corners, or null for a degenerate span. */
export const rectangleFrom = (a: Point2, b: Point2): { start: Point2; end: Point2 } | null => {
  if (Math.abs(b.x - a.x) < MIN_SPAN || Math.abs(b.y - a.y) < MIN_SPAN) return null
  return {
    start: { x: nm(Math.min(a.x, b.x)), y: nm(Math.max(a.y, b.y)) },
    end: { x: nm(Math.max(a.x, b.x)), y: nm(Math.min(a.y, b.y)) }
  }
}

/** Circle from center and rim; the hypot-derived radius rounds onto the nm grid. */
export const circleFrom = (center: Point2, rim: Point2): { center: Point2; radius: Nm } | null => {
  const radius = nm(Math.hypot(rim.x - center.x, rim.y - center.y))
  return radius < MIN_SPAN ? null : { center: { x: center.x, y: center.y }, radius }
}

/**
 * A cubic Bezier's four control points in FILE order, from the order they are
 * clicked: **start, end, then the two handles**.
 *
 * Ends first for the same reason the arc takes its ends before its bulge: by the
 * second click you are already previewing the curve itself — a straight one — and
 * the clicks after it bend a shape that is on screen. Placing the handles first
 * would show a control polygon instead, which is not the shape being drawn.
 *
 * **A handle not yet placed sits on its own endpoint**, which is the degenerate
 * cubic whose control points are collinear — geometrically the straight chord. So
 * two clicks give a line, the third bends it from the start, the fourth from the
 * end, and every phase is a real Bezier rather than a placeholder.
 *
 * Null until there is a chord to bend.
 */
export const bezierFrom = (points: Point2[]): Point2[] | null => {
  const [start, end, handle1, handle2] = points
  if (!start || !end) return null
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_SPAN) return null
  return [{ ...start }, { ...(handle1 ?? start) }, { ...(handle2 ?? end) }, { ...end }]
}

/**
 * The three points of an arc, from the order they are CLICKED: start, then end,
 * then the bulge. KiCad stores them `start`/`mid`/`end`, so the returned shape
 * reorders — the one place the click order and the file order differ, which is
 * why a test names both.
 *
 * With no bulge yet the mid sits on the chord, so the arc previews as the straight
 * line it currently is (both scenes draw a collinear arc that way) and each phase
 * of the draw treats the cursor as the point that click will set: the second
 * click sets the end, the third bends it. Null only when there is no chord at all.
 */
export const arcFrom = (
  start: Point2,
  end: Point2,
  bulge?: Point2
): { start: Point2; mid: Point2; end: Point2 } | null => {
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_SPAN) return null
  // The chord midpoint halves an integer sum, so it rounds back onto the grid.
  const mid = bulge ?? {
    x: nm((start.x + end.x) / 2),
    y: nm((start.y + end.y) / 2)
  }
  return { start: { ...start }, mid: { ...mid }, end: { ...end } }
}

/**
 * A pin's drawn extent. `at` is the CONNECTION point — the end a wire attaches
 * to — and the body extends away from it along `angle`, matching how KiCad
 * stores a pin (`(at x y angle)` is the connection end).
 */
export const pinPointsAt = (at: Point2, angle = 0): Point2[] => {
  const radians = (angle * Math.PI) / 180
  return [
    { x: at.x, y: at.y },
    {
      x: nm(at.x + Math.cos(radians) * PIN_LENGTH),
      y: nm(at.y + Math.sin(radians) * PIN_LENGTH)
    }
  ]
}

/**
 * How the pending item is turned before it lands. Rotate/mirror while a tool is
 * armed adjusts this rather than the selection, so you can orient a pin before
 * committing it — the idiom in both KiCad and Altium. It stays put across
 * repeats, so ten pins can be placed at the same heading.
 */
export interface ToolOrientation {
  /** Counter-clockwise quarter turns applied first. */
  quarterTurns: number
  mirror: MirrorAxis | null
}

export const DEFAULT_ORIENTATION: ToolOrientation = { quarterTurns: 0, mirror: null }

const orientPoint = (p: Point2, pivot: Point2, orientation: ToolOrientation): Point2 => {
  // Quarter-turn rotation and mirroring are integer-exact; nm() only re-brands
  // across symbolEdit's unit-agnostic point math.
  const rotated = rotatePoint(p, pivot, orientation.quarterTurns)
  const placed = orientation.mirror ? mirrorPoint(rotated, pivot, orientation.mirror) : rotated
  return { x: nm(placed.x), y: nm(placed.y) }
}

const orientAngle = (angle: number, orientation: ToolOrientation): number => {
  const rotated = normalizeAngle(angle + orientation.quarterTurns * 90)
  return orientation.mirror ? mirrorAngle(rotated, orientation.mirror) : rotated
}

/**
 * Map every anchor point of a typed graphic. The per-primitive knowledge of
 * which points a shape carries lives here once, for every typed transform —
 * the counterpart of `mapGraphicPoints` on the AST side.
 */
export function mapTypedGraphicPoints(
  graphic: SymbolGraphic,
  at: (p: Point2) => Point2,
  angleOf: (angle: number) => number = (a) => a
): SymbolGraphic {
  switch (graphic.type) {
    case 'rectangle':
      return { ...graphic, start: at(graphic.start), end: at(graphic.end) }
    case 'circle':
      return { ...graphic, center: at(graphic.center) }
    // A Bezier transforms by its control points — mapping them IS mapping the
    // curve, because the mapping is affine.
    case 'line':
    case 'bezier':
      return { ...graphic, points: graphic.points.map(at) }
    case 'arc':
      return { ...graphic, start: at(graphic.start), mid: at(graphic.mid), end: at(graphic.end) }
    case 'text':
      return {
        ...graphic,
        position: { ...at(graphic.position), angle: angleOf(graphic.position.angle) }
      }
    // Only the anchor maps: `size` is an extent, not a point, so mapping it too
    // would scale the box by wherever it happens to sit. The AST-side
    // `mapGraphicPoints` makes the same call for the same reason.
    case 'textBox':
      return {
        ...graphic,
        position: { ...at(graphic.position), angle: angleOf(graphic.position.angle) }
      }
  }
}

/** Update a preview vertex; derived values round back onto the integer nm grid. */
export function setTypedGraphicVertex(
  graphic: SymbolGraphic,
  vertexIndex: number,
  point: Point2
): SymbolGraphic {
  const inRange = (count: number): boolean => vertexIndex >= 0 && vertexIndex < count
  const at = { x: point.x, y: point.y }
  switch (graphic.type) {
    case 'rectangle':
      if (!inRange(2)) return graphic
      return vertexIndex === 0 ? { ...graphic, start: at } : { ...graphic, end: at }
    case 'arc': {
      if (!inRange(3)) return graphic
      const key = (['start', 'mid', 'end'] as const)[vertexIndex]
      return { ...graphic, [key]: at }
    }
    case 'circle':
      if (!inRange(2)) return graphic
      // Vertex 0 is the center and moves the whole circle; the rim handle sets
      // the radius, rounded onto the nm grid like every hypot-derived value.
      return vertexIndex === 0
        ? { ...graphic, center: at }
        : {
            ...graphic,
            radius: nm(Math.hypot(at.x - graphic.center.x, at.y - graphic.center.y))
          }
    case 'line':
    case 'bezier': {
      if (!inRange(graphic.points.length)) return graphic
      const points = graphic.points.map((p, i) => (i === vertexIndex ? at : p))
      return { ...graphic, points }
    }
    case 'text':
      if (!inRange(1)) return graphic
      return { ...graphic, position: { ...graphic.position, x: at.x, y: at.y } }
    case 'textBox': {
      // Mirrors `setGraphicVertex`'s text_box branch exactly — anchor corner
      // moves and resizes so the far corner holds; far corner just resizes.
      // A test pins the two together, because a preview that resized from the
      // other corner would be a different operation, not merely an offset one.
      // `unrotateAbout` is free-angle trig, so its result rounds through nm().
      if (!inRange(2)) return graphic
      const local = unrotateAbout(at, graphic.position, graphic.position.angle)
      const p = { x: nm(local.x), y: nm(local.y) }
      if (vertexIndex === 0) {
        const far = {
          x: graphic.position.x + graphic.size.width,
          y: graphic.position.y + graphic.size.height
        }
        return {
          ...graphic,
          position: { ...graphic.position, x: p.x, y: p.y },
          size: { width: nm(far.x - p.x), height: nm(far.y - p.y) }
        }
      }
      return {
        ...graphic,
        size: {
          width: nm(p.x - graphic.position.x),
          height: nm(p.y - graphic.position.y)
        }
      }
    }
  }
}

/**
 * Turn a built primitive about `pivot`. Transform rules come from symbolEdit —
 * including the two-state snap a `text` angle takes (`snapSymbolTextAngle`), so
 * a text rotated while the tool is armed previews at an angle KiCad can express
 * and lands there too.
 */
const orientGraphic = (
  graphic: SymbolGraphic,
  pivot: Point2,
  orientation: ToolOrientation
): SymbolGraphic =>
  mapTypedGraphicPoints(
    graphic,
    (p) => orientPoint(p, pivot, orientation),
    (angle) => {
      const turned = orientAngle(angle, orientation)
      return graphic.type === 'text' ? snapSymbolTextAngle(turned) : turned
    }
  )

const orientPin = (pin: SymbolPin, pivot: Point2, orientation: ToolOrientation): SymbolPin => ({
  ...pin,
  position: {
    ...orientPoint(pin.position, pivot, orientation),
    angle: orientAngle(pin.position.angle, orientation)
  }
})

/**
 * The real primitives `tool` would place, given the points it has collected.
 * Fed both to the renderer as the placement preview and to the insert commands,
 * so preview and result cannot disagree.
 *
 * `points` is the anchor chain — the clicks committed so far, followed by the
 * cursor while a tool is armed. How much of it is read is the tool's gesture:
 * a drop tool takes the last point, a span tool the first and last, a chain tool
 * all of them. So the same call serves "nothing clicked yet" and "one corner
 * down, dragging the other", and neither can drift from the commit.
 *
 * Orientation applies to drop tools only. A shape whose points came from clicks
 * is already oriented by where those clicks landed; turning it afterwards would
 * move it out from under them, and rotating an axis-aligned rectangle 90° is a
 * corner swap you get by spanning the other diagonal anyway.
 */
export function toolItems(
  tool: SymbolTool,
  points: Point2[],
  orientation: ToolOrientation = DEFAULT_ORIENTATION,
  defaults: ToolDefaults = {}
): { graphics: SymbolGraphic[]; pins: SymbolPin[] } {
  const built = buildToolItems(tool, points, defaults)
  const pivot = points[points.length - 1]
  if (!pivot || toolGesture(tool) !== 'drop') return built
  // The anchor is the pivot, so a pin turns about its connection point — what
  // you'd expect of the thing under the cursor.
  return {
    graphics: built.graphics.map((g) => orientGraphic(g, pivot, orientation)),
    pins: built.pins.map((p) => orientPin(p, pivot, orientation))
  }
}

function buildToolItems(
  tool: SymbolTool,
  points: Point2[],
  defaults: ToolDefaults = {}
): { graphics: SymbolGraphic[]; pins: SymbolPin[] } {
  const none = { graphics: [], pins: [] }
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return none
  // Everything non-geometric comes off the same templates the properties panel
  // edits and `toolTemplate` renders, so the panel, the ghost and the inserted
  // item are one object described three times rather than three descriptions.
  const style = templateStyle(defaults)
  switch (tool) {
    case 'pin':
      return {
        graphics: [],
        pins: [{ ...templatePin(defaults), position: { x: last.x, y: last.y, angle: 0 } }]
      }
    case 'rectangle': {
      // With only the cursor, `first` IS `last`, so this draws nothing until the
      // first click gives the span an anchor to run from — the same rule the
      // polyline follows, and what KiCad's shape tools do.
      const rect = rectangleFrom(first, last)
      if (!rect) return none
      return {
        graphics: [{ type: 'rectangle', start: rect.start, end: rect.end, ...style }],
        pins: []
      }
    }
    case 'line':
      // A chain has nothing to draw until it has a segment: the first click
      // seeds it, and the preview runs from there to the cursor.
      if (points.length < 2) return none
      return {
        graphics: [{ type: 'line', points: points.map((p) => ({ ...p })), ...style }],
        pins: []
      }
    case 'polygon': {
      // Closed back to its first corner at every phase from the third corner
      // on, the cursor standing in for the next one — the shape the finish
      // will commit, since `polygonFrom` is also what the commit is built from.
      const ring = polygonFrom(points)
      if (!ring) return none
      return { graphics: [{ type: 'line', points: ring, ...style }], pins: [] }
    }
    case 'circle': {
      const circle = circleFrom(first, last)
      if (!circle) return none
      return {
        graphics: [{ type: 'circle', center: circle.center, radius: circle.radius, ...style }],
        pins: []
      }
    }
    case 'arc': {
      // points[1] is the end and the LAST point is the bulge, so mid-draw (two
      // points: anchor + cursor) the cursor is the end, and after the second
      // click it is the bulge. Each phase previews what its click will set.
      const arc = arcFrom(
        first,
        points.length >= 3 ? points[1] : last,
        points[2] ? last : undefined
      )
      if (!arc) return none
      return {
        graphics: [{ type: 'arc', start: arc.start, mid: arc.mid, end: arc.end, ...style }],
        pins: []
      }
    }
    case 'bezier': {
      // Clicks are start, end, handle, handle; the file wants start, handle,
      // handle, end. `bezierFrom` owns that reorder and fills the unplaced handles
      // in, so every phase of the draw is a real four-point curve.
      const curve = bezierFrom(points)
      if (!curve) return none
      return {
        graphics: [{ type: 'bezier', points: curve, ...style }],
        pins: []
      }
    }
    case 'text':
      return {
        graphics: [{ ...templateText(defaults), position: { x: last.x, y: last.y, angle: 0 } }],
        pins: []
      }
    case 'textBox': {
      // Spanned exactly like a rectangle, then re-expressed as the anchor +
      // extent the format stores. `rectangleFrom` already normalizes to
      // (min x, max y) → (max x, min y), which IS top-left → bottom-right, so
      // the width comes out positive and the height negative — the shape KiCad
      // writes, without a second normalization rule to keep in step.
      const rect = rectangleFrom(first, last)
      if (!rect) return none
      return {
        graphics: [
          templateTextBox(defaults, rect.start, {
            width: nm(rect.end.x - rect.start.x),
            height: nm(rect.end.y - rect.start.y)
          })
        ],
        pins: []
      }
    }
    case 'anchor':
    case 'select':
      return none
  }
}
