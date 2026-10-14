import { describe, expect, it } from 'vitest'
import type { SymbolGraphic } from '../kicad/schematic'
import {
  arcFrom,
  bezierFrom,
  circleFrom,
  DEFAULT_ORIENTATION,
  INSERT_TOOLS,
  PIN_LENGTH,
  pinPointsAt,
  polygonFrom,
  polygonVertices,
  rectangleFrom,
  toolClick,
  toolFinish,
  toolGesture,
  toolItems,
  toolPointCount,
  toolTemplate,
  type Point2,
  type SymbolTool,
  type ToolOrientation
} from '../symbolTools'
import { mmToNm as mm } from '../kicad/coordinates'

/** A symbol-space point from mm coordinates — the tests speak mm, the domain nm. */
const p = (x: number, y: number): Point2 => ({ x: mm(x), y: mm(y) })

/**
 * The full click chain each tool needs, for tests that iterate every tool. A
 * chain tool is unbounded, so two points stand in for "enough".
 */
const fullChain = (tool: SymbolTool): Point2[] => {
  const count = toolPointCount(tool)
  const points = Number.isFinite(count) ? count : 2
  // Off-axis so no rectangle comes out flat in an axis, which describes no shape.
  return Array.from({ length: points }, (_, i) => p(i * 5 + 1, i * 3 + 2))
}

const graphic = <T extends SymbolGraphic['type']>(
  tool: SymbolTool,
  points: Point2[],
  orientation?: ToolOrientation
): Extract<SymbolGraphic, { type: T }> =>
  toolItems(tool, points, orientation).graphics[0] as Extract<SymbolGraphic, { type: T }>

describe('tool gestures', () => {
  it('drops what has a fixed size and draws what has to be sized', () => {
    expect(toolGesture('pin')).toBe('drop')
    expect(toolGesture('text')).toBe('drop')
    expect(toolGesture('rectangle')).toBe('span')
    expect(toolGesture('circle')).toBe('span')
    expect(toolGesture('arc')).toBe('span')
    expect(toolGesture('line')).toBe('chain')
  })

  it('counts the points each tool needs', () => {
    expect(toolPointCount('pin')).toBe(1)
    expect(toolPointCount('text')).toBe(1)
    expect(toolPointCount('rectangle')).toBe(2)
    expect(toolPointCount('circle')).toBe(2)
    // Three and four: the reason the count is not the gesture.
    expect(toolPointCount('arc')).toBe(3)
    expect(toolPointCount('bezier')).toBe(4)
    expect(toolPointCount('line')).toBe(Infinity)
  })
})

