import { describe, expect, test } from 'vitest'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  GRAPHIC_TOOLS,
  graphicDefaults,
  isGraphicTool,
  nextRouteCornerMode,
  pcbToolClick,
  pcbToolFinish,
  pcbToolGesture,
  pcbToolPointCount,
  pcbToolShape,
  previewToScene,
  routeElbow,
  shapePreviewPrimitives,
  takesLineMode,
  type PcbTool,
  stepCopperLayer
} from '../pcbTools'

// The tools speak integer nm; the tests keep writing mm.
const p = (x: number, y: number): { x: number; y: number } => ({ x: mm(x), y: mm(y) })

describe('gestures', () => {
  test('every tool maps to a gesture and a point count', () => {
    const tools: PcbTool[] = [
      'select',
      'route',
      'via',
      'line',
      'arc',
      'rectangle',
      'circle',
      'polygon',
      'text'
    ]
    for (const tool of tools) {
      expect(['drop', 'span', 'chain']).toContain(pcbToolGesture(tool))
      expect(pcbToolPointCount(tool)).toBeGreaterThan(0)
    }
    expect(pcbToolPointCount('arc')).toBe(3)
    expect(pcbToolPointCount('rectangle')).toBe(2)
    expect(GRAPHIC_TOOLS.every(isGraphicTool)).toBe(true)
    expect(isGraphicTool('route')).toBe(false)
  })

  test('span commits on the click that completes the count', () => {
    const first = pcbToolClick('rectangle', [], p(0, 0))
    expect(first.commit).toBeNull()
    const second = pcbToolClick('rectangle', first.draft, p(5, 5))
    expect(second.commit).toHaveLength(2)
    expect(second.draft).toHaveLength(0)

    const a1 = pcbToolClick('arc', [], p(0, 0))
    const a2 = pcbToolClick('arc', a1.draft, p(10, 0))
    expect(a2.commit).toBeNull()
    const a3 = pcbToolClick('arc', a2.draft, p(5, 3))
    expect(a3.commit).toHaveLength(3)
  })

  test('chain ends on a repeated click and closes on the start', () => {
    let draft = pcbToolClick('polygon', [], p(0, 0)).draft
    draft = pcbToolClick('polygon', draft, p(4, 0)).draft
    draft = pcbToolClick('polygon', draft, p(2, 3)).draft
    const closed = pcbToolClick('polygon', draft, p(0, 0))
    expect(closed.commit).toHaveLength(4) // start kept twice by the gesture
    expect(closed.draft).toHaveLength(0)

    let lineDraft = pcbToolClick('line', [], p(0, 0)).draft
    lineDraft = pcbToolClick('line', lineDraft, p(4, 0)).draft
    const finished = pcbToolClick('line', lineDraft, p(4, 0))
    expect(finished.commit).toEqual([p(0, 0), p(4, 0)])
  })

  test('finish commits a chain and leaves a span alone', () => {
    expect(pcbToolFinish('line', [p(0, 0), p(1, 0)]).commit).toHaveLength(2)
    expect(pcbToolFinish('line', [p(0, 0)]).commit).toBeNull()
    expect(pcbToolFinish('rectangle', [p(0, 0)]).commit).toBeNull()
  })
})

