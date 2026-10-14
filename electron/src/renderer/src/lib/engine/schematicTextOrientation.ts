/**
 * A unitless direction/offset vector in renderer space — deliberately NOT the
 * domain's `Point` (integer nanometers): everything here is unit vectors and
 * angle math, where a nanometer brand would be a lie.
 */
export interface Vec2 {
  x: number
  y: number
}

export interface PinTextOrientation {
  angle: number
  nameAlign: 'left' | 'right'
  above: Vec2
}

const normalizeDegrees = (angle: number): number => {
  const normalized = ((((angle + 180) % 360) + 360) % 360) - 180
  return Object.is(normalized, -0) ? 0 : normalized
}

/**
 * A sheet-space text angle — labels, text items, placed-symbol fields, sheet
 * fields — as the renderer draws it: `0` reading left-to-right or `90` reading
 * bottom-to-top, and nothing else.
 *
 * This is `EDA_ANGLE::KeepUpright`, which KiCad applies to every text it
 * places on a sheet: 180 is drawn as 0 and 270 as 90, and which side of the
 * anchor the text lands on is the justification's job, never the angle's.
 * There is **no sign flip** here even though sheet Y points down: KiCad stores
 * a sheet angle as displayed, counter-clockwise, so 90 means "reads upward" in
 * the file and on screen alike. An earlier version negated the angle on the
 * y-down argument and drew every vertical label, field and text top-to-bottom
 * — checked against `kicad-cli sch export` of the same sheet, which reads them
 * bottom-to-top.
 */
export const schematicTextAngle = (kicadAngle: number): number => {
  const angle = ((kicadAngle % 360) + 360) % 360
  return angle <= 45 || angle >= 315 || (angle > 135 && angle <= 225) ? 0 : 90
}

/**
 * The direction a sheet-space label *faces*, as a renderer angle: the way its
 * text extends from the anchor, which is the raw KiCad angle read
 * counter-clockwise — 0 right, 90 up, 180 left, 270 down. For the arrow on a
 * global or hierarchical label, which points along the text rather than along
 * the folded drawing angle.
 */
export const schematicLabelDirection = (kicadAngle: number): number =>
  ((kicadAngle % 360) + 360) % 360

/**
 * Symbol field angles are stored in the placed symbol's orientation frame.
 * Resolve that frame before converting from schematic to renderer coordinates.
 */
export const schematicFieldTextAngle = (fieldAngle: number, symbolAngle: number): number =>
  schematicTextAngle(fieldAngle - symbolAngle)

export type HorizontalJustify = 'left' | 'center' | 'right'
export type VerticalJustify = 'top' | 'center' | 'bottom'

/** A placed symbol's orientation: its `(at … angle)` and `(mirror …)`. */
export interface SymbolFrame {
  angle: number
  mirror?: 'x' | 'y'
}

/** A placed field as KiCad draws it on the sheet. */
export interface DrawnField {
  /** `schematicTextAngle` of the drawn text: 0 or 90. */
  angle: number
  horizontal: HorizontalJustify
  vertical: VerticalJustify
}

/** The symbol's rotate-then-mirror, on a y-up direction (as `transformLocal` places points). */
const symbolDirection = (v: Vec2, frame: SymbolFrame): Vec2 => {
  const radians = (Math.round(frame.angle / 90) * Math.PI) / 2
  const cos = Math.round(Math.cos(radians))
  const sin = Math.round(Math.sin(radians))
  const x = v.x * cos - v.y * sin
  const y = v.x * sin + v.y * cos
  return { x: frame.mirror === 'y' ? -x : x, y: frame.mirror === 'x' ? -y : y }
}

const flipHorizontal = (justify: HorizontalJustify): HorizontalJustify =>
  justify === 'left' ? 'right' : justify === 'right' ? 'left' : 'center'
const flipVertical = (justify: VerticalJustify): VerticalJustify =>
  justify === 'top' ? 'bottom' : justify === 'bottom' ? 'top' : 'center'

/**
 * How a placed symbol's field is drawn: its angle and the justification that
 * puts the text where KiCad does.
 *
 * KiCad keeps a field's angle and justification in the symbol's unturned
 * frame: `SCH_FIELD::GetBoundingBox` lays the box out from the stored
 * justification and angle, carries it through the symbol's transform, and
 * the painter draws the text centered in the result (`GetDrawRotation` for the
 * angle). So a symbol's turn or mirror can put the text on the other side of
 * its anchor — a right-justified field of a symbol turned 90° runs rightward.
 * The same flips map a drawn justification back to the stored one, so this is
 * its own inverse for a given field angle and frame.
 */
