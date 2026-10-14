// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import * as THREE from 'three'
import { schematicToSvg, type SchematicSvg } from './schematicSvg'
import { currentAppTheme, themeColor } from '../theme'
import { PrimitiveBatch } from './PrimitiveBatch'
import { VertexHandles, type VertexHandleSpec } from './VertexHandles'
import { TextAnchors } from './TextAnchors'
import { dropKeysCoveredByParent, KeyHierarchy } from './keyHierarchy'
import { schematicItemKind, type HitCandidate } from '../selectionResolve'
import {
  arcPath,
  hitShape,
  shapeInBox,
  type HitBox,
  type HitKind,
  type HitShape
} from './schematicHitShapes'
import type { CompositeLayerSpec, ScreenScaled } from './ViewportEngine'
import {
  getTextStrokes,
  strokeOptionsFromTextEffects,
  KICAD_DEFAULT_LINE_WIDTH
} from '../kicad/newstroke'
import { textBoxLayout } from '../schematic/textBox'
import { shapeGraphic } from '../schematic/sheetGraphicEdit'
import {
  dashPath,
  directiveLabelGlyph,
  hatchLineSpacing,
  hatchLineWidth,
  hatchSegments,
  hatchSlopes,
  imageSizeNm,
  pngInfo,
  sheetTextBoxFrame,
  strokeDashPattern,
  tableBorderSegments
} from '../schematic/sheetGraphics'
import { markupToPlainText } from '../kicad/textMarkup'
import { mmToNm, nm, NM_PER_MM, nmToMm, spacingToMm, type Nm } from '../kicad/coordinates'
import { isColorUnset, type Rgba } from '../kicad/color'
import {
  pinTextOrientation,
  schematicFieldDrawn,
  symbolBodyTextAngle,
  symbolFieldTextAngle,
  schematicLabelDirection,
  schematicTextAngle,
  transformedTextAngle
} from './schematicTextOrientation'
import {
  bezierCurvePoints,
  definitionIdOf,
  resolveSymbolGeometry,
  schematicFieldKey,
  shownFieldText,
  symbolPartKey,
  type KicadBusEntry,
  type KicadDirectiveLabel,
  type KicadLabel,
  type KicadSchematic,
  type KicadSchematicTable,
  type KicadWire,
  type KicadSchematicSymbol,
  type KicadTextEffects,
  type Point,
  type SchematicItemType,
  type SymbolGraphic,
  type SymbolPin,
  type SymbolStroke
} from '../kicad/schematic'
import { TEXT_OFFSET_RATIO } from '../schematic/schematicItems'
import { onWireRun } from '../schematic/schematicTools'
import type { ClassConnectionStyles, ConnectionStyle } from '../schematic/classConnectionStyles'

/** A selectable schematic item: its kind plus index into the parsed arrays. */
export interface SchematicItemRef {
  type: SchematicItemType
  index: number
  /**
   * Which field, when `type` is `'field'` or `'sheet_field'` — the property
   * key (`Reference`, `Sheetname`). `index` is then the SYMBOL's or SHEET's
   * index, since a field is part of its owner rather than a document-level
   * item of its own.
   */
  field?: string
  /** Which pin, when `type` is `'sheet_pin'`; `index` is then the sheet's. */
  pin?: number
}

/**
 * Where a selected item's paint is filed.
 *
 * A part — a symbol's field, a sheet's field or pin — resolves to a part key
 * beneath its owner, matching what `rebuild` wrote, so the halo and the drag
 * find the strokes. Everything else is a document-level item and keys by kind
 * and index.
 */
export const schematicItemKey = (item: SchematicItemRef): string => {
  if (item.type === 'field' && item.field !== undefined)
    return `symbol:${item.index}/${schematicFieldKey(item.field)}`
  if (item.type === 'sheet_field' && item.field !== undefined)
    return `sheet:${item.index}/${schematicFieldKey(item.field)}`
  if (item.type === 'sheet_pin' && item.pin !== undefined)
    return `sheet:${item.index}/pin:${item.pin}`
  return `${item.type}:${item.index}`
}

/**
 * Whether two refs name the same thing.
 *
 * Not `sameRef`'s `type` + `index`: two fields of ONE symbol share both — a
 * Reference and a Value are `field:0` and `field:0` — so that comparison would
 * call them equal and shift-clicking the second would deselect the first.
 * Comparing the key is exact, because the key is what identifies the paint.
 */
export const sameSchematicRef = (a: SchematicItemRef, b: SchematicItemRef): boolean =>
  schematicItemKey(a) === schematicItemKey(b)

type LabelShape = 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive'

/**
 * KiCad's hierarchical-label glyph, as `SCH_HIERLABEL::CreateGraphicShape`
 * builds it: points at integer multiples of half the text height, from the
 * connection point outward. `SCH_SHEET_PIN` derives from `SCH_HIERLABEL`, so a
 * sheet pin is the same drawing — which is right, since the two are the halves
 * of one connection.
 *
 * Held for text running RIGHT from the anchor; the other directions are this
 * rotated. `tri_state` shares `bidirectional`'s array in KiCad's source, not by
 * approximation — see `docs/references/kicad-label-shapes.md`.
 */
const HIER_GLYPH: Record<LabelShape, ReadonlyArray<readonly [number, number]>> = {
  input: [
    [0, 0],
    [1, 1],
    [2, 1],
    [2, -1],
    [1, -1]
  ],
  output: [
    [2, 0],
    [1, -1],
    [0, -1],
    [0, 1],
    [1, 1]
  ],
  bidirectional: [
    [0, 0],
    [1, -1],
    [2, 0],
    [1, 1]
  ],
  tri_state: [
    [0, 0],
    [1, -1],
    [2, 0],
    [1, 1]
  ],
  passive: [
    [0, -1],
    [2, -1],
    [2, 1],
    [0, 1]
  ]
}

/** `DEFAULT_LABEL_SIZE_RATIO` — the margin a global label's flag leaves around
 *  its text, as a fraction of the text height. */
const LABEL_BOX_EXPANSION = 0.375

/**
 * How far a label's TEXT is pushed off its anchor, along the direction it
 * reads, so it clears the shape drawn there. From KiCad's
 * `GetSchematicTextOffset` overrides, in text heights:
 *
 * - hierarchical (and sheet pins, which share the class): the glyph's full
 *   width plus the standard text gap, so the name starts just past it.
 * - global: the flag's margin, plus three quarters of a height where that end
 *   is pointed — KiCad's own proxy for the triangle's size.
 * - local: nothing along the text.
 *
 * Drawing at the bare anchor put every name on top of its own shape.
 *
 * Across the text (`labelLift`), KiCad lifts a local label off its wire by the
 * text offset plus the pen width, so the name clears the wire it sits on, and
 * drops a global label's text 0.0715 of a height so it centers on an "E"
 * rather than an "R", leaving room for an overbar.
 */
/**
 * A sheet pin draws the OPPOSITE glyph to a hierarchical label of the same
 * shape — `SCH_SHEET_PIN::CreateGraphicShape` swaps input and output before
 * delegating, and says so in a comment. It reads correctly on the page: a
 * signal the child declares an input arrives at the parent's box, so the arrow
 * on the parent points the other way from the one inside the child.
 */
const sheetPinGlyphShape = (shape: LabelShape): LabelShape =>
  shape === 'input' ? 'output' : shape === 'output' ? 'input' : shape

/**
 * The way a sheet pin's glyph and name run from its anchor, as a renderer
 * angle. NOT its KiCad angle, which names the edge's outward side (180 on a
 * left edge): the drawing runs the way the justification says — `justify
 * left` onward along the text, `right` back against it — and on a pin KiCad
 * writes that is into the box. Reading the justification rather than flipping
 * the angle draws a file the way KiCad does even when its pair is unusual; an
 * unjustified pin falls back to inward.
 */
const sheetPinDirection = (
  kicadAngle: number,
  align: KicadTextEffects['horizontalAlign']
): number => {
  const along = schematicTextAngle(kicadAngle)
  if (align === 'left') return along
  if (align === 'right') return along + 180
  return (schematicLabelDirection(kicadAngle) + 180) % 360
}

const hierarchicalTextGap = (effects: KicadTextEffects): number =>
  nmToMm(effects.fontSize.width) + nmToMm(effects.fontSize.height) * TEXT_OFFSET_RATIO
const globalTextGap = (height: number, shape: LabelShape): number =>
  height * LABEL_BOX_EXPANSION +
  (shape === 'input' || shape === 'bidirectional' || shape === 'tri_state' ? (height * 3) / 4 : 0)

/** How far a label's text moves toward its own top (negative: its bottom), in mm. */
const labelLift = (type: KicadLabel['type'], effects: KicadTextEffects): number => {
  const height = nmToMm(effects.fontSize.height)
  if (type === 'label')
    return height * TEXT_OFFSET_RATIO + strokeOptionsFromTextEffects(effects).thickness
  if (type === 'global_label') return -height * 0.0715
  return 0
}

const itemKey = schematicItemKey

const COLORS = {
  symbol: new THREE.Color(themeColor('--vscode-canvas-symbol', '#cca250')),
  /**
   * KiCad's selection-shadow blue, `COLOR4D(.4, .7, 1.0)` in every built-in
   * theme (`builtin_color_themes.h`) — light AND dark, because the
   * distinctness is carried by HUE: nothing else on a schematic is sky blue.
   * That argument transfers directly to this canvas, whose content palette is
   * all warm golds and green-teals (symbol #cca250, wires #4aba62, pin names
   * #8fc7bd).
   */
  selected: new THREE.Color(themeColor('--vscode-canvas-selection', '#66b3ff')),
  /** The selection halo, and what a selected fill tints toward. */
  halo: new THREE.Color(themeColor('--vscode-canvas-selection-halo', '#66b3ff')),
  wire: new THREE.Color(themeColor('--vscode-canvas-wire', '#4aba62')),
  bus: new THREE.Color(themeColor('--vscode-canvas-bus', '#7b8ce0')),
  ruleArea: new THREE.Color(themeColor('--vscode-canvas-rule-area', '#d9825f')),
  directive: new THREE.Color(themeColor('--vscode-canvas-directive', '#a4b1ab')),
  /** A junction dot: the wire's color unless the theme sets it apart. */
  junction: new THREE.Color(themeColor('--vscode-canvas-junction', '#4aba62')),
  noConnect: new THREE.Color(themeColor('--vscode-canvas-no-connect', '#d16d78')),
  label: new THREE.Color(themeColor('--vscode-canvas-label', '#d7e0dc')),
  labelGlobal: new THREE.Color(themeColor('--vscode-canvas-label-global', '#e6ece9')),
  labelHierarchical: new THREE.Color(themeColor('--vscode-canvas-label-hierarchical', '#8daea0')),
  text: new THREE.Color(themeColor('--vscode-canvas-text', '#d7e0dc')),
  /**
   * The identity fields, apart from each other and from annotation: KiCad
   * colors Reference and Value separately, and a sheet scanned for "where is
   * U7" reads the designators as their own layer.
   */
  reference: new THREE.Color(themeColor('--vscode-canvas-reference', '#9bc7b0')),
  value: new THREE.Color(themeColor('--vscode-canvas-value', '#9bc7b0')),
  /** Free sheet text and graphics — annotation about the design, not part of it. */
  notes: new THREE.Color(themeColor('--vscode-canvas-notes', '#ffffff')),
  /** A pin's line: KiCad's own "pin" color, apart from the body outline. */
  pin: new THREE.Color(themeColor('--vscode-canvas-pin', '#cca250')),
  /**
   * A power port (`(power)` symbol): its body and pin. The symbol color by
   * default, as in KiCad, which draws a port like any part; its own input so
   * a theme can color it with the wiring instead.
   */
  power: new THREE.Color(themeColor('--vscode-canvas-power', '#cca250')),
  pinNumber: new THREE.Color(themeColor('--vscode-canvas-pin-number', '#d59d72')),
  /**
   * Pin NAMES, distinct from pin numbers and from generic text. KiCad colors the
   * three separately — names read teal against the body — and collapsing names
   * into the ordinary text color loses the at-a-glance split between "what this
   * pin is called" and "which physical pin it is".
   *
   * Darker and greener than general text so it stays clearly canvas CONTENT —
   * and nowhere near the selection blue, which owns "selected" outright.
   */
  pinName: new THREE.Color(themeColor('--vscode-canvas-pin-name', '#8fc7bd')),
  /**
   * Non-identity fields (Footprint, Datasheet, …). KiCad colors these apart from
   * Reference/Value, and they are metadata rather than the part's identity.
   */
  field: new THREE.Color(themeColor('--vscode-canvas-field', '#a992c4')),
  /** A `(hide yes)` pin, drawn dimmed where hidden pins are shown. */
  pinHidden: new THREE.Color(themeColor('--vscode-canvas-hidden', '#748780')),
  /**
   * A field the file marks hidden, drawn where hidden fields are shown (the
   * symbol editor, or the schematic's view switch). Dimmed toward the
   * background — visible, clearly secondary, and unmistakably not what a placed
   * instance would show.
   */
  fieldHidden: new THREE.Color(themeColor('--vscode-canvas-hidden', '#748780')),
  /**
   * The dangling-indicator ring at a pin's free end, in the SYMBOL EDITOR.
   * BRIGHTENED body color, not faded — KiCad draws it `aColor.Brightened(0.3)`
   * (`sch_painter.cpp`) precisely so it stays visible where it overlaps a
   * junction dot. An earlier pass darkened it instead, which is backwards.
   */
  pinConnection: new THREE.Color(themeColor('--vscode-canvas-pin', '#cca250')).lerp(
    new THREE.Color(themeColor('--vscode-text-light', '#ffffff')),
    0.3
  ),
  /**
   * `(fill (type background))` — KiCad's "body background", the wash inside a
   * symbol's outline. 11.6k of the 17.5k fills in the standard library are
   * rectangles carrying this, so it is what a filled symbol body looks like.
   * A dark warm tone rather than the light yellow KiCad's LIGHT theme uses: the
   * job is to read as body-interior against #101513, not to match a theme we
   * don't run.
   */
  symbolBody: new THREE.Color(themeColor('--vscode-canvas-symbol-body', '#2a2417')),
  sheet: new THREE.Color(themeColor('--vscode-canvas-sheet', '#8daea0')),
  netHighlight: new THREE.Color(themeColor('--vscode-canvas-net-highlight', '#e8c46a')),
  /** The cross struck through a `(dnp yes)` symbol. */
  dnp: new THREE.Color(themeColor('--vscode-canvas-dnp', '#ef4b40')),
  /**
   * The sheet behind everything. Not painted from here — the engine clears to
   * it — but a DNP symbol is dimmed by mixing HALFWAY toward it, so the scene
   * has to know what it is.
   */
  sheetBackground: new THREE.Color(themeColor('--vscode-bg-viewport', '#101513'))
}

/** Update the shared scene colors before each open schematic is rebuilt. */
export const applySchematicTheme = (): void => {
  COLORS.symbol.set(themeColor('--vscode-canvas-symbol', '#cca250'))
  COLORS.selected.set(themeColor('--vscode-canvas-selection', '#66b3ff'))
  COLORS.halo.set(themeColor('--vscode-canvas-selection-halo', '#66b3ff'))
  COLORS.wire.set(themeColor('--vscode-canvas-wire', '#4aba62'))
  COLORS.junction.set(themeColor('--vscode-canvas-junction', '#4aba62'))
  COLORS.bus.set(themeColor('--vscode-canvas-bus', '#7b8ce0'))
  COLORS.ruleArea.set(themeColor('--vscode-canvas-rule-area', '#d9825f'))
  COLORS.directive.set(themeColor('--vscode-canvas-directive', '#a4b1ab'))
  COLORS.noConnect.set(themeColor('--vscode-canvas-no-connect', '#d16d78'))
  COLORS.label.set(themeColor('--vscode-canvas-label', '#d7e0dc'))
  COLORS.labelGlobal.set(themeColor('--vscode-canvas-label-global', '#e6ece9'))
  COLORS.labelHierarchical.set(themeColor('--vscode-canvas-label-hierarchical', '#8daea0'))
  COLORS.text.set(themeColor('--vscode-canvas-text', '#d7e0dc'))
  COLORS.reference.set(themeColor('--vscode-canvas-reference', '#9bc7b0'))
  COLORS.value.set(themeColor('--vscode-canvas-value', '#9bc7b0'))
  COLORS.notes.set(themeColor('--vscode-canvas-notes', '#ffffff'))
  COLORS.pin.set(themeColor('--vscode-canvas-pin', '#cca250'))
  COLORS.power.set(themeColor('--vscode-canvas-power', '#cca250'))
  COLORS.pinNumber.set(themeColor('--vscode-canvas-pin-number', '#d59d72'))
  COLORS.pinName.set(themeColor('--vscode-canvas-pin-name', '#8fc7bd'))
  COLORS.field.set(themeColor('--vscode-canvas-field', '#a992c4'))
  COLORS.pinHidden.set(themeColor('--vscode-canvas-hidden', '#748780'))
  COLORS.fieldHidden.copy(COLORS.pinHidden)
  COLORS.pinConnection
    .copy(COLORS.pin)
    .lerp(new THREE.Color(themeColor('--vscode-text-light', '#ffffff')), 0.3)
  COLORS.symbolBody.set(themeColor('--vscode-canvas-symbol-body', '#2a2417'))
  COLORS.sheet.set(themeColor('--vscode-canvas-sheet', '#8daea0'))
  COLORS.netHighlight.set(themeColor('--vscode-canvas-net-highlight', '#e8c46a'))
  COLORS.dnp.set(themeColor('--vscode-canvas-dnp', '#ef4b40'))
  COLORS.sheetBackground.set(themeColor('--vscode-bg-viewport', '#101513'))
  dimmedColors.clear()
}

/**
 * KiCad's dim, for a symbol marked Do Not Populate: `color.Desaturate()` — HSL
 * saturation to zero, lightness untouched — then `Mix(sheetColour, 0.5)`, an
 * even blend with the page (`SCH_PAINTER::getRenderColor`). Hue is what it
 * takes away: a dimmed part stops reading as one of the colored classes on the
 * sheet before it reads as merely fainter, which is why halving the alpha is
 * not the same effect.
 */
export const dnpDimmedColor = (color: THREE.Color, sheet: THREE.Color): THREE.Color => {
  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl)
  return new THREE.Color().setHSL(hsl.h, 0, hsl.l).lerp(sheet, 0.5)
}

/** Dimmed paint, memoized per source color — a rebuilt sheet asks repeatedly. */
const dimmedColors = new Map<number, THREE.Color>()
const dimmed = (color: THREE.Color): THREE.Color => {
  const key = color.getHex()
  const found = dimmedColors.get(key)
  if (found) return found
  const made = dnpDimmedColor(color, COLORS.sheetBackground)
  dimmedColors.set(key, made)
  return made
}

/** File-space geometry of one net, for the hover-highlight overlay. */
/** How the visual diff paints a sheet (`SchematicScene.setDiffPaint`), by element key. */
export interface SchematicDiffPaint {
  /** Added, moved or changed: drawn in their own colors. */
  changed: ReadonlySet<string>
  /** Removed items drawn back in where they were: faded red, under what remains. */
  removed: ReadonlySet<string>
}

export interface NetHighlightGeometry {
  /** Wire polylines (each an ordered point run in sheet coordinates). */
  wireRuns: Point[][]
  /** Pin and junction connection points. */
  points: Point[]
}

/**
 * Recorded strokes per element, replayed into the selection-glow batch. The
 * glow is the same geometry widened and drawn beneath the element, in a batch
 * with a pixel floor so the halo stays visible at any zoom.
 */
type GlowPrimitive =
  | {
      kind: 'capsule'
      x0: number
      y0: number
      x1: number
      y1: number
      halfWidth: number
      z: number
    }
  | { kind: 'ring'; x: number; y: number; radius: number; stroke: number; z: number }
  | {
      kind: 'roundrect'
      x: number
      y: number
      halfW: number
      halfH: number
      radius: number
      rotation: number
      z: number
    }

