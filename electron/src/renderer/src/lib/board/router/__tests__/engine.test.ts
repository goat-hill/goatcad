import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { BoardSpatialIndex, type CopperItem } from '../../spatialIndex'
import { RouterWorld, nextOverlayId } from '../world'
import { proposeRoute, type RouteRequest } from '../engine'
import { cornerCost, smoothPath, mergeColinear } from '../optimize'
import { replayRoute } from '../replay'
import { assembleLine } from '../lines'

// World fixture: net 1 is being routed; net 2 copper is the obstacle field.
const world = (body: string): RouterWorld => {
  const board = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "SIG")
  (net 2 "OBS")
${body}
)`)
  return new RouterWorld(BoardSpatialIndex.build(board))
}

const request = (
  tail: { x: number; y: number },
  cursor: { x: number; y: number },
  overrides: Partial<RouteRequest> = {}
): RouteRequest => ({
  mode: 'walkaround',
  tail,
  cursor,
  cornerMode: 'free',
  diagFirst: true,
  layer: 'F.Cu',
  width: 0.5,
  clearance: 0.5,
  net: 1,
  ...overrides
})

// KiCad y-down source ↔ y-up world: fixtures at y 0 keep signs trivial.
const blockingTrack = `(segment (start 5 -2) (end 5 2) (width 0.5) (layer "F.Cu") (net 2) (uuid "s1"))`

const noViolations = (segments: Array<{ violation: boolean }>): void => {
  expect(segments.length).toBeGreaterThan(0)
  expect(segments.every((s) => !s.violation)).toBe(true)
}

describe('proposeRoute', () => {
  test('a clean line passes through untouched in every mode', () => {
    const w = world('')
    for (const mode of ['highlight', 'walkaround'] as const) {
      const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }, { mode }))
      expect(p.segments).toHaveLength(1)
      expect(p.walked).toBe(false)
      expect(p.blocked).toBe(false)
      expect(p.endsAt).toEqual({ x: 10, y: 0 })
    }
  })

  test('highlight mode marks the violation and does not bend', () => {
    const w = world(blockingTrack)
    const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }, { mode: 'highlight' }))
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0].violation).toBe(true)
    expect(p.walked).toBe(false)
    expect(p.blocked).toBe(true)
  })

  test('Highlight: within half a width of an obstacle the head snaps onto its clearance outline (KiCad)', () => {
    // The track's clearance outline runs at x 4 (0.25 + 0.5 + 0.25 from x 5).
    const w = world(blockingTrack)
    const near = proposeRoute(w, request({ x: 0, y: 0 }, { x: 4.1, y: 0 }, { mode: 'highlight' }))
    expect(near.endsAt.x).toBeCloseTo(4, 9)
    expect(near.endsAt.y).toBeCloseTo(0, 9)
    expect(near.blocked).toBe(false)
    // Further in than half a width, it goes on to the cursor and is marked.
    const deep = proposeRoute(w, request({ x: 0, y: 0 }, { x: 4.4, y: 0 }, { mode: 'highlight' }))
    expect(deep.endsAt).toEqual({ x: 4.4, y: 0 })
    expect(deep.blocked).toBe(true)
    // Clear of it, nothing snaps.
    const clear = proposeRoute(w, request({ x: 0, y: 0 }, { x: 3.9, y: 0 }, { mode: 'highlight' }))
    expect(clear.endsAt).toEqual({ x: 3.9, y: 0 })
  })

  test('walkaround bends around a foreign track and lands on the cursor', () => {
    const w = world(blockingTrack)
    const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p.walked).toBe(true)
    expect(p.blocked).toBe(false)
    noViolations(p.segments)
    expect(p.segments.length).toBeGreaterThan(1)
    expect(p.endsAt.x).toBeCloseTo(10, 9)
    expect(p.endsAt.y).toBeCloseTo(0, 9)
    // The detour clears the obstacle: some vertex is ≥ clearance off axis.
    const maxOff = Math.max(...p.segments.map((s) => Math.max(Math.abs(s.y0), Math.abs(s.y1))))
    expect(maxOff).toBeGreaterThan(0.9) // 0.25 obs + 0.5 cl + 0.25 route
  })

  test('walkaround respects a pad obstacle and same-net copper is no obstacle', () => {
    const pad = `(footprint "T:P" (layer "F.Cu") (uuid "f1") (at 5 0)
      (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 2 "OBS")))`
    const w = world(pad)
    const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p.walked).toBe(true)
    noViolations(p.segments)

    const sameNetPad = pad.replace('(net 2 "OBS")', '(net 1 "SIG")')
    const w2 = world(sameNetPad)
    const p2 = proposeRoute(w2, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p2.walked).toBe(false)
    expect(p2.segments).toHaveLength(1)
  })

  test('an obstacle on the other layer is invisible', () => {
    const w = world(blockingTrack.replace('"F.Cu"', '"B.Cu"'))
    const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p.walked).toBe(false)
    expect(p.segments).toHaveLength(1)
  })

  test('45° posture survives the engine when nothing blocks', () => {
    const w = world('')
    const p = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 4 }, { cornerMode: '45' }))
    expect(p.segments).toHaveLength(2)
    expect(p.blocked).toBe(false)
  })
})

describe('smoothing', () => {
  const free = { collides: () => false, crosses: () => false }

  test('a staircase pulls taut when nothing is in the way', () => {
    const jaggy = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 0 },
      { x: 10, y: 0 }
    ]
    expect(mergeColinear(jaggy.slice(0, 3))).toHaveLength(2)
    expect(smoothPath(jaggy, '45', free)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ])
  })

  test('a shortcut that collides is refused', () => {
    const detour = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 10, y: 0 }
    ]
    const out = smoothPath(detour, '45', {
      collides: (p) => p.some((q, i) => i > 0 && i < p.length - 1 && q.y < 1) || p.length === 2,
      crosses: () => false
    })
    expect(out).toEqual(detour)
  })

  test('a box round an obstacle becomes 45° shoulders that keep the line either side (P2)', () => {
    // A line bumped up round something in 4 < x < 6, y < 1.
    const box = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 0 },
      { x: 10, y: 0 }
    ]
    const inBox = (p: { x: number; y: number }): boolean =>
      p.x > 4 - 1e-9 && p.x < 6 + 1e-9 && p.y < 1 - 1e-9
    const collides = (run: readonly { x: number; y: number }[]): boolean =>
      run.some((a, i) => {
        const b = run[i + 1]
        if (!b) return false
        for (let k = 0; k <= 100; k++) {
          if (inBox({ x: a.x + ((b.x - a.x) * k) / 100, y: a.y + ((b.y - a.y) * k) / 100 }))
            return true
        }
        return false
      })
    const out = smoothPath(box, '45', { collides, crosses: () => false }, 400, { holdEnds: true })
    expect(cornerCost(out)).toBeLessThan(cornerCost(box))
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[1].y).toBeCloseTo(0, 9)
    expect(out[out.length - 1]).toEqual({ x: 10, y: 0 })
    expect(out[out.length - 2].y).toBeCloseTo(0, 9)
    expect(collides(out)).toBe(false)
  })

  test('a shortcut to the other side of an obstacle is refused', () => {
    const detour = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 10, y: 0 }
    ]
    const out = smoothPath(detour, '45', { collides: () => false, crosses: () => true })
    expect(out).toEqual(detour)
  })
})

describe('corner cost', () => {
  const O = { x: 0, y: 0 }
  const E = { x: 4, y: 0 }

  test('a gentle bend costs less than a right angle, which costs less than an acute one', () => {
    const at45 = cornerCost([O, E, { x: 8, y: 4 }])
    const at90 = cornerCost([O, E, { x: 4, y: 4 }])
    const at135 = cornerCost([O, E, { x: 0, y: 4 }])
    expect(at45).toBeLessThan(at90)
    expect(at90).toBeLessThan(at135)
    expect(cornerCost([O, E, { x: 8, y: 0 }])).toBe(0)
  })

  test('a neighbor past the stretch counts toward its cost', () => {
    expect(cornerCost([O, E], { before: { x: -4, y: -4 } })).toBe(
      cornerCost([{ x: -4, y: -4 }, O, E])
    )
  })
})

describe('router world overlay', () => {
  const overlayVia = (x: number, y: number, net: number): CopperItem => ({
    id: nextOverlayId(),
    ref: { type: 'via', index: 999 },
    net,
    layers: ['F.Cu', 'B.Cu'],
    shape: { kind: 'circle', cx: x, cy: y, r: 0.4 },
    minX: x - 0.4,
    minY: y - 0.4,
    maxX: x + 0.4,
    maxY: y + 0.4
  })

  test('a branch sees added obstacles; the parent does not', () => {
    const w = world('')
    const clean = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(clean.walked).toBe(false)

    const branch = w.branch()
    branch.add(overlayVia(5, 0, 2))
    const bent = proposeRoute(branch, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(bent.walked).toBe(true)
    const parentStill = proposeRoute(w, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(parentStill.walked).toBe(false)
  })

  test('a branch can hide base copper', () => {
    const w = world(blockingTrack)
    const blockedItem = w.base.items.find((i) => i.net === 2)!
    const branch = w.branch()
    branch.remove(blockedItem.id)
    const p = proposeRoute(branch, request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p.walked).toBe(false)
    expect(p.segments).toHaveLength(1)
  })
})

describe('the first obstacle', () => {
  test('of several one segment meets, is the one it reaches first', () => {
    // The far track listed first: the near one is still the one met.
    const w =
      world(`(segment (start -5 -3) (end 5 -3) (width 0.5) (layer "F.Cu") (net 2) (uuid "far"))