export const schematicFieldDrawn = (
  fieldAngle: number,
  horizontal: HorizontalJustify,
  vertical: VerticalJustify,
  frame: SymbolFrame
): DrawnField => {
  // Snapped to a quarter turn, the only angles a field or a symbol takes.
  const radians = (Math.round(fieldAngle / 90) * Math.PI) / 2
  const cos = Math.round(Math.cos(radians))
  const sin = Math.round(Math.sin(radians))
  // The stored text's reading direction and its "down", y-up, then turned.
  const reading = symbolDirection({ x: cos, y: sin }, frame)
  const down = symbolDirection({ x: sin, y: -cos }, frame)
  const angle = schematicTextAngle((Math.atan2(reading.y, reading.x) * 180) / Math.PI)
  // The drawn text's own reading direction and "down" at that angle.
  const drawnReading = angle === 90 ? { x: 0, y: 1 } : { x: 1, y: 0 }
  const drawnDown = angle === 90 ? { x: 1, y: 0 } : { x: 0, y: -1 }
  const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
  return {
    angle,
    horizontal: dot(reading, drawnReading) < 0 ? flipHorizontal(horizontal) : horizontal,
    vertical: dot(down, drawnDown) < 0 ? flipVertical(vertical) : vertical
  }
}

/**
 * A text angle read from **symbol library space**, which is already y-up like the
 * renderer — so unlike sheet space it needs **no sign flip**.
 *
 * Verified by plotting probe symbols with `kicad-cli sym export svg`: KiCad
 * renders 0° as L→R, 90° as bottom→top, 180° as R→L and 270° as top→bottom —
 * literally, in every quadrant.
 *
 * The fold into [-90, 90] is kept, so text never renders upside down. That
 * matches KiCad at 0/90/270 and deliberately differs at 180, where KiCad plots
 * the text reversed and this straightens it: a field authored upside down is
 * almost certainly a mistake, and reading it beats reproducing it.
 */
export const symbolFieldTextAngle = (fieldAngle: number): number => {
  const angle = normalizeDegrees(fieldAngle)
  if (angle > 90) return angle - 180
  if (angle < -90) return angle + 180
  return angle
}

/**
 * A **body** `(text …)` angle, which KiCad reads as two states rather than four.
 *
 * The same `kicad-cli sym export svg` probe that pins the literal quadrants
 * above says something different about body text: it plots horizontal at exactly
 * 0 and vertical bottom→top at every other angle (`900`, `1800`, `2700`, `450`
 * alike). Fields and body text really do differ — probed side by side, a field
 * at 180 plots R→L and one at 270 top→bottom, both literal.
 *
 * Applied in symbol-local space, before any placement transform, since that is
 * where KiCad makes the horizontal/vertical decision. `(text_box …)` is excluded:
 * the probe shows KiCad honoring its angle literally, upside down at 180 included.
 */
export const symbolBodyTextAngle = (textAngle: number): number =>
  normalizeDegrees(textAngle) === 0 ? 0 : 90

/**
 * KiCad keeps pin annotations readable after symbol rotation and mirroring.
 * When the pin points left/down, reverse the text baseline and justification
 * together so the text keeps flowing toward the symbol body without inversion.
 */
export const pinTextOrientation = (direction: Vec2): PinTextOrientation => {
  const sourceAngle = normalizeDegrees((Math.atan2(direction.y, direction.x) * 180) / Math.PI)
  const reversed = sourceAngle > 90 || sourceAngle <= -90
  const angle = normalizeDegrees(sourceAngle + (reversed ? 180 : 0))
  const radians = (angle * Math.PI) / 180
  const normalX = -Math.sin(radians)
  const normalY = Math.cos(radians)

  return {
    angle,
    nameAlign: reversed ? 'right' : 'left',
    // The left-hand normal of the readable baseline is consistently the
    // visual "above" side of a pin, independent of the original direction.
    above: {
      x: Math.abs(normalX) < 1e-12 ? 0 : normalX,
      y: Math.abs(normalY) < 1e-12 ? 0 : normalY
    }
  }
}

/** Resolve a local library-text angle through the symbol transform. */
export const transformedTextAngle = (
  localAngle: number,
  transform: (point: Vec2) => Vec2
): number => {
  const radians = (localAngle * Math.PI) / 180
  const origin = transform({ x: 0, y: 0 })
  const alongBaseline = transform({ x: Math.cos(radians), y: Math.sin(radians) })
  return normalizeDegrees(
    (Math.atan2(alongBaseline.y - origin.y, alongBaseline.x - origin.x) * 180) / Math.PI
  )
}
