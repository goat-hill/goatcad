import { describe, expect, test } from 'vitest'
import { RouteSession, type RouteRequest } from '../engine'
import { segmentToShape } from '../../spatialIndex'
import { outline, pad, pointsOf, request, rulesWorld, via, world } from './routerFixture'
import { ViaDragSession } from '../viaDrag'

// docs/router-behavior.md R24 (a via is legal on every layer it spans) and
// R16 (a keepout that forbids vias stops one).

const LAYERS = ['F.Cu', 'B.Cu']
const tail = { x: 0, y: 0 }
const end = { x: 5, y: 0 }

/** A route to `end` with a via armed there. */
const withVia = (o: Partial<RouteRequest> = {}, size = 0.6): RouteRequest =>
  request(tail, end, { via: { size, layers: LAYERS }, ...o })

/** A net-2 track on B.Cu along world y = `y`, its ends far off. */
const backTrack = (y: number, extra = ''): string =>
  `(segment (start -6 ${-y}) (end 16 ${-y}) (width 0.2) (layer "B.Cu") (net 2)${extra} (uuid "b-${y}"))`

/** A keepout over a source rectangle on B.Cu that forbids vias and allows tracks. */
const viaKeepout = (x0: number, y0: number, x1: number, y1: number): string =>
  `(zone (layers "B.Cu") (uuid "vk") (hatch full 0.5)
    (keepout (tracks allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`

describe('R24: the via where the head ends', () => {
  // 0.8 from the via's center: 0.4 from its edge to the track's, under 0.5.
  const board = backTrack(0.8)

  test('Highlight: copper on another layer it spans marks it and refuses the click', () => {
    const w = world(board)
    expect(new RouteSession(w).propose(request(tail, end)).blocked).toBe(false)
    const p = new RouteSession(w).propose(withVia({ mode: 'highlight' }))
    expect(p.via).toEqual({ at: end, violation: true })
    expect(p.blocked).toBe(true)
    expect(p.state).toBe('violating')
    expect(p.violators).toEqual([{ type: 'segment', index: 0 }])
    expect(p.marks.length).toBeGreaterThan(0)
    // The head itself is clean: only the via is wrong.
    expect(p.segments.every((s) => !s.violation)).toBe(true)
  })

  test('clear of everything, it lands', () => {
    const p = new RouteSession(world(backTrack(1.2))).propose(withVia())
    expect(p.via).toEqual({ at: end, violation: false })
    expect(p.blocked).toBe(false)
  })

  test('push mode pushes what it hits on the other layer', () => {
    const session = new RouteSession(world(board))
    const p = session.propose(withVia({ mode: 'shove' }))
    expect(p.blocked).toBe(false)
    expect(p.via?.violation).toBe(false)
    const moved = session.displaced()
    expect(moved.hiddenRefs).toEqual([{ type: 'segment', index: 0 }])
    expect(moved.segments.every((s) => s.layer === 'B.Cu')).toBe(true)
    // Pushed out to the via's clearance at least.
    for (const s of moved.segments) {
      const d = segmentToShape(
        { kind: 'circle', cx: 5, cy: 0, r: 0.3 },
        s.x0,
        s.y0,
        s.x1,
        s.y1,
        0.1
      )
      expect(d).toBeGreaterThan(0.5 - 1e-6)
    }
  })

  test('Avoid: the via goes to the nearest spot it fits, the head walked there (R14)', () => {
    const p = new RouteSession(world(board)).propose(withVia())
    expect(p.blocked).toBe(false)
    expect(p.via?.violation).toBe(false)
    expect(p.via?.at).toEqual(p.endsAt)
    // Clear of the track: 0.3 + 0.5 + 0.1 from its centerline, below it.
    expect(p.endsAt.y).toBeLessThan(0.8 - 0.9 + 1e-6)
    expect(Math.abs(p.endsAt.x - 5)).toBeLessThan(0.05)
  })

  test('push mode does as Avoid where what it hits cannot move', () => {
    // A pad 1.2 above: the head passes, a 1 mm via does not, and a pad never moves.
    const session = new RouteSession(world(pad(5, -1.2, 0.6)))
    expect(session.propose(request(tail, end, { mode: 'shove' })).blocked).toBe(false)
    const p = session.propose(withVia({ mode: 'shove' }, 1))
    expect(p.blocked).toBe(false)
    expect(p.via?.violation).toBe(false)
    expect(p.endsAt.y).toBeLessThan(1.2 - 0.3 - 0.5 - 0.5 + 1e-6)
    expect(session.displaced().hiddenRefs).toHaveLength(0)
  })

  test('a locked track is not pushed: the via steps clear of it instead', () => {
    const session = new RouteSession(world(backTrack(0.8, ' (locked yes)')), {
      isFixed: (item) => item.ref.type === 'segment'
    })
    const p = session.propose(withVia({ mode: 'shove' }))
    expect(p.blocked).toBe(false)
    expect(p.via?.violation).toBe(false)
    expect(p.endsAt).not.toEqual(end)
    expect(session.displaced().hiddenRefs).toHaveLength(0)
  })

  test('Avoid with nowhere along the head to stand: back to where it fits', () => {
    // A B.Cu track under the route in a strip of board too narrow to pass it:
    // the via fits only back before the track starts.
    const under = `(segment (start 2 0) (end 16 0) (width 0.2) (layer "B.Cu") (net 2) (uuid "u"))`
    const strip = outline([-2, -0.6], [16, -0.6], [16, 0.6], [-2, 0.6])
    const p = new RouteSession(world(`${under}\n${strip}`, 0)).propose(withVia({ width: 0.2 }))
    expect(p.blocked).toBe(false)
    expect(p.via?.violation).toBe(false)
    expect(p.endsAt.x).toBeLessThanOrEqual(2 - 0.9 + 1e-3)
  })

  test("the via's pushes land as their own step", () => {
    const session = new RouteSession(world(board))
    session.propose(withVia({ mode: 'shove' }))
    session.markClick()
    expect(session.displaced().hiddenRefs).toHaveLength(1)
    session.markVia()
    expect(session.displaced().hiddenRefs).toHaveLength(1)
    // Backspace takes the via, and what it pushed springs back.
    session.undoClick()
    expect(session.displaced().hiddenRefs).toHaveLength(0)
  })
})

