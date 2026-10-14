import { describe, expect, test } from 'vitest'
import { nm, type Nm } from '../../../kicad/coordinates'
import {
  planRouteCommit,
  type BoardArc,
  type BoardTrack,
  type RouteCommitPlan,
  type TrackLine
} from '../routeCommit'

const P = (x: number, y: number): { x: Nm; y: Nm } => ({ x: nm(x), y: nm(y) })
const W = nm(250_000)
const line = (x0: number, y0: number, x1: number, y1: number, layer = 'F.Cu'): TrackLine => ({
  start: P(x0, y0),
  end: P(x1, y1),
  width: W,
  layer
})
const track = (
  index: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  net = 1
): BoardTrack => ({
  ...line(x0, y0, x1, y1),
  index,
  net
})
const free = (): boolean => false

describe('planRouteCommit: the route itself (R26)', () => {
  test('two straight clicks in a row commit as one segment', () => {
    const plan = planRouteCommit([line(0, 0, 1000, 0), line(1000, 0, 3000, 0)], [], 1, free)
    expect(plan.add).toEqual([line(0, 0, 3000, 0)])
  })

  test('a corner, a width change or a via between them keeps two', () => {
    expect(
      planRouteCommit([line(0, 0, 1000, 0), line(1000, 0, 2000, 1000)], [], 1, free).add
    ).toHaveLength(2)
    const narrower = { ...line(1000, 0, 3000, 0), width: nm(150_000) }
    expect(planRouteCommit([line(0, 0, 1000, 0), narrower], [], 1, free).add).toHaveLength(2)
    const viaAt = (p: { x: Nm; y: Nm }): boolean => p.x === 1000
    expect(
      planRouteCommit([line(0, 0, 1000, 0), line(1000, 0, 3000, 0)], [], 1, viaAt).add
    ).toHaveLength(2)
  })

  test('zero-length pieces are dropped', () => {
    expect(planRouteCommit([line(0, 0, 0, 0), line(0, 0, 1000, 0)], [], 1, free).add).toEqual([
      line(0, 0, 1000, 0)
    ])
  })
})

describe('planRouteCommit: tees (R32)', () => {
  test('ending on the middle of a track of the net splits it there', () => {
    const plan = planRouteCommit([line(1000, 2000, 1000, 0)], [track(4, 0, 0, 3000, 0)], 1, free)
    expect(plan.update).toEqual([{ index: 4, start: P(0, 0), end: P(1000, 0) }])
    expect(plan.add).toEqual([line(1000, 2000, 1000, 0), { ...line(1000, 0, 3000, 0), from: 4 }])
  })

  test('starting there splits it too, and both ends on one track cut it twice in order', () => {
    const plan = planRouteCommit(
      [line(2000, 0, 2000, 1000), line(2000, 1000, 500, 1000), line(500, 1000, 500, 0)],
      [track(0, 0, 0, 3000, 0)],
      1,
      free
    )
    expect(plan.update).toEqual([{ index: 0, start: P(0, 0), end: P(500, 0) }])
    // The piece between the two cuts joined what the route now joins (R27).
    expect(plan.add.filter((a) => a.from === 0)).toEqual([{ ...line(2000, 0, 3000, 0), from: 0 }])
  })

  test('another net’s track, another layer, or an end is not split', () => {
    const route = [line(1000, 2000, 1000, 0)]
    const untouched = (plan: RouteCommitPlan): void => {
      expect(plan.update).toEqual([])
      expect(plan.add).toEqual(route)
    }
    untouched(planRouteCommit(route, [track(0, 0, 0, 3000, 0, 2)], 1, free))
    const back = { ...track(0, 0, 0, 3000, 0), layer: 'B.Cu' }
    untouched(planRouteCommit(route, [back], 1, free))
    untouched(planRouteCommit(route, [track(0, 1000, 0, 3000, 0)], 1, free))
    const locked = { ...track(0, 0, 0, 3000, 0), locked: true }
    untouched(planRouteCommit(route, [locked], 1, free))
  })
})

