import { describe, expect, test } from 'vitest'
import { arcPolyline, RouteSession, type RouteProposal, type RouteRequest } from '../engine'
import { selfCrosses } from '../geometry'
import { shapeHulls } from '../hulls'
import type { Pt } from '../../spatialIndex'
import {
  allAngled,
  keepout,
  maxY,
  minY,
  outline,
  pad,
  pointsOf,
  request,
  track,
  world
} from './routerFixture'

// docs/router-behavior.md, routing: R2–R17 and F2.

const O = { x: 0, y: 0 }

/** Drive one session through a sequence of cursor positions; the last proposal. */
const drive = (
  session: RouteSession,
  cursors: Pt[],
  o: Partial<RouteRequest> = {}
): RouteProposal => {
  let last = session.propose(request(O, cursors[0], o))
  for (const c of cursors.slice(1)) last = session.propose(request(O, c, o))
  return last
}

describe('which side of an obstacle the route takes', () => {
  // A 2 × 2 pad centered at (5, 0).
  const board = pad(5, 0)

  test('R7, R8: the route takes the shorter way every frame, whatever the mouse did before', () => {
    // Swept over the pad's top and on down past its middle, the route still
    // passes underneath, the shorter way, as a fresh route to the same
    // cursor does: no side is kept (KiCad's walkaround).
    const swept = drive(new RouteSession(world(board)), [
      { x: 5, y: 5 },
      { x: 10, y: 4 },
      { x: 10, y: 0 },
      { x: 10, y: -1 }
    ])
    const fresh = new RouteSession(world(board)).propose(request(O, { x: 10, y: -1 }))
    expect(swept.blocked).toBe(false)
    expect(swept.endsAt).toEqual({ x: 10, y: -1 })
    expect(maxY(pointsOf(swept.segments))).toBeLessThan(0.5)
    expect(swept.segments).toEqual(fresh.segments)
  })

  test('R11, R12: through a pad and out, the route wraps the side it went in on', () => {
    for (const side of [1, -1]) {
      const session = new RouteSession(world(board))
      const inside = drive(session, [
        { x: 2, y: 0.5 * side },
        { x: 5, y: 0.5 * side }
      ])
      // Inside: the head stops at the pad's clearance, legally.
      expect(inside.blocked).toBe(false)
      expect(Math.hypot(inside.endsAt.x - 5, inside.endsAt.y - 0.5 * side)).toBeGreaterThan(0.5)
      const out = session.propose(request(O, { x: 8, y: 0.5 * side }))
      expect(out.blocked).toBe(false)
      expect(out.endsAt).toEqual({ x: 8, y: 0.5 * side })
      const path = pointsOf(out.segments)
      if (side > 0) expect(maxY(path)).toBeGreaterThan(1.5)
      else expect(minY(path)).toBeLessThan(-1.5)
    }
  })

  test('R11: a cursor inside a pad holds the head at its clearance, nearest the cursor', () => {
    // The pad spans x 4–6, y −1–1, its clearance outline 0.75 beyond.
    const session = new RouteSession(world(board))
    for (const cursor of [
      { x: 4.5, y: 0 },
      { x: 5, y: 0.6 },
      { x: 5.4, y: -0.4 },
      { x: 5.6, y: -0.8 }
    ]) {
      const p = session.propose(request(O, cursor))
      expect(p.blocked).toBe(false)
      expect(p.segments.every((s) => !s.violation)).toBe(true)
      // Outside the pad's copper, and no further from the cursor than its outline's far side.
      const { x, y } = p.endsAt
      expect(x < 4 || x > 6 || y < -1 || y > 1).toBe(true)
      expect(Math.hypot(x - cursor.x, y - cursor.y)).toBeLessThan(2)
    }
  })

  test('R39: a way round far longer than the straight line stops short, at the obstacle', () => {
    // A long wall between the tail and a cursor just beyond it: the way round
    // is some six times the straight line, so the head goes no further than
    // the wall, at its point nearest the cursor, rather than round it.
    const session = new RouteSession(world(track(2, -10, 2, 10)))
    const p = drive(session, [
      { x: 1, y: 0 },
      { x: 4, y: 0 }
    ])
    expect(p.blocked).toBe(false)
    expect(p.state).toBe('walking')
    expect(p.endsAt.x).toBeCloseTo(1, 3)
    expect(Math.abs(p.endsAt.y)).toBeLessThan(0.5)
  })

  test('R39: past three times the straight line, the head follows the way round only to 1.5 times it', () => {
    // A wall from world y −10 upward, the cursor beyond it and below: round
    // its foot, tidied, is over three times the line. The first 1.5 times of
    // the way round runs down the near side, so the head stops there, at its
    // point nearest the cursor.
    const cursor = { x: 6, y: -1 }
    const p = new RouteSession(world(track(2, 10, 2, -40))).propose(request(O, cursor))
    expect(p.blocked).toBe(false)
    expect(p.state).toBe('walking')
    const path = pointsOf(p.segments)
    expect(Math.max(...path.map((q) => q.x))).toBeLessThan(2)
    expect(p.endsAt.x).toBeCloseTo(1, 3)
    expect(p.endsAt.y).toBeCloseTo(-1, 3)
  })

  test('R39: a way round within three times the straight line is taken whole', () => {
    // The same wall, shorter: round its end is under three times the line.
    const p = new RouteSession(world(track(2, -1, 2, 1))).propose(request(O, { x: 4, y: 0 }))
    expect(p.endsAt).toEqual({ x: 4, y: 0 })
  })

  test('R38: walked round what is beside it, a route leaves its pad by the exit that keeps it cleanest', () => {
    // A wide pad of the route's net, and a tall one of another net just to
    // its right. The cursor is to the right, but the route must go up and
    // over: it leaves upward (or through the top corner) rather than out to
    // the right and then up at a right angle — and never across the pad's edge.
    const own = `(footprint "T:S" (layer "F.Cu") (uuid "f-s") (at 0 0)
      (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu") (net 1 "SIG")))`
    const wall = `(footprint "T:W" (layer "F.Cu") (uuid "f-w") (at 2.5 0)
      (pad "1" smd rect (at 0 0) (size 1 3) (layers "F.Cu") (net 2 "OBS")))`
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2 }
    const p = new RouteSession(world(`${own}\n${wall}`)).propose(request(O, { x: 6, y: 0 }, o))
    expect(p.endsAt).toEqual({ x: 6, y: 0 })
    const path = pointsOf(p.segments)
    const first = { x: path[1].x - path[0].x, y: path[1].y - path[0].y }
    const alongAxis = Math.abs(first.x) < 1e-9 || Math.abs(first.y) < 1e-9
    expect(alongAxis).toBe(true)
    // Where the first leg leaves the copper (|x| ≤ 1, |y| ≤ 0.5), it turns
    // no more than 45°, as does every corner after.
    for (let i = 1; i < path.length - 1; i++) {
      const u = { x: path[i].x - path[i - 1].x, y: path[i].y - path[i - 1].y }
      const v = { x: path[i + 1].x - path[i].x, y: path[i + 1].y - path[i].y }
      const turn = Math.acos(
        (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))
      )
      expect(turn).toBeLessThanOrEqual(Math.PI / 4 + 1e-6)
    }
  })

  test('R9: head-on with no history takes the shorter side', () => {
    const p = new RouteSession(world(pad(5, -0.3))).propose(request(O, { x: 10, y: 0 }))
    expect(p.blocked).toBe(false)
    // The pad sits a little above the line (source y −0.3): under is shorter.
    expect(minY(pointsOf(p.segments))).toBeLessThan(-1)
  })
})

