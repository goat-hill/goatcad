import { describe, expect, test } from 'vitest'
import { RouteSession, type RouteRequest } from '../engine'
import type { PendingCopper } from '../shove'
import { segmentToShape } from '../../spatialIndex'
import {
  allAngled,
  maxY,
  minY,
  pad,
  pointsOf,
  request,
  rulesWorld,
  track,
  via,
  world
} from './routerFixture'

// Push mode throughout (docs/router-behavior.md P1–P9).
const push = (
  tail: { x: number; y: number },
  cursor: { x: number; y: number },
  o: Partial<RouteRequest> = {}
): RouteRequest => request(tail, cursor, { mode: 'shove', ...o })

const noPending: PendingCopper = { segments: [], vias: [] }

// A foreign track running just above the route corridor, its ends far
// outside the head's reach. Source y −0.5 is world y +0.5.
const parallelTrack = track(-6, -0.5, 16, -0.5)

/** The least gap between any displaced segment's copper and the head's (half width `hw`). */
const gapToHead = (
  displaced: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; width: number }>,
  head: ReadonlyArray<{ x: number; y: number }>,
  hw: number
): number => {
  let best = Infinity
  for (const d of displaced)
    for (let i = 0; i < head.length - 1; i++)
      best = Math.min(
        best,
        segmentToShape(
          { kind: 'capsule', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, halfWidth: d.width / 2 },
          head[i].x,
          head[i].y,
          head[i + 1].x,
          head[i + 1].y,
          hw
        )
      )
  return best
}