/**
 * The scene's paint order, low to high.
 *
 * Everything here is a depth passed to the primitive batches, which sort by it —
 * so these are RELATIVE positions in a stack, and only their order carries
 * meaning. They were scattered as bare literals (`0.07` appeared 18 times), which
 * made the stack impossible to read and adding a layer a matter of guessing a
 * gap: the pin connection ring first went in at `0.069` and rendered *under* the
 * pin it marks, a bug that a named constant would not have allowed.
 *
 * The order itself is KiCad's, not invented: `SCH_LAYER_ORDER` in
 * `eeschema/sch_view.h`, read TOP-first, is what `SCH_DRAW_PANEL` feeds to
 * `VIEW::SetLayerOrder` and thence to `SetLayerDepth`. Its consequences are
 * easy to get backwards from taste alone — backgrounds go under WIRE rather
 * than just under the outline they fill; a no-connect goes over the pin it
 * marks but under that pin's NUMBER (`SCH_PIN::ViewGetLayers` puts the pin
 * line on `LAYER_DEVICE` and its text two tiers higher).
 *
 * Ordering rules worth stating, since the numbers no longer show them:
 * - Fills sit under everything, wires included.
 * - Anything marking a point ON a stroke (a no-connect, a junction, the
 *   connection ring) sits above it.
 * - Text sits above all geometry; a symbol's fields sit above its own text.
 * - Previews sit above the document — they stand in front of what they'd change.
 *
 * A schematic has no layers, so a flat named stack is the whole story here.
 * `BoardScene` needs promotions (active layer, flipped view) and so builds its
 * order as data instead — `BOARD_LAYER_STACK` in lib/kicad/layers.ts.
 * `FootprintScene` and `GerberScene` still carry bare literals.
 */
export const SCHEMATIC_PAINT_ORDER = {
  /** Net-highlight wash, beneath the document it highlights. */
  netHighlight: 0.02,
  /** Fills of free sheet graphics and text boxes — `LAYER_NOTES_BACKGROUND`, the bottom. */
  notesFill: 0.025,
  /**
   * Filled symbol bodies — KiCad's `LAYER_DEVICE_BACKGROUND`, which its stack
   * puts under EVERYTHING it draws, wires included. A background that outranks
   * a wire swallows any wire routed across a filled body.
   */
  symbolFill: 0.03,
  /** Images — `LAYER_DRAW_BITMAPS`, over every background and under every stroke. */
  image: 0.035,
  /** Sheet frames — `LAYER_SHEET`, under the symbols that may sit on them. */
  sheetFrame: 0.04,
  /**
   * Symbol-editor-only paint for `(hide yes)` pins and fields. Each sits one
   * layer under the visible class it mirrors — `symbolStroke`, `pinConnection`,
   * `text` — so a ghosted item never covers the drawing proper.
   *
   * Above `symbolFill` rather than below everything visible: a hidden pin is
   * routinely INSIDE the body (ecc83-pp's GND is a zero-length pin at the
   * origin), and under the fill it would not be on screen at all, which is the
   * one thing the editor's hidden rendering exists to prevent.
   */
  hiddenStroke: 0.045,
  hiddenConnection: 0.047,
  /** Symbol outlines and pin LINES — KiCad's `LAYER_DEVICE`. */
  symbolStroke: 0.05,
  /** The connection ring marks a point on the pin, so it sits ABOVE it. */
  pinConnection: 0.052,
  /**
   * The DNP cross. KiCad draws it inside the `LAYER_DEVICE` pass after one
   * `AdvanceDepth()`, so it clears the body it strikes through and nothing
   * else — pin numbers, labels and fields all still land on top of it.
   */
  dnpMarker: 0.054,
  /** Buses — `LAYER_BUS`, over the symbols and just under the wires. */
  bus: 0.055,
  /** Wires — `LAYER_WIRE`, ABOVE the symbols they cross. */
  wire: 0.056,
  /** Free graphics on the sheet — `LAYER_NOTES`. */
  notes: 0.058,
  /** Label frames and the hierarchical glyph. */
  labelArrow: 0.06,
  noConnect: 0.062,
  junction: 0.064,
  /** Rule-area outlines — `LAYER_RULE_AREAS`, over every connection mark. */
  ruleArea: 0.066,
  /** Directive-label flags — `LAYER_NETCLASS_REFS`, just above rule areas. */
  directive: 0.068,
  hiddenText: 0.075,
  /** All document text: labels, symbol text, pin names and numbers. */
  text: 0.08,
  /** A symbol's Reference/Value, above its own body text. */
  fieldText: 0.09,
  dangling: 0.095,
  netHighlightPoint: 0.1,
  /** Tool previews and placement ghosts, above everything they'd replace. */
  preview: 0.14,
  /** How far BELOW its stroke a selection halo is drawn. Subtracted, not absolute. */
  glowOffset: 0.02,
  /**
   * Added to a SELECTED element's own paint so the whole item bubbles above
   * unselected content — its internal stacking (fill under stroke under text)
   * rides along unchanged, and the depth buffer resolves the overlap. This is
   * the one DYNAMIC entry in an otherwise static stack: applied per element at
   * selection time (`PrimitiveBatch.setElementZOffset`) and removed on
   * deselect, never baked into emitted geometry. Sized to clear every static
   * z above, including tool previews.
   */
  selectedLift: 0.5,
  /**
   * The lift a selected item's FILLS (`:fill` keys) take instead: above every
   * static z, but under `LIFT_SPLIT_Z`, so the halo composites over the item's
   * own body and every stroke inside it keeps its halo.
   */
  selectedFillLift: 0.15
} as const

const Z = SCHEMATIC_PAINT_ORDER

/** A selection's own fills, filed under `:fill` — see `Z.selectedFillLift`. */
const isFillKey = (key: string): boolean => key.endsWith(':fill')

/**
 * How far selection mixes a fill toward the halo color, so a selected
 * body takes its halo's hue and the two read as one selected thing. Less on
 * the light canvas, where the warm body and the blue are near-complementary
 * and a strong mix turns gray.
 */
const selectedFillTint = (): number => (currentAppTheme() === 'dark' ? 0.2 : 0.12)

/**
 * Where a graphic paints, and in what color when it names none: a symbol's
 * body (`LAYER_DEVICE`) or a free graphic on the sheet (`LAYER_NOTES`). One
 * emitter serves both, so a sheet polyline and a symbol polyline cannot
 * disagree about dashes, fills or hatching.
 */
interface GraphicStyle {
  stroke: THREE.Color
  /** Text drawn as one of the graphic's own items (a body or text-box text). */
  text: THREE.Color
  strokeZ: number
  fillZ: number
}
// A symbol's own body text is drawing, not a field: KiCad puts it on
// LAYER_DEVICE with the outline, so it takes the outline's color.
const SYMBOL_STYLE: GraphicStyle = {
  stroke: COLORS.symbol,
  text: COLORS.symbol,
  strokeZ: Z.symbolStroke,
  fillZ: Z.symbolFill
}
const POWER_STYLE: GraphicStyle = { ...SYMBOL_STYLE, stroke: COLORS.power, text: COLORS.power }
// Free sheet graphics read in the notes color, as annotation rather than as a
// part or a sheet.
const NOTES_STYLE: GraphicStyle = {
  stroke: COLORS.notes,
  text: COLORS.notes,
  strokeZ: Z.notes,
  fillZ: Z.notesFill
}
const RULE_AREA_STYLE: GraphicStyle = {
  stroke: COLORS.ruleArea,
  text: COLORS.notes,
  strokeZ: Z.ruleArea,
  fillZ: Z.notesFill
}

/** KiCad's default bus pen, `DEFAULT_BUS_WIDTH_MILS` (default_values.h). */
const DEFAULT_BUS_WIDTH = spacingToMm(12, 'mil')

/** The rectangle an image covers, centered on its `at`, at the size KiCad draws it. */
const imageFrame = (
  image: KicadSchematic['images'][number],
  version: number | undefined
): SymbolGraphic | null => {
  const info = pngInfo(image.data)
  if (!info) return null
  const size = imageSizeNm(info, image.scale, version)
  const half = { x: size.width / 2, y: size.height / 2 }
  return {
    type: 'rectangle',
    start: { x: nm(image.position.x - half.x), y: nm(image.position.y - half.y) },
    end: { x: nm(image.position.x + half.x), y: nm(image.position.y + half.y) },
    stroke: { width: nm(0) },
    fill: 'none'
  }
}

/** A bus entry as the two-point wire run it draws as. */
const busEntryRun = (
  entry: KicadBusEntry
): Pick<KicadWire, 'points' | 'width' | 'strokeType' | 'strokeColor'> => ({
  points: [
    entry.position,
    { x: nm(entry.position.x + entry.size.width), y: nm(entry.position.y + entry.size.height) }
  ],
  width: entry.width,
  strokeType: entry.strokeType,
  strokeColor: entry.strokeColor
})

/** The identity placement: symbol-local y-up nm is already sheet y-up nm. */
const SHEET_PLACEMENT = { position: { x: nm(0), y: nm(0), angle: 0 } }

/** A sheet graphic (y-down) in the y-up frame `addGraphic` reads. */
const flipGraphic = <G extends SymbolGraphic>(graphic: G): G => {
  const flip = (p: Point): Point => ({ x: p.x, y: nm(-p.y) })
  switch (graphic.type) {
    case 'line':
    case 'bezier':
      return { ...graphic, points: graphic.points.map(flip) }
    case 'rectangle':
      return { ...graphic, start: flip(graphic.start), end: flip(graphic.end) }
    case 'circle':
      return { ...graphic, center: flip(graphic.center) }
    case 'arc':
      return {
        ...graphic,
        start: flip(graphic.start),
        mid: flip(graphic.mid),
        end: flip(graphic.end)
      }
    default:
      return graphic
  }
}

/**
 * KiCad's default pen — provenance and value live at
 * `KICAD_DEFAULT_LINE_WIDTH` (newstroke.ts), shared with the text
 * auto-thickness rule. (Precision is not the concern for a render constant —
 * it never round-trips to a file.)
 * This is what a `(stroke (width 0))` means: not a
 * hairline, but "use the default", which is why a 0-width body outline and a pin
 * line draw at exactly the same weight in KiCad. The `ecc83-pp` demo leans on
 * this — `CONN_1`, `CONN_2`, `GND` and `ECC83` all carry `(width 0)` outlines.
 */
const DEFAULT_PEN_WIDTH = KICAD_DEFAULT_LINE_WIDTH

/**
 * The ring KiCad draws at an unconnected pin's connection point — its **dangling
 * indicator**, which in the symbol editor appears on every pin because nothing
 * there is connected to anything.
 *
 * Both numbers are KiCad's, read from source rather than eyeballed:
 * `TARGET_PIN_RADIUS = MilsToIU(15)` (`eeschema/sch_pin.h`) is the radius — in
 * mils there too, so it is spelled that way here — and
 * `GetDanglingIndicatorThickness() = defaultPenWidth / 3`
 * (`eeschema/sch_render_settings.h`) is the stroke. An earlier guess of 0.32 mm
 * radius / 0.09 mm stroke read as too small and too heavy against the real thing.
 *
 * Exported for the symbol editor's pin hit-test: the ring is part of what a
 * pin LOOKS like there, so clicking it must select the pin.
 */
export const PIN_CONNECTION_RADIUS = spacingToMm(15, 'mil')

/**
 * Gap between a pin's line and its name/number, **8 mil** — KiCad's
 * `getPinTextOffset() + PIN_TEXT_MARGIN`, where the first is
 * `MilsToIU(round(24 * DEFAULT_TEXT_OFFSET_RATIO))` = `MilsToIU(round(24*0.15))`
 * = 4 mil and the second is a flat 4 (`pin_layout_cache.cpp`).
 *
 * One term of the full perpendicular offset, which is assembled at
 * `perpendicular()` in the pin loop — the formula lives there. Both texts
 * anchor at the pin's midpoint along its length.
 */
const PIN_TEXT_CLEARANCE = spacingToMm(8, 'mil')

/**
 * Stroke weight of a pin's name/number text. KiCad draws BOTH with the PIN's
 * pen, not the text's own effects: the painter feeds `getLineWidth(aPin)` —
 * the 6-mil default line width, since `SCH_PIN::GetPenWidth()` returns 0 —
 * through `ClampTextPenSize(width, textSize, aStrict = true)`, i.e.
 * `min(width, 0.18 × size)` (`sch_painter.cpp`, `gr_text.cpp`). A
 * `(font (thickness …))` on the pin text never reaches KiCad's pin painter,
 * so it is deliberately ignored here too.
 */
const pinTextThickness = (fontHeight: number): number =>
  Math.min(DEFAULT_PEN_WIDTH, fontHeight * 0.18)
const PIN_CONNECTION_STROKE = DEFAULT_PEN_WIDTH / 3

/** KiCad's `DANGLING_SYMBOL_SIZE` (`default_values.h`): a dangling square's side, before its pen. */
const DANGLING_SIZE = spacingToMm(12, 'mil')
/** `GetDanglingIndicatorThickness()`: a third of the default pen, as the pin's ring. */
const DANGLING_STROKE = PIN_CONNECTION_STROKE

/** Where the canvas draws a dangling mark, and what is dangling there. */
export interface DanglingMark {
  position: Point
  kind: 'pin' | 'wire' | 'bus' | 'label' | 'global_label' | 'hierarchical_label' | 'sheet_pin'
}

/**
 * The selection halo pad, KiCad's way: `SCH_PAINTER::getShadowWidth` returns
 * `selection_thickness` (3) as PIXELS plus the same number as MILS — "a cross
 * between the zoom level and the default line width" — added to the item's
 * full stroke width, so 1.5 of each per side. The screen term keeps a halo
 * findable on a zoomed-out sheet; the world term keeps it hugging the geometry
 * when a symbol fills the screen. Both terms live in the glow batch's shader
 * (`padPixels`/`padWorld`), so the journal replays RAW stroke geometry and
 * zooming re-fits the halo for free.
 */
const GLOW_PAD_PIXELS = 1.5

/** The visual diff's removed items: the git red at this opacity (`setDiffPaint`). */
const REMOVED_OPACITY = 0.5
const GLOW_PAD_WORLD = spacingToMm(1.5, 'mil')

/**
 * World-z plane for the engine's split render (`setLiftSplitZ`), passed by
 * the viewports whenever a selection exists: above every static content z
 * (`Z.preview` 0.14) and below both the `Z.selectedLift`ed paint and the
 * selection chrome among it (`CHROME_STACK`, 0.57–0.71). The flattened halo
 * quad composites at this plane — over unselected content and a selection's
 * own fills (`Z.selectedFillLift`), under everything else selected.
 */
export const LIFT_SPLIT_Z = 0.2

/** Engine/world-space point: millimeters, y-up. Deliberately unbranded. */
type XY = { x: number; y: number }

/**
 * Where an item's EDGE hit ranks among the rest (`hitCandidates`): with the
 * labels (`small`), with the wires (`run`), or with the free strokes after them
 * (`stroke`). A hit only inside a filled body always ranks behind the symbols.
 */
type HitTier = 'small' | 'run' | 'stroke'

interface ItemHit {
  ref: SchematicItemRef
  shape: HitShape
  tier: HitTier
  /** The grid point a drag snaps the item by — the point the file positions it at. */
  pivot: XY
}

const boxOf = (box: THREE.Box2): HitBox => ({
  minX: box.min.x,
  minY: box.min.y,
  maxX: box.max.x,
  maxY: box.max.y
})

const boxOfPoints = (points: XY[]): HitBox => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y))
})

/** KiCad's `IsFilled`: every fill but none is a body a click lands inside. */
const isFilled = (fill: string): boolean => fill !== 'none' && fill !== ''

/**
 * THE domain→engine boundary: integer-nanometer y-down document coordinates
 * become millimeter y-up world coordinates. Everything below this line in the
 * scene is mm; nothing downstream should touch a domain field directly without
 * converting (nmToMm for scalars, this for points).
 */
const enginePoint = (point: { x: Nm; y: Nm }): XY => ({
  x: nmToMm(point.x),
  y: -nmToMm(point.y)
})

/**
 * KiCad's `(color R G B A)` as a renderer color. Built through a CSS string so
 * three.js applies the same sRGB handling it gives the hex literals in `COLORS`
 * — passing raw 0–1 components would land in the working space instead and a
 * file's red would not match a themed red.
 *
 * Alpha is dropped: `addLine` takes no per-stroke alpha, and a partly
 * transparent text is not a case any surface here supports yet.
 */
/**
 * `enginePoint` for geometry the pure sheet helpers computed: nanometer-valued
 * but unbranded, since their arithmetic leaves the integer grid.
 */
const sheetGeometryPoint = (point: XY): XY => ({ x: point.x / NM_PER_MM, y: -point.y / NM_PER_MM })

const rgbaToColor = (c: Rgba): THREE.Color => new THREE.Color(`rgb(${c.r}, ${c.g}, ${c.b})`)

const rotate = (point: XY, angleDegrees: number): XY => {
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos }
}

/** Everything `transformLocal` needs — a preview supplies this without a document. */
type SymbolPlacement = Pick<KicadSchematicSymbol, 'position' | 'mirror'>

/**
 * Symbol-local (nm, y-up lib space) → engine world (mm, y-up). The second
 * domain→engine boundary beside `enginePoint`: local geometry converts to mm
 * here, then mirrors/rotates/translates in engine space. Accepts fractional
 * nm inputs (midpoints, arc math) — the scale-down keeps them sub-precision.
 */
const transformLocal = (point: { x: number; y: number }, symbol: SymbolPlacement): XY => {
  // Rotate first, then mirror about the symbol's own axes as drawn — the
  // order KiCad composes them (`placedPoint` in connectivity.ts says why).
  const transformed = rotate(
    { x: point.x / NM_PER_MM, y: point.y / NM_PER_MM },
    symbol.position.angle
  )
  const x = symbol.mirror === 'y' ? -transformed.x : transformed.x
  const y = symbol.mirror === 'x' ? -transformed.y : transformed.y
  return {
    x: nmToMm(symbol.position.x) + x,
    y: -nmToMm(symbol.position.y) + y
  }
}

export class SchematicScene {
  private readonly scene: THREE.Scene
  private readonly primitives = new PrimitiveBatch(4096, { minStrokePixels: 1 })
  /** Separate small batch so net hover-highlight never disturbs the document batch. */
  private readonly highlight = new PrimitiveBatch(1024, { minStrokePixels: 1 })
  /** Persistent diagnostics overlay (dangling ends), independent of hover. */
  private readonly markers = new PrimitiveBatch(1024, { minStrokePixels: 1 })
  /** Transient tool feedback (wire rubber band), separate from the document. */
  private readonly preview = new PrimitiveBatch(512, { minStrokePixels: 1 })
  /**
   * The armed tool's ghost halo. Its own batch because the pad is a batch-wide
   * shader uniform: the ghost's strokes must stay at their real width while the
   * halo widens, and giving it the SAME uniforms as `glow` is what makes a
   * ghost read like the selected item it is about to become.
   */
  private readonly previewGlow = new PrimitiveBatch(512, {
    padPixels: GLOW_PAD_PIXELS,
    padWorld: GLOW_PAD_WORLD
  })
  /**
   * Selection halo and net-hover underlay live in the engine's overlay layer:
   * drawn OPAQUE there, flattened offscreen, and composited once at a uniform
   * global opacity — overlapping strokes can never accumulate alpha.
   */
  private readonly glow = new PrimitiveBatch(2048, {
    padPixels: GLOW_PAD_PIXELS,
    padWorld: GLOW_PAD_WORLD
  })
  private readonly netUnderlay = new PrimitiveBatch(1024, { minStrokePixels: 1 })
  /**
   * The visual diff's removed items, moved off the document onto a composite
   * layer (`diffCompositeLayers`): drawn as coverage and faded as one sheet, so
   * where their strokes overlap they do not print darker, and the layer sits
   * beneath the whole document, under everything that remains.
   */
  private readonly removedScene = new THREE.Scene()
  private readonly removedBatch = new PrimitiveBatch(1024, { minStrokePixels: 1 })
  private readonly removedLayer: CompositeLayerSpec = {
    scene: this.removedScene,
    color: new THREE.Color(),
    opacity: REMOVED_OPACITY,
    visible: false
  }
  /** Element key -> recorded strokes for the glow replay. */
  private readonly journal = new Map<string, GlowPrimitive[]>()
  /** Which journal keys are parts of which — see KeyHierarchy. */
  private readonly journalParts = new KeyHierarchy()