describe('collecting a tool’s points', () => {
  const A = p(0, 0)
  const B = p(2.54, 0)
  const C = p(2.54, 5.08)

  it('commits a drop tool on the first click, holding nothing', () => {
    expect(toolClick('pin', [], A)).toEqual({ draft: [], commit: [A] })
  })

  it('spans a shape across two clicks', () => {
    const first = toolClick('rectangle', [], A)
    expect(first).toEqual({ draft: [A], commit: null })
    expect(toolClick('rectangle', first.draft, B)).toEqual({ draft: [], commit: [A, B] })
  })

  it('accumulates a polyline a click at a time', () => {
    const one = toolClick('line', [], A)
    expect(one).toEqual({ draft: [A], commit: null })
    const two = toolClick('line', one.draft, B)
    expect(two).toEqual({ draft: [A, B], commit: null })
    expect(toolClick('line', two.draft, C).draft).toEqual([A, B, C])
  })

  it('ends a polyline when the click repeats the last point', () => {
    // Which is also how a double-click finishes: the second press lands on the
    // point the first one left, so no dblclick handler exists to keep in step.
    expect(toolClick('line', [A, B], { ...B })).toEqual({ draft: [], commit: [A, B] })
  })

  it('ends without inserting anything when only one point is down', () => {
    // A double-click that STARTS a polyline must not leave a zero-length one.
    expect(toolClick('line', [A], { ...A })).toEqual({ draft: [], commit: null })
  })

  it('closes a polyline when the click lands back on the start', () => {
    // KiCad stores a closed body as a polyline whose last point repeats its
    // first, so keeping the closing click IS the closed shape.
    expect(toolClick('line', [A, B, C], { ...A })).toEqual({
      draft: [],
      commit: [A, B, C, A]
    })
  })

  it('treats a two-point chain’s start as its last point, not as a close', () => {
    // With two points down, clicking the start would be ambiguous — it is both
    // ends of the same segment. Finishing wins; closing needs a real area.
    expect(toolClick('line', [A, B], { ...A })).toEqual({ draft: [], commit: [A, B] })
  })

  it('takes three clicks for an arc, committing on the third', () => {
    const one = toolClick('arc', [], A)
    expect(one).toEqual({ draft: [A], commit: null })
    const two = toolClick('arc', one.draft, B)
    expect(two).toEqual({ draft: [A, B], commit: null })
    expect(toolClick('arc', two.draft, C)).toEqual({ draft: [], commit: [A, B, C] })
  })

  it('takes four clicks for a bezier: both ends, then the two handles', () => {
    const D = p(7.62, 0)
    let r = toolClick('bezier', [], A)
    expect(r).toEqual({ draft: [A], commit: null })
    r = toolClick('bezier', r.draft, B)
    r = toolClick('bezier', r.draft, C)
    expect(r).toEqual({ draft: [A, B, C], commit: null })
    expect(toolClick('bezier', r.draft, D)).toEqual({ draft: [], commit: [A, B, C, D] })
  })

  it('finishes a chain without adding a point, and says when it could not', () => {
    // Right-click. Keeping the draft on a no-op is what lets the caller unwind a
    // level instead — abandon a half-spanned shape, then put the tool away.
    expect(toolFinish('line', [A, B, C])).toEqual({ draft: [], commit: [A, B, C] })
    expect(toolFinish('line', [A])).toEqual({ draft: [A], commit: null })
    expect(toolFinish('rectangle', [A])).toEqual({ draft: [A], commit: null })
    expect(toolFinish('pin', [])).toEqual({ draft: [], commit: null })
  })

  it('does nothing at all in select mode', () => {
    expect(toolClick('select', [A], B)).toEqual({ draft: [], commit: null })
  })

  it('leaves the caller’s draft alone', () => {
    const draft = [A, B]
    toolClick('line', draft, C)
    expect(draft).toEqual([A, B])
  })
})

describe('placement geometry', () => {
  it('anchors a pin at its connection end, extending away along the angle', () => {
    // The clicked point is where a wire attaches — KiCad's (at x y angle).
    const [connection, far] = pinPointsAt(p(2, 2))
    expect(connection).toEqual(p(2, 2))
    expect(far.x).toBe(mm(2) + PIN_LENGTH)
    expect(far.y).toBe(mm(2))

    const [, up] = pinPointsAt(p(0, 0), 90)
    expect(up.x).toBe(0)
    expect(up.y).toBe(PIN_LENGTH)
  })
})

describe('spanning a shape between two clicks', () => {
  it('normalizes the corners, so either drag direction writes the same file', () => {
    const downRight = rectangleFrom(p(0, 10), p(8, 2))
    const upLeft = rectangleFrom(p(8, 2), p(0, 10))
    expect(downRight).toEqual(upLeft)
    expect(downRight).toEqual({ start: p(0, 10), end: p(8, 2) })
  })

  it('takes the radius from the second click, quantized like the AST writer', () => {
    // 3-4-5: an exact radius, so this pins the rule and not the rounding.
    expect(circleFrom(p(1, 1), p(4, 5))).toEqual({
      center: p(1, 1),
      radius: mm(5)
    })
    // Derived values are quantized to the 1 nm grid the commit writes on, or a
    // dragged circle previews a radius the file will not contain.
    expect(circleFrom(p(0, 0), p(2.9, 2.9))?.radius).toBe(mm(4.101219))
  })

  it('describes no shape until the points have extent', () => {
    // No default-sized fallback: a span tool draws nothing rather than a shape
    // whose anchor rule the following click would contradict. What replaced the
    // centerd-then-jumping preview, and why the case cannot come back.
    const at = p(-4, 6)
    expect(rectangleFrom(at, { ...at })).toBeNull()
    expect(circleFrom(at, { ...at })).toBeNull()
  })

  it('reorders an arc from click order into KiCad’s storage order', () => {
    // Clicks arrive start → end → bulge; the file stores start/mid/end. This is
    // the one place the two orders differ, so both are named here.
    const start = p(0, 0)
    const end = p(10, 0)
    const bulge = p(5, 4)
    expect(arcFrom(start, end, bulge)).toEqual({ start, mid: bulge, end })
  })

  it('puts an unbent arc’s mid on the chord, so it previews as the line it is', () => {
    const arc = arcFrom(p(0, 0), p(10, 5))
    expect(arc?.mid).toEqual(p(5, 2.5))
    // Collinear is allowed rather than rejected: both scenes draw that case as a
    // straight line, and it is what an arc looks like before its bulge is set.
    expect(arc).not.toBeNull()
  })

  it('describes no arc without a chord', () => {
    const at = p(2, 2)
    expect(arcFrom(at, { ...at })).toBeNull()
  })

  it('rejects a rectangle flat in one axis — that is a line, not a rectangle', () => {
    // Nothing previews while the drag runs along a single axis, which is the
    // feedback: the shape appears as soon as the span has two dimensions.
    expect(rectangleFrom(p(0, 0), p(10, 0))).toBeNull()
    expect(rectangleFrom(p(0, 0), p(0, 10))).toBeNull()
    expect(rectangleFrom(p(0, 0), p(10, 10))).not.toBeNull()
  })
})