describe('push', () => {
  test('P2: the head stays straight; the track moves aside in 45° shapes, its ends kept', () => {
    const session = new RouteSession(world(parallelTrack))
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(p.blocked).toBe(false)
    expect(p.state).toBe('pushing')
    expect(p.segments).toHaveLength(1)
    expect(p.endsAt).toEqual({ x: 10, y: 0 })

    const displaced = session.displaced()
    expect(displaced.hiddenRefs).toEqual([{ type: 'segment', index: 0 }])
    // Clear of the head by its clearance, and no further: 0.25 + 0.5 + 0.25 off the axis.
    expect(gapToHead(displaced.segments, pointsOf(p.segments), 0.25)).toBeGreaterThan(0.5 - 1e-6)
    const pts = pointsOf(displaced.segments)
    expect(maxY(pts)).toBeCloseTo(1, 6)
    expect(pts[0]).toEqual({ x: -6, y: 0.5 })
    expect(pts[pts.length - 1]).toEqual({ x: 16, y: 0.5 })
    expect(allAngled(pts)).toBe(true)

    // The delta names the removed track and adds its new shape, net, width and layer kept.
    const delta = session.delta()
    expect(delta.removed).toEqual([{ type: 'segment', index: 0 }])
    expect(delta.added.length).toBeGreaterThan(0)
    for (const seg of delta.added) {
      expect(seg.net).toBe(2)
      expect(seg.width).toBeCloseTo(0.5, 9)
      expect(seg.layer).toBe('F.Cu')
    }
  })

  /** How far each turn of a line bends, in degrees. */
  const turns = (pts: Array<{ x: number; y: number }>): number[] =>
    pts.slice(1, -1).map((b, i) => {
      const a = pts[i]
      const c = pts[i + 2]
      const u = Math.atan2(b.y - a.y, b.x - a.x)
      const v = Math.atan2(c.y - b.y, c.x - b.x)
      const d = Math.abs(((v - u + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
      return Math.round((d * 180) / Math.PI)
    })

  test('P2: a track met head-on bulges in 45° shoulders, not a box round the head', () => {
    // Straight up into a track 2 mm ahead (source y −2): the track goes on
    // ahead of the head's end as a trapezoid, its ends and the rest of its
    // run where they were.
    const session = new RouteSession(world(track(-5, -2, 5, -2)))
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2 }
    const p = session.propose(push({ x: 0, y: 0 }, { x: 0, y: 2.6 }, o), noPending)
    expect(p.state).toBe('pushing')
    expect(p.segments).toHaveLength(1)
    const pts = pointsOf(session.displaced().segments)
    expect(pts[0]).toEqual({ x: -5, y: 2 })
    expect(pts[pts.length - 1]).toEqual({ x: 5, y: 2 })
    expect(turns(pts).every((t) => t === 45)).toBe(true)
    // Clear of the head's end by exactly what clearance asks, and no more.
    expect(maxY(pts)).toBeCloseTo(2.6 + 0.125 + 0.2 + 0.25, 3)
  })

  test('P3: two tracks met head-on nest, the near one pushing the far one on', () => {
    const w = world(`${track(-5, -2, 5, -2)}\n${track(-5, -3, 5, -3, 3)}`)
    const session = new RouteSession(w)
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2, autoPosture: true }
    let p = session.propose(push({ x: 0, y: 0 }, { x: 0.03, y: 0.32 }, o), noPending)
    for (let t = 2; t <= 10; t++)
      p = session.propose(push({ x: 0, y: 0 }, { x: 0.03 * t, y: 0.32 * t }, o), noPending)
    // The head keeps its plain bend: nothing walked round.
    expect(p.state).toBe('pushing')
    expect(p.segments.length).toBeLessThanOrEqual(2)
    expect(p.endsAt.y).toBeCloseTo(3.2, 9)
    const displaced = session.displaced()
    expect(displaced.hiddenRefs).toHaveLength(2)
    // Both go on ahead: never round behind where the route starts.
    expect(minY(pointsOf(displaced.segments))).toBeGreaterThan(2 - 1e-6)
  })

  test.each([
    ['nested, slanted', `${track(-5, -2, 5, -1)}\n${track(-5, -3, 5, -2.2, 3)}`],
    ['crossing pair', `${track(-2, -4, 6, 2)}\n${track(-1, -5, 7, 1, 3)}`],
    ['short tracks in a row', `${track(-1, -2, 4, -2)}\n${track(0, -2.8, 6, -2.8, 3)}`],
    [
      'a fan of three',
      `${track(-4, -1, 4, -2)}\n${track(-4, -2, 4, -3, 3)}\n${track(-4, -3, 4, -4)}`
    ]
  ])('P3: what a push pushes on never lands on the head (%s)', (_name, body) => {
    // Whatever the depth of the chain, the head shows clear of everything pushed,
    // on every frame — and the sweep does push.
    const session = new RouteSession(world(body))
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2, autoPosture: true }
    let pushes = 0
    for (let t = 1; t <= 12; t++) {
      const p = session.propose(push({ x: 0, y: 0 }, { x: 0.25 * t, y: 0.35 * t }, o), noPending)
      const displaced = session.displaced().segments
      if (displaced.length > 0) {
        pushes++
        expect(p.blocked).toBe(false)
      }
      expect(gapToHead(displaced, pointsOf(p.segments), 0.125)).toBeGreaterThan(0.2 - 1e-6)
    }
    expect(pushes).toBeGreaterThan(0)
  })

  test('P3: a fan of slanted tracks nests, each pushing the next', () => {
    // Pushed, the near track keeps its slant either side of the bulge; the
    // next is walked round that slanted run by its own outline, not by a 45°
    // box over its whole length that reaches the next track's end.
    const fan = `${track(-4, -1, 4, -2)}\n${track(-4, -2, 4, -3, 3)}\n${track(-4, -3, 4, -4)}`
    const session = new RouteSession(world(fan))
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2, autoPosture: true }
    for (let t = 3; t <= 8; t++) {
      const p = session.propose(push({ x: 0, y: 0 }, { x: 0.25 * t, y: 0.35 * t }, o), noPending)
      expect(p.state).toBe('pushing')
      expect(p.endsAt.x).toBeCloseTo(0.25 * t, 9)
      expect(p.endsAt.y).toBeCloseTo(0.35 * t, 9)
    }
    expect(session.displaced().hiddenRefs).toHaveLength(3)
  })

  test('P5, Push budget: a push that runs out of work walks the head round everything', () => {
    // The head along y 0 presses a track above it and a via below; the via
    // pushes a stack of tracks, each the next.
    const stack = Array.from({ length: 10 }, (_, k) =>
      track(-6, 1.9 + k, 30, 1.9 + k, k % 2 ? 2 : 3)
    )
    const body = [track(-6, -0.5, 16, -0.5), via(10, 0.9), ...stack].join('\n')
    const viaRef = { type: 'via', index: 0 }
    const ample = new RouteSession(world(body))
    ample.propose(push({ x: 0, y: 0 }, { x: 12, y: 0 }, { cornerMode: '45' }), noPending)
    expect(ample.displaced().hiddenRefs).toContainEqual(viaRef)
    expect(ample.displaced().hiddenRefs).toContainEqual({ type: 'segment', index: 9 })

    // Too little work for the chain under the via: nothing is pushed, the
    // head is walked round everything as in Avoid (KiCad's fallback), and the
    // answer is the same every time (Q2).
    const run = (): ReturnType<RouteSession['propose']> => {
      const session = new RouteSession(world(body), { workBudget: 1000 })
      const p = session.propose(push({ x: 0, y: 0 }, { x: 12, y: 0 }, { cornerMode: '45' }))
      expect(session.displaced().hiddenRefs).toEqual([])
      return p
    }
    const p = run()
    expect(p.state).not.toBe('pushing')
    expect(pointsOf(run().segments)).toEqual(pointsOf(p.segments))
  })

  test('P8: pushed copper lands tidy: no zero-length or straight-on joints', () => {
    const w = world(`${track(-5, -2, 5, -2)}\n${track(-5, -3, 5, -3, 3)}`)
    const session = new RouteSession(w)
    const o = { cornerMode: '45' as const, width: 0.25, clearance: 0.2, autoPosture: true }
    for (let t = 1; t <= 10; t++)
      session.propose(push({ x: 0, y: 0 }, { x: 0.03 * t, y: 0.32 * t }, o), noPending)
    const added = session.delta().added
    expect(added.length).toBeGreaterThan(0)
    for (const a of added)
      expect(Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y)).toBeGreaterThan(1e-6)
    for (const a of added)
      for (const b of added) {
        if (
          a === b ||
          a.net !== b.net ||
          Math.hypot(a.end.x - b.start.x, a.end.y - b.start.y) > 1e-6
        )
          continue
        const cross =
          (a.end.x - a.start.x) * (b.end.y - b.start.y) -
          (a.end.y - a.start.y) * (b.end.x - b.start.x)
        const dot =
          (a.end.x - a.start.x) * (b.end.x - b.start.x) +
          (a.end.y - a.start.y) * (b.end.y - b.start.y)
        expect(Math.abs(cross) < 1e-9 && dot > 0).toBe(false)
      }
  })

  test('P4: backing off springs the pushed copper back', () => {
    const session = new RouteSession(world(parallelTrack))
    session.propose(push({ x: 0, y: -3 }, { x: 10, y: 0 }), noPending)
    expect(session.displaced().segments.length).toBeGreaterThan(0)
    const back = session.propose(push({ x: 0, y: -3 }, { x: 2, y: -3 }), noPending)
    expect(back.blocked).toBe(false)
    expect(session.displaced().segments).toHaveLength(0)
    expect(session.displaced().hiddenRefs).toHaveLength(0)
  })

  test('P3: a push carries on into the track beyond', () => {
    const w = world(`${parallelTrack}\n${track(-6, -1.5, 16, -1.5, 3)}`)
    const session = new RouteSession(w)
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(p.blocked).toBe(false)
    expect(p.segments).toHaveLength(1)
    expect(session.displaced().hiddenRefs).toHaveLength(2)
  })

  test('P1: a pad never moves; the head goes round it', () => {
    const session = new RouteSession(world(pad(5, 0)))
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(p.blocked).toBe(false)
    expect(p.walked).toBe(true)
    expect(session.displaced().segments).toHaveLength(0)
    expect(p.endsAt.x).toBeCloseTo(10, 9)
  })

  test('P5: what cannot move is walked round while the rest is still pushed', () => {
    // The track over the first half of the corridor is pushed; the pad
    // further on cannot be, and the head goes round it — one route doing
    // both, not a whole-route fallback to walking.
    const w = world(`${parallelTrack}\n${pad(8, 0)}`)
    const session = new RouteSession(w)
    const p = session.propose(push({ x: 0, y: 0 }, { x: 12, y: 0 }), noPending)
    expect(p.blocked).toBe(false)
    expect(session.displaced().hiddenRefs).toContainEqual({ type: 'segment', index: 0 })
    const path = pointsOf(p.segments)
    expect(Math.max(maxY(path), -minY(path))).toBeGreaterThan(1.5)
    expect(p.endsAt.x).toBeCloseTo(12, 9)
  })

  test('R6, P5: what the head walks round in push mode, it hugs in clean 45° bends', () => {
    // The track is pushed, the pad walked round: four 45° bends over the
    // pad, not its outline corner by corner.
    const w = world(`${parallelTrack}\n${pad(8, 0)}`)
    const p = new RouteSession(w).propose(
      push({ x: 0, y: 0 }, { x: 12, y: 0 }, { cornerMode: '45' })
    )
    expect(p.state).toBe('pushing')
    const path = pointsOf(p.segments)
    expect(allAngled(path)).toBe(true)
    // At most four bends, none sharper than 45°.
    expect(turns(path).length).toBeLessThanOrEqual(4)
    expect(turns(path).every((t) => t <= 45)).toBe(true)
  })

  describe('P10: a pushed track meeting what cannot move', () => {
    // A track above the route, and a small pad of a third net just above the
    // track: pushing the track up runs it into the pad.
    const padAbove = `(footprint "T:Q" (layer "F.Cu") (uuid "f-q") (at 3 -1.8)
      (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net 3 "OBS2")))`
    const body = `${track(-6, -1, 16, -1)}\n${padAbove}`
    const sweep = (session: RouteSession): ReturnType<RouteSession['propose']> => {
      let p = session.propose(push({ x: 0, y: -1 }, { x: 4, y: -1 }, { cornerMode: '45' }))
      for (let k = 1; k <= 6; k++)
        p = session.propose(
          push({ x: 0, y: -1 }, { x: 4, y: -1 + (2.2 * k) / 6 }, { cornerMode: '45' })
        )
      return p
    }

    test('without the pad, the same sweep pushes the track', () => {
      const session = new RouteSession(world(track(-6, -1, 16, -1)))
      const p = sweep(session)
      expect(p.state).toBe('pushing')
      expect(session.displaced().segments.length).toBeGreaterThan(0)
    })

    test('reflects: the track stays, and the head goes round it (P5)', () => {
      // A shorter track, so going round its end is within R39's reach; the
      // cursor carried on past it, out of its clearance (R11 holds the head
      // at its edge while the cursor is still inside).
      const session = new RouteSession(world(`${track(-1, -1, 6, -1)}\n${padAbove}`))
      let p = session.propose(push({ x: 0, y: -1 }, { x: 4, y: -1 }, { cornerMode: '45' }))
      for (let k = 1; k <= 6; k++)
        p = session.propose(
          push({ x: 0, y: -1 }, { x: 4, y: -1 + (3.6 * k) / 6 }, { cornerMode: '45' })
        )
      expect(p.blocked).toBe(false)
      expect(session.displaced().segments).toHaveLength(0)
      expect(p.endsAt.x).toBeCloseTo(4, 9)
      expect(p.endsAt.y).toBeCloseTo(2.6, 9)
      // Round one of the track's ends (x −1 or 6), the shorter, clear of it.
      const xs = pointsOf(p.segments).map((q) => q.x)
      expect(Math.min(...xs) < -1.5 || Math.max(...xs) > 6.5).toBe(true)
      expect(p.segments.every((s) => !s.violation)).toBe(true)
    })

    test('with jump-over, the track goes on round the pad, behind it', () => {
      const session = new RouteSession(world(body), { jumpOverObstacles: true })
      const p = sweep(session)
      expect(p.state).toBe('pushing')
      expect(p.endsAt.y).toBeGreaterThan(1)
      // Over the pad's top (2.1) and its clearance.
      expect(maxY(pointsOf(session.displaced().segments))).toBeGreaterThan(2.5)
    })
  })

  test('P5: a track that cannot be pushed is walked round, nothing displaced', () => {
    // Across the route with its ends inside the head's reach: no push
    // keeps them.
    const session = new RouteSession(world(track(5, -0.6, 5, 0.6)))
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(session.displaced().segments).toHaveLength(0)
    expect(p.blocked).toBe(false)
    expect(p.walked).toBe(true)
    expect(p.endsAt).toEqual({ x: 10, y: 0 })
    expect(p.segments.every((s) => !s.violation)).toBe(true)
  })

  test('P1: a locked track is not pushed', () => {
    // Across the route, locked: the head goes round its end instead.
    const w = world(track(5, -3, 5, 3, 2, ' (locked yes)'))
    const session = new RouteSession(w, {
      isFixed: (item) => item.ref.type === 'segment' && item.ref.index === 0
    })
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(session.displaced().segments).toHaveLength(0)
    expect(p.blocked).toBe(false)
    expect(p.walked).toBe(true)
    expect(p.endsAt).toEqual({ x: 10, y: 0 })
    expect(p.segments.every((s) => !s.violation)).toBe(true)
  })

  test('P6: pushed copper keeps clear of the committed clicks', () => {
    // A click laid along y 1.3: pushed as far as the head alone asks (to y 1),
    // the track would sit 0.3 from it, under clearance.
    const click = { x0: 0, y0: 1.3, x1: 10, y1: 1.3, width: 0.5, layer: 'F.Cu' }
    const alone = new RouteSession(world(parallelTrack))
    alone.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(maxY(pointsOf(alone.displaced().segments))).toBeCloseTo(1, 6)

    const session = new RouteSession(world(parallelTrack))
    session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), { segments: [click], vias: [] })
    const clickLine = [
      { x: click.x0, y: click.y0 },
      { x: click.x1, y: click.y1 }
    ]
    expect(gapToHead(session.displaced().segments, clickLine, 0.25)).toBeGreaterThan(0.5 - 1e-6)
  })

  test('P1, P7: a via steps aside and its track follows', () => {
    // Via of net 2 just below the corridor (world y −0.6), its track running
    // straight down from it.
    const w = world(`${via(5, 0.6)}\n${track(5, 0.6, 5, 5)}`)
    const session = new RouteSession(w)
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(p.blocked).toBe(false)
    expect(p.segments).toHaveLength(1)
    const delta = session.delta()
    expect(delta.movedVias).toHaveLength(1)
    const moved = delta.movedVias![0]
    expect(moved.index).toBe(0)
    // Out by track half-width + clearance + via radius.
    expect(moved.y).toBeLessThanOrEqual(-(0.25 + 0.5 + 0.3) + 1e-6)
    expect(moved.x).toBeCloseTo(5, 6)
    // The track re-drawn to the via's new center, its far end kept.
    const ends = delta.added.flatMap((s) => [s.start, s.end])
    expect(ends.some((e) => Math.abs(e.x - moved.x) < 1e-6 && Math.abs(e.y - moved.y) < 1e-6)).toBe(
      true
    )
    expect(ends.some((e) => Math.abs(e.x - 5) < 1e-6 && Math.abs(e.y + 5) < 1e-6)).toBe(true)
  })

  test('P7: a pushed via carries on into what its tracks meet on other layers', () => {
    // Via of net 2 just below the corridor, its track running right on B.Cu;
    // a B.Cu track of net 3 under that: the via's re-drawn track pushes it on.
    const back = (x0: number, y0: number, x1: number, y1: number, net: number): string =>
      `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.5) (layer "B.Cu") (net ${net}) (uuid "b-${x0}-${y0}-${net}"))`
    const w = world(`${via(5, 0.6)}\n${back(5, 0.6, 10, 0.6, 2)}\n${back(0, 1.7, 14, 1.7, 3)}`)
    const session = new RouteSession(w)
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(p.state).toBe('pushing')
    const delta = session.delta()
    expect(delta.movedVias).toHaveLength(1)
    const pushedBack = delta.added.filter((a) => a.net === 3 && a.layer === 'B.Cu')
    expect(pushedBack.length).toBeGreaterThan(0)
    expect(Math.min(...pushedBack.flatMap((a) => [a.start.y, a.end.y]))).toBeLessThan(-1.7)
  })

  describe('P11: a line with an arc in it', () => {
    // Net 2: along y = 1, a quarter arc up at x 2–4, then up x = 4 (world).
    const s2 = Math.SQRT1_2
    const bend = [
      track(-6, -1, 2, -1),
      `(arc (start 2 -1) (mid ${2 + 2 * s2} ${-(1 + 2 * (1 - s2))}) (end 4 -3) (width 0.5) (layer "F.Cu") (net 2) (uuid "arc-2"))`,
      track(4, -3, 4, -9)
    ].join('\n')

    test('pushed where it runs straight, its arc stays as it was', () => {
      const session = new RouteSession(world(bend))
      const p = session.propose(push({ x: -4, y: 0.4 }, { x: -1, y: 0.4 }), noPending)
      expect(p.state).toBe('pushing')
      const delta = session.delta()
      expect(delta.removed).toContainEqual({ type: 'segment', index: 0 })
      expect(delta.removed.some((r) => r.type === 'tarc')).toBe(false)
      expect(delta.addedArcs ?? []).toHaveLength(0)
    })

    test('pressed on the arc itself, the arc is pushed aside', () => {
      const session = new RouteSession(world(bend))
      // Up toward the arc's inside, from below-right of it.
      const p = session.propose(push({ x: 5.5, y: -1 }, { x: 2.6, y: 1.9 }), noPending)
      expect(p.blocked).toBe(false)
      expect(p.state).toBe('pushing')
      expect(session.delta().removed).toContainEqual({ type: 'tarc', index: 0 })
    })
  })

  test('P7, R24: a via whose hole would land too near another is not pushed', () => {
    // 0.5 / 0.3 vias under Board Setup's defaults (clearance 0.2, hole to hole
    // 0.5). Pushed to clearance below the route, net 2's via would sit 0.25
    // from net 3's in copper but 0.45 in hole: the route goes round it.
    const thin = (y: number, net: number): string =>
      `(via (at 5 ${y}) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "t-${net}"))`
    const session = new RouteSession(rulesWorld(`${thin(0.4, 2)}\n${thin(1.3, 3)}`))
    const p = session.propose(
      push({ x: 0, y: 0 }, { x: 10, y: 0 }, { width: 0.2, clearance: 0.2 }),
      noPending
    )
    expect(session.delta().movedVias ?? []).toHaveLength(0)
    expect(p.segments.every((s) => !s.violation)).toBe(true)
    expect(p.endsAt).toEqual({ x: 10, y: 0 })
  })

  test('P1: vias stay put when the setting says so', () => {
    const w = world(`${via(5, 0.6)}\n${track(5, 0.6, 5, 5)}`)
    const session = new RouteSession(w, { pushVias: false })
    const p = session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    expect(session.delta().movedVias ?? []).toHaveLength(0)
    expect(p.blocked).toBe(false)
    expect(p.walked).toBe(true)
    expect(p.endsAt).toEqual({ x: 10, y: 0 })
    expect(p.segments.every((s) => !s.violation)).toBe(true)
  })

  test('R22: a click keeps its pushes; Backspace springs them back', () => {
    const session = new RouteSession(world(parallelTrack))
    session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    session.markClick()
    // The next head goes somewhere clear: the first click's pushes stay.
    const pending: PendingCopper = {
      segments: [{ x0: 0, y0: 0, x1: 10, y1: 0, width: 0.5, layer: 'F.Cu' }],
      vias: []
    }
    session.propose(push({ x: 10, y: 0 }, { x: 10, y: -5 }), pending)
    expect(session.displaced().hiddenRefs).toContainEqual({ type: 'segment', index: 0 })
    session.undoClick()
    session.propose(push({ x: 0, y: -3 }, { x: 2, y: -3 }), noPending)
    expect(session.displaced().hiddenRefs).toHaveLength(0)
  })

  test('R21: reset drops every push', () => {
    const session = new RouteSession(world(parallelTrack))
    session.propose(push({ x: 0, y: 0 }, { x: 10, y: 0 }), noPending)
    session.markClick()
    session.reset()
    expect(session.displaced().segments).toHaveLength(0)
  })
})