describe('planRouteCommit: continuing a track (R26)', () => {
  test('a route straight on from a track’s free end lengthens it', () => {
    const plan = planRouteCommit(
      [line(1000, 0, 3000, 0), line(3000, 0, 4000, 1000)],
      [track(7, 0, 0, 1000, 0)],
      1,
      free
    )
    expect(plan.update).toEqual([{ index: 7, start: P(0, 0), end: P(3000, 0) }])
    expect(plan.add).toEqual([line(3000, 0, 4000, 1000)])
  })

  test('arriving straight on at a track’s end lengthens it backwards', () => {
    const plan = planRouteCommit(
      [line(0, 1000, 0, 0), line(0, 0, 2000, 0)],
      [track(2, 2000, 0, 5000, 0)],
      1,
      free
    )
    expect(plan.update).toEqual([{ index: 2, start: P(0, 0), end: P(5000, 0) }])
  })

  test('not at a pad, a turn, another width, or where a second track ends', () => {
    const route = [line(1000, 0, 3000, 0)]
    expect(planRouteCommit(route, [track(0, 0, 0, 1000, 0)], 1, () => true).update).toEqual([])
    expect(planRouteCommit(route, [track(0, 1000, 1000, 1000, 0)], 1, free).update).toEqual([])
    const wide = { ...track(0, 0, 0, 1000, 0), width: nm(400_000) }
    expect(planRouteCommit(route, [wide], 1, free).update).toEqual([])
    expect(
      planRouteCommit(route, [track(0, 0, 0, 1000, 0), track(1, 1000, 1000, 1000, 0)], 1, free)
        .update
    ).toEqual([])
  })

  test('a straight run merges on through the old copper it continues, not past a turn', () => {
    // Old 0–1–2 mm in two collinear tracks; the route carries on to 4 mm.
    const plan = planRouteCommit(
      [line(2000, 0, 4000, 0)],
      [track(0, 0, 0, 1000, 0), track(1, 1000, 0, 2000, 0)],
      1,
      free
    )
    expect(plan.update).toEqual([{ index: 0, start: P(0, 0), end: P(4000, 0) }])
    expect(plan.remove.segments).toEqual([1])
    expect(plan.add).toEqual([])
  })
})

describe('planRouteCommit: tees on track arcs (R32)', () => {
  // A quarter circle of radius 10 mm about the origin, (10, 0) round to (0, 10).
  const r = 10_000_000
  const s = Math.SQRT1_2 * r
  const arc = (net = 1, locked = false): BoardArc => ({
    start: P(r, 0),
    mid: P(Math.round(s), Math.round(s)),
    end: P(0, r),
    layer: 'F.Cu',
    index: 0,
    net,
    locked
  })
  // A point a third of the way round (30°), on the grid's nanometer.
  const tee = P(Math.round(r * Math.cos(Math.PI / 6)), Math.round(r * Math.sin(Math.PI / 6)))
  const into = line(tee.x + 2_000_000, tee.y, tee.x, tee.y)

  const onCircle = (p: { x: number; y: number }): number => Math.abs(Math.hypot(p.x, p.y) - r)
  const angle = (p: { x: number; y: number }): number => (Math.atan2(p.y, p.x) * 180) / Math.PI

  test('a route ending on the middle of an arc of its net cuts it there, into two arcs', () => {
    const plan = planRouteCommit([into], [], 1, free, [arc()])
    expect(plan.arcSplits).toHaveLength(1)
    const [first, second] = plan.arcSplits[0].pieces
    expect(first.start).toEqual(P(r, 0))
    expect(first.end).toEqual(tee)
    expect(second.start).toEqual(tee)
    expect(second.end).toEqual(P(0, r))
    // Each mid halfway round its own piece, on the same circle.
    expect(angle(first.mid)).toBeCloseTo(15, 3)
    expect(angle(second.mid)).toBeCloseTo(60, 3)
    for (const p of [first.mid, second.mid]) expect(onCircle(p)).toBeLessThan(1)
  })

  test('a route starting there cuts it too; the other way round the same', () => {
    const out = line(tee.x, tee.y, tee.x + 2_000_000, tee.y)
    expect(planRouteCommit([out], [], 1, free, [arc()]).arcSplits[0].pieces).toHaveLength(2)
    const reversed: BoardArc = { ...arc(), start: P(0, r), end: P(r, 0) }
    const pieces = planRouteCommit([into], [], 1, free, [reversed]).arcSplits[0].pieces
    expect(pieces[0].end).toEqual(tee)
    expect(angle(pieces[0].mid)).toBeCloseTo(60, 3)
  })

  test("not at an end, on another net's arc, a locked arc or another layer", () => {
    const atEnd = line(r + 2_000_000, 0, r, 0)
    expect(planRouteCommit([atEnd], [], 1, free, [arc()]).arcSplits).toEqual([])
    expect(planRouteCommit([into], [], 1, free, [arc(2)]).arcSplits).toEqual([])
    expect(planRouteCommit([into], [], 1, free, [arc(1, true)]).arcSplits).toEqual([])
    expect(planRouteCommit([{ ...into, layer: 'B.Cu' }], [], 1, free, [arc()]).arcSplits).toEqual(
      []
    )
  })
})

