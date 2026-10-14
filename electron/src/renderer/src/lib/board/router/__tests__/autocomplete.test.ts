import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { BoardSpatialIndex } from '../../spatialIndex'
import { RouterWorld } from '../world'
import { proposeRoute } from '../engine'
import {
  attemptFinish,
  cutRetraces,
  nearestUnconnectedAnchor,
  routeNetClusters,
  routeRatsnest
} from '../autocomplete'
import type { KicadBoard } from '../../../kicad/board'

const fixture = (
  body: string
): { board: KicadBoard; index: BoardSpatialIndex; world: RouterWorld } => {
  const board = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "SIG")
  (net 2 "OBS")
${body}
)`)
  const index = BoardSpatialIndex.build(board)
  return { board, index, world: new RouterWorld(index) }
}

const pads = `(footprint "T:A" (layer "F.Cu") (uuid "fa") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG")))
  (footprint "T:B" (layer "F.Cu") (uuid "fb") (at 10 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG")))`

describe('nearestUnconnectedAnchor', () => {
  test('finds the other cluster and skips its own', () => {
    const { board, index } = fixture(pads)
    const target = nearestUnconnectedAnchor(board, index, 1, { x: 0, y: 0 }, { x: 2, y: 0 })?.point
    expect(target).not.toBeNull()
    expect(target!.x).toBeCloseTo(10, 9)
    expect(target!.y).toBeCloseTo(0, 9)
  })

  test('R23, R30: given the routed layer, copper not on it is passed over', () => {
    // A third pad, on B.Cu, nearer the tail than B: finishing on F.Cu goes to B.
    const back = `${pads}
  (footprint "T:C" (layer "B.Cu") (uuid "fc") (at 3 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "SIG")))`
    const { board, index } = fixture(back)
    const any = nearestUnconnectedAnchor(board, index, 1, { x: 0, y: 0 }, { x: 2, y: 0 })?.point
    expect(any!.x).toBeCloseTo(3, 9)
    const front = nearestUnconnectedAnchor(
      board,
      index,
      1,
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      'F.Cu'
    )?.point
    expect(front!.x).toBeCloseTo(10, 9)
  })

  test('a fully connected net offers nothing', () => {
    const joined = `${pads}
  (segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s1"))`
    const { board, index } = fixture(joined)
    expect(nearestUnconnectedAnchor(board, index, 1, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull()
  })
})

describe('routeRatsnest (F7)', () => {
  // Three pads of one net: A at 0,0, B at 10,0, C at 0,-10 (y up). The board's
  // ratsnest joins A–B and A–C; routing from A toward B replaces A–B with the
  // line from the head.
  const three = `${pads}
  (footprint "T:C" (layer "F.Cu") (uuid "fc") (at 0 10)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG")))`
  const points = (
    c: ReturnType<typeof routeNetClusters>
  ): {
    origin: Array<{ x: number; y: number }>
    others: Array<Array<{ x: number; y: number }>>
  } => ({
    origin: c.origin.map((a) => a.point),
    others: c.others.map((o) => o.map((a) => a.point))
  })
  const ends = (w: { from: { x: number; y: number }; to: { x: number; y: number } }): string[] =>
    [w.from, w.to].map((p) => `${p.x},${p.y}`).sort()

  test('the airwire the route replaces is not drawn beside the line from the head', () => {
    const { board, index } = fixture(three)
    const clusters = points(routeNetClusters(board, index, 1, { x: 0, y: 0 }))
    expect(clusters.origin).toHaveLength(1)
    expect(clusters.others).toHaveLength(2)
    const head = { x: 7, y: 0 }
    const { lead, airwires } = routeRatsnest(clusters, [{ x: 0, y: 0 }], head)
    expect(lead?.from).toEqual(head)
    expect(lead?.to.x).toBeCloseTo(10, 9)
    expect(airwires).toHaveLength(1)
    expect(ends(airwires[0])).toEqual(['0,-10', '0,0'])
  })

  test('the rest of the net spans from the route, not only from where it started', () => {
    const { board, index } = fixture(three)
    const clusters = points(routeNetClusters(board, index, 1, { x: 0, y: 0 }))
    // The route passed 1,-9 on its way: C is nearer that than A.
    const head = { x: 9, y: -5 }
    const { lead, airwires } = routeRatsnest(
      clusters,
      [
        { x: 0, y: 0 },
        { x: 1, y: -9 }
      ],
      head
    )
    expect(lead?.to.x).toBeCloseTo(10, 9)
    expect(airwires).toHaveLength(1)
    expect(ends(airwires[0])).toEqual(['0,-10', '1,-9'])
  })

  test('a whole net draws nothing', () => {
    expect(routeRatsnest({ origin: [{ x: 0, y: 0 }], others: [] }, [], { x: 1, y: 1 })).toEqual({
      lead: null,
      airwires: []
    })
  })
})

describe('attemptFinish', () => {
  const settings = {
    mode: 'walkaround' as const,
    cornerMode: 'free' as const,
    diagFirst: true,
    layer: 'F.Cu',
    width: 0.5,
    clearance: 0.5,
    net: 1
  }

  test('routes straight home when nothing blocks', () => {
    const { world } = fixture(pads)
    const r = attemptFinish({ x: 0, y: 0 }, { x: 10, y: 0 }, (tail, cursor) =>
      proposeRoute(world, { ...settings, tail, cursor })
    )
    expect(r.arrived).toBe(true)
    expect(r.segments.length).toBeGreaterThan(0)
    expect(r.segments.every((s) => !s.violation)).toBe(true)
  })

  test('walks around traffic to arrive, in possibly several rounds', () => {
    const blocked = `${pads}
  (segment (start 5 -3) (end 5 3) (width 0.5) (layer "F.Cu") (net 2) (uuid "s1"))`
    const { world } = fixture(blocked)
    const r = attemptFinish({ x: 0, y: 0 }, { x: 10, y: 0 }, (tail, cursor) =>
      proposeRoute(world, { ...settings, tail, cursor })
    )
    expect(r.arrived).toBe(true)
    expect(r.segments.every((s) => !s.violation)).toBe(true)
    // The path detoured: it is longer than the straight shot.
    let len = 0
    for (const s of r.segments) len += Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
    expect(len).toBeGreaterThan(10.5)
  })

  test('an unreachable target keeps the progress and reports non-arrival', () => {
    // The target shut in a closed ring of another net's copper.
    const ring = [
      [7, -3, 13, -3],
      [13, -3, 13, 3],
      [13, 3, 7, 3],
      [7, 3, 7, -3]
    ]
      .map(
        ([x0, y0, x1, y1], i) =>
          `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.5) (layer "F.Cu") (net 2) (uuid "r${i}"))`
      )
      .join('\n')
    const walled = `${pads}\n${ring}`
    const { world } = fixture(walled)
    const r = attemptFinish({ x: 0, y: 0 }, { x: 10, y: 0 }, (tail, cursor) =>
      proposeRoute(world, { ...settings, tail, cursor })
    )
    expect(r.arrived).toBe(false)
    // The progress is kept: a route up to the ring, legal throughout.
    expect(r.segments.length).toBeGreaterThan(0)
    expect(r.segments.every((s) => !s.violation)).toBe(true)
    const last = r.segments[r.segments.length - 1]
    expect(Math.hypot(last.x1 - 10, last.y1)).toBeLessThan(Math.hypot(10, 0))
  })
})

describe('cutRetraces (R26 over the finish rounds)', () => {
  /** A polyline as segments, `widths` per segment (default 0.25). */
  const run = (
    pts: ReadonlyArray<readonly [number, number]>,
    widths: readonly number[] = []
  ): Array<{ x0: number; y0: number; x1: number; y1: number; width: number }> =>
    pts.slice(1).map(([x, y], k) => ({
      x0: pts[k][0],
      y0: pts[k][1],
      x1: x,
      y1: y,
      width: widths[k] ?? 0.25
    }))
  const path = (segs: ReturnType<typeof run>): string[] => [
    `${segs[0].x0},${segs[0].y0}`,
    ...segs.map((s) => `${+s.x1.toFixed(4)},${+s.y1.toFixed(4)}`)
  ]

  test('a round that comes back the way the last went is cut back to where it turned', () => {
    // Out to a dead end at (-3, 1) (a hug stopped short), back over it, then on round.
    const segs = run([
      [0, 0],
      [1, 1],
      [-3, 1],
      [1, 1],
      [2, 2],
      [5, 2]
    ])
    expect(path(cutRetraces(segs))).toEqual(['0,0', '1,1', '2,2', '5,2'])
  })

  test('a narrower run back inside the copper of the way out goes too, and the ends stay', () => {
    // Narrowed to 0.127 on the way back, its edge on the wide run's: 0.0615 off its centerline.
    const off = (0.25 - 0.127) / 2
    const segs = run(
      [
        [0, 0],
        [4, 0],
        [4, off],
        [1, off],
        [1, 3]
      ],
      [0.25, 0.127, 0.127, 0.25]
    )
    const cut = cutRetraces(segs)
    expect(path(cut)).toEqual(['0,0', '1,0', `1,${+off.toFixed(4)}`, '1,3'])
    // The stub joining them is the narrower run's.
    expect(cut[1].width).toBe(0.127)
  })

  test('a crossing cuts the loop out; a route that never meets itself is untouched', () => {
    const loop = run([
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, -2]
    ])
    expect(path(cutRetraces(loop))).toEqual(['0,0', '2,0', '2,-2'])
    const clean = run([
      [0, 0],
      [3, 0],
      [3.05, 0.05],
      [6, 0.05]
    ])
    expect(cutRetraces(clean)).toEqual(clean)
  })
})