describe('toolItems', () => {
  it('previews nothing for the select tool', () => {
    expect(toolItems('select', [p(0, 0)])).toEqual({ graphics: [], pins: [] })
  })

  it('previews nothing at all with no points', () => {
    for (const tool of INSERT_TOOLS) {
      expect(toolItems(tool, []), tool).toEqual({ graphics: [], pins: [] })
    }
  })

  it('previews nothing for a shape tool until its first click', () => {
    // The armed-but-unclicked state, which is one point long: only a drop tool
    // has something to show there. Rect/circle/arc/line all wait for an anchor,
    // so every shape tool behaves alike and matches KiCad's.
    const cursor = [p(4, 4)]
    expect(toolItems('rectangle', cursor)).toEqual({ graphics: [], pins: [] })
    expect(toolItems('circle', cursor)).toEqual({ graphics: [], pins: [] })
    expect(toolItems('arc', cursor)).toEqual({ graphics: [], pins: [] })
    expect(toolItems('line', cursor)).toEqual({ graphics: [], pins: [] })
    expect(toolItems('pin', cursor).pins).toHaveLength(1)
    expect(toolItems('text', cursor).graphics).toHaveLength(1)
  })

  it('previews an arc bending to the cursor once the chord is down', () => {
    const start = p(0, 0)
    const end = p(10, 0)
    const cursor = p(5, 6)
    // Mid-draw the cursor is the END (the click that sets it), so the mid sits on
    // the chord and the arc reads as the straight line it currently is.
    const flat = graphic<'arc'>('arc', [start, cursor])
    expect(flat.end).toEqual(cursor)
    expect(flat.mid).toEqual(p(2.5, 3))
    // After that click the cursor is the BULGE, and the end stays put.
    const bent = graphic<'arc'>('arc', [start, end, cursor])
    expect(bent.end).toEqual(end)
    expect(bent.mid).toEqual(cursor)
    expect({ start: bent.start, mid: bent.mid, end: bent.end }).toEqual(arcFrom(start, end, cursor))
  })

  it('previews a real curve from the second click, bending as handles land', () => {
    const start = p(0, 0)
    const end = p(6, 0)
    const h1 = p(1, 3)
    const h2 = p(5, -3)
    // Two clicks: an unplaced handle sits on its own endpoint, which is the
    // degenerate cubic — a straight chord, and already the shape being drawn.
    expect(graphic<'bezier'>('bezier', [start, end]).points).toEqual([start, start, end, end])
    // Third click bends the start side; the end handle stays collapsed.
    expect(graphic<'bezier'>('bezier', [start, end, h1]).points).toEqual([start, h1, end, end])
    // Fourth bends the other side. Clicks are start/end/handle/handle; the file
    // holds start/handle/handle/end — this is the reorder, named both ways.
    expect(graphic<'bezier'>('bezier', [start, end, h1, h2]).points).toEqual([start, h1, h2, end])
    // One point is an anchor with nothing to draw between, like every span tool.
    expect(toolItems('bezier', [start])).toEqual({ graphics: [], pins: [] })
    // And no chord means no curve.
    expect(bezierFrom([start, { ...start }])).toBeNull()
  })

  it('drops text with a placeholder to type over, visible and unrotated', () => {
    const [text] = toolItems('text', [p(1, -2)]).graphics
    expect(text).toEqual({
      type: 'text',
      text: 'Text',
      position: { x: mm(1), y: mm(-2), angle: 0 },
      effects: expect.objectContaining({
        hidden: false,
        fontSize: { height: mm(1.27), width: mm(1.27) }
      })
    })
  })

  it('gives every insert tool something to draw once it has its points', () => {
    for (const tool of INSERT_TOOLS) {
      const { graphics, pins } = toolItems(tool, fullChain(tool))
      expect(graphics.length + pins.length, tool).toBeGreaterThan(0)
    }
  })

  it('previews a pin anchored at the connection point, reading the last point', () => {
    const { pins } = toolItems('pin', [p(1, 2)])
    expect(pins).toHaveLength(1)
    expect(pins[0].position).toEqual({ x: mm(1), y: mm(2), angle: 0 })
    expect(pins[0].length).toBe(PIN_LENGTH)
    // The drawn extent agrees with the geometry helper the insert command uses.
    expect(pinPointsAt(p(1, 2))[1].x).toBe(mm(1) + PIN_LENGTH)
  })

  it('previews the same geometry the insert command will write', () => {
    // A preview that disagrees with what lands is the bug this module exists to
    // prevent, so both come off the same helpers.
    const a = p(-4, 6)
    const b = p(3, -1)
    const rect = graphic<'rectangle'>('rectangle', [a, b])
    expect({ start: rect.start, end: rect.end }).toEqual(rectangleFrom(a, b))

    const circle = graphic<'circle'>('circle', [a, b])
    expect({ center: circle.center, radius: circle.radius }).toEqual(circleFrom(a, b))
  })

  it('spans a shape from the FIRST point to the cursor, ignoring the ones between', () => {
    // Only a chain accumulates; a span tool can never hold more than two points,
    // but reading `first`/`last` rather than `[0]`/`[1]` is what makes that true.
    const a = p(0, 0)
    const b = p(10, -4)
    const rect = graphic<'rectangle'>('rectangle', [a, p(3, 3), b])
    expect({ start: rect.start, end: rect.end }).toEqual(rectangleFrom(a, b))
  })

  it('draws a polyline through every point of the chain', () => {
    const points = [p(0, 0), p(2.54, 0), p(2.54, 5.08)]
    expect(graphic<'line'>('line', points).points).toEqual(points)
  })

  it('draws nothing for a chain with only one point', () => {
    // The first click seeds a polyline rather than committing a default segment,
    // so there is deliberately nothing under the cursor until it has a segment.
    expect(toolItems('line', [p(1, 1)])).toEqual({ graphics: [], pins: [] })
  })

  it('copies the chain rather than aliasing it', () => {
    const points = [p(0, 0), p(1, 1)]
    const line = graphic<'line'>('line', points)
    line.points[0].x = mm(99)
    expect(points[0].x).toBe(0)
  })
})