describe('routeElbow', () => {
  test('45°: the diagonal leg covers the smaller extent, posture picks its end', () => {
    // dx=10, dy=4 → diagonal run 4.
    expect(routeElbow('45', true, p(0, 0), p(10, 4))).toEqual([p(4, 4), p(10, 4)])
    expect(routeElbow('45', false, p(0, 0), p(10, 4))).toEqual([p(6, 0), p(10, 4)])
    // Taller than wide: diagonal covers dx.
    expect(routeElbow('45', true, p(0, 0), p(4, -10))).toEqual([p(4, -4), p(4, -10)])
  })

  test('45°: axis-aligned and pure-diagonal pairs need no corner', () => {
    expect(routeElbow('45', true, p(0, 0), p(10, 0))).toEqual([p(10, 0)])
    expect(routeElbow('45', true, p(0, 0), p(0, 7))).toEqual([p(0, 7)])
    expect(routeElbow('45', true, p(0, 0), p(5, 5))).toEqual([p(5, 5)])
  })

  test('90°: elbow corner per posture; free: straight to the cursor', () => {
    expect(routeElbow('90', true, p(0, 0), p(10, 4))).toEqual([p(10, 0), p(10, 4)])
    expect(routeElbow('90', false, p(0, 0), p(10, 4))).toEqual([p(0, 4), p(10, 4)])
    expect(routeElbow('free', true, p(0, 0), p(10, 4))).toEqual([p(10, 4)])
  })

  test('corner modes cycle 45 → 90 → free → 45', () => {
    expect(nextRouteCornerMode('45')).toBe('90')
    expect(nextRouteCornerMode('90')).toBe('free')
    expect(nextRouteCornerMode('free')).toBe('45')
  })

  test('the line mode constrains the chain tools only', () => {
    expect(takesLineMode('line')).toBe(true)
    expect(takesLineMode('polygon')).toBe(true)
    expect(takesLineMode('zone')).toBe(true)
    expect(takesLineMode('rectangle')).toBe(false)
    expect(takesLineMode('route')).toBe(false)
    expect(takesLineMode(null)).toBe(false)
  })
})

describe('layer drawing defaults (KiCad layer classes)', () => {
  test('copper, silk, edge and other layers get their class values', () => {
    expect(graphicDefaults('F.Cu')).toEqual({
      lineWidth: mm(0.2),
      textSize: mm(1.5),
      textThickness: mm(0.3)
    })
    expect(graphicDefaults('F.SilkS')).toEqual({
      lineWidth: mm(0.1),
      textSize: mm(1.0),
      textThickness: mm(0.1)
    })
    expect(graphicDefaults('Edge.Cuts').lineWidth).toBe(mm(0.05))
    expect(graphicDefaults('F.CrtYd').lineWidth).toBe(mm(0.05))
    expect(graphicDefaults('Cmts.User')).toEqual({
      lineWidth: mm(0.1),
      textSize: mm(1.0),
      textThickness: mm(0.15)
    })
  })
})

