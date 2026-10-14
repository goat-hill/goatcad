import { describe, expect, test } from 'vitest'
import { RouteSession } from '../engine'
import { segmentToShape } from '../../spatialIndex'
import { maxY, outline, pad, pointsOf, request, rulesWorld, track } from './routerFixture'

// docs/router-behavior.md Terms ("Clearance"), S1, S11: a route keeps from
// each item what the rules resolver gives for its net against that item.

/** SIG to OBS asks 0.7 mm, wider than the class's 0.2. */
const WIDE = `(version 1)
(rule wide (constraint clearance (min 0.7mm)) (condition "A.NetName == 'SIG' && B.NetName == 'OBS'"))`

const thin = { width: 0.2, clearance: 0.2, cornerMode: '45' as const }

describe('per-item clearance', () => {
  test("a pad's own clearance wider than the class is kept", () => {
    // Pad top at y = 1; the route's edge passes 0.5 above it.
    const tail = { x: 0, y: 1.6 }
    const cursor = { x: 10, y: 1.6 }
    const plain = new RouteSession(rulesWorld(pad(5, 0))).propose(request(tail, cursor, thin))
    expect(plain.state).toBe('clear')

    const w = rulesWorld(pad(5, 0, 2, 'P', ' (clearance 0.8)'))
    const p = new RouteSession(w).propose(request(tail, cursor, thin))
    expect(p.blocked).toBe(false)
    expect(p.state).toBe('walking')
    expect(maxY(pointsOf(p.segments))).toBeGreaterThan(1 + 0.8 + 0.1 - 1e-6)
  })

  test('a custom rule between two nets is kept, and marks at its clearance', () => {
    const body = track(-6, 0, 16, 0)
    const tail = { x: 0, y: 0.85 }
    const cursor = { x: 10, y: 0.85 }
    const hl = { ...thin, mode: 'highlight' as const }
    expect(new RouteSession(rulesWorld(body)).propose(request(tail, cursor, hl)).blocked).toBe(
      false
    )
    const p = new RouteSession(rulesWorld(body, WIDE)).propose(request(tail, cursor, hl))
    expect(p.blocked).toBe(true)
    // The mark is the track at the rule's 0.7, not the route's 0.2.
    expect(p.marks).toHaveLength(1)
    expect(p.marks[0].clearance).toBeCloseTo(0.7, 9)
    expect(p.marks[0].copper).toBe(true)
    // Its gap, edge to edge: the route's at 0.75, the 0.5 mm track's at 0.25.
    expect(p.marks[0].actual).toBeCloseTo(0.5, 9)
  })

  test('push: the pushed track keeps the rule from the head', () => {
    const body = track(-6, -0.5, 16, -0.5)
    const w = rulesWorld(body, WIDE)
    const session = new RouteSession(w)
    const p = session.propose(
      request({ x: 0, y: 0 }, { x: 10, y: 0 }, { mode: 'shove', width: 0.5, clearance: 0.2 })
    )
    expect(p.blocked).toBe(false)
    expect(p.state).toBe('pushing')
    // Clear of the head by the rule's 0.7, not the route's 0.2: 0.25 + 0.7 + 0.25 off its axis.
    const displaced = session.displaced().segments
    expect(displaced.length).toBeGreaterThan(0)
    for (const d of displaced)
      expect(
        segmentToShape(
          { kind: 'capsule', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, halfWidth: d.width / 2 },
          0,
          0,
          10,
          0,
          0.25
        )
      ).toBeGreaterThan(0.7 - 1e-6)
    expect(maxY(pointsOf(displaced))).toBeCloseTo(0.25 + 0.7 + 0.25, 6)
  })
})

describe('S11: what the clearance is measured against', () => {
  test('the pad the head walks round is named', () => {
    const w = rulesWorld(pad(5, 0))
    const p = new RouteSession(w).propose(request({ x: 0, y: 0 }, { x: 10, y: 0 }, thin))
    expect(p.state).toBe('walking')
    expect(p.huggingId).toBeDefined()
    expect(w.base.items[p.huggingId!].ref.type).toBe('pad')
  })

  test('nothing in the way, nothing named', () => {
    const p = new RouteSession(rulesWorld(pad(5, 0))).propose(
      request({ x: 0, y: 5 }, { x: 10, y: 5 }, thin)
    )
    expect(p.huggingId).toBeUndefined()
  })
})

describe('edge clearance per net', () => {
  test("R16: a route keeps its own net's edge clearance, not the largest any rule asks", () => {
    const board = outline([-2, -10], [30, -10], [30, 10], [-2, 10])
    const rule = `(version 1)
(rule edge (constraint edge_clearance (min 1.5mm)) (condition "A.NetName == 'SIG' || B.NetName == 'SIG'"))`
    const w = rulesWorld(board, rule)
    const off = { x: 40, y: 0 }
    const sig = new RouteSession(w).propose(request({ x: 0, y: 0 }, off, thin))
    expect(sig.blocked).toBe(false)
    expect(sig.endsAt.x).toBeCloseTo(30 - 1.5 - 0.1, 3)
    const other = new RouteSession(w).propose(request({ x: 0, y: 0 }, off, { ...thin, net: 2 }))
    expect(other.blocked).toBe(false)
    // The board's own minimum, 0.3.
    expect(other.endsAt.x).toBeCloseTo(30 - 0.3 - 0.1, 3)
  })
})