  /**
   * Where symbol strokes land. Normally the document batch; swapped to
   * `preview` while drawing a placement preview, so the preview is the REAL
   * geometry through the REAL emitter rather than a parallel ghost renderer.
   */
  private emitBatch: PrimitiveBatch = this.primitives
  /** Preview strokes are transient — journalling them would pollute the glow. */
  private emitJournal = true
  /**
   * Halo batch for the current emit, or null for plain document paint. Set,
   * every stroke is emitted twice: once RAW here (the batch's shader supplies
   * the pad), once as itself.
   */
  private emitGlow: PrimitiveBatch | null = null
  /**
   * Whether the symbol being emitted is dimmed — set only while `addSymbol`
   * draws a `(dnp yes)` instance. It is read at the four points where paint
   * reaches a batch rather than at every call site that names a color, which
   * is what keeps a new piece of symbol drawing dimmed by default instead of
   * by remembering.
   */
  private dimming = false
  /**
   * Rendering differences that belong to the SYMBOL EDITOR rather than the
   * schematic — all of them cases where authoring needs to see what a placed
   * instance must not show. See `setSymbolEditorMode`.
   */
  private symbolEditorMode = false
  /** Which hidden classes are drawn, once a caller says. See `setHiddenDisplay`. */
  private hiddenDisplay: { pins: boolean; fields: boolean } | null = null
  private readonly typefaceGroup = new THREE.Group()
  private readonly typefaceSprites = new Map<string, THREE.Sprite[]>()
  private readonly typefaceBounds = new THREE.Box3()
  private typefaceOrigins = new Map<string, THREE.Vector3[]>()
  /** Which sprite keys are parts of which, so a sheet's drag reaches its name. */
  private readonly typefaceParts = new KeyHierarchy()
  private readonly anchors: THREE.Group[] = []
  private readonly symbolBounds: THREE.Box2[] = []
  /**
   * Field text, for hit-testing and for the drag pivot. Its bounds come from
   * the glyph run `addStrokeText` measured, so what you can click is exactly
   * what was drawn — a field's extent depends on its justification and its
   * string, neither of which a bounding rule could restate correctly.
   */
  private readonly fieldHits: Array<{
    ref: SchematicItemRef
    anchor: { x: number; y: number }
    bounds: THREE.Box2
  }> = []
  private anchorOrigins = new Map<string, THREE.Vector3>()
  /**
   * Hit geometry for everything beyond wires, labels, symbols and sheets —
   * texts, graphics, buses, tables, images, directive labels, rule areas, and a
   * sheet's pins and name/file fields — each with the grid point a drag snaps
   * it by. Engine space, rebuilt with the document.
   */
  private readonly itemHits: ItemHit[] = []
  /** The anchor cross each text-like item shows while selected, by item key. */
  private readonly textAnchorPoints = new Map<string, XY>()
  // Engine-space hit-test geometry per item kind, rebuilt with the document.
  private wireRuns: XY[][] = []
  private junctionPoints: XY[] = []
  private noConnectPoints: XY[] = []
  private labelBounds: (THREE.Box2 | null)[] = []
  private readonly sheetBounds: THREE.Box2[] = []

  private readonly overlayScene: THREE.Scene

  // Grab handles for a single selected sheet's corners or wire's points
  // (raycast by the engine's 'vertex' drag path). Assigned in the constructor,
  // which is where `scene` becomes available to parent them to.
  private readonly sheetHandles: VertexHandles
  /** Anchor crosses on selected text — schematic fields, symbol-editor texts. */
  private readonly textAnchors: TextAnchors

  constructor(scene: THREE.Scene, overlayScene?: THREE.Scene) {
    this.scene = scene
    this.sheetHandles = new VertexHandles(scene)
    this.textAnchors = new TextAnchors(scene)
    // Without an engine overlay layer (tests, legacy callers) the halo
    // batches degrade to in-scene rendering.
    this.overlayScene = overlayScene ?? scene
    this.overlayScene.add(this.glow.mesh)
    this.overlayScene.add(this.netUnderlay.mesh)
    this.removedScene.add(this.removedBatch.mesh)
    this.scene.add(this.primitives.mesh)
    this.scene.add(this.highlight.mesh)
    this.scene.add(this.markers.mesh)
    this.scene.add(this.preview.mesh)
    // Document scene, not the overlay the selection halo composites through:
    // the ghost sits ABOVE the document, and the overlay is flattened beneath it.
    //
    // It must also draw BEFORE the strokes it haloes. Both batches are
    // transparent and depth-writing, so a stroke drawn first writes depth across
    // its antialiased fringe as well as its body, and the halo behind it is then
    // depth-rejected there — a hairline of background between glyph and halo.
    // Three.js would otherwise order the two by object id, which is creation
    // order.
    this.previewGlow.mesh.renderOrder = 0
    this.scene.add(this.previewGlow.mesh)
    this.scene.add(this.typefaceGroup)
    this.scene.add(this.fillGroup)
  }

  /** Refresh the selection handles and anchors after a live theme change. */
  public applyTheme(): void {
    this.sheetHandles.applyTheme()
    this.textAnchors.applyTheme()
  }

  /**
   * Targets the viewport must hand to `ViewportEngine.registerScreenScaled`, so
   * handles keep a constant on-screen size instead of growing with zoom.
   */
  public screenScaledTargets(): ScreenScaled[] {
    return [this.sheetHandles, this.textAnchors]
  }

  /**
   * Anchor crosses at the given engine-space points, or none — see
   * `TextAnchors`. The caller decides which selected items carry one: the
   * schematic passes its selected fields' pivots (`fieldPivot`), the symbol
   * editor its selected texts' `(at …)`.
   *
   * They ride a drag with the rest of the scene, through the same
   * `saveDragOriginKeys` / `translateElementKeys` / `clearDragOrigins` path the
   * paint moves on — so neither editor wires that up a second time.
   */
  public renderTextAnchors(points: XY[] | null): void {
    this.textAnchors.render(points)
  }

  /**
   * Corner resize handles for one selected sheet, or none. Engine-space corners
   * (y-up); `userData.corner` names which corner drags, `sheetIndex` which sheet.
   * The engine raycasts these as `type: 'vertex'` drags.
   */
  public renderSheetHandles(
    sheet: { index: number; x0: number; x1: number; yTop: number; yBottom: number } | null
  ): void {
    if (!sheet) {
      this.sheetHandles.render(null)
      return
    }
    this.sheetHandles.render([
      { x: sheet.x0, y: sheet.yTop, data: { sheetIndex: sheet.index, corner: 'tl' } },
      { x: sheet.x1, y: sheet.yTop, data: { sheetIndex: sheet.index, corner: 'tr' } },
      { x: sheet.x1, y: sheet.yBottom, data: { sheetIndex: sheet.index, corner: 'br' } },
      { x: sheet.x0, y: sheet.yBottom, data: { sheetIndex: sheet.index, corner: 'bl' } }
    ])
  }

  /**
   * A square grab handle on every point of one selected wire or bus, or none —
   * KiCad's wire point editor. Engine-space points (y-up); `userData.vertexOf`,
   * `index` and `vertex` name the point the handle drags. Shares the sheet's
   * handle layer, since only one item at a time carries handles.
   */
  public renderPointHandles(
    owner: { type: 'wire' | 'bus'; index: number } | null,
    points: XY[] = []
  ): void {
    if (!owner) {
      this.sheetHandles.render(null)
      return
    }
    this.sheetHandles.render(
      points.map((point, vertex) => ({
        x: point.x,
        y: point.y,
        data: { vertexOf: owner.type, index: owner.index, vertex }
      }))
    )
  }

  /**
   * Handles on one selected free graphic (`graphicHandleSpecs`), or none. Shares
   * the sheet's handle layer, since only one item at a time carries handles.
   */
  public renderGraphicHandles(specs: VertexHandleSpec[] | null): void {
    this.sheetHandles.render(specs)
  }

  /** Reposition the graphic handles in place — they ride a live resize. */
  public moveGraphicHandles(specs: VertexHandleSpec[]): void {
    this.sheetHandles.setPositions(specs)
  }

  /** The color to actually paint with, dimmed while a DNP symbol is emitting. */
  private paint(color: THREE.Color): THREE.Color {
    return this.dimming ? dimmed(color) : color
  }

  private journalAdd(key: string, entry: GlowPrimitive): void {
    if (!this.emitJournal) return
    const list = this.journal.get(key)
    if (list) list.push(entry)
    else {
      this.journal.set(key, [entry])
      // Symbol strokes are journalled under their PART names, so a selection
      // asking for `symbol:3` has to gather them — the same expansion
      // PrimitiveBatch does for the paint itself, through the same index, so
      // the halo can never cover a different set of strokes than the move.
      this.journalParts.add(key)
    }
  }

  // -------------------------------------------------------------------------
  // Triangulated fills — polylines, beziers and arcs.
  //
  // WHY these are meshes when rectangles, circles and text boxes are not: the
  // primitive batch draws analytic shapes (an SDF round-rect covers a rotated
  // rectangle and, with its corner radius run out, a disc), and those cost one
  // instance and drag for free. A polyline is an arbitrary polygon with no
  // analytic form, so it has to be triangulated. `THREE.ShapeUtils.triangulateShape`
  // is the same ear-clipper BoardScene fills zones with.
  //
  // Clipper2 is deliberately NOT involved: it does boolean ops (union, offset,
  // intersect), not triangulation, so it has nothing to contribute to filling a
  // single simple polygon. It would only earn its place if we had to make
  // self-intersecting outlines well-defined first, which KiCad symbol bodies are
  // not — and an ear-clipper degrades to a harmless partial fill there rather
  // than to a crash.
  //
  // The cost of not being in the batch is that drag, hide and teardown have to
  // be handled by hand below — which is exactly why the analytic shapes stay in
  // the batch rather than being moved here for uniformity.
  // -------------------------------------------------------------------------

  private readonly fillGroup = new THREE.Group()
  /** Element key -> its fill meshes. */
  private readonly fillMeshes = new Map<string, THREE.Mesh[]>()
  /** Which fill keys are parts of which, so a parent key reaches its children. */
  private readonly fillParts = new KeyHierarchy()
  /** Drag start positions, mirroring `typefaceOrigins`. */
  private readonly fillOrigins = new Map<string, THREE.Vector3[]>()
  /**
   * Fills go to the document only. Previews swap `emitBatch` to a transient
   * batch that is reset on its own; a mesh added during one would outlive it.
   */
  private emitFills = true
  /**
   * Set while `setSymbolPlacementPreview` draws: the symbol is paint only, so it
   * registers no anchor, bounds or field hit a click could find.
   */
  private previewingSymbol = false