describe('orienting the pending item', () => {
  it('turns a pin about its connection point, taking the heading with it', () => {
    const at = p(5, 5)
    const [pin] = toolItems('pin', [at], { quarterTurns: 1, mirror: null }).pins
    // The anchor is the pivot, so the connection point does not move.
    expect(pin.position.x).toBeCloseTo(at.x, 9)
    expect(pin.position.y).toBeCloseTo(at.y, 9)
    expect(pin.position.angle).toBe(90)
  })

  it('returns to the original after four quarter turns', () => {
    const at = p(2, 7)
    const [pin] = toolItems('pin', [at], { quarterTurns: 4, mirror: null }).pins
    expect(pin.position.angle).toBe(0)
    expect(toolItems('pin', [at], { quarterTurns: 4, mirror: null })).toEqual(
      toolItems('pin', [at])
    )
  })

  it('mirrors a pin heading without moving its anchor', () => {
    const at = p(0, 0)
    const [flipped] = toolItems('pin', [at], { quarterTurns: 0, mirror: 'horizontal' }).pins
    expect(flipped.position).toEqual({ x: mm(0), y: mm(0), angle: 180 })
    const [vertical] = toolItems('pin', [at], { quarterTurns: 1, mirror: 'vertical' }).pins
    // Rotated to 90 (up), then flipped top-to-bottom, so it points down.
    expect(vertical.position.angle).toBe(270)
  })

  it('holds a pending TEXT to the two angles KiCad can draw', () => {
    // A pin's heading is free in all four quadrants; a symbol text's is not —
    // KiCad plots `(text …)` horizontal at 0 and vertical at everything else, so
    // an armed text previews and lands on 0 or 90 only.
    const at = p(3, 3)
    const angleOf = (orientation: ToolOrientation): number =>
      graphic<'text'>('text', [at], orientation).position.angle
    expect(angleOf({ quarterTurns: 1, mirror: null })).toBe(90)
    expect(angleOf({ quarterTurns: 2, mirror: null })).toBe(0)
    expect(angleOf({ quarterTurns: 0, mirror: 'horizontal' })).toBe(0)
    expect(angleOf({ quarterTurns: 1, mirror: 'vertical' })).toBe(90)
  })

  it('leaves the default orientation identical to no orientation', () => {
    const at = p(-1, 4)
    expect(toolItems('pin', [at], DEFAULT_ORIENTATION)).toEqual(toolItems('pin', [at]))
  })

  it('ignores orientation on a shape the clicks already oriented', () => {
    // R/X/Y are for drop tools. A spanned or chained shape is oriented
    // by where its points landed, and turning it would move it out from under
    // them — so these keys are inert while those tools are armed, and the
    // geometry must not depend on the orientation state left over from a pin.
    const turned: ToolOrientation = { quarterTurns: 1, mirror: 'horizontal' }
    const span = [p(0, 0), p(6, 4)]
    expect(toolItems('rectangle', span, turned)).toEqual(toolItems('rectangle', span))
    expect(toolItems('circle', span, turned)).toEqual(toolItems('circle', span))
    expect(toolItems('line', span, turned)).toEqual(toolItems('line', span))
  })
})