describe('planRouteCommit: the connection the route replaces (R27)', () => {
  // Pads A at (0, 0) and B at (10, 0) mm, each 1 mm across; an old run from
  // A up over (2, 2)…(8, 2) and down to B.
  const pads = (p: { x: Nm; y: Nm }): string | false =>
    Math.hypot(p.x, p.y) <= 500_000
      ? 'A'
      : Math.hypot(p.x - 10_000_000, p.y) <= 500_000
        ? 'B'
        : false
  const old = [
    track(0, 0, 0, 2_000_000, 2_000_000),
    track(1, 2_000_000, 2_000_000, 8_000_000, 2_000_000),
    track(2, 8_000_000, 2_000_000, 10_000_000, 0)
  ]
  const direct = [line(0, 0, 10_000_000, 0)]

  test('a route joining the same two pads removes the old run', () => {
    const plan = planRouteCommit(direct, old, 1, pads)
    expect(plan.remove.segments.sort()).toEqual([0, 1, 2])
    expect(plan.add).toEqual(direct)
  })

  test('an old run ending anywhere on the pad is the same connection', () => {
    const offCenter = [...old.slice(0, 2), track(2, 8_000_000, 2_000_000, 10_200_000, 100_000)]
    expect(planRouteCommit(direct, offCenter, 1, pads).remove.segments.sort()).toEqual([0, 1, 2])
  })

  test('a branch, a via or a locked piece on the old run keeps it', () => {
    const split = [
      old[0],
      track(1, 2_000_000, 2_000_000, 5_000_000, 2_000_000),
      track(3, 5_000_000, 2_000_000, 8_000_000, 2_000_000),
      old[2]
    ]
    const branch = [...split, track(4, 5_000_000, 2_000_000, 5_000_000, 6_000_000)]
    expect(planRouteCommit(direct, branch, 1, pads).remove.segments).toEqual([])
    const via = (p: { x: Nm; y: Nm }): string | boolean =>
      p.x === 5_000_000 && p.y === 2_000_000 ? 'via' : pads(p)
    expect(planRouteCommit(direct, split, 1, via).remove.segments).toEqual([])
    const locked = [old[0], { ...old[1], locked: true }, old[2]]
    expect(planRouteCommit(direct, locked, 1, pads).remove.segments).toEqual([])
  })

  test("a route that arrives nowhere, or another net's run, removes nothing", () => {
    expect(
      planRouteCommit([line(0, 0, 10_000_000, 5_000_000)], old, 1, pads).remove.segments
    ).toEqual([])
    const other = old.map((t) => ({ ...t, net: 2 }))
    expect(planRouteCommit(direct, other, 1, pads).remove.segments).toEqual([])
  })

  test('a route teeing into the old run removes only the part it replaces', () => {
    // From A to (5, 2) on the middle of track 1: track 0 and the half of
    // track 1 up to the tee go; the half beyond, and track 2 to B, stay.
    const plan = planRouteCommit(
      [line(0, 0, 5_000_000, 0), line(5_000_000, 0, 5_000_000, 2_000_000)],
      old,
      1,
      pads
    )
    expect(plan.remove.segments).toEqual([0])
    expect(plan.update).toEqual([
      { index: 1, start: P(5_000_000, 2_000_000), end: P(8_000_000, 2_000_000) }
    ])
  })
})

