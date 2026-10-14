import { describe, expect, test } from 'vitest'
import { parseDimension } from '../../kicad/footprint'
import { parseSExpr, type SExprList } from '../../kicad/sexpr'
import { dimensionGeometry, type Pt } from '../dimensionGeometry'

const dim = (source: string): ReturnType<typeof parseDimension> =>
  parseDimension(parseSExpr(source) as SExprList)

const STYLE = `(style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5))`

/** Lines in mm, rounded, for comparing. */
const mm = (lines: Array<{ a: Pt; b: Pt }>): number[][] =>
  lines.map(({ a, b }) => [a.x, a.y, b.x, b.y].map((v) => Math.round(v / 1e3) / 1e3))

const BARB = (27.5 * Math.PI) / 180

describe('dimensionGeometry', () => {
  test('an aligned dimension: extension lines, a crossbar at its height, outward arrowheads', () => {
    const { lines, circles } = dimensionGeometry(
      dim(`(dimension (type aligned) (layer "F.Cu") (pts (xy 0 0) (xy 10 0)) (height -5) ${STYLE})`)
    )
    expect(circles).toEqual([])
    const bx = Math.round(1.27 * Math.cos(BARB) * 1e3) / 1e3
    const by = Math.round(1.27 * Math.sin(BARB) * 1e3) / 1e3
    expect(mm(lines)).toEqual([
      // From a 0.5 mm gap at each point to 0.58642 mm past the crossbar.
      [0, -0.5, 0, -5.586],
      [10, -0.5, 10, -5.586],
      // The crossbar, whole: the text sits outside it.
      [0, -5, 10, -5],
      // Barbs from each tip back along the crossbar.
      [0, -5, bx, -5 - by],
      [0, -5, bx, -5 + by],
      [10, -5, 10 - bx, -5 + by],
      [10, -5, 10 - bx, -5 - by]
    ])
  })

  test('inward arrows carry tails outside the crossbar, twice the arrow long', () => {
    const { lines } = dimensionGeometry(
      dim(
        `(dimension (type aligned) (layer "F.Cu") (pts (xy 0 0) (xy 10 0)) (height 5)
          (style (arrow_length 1 ) (arrow_direction inward) (extension_height 0.5) (extension_offset 0.5)))`
      )
    )
    const tails = mm(lines).filter(([, y0, , y1]) => y0 === 5 && y1 === 5)
    expect(tails).toContainEqual([0, 5, -2, 5])
    expect(tails).toContainEqual([10, 5, 12, 5])
  })

  test('an orthogonal dimension measures along one axis; its second extension runs to the far point', () => {
    const { lines } = dimensionGeometry(
      dim(
        `(dimension (type orthogonal) (layer "F.Cu") (pts (xy 0 0) (xy 10 3)) (height -2) (orientation 0) ${STYLE})`
      )
    )
    const out = mm(lines)
    expect(out[0]).toEqual([0, -0.5, 0, -2.586])
    // Past the crossbar at y −2, down to a gap short of (10, 3).
    expect(out[1]).toEqual([10, -2.586, 10, 2.5])
    expect(out[2]).toEqual([0, -2, 10, -2])
  })

  test('inline text breaks the crossbar round it', () => {
    const { lines } = dimensionGeometry(
      dim(`(dimension (type aligned) (layer "F.Cu") (pts (xy 0 0) (xy 20 0)) (height -5)
        (style (arrow_length 1.27) (text_position_mode 1) (extension_height 0.5) (extension_offset 0.5))
        (gr_text "20.00" (at 10 -5 0) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.15)))))`)
    )
    const crossbar = mm(lines).filter(([, y0, , y1]) => y0 === -5 && y1 === -5)
    expect(crossbar).toHaveLength(2)
    const [left, right] = crossbar.sort((a, b) => a[0] - b[0])
    expect(left[0]).toBe(0)
    expect(right[2]).toBe(20)
    // The gap holds the text, half a glyph's width wider each side.
    expect(left[2]).toBeLessThan(7.5)
    expect(right[0]).toBeGreaterThan(12.5)
  })

  test('a center mark is a cross whose arms reach the second point', () => {
    const { lines } = dimensionGeometry(
      dim(`(dimension (type center) (layer "F.Cu") (pts (xy 5 5) (xy 5 3)) ${STYLE})`)
    )
    expect(mm(lines)).toEqual([
      [5, 7, 5, 3],
      [7, 5, 3, 5]
    ])
  })

  test('a radial dimension: a cross at the center, a leader out past the measured point', () => {
    const { lines } = dimensionGeometry(
      dim(
        `(dimension (type radial) (layer "F.Cu") (pts (xy 0 0) (xy 3 0)) (leader_length 2) ${STYLE})`
      )
    )
    const out = mm(lines)
    expect(out.slice(0, 2)).toEqual([
      [0, -1.27, 0, 1.27],
      [-1.27, 0, 1.27, 0]
    ])
    // With no text the leader runs to its knee, and the knee's segment is empty.
    expect(out).toContainEqual([3, 0, 5, 0])
  })

  test("a leader's rectangle frames its text, and its line stops at the frame", () => {
    const { lines } = dimensionGeometry(
      dim(`(dimension (type leader) (layer "F.Cu") (pts (xy 0 0) (xy 5 0))
        (style (arrow_length 1.27) (text_frame 1) (extension_offset 0.5))
        (gr_text "A" (at 5 0 0) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.1)))))`)
    )
    const out = mm(lines)
    // The line from past the gap at the arrow, cut where it meets the frame left of the text.
    expect(out[0][0]).toBe(0.5)
    expect(out[0][2]).toBeGreaterThan(3.5)
    expect(out[0][2]).toBeLessThan(5)
    // Arrowhead (two barbs) and the frame's four sides.
    expect(out).toHaveLength(7)
  })
})