/**
 * The template/points split: a tool's non-geometric settings are edited in the
 * properties panel while it is armed, and both the ghost and the inserted item
 * must come off them. A panel that described one pin and placed another would be
 * the same failure the preview/commit tests exist to catch, one level up.
 */
describe('toolTemplate + ToolDefaults', () => {
  it('defaults to exactly what the tools placed before they were parameterised', () => {
    const pin = toolTemplate('pin').pins[0]
    expect(pin.electricalType).toBe('passive')
    expect(pin.graphicStyle).toBe('line')
    // Empty, not the legacy `~`: KiCad has written `(name "")` since v6, and the
    // standard libraries contain no `(name "~")` at all.
    expect(pin.name).toBe('')
    expect(pin.length).toBe(PIN_LENGTH)
    const rect = toolTemplate('rectangle').graphics[0] as Extract<
      SymbolGraphic,
      { type: 'rectangle' }
    >
    expect(rect.stroke.width).toBe(mm(0.254))
    expect(rect.fill).toBe('none')
  })

  it('carries a pin default through to the item that lands', () => {
    const defaults = { pin: { electricalType: 'power_in', length: mm(5.08), name: 'VDD' } }
    expect(toolTemplate('pin', defaults).pins[0].electricalType).toBe('power_in')
    const placed = toolItems('pin', [p(2.54, 0)], DEFAULT_ORIENTATION, defaults).pins[0]
    expect(placed.electricalType).toBe('power_in')
    expect(placed.length).toBe(mm(5.08))
    expect(placed.name).toBe('VDD')
    // The click still owns the position; the template only says what it is.
    expect(placed.position).toEqual({ x: mm(2.54), y: mm(0), angle: 0 })
  })

  it('carries stroke and fill through to every shape tool', () => {
    const defaults = { graphic: { stroke: { width: mm(0.5), type: 'dash' }, fill: 'background' } }
    const spans: Array<[SymbolTool, Point2[]]> = [
      ['rectangle', [p(0, 0), p(5, 5)]],
      ['circle', [p(0, 0), p(5, 0)]],
      ['arc', [p(0, 0), p(5, 0), p(2.5, 2)]],
      ['line', [p(0, 0), p(5, 5)]]
    ]
    for (const [tool, points] of spans) {
      const g = toolItems(tool, points, DEFAULT_ORIENTATION, defaults).graphics[0] as {
        stroke: { width: number; type?: string }
        fill: string
      }
      expect([tool, g.stroke.width, g.stroke.type, g.fill]).toEqual([
        tool,
        mm(0.5),
        'dash',
        'background'
      ])
    }
  })

  it('carries the text string and size through', () => {
    const defaults = { text: { text: 'GND', effects: { bold: true } } }
    const placed = toolItems('text', [p(1, 1)], DEFAULT_ORIENTATION, defaults)
      .graphics[0] as Extract<SymbolGraphic, { type: 'text' }>
    expect(placed.text).toBe('GND')
    expect(placed.effects.bold).toBe(true)
    // Untouched effects still come from the visible-text default.
    expect(placed.effects.hidden).toBe(false)
  })

  it('gives every insert tool something for the panel to describe', () => {
    // A tool whose template were empty would silently fall back to the selection
    // panel while armed, which is the bug this feature exists to remove.
    for (const tool of INSERT_TOOLS) {
      const { pins, graphics } = toolTemplate(tool)
      expect([tool, pins.length + graphics.length]).toEqual([tool, 1])
    }
    expect(toolTemplate('select')).toEqual({ pins: [], graphics: [] })
  })
})