describe('pcbToolShape', () => {
  test('line chain becomes independent segments, zero-length steps dropped', () => {
    const shape = pcbToolShape('line', [p(0, 0), p(4, 0), p(4, 0), p(4, 3)])
    expect(shape).toEqual({
      kind: 'lines',
      segments: [
        { start: p(0, 0), end: p(4, 0) },
        { start: p(4, 0), end: p(4, 3) }
      ]
    })
    expect(pcbToolShape('line', [p(0, 0)])).toBeNull()
  })

  test('polygon drops the closing duplicate and needs three vertices', () => {
    const closed = pcbToolShape('polygon', [p(0, 0), p(4, 0), p(2, 3), p(0, 0)])
    expect(closed).toEqual({ kind: 'poly', points: [p(0, 0), p(4, 0), p(2, 3)] })
    expect(pcbToolShape('polygon', [p(0, 0), p(4, 0), p(0, 0)])).toBeNull()
  })

  test('rectangle normalizes corners either drag direction; degenerate is null', () => {
    const down = pcbToolShape('rectangle', [p(1, 1), p(9, 6)])
    const up = pcbToolShape('rectangle', [p(9, 6), p(1, 1)])
    expect(down).toEqual({ kind: 'rect', start: p(1, 1), end: p(9, 6) })
    expect(up).toEqual(down)
    expect(pcbToolShape('rectangle', [p(1, 1), p(1.005, 9)])).toBeNull()
  })

  test('circle keeps the center → rim pair KiCad stores', () => {
    expect(pcbToolShape('circle', [p(5, 5), p(8, 5)])).toEqual({
      kind: 'circle',
      center: p(5, 5),
      end: p(8, 5)
    })
    expect(pcbToolShape('circle', [p(5, 5), p(5.001, 5)])).toBeNull()
  })

  test('arc is clicked start → end → bulge but stored start/mid/end', () => {
    // Two points down: the cursor is the end and the mid sits on the chord.
    const flat = pcbToolShape('arc', [p(0, 0), p(10, 0)])
    expect(flat).toEqual({ kind: 'arc', start: p(0, 0), mid: p(5, 0), end: p(10, 0) })
    // Third point bends it: click order [start, end, bulge] reorders to s/m/e.
    const bent = pcbToolShape('arc', [p(0, 0), p(10, 0), p(5, 3)])
    expect(bent).toEqual({ kind: 'arc', start: p(0, 0), mid: p(5, 3), end: p(10, 0) })
  })

  test('text anchors on the last point; route/via/select build no shape', () => {
    expect(pcbToolShape('text', [p(3, 4)])).toEqual({ kind: 'text', position: p(3, 4) })
    expect(pcbToolShape('route', [p(0, 0), p(1, 1)])).toBeNull()
    expect(pcbToolShape('via', [p(0, 0)])).toBeNull()
    expect(pcbToolShape('select', [p(0, 0)])).toBeNull()
  })

  test('bezier is clicked start → end → controls, KiCad’s order, and stored start/controls/end', () => {
    expect(pcbToolGesture('bezier')).toBe('span')
    expect(pcbToolPointCount('bezier')).toBe(4)
    // The cursor after the start drags the end and the second control with it.
    expect(pcbToolShape('bezier', [p(0, 0), p(4, 0)])).toEqual({
      kind: 'bezier',
      points: [p(0, 0), p(0, 0), p(4, 0), p(4, 0)]
    })
    // With the end down, the cursor is the first control.
    expect(pcbToolShape('bezier', [p(0, 0), p(10, 0), p(2, 5)])).toEqual({
      kind: 'bezier',
      points: [p(0, 0), p(2, 5), p(10, 0), p(10, 0)]
    })
    // Four clicks: the last is the second control.
    expect(pcbToolShape('bezier', [p(0, 0), p(10, 0), p(2, 5), p(8, 5)])).toEqual({
      kind: 'bezier',
      points: [p(0, 0), p(2, 5), p(8, 5), p(10, 0)]
    })
    expect(pcbToolShape('bezier', [p(0, 0)])).toBeNull()
    expect(pcbToolShape('bezier', [p(0, 0), p(0, 0)])).toBeNull()
  })

  test('a text box spans two corners as a rectangle does; a point drops where clicked', () => {
    expect(pcbToolGesture('textBox')).toBe('span')
    expect(pcbToolShape('textBox', [p(4, 3), p(0, 0)])).toEqual({
      kind: 'textBox',
      start: p(0, 0),
      end: p(4, 3)
    })
    expect(pcbToolShape('textBox', [p(0, 0), p(4, 0)])).toBeNull()
    expect(pcbToolGesture('point')).toBe('drop')
    expect(pcbToolClick('point', [], p(1, 2))).toEqual({ draft: [], commit: [p(1, 2)] })
    expect(pcbToolShape('point', [p(1, 2)])).toEqual({ kind: 'point', position: p(1, 2) })
    expect(GRAPHIC_TOOLS).toEqual(expect.arrayContaining(['bezier', 'textBox', 'point']))
  })
})