describe('R16: keepouts that forbid vias', () => {
  const board = viaKeepout(4, -1, 6, 1)

  test('the head passes over it; Highlight marks a via there, Avoid and Push set it outside', () => {
    const w = world(board)
    expect(new RouteSession(w).propose(request(tail, end)).blocked).toBe(false)
    const hl = new RouteSession(w).propose(withVia({ mode: 'highlight' }))
    expect(hl.blocked).toBe(true)
    expect(hl.via?.violation).toBe(true)
    expect(hl.marks.length).toBeGreaterThan(0)
    for (const mode of ['walkaround', 'shove'] as const) {
      const p = new RouteSession(w).propose(withVia({ mode }))
      expect(p.blocked).toBe(false)
      expect(p.via?.violation).toBe(false)
      // Outside the 4..6 × −1..1 area by the via's radius.
      const { x, y } = p.endsAt
      expect(x <= 4 - 0.3 + 1e-6 || x >= 6 + 0.3 - 1e-6 || Math.abs(y) >= 1 + 0.3 - 1e-6).toBe(true)
    }
  })

  test('only on the layers it applies to', () => {
    const front = new RouteSession(world(board)).propose(
      request(tail, end, { via: { size: 0.6, layers: ['F.Cu'] } })
    )
    expect(front.blocked).toBe(false)
  })
})

/** A mounting hole of `drill` mm at a source position: no copper, only its hole. */
const npth = (x: number, y: number, drill = 1): string =>
  `(footprint "T:H" (layer "F.Cu") (uuid "h-${x}-${y}") (at ${x} ${y})
    (pad "" np_thru_hole circle (at 0 0) (size ${drill} ${drill}) (drill ${drill}) (layers "*.Mask")))`