(segment (start -5 -2) (end 5 -2) (width 0.5) (layer "F.Cu") (net 2) (uuid "near"))`)
    const hit = w.firstObstacle(
      [
        { x: 0, y: 0 },
        { x: 0, y: 2.8 }
      ],
      0.25,
      0.2,
      {
        layer: 'F.Cu',
        excludeNet: 1
      }
    )
    expect(hit?.shape.kind === 'capsule' && hit.shape.y0).toBeCloseTo(2, 9)
  })
})

describe('line assembly', () => {
  test('a tight bend whose segments are shorter than the track is wide is still one line', () => {
    // A 45° bump 0.175 mm tall in a 0.5 mm track: each corner's neighbors'
    // copper reaches the next corner, which does not make it a junction.
    const seg = (x0: number, y0: number, x1: number, y1: number, id: string): string =>
      `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.5) (layer "F.Cu") (net 2) (uuid "${id}"))`
    const w = world(
      [
        seg(-5, 0, -0.263, 0, 'a'),
        seg(-0.263, 0, -0.088, -0.175, 'b'),
        seg(-0.088, -0.175, 0.388, -0.175, 'c'),
        seg(0.388, -0.175, 0.563, 0, 'd'),
        seg(0.563, 0, 5, 0, 'e')
      ].join('\n')
    )
    const line = assembleLine(
      w,
      w.base.items.find((i) => i.ref.index === 4)!
    )
    expect(line.ids).toHaveLength(5)
  })
})

describe('replay', () => {
  test('a two-click route around an obstacle commits the walked geometry', () => {
    const w = world(blockingTrack)
    const state = replayRoute(
      w,
      {
        mode: 'walkaround',
        cornerMode: 'free',
        diagFirst: true,
        layer: 'F.Cu',
        width: 0.5,
        clearance: 0.5,
        net: 1
      },
      [
        { type: 'click', x: 0, y: 0 },
        { type: 'move', x: 10, y: 0 },
        { type: 'click', x: 10, y: 0 }
      ]
    )
    expect(state.refusals).toBe(0)
    expect(state.committed.length).toBeGreaterThan(1)
    expect(state.committed.every((s) => !s.violation)).toBe(true)
    expect(state.tail!.x).toBeCloseTo(10, 9)
    // Preview equals commit: the last move's preview is what the click landed.
    expect(state.preview).toEqual(state.committed)
  })
})