describe('shapePreviewPrimitives', () => {
  test('rect previews as four edges, polygon closes its loop', () => {
    const rect = pcbToolShape('rectangle', [p(0, 0), p(4, 3)])!
    expect(shapePreviewPrimitives(rect).segments).toHaveLength(4)
    const poly = pcbToolShape('polygon', [p(0, 0), p(4, 0), p(2, 3)])!
    expect(shapePreviewPrimitives(poly).segments).toHaveLength(3)
  })

  test('circle previews as a ring with the derived radius', () => {
    const circle = pcbToolShape('circle', [p(5, 5), p(8, 5)])!
    const preview = shapePreviewPrimitives(circle)
    expect(preview.rings).toEqual([{ center: p(5, 5), radius: mm(3) }])
  })

  test('arc previews as itself and text as nothing', () => {
    const arc = pcbToolShape('arc', [p(0, 0), p(10, 0), p(5, 3)])!
    expect(shapePreviewPrimitives(arc).arcs).toHaveLength(1)
    const text = pcbToolShape('text', [p(1, 1)])!
    const preview = shapePreviewPrimitives(text)
    expect(preview.segments).toHaveLength(0)
    expect(preview.rings).toHaveLength(0)
    expect(preview.arcs).toHaveLength(0)
  })

  test('a curve previews as its sampled polyline, a text box as its edges, a point as nothing', () => {
    const curve = pcbToolShape('bezier', [p(0, 0), p(10, 0), p(2, 5), p(8, 5)])!
    const segments = shapePreviewPrimitives(curve).segments
    expect(segments.length).toBeGreaterThan(4)
    expect(segments[0].start).toEqual(p(0, 0))
    expect(segments[segments.length - 1].end).toEqual(p(10, 0))
    const box = pcbToolShape('textBox', [p(0, 0), p(4, 3)])!
    expect(shapePreviewPrimitives(box).segments).toHaveLength(4)
    const point = shapePreviewPrimitives(pcbToolShape('point', [p(1, 1)])!)
    expect(point.segments).toHaveLength(0)
    expect(point.rings).toHaveLength(0)
  })
})

describe('previewToScene', () => {
  test('carries nm, y down, into scene mm, y up', () => {
    const rect = pcbToolShape('rectangle', [p(1, 2), p(11, 7)])!
    const { segments } = previewToScene(shapePreviewPrimitives(rect))
    expect(segments[0]).toEqual({ start: { x: 1, y: -2 }, end: { x: 11, y: -2 } })
    expect(segments[2]).toEqual({ start: { x: 11, y: -7 }, end: { x: 1, y: -7 } })
  })

  test('a radius is a length: scaled, never negated', () => {
    const circle = pcbToolShape('circle', [p(5, 5), p(8, 9)])!
    const [ring] = previewToScene(shapePreviewPrimitives(circle)).rings
    expect(ring.center).toEqual({ x: 5, y: -5 })
    expect(ring.radius).toBeCloseTo(5)
  })

  test('an arc keeps all three of its points', () => {
    const arc = pcbToolShape('arc', [p(0, 0), p(10, 0), p(5, 3)])!
    const [a] = previewToScene(shapePreviewPrimitives(arc)).arcs
    expect(a).toEqual({ start: { x: 0, y: -0 }, mid: { x: 5, y: -3 }, end: { x: 10, y: -0 } })
  })
})

describe('stepCopperLayer', () => {
  // v9+ stack order is file order — In1/In2 sit between the outers.
  const stack = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']

  test('walks the stack and clamps at the ends', () => {
    expect(stepCopperLayer(stack, 'F.Cu', 1)).toBe('In1.Cu')
    expect(stepCopperLayer(stack, 'In2.Cu', 1)).toBe('B.Cu')
    expect(stepCopperLayer(stack, 'B.Cu', 1)).toBe('B.Cu')
    expect(stepCopperLayer(stack, 'In1.Cu', -1)).toBe('F.Cu')
    expect(stepCopperLayer(stack, 'F.Cu', -1)).toBe('F.Cu')
  })

  test('an unknown current layer restarts from the top', () => {
    expect(stepCopperLayer(stack, 'Edge.Cuts', 1)).toBe('In1.Cu')
    expect(stepCopperLayer([], 'F.Cu', 1)).toBe('F.Cu')
  })
})