  /**
   * Fill a closed polygon. Points are scene-space and must already be placed
   * (symbol transform applied) — the mesh carries no transform of its own.
   */
  private addPolygonFill(key: string, points: XY[], color: THREE.Color, z: number): void {
    if (!this.emitFills || points.length < 3) return
    const contour = points.map((p) => new THREE.Vector2(p.x, p.y))
    const faces = THREE.ShapeUtils.triangulateShape(contour, [])
    if (faces.length === 0) return
    const positions = new Float32Array(contour.length * 3)
    for (let i = 0; i < contour.length; i++) {
      positions[i * 3] = contour[i].x
      positions[i * 3 + 1] = contour[i].y
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(faces.flat())
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: this.paint(color) }))
    mesh.position.z = z
    // Below the batch mesh in draw order, matching the z these fills carry.
    mesh.renderOrder = Math.round(z * 10000)
    this.fillGroup.add(mesh)
    const list = this.fillMeshes.get(key)
    if (list) list.push(mesh)
    else {
      this.fillMeshes.set(key, [mesh])
      this.fillParts.add(key)
    }
  }

  private clearFills(): void {
    for (const mesh of this.fillGroup.children) {
      if (!(mesh instanceof THREE.Mesh)) continue
      mesh.geometry.dispose()
      const material = mesh.material as THREE.Material
      for (const entry of this.imageTextures.values()) entry.waiting.delete(material)
      material.dispose()
    }
    this.fillGroup.clear()
    this.fillMeshes.clear()
    this.fillParts.clear()
    this.fillOrigins.clear()
  }

  /** Fill meshes filed under `key` or any of its parts. */
  private fillsFor(key: string): Array<[string, THREE.Mesh[]]> {
    return this.fillParts
      .expand(key, (k) => this.fillMeshes.has(k))
      .map((k) => [k, this.fillMeshes.get(k) ?? []] as [string, THREE.Mesh[]])
  }

  /** Typeface sprites filed under `key` or any of its parts — a field's, a pin's. */
  private spritesFor(key: string): Array<[string, THREE.Sprite[]]> {
    return this.typefaceParts
      .expand(key, (k) => this.typefaceSprites.has(k))
      .map((k) => [k, this.typefaceSprites.get(k) ?? []] as [string, THREE.Sprite[]])
  }

  /** Every stroke recorded for `key`, including its parts'. */
  private journalFor(key: string): GlowPrimitive[] {
    const keys = this.journalParts.expand(key, (k) => this.journal.has(k))
    if (keys.length === 1) return this.journal.get(keys[0]) ?? []
    const strokes: GlowPrimitive[] = []
    for (const k of keys) {
      const list = this.journal.get(k)
      if (list) strokes.push(...list)
    }
    return strokes
  }

  private readonly anchorMap = new Map<string, THREE.Group>()

  /** Empty group carrying userData so ViewportEngine can resolve hits/drags. */
  private addAnchor(type: SchematicItemType, index: number, x: number, y: number): THREE.Group {
    const anchor = new THREE.Group()
    const key = `${type}:${index}`
    anchor.name = key
    anchor.userData = { type, index }
    anchor.position.set(x, y, 0.1)
    this.scene.add(anchor)
    this.anchors.push(anchor)
    this.anchorMap.set(key, anchor)
    return anchor
  }

  /** Each wire's and the buses' class styling on the instance shown (`classConnectionStyles`). */
  private connectionStyles: ClassConnectionStyles | null = null

  /** Take the class styling the next `rebuild` draws wires and buses with. */
  public setConnectionStyles(styles: ClassConnectionStyles | null): void {
    this.connectionStyles = styles
  }

  public rebuild(document: KicadSchematic): void {
    // The batch reset drops all lift state with its instances, and fills and
    // sprites are recreated at base z below — restoring a stale lift onto the
    // fresh objects would sink them by a full lift instead.
    this.liftedElementKeys = []
    this.primitives.reset()
    this.highlight.reset()
    this.markers.reset()
    this.resetPreview()
    this.glow.reset()
    this.netUnderlay.reset()
    this.clearRemovedLayer()
    this.journal.clear()
    this.journalParts.clear()
    this.clearTypefaceSprites()
    this.clearFills()
    this.imageBounds.makeEmpty()
    for (const anchor of this.anchors) this.scene.remove(anchor)
    this.anchors.length = 0
    this.anchorMap.clear()
    this.symbolBounds.length = 0
    this.fieldHits.length = 0
    this.itemHits.length = 0
    this.textAnchorPoints.clear()
    this.wireRuns = []
    this.junctionPoints = []
    this.noConnectPoints = []
    this.labelBounds = []
    this.sheetBounds.length = 0

    document.wires.forEach((wire, index) => {
      const run = this.addConnectionRun(
        `wire:${index}`,
        wire,
        DEFAULT_PEN_WIDTH,
        COLORS.wire,
        Z.wire,
        this.connectionStyles?.wires[index]
      )
      this.wireRuns[index] = run
      if (run.length) this.addAnchor('wire', index, run[0].x, run[0].y)
    })
    document.buses.forEach((bus, index) => {
      const classStyle = this.connectionStyles?.bus
      const run = this.addConnectionRun(
        `bus:${index}`,
        bus,
        DEFAULT_BUS_WIDTH,
        COLORS.bus,
        Z.bus,
        classStyle
      )
      const width =
        nmToMm(bus.width) > 0 ? nmToMm(bus.width) : (classStyle?.width ?? DEFAULT_BUS_WIDTH)
      if (run.length) {
        this.addItemHit({ type: 'bus', index }, 'run', run[0], {
          kind: 'path',
          points: run,
          closed: false,
          halfWidth: Math.max(width, DEFAULT_PEN_WIDTH) / 2,
          filled: false
        })
      }
    })
    // A bus entry is a stub of WIRE (`SCH_BUS_WIRE_ENTRY`, `LAYER_WIRE`): it
    // carries one member of the bus off it, so it draws as the wire it joins.
    document.busEntries.forEach((entry, index) => {
      const run = this.addConnectionRun(
        `bus_entry:${index}`,
        busEntryRun(entry),
        DEFAULT_PEN_WIDTH,
        COLORS.wire,
        Z.wire
      )
      this.addItemHit({ type: 'bus_entry', index }, 'small', run[0], {
        kind: 'path',
        points: run,
        closed: false,
        halfWidth: Math.max(nmToMm(entry.width), DEFAULT_PEN_WIDTH) / 2,
        filled: false
      })
    })

    // A dot touching a bus is a bus junction and takes the bus's color, as
    // KiCad moves it to LAYER_BUS_JUNCTION.
    const busRuns = document.buses.map((bus) => bus.points)
    document.junctions.forEach((junction, index) => {
      const point = enginePoint(junction)
      this.junctionPoints[index] = point
      this.addAnchor('junction', index, point.x, point.y)
      const onBus = busRuns.some((run) => onWireRun(junction, run))
      this.primitives.addRoundRect(
        `junction:${index}`,
        point.x,
        point.y,
        0.35,
        0.35,
        0.35,
        0,
        onBus ? COLORS.bus : COLORS.junction,
        1,
        Z.junction
      )
      this.journalAdd(`junction:${index}`, {
        kind: 'roundrect',
        x: point.x,
        y: point.y,
        halfW: 0.35,
        halfH: 0.35,
        radius: 0.35,
        rotation: 0,
        z: Z.junction
      })
    })

    document.noConnects.forEach((noConnect, index) => {
      const point = enginePoint(noConnect)
      this.noConnectPoints[index] = point
      this.addAnchor('no_connect', index, point.x, point.y)
      const r = 0.65
      this.addLine(
        `no_connect:${index}`,
        point.x - r,
        point.y - r,
        point.x + r,
        point.y + r,
        0.12,
        COLORS.noConnect,
        Z.noConnect
      )
      this.addLine(
        `no_connect:${index}`,
        point.x - r,
        point.y + r,
        point.x + r,
        point.y - r,
        0.12,
        COLORS.noConnect,
        Z.noConnect
      )
    })

    document.texts.forEach((item, index) => {
      const anchor = enginePoint(item.position)
      const bounds = this.addStrokeText(
        `text:${index}`,
        item.text,
        anchor,
        schematicTextAngle(item.position.angle),
        item.effects,
        COLORS.notes,
        Z.text
      )
      this.addTextItemHit({ type: 'text', index }, anchor, bounds)
    })

    document.labels.forEach((label, index) => {
      const key = `label:${index}`
      const point = enginePoint(label.position)
      this.addAnchor('label', index, point.x, point.y)
      this.textAnchorPoints.set(key, point)
      const shape = (label.shape ?? 'passive') as LabelShape
      const height = nmToMm(label.effects.fontSize.height)
      const direction = schematicLabelDirection(label.position.angle)
      const gap =
        label.type === 'hierarchical_label'
          ? hierarchicalTextGap(label.effects)
          : label.type === 'global_label'
            ? globalTextGap(height, shape)
            : 0
      const radians = (direction * Math.PI) / 180
      // The text's top is up the sheet for horizontal text, left for vertical
      // (KeepUpright reads it bottom to top).
      const textAngle = schematicTextAngle(label.position.angle)
      const lift = labelLift(label.type, label.effects)
      const textAnchor = {
        x: point.x + Math.cos(radians) * gap - (textAngle === 90 ? lift : 0),
        y: point.y + Math.sin(radians) * gap + (textAngle === 90 ? 0 : lift)
      }
      const textBounds = this.addStrokeText(
        key,
        label.text,
        textAnchor,
        textAngle,
        label.effects,
        label.type === 'global_label'
          ? COLORS.labelGlobal
          : label.type === 'hierarchical_label'
            ? COLORS.labelHierarchical
            : COLORS.label,
        Z.text
      )
      const bounds = textBounds?.clone() ?? new THREE.Box2()
      bounds.expandByPoint(new THREE.Vector2(point.x, point.y))
      this.labelBounds[index] = bounds
      // A local label is its text and nothing else, as in KiCad: the anchor
      // mark that used to be drawn here was a stray stub of wire under every
      // net name, and on a pin it read as a wire that went nowhere. The other
      // two kinds are drawn differently from each other, which is the whole
      // point — a global label's shape WRAPS its text, a hierarchical label's
      // is a glyph beside it (references/kicad-label-shapes.md).
      if (label.type !== 'label' && textBounds) {
        if (label.type === 'global_label') {
          // The extent ALONG the text, not the box's width: a label at 90° or
          // 270° reads up the sheet, so its bounding box is one glyph wide and
          // as long as the name is tall. Measuring the width there wrapped a
          // seven-character net in a flag the size of one letter.
          const along =
            direction === 90 || direction === 270
              ? textBounds.max.y - textBounds.min.y
              : textBounds.max.x - textBounds.min.x
          this.addGlobalLabelFlag(key, point, direction, height, along, shape, COLORS.labelGlobal)
        } else {
          this.addHierarchicalGlyph(key, point, direction, height, shape, COLORS.labelHierarchical)
        }
      }
    })

    // Block outlines: a rectangle that draws and connects nothing.
    document.shapes.forEach((shape, index) => {
      const graphic = shapeGraphic(shape)
      this.addSheetGraphic(`shape:${index}`, graphic)
      this.addGraphicHit({ type: 'shape', index }, graphic)
    })
    this.addSheetNotes(document)

    document.sheets.forEach((sheet, index) => {
      const key = `sheet:${index}`
      const x0 = nmToMm(sheet.position.x)
      const y0 = -nmToMm(sheet.position.y)
      const x1 = x0 + nmToMm(sheet.size.width)
      const y1 = y0 - nmToMm(sheet.size.height)
      this.addRectOutline(
        key,
        x0,
        y0,
        x1,
        y1,
        Math.max(nmToMm(sheet.strokeWidth) / 2, 0.07),
        COLORS.sheet,
        Z.sheetFrame
      )
      // Selectable/draggable like any item: an anchor keyed `sheet:index` and an
      // engine-space bounds box (y1 < y0, so min/max are ordered explicitly).
      this.addAnchor('sheet', index, x0, y0)
      this.sheetBounds[index] = new THREE.Box2(
        new THREE.Vector2(Math.min(x0, x1), Math.min(y0, y1)),
        new THREE.Vector2(Math.max(x0, x1), Math.max(y0, y1))
      )
      // A sheet's name and file are fields of it, as in KiCad: named beneath the
      // sheet so it still carries them, and selectable on their own.
      for (const property of sheet.properties) {
        const fieldKey = `${key}/${schematicFieldKey(property.key)}`
        const anchor = enginePoint(property.position)
        const bounds = this.addStrokeText(
          fieldKey,
          property.value,
          anchor,
          schematicTextAngle(property.position.angle),
          property.effects,
          COLORS.text,
          Z.text
        )
        if (bounds) {
          this.addTextItemHit({ type: 'sheet_field', index, field: property.key }, anchor, bounds)
        }
      }
      sheet.pins.forEach((pin, pinIndex) => {
        const pinKey = `${key}/pin:${pinIndex}`
        const anchor = enginePoint(pin.position)
        const pinHeight = nmToMm(pin.effects.fontSize.height)
        const pinDirection = sheetPinDirection(pin.position.angle, pin.effects.horizontalAlign)
        // Same offset as a hierarchical label, for the same reason: the name
        // has to start past the glyph rather than on top of it.
        const pinRadians = (pinDirection * Math.PI) / 180
        const pinGap = hierarchicalTextGap(pin.effects)
        const textBounds = this.addStrokeText(
          pinKey,
          pin.name,
          {
            x: anchor.x + Math.cos(pinRadians) * pinGap,
            y: anchor.y + Math.sin(pinRadians) * pinGap
          },
          schematicTextAngle(pin.position.angle),
          pin.effects,
          COLORS.labelHierarchical,
          Z.text
        )
        // A sheet pin is a hierarchical label — KiCad's SCH_SHEET_PIN derives
        // from SCH_HIERLABEL and shares this drawing — so the glyph says which
        // way the signal goes, and the shapes are the same five. The direction
        // is `sheetPinDirection`, not the text angle: `KeepUpright` folds 180
        // to 0 and 270 to 90, which cannot express left or down.
        const glyph = this.addHierarchicalGlyph(
          pinKey,
          anchor,
          pinDirection,
          pinHeight,
          sheetPinGlyphShape((pin.electricalType ?? 'passive') as LabelShape),
          COLORS.labelHierarchical
        )
        if (textBounds) glyph.union(textBounds)
        this.addTextItemHit({ type: 'sheet_pin', index, pin: pinIndex }, anchor, glyph)
      })
    })

    document.symbols.forEach((symbol, index) => this.addSymbol(document, symbol, index))
    this.releaseUnusedImages()
    this.primitives.finalizeSorted()
    if (this.diffPaint) this.applyDiffPaint(this.diffPaint)
  }

  /**
   * A wire, bus or bus entry: a point run at its own width, color and line
   * style, each where it names one, else its net class's, else the default pen.
   * Returns the run in engine space.
   */
  private addConnectionRun(
    key: string,
    run: Pick<KicadWire, 'points' | 'width' | 'strokeType' | 'strokeColor'>,
    defaultWidth: number,
    color: THREE.Color,
    z: number,
    classStyle?: ConnectionStyle | null
  ): XY[] {
    const points = run.points.map(enginePoint)
    const width = nmToMm(run.width) > 0 ? nmToMm(run.width) : (classStyle?.width ?? defaultWidth)
    const paint =
      run.strokeColor && !isColorUnset(run.strokeColor)
        ? rgbaToColor(run.strokeColor)
        : classStyle?.color
          ? rgbaToColor(classStyle.color)
          : color
    const lineStyle =
      run.strokeType && run.strokeType !== 'default'
        ? run.strokeType
        : (classStyle?.lineStyle ?? run.strokeType)
    this.addStrokedPath(key, points, Math.max(width, DEFAULT_PEN_WIDTH) / 2, paint, z, lineStyle)
    return points
  }

  /** A free graphic in sheet space (y-down nm), drawn as a note. */
  private addSheetGraphic(
    key: string,
    graphic: SymbolGraphic,
    style: GraphicStyle = NOTES_STYLE,
    closed = false
  ): void {
    this.addGraphic(key, flipGraphic(graphic), SHEET_PLACEMENT, (p) => p, style, closed)
  }

  /**
   * Everything on the sheet that annotates rather than connects: free
   * graphics, text boxes, tables, images, rule areas and directive labels.
   * Each is keyed `kind:index` into its array on the document.
   */
  private addSheetNotes(document: KicadSchematic): void {
    document.polylines.forEach(({ graphic }, index) => {
      this.addSheetGraphic(`polyline:${index}`, graphic)
      this.addGraphicHit({ type: 'polyline', index }, graphic)
    })
    document.circles.forEach(({ graphic }, index) => {
      this.addSheetGraphic(`circle:${index}`, graphic)
      this.addGraphicHit({ type: 'circle', index }, graphic)
    })
    document.arcs.forEach(({ graphic }, index) => {
      this.addSheetGraphic(`arc:${index}`, graphic)
      this.addGraphicHit({ type: 'arc', index }, graphic)
    })
    document.beziers.forEach(({ graphic }, index) => {
      this.addSheetGraphic(`bezier:${index}`, graphic)
      this.addGraphicHit({ type: 'bezier', index }, graphic)
    })
    document.textBoxes.forEach(({ graphic }, index) => {
      // The box KiCad draws is the stored rectangle whatever the text angle,
      // and a click anywhere in it lands on it (`SCH_TEXTBOX::HitTest`).
      const corner = enginePoint(graphic.position)
      const opposite = enginePoint({
        x: nm(graphic.position.x + graphic.size.width),
        y: nm(graphic.position.y + graphic.size.height)
      })
      this.addItemHit({ type: 'text_box', index }, 'stroke', corner, {
        kind: 'area',
        box: boxOfPoints([corner, opposite])
      })
      this.textAnchorPoints.set(`text_box:${index}`, corner)
      this.addSheetTextBox(`text_box:${index}`, graphic)
    })
    document.tables.forEach((table, index) => {
      this.addTable(`table:${index}`, table)
      const corners = table.cells.flatMap((cell) => [
        enginePoint(cell.position),
        enginePoint({
          x: nm(cell.position.x + cell.size.width),
          y: nm(cell.position.y + cell.size.height)
        })
      ])
      if (corners.length) {
        this.addItemHit({ type: 'table', index }, 'stroke', corners[0], {
          kind: 'area',
          box: boxOfPoints(corners)
        })
      }
    })
    document.images.forEach((image, index) => {
      const box = this.addImage(`image:${index}`, image, document.version)
      const center = enginePoint(image.position)
      this.addItemHit({ type: 'image', index }, 'stroke', center, {
        kind: 'area',
        box: box ?? boxOfPoints([center])
      })
    })
    // A rule area's outline is a polygon: KiCad closes it whether or not the
    // file repeats the first point.
    document.ruleAreas.forEach(({ graphic }, index) => {
      this.addSheetGraphic(`rule_area:${index}`, graphic, RULE_AREA_STYLE, true)
      this.addGraphicHit({ type: 'rule_area', index }, graphic, true)
    })
    document.directiveLabels.forEach((label, index) => {
      const key = `netclass_flag:${index}`
      const bounds = this.addDirectiveLabel(key, label)
      const anchor = enginePoint(label.position)
      this.textAnchorPoints.set(key, anchor)
      this.addItemHit({ type: 'netclass_flag', index }, 'small', anchor, {
        kind: 'box',
        box: boxOf(bounds)
      })
    })
  }

  /** A sheet text box: its frame where KiCad draws it, whatever the text angle. */
  private addSheetTextBox(key: string, graphic: Extract<SymbolGraphic, { type: 'textBox' }>): void {
    const frame = sheetTextBoxFrame(graphic)
    this.addGraphic(
      key,
      {
        ...graphic,
        position: { ...frame.position, x: nm(frame.position.x), y: nm(frame.position.y) },
        size: { width: nm(frame.size.width), height: nm(frame.size.height) }
      },
      SHEET_PLACEMENT,
      (p) => p,
      NOTES_STYLE
    )
  }

  /**
   * A drawing tool's item before the click that commits it: a scratch sheet
   * the tool's own writer filled (`drawTools.draftSheet`), drawn by the same
   * emitters as the document and haloed like a selection. No hits, no
   * journal, no fills: the ghost reads as a ghost and never catches a click.
   */
  public setDraftPreview(draft: KicadSchematic | null): void {
    this.resetPreview()
    if (!draft) return
    this.emitDraft(() => {
      draft.buses.forEach((bus, index) =>
        this.addConnectionRun(`draft-bus:${index}`, bus, DEFAULT_BUS_WIDTH, COLORS.bus, Z.bus)
      )
      draft.busEntries.forEach((entry, index) =>
        this.addConnectionRun(
          `draft-bus-entry:${index}`,
          busEntryRun(entry),
          DEFAULT_PEN_WIDTH,
          COLORS.wire,
          Z.wire
        )
      )
      draft.shapes.forEach((shape, index) =>
        this.addSheetGraphic(`draft-shape:${index}`, shapeGraphic(shape))
      )
      for (const [kind, graphics] of [
        ['polyline', draft.polylines],
        ['circle', draft.circles],
        ['arc', draft.arcs],
        ['bezier', draft.beziers]
      ] as const) {
        graphics.forEach(({ graphic }, index) =>
          this.addSheetGraphic(`draft-${kind}:${index}`, graphic)
        )
      }
      draft.ruleAreas.forEach(({ graphic }, index) =>
        this.addSheetGraphic(`draft-rule-area:${index}`, graphic, RULE_AREA_STYLE, true)
      )
      draft.tables.forEach((table, index) => this.addTable(`draft-table:${index}`, table))
      // A picture's pixels are a textured fill, which a ghost does not get: its frame stands in.
      draft.images.forEach((image, index) => {
        const frame = imageFrame(image, draft.version)
        if (frame) this.addSheetGraphic(`draft-image:${index}`, frame)
      })
      draft.textBoxes.forEach(({ graphic }, index) =>
        this.addSheetTextBox(`draft-text-box:${index}`, graphic)
      )
      draft.directiveLabels.forEach((label, index) =>
        this.addDirectiveLabel(`draft-directive:${index}`, label)
      )
      this.settleGhostFills()
    })
  }

  /**
   * A wire being drawn (sheet-space polyline: the clicked points plus the
   * elbow to the cursor), drawn as a bus being drawn is: the document's own
   * stroke, haloed like a selection, as KiCad shows the line it is placing.
   * Pass null to clear.
   */
  public setWireDraftPreview(points: Point[] | null): void {
    this.resetPreview()
    if (!points || points.length < 2) return
    this.emitDraft(() =>
      this.addConnectionRun(
        'draft-wire',
        { points, width: nm(0) },
        DEFAULT_PEN_WIDTH,
        COLORS.wire,
        Z.wire
      )
    )
  }

  /** Emit into the preview batch as a draft: haloed, no journal, no fills. */
  private emitDraft(emit: () => void): void {
    this.emitBatch = this.preview
    this.emitJournal = false
    this.emitFills = false
    this.emitGlow = this.previewGlow
    try {
      emit()
    } finally {
      this.emitBatch = this.primitives
      this.emitJournal = true
      this.emitFills = true
      this.emitGlow = null
    }
  }

  /** Record what a click on an item tests against, and the point it drags by. */
  private addItemHit(ref: SchematicItemRef, tier: HitTier, pivot: XY, shape: HitShape): void {
    this.itemHits.push({ ref, shape, tier, pivot })
  }

  /**
   * A text-like item: its glyph box is what a click lands on and its stored
   * point is both the drag pivot and the anchor cross. Text that drew nothing
   * (empty, hidden) is still reachable at its anchor.
   */
  private addTextItemHit(ref: SchematicItemRef, anchor: XY, bounds: THREE.Box2 | null): void {
    this.textAnchorPoints.set(itemKey(ref), anchor)
    this.addItemHit(ref, 'small', anchor, {
      kind: 'box',
      box: bounds && !bounds.isEmpty() ? boxOf(bounds) : boxOfPoints([anchor])
    })
  }

  /**
   * A free sheet graphic's outline, as `addGraphic` strokes it: the stroke at
   * its pen width, and the body too when filled (`EDA_SHAPE::hitTest`).
   */
  private addGraphicHit(ref: SchematicItemRef, graphic: SymbolGraphic, closed = false): void {
    if (graphic.type === 'text' || graphic.type === 'textBox') return
    const width = nmToMm(graphic.stroke.width)
    const halfWidth = (width > 0 ? width : DEFAULT_PEN_WIDTH) / 2
    const filled = isFilled(graphic.fill)
    const path = (points: XY[], isClosed: boolean, fillPolygon?: XY[]): HitShape => ({
      kind: 'path',
      points,
      closed: isClosed,
      halfWidth,
      filled,
      ...(fillPolygon ? { fillPolygon } : {})
    })
    switch (graphic.type) {
      case 'line':
      case 'bezier': {
        const placed = graphic.points.map(enginePoint)
        const points = graphic.type === 'bezier' ? bezierCurvePoints(placed) : placed
        if (points.length) this.addItemHit(ref, 'stroke', placed[0], path(points, closed))
        return
      }
      case 'rectangle': {
        const start = enginePoint(graphic.start)
        const end = enginePoint(graphic.end)
        const corners = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }]
        this.addItemHit(ref, 'stroke', start, path(corners, true))
        return
      }
      case 'circle': {
        const center = enginePoint(graphic.center)
        this.addItemHit(ref, 'stroke', center, {
          kind: 'circle',
          center,
          radius: nmToMm(graphic.radius),
          halfWidth,
          filled
        })
        return
      }
      case 'arc': {
        const start = enginePoint(graphic.start)
        const end = enginePoint(graphic.end)
        const arc = arcPath(start, enginePoint(graphic.mid), end)
        this.addItemHit(
          ref,
          'stroke',
          start,
          arc ? path(arc.points, false, [...arc.points, arc.center]) : path([start, end], false)
        )
        return
      }
    }
  }

  /**
   * A table: each cell's fill and text, laid out as a text box without a
   * border, then the table's borders and separators (`SCH_TABLE::DrawBorders`)
   * in their own strokes. A cell covered by a neighbor's span draws nothing.
   */
  private addTable(key: string, table: KicadSchematicTable): void {
    for (const cell of table.cells) {
      if (cell.span.cols === 0 || cell.span.rows === 0) continue
      const frame = sheetTextBoxFrame(cell)
      const options = strokeOptionsFromTextEffects(cell.effects)
      const layout = textBoxLayout(frame, cell.text, options)
      const corners = layout.corners.map((p) => transformLocal(p, SHEET_PLACEMENT))
      const fill = SchematicScene.fillColorFor(cell, COLORS.notes)
      if (fill) this.addQuadFill(`${key}:fill`, corners, fill, Z.notesFill)
      this.addStrokeText(
        key,
        layout.text,
        transformLocal(layout.anchor, SHEET_PLACEMENT),
        layout.angle,
        cell.effects,
        COLORS.text,
        Z.text
      )
    }
    for (const { a, b, stroke } of tableBorderSegments(table)) {
      if (stroke.width < 0) continue
      const width = nmToMm(stroke.width) > 0 ? nmToMm(stroke.width) : DEFAULT_PEN_WIDTH
      this.addStrokedPath(
        key,
        [sheetGeometryPoint(a), sheetGeometryPoint(b)],
        width / 2,
        SchematicScene.strokeColor(stroke, COLORS.notes),
        Z.notes,
        stroke.type
      )
    }
  }

  private static strokeColor(stroke: SymbolStroke, fallback: THREE.Color): THREE.Color {
    return stroke.color && !isColorUnset(stroke.color) ? rgbaToColor(stroke.color) : fallback
  }

  /**
   * A directive label: its flag (`directiveLabelGlyph`) at the default pen in
   * the label's own color or the theme's, and its fields. The label's text is
   * never drawn — KiCad's painter draws only the flag and the fields.
   */
  private addDirectiveLabel(key: string, label: KicadDirectiveLabel): THREE.Box2 {
    const glyph = directiveLabelGlyph(label)
    const color =
      label.effects.color && !isColorUnset(label.effects.color)
        ? rgbaToColor(label.effects.color)
        : COLORS.directive
    const half = DEFAULT_PEN_WIDTH / 2
    const outline = glyph.polyline.map(sheetGeometryPoint)
    // What a click on the flag lands on: the glyph and its shown fields.
    const bounds = new THREE.Box2()
    for (const point of outline) bounds.expandByPoint(new THREE.Vector2(point.x, point.y))
    this.addStrokedPath(key, outline, half, color, Z.directive, undefined)
    if (glyph.circle) {
      const center = sheetGeometryPoint(glyph.circle.center)
      const radius = glyph.circle.radius / NM_PER_MM
      bounds.expandByPoint(new THREE.Vector2(center.x - radius, center.y - radius))
      bounds.expandByPoint(new THREE.Vector2(center.x + radius, center.y + radius))
      if (glyph.circle.filled) {
        this.emitBatch.addRoundRect(
          `${key}:fill`,
          center.x,
          center.y,
          radius,
          radius,
          radius,
          0,
          color,
          1,
          Z.directive
        )
      }
      this.emitBatch.addRing(key, center.x, center.y, radius, half, color, 1, Z.directive)
      this.journalAdd(key, {
        kind: 'ring',
        x: center.x,
        y: center.y,
        radius,
        stroke: half,
        z: Z.directive
      })
    }
    for (const property of label.properties) {
      if (!property.value || property.hidden) continue
      const text = this.addStrokeText(
        key,
        shownFieldText(property),
        enginePoint(property.position),
        schematicTextAngle(property.position.angle),
        property.effects,
        COLORS.field,
        Z.text
      )
      if (text) bounds.union(text)
    }
    return bounds
  }

  /**
   * Called when paint that finished asynchronously — an image's texture —
   * lands, so an on-demand viewport can draw again.
   */
  public onAsyncPaint: (() => void) | null = null

  /**
   * Decoded images by their base64 data. Kept across rebuilds, so an edit
   * elsewhere on the sheet does not blank and re-decode every image; an entry
   * no rebuild used is disposed at the end of the next one.
   */
  private readonly imageTextures = new Map<
    string,
    { texture: THREE.Texture; loaded: boolean; waiting: Set<THREE.Material>; used: boolean }
  >()
  /** Extent of the image quads, which are not in the primitive batch. */
  private readonly imageBounds = new THREE.Box3()

  private imageTexture(data: string): {
    texture: THREE.Texture
    loaded: boolean
    waiting: Set<THREE.Material>
    used: boolean
  } | null {
    const found = this.imageTextures.get(data)
    if (found) {
      found.used = true
      return found
    }
    if (typeof Image === 'undefined') return null
    const texture = new THREE.Texture()
    texture.colorSpace = THREE.SRGBColorSpace
    const entry = { texture, loaded: false, waiting: new Set<THREE.Material>(), used: true }
    const image = new Image()
    image.onload = (): void => {
      texture.image = image
      texture.needsUpdate = true
      entry.loaded = true
      for (const material of entry.waiting) material.visible = true
      entry.waiting.clear()
      this.onAsyncPaint?.()
    }
    image.src = `data:image/png;base64,${data}`
    this.imageTextures.set(data, entry)
    return entry
  }

  /**
   * An `(image …)` as a textured quad centered on its `at`, at the size KiCad
   * draws it (`imageSizeNm`). Filed with the fills so it drags and hides with
   * its key. It stays invisible until its PNG has decoded, rather than
   * flashing an empty quad.
   */
  private addImage(
    key: string,
    image: KicadSchematic['images'][number],
    version: number | undefined
  ): HitBox | null {
    const info = pngInfo(image.data)
    if (!info || !this.emitFills) return null
    const size = imageSizeNm(info, image.scale, version)
    const width = size.width / NM_PER_MM
    const height = size.height / NM_PER_MM
    if (!(width > 0 && height > 0)) return null
    const center = enginePoint(image.position)
    const box = {
      minX: center.x - width / 2,
      minY: center.y - height / 2,
      maxX: center.x + width / 2,
      maxY: center.y + height / 2
    }
    // A bitmap has no strokes to halo, so a selected image haloes its frame.
    const corners = [
      { x: box.minX, y: box.minY },
      { x: box.maxX, y: box.minY },
      { x: box.maxX, y: box.maxY },
      { x: box.minX, y: box.maxY }
    ]
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % corners.length]
      this.journalAdd(key, {
        kind: 'capsule',
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        halfWidth: 0,
        z: Z.image
      })
    })
    this.imageBounds.expandByPoint(
      new THREE.Vector3(center.x - width / 2, center.y - height / 2, Z.image)
    )
    this.imageBounds.expandByPoint(
      new THREE.Vector3(center.x + width / 2, center.y + height / 2, Z.image)
    )
    const entry = this.imageTexture(image.data)
    if (!entry) return box
    const material = new THREE.MeshBasicMaterial({ map: entry.texture, transparent: true })
    material.visible = entry.loaded
    if (!entry.loaded) entry.waiting.add(material)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    mesh.position.set(center.x, center.y, Z.image)
    mesh.renderOrder = Math.round(Z.image * 10000)
    this.fillGroup.add(mesh)
    const list = this.fillMeshes.get(key)
    if (list) list.push(mesh)
    else {
      this.fillMeshes.set(key, [mesh])
      this.fillParts.add(key)
    }
    return box
  }

  /** Dispose the decoded images the last rebuild did not use. */
  private releaseUnusedImages(): void {
    for (const [data, entry] of this.imageTextures) {
      if (entry.used) {
        entry.used = false
        continue
      }
      entry.texture.dispose()
      this.imageTextures.delete(data)
    }
  }

  private addLine(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    color: THREE.Color,
    z: number
  ): void {
    if (this.emitGlow) {
      this.emitGlow.addCapsule(
        `${key}:glow`,
        x0,
        y0,
        x1,
        y1,
        halfWidth,
        COLORS.halo,
        1,
        z - Z.glowOffset
      )
    }
    this.emitBatch.addCapsule(key, x0, y0, x1, y1, halfWidth, this.paint(color), 1, z)
    this.journalAdd(key, { kind: 'capsule', x0, y0, x1, y1, halfWidth, z })
  }

  private addStrokeText(
    key: string,
    text: string,
    anchor: XY,
    angleDegrees: number,
    effects: KicadTextEffects,
    color: THREE.Color,
    z: number,
    include?: (point: XY) => XY
  ): THREE.Box2 | null {
    if (!text || effects.hidden) return null
    if (effects.face && effects.face !== 'KiCad Font') {
      return this.addTypefaceText(key, text, anchor, angleDegrees, effects, color, z, include)
    }
    // Shared with the symbol editor's text hit-test, so a click lands where the
    // glyphs actually are: see `strokeOptionsFromTextEffects`.
    const options = strokeOptionsFromTextEffects(effects)
    const thickness = options.thickness
    const layout = getTextStrokes(text, options)
    // A text's own `(font (color …))` wins over the caller's default, so every
    // text surface — symbol text, properties, labels — honors it from one place.
    const drawColor =
      effects.color && !isColorUnset(effects.color) ? rgbaToColor(effects.color) : color
    const angle = (angleDegrees * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const transform = (point: XY): XY => ({
      x: anchor.x + point.x * cos - point.y * sin,
      y: anchor.y + point.x * sin + point.y * cos
    })
    for (const stroke of layout.strokes) {
      const start = transform({ x: stroke.x1, y: stroke.y1 })
      const end = transform({ x: stroke.x2, y: stroke.y2 })
      include?.(start)
      include?.(end)
      this.addLine(key, start.x, start.y, end.x, end.y, thickness / 2, drawColor, z)
    }
    const bounds = new THREE.Box2()
    for (const corner of [
      { x: layout.bounds.minX, y: layout.bounds.minY },
      { x: layout.bounds.maxX, y: layout.bounds.minY },
      { x: layout.bounds.maxX, y: layout.bounds.maxY },
      { x: layout.bounds.minX, y: layout.bounds.maxY }
    ]) {
      const point = transform(corner)
      bounds.expandByPoint(new THREE.Vector2(point.x, point.y))
      include?.(point)
    }
    return bounds
  }

  private addTypefaceText(
    key: string,
    text: string,
    anchor: XY,
    angleDegrees: number,
    effects: KicadTextEffects,
    color: THREE.Color,
    z: number,
    include?: (point: XY) => XY
  ): THREE.Box2 {
    const fontPx = 160
    const paddingPx = 18
    // A typeface cannot draw KiCad's overbar or shift a script run, but it can
    // at least not spell the markup out: `~{RST}` reads RST.
    const lines = markupToPlainText(text).split('\n')
    const measureCanvas = document.createElement('canvas')
    const measure = measureCanvas.getContext('2d')!
    measure.font = `${effects.italic ? 'italic ' : ''}${effects.bold ? 'bold ' : ''}${fontPx}px "${effects.face}", sans-serif`
    const widths = lines.map((line) => measure.measureText(line).width)
    const maxWidthPx = Math.max(1, ...widths)
    const advancePx = fontPx * 1.5 * effects.lineSpacing
    const contentHeightPx = fontPx + Math.max(0, lines.length - 1) * advancePx
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(maxWidthPx + paddingPx * 2)
    canvas.height = Math.ceil(contentHeightPx + paddingPx * 2)
    const context = canvas.getContext('2d')!
    context.font = measure.font
    context.fillStyle = '#ffffff'
    context.textBaseline = 'middle'
    context.textAlign = effects.horizontalAlign
    const textX =
      effects.horizontalAlign === 'left'
        ? paddingPx
        : effects.horizontalAlign === 'right'
          ? canvas.width - paddingPx
          : canvas.width / 2
    lines.forEach((line, index) => {
      context.fillText(line, textX, paddingPx + fontPx / 2 + index * advancePx)
    })

    const fontWidthMm = nmToMm(effects.fontSize.width)
    const fontHeightMm = nmToMm(effects.fontSize.height)
    const worldWidth = (maxWidthPx / fontPx) * fontWidthMm
    const worldHeight =
      fontHeightMm + Math.max(0, lines.length - 1) * fontHeightMm * 1.5 * effects.lineSpacing
    const localBounds = {
      minX:
        effects.horizontalAlign === 'left'
          ? 0
          : effects.horizontalAlign === 'right'
            ? -worldWidth
            : -worldWidth / 2,
      maxX:
        effects.horizontalAlign === 'left'
          ? worldWidth
          : effects.horizontalAlign === 'right'
            ? 0
            : worldWidth / 2,
      minY:
        effects.verticalAlign === 'bottom'
          ? 0
          : effects.verticalAlign === 'top'
            ? -worldHeight
            : -worldHeight / 2,
      maxY:
        effects.verticalAlign === 'bottom'
          ? worldHeight
          : effects.verticalAlign === 'top'
            ? 0
            : worldHeight / 2
    }
    const angle = (angleDegrees * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const transform = (point: XY): XY => ({
      x: anchor.x + point.x * cos - point.y * sin,
      y: anchor.y + point.x * sin + point.y * cos
    })
    const center = transform({
      x: (localBounds.minX + localBounds.maxX) / 2,
      y: (localBounds.minY + localBounds.maxY) / 2
    })
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    const drawColor = this.paint(color)
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: drawColor,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      rotation: angle
    })
    material.userData.defaultColor = drawColor.clone()
    const sprite = new THREE.Sprite(material)
    const padWorld = (paddingPx / fontPx) * fontHeightMm
    sprite.position.set(center.x, center.y, z)
    sprite.scale.set(worldWidth + padWorld * 2, worldHeight + padWorld * 2, 1)
    sprite.renderOrder = 1000
    this.typefaceGroup.add(sprite)
    const sprites = this.typefaceSprites.get(key)
    if (sprites) sprites.push(sprite)
    else {
      this.typefaceSprites.set(key, [sprite])
      this.typefaceParts.add(key)
    }

    const bounds = new THREE.Box2()
    for (const corner of [
      { x: localBounds.minX, y: localBounds.minY },
      { x: localBounds.maxX, y: localBounds.minY },
      { x: localBounds.maxX, y: localBounds.maxY },
      { x: localBounds.minX, y: localBounds.maxY }
    ]) {
      const point = transform(corner)
      bounds.expandByPoint(new THREE.Vector2(point.x, point.y))
      this.typefaceBounds.expandByPoint(new THREE.Vector3(point.x, point.y, z))
      include?.(point)
    }
    return bounds
  }

  private clearTypefaceSprites(): void {
    for (const sprite of this.typefaceGroup.children) {
      if (!(sprite instanceof THREE.Sprite)) continue
      sprite.material.map?.dispose()
      sprite.material.dispose()
    }
    this.typefaceGroup.clear()
    this.typefaceSprites.clear()
    this.typefaceParts.clear()
    this.typefaceOrigins.clear()
    this.typefaceBounds.makeEmpty()
  }

  /**
   * A closed outline through `points`, given in the label's own frame (x along
   * the text direction, y across it) and rotated onto the sheet.
   */
  private addOutline(
    key: string,
    anchor: XY,
    angleDegrees: number,
    points: ReadonlyArray<readonly [number, number]>,
    color: THREE.Color
  ): THREE.Box2 {
    const radians = (angleDegrees * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    const at = (point: readonly [number, number]): XY => ({
      x: anchor.x + point[0] * cos - point[1] * sin,
      y: anchor.y + point[0] * sin + point[1] * cos
    })
    const bounds = new THREE.Box2()
    for (let i = 0; i < points.length; i++) {
      const from = at(points[i])
      const to = at(points[(i + 1) % points.length])
      bounds.expandByPoint(new THREE.Vector2(from.x, from.y))
      this.addLine(key, from.x, from.y, to.x, to.y, 0.06, color, Z.labelArrow)
    }
    return bounds
  }

  /**
   * A hierarchical label's or sheet pin's glyph: KiCad's template at the
   * connection point, scaled by half the text height. The text is drawn
   * separately, beside it — there is no box, which is what distinguishes these
   * from a global label at a glance.
   */
  private addHierarchicalGlyph(
    key: string,
    anchor: XY,
    angleDegrees: number,
    textHeight: number,
    shape: LabelShape,
    color: THREE.Color
  ): THREE.Box2 {
    const half = textHeight / 2
    return this.addOutline(
      key,
      anchor,
      angleDegrees,
      HIER_GLYPH[shape].map(([x, y]) => [x * half, y * half] as const),
      color
    )
  }

  /**
   * A global label's flag: one outline enclosing the text, with the ends
   * chamfered by shape — `SCH_GLOBALLABEL::CreateGraphicShape`. The point is
   * what says which way the net is going, and a plain rectangle (which is what
   * this used to draw for every kind and shape) says nothing at all.
   */
  private addGlobalLabelFlag(
    key: string,
    anchor: XY,
    angleDegrees: number,
    textHeight: number,
    textWidth: number,
    shape: LabelShape,
    color: THREE.Color
  ): void {
    const margin = LABEL_BOX_EXPANSION * textHeight
    const half = textHeight / 2 + margin
    const length = textWidth + 2 * margin
    // KiCad builds this running -x from the anchor and then rotates; here x
    // already runs along the text, so the body extends +x and the chamfers are
    // mirrored to match.
    const pointedStart = shape !== 'output' && shape !== 'passive'
    const pointedEnd = shape !== 'input' && shape !== 'passive'
    const bodyStart = pointedStart ? half : 0
    const bodyEnd = length + (pointedStart ? half : 0)
    this.addOutline(
      key,
      anchor,
      angleDegrees,
      [
        [0, 0],
        [bodyStart, -half],
        [bodyEnd, -half],
        ...(pointedEnd ? ([[bodyEnd + half, 0]] as ReadonlyArray<readonly [number, number]>) : []),
        [bodyEnd, half],
        [bodyStart, half]
      ],
      color
    )
  }

  private addSymbol(document: KicadSchematic, symbol: KicadSchematicSymbol, index: number): void {
    const key = this.previewingSymbol ? `placement:${index}` : `symbol:${index}`
    if (!this.previewingSymbol)
      this.addAnchor('symbol', index, symbol.position.x, -symbol.position.y)

    const bounds = new THREE.Box2()
    // KiCad's two symbol extents, which the DNP cross is sized from: the BODY
    // (drawn items, no pins and no fields) and the body WITH its pins. Both are
    // gathered here rather than recomputed, since this loop already visits
    // every point either one is made of.
    const body = new THREE.Box2()
    const bodyAndPins = new THREE.Box2()
    let bodyExtent = false
    const include = (point: XY): XY => {
      const at = new THREE.Vector2(point.x, point.y)
      bounds.expandByPoint(at)
      if (bodyExtent) body.expandByPoint(at)
      return point
    }
    const geometry = resolveSymbolGeometry(document, symbol)
    const isPower = document.libSymbols.get(definitionIdOf(symbol))?.isPower ?? false
    const bodyStyle = isPower ? POWER_STYLE : SYMBOL_STYLE
    // A DNP instance draws in KiCad's dimmed paint throughout — body, pins,
    // pin text and fields — so the flag is raised for the whole symbol and
    // read where paint reaches a batch. `finally`, because an unwound throw
    // would dim the rest of the sheet.
    this.dimming = symbol.dnp

    try {
      // Paint goes under the most specific name the part has, so a single pin or
      // body line can be highlighted or moved. `PrimitiveBatch` gathers a
      // parent's children, so every existing caller passing `symbol:<i>` still
      // reaches all of it. See ARCHITECTURE.md §3.7.
      bodyExtent = true
      for (const { graphic, part } of geometry.graphics) {
        this.addGraphic(
          `${key}/${symbolPartKey('graphic', part)}`,
          graphic,
          symbol,
          include,
          bodyStyle
        )
      }
      bodyExtent = false
      bodyAndPins.copy(body)

      // Names of DIFFERENT pins line up because KiCad offsets every one of them by
      // the tallest name in the symbol, not by its own — so a symbol mixing text
      // sizes gets one straight row of names rather than a ragged one. Pins with no
      // shown name are skipped, exactly as KiCad skips them.
      const maxPinNameHalfHeight = geometry.pins.reduce(
        (tallest, { pin }) =>
          pin.name && pin.name !== '~'
            ? Math.max(tallest, nmToMm(pin.nameEffects.fontSize.height) / 2)
            : tallest,
        0
      )
      for (const { pin, part } of geometry.pins) {
        // Hidden pins draw gray, below, while a view switch shows them: on by
        // default in the symbol editor, off by default on a sheet (KiCad's).
        if (pin.hidden && !this.showsHidden('pins')) continue
        const pinKey = `${key}/${symbolPartKey('pin', part)}`
        const start = include(transformLocal(pin.position, symbol))
        const angle = (pin.position.angle * Math.PI) / 180
        const localEnd = {
          x: pin.position.x + Math.cos(angle) * pin.length,
          y: pin.position.y + Math.sin(angle) * pin.length
        }
        const end = include(transformLocal(localEnd, symbol))
        bodyAndPins.expandByPoint(new THREE.Vector2(start.x, start.y))
        bodyAndPins.expandByPoint(new THREE.Vector2(end.x, end.y))
        // Gray THROUGHOUT — line, connection ring, name and number: graying the
        // line alone leaves full-brightness text hanging off a gray stub, which
        // reads as a visible pin.
        const pinColor = pin.hidden ? COLORS.pinHidden : isPower ? COLORS.power : COLORS.pin
        const pinStrokeZ = pin.hidden ? Z.hiddenStroke : Z.symbolStroke
        const pinTextZ = pin.hidden ? Z.hiddenText : Z.text
        // Same default pen as a 0-width graphic, which is what makes the two meet
        // flush where a pin joins a body outline.
        this.addLine(
          pinKey,
          start.x,
          start.y,
          end.x,
          end.y,
          DEFAULT_PEN_WIDTH / 2,
          pinColor,
          pinStrokeZ
        )
        // The connection point — the end a wire attaches to, which is what a pin's
        // `(at …)` names. KiCad draws this ring in the symbol editor ONLY: on a
        // placed symbol the schematic's own wire snapping already shows it, so
        // marking every pin there would be noise. Hence the opt-in flag rather
        // than drawing it wherever a symbol appears.
        //
        // NOT journalled — it would widen into the selection halo and read as a
        // blob on the pin's end. The pin's own stroke already shapes that halo.
        if (this.symbolEditorMode) {
          this.emitBatch.addRing(
            `${pinKey}:conn`,
            start.x,
            start.y,
            PIN_CONNECTION_RADIUS,
            PIN_CONNECTION_STROKE / 2,
            pin.hidden ? COLORS.pinHidden : COLORS.pinConnection,
            1,
            pin.hidden ? Z.hiddenConnection : Z.pinConnection
          )
        }
        // The pin's direction is its ANGLE pushed through the symbol transform,
        // not `end - start`: a zero-length pin (ecc83-pp's GND, `(length 0)`)
        // has no geometric extent, and KiCad still orients pin text by the
        // angle (`PinDrawOrient` — GND's 270 reads vertical). The probe point
        // is not `include()`d: it is a direction, not geometry.
        const directionProbe = transformLocal(
          {
            x: pin.position.x + Math.cos(angle) * NM_PER_MM,
            y: pin.position.y + Math.sin(angle) * NM_PER_MM
          },
          symbol
        )
        const direction = new THREE.Vector2(
          directionProbe.x - start.x,
          directionProbe.y - start.y
        ).normalize()
        const textOrientation = pinTextOrientation(direction)
        // KiCad's "place pin names inside" is `pin_names offset > 0`, and it moves
        // BOTH texts, which is the part that was missing. From
        // `pin_layout_cache.cpp`:
        //   - names INSIDE  → name past the body end by the offset; number ABOVE.
        //   - names OUTSIDE → name ABOVE the pin at its midpoint, and the number
        //     driven BELOW so the two do not collide.
        // KiCad guards that last case on `showBothNameAndNumber` — name non-empty
        // AND names shown AND offset == 0 — so a pin whose name is hidden keeps
        // its number above. The ecc83-pp demo exercises it: `ECC83` and `R` set
        // `(pin_names (offset 0))`.
        const nameShown = !geometry.pinNamesHidden && !!pin.name && pin.name !== '~'
        const namesInside = geometry.pinNameOffset > 0
        const numberShown = !geometry.pinNumbersHidden && !!pin.number
        const showBothOutside = nameShown && numberShown && !namesInside
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        const nameThickness = pinTextThickness(nmToMm(pin.nameEffects.fontSize.height))
        const numberThickness = pinTextThickness(nmToMm(pin.numberEffects.fontSize.height))
        /**
         * KiCad's exact offset from the pin line to the text's CENTER:
         * `halfHeight + clearance + thickness` (`pin_layout_cache.cpp`). What
         * `halfHeight` is differs per text, and the asymmetry is KiCad's own:
         * the NAME uses the nominal size / 2 (`GetPinNameInfo`), but the NUMBER
         * uses half its measured string extents (`GetPinNumberInfo`) — the
         * nominal size inflated per side by 1.5 × the extents cache's OWN pen,
         * `GetPenSizeForNormal(size)` = size / 8 (`recomputeExtentsCache` +
         * `FONT::StringBoundaryLimits`), NOT the pin pen the number is drawn
         * with. Two pens, two roles: size/8 inflates the half-height, the pin
         * pen is the additive `thickness` term.
         */
        const perpendicular = (
          halfHeight: number,
          thickness: number,
          below = false
        ): { x: number; y: number } => {
          const gap = (halfHeight + PIN_TEXT_CLEARANCE + thickness) * (below ? -1 : 1)
          return {
            x: mid.x + textOrientation.above.x * gap,
            y: mid.y + textOrientation.above.y * gap
          }
        }
        if (nameShown) {
          const inside = {
            x: end.x + direction.x * nmToMm(geometry.pinNameOffset),
            y: end.y + direction.y * nmToMm(geometry.pinNameOffset)
          }
          this.addStrokeText(
            pinKey,
            pin.name,
            namesInside ? inside : perpendicular(maxPinNameHalfHeight, nameThickness),
            textOrientation.angle,
            {
              ...pin.nameEffects,
              thickness: mmToNm(nameThickness),
              // Outside, the name is centered over the pin like a number; inside,
              // it runs away from the body end, so it hangs off that end instead.
              horizontalAlign: namesInside ? textOrientation.nameAlign : 'center',
              verticalAlign: 'center'
            },
            pin.hidden ? COLORS.pinHidden : COLORS.pinName,
            pinTextZ,
            include
          )
        }
        if (numberShown) {
          const numberHeightMm = nmToMm(pin.numberEffects.fontSize.height)
          const numberAnchor = perpendicular(
            numberHeightMm / 2 + 1.5 * (numberHeightMm / 8),
            numberThickness,
            showBothOutside
          )
          this.addStrokeText(
            pinKey,
            pin.number,
            numberAnchor,
            textOrientation.angle,
            // CENTER, not bottom — `perpendicular()` returns the offset KiCad
            // measures to the text's CENTER (`m_VAlign = GR_TEXT_V_ALIGN_CENTER`
            // in `GetPinNumberInfo`). Bottom-justifying it here lifted every pin
            // number by the gap between the two justifications, 0.585 x its font
            // height — ~29 mil at 1.27 mm. The name already used center, which is
            // why names looked right and only numbers floated.
            {
              ...pin.numberEffects,
              thickness: mmToNm(numberThickness),
              horizontalAlign: 'center',
              verticalAlign: 'center'
            },
            pin.hidden ? COLORS.pinHidden : COLORS.pinNumber,
            pinTextZ,
            include
          )
        }
      }

      if (bounds.isEmpty()) {
        const center = transformLocal({ x: 0, y: 0 }, symbol)
        const half = 2.54
        bounds.set(
          new THREE.Vector2(center.x - half, center.y - half),
          new THREE.Vector2(center.x + half, center.y + half)
        )
        this.addRectOutline(
          key,
          center.x - half,
          center.y - half,
          center.x + half,
          center.y + half,
          0.08,
          COLORS.symbol
        )
      }

      // Every field is drawn that KiCad draws: the visible ones always, the
      // hidden ones — dimmed — while the view shows them. The symbol editor shows
      // them by default since you cannot position or unhide a field you cannot
      // see; a sheet only on its "Show hidden fields" switch.
      for (const property of symbol.properties) {
        // `ki_*` keys are metadata (fp filters, locked), never drawn.
        if (!property || !property.value || property.key.startsWith('ki_')) continue
        if (property.hidden && !this.showsHidden('fields')) continue
        const point = enginePoint(property.position)
        // A field carries its own name, so it can be haloed and moved on its own
        // — the one thing inside a schematic symbol that is separately selectable,
        // because moving a Reference is a thing people actually do. Nested under
        // the symbol, so selecting or dragging the symbol still reaches it.
        const fieldKey = `${key}/${schematicFieldKey(property.key)}`
        // Reference and Value are the identity fields and each takes its own
        // color — a power port's Value too, as KiCad draws it (LAYER_VALUEPART);
        // everything else (Footprint, Datasheet, …) is metadata and gets its
        // own, as KiCad colors them apart. A hidden field shown in the editor
        // is dimmed — and its `hidden` effect must be overridden here, because
        // `addStrokeText` declines to draw one at all, which is right for the
        // schematic and wrong for the surface that has to let you unhide it.
        const fieldColor = property.hidden
          ? COLORS.fieldHidden
          : property.key === 'Reference'
            ? COLORS.reference
            : property.key === 'Value'
              ? COLORS.value
              : COLORS.field
        // Library space is y-up like the renderer and draws the field as
        // stored; a placed symbol's field reads through the symbol's turn and
        // mirror, which can swap its angle and flip its justification.
        const drawn = this.symbolEditorMode
          ? null
          : schematicFieldDrawn(
              property.position.angle,
              property.effects.horizontalAlign,
              property.effects.verticalAlign,
              { angle: symbol.position.angle, mirror: symbol.mirror }
            )
        const textBounds = this.addStrokeText(
          fieldKey,
          shownFieldText(property),
          point,
          drawn ? drawn.angle : symbolFieldTextAngle(property.position.angle),
          {
            ...property.effects,
            ...(property.hidden ? { hidden: false } : {}),
            ...(drawn ? { horizontalAlign: drawn.horizontal, verticalAlign: drawn.vertical } : {})
          },
          fieldColor,
          property.hidden ? Z.hiddenText : Z.fieldText,
          include
        )
        if (textBounds && !this.previewingSymbol) {
          this.textAnchorPoints.set(fieldKey, { x: point.x, y: point.y })
          this.fieldHits.push({
            ref: { type: 'field', index, field: property.key },
            anchor: { x: point.x, y: point.y },
            bounds: textBounds
          })
        }
      }

      bounds.expandByScalar(0.7)
      if (!this.previewingSymbol) this.symbolBounds[index] = bounds
      if (symbol.dnp) this.addDnpMarker(key, body.isEmpty() ? bounds : body, bodyAndPins)
    } finally {
      this.dimming = false
    }
  }

  /**
   * The cross struck through a Do-Not-Populate symbol, sized KiCad's way
   * (`SCH_PAINTER::draw( const SCH_SYMBOL*, … )`): the body box grown by a
   * margin derived from HOW FAR THE PINS STICK OUT of it, so the cross clears
   * a wide part's body without swallowing a resistor's whole pin span. Each
   * axis' margin then borrows from the other, which is what keeps the cross
   * square-ish on a symbol that is tall and narrow. Its pen is three times the
   * default line width — the marker has to read at sheet zoom.
   *
   * Not journalled: it is not part of the symbol's shape, and widened into the
   * selection halo it would draw a filled X behind a selected part.
   */
  private addDnpMarker(key: string, body: THREE.Box2, bodyAndPins: THREE.Box2): void {
    if (body.isEmpty()) return
    // A symbol with no pins at all leaves nothing to measure an overhang
    // against; measuring against the body gives it zero, not an infinity.
    const outer = bodyAndPins.isEmpty() ? body : bodyAndPins
    const overhangX = Math.max(body.min.x - outer.min.x, outer.max.x - body.max.x)
    const overhangY = Math.max(body.min.y - outer.min.y, outer.max.y - body.max.y)
    const marginX = Math.max(overhangX * 0.6, overhangY * 0.3)
    const marginY = Math.max(overhangY * 0.6, marginX * 0.3)
    const x0 = body.min.x - marginX
    const x1 = body.max.x + marginX
    const y0 = body.min.y - marginY
    const y1 = body.max.y + marginY
    const halfWidth = (3 * DEFAULT_PEN_WIDTH) / 2
    const color = COLORS.dnp
    this.emitBatch.addCapsule(key, x0, y0, x1, y1, halfWidth, color, 1, Z.dnpMarker)
    this.emitBatch.addCapsule(key, x0, y1, x1, y0, halfWidth, color, 1, Z.dnpMarker)
  }

  /**
   * The color a graphic's outline strokes in: its own `(stroke (color …))` when
   * it carries one, otherwise the style's color. The `(0 0 0 0)` unset tuple
   * means "inherit" rather than "transparent black".
   *
   * A `text` has no stroke — its color is `(font (color …))`, which
   * `addStrokeText` prefers on its own — so it simply inherits here.
   */
  private static strokeColorFor(graphic: SymbolGraphic, fallback: THREE.Color): THREE.Color {
    const color = 'stroke' in graphic ? graphic.stroke.color : undefined
    return color && !isColorUnset(color) ? rgbaToColor(color) : fallback
  }

  /**
   * The color a graphic's `(fill …)` paints solid with, or null when it paints
   * nothing solid. KiCad's kinds (`SCH_PAINTER::getRenderColor`): `outline`
   * fills with the outline's own color, `background` with the body wash, and
   * `color` with its `(color …)` — or the outline's when it names none. A
   * hatch is lines, not paint; `addHatch` draws it.
   */
  private static fillColorFor(
    graphic: { fill: string; fillColor?: Rgba },
    strokeColor: THREE.Color
  ): THREE.Color | null {
    if (graphic.fill === 'outline') return strokeColor
    if (graphic.fill === 'background') return COLORS.symbolBody
    if (graphic.fill !== 'color') return null
    return graphic.fillColor && !isColorUnset(graphic.fillColor)
      ? rgbaToColor(graphic.fillColor)
      : strokeColor
  }

  /**
   * Fill a rotated rectangle given its four world corners, as an SDF round-rect
   * with zero corner radius — so a filled body costs one instance rather than a
   * triangulated mesh, and rotates and mirrors with the symbol for free (the
   * center, rotation and half-extents are all derived from the corners
   * themselves, whatever transform produced them).
   *
   * Deliberately NOT journalled: the journal drives the selection halo, and a
   * solid quad in it would replace the outline-shaped glow with a filled blob.
   * The outline strokes already describe the shape the halo should trace.
   */
  private addQuadFill(key: string, corners: XY[], color: THREE.Color, z: number): void {
    const [a, b, c] = corners
    const halfW = Math.hypot(b.x - a.x, b.y - a.y) / 2
    const halfH = Math.hypot(c.x - b.x, c.y - b.y) / 2
    if (halfW <= 0 || halfH <= 0) return
    this.emitBatch.addRoundRect(
      key,
      (corners[0].x + corners[2].x) / 2,
      (corners[0].y + corners[2].y) / 2,
      halfW,
      halfH,
      0,
      Math.atan2(b.y - a.y, b.x - a.x),
      this.paint(color),
      1,
      z
    )
  }

  /**
   * Stroke a path in a KiCad line style. Dashed styles restart at every vertex
   * of a polyline or polygon and run on round an arc or circle
   * (`continuous`) — how `STROKE_PARAMS::Stroke` walks the two.
   */
  private addStrokedPath(
    key: string,
    path: XY[],
    halfWidth: number,
    color: THREE.Color,
    z: number,
    lineStyle: string | undefined,
    continuous = false
  ): void {
    const pattern = strokeDashPattern(lineStyle, halfWidth * 2)
    if (!pattern) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        this.addLine(key, a.x, a.y, b.x, b.y, halfWidth, color, z)
      }
      return
    }
    for (const [a, b] of dashPath(path, pattern, !continuous)) {
      this.addLine(key, a.x, a.y, b.x, b.y, halfWidth, color, z)
    }
  }

  /**
   * A hatch fill's lines, laid in y-down sheet space so they fall where KiCad
   * puts them (the phase is pinned to the sheet), at half the outline's pen.
   * Filed under `:fill` and not journalled, like a solid fill.
   */
  private addHatch(
    key: string,
    polygon: XY[],
    graphic: { fill: string; fillColor?: Rgba },
    pen: number,
    strokeColor: THREE.Color,
    z: number
  ): void {
    const slopes = hatchSlopes(graphic.fill)
    if (!slopes) return
    const color =
      graphic.fillColor && !isColorUnset(graphic.fillColor)
        ? rgbaToColor(graphic.fillColor)
        : strokeColor
    const sheet = polygon.map((p) => ({ x: p.x, y: -p.y }))
    const half = hatchLineWidth(pen) / 2
    for (const [a, b] of hatchSegments(sheet, slopes, hatchLineSpacing(pen))) {
      this.emitBatch.addCapsule(`${key}:fill`, a.x, -a.y, b.x, -b.y, half, this.paint(color), 1, z)
    }
  }

  private addGraphic(
    key: string,
    graphic: SymbolGraphic,
    symbol: SymbolPlacement,
    include: (point: XY) => XY,
    style: GraphicStyle = SYMBOL_STYLE,
    closed = false
  ): void {
    // `(width 0)` means "use the default pen", not "hairline" — KiCad's own
    // rule, and why a 0-width body outline is exactly as heavy as a pin line.
    // Four of the six symbols in the ecc83-pp demo rely on it. A NEGATIVE
    // width draws no outline at all (`SCH_SHAPE::GetEffectiveWidth`).
    const strokeWidth = graphic.type === 'text' ? DEFAULT_PEN_WIDTH : nmToMm(graphic.stroke.width)
    const pen = strokeWidth > 0 ? strokeWidth : DEFAULT_PEN_WIDTH
    const stroke = pen / 2
    const stroked = !(strokeWidth < 0)
    const strokeColor = SchematicScene.strokeColorFor(graphic, style.stroke)
    const lineStyle = graphic.type === 'text' ? undefined : graphic.stroke.type
    const strokePath = (path: XY[], continuous = false): void => {
      if (stroked) {
        this.addStrokedPath(key, path, stroke, strokeColor, style.strokeZ, lineStyle, continuous)
      }
    }
    if (graphic.type === 'line' || graphic.type === 'bezier') {
      // A bezier's control points are placed first and curved through after: the
      // transform is affine, so flattening before or after it gives the same
      // curve, and this way the flattener stays in symbol-independent space.
      const placed = graphic.points.map((p) => include(transformLocal(p, symbol)))
      const path = graphic.type === 'bezier' ? bezierCurvePoints(placed) : placed
      // Filled polylines are ordinary in the standard library (1.9k with a
      // background fill), and are how a symbol body that isn't a rectangle gets
      // its wash. The polygon is the run of points, closed implicitly — KiCad
      // repeats the first point to close a body outline, and a fill of an
      // unclosed run is still the polygon its points enclose.
      const pathFill = SchematicScene.fillColorFor(graphic, strokeColor)
      if (pathFill) this.addPolygonFill(`${key}:fill`, path, pathFill, style.fillZ)
      const first = path[0]
      const last = path[path.length - 1]
      const isClosed = path.length > 2 && first && last && first.x === last.x && first.y === last.y
      if (graphic.type === 'line' && isClosed) {
        this.addHatch(key, path.slice(0, -1), graphic, pen, strokeColor, style.fillZ)
      }
      strokePath(closed && path.length > 2 && !isClosed ? [...path, path[0]] : path)
      return
    }
    if (graphic.type === 'rectangle') {
      const corners = [
        { x: graphic.start.x, y: graphic.start.y },
        { x: graphic.end.x, y: graphic.start.y },
        { x: graphic.end.x, y: graphic.end.y },
        { x: graphic.start.x, y: graphic.end.y }
      ].map((point) => include(transformLocal(point, symbol)))
      // Fill first, under the outline: a symbol body is a filled shape with an
      // edge, not an edge with paint on top.
      const fill = SchematicScene.fillColorFor(graphic, strokeColor)
      if (fill) this.addQuadFill(`${key}:fill`, corners, fill, style.fillZ)
      this.addHatch(key, corners, graphic, pen, strokeColor, style.fillZ)
      strokePath([...corners, corners[0]])
      return
    }
    if (graphic.type === 'circle') {
      const center = include(transformLocal(graphic.center, symbol))
      const edge = include(
        transformLocal({ x: graphic.center.x + graphic.radius, y: graphic.center.y }, symbol)
      )
      const radius = Math.hypot(edge.x - center.x, edge.y - center.y)
      // A disc is the same SDF round-rect with its corner radius run all the way
      // out to its half-extents, so a filled circle needs no second primitive.
      const circleFill = SchematicScene.fillColorFor(graphic, strokeColor)
      if (circleFill && radius > 0) {
        this.emitBatch.addRoundRect(
          `${key}:fill`,
          center.x,
          center.y,
          radius,
          radius,
          radius,
          0,
          this.paint(circleFill),
          1,
          style.fillZ
        )
      }
      const ring: XY[] = []
      const ringSegments = 64
      for (let i = 0; i <= ringSegments; i++) {
        const angle = (i / ringSegments) * Math.PI * 2
        ring.push({
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius
        })
      }
      this.addHatch(key, ring.slice(0, -1), graphic, pen, strokeColor, style.fillZ)
      if (!stroked) return
      if (strokeDashPattern(lineStyle, pen)) {
        strokePath(ring, true)
        return
      }
      if (this.emitGlow) {
        this.emitGlow.addRing(
          `${key}:glow`,
          center.x,
          center.y,
          radius,
          stroke,
          COLORS.halo,
          1,
          style.fillZ
        )
      }
      this.emitBatch.addRing(
        key,
        center.x,
        center.y,
        radius,
        stroke,
        this.paint(strokeColor),
        1,
        style.strokeZ
      )
      this.journalAdd(key, {
        kind: 'ring',
        x: center.x,
        y: center.y,
        radius,
        stroke,
        z: style.strokeZ
      })
      return
    }
    if (graphic.type === 'arc') {
      const start = include(transformLocal(graphic.start, symbol))
      const mid = include(transformLocal(graphic.mid, symbol))
      const end = include(transformLocal(graphic.end, symbol))
      // Flattened once, then both filled and stroked from it — the same
      // one-definition rule the bezier follows, so the wash cannot stop short of
      // the curve that bounds it.
      const arc = arcPath(start, mid, end)
      if (!arc) {
        strokePath([start, end])
        return
      }
      // A filled arc is a PIE SLICE: the region closed through the circle's
      // CENTER, not the segment cut off by the chord. Verified against KiCad 10
      // rather than assumed — a probe arc exported to SVG comes back as
      // `M<end> A… <start> L<center> Z`, and the `L` lands exactly the center
      // offset away. (A semicircle cannot tell the two apart, since its chord
      // runs through its center; a shallow arc separates them.)
      //
      // Only the FILL closes this way. The stroke below still draws the bare
      // arc — KiCad emits no radii and no chord for it.
      const arcFill = SchematicScene.fillColorFor(graphic, strokeColor)
      if (arcFill) {
        this.addPolygonFill(`${key}:fill`, [...arc.points, arc.center], arcFill, style.fillZ)
      }
      strokePath(arc.points, true)
      return
    }
    if (graphic.type === 'textBox') {
      // Border first, then the text — one `textBoxLayout` call for both, so the
      // box that draws and the text inside it can never describe different
      // geometry (and the hit-test measures from the same function).
      const options = strokeOptionsFromTextEffects(graphic.effects)
      const layout = textBoxLayout(graphic, graphic.text, options)
      const corners = layout.corners.map((p) => include(transformLocal(p, symbol)))
      // Fills like any other body shape. Every text_box in the standard library
      // is `fill none`, so this normally paints nothing — it is here for boxes
      // authored with a background, not to satisfy the shipped ones.
      const boxFill = SchematicScene.fillColorFor(graphic, strokeColor)
      if (boxFill) this.addQuadFill(`${key}:fill`, corners, boxFill, style.fillZ)
      strokePath([...corners, corners[0]])
      const anchor = include(transformLocal(layout.anchor, symbol))
      this.addStrokeText(
        key,
        layout.text,
        anchor,
        transformedTextAngle(layout.angle, (localPoint) => transformLocal(localPoint, symbol)),
        graphic.effects,
        style.text,
        Z.text,
        include
      )
      return
    }
    const point = include(transformLocal(graphic.position, symbol))
    this.addStrokeText(
      key,
      graphic.text,
      point,
      // Two-state in symbol space first, then through the placement transform:
      // KiCad decides a body text's horizontal/vertical from the stored angle
      // alone, and the symbol's own rotation turns that decision, not the number.
      transformedTextAngle(symbolBodyTextAngle(graphic.position.angle), (localPoint) =>
        transformLocal(localPoint, symbol)
      ),
      graphic.effects,
      style.text,
      Z.text,
      include
    )
  }

  private addRectOutline(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    stroke: number,
    color: THREE.Color,
    z: number = Z.symbolStroke
  ): void {
    this.addLine(key, x0, y0, x1, y0, stroke, color, z)
    this.addLine(key, x1, y0, x1, y1, stroke, color, z)
    this.addLine(key, x1, y1, x0, y1, stroke, color, z)
    this.addLine(key, x0, y1, x0, y0, stroke, color, z)
  }

  /**
   * The visual diff's paint: items in `changed` keep their own colors, items in
   * `removed` move to a composite layer (`diffCompositeLayers`) that draws them
   * as one faded red beneath everything that remains, and everything else paints in the DNP dim
   * — hue gone, halfway to the page — so only the changes carry color. Keys are
   * element keys, whole items (`symbol:3`, `wire:12`) or parts
   * (`symbol:0/pin:0.1.1.2`). Null draws everything as usual.
   * Takes effect at the next `rebuild`, which paints from scratch.
   */
  public setDiffPaint(paint: SchematicDiffPaint | null): void {
    this.diffPaint = paint
  }

  private diffPaint: SchematicDiffPaint | null = null

  /** For `ViewportEngine.setCompositeLayers`; the scene keeps it current. */
  public diffCompositeLayers(): CompositeLayerSpec[] {
    return [this.removedLayer]
  }

  private clearRemovedLayer(): void {
    this.removedBatch.reset()
    for (const child of [...this.removedScene.children]) {
      if (child === this.removedBatch.mesh) continue
      this.removedScene.remove(child)
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
        child.material.dispose()
      }
    }
    this.removedLayer.visible = false
  }

  private applyDiffPaint(paint: SchematicDiffPaint): void {
    // A key is painted by the most specific entry that names it: itself, a
    // part it belongs to (`symbol:3/pin:0.1.1.2` for that pin's name text), or
    // its item (`symbol:3`).
    const statusOf = (key: string): 'changed' | 'removed' | 'unchanged' => {
      const item = /^[a-z_-]+:\d+/.exec(key)?.[0]
      const candidates: string[] = []
      for (let cut = key.length; cut > 0; cut = key.lastIndexOf('/', cut - 1)) {
        candidates.push(key.slice(0, cut))
      }
      if (item) candidates.push(item)
      for (const candidate of candidates) {
        if (paint.changed.has(candidate)) return 'changed'
        if (paint.removed.has(candidate)) return 'removed'
      }
      return 'unchanged'
    }
    this.primitives.repaintElements((key, color) =>
      statusOf(key) === 'unchanged' ? dimmed(color) : null
    )

    // Removed paint moves to its layer as white coverage; the layer tints it
    // the canvas's own rose (the no-connect's), so faded it still reads as the
    // sheet's red rather than a UI color.
    this.removedLayer.color.copy(COLORS.noConnect)
    const coverage = new THREE.Color(1, 1, 1)
    for (const key of SchematicScene.withPartAliases([...paint.removed])) {
      this.primitives.copyElementTo(key, this.removedBatch, coverage, 1)
      this.primitives.setElementHidden(key, true)
    }
    this.removedLayer.visible = paint.removed.size > 0

    for (const [key, sprites] of this.typefaceSprites) {
      const status = statusOf(key)
      for (const sprite of sprites) {
        if (status === 'changed') continue
        // A sprite is a texture, not coverage the layer can take: it fades in place.
        const next = status === 'removed' ? this.removedLayer.color : dimmed(sprite.material.color)
        sprite.material.color.copy(next)
        sprite.material.userData.defaultColor = next.clone()
        if (status === 'removed') sprite.material.opacity = REMOVED_OPACITY
      }
    }
    for (const [key, meshes] of this.fillMeshes) {
      const status = statusOf(key)
      for (const mesh of meshes) {
        const material = mesh.material
        if (!(material instanceof THREE.MeshBasicMaterial) || status === 'changed') continue
        if (status === 'unchanged') {
          material.color.copy(dimmed(material.color))
          continue
        }
        const copy = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: coverage }))
        copy.position.copy(mesh.position)
        copy.renderOrder = mesh.renderOrder
        this.removedScene.add(copy)
        mesh.visible = false
      }
    }
  }

  /**
   * Replay an element's journalled strokes into a halo batch, raw — the
   * batch's shader pad does the widening, so zooming re-fits it for free.
   */
  private replayJournal(
    target: PrimitiveBatch,
    haloKey: string,
    key: string,
    color: THREE.Color
  ): void {
    for (const entry of this.journalFor(key)) {
      const z = entry.z - Z.glowOffset
      if (entry.kind === 'capsule') {
        target.addCapsule(
          haloKey,
          entry.x0,
          entry.y0,
          entry.x1,
          entry.y1,
          entry.halfWidth,
          color,
          1,
          z
        )
      } else if (entry.kind === 'ring') {
        target.addRing(haloKey, entry.x, entry.y, entry.radius, entry.stroke, color, 1, z)
      } else {
        target.addRoundRect(
          haloKey,
          entry.x,
          entry.y,
          entry.halfW,
          entry.halfH,
          entry.radius,
          entry.rotation,
          color,
          1,
          z
        )
      }
    }
  }

  /**
   * Tint one net's geometry (hover highlight): a soft glow under the net's
   * wires plus rings at its pin/junction connection points. Pass null to
   * clear. Rendered from its own batch so the document batch, selection
   * colors, and drag translations stay untouched.
   */
  public setNetHighlight(geometry: NetHighlightGeometry | null): void {
    this.highlight.reset()
    this.netUnderlay.reset()
    if (!geometry) return
    geometry.wireRuns.forEach((run, runIndex) => {
      for (let index = 1; index < run.length; index++) {
        const a = enginePoint(run[index - 1])
        const b = enginePoint(run[index])
        this.netUnderlay.addCapsule(
          `net-wire:${runIndex}`,
          a.x,
          a.y,
          b.x,
          b.y,
          0.5,
          COLORS.netHighlight,
          1,
          Z.netHighlight
        )
      }
    })
    geometry.points.forEach((point, pointIndex) => {
      const p = enginePoint(point)
      this.highlight.addRing(
        `net-point:${pointIndex}`,
        p.x,
        p.y,
        0.55,
        0.1,
        COLORS.netHighlight,
        0.85,
        0.1
      )
    })
  }

  /**
   * Rubber-band preview of a wire being drawn (sheet-space polyline: the
   * committed draft points plus the pending elbow to the cursor). Pass null
   * or an empty run to clear. Drawn above the document so the draft never
   * hides under existing strokes.
   */
  public setWirePreview(points: Point[] | null): void {
    this.resetPreview()
    if (!points || points.length === 0) return
    const run = points.map(enginePoint)
    const start = run[0]
    this.preview.addRing(
      'wire-preview:start',
      start.x,
      start.y,
      0.35,
      0.09,
      COLORS.wire,
      0.9,
      Z.preview
    )
    for (let index = 1; index < run.length; index++) {
      this.preview.addCapsule(
        `wire-preview:${index}`,
        run[index - 1].x,
        run[index - 1].y,
        run[index].x,
        run[index].y,
        0.0762,
        COLORS.wire,
        0.85,
        Z.preview
      )
    }
  }

  /**
   * Wires redrawn under a drag, in place of the ones `setElementHidden` has
   * stepped aside (sheet-space polylines), and the junction dots the drop
   * would add. `alert` paints them in the DNP red: the drop would join or
   * break a net. Pass null to clear.
   */
  public setDragWirePreview(
    runs: Point[][] | null,
    alert = false,
    junctions: Point[] = [],
    busRuns: Point[][] = []
  ): void {
    this.resetPreview()
    if (!runs) return
    const color = alert ? COLORS.dnp : COLORS.wire
    // Buses step aside the same way, in the bus's color and pen.
    busRuns.forEach((points, runIndex) => {
      const run = points.map(enginePoint)
      for (let index = 1; index < run.length; index++) {
        this.preview.addCapsule(
          `drag-bus:${runIndex}:${index}`,
          run[index - 1].x,
          run[index - 1].y,
          run[index].x,
          run[index].y,
          DEFAULT_BUS_WIDTH / 2,
          alert ? COLORS.dnp : COLORS.bus,
          0.9,
          Z.preview
        )
      }
    })
    junctions.forEach((junction, index) => {
      const point = enginePoint(junction)
      this.preview.addRoundRect(
        `drag-junction:${index}`,
        point.x,
        point.y,
        0.35,
        0.35,
        0.35,
        0,
        color,
        0.9,
        Z.preview
      )
    })
    runs.forEach((points, runIndex) => {
      const run = points.map(enginePoint)
      for (let index = 1; index < run.length; index++) {
        this.preview.addCapsule(
          `drag-wire:${runIndex}:${index}`,
          run[index - 1].x,
          run[index - 1].y,
          run[index].x,
          run[index].y,
          0.0762,
          color,
          0.9,
          Z.preview
        )
      }
    })
  }

  /**
   * Rubber-band preview of a hierarchical sheet being drawn (engine-space
   * rectangle: y-up, so y1 < y0). Shares the preview batch with the other
   * tools. Pass null to clear. The placeholder name/file text lives in the DOM
   * popover anchored at the rectangle, not in this WebGL batch.
   */
  public setSheetPreview(rect: { x0: number; y0: number; x1: number; y1: number } | null): void {
    this.resetPreview()
    if (!rect) return
    const corners: Array<[number, number]> = [
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x1, rect.y1],
      [rect.x0, rect.y1],
      [rect.x0, rect.y0]
    ]
    for (let index = 1; index < corners.length; index++) {
      this.preview.addCapsule(
        `sheet-preview:${index}`,
        corners[index - 1][0],
        corners[index - 1][1],
        corners[index][0],
        corners[index][1],
        0.08,
        COLORS.sheet,
        0.85,
        Z.preview
      )
    }
  }

  /**
   * Ghost of a symbol about to be placed: bounding outline + pin rings at
   * the cursor (sheet-space points, already rotated). Shares the preview
   * batch with the wire rubber band — the tools are mutually exclusive.
   */
  public setPlacementPreview(geometry: { outline: Point[]; pins: Point[] } | null): void {
    this.resetPreview()
    if (!geometry) return
    const run = geometry.outline.map(enginePoint)
    for (let index = 1; index < run.length; index++) {
      this.preview.addCapsule(
        `placement:${index}`,
        run[index - 1].x,
        run[index - 1].y,
        run[index].x,
        run[index].y,
        0.06,
        COLORS.symbol,
        0.7,
        Z.preview
      )
    }
    geometry.pins.forEach((pin, index) => {
      const p = enginePoint(pin)
      this.preview.addRing(
        `placement-pin:${index}`,
        p.x,
        p.y,
        0.3,
        0.09,
        COLORS.wire,
        0.85,
        Z.preview
      )
    })
  }

  /**
   * Preview of items about to be placed: the real graphics and pins, drawn
   * where they will land and haloed like a selected element. Reusing the
   * document emitter means there is no separate ghost visual to keep in step
   * with what actually appears — the preview IS the thing, highlighted.
   *
   * The items are in ABSOLUTE symbol space — already where they will be
   * written — so the placement is the identity. Handing this a position as well
   * would apply the offset twice.
   */
  /**
   * Draw symbol primitives through the document emitter into `batch`, so a
   * preview is the real geometry rather than an approximation of it.
   */
  private emitSymbolItems(
    items: { graphics: SymbolGraphic[]; pins: SymbolPin[] },
    keyPrefix: string,
    batch: PrimitiveBatch
  ): void {
    const placement: SymbolPlacement = { position: { x: nm(0), y: nm(0), angle: 0 } }
    const identity = (point: XY): XY => point
    this.emitBatch = batch
    this.emitJournal = false
    // Preview graphics draw as outlines: a preview batch is reset on its own,
    // and a fill mesh added here would outlive it. The ghost reads as a ghost.
    this.emitFills = false
    this.emitGlow = this.previewGlow
    try {
      items.graphics.forEach((graphic, index) =>
        this.addGraphic(`${keyPrefix}-graphic:${index}`, graphic, placement, identity)
      )
      items.pins.forEach((pin, index) => {
        const start = transformLocal(pin.position, placement)
        const angle = (pin.position.angle * Math.PI) / 180
        const end = transformLocal(
          {
            x: pin.position.x + Math.cos(angle) * pin.length,
            y: pin.position.y + Math.sin(angle) * pin.length
          },
          placement
        )
        // Body only: pin name/number belong to a resolved symbol's text rules.
        this.addLine(
          `${keyPrefix}-pin:${index}`,
          start.x,
          start.y,
          end.x,
          end.y,
          0.08,
          COLORS.symbol,
          Z.symbolStroke
        )
      })
    } finally {
      this.emitBatch = this.primitives
      this.emitJournal = true
      this.emitFills = true
      this.emitGlow = null
    }
  }

  /**
   * Preview of items about to be placed: the real graphics and pins, drawn
   * where they will land and haloed like a selected element. Reusing the
   * document emitter means there is no separate ghost visual to keep in step
   * with what actually appears — the preview IS the thing, highlighted.
   *
   * The items are in ABSOLUTE symbol space — already where they will be
   * written — so the placement is the identity.
   */
  /**
   * Switch the scene into symbol-editor rendering. Off by default: every one of
   * these would be wrong on a schematic sheet.
   *
   * - Pin **connection rings** (KiCad's dangling indicator, which in the editor
   *   lands on every pin since nothing is connected).
   * - **Hidden pins** drawn dimmed instead of omitted — you cannot unhide what
   *   is not on screen.
   * - **Hidden fields** drawn dimmed instead of omitted.
   * - Field angles read as **library space** (y-up), not sheet space.
   */
  public setSymbolEditorMode(enabled: boolean): void {
    this.symbolEditorMode = enabled
  }

  /**
   * Which classes of `(hide yes)` item are drawn, dimmed — the "Show hidden
   * pins" and "Show hidden fields" switches on the symbol editor's and the
   * schematic's view rails. Until a caller says, the symbol editor shows both and a
   * sheet neither, which is KiCad's default on each; a caller must rebuild to
   * see a change.
   */
  public setHiddenDisplay(display: { pins: boolean; fields: boolean }): void {
    this.hiddenDisplay = { ...display }
  }

  /** Whether a hidden pin or field is on screen at all right now. */
  private showsHidden(kind: 'pins' | 'fields'): boolean {
    return this.hiddenDisplay ? this.hiddenDisplay[kind] : this.symbolEditorMode
  }

  /** Both halves of the tool ghost: its strokes and the halo under them. */
  private resetPreview(): void {
    this.preview.reset()
    this.previewGlow.reset()
    this.movePreview(0, 0)
    this.liftPreview(false)
  }

  /**
   * A ghost's fills, settled the way a selection settles its own: tinted, and
   * under the halo. Ghost and halo share one depth pass, so a fill left at its
   * document z would cover the halo of every stroke inside it.
   */
  private settleGhostFills(): void {
    const tint = selectedFillTint()
    for (const key of this.preview.elementKeys()) {
      if (!isFillKey(key)) continue
      this.preview.setElementZOffset(key, -Z.glowOffset)
      this.preview.tintElementColors(key, COLORS.halo, tint)
    }
  }

  /** The tool ghost into or out of the selected band (`Z.selectedLift`), where a selection draws. */
  private liftPreview(lifted: boolean): void {
    for (const batch of [this.preview, this.previewGlow])
      batch.mesh.position.z = lifted ? Z.selectedLift : 0
  }

  /**
   * The symbol about to be placed, as it will be placed and drawn as if
   * selected: the sheet's own `addSymbol` — body, pins, pin text, fields —
   * into the preview batch with its halo. `sheet` holds the symbol at the
   * origin; `movePreview` carries it to the cursor, so following the pointer
   * re-draws nothing.
   */
  public setSymbolPlacementPreview(sheet: KicadSchematic | null): void {
    this.resetPreview()
    if (!sheet) return
    this.emitBatch = this.preview
    this.emitJournal = false
    // Fill meshes live outside the preview batch and would not follow it.
    this.emitFills = false
    this.emitGlow = this.previewGlow
    this.previewingSymbol = true
    // Drawn at the document's own depths, then lifted whole, exactly as selecting lifts a part.
    this.liftPreview(true)
    try {
      sheet.symbols.forEach((symbol, index) => this.addSymbol(sheet, symbol, index))
      this.settleGhostFills()
    } finally {
      this.emitBatch = this.primitives
      this.emitJournal = true
      this.emitFills = true
      this.emitGlow = null
      this.previewingSymbol = false
    }
  }

  /**
   * A free sheet graphic as a live resize will leave it (sheet space), drawn
   * and haloed like the selection it stands in for; null clears it.
   */
  public setSheetGraphicPreview(graphic: SymbolGraphic | null, ruleArea = false): void {
    this.resetPreview()
    if (!graphic) return
    this.emitBatch = this.preview
    this.emitJournal = false
    this.emitFills = false
    this.emitGlow = this.previewGlow
    try {
      if (ruleArea) this.addSheetGraphic('preview-graphic', graphic, RULE_AREA_STYLE, true)
      else this.addSheetGraphic('preview-graphic', graphic)
      this.settleGhostFills()
    } finally {
      this.emitBatch = this.primitives
      this.emitJournal = true
      this.emitFills = true
      this.emitGlow = null
    }
  }

  /** Offset the tool ghost (engine mm, y up) without re-drawing it. */
  public movePreview(x: number, y: number): void {
    for (const batch of [this.preview, this.previewGlow]) {
      batch.mesh.position.x = x
      batch.mesh.position.y = y
    }
  }

  public setSymbolItemPreview(
    preview: { graphics: SymbolGraphic[]; pins: SymbolPin[] } | null
  ): void {
    this.resetPreview()
    if (!preview) return
    this.emitSymbolItems(preview, 'preview', this.preview)
    this.settleGhostFills()
  }

  /**
   * KiCad's dangling marks (`SCH_PAINTER::drawDanglingIndicator`,
   * `drawPinDanglingIndicator`): a circle at an unconnected pin's end, a square
   * at an open wire or bus end and at a label or sheet pin with nothing at its anchor,
   * each in its item's color brightened 0.3, as KiCad draws them so they stay
   * visible over a junction dot.
   */
  public setDanglingIndicators(marks: DanglingMark[]): void {
    this.markers.reset()
    const toLight = new THREE.Color(themeColor('--vscode-text-light', '#ffffff'))
    const halfStroke = DANGLING_STROKE / 2
    marks.forEach((mark, index) => {
      const p = enginePoint(mark.position)
      const key = `dangling:${index}`
      if (mark.kind === 'pin') {
        this.markers.addRing(
          key,
          p.x,
          p.y,
          PIN_CONNECTION_RADIUS,
          halfStroke,
          COLORS.pinConnection,
          1,
          Z.dangling
        )
        return
      }
      const color = (
        mark.kind === 'wire'
          ? COLORS.wire
          : mark.kind === 'bus'
            ? COLORS.bus
            : mark.kind === 'global_label'
              ? COLORS.labelGlobal
              : mark.kind === 'label'
                ? COLORS.label
                : COLORS.labelHierarchical
      )
        .clone()
        .lerp(toLight, 0.3)
      // KiCad grows the square by the pen it is given: the wire's, or half the mark's size.
      const pen =
        mark.kind === 'wire'
          ? DEFAULT_PEN_WIDTH
          : mark.kind === 'bus'
            ? DEFAULT_BUS_WIDTH
            : DANGLING_SIZE / 2
      const half = pen + DANGLING_SIZE / 2
      const corners: Array<[number, number]> = [
        [p.x - half, p.y - half],
        [p.x + half, p.y - half],
        [p.x + half, p.y + half],
        [p.x - half, p.y + half]
      ]
      corners.forEach(([x0, y0], side) => {
        const [x1, y1] = corners[(side + 1) % 4]
        this.markers.addCapsule(`${key}:${side}`, x0, y0, x1, y1, halfStroke, color, 1, Z.dangling)
      })
    })
  }

  private static segmentDistance(point: THREE.Vector2, a: XY, b: XY): number {
    const abx = b.x - a.x
    const aby = b.y - a.y
    const apx = point.x - a.x
    const apy = point.y - a.y
    const lengthSq = abx * abx + aby * aby
    if (lengthSq < 1e-12) return Math.hypot(apx, apy)
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSq))
    return Math.hypot(apx - t * abx, apy - t * aby)
  }

  /**
   * A field's anchor, in engine space — the drag pivot for field text.
   *
   * Field text has no anchor `THREE.Group` (those are keyed `type:index`, and
   * two fields of one symbol would collide), so a field hit carries its pivot
   * directly and the engine skips the scene traverse — the path `BoardScene`
   * already uses.
   */
  public fieldPivot(ref: SchematicItemRef): { x: number; y: number } | null {
    return (
      this.fieldHits.find((hit) => hit.ref.index === ref.index && hit.ref.field === ref.field)
        ?.anchor ?? null
    )
  }

  /**
   * Where a selected text-like item's anchor cross goes — the point its file
   * positions it at, which its glyphs do not show: a label's connection point,
   * a text's or a field's justification anchor, a sheet pin on its edge, a text
   * box's stored corner. Null for everything else.
   */
  public textAnchor(ref: SchematicItemRef): { x: number; y: number } | null {
    return this.textAnchorPoints.get(itemKey(ref)) ?? null
  }

  /** Nearest item under the cursor; small items outrank symbol bodies. */
  public hitTest(point: THREE.Vector2, threshold: number): SchematicItemRef | null {
    return this.hitCandidates(point, threshold)[0]?.levels[0]?.ref ?? null
  }

  /**
   * Everything under the cursor, best first, each described from the inside
   * out — what an editor's selection policy resolves against (`resolveHit`,
   * lib/selectionResolve.ts).
   *
   * The ranking is this scene's own and is deliberately NOT the board's
   * distance-then-z rule: here it is a fixed priority — small items before
   * symbol bodies, sheets last because they are large enough to swallow
   * everything sitting on them. Both encode real differences between the
   * documents; reconciling them would be a behavior change, not plumbing.
   *
   * Ordering within a type is reverse document order, so the item drawn last —
   * the one on top — wins between overlapping siblings.
   */
  public hitCandidates(
    point: THREE.Vector2,
    threshold: number
  ): Array<HitCandidate<SchematicItemRef>> {
    const near = (p: XY): boolean => Math.hypot(point.x - p.x, point.y - p.y) <= threshold
    const candidates: Array<HitCandidate<SchematicItemRef>> = []
    const add = (type: SchematicItemType, index: number): void => {
      candidates.push({ levels: [{ kind: type, ref: { type, index } }] })
    }
    // Everything `itemHits` holds, sorted into the tier its hit ranks in. A
    // sheet's pin and its fields arrive as two levels, so an editor that
    // filters them out resolves the click to the sheet instead.
    const tiers: Record<HitTier | 'inside', Array<HitCandidate<SchematicItemRef>>> = {
      small: [],
      run: [],
      stroke: [],
      inside: []
    }
    for (let i = this.itemHits.length - 1; i >= 0; i--) {
      const hit = this.itemHits[i]
      const kind: HitKind | null = hitShape(hit.shape, point, threshold)
      if (!kind) continue
      const { ref } = hit
      const levels: HitCandidate<SchematicItemRef>['levels'] = [
        { kind: schematicItemKind(ref.type), ref }
      ]
      if (ref.type === 'sheet_pin' || ref.type === 'sheet_field') {
        levels.push({ kind: 'sheet', ref: { type: 'sheet', index: ref.index } })
      }
      tiers[kind === 'inside' ? 'inside' : hit.tier].push({ levels })
    }

    for (let index = this.junctionPoints.length - 1; index >= 0; index--) {
      if (near(this.junctionPoints[index])) add('junction', index)
    }
    for (let index = this.noConnectPoints.length - 1; index >= 0; index--) {
      if (near(this.noConnectPoints[index])) add('no_connect', index)
    }
    for (let index = this.labelBounds.length - 1; index >= 0; index--) {
      const bounds = this.labelBounds[index]
      if (
        bounds &&
        bounds
          .clone()
          .expandByScalar(threshold * 0.5)
          .containsPoint(point)
      ) {
        add('label', index)
      }
    }
    candidates.push(...tiers.small)
    for (let index = this.wireRuns.length - 1; index >= 0; index--) {
      const run = this.wireRuns[index]
      for (let i = 0; i + 1 < run.length; i++) {
        if (SchematicScene.segmentDistance(point, run[i], run[i + 1]) <= threshold) {
          add('wire', index)
          break
        }
      }
    }
    candidates.push(...tiers.run, ...tiers.stroke)
    // Field text, before the symbol body it sits on: the ONLY thing inside a
    // schematic symbol a click can land on. It arrives as two levels, so an
    // editor that does not allow fields resolves it up to the symbol instead of
    // losing the click.
    for (let i = this.fieldHits.length - 1; i >= 0; i--) {
      const hit = this.fieldHits[i]
      if (
        !hit.bounds
          .clone()
          .expandByScalar(threshold * 0.5)
          .containsPoint(point)
      )
        continue
      candidates.push({
        levels: [
          { kind: 'field', ref: hit.ref },
          { kind: 'symbol', ref: { type: 'symbol', index: hit.ref.index } }
        ]
      })
    }
    for (let index = this.symbolBounds.length - 1; index >= 0; index--) {
      const bounds = this.symbolBounds[index]
      if (bounds?.clone().expandByScalar(threshold).containsPoint(point)) add('symbol', index)
    }
    // A filled body, a text box, a table or an image under the cursor: behind
    // every stroke and symbol, which may well be drawn over it.
    candidates.push(...tiers.inside)
    // Sheets are large; test them last so an item over a sheet body wins.
    for (let index = this.sheetBounds.length - 1; index >= 0; index--) {
      if (this.sheetBounds[index]?.clone().expandByScalar(threshold).containsPoint(point))
        add('sheet', index)
    }
    return candidates
  }

  /**
   * A rubber band takes symbols, never their fields.
   *
   * Deliberately not the click rule. A band over a symbol covers its Reference
   * too, and selecting both would move the text twice on the next drag — once
   * because the symbol carries its parts, once on its own. A field is something
   * you reach for individually, which is what clicking is for; KiCad sweeps the
   * same way.
   */
  public boxSelect(
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    crossing: boolean
  ): SchematicItemRef[] {
    const box = new THREE.Box2(
      new THREE.Vector2(bounds.xMin, bounds.yMin),
      new THREE.Vector2(bounds.xMax, bounds.yMax)
    )
    const selected: SchematicItemRef[] = []
    this.symbolBounds.forEach((symbolBounds, index) => {
      if (crossing ? box.intersectsBox(symbolBounds) : box.containsBox(symbolBounds))
        selected.push({ type: 'symbol', index })
    })
    this.wireRuns.forEach((run, index) => {
      if (!run.length) return
      const wireBox = new THREE.Box2()
      for (const point of run) wireBox.expandByPoint(new THREE.Vector2(point.x, point.y))
      if (crossing ? box.intersectsBox(wireBox) : box.containsBox(wireBox))
        selected.push({ type: 'wire', index })
    })
    this.labelBounds.forEach((labelBox, index) => {
      if (!labelBox) return
      if (crossing ? box.intersectsBox(labelBox) : box.containsBox(labelBox))
        selected.push({ type: 'label', index })
    })
    this.junctionPoints.forEach((point, index) => {
      if (box.containsPoint(new THREE.Vector2(point.x, point.y)))
        selected.push({ type: 'junction', index })
    })
    this.noConnectPoints.forEach((point, index) => {
      if (box.containsPoint(new THREE.Vector2(point.x, point.y)))
        selected.push({ type: 'no_connect', index })
    })
    this.sheetBounds.forEach((sheetBox, index) => {
      if (!sheetBox) return
      if (crossing ? box.intersectsBox(sheetBox) : box.containsBox(sheetBox))
        selected.push({ type: 'sheet', index })
    })
    // A sheet's pins and fields are reached for one at a time, like a symbol's.
    const band: HitBox = {
      minX: bounds.xMin,
      minY: bounds.yMin,
      maxX: bounds.xMax,
      maxY: bounds.yMax
    }
    for (const hit of this.itemHits) {
      if (hit.ref.type === 'sheet_pin' || hit.ref.type === 'sheet_field') continue
      if (shapeInBox(hit.shape, band, crossing)) selected.push(hit.ref)
    }
    return selected
  }

  /**
   * `boxSelect`'s items as candidates, each with the kind the selection filter
   * asks about — the band's answer in the shape a click's is (`hitCandidates`),
   * so both resolve through the same policy (lib/canvasSelection.ts). No lock
   * state: KiCad has no locked schematic item.
   */
  public boxCandidates(
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    crossing: boolean
  ): Array<HitCandidate<SchematicItemRef>> {
    return this.boxSelect(bounds, crossing).map((ref) => ({
      levels: [{ kind: schematicItemKind(ref.type), ref }]
    }))
  }

  public setSelection(items: SchematicItemRef[]): void {
    this.setSelectedElementKeys(items.map(itemKey))
  }

  /**
   * Halo the given element keys. Split out from `setSelection` so the symbol
   * editor can select PARTS (`symbol:0/pin:…`) through the schematic's own
   * halo rather than carrying a second highlight mechanism of its own.
   */
  /** Elements currently z-lifted by selection — restored before every change. */
  private liftedElementKeys: string[] = []

  /**
   * Bubble one element's own paint above (or back level with) unselected
   * content. Strokes and `:conn`/`:fill` batch aliases take an ABSOLUTE batch
   * offset (idempotent); typeface sprites and fill meshes move by a DELTA, so
   * apply/restore must stay strictly paired — `liftedElementKeys` is that
   * bookkeeping. Same per-key coverage as `translateElementKeys`, and the
   * same deliberate limits: the glow lives in the flattened overlay beneath
   * the document and is not lifted.
   */
  private applyElementLift(key: string, up: boolean): void {
    const tint = selectedFillTint()
    for (const alias of SchematicScene.withPartAliases([key])) {
      for (const resolved of this.primitives.resolveKeys(alias)) {
        const fill = isFillKey(resolved)
        this.primitives.setElementZOffset(
          resolved,
          up ? (fill ? Z.selectedFillLift : Z.selectedLift) : 0
        )
        if (fill && up) this.primitives.tintElementColors(resolved, COLORS.halo, tint)
      }
    }
    const delta = up ? Z.selectedLift : -Z.selectedLift
    for (const [, sprites] of this.spritesFor(key)) {
      for (const sprite of sprites) sprite.position.z += delta
    }
    for (const [fillKey, meshes] of this.fillsFor(key)) {
      const fill = isFillKey(fillKey)
      const lift = fill ? Z.selectedFillLift : Z.selectedLift
      for (const mesh of meshes) {
        mesh.position.z += up ? lift : -lift
        mesh.renderOrder = Math.round(mesh.position.z * 10000)
        const material = mesh.material
        if (!fill || !(material instanceof THREE.MeshBasicMaterial)) continue
        if (up) {
          material.userData.unselectedColor = material.color.clone()
          material.color.lerp(COLORS.halo, tint)
        } else if (material.userData.unselectedColor instanceof THREE.Color) {
          material.color.copy(material.userData.unselectedColor)
          delete material.userData.unselectedColor
        }
      }
    }
  }

  public setSelectedElementKeys(keys: string[]): void {
    const selectedColor = COLORS.selected
    this.glow.reset()
    this.primitives.resetColors()
    for (const key of this.liftedElementKeys) this.applyElementLift(key, false)
    this.liftedElementKeys = [...keys]
    // Original stroke colors stay untouched — the halo alone marks selection.
    // Typeface sprites (custom-font text) are the exception: they have no
    // journal strokes to replay, so a tint remains their only indicator.
    for (const sprites of this.typefaceSprites.values()) {
      for (const sprite of sprites) {
        const defaultColor = sprite.material.userData.defaultColor
        if (defaultColor instanceof THREE.Color) sprite.material.color.copy(defaultColor)
      }
    }
    for (const key of keys) {
      this.applyElementLift(key, true)
      for (const [, sprites] of this.spritesFor(key)) {
        for (const sprite of sprites) sprite.material.color.copy(selectedColor)
      }
      // Replay the element's strokes as a halo beneath it, OPAQUE in the
      // pre-mixed glow color so overlapping strokes (font glyphs, corner
      // joints) render one continuous shade. The geometry is replayed RAW:
      // the widening is the glow batch's shader pad (GLOW_PAD_PIXELS +
      // GLOW_PAD_WORLD per side, KiCad's getShadowWidth split), which also
      // means zoom changes re-fit every halo without a replay.
      this.replayJournal(this.glow, `glow:${key}`, key, COLORS.halo)
    }
  }

  /**
   * A part's paint can extend past its own key: a pin's connection ring
   * (`:conn`) and a graphic's fill (`:fill`) are batch instances filed under
   * SUFFIX keys. `KeyHierarchy` cuts at the first `/`, so those file as
   * children of the SYMBOL — a whole-symbol drag reaches them through
   * expansion, but a part-only drag (the symbol editor's normal case) must
   * name them itself, or the ring and fill stay behind until the drag-end
   * rebuild. `:glow` is preview-only paint; previews are rebuilt, not dragged.
   * Nonexistent aliases resolve to no instances and cost nothing.
   */
  private static withPartAliases(keys: string[]): string[] {
    return keys.flatMap((key) => [key, `${key}:conn`, `${key}:fill`])
  }

  public saveDragOrigins(items: SchematicItemRef[], extraKeys: string[] = []): void {
    this.saveDragOriginKeys([...dropKeysCoveredByParent(items.map(itemKey)), ...extraKeys])
  }

  /** `saveDragOrigins` by raw element key — see `setSelectedElementKeys`. */
  public saveDragOriginKeys(keys: string[]): void {
    // Anchor crosses are drawn for the selection, which is what a drag moves,
    // so they all travel — there is no per-key set to filter by.
    this.textAnchors.saveOrigins()
    this.primitives.saveOrigins(SchematicScene.withPartAliases(keys))
    this.glow.saveOrigins(keys.map((key) => `glow:${key}`))
    this.typefaceOrigins.clear()
    this.anchorOrigins.clear()
    for (const key of keys) {
      for (const [spriteKey, sprites] of this.spritesFor(key)) {
        this.typefaceOrigins.set(
          spriteKey,
          sprites.map((sprite) => sprite.position.clone())
        )
      }
      const anchor = this.anchorMap.get(key)
      if (anchor) this.anchorOrigins.set(key, anchor.position.clone())
      // Fills are not in the batch, so they need their own saved origins —
      // expanded, because a drag names the SYMBOL and the fills are its parts.
      for (const [childKey, meshes] of this.fillsFor(key)) {
        this.fillOrigins.set(
          childKey,
          meshes.map((mesh) => mesh.position.clone())
        )
      }
    }
  }

  public translateItems(items: SchematicItemRef[], delta: THREE.Vector2): void {
    // A symbol already carries its fields; moving both would offset the text
    // twice. See `dropKeysCoveredByParent`.
    this.translateElementKeys(dropKeysCoveredByParent(items.map(itemKey)), delta)
  }

  /** `translateItems` by raw element key — see `setSelectedElementKeys`. */
  public translateElementKeys(keys: string[], delta: THREE.Vector2, withAnchors = true): void {
    if (keys.length > 0 && withAnchors) this.textAnchors.translate(delta)
    for (const key of keys) {
      for (const alias of SchematicScene.withPartAliases([key])) {
        this.primitives.translateElement(alias, delta.x, delta.y)
      }
      this.glow.translateElement(`glow:${key}`, delta.x, delta.y)
      for (const [spriteKey, sprites] of this.spritesFor(key)) {
        const origins = this.typefaceOrigins.get(spriteKey)
        if (!origins) continue
        sprites.forEach((sprite, spriteIndex) => {
          const origin = origins[spriteIndex]
          if (origin) sprite.position.set(origin.x + delta.x, origin.y + delta.y, origin.z)
        })
      }
      const anchor = this.anchorMap.get(key)
      const origin = this.anchorOrigins.get(key)
      if (anchor && origin) anchor.position.set(origin.x + delta.x, origin.y + delta.y, origin.z)
      for (const [childKey, meshes] of this.fillsFor(key)) {
        const origins = this.fillOrigins.get(childKey)
        if (!origins) continue
        meshes.forEach((mesh, index) => {
          const from = origins[index]
          if (from) mesh.position.set(from.x + delta.x, from.y + delta.y, from.z)
        })
      }
    }
  }

  /**
   * Stop drawing an element while something else stands in for it — the symbol
   * editor's resize, where the shape changes and so cannot be expressed as an
   * offset of the real geometry.
   */
  public setElementHidden(key: string, hidden: boolean): void {
    this.primitives.setElementHidden(key, hidden)
    this.glow.setElementHidden(`glow:${key}`, hidden)
    // A resize stands in for the real shape; its fill has to step aside too, or
    // the old polygon stays painted under the preview.
    for (const [, meshes] of this.fillsFor(key)) {
      for (const mesh of meshes) mesh.visible = !hidden
    }
  }

  public showAllHidden(): void {
    this.primitives.showAllHidden()
    this.glow.showAllHidden()
    for (const meshes of this.fillMeshes.values()) {
      for (const mesh of meshes) mesh.visible = true
    }
  }

  public clearDragOrigins(): void {
    this.textAnchors.clearOrigins()
    this.primitives.clearOrigins()
    this.glow.clearOrigins()
    this.typefaceOrigins.clear()
    this.anchorOrigins.clear()
    this.fillOrigins.clear()
  }

  /**
   * The document as SVG, framed to `frame` (`schematicSvg.ts`). Only what the
   * document draws: hover, glow, previews and the dangling-end markers are the
   * editor's overlays, not the drawing, and stay out as they do from a print.
   */
  public toSvg(frame: THREE.Box3, background?: string): SchematicSvg {
    const fills: THREE.Mesh[] = []
    for (const meshes of this.fillMeshes.values()) fills.push(...meshes)
    let sprites = 0
    for (const list of this.typefaceSprites.values()) sprites += list.length
    return schematicToSvg({ primitives: this.primitives, fills, sprites, frame, background })
  }

  public getBounds(): THREE.Box3 {
    const bounds = new THREE.Box3()
    this.primitives.getBounds(bounds)
    bounds.union(this.typefaceBounds)
    bounds.union(this.imageBounds)
    return bounds
  }

  /** Scene-space bounds of what the selection paints where it is now, for zoom to selection. */
  public selectionBounds(): THREE.Box3 {
    const bounds = new THREE.Box3()
    for (const key of SchematicScene.withPartAliases(this.liftedElementKeys)) {
      this.primitives.elementBounds(key, bounds)
      for (const [, sprites] of this.spritesFor(key))
        for (const sprite of sprites) bounds.expandByObject(sprite)
      for (const [, meshes] of this.fillsFor(key))
        for (const mesh of meshes) bounds.expandByObject(mesh)
    }
    return bounds
  }

  /** Scene-space (Y-flipped) bounds of one placed symbol, for focus/zoom. */
  public getSymbolBounds(index: number): THREE.Box2 | undefined {
    const bounds = this.symbolBounds[index]
    return bounds && !bounds.isEmpty() ? bounds : undefined
  }

  /**
   * Test-only: every element key the document batch drew, with its rows. The
   * oracle for what a view switch takes off the canvas — see BoardScene's
   * `debugSnapshot`, which serves the same purpose there.
   */
  public debugElements(): Map<string, string[]> {
    return this.primitives.debugElements()
  }

  public dispose(): void {
    for (const anchor of this.anchors) this.scene.remove(anchor)
    this.scene.remove(this.primitives.mesh)
    this.scene.remove(this.highlight.mesh)
    this.scene.remove(this.markers.mesh)
    this.scene.remove(this.preview.mesh)
    this.scene.remove(this.previewGlow.mesh)
    this.scene.remove(this.typefaceGroup)
    this.clearFills()
    this.scene.remove(this.fillGroup)
    for (const entry of this.imageTextures.values()) entry.texture.dispose()
    this.imageTextures.clear()
    this.onAsyncPaint = null
    this.overlayScene.remove(this.glow.mesh)
    this.overlayScene.remove(this.netUnderlay.mesh)
    this.clearTypefaceSprites()
    this.primitives.dispose()
    this.highlight.dispose()
    this.markers.dispose()
    this.preview.dispose()
    this.previewGlow.dispose()
    this.glow.dispose()
    this.netUnderlay.dispose()
    this.clearRemovedLayer()
    this.removedBatch.dispose()
    this.sheetHandles.dispose()
    this.textAnchors.dispose()
  }
}