describe('planRouteCommit: a route started short of a track end (R1, R26, R27)', () => {
  // The track runs 0–10 mm; the route starts at 8 mm, on its middle.
  const old = [track(0, 0, 0, 10_000_000, 0)]

  test('run on over the end, the stub it covers goes and one track is left', () => {
    const plan = planRouteCommit([line(8_000_000, 0, 15_000_000, 0)], old, 1, free)
    expect(plan.update).toEqual([{ index: 0, start: P(0, 0), end: P(15_000_000, 0) }])
    expect(plan.add).toEqual([])
    expect(plan.remove.segments).toEqual([])
  })

  test('run back over the track and off it, the copper it doubles goes and the rest joins up', () => {
    const plan = planRouteCommit(
      [line(8_000_000, 0, 3_000_000, 0), line(3_000_000, 0, 0, 3_000_000)],
      old,
      1,
      free
    )
    expect(plan.update).toEqual([{ index: 0, start: P(0, 0), end: P(3_000_000, 0) }])
    expect(plan.add).toEqual([
      line(3_000_000, 0, 0, 3_000_000),
      { ...line(3_000_000, 0, 10_000_000, 0), from: 0 }
    ])
  })

  test('a piece of the route lying over old copper to a dead end goes', () => {
    // From 8 mm back to 5 mm and stopped there: the old track already is that copper.
    const plan = planRouteCommit([line(8_000_000, 0, 5_000_000, 0)], old, 1, free)
    expect(plan.add.filter((a) => a.from === undefined)).toEqual([])
  })

  test('another width, or a locked track, is left as it is', () => {
    const wide = { ...line(8_000_000, 0, 15_000_000, 0), width: nm(400_000) }
    const plan = planRouteCommit([wide], old, 1, free)
    expect(plan.add).toContainEqual({ ...line(8_000_000, 0, 10_000_000, 0), from: 0 })
    const locked = [{ ...old[0], locked: true }]
    const kept = planRouteCommit([line(8_000_000, 0, 15_000_000, 0)], locked, 1, free)
    expect(kept.update).toEqual([])
    expect(kept.remove.segments).toEqual([])
  })
})

describe('planRouteCommit: a run of two widths is two lines (R27)', () => {
  // Pads A (0, 0) and B (10, 0) mm; the old run necks down halfway along.
  const pads = (p: { x: Nm; y: Nm }): string | false =>
    p.x === 0 && p.y === 0 ? 'A' : p.x === 10_000_000 && p.y === 0 ? 'B' : false

  test('a route joining the same pads leaves a necked-down run, as KiCad does', () => {
    const necked = [
      track(0, 0, 0, 5_000_000, 2_000_000),
      { ...track(1, 5_000_000, 2_000_000, 10_000_000, 0), width: nm(150_000) }
    ]
    const direct = [line(0, 0, 10_000_000, 0)]
    expect(planRouteCommit(direct, necked, 1, pads).remove.segments).toEqual([])
  })

  test('with redundant tracks off, the old run stays', () => {
    const old = [
      track(0, 0, 0, 5_000_000, 2_000_000),
      track(1, 5_000_000, 2_000_000, 10_000_000, 0)
    ]
    const direct = [line(0, 0, 10_000_000, 0)]
    expect(planRouteCommit(direct, old, 1, pads).remove.segments.sort()).toEqual([0, 1])
    expect(
      planRouteCommit(direct, old, 1, pads, [], { removeLoops: false }).remove.segments
    ).toEqual([])
  })
})