describe('reaching the cursor', () => {
  test('R13, R14: a gap narrower than the track never lets it through', () => {
    // Two pads at x = 5 with 1.2 mm of board between them; the route needs
    // its width plus clearance on both sides, 0.5 + 2 × 0.5 = 1.5.
    const w = world(`${pad(5, 1.6, 2, 'A')}\n${pad(5, -1.6, 2, 'B')}`)
    const p = new RouteSession(w).propose(request({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(p.segments.every((s) => !s.violation)).toBe(true)
    const through = pointsOf(p.segments).every((q) => Math.abs(q.y) < 0.01)
    expect(through).toBe(false)
  })

  test('R14: an unreachable cursor stops the head short, showing nothing illegal', () => {
    const w = world(track(5, -2, 5, 2))
    const p = new RouteSession(w).propose(request(O, { x: 5, y: 0 }))
    expect(p.blocked).toBe(false)
    expect(p.segments.every((s) => !s.violation)).toBe(true)
    const gap = Math.hypot(p.endsAt.x - 5, p.endsAt.y)
    expect(gap).toBeGreaterThan(0.5)
    expect(gap).toBeLessThan(5)
  })

  test('R2: a route may leave from inside a neighbor pad’s clearance', () => {
    // A 0.4 mm pad whose edge is 0.4 from the tail: inside clearance + half width.
    const w = world(pad(0.6, 0, 0.4))
    const p = new RouteSession(w).propose(request(O, { x: 0, y: 5 }))
    expect(p.segments.length).toBeGreaterThan(0)
    expect(p.endsAt).toEqual({ x: 0, y: 5 })
  })

  /** How near a path comes to the 0.4 mm neighbor pad at (0.6, 0): its copper spans x 0.4–0.8, y ±0.2. */
  const nearNeighbor = (path: readonly Pt[]): number => {
    let best = Infinity
    for (let i = 0; i < path.length - 1; i++)
      for (let t = 0; t <= 1; t += 0.01) {
        const x = path[i].x + (path[i + 1].x - path[i].x) * t
        const y = path[i].y + (path[i + 1].y - path[i].y) * t
        const dx = Math.max(0, Math.abs(x - 0.6) - 0.2)
        const dy = Math.max(0, Math.abs(y) - 0.2)
        best = Math.min(best, Math.hypot(dx, dy))
      }
    return best
  }

  test('R2: leaving a neighbor pad’s clearance, the head never crosses the pad', () => {
    // The cursor beyond the neighbor: the head leaves the clearance it starts
    // in, then goes round the pad as any obstacle, never through its copper.
    const w = world(pad(0.6, 0, 0.4))
    const p = new RouteSession(w).propose(request(O, { x: 3, y: 0 }))
    expect(p.endsAt).toEqual({ x: 3, y: 0 })
    expect(nearNeighbor(pointsOf(p.segments))).toBeGreaterThan(0.25 - 1e-6)
  })

  test('R2: in Push the head pushes from inside a neighbor pad’s clearance', () => {
    // A track of another net across the way out: it is pushed, not walked.
    const w = world(`${pad(0.6, 0, 0.4)}\n${track(-3, -3, 3, -3, 3)}`)
    const session = new RouteSession(w)
    const p = session.propose(request(O, { x: 0, y: 5 }, { mode: 'shove' }))
    expect(p.endsAt).toEqual({ x: 0, y: 5 })
    expect(session.displaced().segments.length).toBeGreaterThan(0)
  })

  test('R2: a tail inside a neighbor’s 45° outline but clear of it walks out', () => {
    // A round pad down-left of the tail, 1.3 from it at 22.5°: clear of the
    // pad by its clearance (1.25 from its center), but inside the octagon
    // the 45° walk goes round. The head still walks round it to the cursor.
    const a = (22.5 * Math.PI) / 180
    const cx = -1.3 * Math.cos(a)
    const cy = -1.3 * Math.sin(a)
    const w = world(
      `(footprint "T:R" (layer "F.Cu") (uuid "f-r") (at ${cx} ${-cy})
        (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "OBS")))`
    )
    const cursor = { x: cx * 2.5, y: cy * 2.5 }
    const p = new RouteSession(w).propose(request(O, cursor, { cornerMode: '45' }))
    expect(p.blocked).toBe(false)
    expect(p.endsAt.x).toBeCloseTo(cursor.x, 6)
    expect(p.endsAt.y).toBeCloseTo(cursor.y, 6)
  })
})

describe('R3: rounded corners', () => {
  const rounded = { cornerMode: '45' as const, rounded: true, diagFirst: false }

  test('the bend from the tail is a straight run and one 45° arc into the cursor', () => {
    const p = new RouteSession(world('')).propose(request(O, { x: 10, y: 4 }, rounded))
    expect(p.endsAt).toEqual({ x: 10, y: 4 })
    const arcs = p.segments.filter((s) => s.mid)
    expect(arcs).toHaveLength(1)
    const arc = arcs[0]
    // Tangent to the run along y = 0 where it starts, and to the 45° diagonal where it ends.
    expect(arc.y0).toBeCloseTo(0, 9)
    expect(arc.x1).toBeCloseTo(10, 9)
    expect(arc.y1).toBeCloseTo(4, 9)
    const t = 4 * Math.SQRT2
    const r = t / Math.tan(Math.PI / 8)
    const c = { x: 6 - t, y: r }
    for (const q of [{ x: arc.x0, y: arc.y0 }, arc.mid!, { x: arc.x1, y: arc.y1 }])
      expect(Math.hypot(q.x - c.x, q.y - c.y)).toBeCloseTo(r, 6)
  })

  test('an arc that would break clearance is drawn smaller, never through what is inside the bend', () => {
    const w = world(pad(5, -2, 1))
    const p = new RouteSession(w).propose(request(O, { x: 10, y: 4 }, rounded))
    expect(p.blocked).toBe(false)
    for (const s of p.segments) {
      const run = s.mid
        ? arcPolyline({ x: s.x0, y: s.y0 }, s.mid, { x: s.x1, y: s.y1 }, 32)
        : [
            { x: s.x0, y: s.y0 },
            { x: s.x1, y: s.y1 }
          ]
      expect(w.pathViolates(run, 0.25, 0.5, { layer: 'F.Cu', excludeNet: 1 })).toBe(false)
    }
  })
})

describe('which obstacle comes first', () => {
  test('several on one segment: the one whose clearance the line enters first', () => {
    // A track slanting down toward the line enters its clearance (1.0 from
    // its centerline) near x = 6.4, though its nearest end is at x = 10; a
    // small pad at x = 8 is entered near x = 7.05. The track comes first.
    const w = world(`${track(2, -1.5, 10, -0.6)}\n${pad(8, 0, 0.4)}`)
    const hit = w.firstObstacle([O, { x: 10, y: 0 }], 0.25, 0.5, { layer: 'F.Cu', excludeNet: 1 })
    expect(hit?.ref.type).toBe('segment')
  })
})

describe('shape of the route', () => {
  test('R4: the posture follows how the mouse left the tail', () => {
    const w = world('')
    const auto = { cornerMode: '45' as const, autoPosture: true, diagFirst: false }
    // Set off diagonally: the diagonal comes first.
    const diag = drive(
      new RouteSession(w),
      [
        { x: 2, y: 2 },
        { x: 10, y: 4 }
      ],
      auto
    )
    expect(diag.diagFirst).toBe(true)
    expect(diag.segments[0].y1).toBeCloseTo(diag.segments[0].x1, 9)
    // Set off straight: the straight leg comes first.
    const straight = drive(
      new RouteSession(w),
      [
        { x: 2, y: 0 },
        { x: 10, y: 4 }
      ],
      auto
    )
    expect(straight.diagFirst).toBe(false)
    expect(straight.segments[0].y1).toBeCloseTo(0, 9)
    // `/` flips it.
    const flipped = drive(
      new RouteSession(w),
      [
        { x: 2, y: 0 },
        { x: 10, y: 4 }
      ],
      {
        ...auto,
        diagFirst: true
      }
    )
    expect(flipped.diagFirst).toBe(true)
  })

  test('R4: the posture is read from the whole way the mouse went, not a first wobble', () => {
    const w = world('')
    const auto = { cornerMode: '45' as const, autoPosture: true, diagFirst: false }
    // The first frame clear of the tail wobbles up at 40°; the mouse then
    // runs along the x axis and only late turns up: the straight leg first.
    const p = drive(
      new RouteSession(w),
      [
        { x: 1.2, y: 1 },
        { x: 3, y: 0.3 },
        { x: 6, y: 0.2 },
        { x: 10, y: 0.5 },
        { x: 14, y: 3 },
        { x: 16, y: 5 }
      ],
      auto
    )
    expect(p.diagFirst).toBe(false)
    expect(p.segments[0].y1).toBeCloseTo(0, 9)
  })

  test('R4: leaving a click, the head goes straight on, or turns the gentler way', () => {
    const w = world('')
    const auto = { cornerMode: '45' as const, autoPosture: true, diagFirst: false }
    const pending = {
      segments: [{ x0: -5, y0: 0, x1: 0, y1: 0, layer: 'F.Cu', width: 0.25 }],
      vias: []
    }
    // Arrived heading +x, the mouse leaving at 45°: the head carries on
    // along +x first rather than turn at the click.
    const on = new RouteSession(w).propose(request(O, { x: 6, y: 4 }, auto), pending)
    expect(on.segments[0].y1).toBeCloseTo(0, 9)
    // The mouse leaving straight up: a 45° turn at the click, not a right angle.
    const up = drive(
      new RouteSession(w),
      [
        { x: 0, y: 2 },
        { x: 2, y: 6 }
      ],
      auto
    )
    expect(up.diagFirst).toBe(false)
    const turned = new RouteSession(w)
    turned.propose(request(O, { x: 0, y: 2 }, auto), pending)
    const p = turned.propose(request(O, { x: 2, y: 6 }, auto), pending)
    expect(p.segments[0].x1).toBeCloseTo(p.segments[0].y1, 9)
  })

  test('R4: leaving a click, the head does not turn back on the segment before it', () => {
    const w = world('')
    const auto = { cornerMode: '45' as const, autoPosture: true, diagFirst: false }
    // Arrived heading +x; the cursor up and to the left, at an angle that sets
    // the diagonal first — which would leave at 45° to the segment before.
    // Straight up first turns a clean 90° instead.
    const pending = {
      segments: [{ x0: -5, y0: 0, x1: 0, y1: 0, layer: 'F.Cu', width: 0.25 }],
      vias: []
    }
    const session = new RouteSession(w)
    const p = session.propose(request(O, { x: -4, y: 6 }, auto), pending)
    expect(p.diagFirst).toBe(false)
    expect(p.segments[0].x1).toBeCloseTo(0, 9)
    // With no segment before it, the mouse's posture stands.
    expect(new RouteSession(w).propose(request(O, { x: -4, y: 6 }, auto)).diagFirst).toBe(true)
  })

  test('90° mode hugs with only 0° and 90° segments', () => {
    const p = new RouteSession(world(pad(5, 0))).propose(
      request(O, { x: 10, y: 0 }, { cornerMode: '90' })
    )
    expect(p.blocked).toBe(false)
    expect(allAngled(pointsOf(p.segments), 90)).toBe(true)
  })

  test('R6: going round a pad the route runs at clearance, not wider', () => {
    const p = new RouteSession(world(pad(5, 0))).propose(request(O, { x: 10, y: 0 }))
    const path = pointsOf(p.segments)
    // Pad half-size 1 + clearance 0.5 + half width 0.25.
    const off = Math.max(maxY(path), -minY(path))
    expect(off).toBeGreaterThanOrEqual(1.75 - 1e-6)
    expect(off).toBeLessThan(1.75 * 1.1)
  })

  test('R3, R17: across a sweep of cursors over a crowded field, every head is legal and clean', () => {
    const field = [
      pad(4, 0, 2, 'A'),
      pad(9, 3, 1.5, 'B'),
      pad(9, -3, 1.5, 'C'),
      track(12, -8, 12, 8),
      track(2, -6, 8, -6)
    ].join('\n')
    for (const cornerMode of ['45', '90', 'free'] as const) {
      const session = new RouteSession(world(field))
      for (let x = -2; x <= 16; x += 0.9) {
        for (let y = -8; y <= 8; y += 1.1) {
          const p = session.propose(request(O, { x, y }, { cornerMode }))
          const path = pointsOf(p.segments)
          if (path.length === 0) continue
          expect(path[0]).toEqual(O)
          expect(selfCrosses(path)).toBe(false)
          expect(p.segments.every((s) => !s.violation)).toBe(true)
          if (cornerMode !== 'free') {
            expect(allAngled(path, cornerMode === '90' ? 90 : 45)).toBe(true)
          }
        }
      }
    }
  })

  test('Q2: the same moves give the same route', () => {
    const cursors = [
      { x: 5, y: 5 },
      { x: 10, y: 4 },
      { x: 10, y: -4 }
    ]
    const a = drive(new RouteSession(world(pad(5, 0))), cursors)
    const b = drive(new RouteSession(world(pad(5, 0))), cursors)
    expect(a.segments).toEqual(b.segments)
  })
})

describe('the board edge and keepouts', () => {
  // A board from x −2 to 30 and y −10 to 10, and the same with a notch cut
  // from its top edge down to y 2, between x 10 and 14 (world y, up).
  const board = outline([-2, -10], [30, -10], [30, 10], [-2, 10])
  const notched = outline(
    [-2, -10],
    [10, -10],
    [10, -2],
    [14, -2],
    [14, -10],
    [30, -10],
    [30, 10],
    [-2, 10]
  )
  // Edge clearance 0.5 plus half the track's 0.5.
  const inset = 0.75

  test('R16: a cursor off the board brings the head to the edge, at edge clearance', () => {
    const session = new RouteSession(world(board))
    const across = session.propose(request(O, { x: 40, y: 0 }))
    expect(across.blocked).toBe(false)
    expect(across.endsAt.x).toBeCloseTo(30 - inset, 3)
    expect(across.endsAt.y).toBeCloseTo(0, 9)
    const corner = session.propose(request(O, { x: 40, y: 20 }))
    expect(corner.blocked).toBe(false)
    expect(corner.endsAt.x).toBeCloseTo(30 - inset, 3)
    expect(corner.endsAt.y).toBeCloseTo(10 - inset, 3)
  })

  test('R16: the edge is held at its own clearance, not the route’s', () => {
    const p = new RouteSession(world(board, 1)).propose(request(O, { x: 40, y: 0 }))
    expect(p.blocked).toBe(false)
    expect(p.endsAt.x).toBeCloseTo(30 - 1.25, 3)
  })

  test('R16: across a notch the route goes round its tip, on the board', () => {
    for (const mode of ['walkaround', 'shove'] as const) {
      for (const cornerMode of ['45', '90', 'free'] as const) {
        const w = world(notched)
        const p = new RouteSession(w).propose(
          request({ x: 0, y: 6 }, { x: 24, y: 6 }, { mode, cornerMode })
        )
        const path = pointsOf(p.segments)
        expect(p.blocked).toBe(false)
        expect(p.endsAt).toEqual({ x: 24, y: 6 })
        expect(minY(path)).toBeLessThanOrEqual(2 - inset + 1e-6)
        expect(minY(path)).toBeGreaterThan(2 - inset * 1.5)
        expect(path.every((q) => w.onBoard(q))).toBe(true)
      }
    }
  })

  test('R16: along the edge the route hugs it from inside', () => {
    // Cursor beyond the notch's far wall, closer to the top edge than its
    // clearance: reached round the tip, and held at clearance from the edge.
    const w = world(notched)
    const p = new RouteSession(w).propose(request({ x: 0, y: 6 }, { x: 16, y: 9.6 }))
    expect(p.blocked).toBe(false)
    expect(p.endsAt.x).toBeCloseTo(16, 9)
    expect(p.endsAt.y).toBeCloseTo(10 - inset, 3)
    expect(pointsOf(p.segments).every((q) => w.onBoard(q))).toBe(true)
  })

  test('R16: a route goes into a recess the board leaves round a notch', () => {
    // An L-shaped notch: down from the top edge at x 10–14, then right to x 20
    // at y 2–6, leaving the board between it and the top edge at x 14–20.
    const hooked = outline(
      [-2, -10],
      [10, -10],
      [10, -2],
      [20, -2],
      [20, -6],
      [14, -6],
      [14, -10],
      [30, -10],
      [30, 10],
      [-2, 10]
    )
    for (const mode of ['walkaround', 'shove'] as const) {
      const w = world(hooked)
      const p = new RouteSession(w).propose(request({ x: 25, y: 8 }, { x: 16, y: 8 }, { mode }))
      expect(p.blocked).toBe(false)
      expect(p.endsAt).toEqual({ x: 16, y: 8 })
      expect(pointsOf(p.segments).every((q) => w.onBoard(q))).toBe(true)
    }
  })

  test('R16: a route goes into the mouth of a keepout, KiCad walking its true outline', () => {
    // A C-shaped track keepout open to the right: its mouth is x 6–10, y −1 to 1.
    const c = `(zone (layers "F.Cu") (uuid "ko-c") (hatch full 0.5)
    (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy 4 -3) (xy 10 -3) (xy 10 -1) (xy 6 -1) (xy 6 1) (xy 10 1) (xy 10 3) (xy 4 3))))`
    for (const mode of ['walkaround', 'shove'] as const) {
      const p = new RouteSession(world(c)).propose(
        request({ x: 14, y: 0 }, { x: 7, y: 0 }, { mode })
      )
      expect(p.blocked).toBe(false)
      expect(p.endsAt).toEqual({ x: 7, y: 0 })
      const inside = new RouteSession(world(c)).propose(
        request({ x: 14, y: 0 }, { x: 5.5, y: 0 }, { mode })
      )
      expect(inside.endsAt.x).toBeCloseTo(6 + 0.25, 3)
    }
  })

  test('R16: a cutout is walked round like an obstacle', () => {
    // A 2 × 4 cutout from x 6 to 8.
    const w = world(`${board}\n${outline([6, -2], [8, -2], [8, 2], [6, 2])}`)
    const p = new RouteSession(w).propose(request(O, { x: 12, y: 0 }))
    const path = pointsOf(p.segments)
    expect(p.blocked).toBe(false)
    expect(p.endsAt).toEqual({ x: 12, y: 0 })
    const off = Math.max(maxY(path), -minY(path))
    expect(off).toBeGreaterThanOrEqual(2 + inset - 1e-6)
    expect(off).toBeLessThan((2 + inset) * 1.1)
  })

  test('R16: a track keepout is walked round at no clearance, and never entered', () => {
    // A keepout from x 4 to 6, y −2 to 2; the track keeps only its half width off.
    for (const mode of ['walkaround', 'shove'] as const) {
      const w = world(keepout(4, -2, 6, 2))
      const round = new RouteSession(w).propose(request(O, { x: 10, y: 0 }, { mode }))
      const path = pointsOf(round.segments)
      expect(round.blocked).toBe(false)
      expect(round.endsAt).toEqual({ x: 10, y: 0 })
      const off = Math.max(maxY(path), -minY(path))
      expect(off).toBeGreaterThanOrEqual(2.25 - 1e-6)
      expect(off).toBeLessThan(2.25 * 1.1)

      const inside = new RouteSession(w).propose(request(O, { x: 5, y: 0.5 }, { mode }))
      expect(inside.blocked).toBe(false)
      expect(inside.endsAt.x).toBeCloseTo(4 - 0.25, 3)
    }
  })

  test('R16: pushed copper stays clear of the edge', () => {
    // A track of another net 2 mm inside the right edge, the head pressing
    // it towards the edge: it moves only as far as the edge allows.
    const w = world(`${board}\n${track(28, -8, 28, 8)}`)
    for (const x of [27, 27.5, 28, 29]) {
      const session = new RouteSession(w)
      const p = session.propose(request(O, { x, y: 0 }, { mode: 'shove' }))
      expect(p.blocked).toBe(false)
      const pushed = session.displaced().segments
      if (x === 27.5) expect(pushed.length).toBeGreaterThan(0)
      for (const s of pushed) expect(Math.max(s.x0, s.x1)).toBeLessThanOrEqual(30 - inset + 1e-6)
    }
  })

  test('F2: crossing the edge in highlight mode outlines the edge clearance', () => {
    const p = new RouteSession(world(board)).propose(
      request(O, { x: 29.5, y: 0 }, { mode: 'highlight' })
    )
    expect(p.blocked).toBe(true)
    expect(p.violators).toEqual([])
    expect(p.marks.length).toBe(1)
  })
})

describe('feedback', () => {
  test('F2: highlight names what it violates and outlines its clearance', () => {
    const w = world(track(5, -2, 5, 2))
    const p = new RouteSession(w).propose(request(O, { x: 10, y: 0 }, { mode: 'highlight' }))
    expect(p.blocked).toBe(true)
    expect(p.state).toBe('violating')
    expect(p.violators).toEqual([{ type: 'segment', index: 0 }])
    expect(p.marks.length).toBe(1)
  })
})

describe('obstacle outlines', () => {
  test('fitted to 45° they contain the exact outline and keep to eight directions', () => {
    const shape = { kind: 'capsule' as const, x0: 0, y0: 0, x1: 3, y1: 1, halfWidth: 0.25 }
    const [exact] = shapeHulls(shape, 0.5, 0.25, 'free')
    const [fitted] = shapeHulls(shape, 0.5, 0.25, '45')
    expect(allAngled([...fitted, fitted[0]])).toBe(true)
    // Every exact vertex lies within the fitted outline (or on it).
    for (const p of exact) {
      let inside = true
      for (let i = 0; i < fitted.length; i++) {
        const a = fitted[i]
        const b = fitted[(i + 1) % fitted.length]
        // Clockwise ring: inside is to the right of each edge.
        if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 1e-9) inside = false
      }
      expect(inside).toBe(true)
    }
  })
})

describe('R38: pad exits', () => {
  // A 2 × 1 mm pad of the routed net at the origin, long along x.
  const own = `(footprint "T:O" (layer "F.Cu") (uuid "f-own") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu") (net 1 "SIG")))`
  const req = (tail: Pt, cursor: Pt): RouteRequest =>
    request(tail, cursor, { cornerMode: '45', autoPosture: true, diagFirst: false, width: 0.25 })

  test('leaving, the head runs out along the pad to its edge before it bends', () => {
    const p = new RouteSession(world(own)).propose(req({ x: 0, y: 0 }, { x: 5, y: 3 }))
    const path = pointsOf(p.segments)
    expect(path[0]).toEqual({ x: 0, y: 0 })
    expect(path[1].y).toBeCloseTo(0, 9)
    expect(path[1].x).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(p.endsAt).toEqual({ x: 5, y: 3 })
    expect(allAngled(path)).toBe(true)
  })

  test('arriving, it comes in along the pad from its edge', () => {
    const p = new RouteSession(world(own)).propose(req({ x: -5, y: 1 }, { x: 0, y: 0 }))
    const path = pointsOf(p.segments)
    expect(path[path.length - 1]).toEqual({ x: 0, y: 0 })
    expect(path[path.length - 2].y).toBeCloseTo(0, 9)
    expect(path[path.length - 2].x).toBeLessThanOrEqual(-1 + 1e-9)
  })

  test('with pad connections not optimized, the bend leaves the anchor directly', () => {
    const p = new RouteSession(world(own), { smartPads: false }).propose(
      req({ x: 0, y: 0 }, { x: 5, y: 3 })
    )
    const path = pointsOf(p.segments)
    expect(path[1].x).toBeCloseTo(path[1].y, 9)
  })

  test('in 90° mode no exit is fitted: the bend leaves the anchor directly (KiCad)', () => {
    // Across first toward (3, 5): an exit would go up the pad's short axis to
    // its edge, then across; without one, the first leg runs from the anchor.
    const p = new RouteSession(world(own)).propose({
      ...req({ x: 0, y: 0 }, { x: 3, y: 5 }),
      cornerMode: '90',
      diagFirst: true
    })
    const path = pointsOf(p.segments)
    expect(path[0]).toEqual({ x: 0, y: 0 })
    expect(path[1].x).toBeCloseTo(3, 9)
    expect(path[1].y).toBeCloseTo(0, 9)
    expect(p.endsAt).toEqual({ x: 3, y: 5 })
    expect(allAngled(path, 90)).toBe(true)
  })

  test('with the posture forced by `/`, no exit is fitted (KiCad)', () => {
    const p = new RouteSession(world(own)).propose({
      ...req({ x: 0, y: 0 }, { x: 5, y: 3 }),
      postureForced: true
    })
    const path = pointsOf(p.segments)
    expect(path[1].x).toBeCloseTo(path[1].y, 9)
  })
})

describe('R4: without the mouse path', () => {
  const auto = { cornerMode: '45' as const, autoPosture: true, diagFirst: false }
  test('the posture is the one the settings start from, `/` flipping it', () => {
    const w = world('')
    const leaves = [
      { x: 2, y: 2 },
      { x: 10, y: 4 }
    ]
    const straight = drive(new RouteSession(w, { autoPosture: false }), leaves, auto)
    expect(straight.diagFirst).toBe(false)
    const diag = drive(
      new RouteSession(w, { autoPosture: false, startDiagonal: true }),
      leaves,
      auto
    )
    expect(diag.diagFirst).toBe(true)
    const flipped = drive(new RouteSession(w, { autoPosture: false }), leaves, {
      ...auto,
      diagFirst: true
    })
    expect(flipped.diagFirst).toBe(true)
  })
})