describe('R24: the via keeps its hole clear of other holes and copper', () => {
  // Board Setup's defaults: hole to hole 0.5, copper to hole 0.25. A 0.6 / 0.3
  // via at (5, 0) and a 1 mm hole 1.1 above it: the via's copper is 0.3 from
  // the hole (fine), its hole 0.45 (under 0.5).
  const board = npth(5, -1.1)
  const drilled = (o: Partial<RouteRequest> = {}): RouteRequest =>
    request(tail, end, {
      width: 0.2,
      clearance: 0.2,
      via: { size: 0.6, drill: 0.3, layers: LAYERS },
      ...o
    })
  const holeGap = (at: { x: number; y: number }): number =>
    Math.hypot(at.x - 5, at.y - 1.1) - 0.5 - 0.15

  test('Highlight marks the via and refuses the click', () => {
    const p = new RouteSession(rulesWorld(board)).propose(drilled({ mode: 'highlight' }))
    expect(p.via).toEqual({ at: end, violation: true })
    expect(p.blocked).toBe(true)
    expect(p.marks.length).toBeGreaterThan(0)
  })

  test('Avoid and Push set it where its hole keeps the spacing', () => {
    for (const mode of ['walkaround', 'shove'] as const) {
      const p = new RouteSession(rulesWorld(board)).propose(drilled({ mode }))
      expect(p.blocked).toBe(false)
      expect(p.via?.violation).toBe(false)
      expect(holeGap(p.endsAt)).toBeGreaterThanOrEqual(0.5 - 1e-6)
    }
  })

  test("a via's hole near another via's, of its own net too", () => {
    const p = new RouteSession(rulesWorld(via(5, -0.7, 1))).propose(drilled({ mode: 'highlight' }))
    expect(p.via?.violation).toBe(true)
    expect(p.violators).toEqual([{ type: 'via', index: 0 }])
    // The hole is marked as the via's, at its measured gap under the rule's.
    const hole = p.marks.find((m) => !m.copper && m.id !== undefined)
    expect(hole?.actual).toBeGreaterThanOrEqual(0)
    expect(hole?.actual).toBeLessThan(hole?.clearance ?? 0)
  })

  test("the route's own via placed before", () => {
    const pending = { segments: [], vias: [{ x: 5, y: 0.6, size: 0.6, drill: 0.3 }] }
    const p = new RouteSession(rulesWorld('')).propose(drilled({ mode: 'highlight' }), pending)
    expect(p.via?.violation).toBe(true)
  })

  test('without a drill, only its copper is judged', () => {
    const p = new RouteSession(rulesWorld(board)).propose(
      drilled({ mode: 'highlight', via: { size: 0.6, layers: LAYERS } })
    )
    expect(p.via?.violation).toBe(false)
  })

  test('a dragged via is held to it too', () => {
    const w = rulesWorld(`${via(0, 0, 1)}\n${board}`)
    const v = w.base.items.find((i) => i.ref.type === 'via')!
    const s = new ViaDragSession(w, v, 0.2)
    expect(s.update(end, 'highlight').viaViolation).toBe(true)
    expect(s.update({ x: 5, y: -1 }, 'highlight').viaViolation).toBe(false)
  })
})

describe('R15: a hole with no copper round it is an obstacle', () => {
  test('the head walks round it at the hole clearance', () => {
    const p = new RouteSession(rulesWorld(npth(2.5, 0))).propose(
      request(tail, end, { width: 0.2, clearance: 0.2 })
    )
    expect(p.blocked).toBe(false)
    expect(p.endsAt).toEqual(end)
    const path = pointsOf(p.segments)
    for (let i = 0; i < path.length - 1; i++) {
      const d = segmentToShape(
        { kind: 'circle', cx: 2.5, cy: 0, r: 0.5 },
        path[i].x,
        path[i].y,
        path[i + 1].x,
        path[i + 1].y,
        0.1
      )
      expect(d).toBeGreaterThanOrEqual(0.25 - 1e-6)
    }
  })
})