describe('polygon tool', () => {
  it('chains a vertex per click, like the line tool', () => {
    expect(toolGesture('polygon')).toBe('chain')
    const draft = toolClick('polygon', [p(0, 0)], p(5, 0)).draft
    expect(draft).toEqual([p(0, 0), p(5, 0)])
  })

  it('closes back to its first corner, as KiCad stores a closed body', () => {
    expect(polygonFrom([p(0, 0), p(5, 0), p(5, 5)])).toEqual([p(0, 0), p(5, 0), p(5, 5), p(0, 0)])
    // Already closed by a click on the start: no second closing point.
    expect(polygonFrom([p(0, 0), p(5, 0), p(5, 5), p(0, 0)])).toEqual([
      p(0, 0),
      p(5, 0),
      p(5, 5),
      p(0, 0)
    ])
  })

  it('previews the open first edge before the third corner', () => {
    const [line] = toolItems('polygon', [p(0, 0), p(5, 0)]).graphics
    expect(line).toMatchObject({ type: 'line', points: [p(0, 0), p(5, 0)] })
  })

  it('previews the closed shape with the cursor as the next corner', () => {
    const [line] = toolItems('polygon', [p(0, 0), p(5, 0), p(5, 5)]).graphics
    expect(line).toMatchObject({ type: 'line', points: [p(0, 0), p(5, 0), p(5, 5), p(0, 0)] })
  })

  it('commits on right-click with three corners, and keeps fewer', () => {
    expect(toolFinish('polygon', [p(0, 0), p(5, 0), p(5, 5)]).commit).toEqual([
      p(0, 0),
      p(5, 0),
      p(5, 5)
    ])
    const short = toolFinish('polygon', [p(0, 0), p(5, 0)])
    expect(short.commit).toBeNull()
    expect(short.draft).toEqual([p(0, 0), p(5, 0)])
  })

  it('places nothing when a double-click ends it after one edge', () => {
    expect(toolClick('polygon', [p(0, 0), p(5, 0)], p(5, 0))).toEqual({ draft: [], commit: null })
  })

  it('counts distinct corners, ignoring repeats and the closing point', () => {
    expect(polygonVertices([p(0, 0), p(0, 0), p(5, 0), p(5, 5), p(0, 0)])).toHaveLength(3)
  })
})

describe('anchor tool', () => {
  it('is one click that places nothing', () => {
    expect(toolGesture('anchor')).toBe('drop')
    expect(toolClick('anchor', [], p(1, 2))).toEqual({ draft: [], commit: [p(1, 2)] })
    expect(toolItems('anchor', [p(1, 2)])).toEqual({ graphics: [], pins: [] })
    expect(toolTemplate('anchor')).toEqual({ graphics: [], pins: [] })
  })
})
