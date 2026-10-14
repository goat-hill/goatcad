import { describe, expect, test } from 'vitest'
import {
  DiffPairSession,
  initialTrace,
  offsetPath,
  type PairProposal,
  type PairRequest,
  type PrimitivePair
} from '../diffPair'
import type { Pt } from '../../spatialIndex'
import { pad, world } from './routerFixture'

// docs/router-behavior.md PR1–PR6, held to KiCad's DIFF_PAIR_PLACER.

const sizes = { width: 0.15, gap: 0.15 }
const pitch = sizes.width + sizes.gap
/** Two 0.3 mm square pads, P above N, `apart` between centers: a pair's start. */
const pads = (x: number, apart = 0.5, y = 0): PrimitivePair => ({
  anchorP: { x, y: y + apart / 2 },
  anchorN: { x, y: y - apart / 2 },
  p: { kind: 'pad', fan: { ortho: 0.45, diag: 0 } },
  n: { kind: 'pad', fan: { ortho: 0.45, diag: 0 } }
})
const req = (cursor: Pt, o: Partial<PairRequest> = {}): PairRequest => ({
  mode: 'walkaround',
  layer: 'F.Cu',
  sizes,
  clearance: 0.1,
  nets: { p: 1, n: 3 },
  cursor,
  postureFlipped: false,
  ...o
})

const segs = (path: readonly Pt[]): Array<[Pt, Pt]> =>
  path.slice(1).map((b, i) => [path[i], b] as [Pt, Pt])

function segDist([a, b]: [Pt, Pt], [c, d]: [Pt, Pt]): number {
  const pt = (p: Pt, [s, t]: [Pt, Pt]): number => {
    const dx = t.x - s.x
    const dy = t.y - s.y
    const l2 = dx * dx + dy * dy
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0
    return Math.hypot(p.x - (s.x + dx * k), p.y - (s.y + dy * k))
  }
  const cr = (o: Pt, p: Pt, q: Pt): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const crosses = cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0
  if (crosses) return 0
  return Math.min(pt(a, [c, d]), pt(b, [c, d]), pt(c, [a, b]), pt(d, [a, b]))
}

/** The least distance between the halves' centerlines, away from where they leave their copper. */
const nearestBeyond = (p: PairProposal, from: Pt, radius: number): number => {
  let least = Infinity
  for (const s of segs(p.p))
    for (const t of segs(p.n)) {
      const m = (q: [Pt, Pt]): Pt => ({ x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 })
      if (Math.hypot(m(s).x - from.x, m(s).y - from.y) <= radius) continue
      if (Math.hypot(m(t).x - from.x, m(t).y - from.y) <= radius) continue
      least = Math.min(least, segDist(s, t))
    }
  return least
}

const anyCross = (p: PairProposal): boolean =>
  segs(p.p).some((s) => segs(p.n).some((t) => segDist(s, t) === 0))

/** Every turn a multiple of 45°, none sharper than a right angle's worth of two 45° steps (no acute). */
const turnsOk = (path: readonly Pt[]): boolean =>
  segs(path).every((s, i, all) => {
    if (i === 0) return true
    const [a, b] = all[i - 1]
    const u = { x: b.x - a.x, y: b.y - a.y }
    const v = { x: s[1].x - s[0].x, y: s[1].y - s[0].y }
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))
    return cos > -1e-9
  })

describe('initialTrace (KiCad BuildInitialTrace)', () => {
  test('straight then diagonal, or diagonal first', () => {
    expect(initialTrace({ x: 0, y: 0 }, { x: 5, y: 2 }, false)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 5, y: 2 }
    ])
    expect(initialTrace({ x: 0, y: 0 }, { x: 5, y: 2 }, true)).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 5, y: 2 }
    ])
    expect(initialTrace({ x: 0, y: 0 }, { x: 3, y: 3 }, false)).toHaveLength(2)
  })
})

describe('offsetPath', () => {
  test('a 45° bend offset either way keeps the distance on both runs', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 8, y: 3 }
    ]
    const left = offsetPath(path, 0.5)
    expect(left[0]).toEqual({ x: 0, y: 0.5 })
    expect(left[left.length - 1].x).toBeCloseTo(8 - 0.5 * Math.SQRT1_2, 9)
  })
})

describe('PR2: gateways', () => {
  test('from two pads the halves fan out, converge on the pitch and run side by side', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const p = s.propose(req({ x: 5, y: 0 }))
    expect(p.blocked).toBe(false)
    expect(p.p[0]).toEqual({ x: 0, y: 0.25 })
    expect(p.n[0]).toEqual({ x: 0, y: -0.25 })
    expect(anyCross(p)).toBe(false)
    // Out of the pads' neighbourhood the halves hold the pitch.
    expect(nearestBeyond(p, { x: 0, y: 0 }, 4 * pitch)).toBeGreaterThanOrEqual(pitch - 1e-4)
    expect(turnsOk(p.p) && turnsOk(p.n)).toBe(true)
  })

  test('near the line the pair runs on, the head goes straight on rather than jogging', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    s.fix(s.propose(req({ x: 3, y: 0 })), req({ x: 3, y: 0 }), { fixAll: true })
    const p = s.propose(req({ x: 6, y: 0.1 }))
    // The head's last runs are level: no 45° jog toward a cursor within half a pitch.
    const last = (path: Pt[]): number => path[path.length - 1].y - path[path.length - 2].y
    expect(Math.abs(last(p.p))).toBeLessThan(1e-9)
    expect(Math.abs(last(p.n))).toBeLessThan(1e-9)
  })

  test('PR6: a 45° turn after a click is mitred: the halves never cross and keep the pitch', () => {
    for (const cursor of [
      { x: 8, y: 3 },
      { x: 9, y: -2.5 },
      { x: 6, y: 1 }
    ]) {
      const s = new DiffPairSession(world(''))
      s.begin(pads(0))
      expect(
        s.fix(s.propose(req({ x: 4, y: 0 })), req({ x: 4, y: 0 }), { fixAll: true })
      ).not.toBeNull()
      const p = s.propose(req(cursor))
      expect(p.p.length).toBeGreaterThan(1)
      expect(anyCross(p)).toBe(false)
      const from = s.from()!
      const m = {
        x: (from.anchorP.x + from.anchorN.x) / 2,
        y: (from.anchorP.y + from.anchorN.y) / 2
      }
      expect(nearestBeyond(p, m, 0)).toBeGreaterThanOrEqual(pitch - 1e-4)
      expect(turnsOk(p.p) && turnsOk(p.n)).toBe(true)
    }
  })

  test('PR6: a turn sharper than 45° at a click fits no gateway: no head, never crossed halves', () => {
    for (const cursor of [
      { x: 4, y: 4 },
      { x: 1, y: 3 }
    ]) {
      const s = new DiffPairSession(world(''))
      s.begin(pads(0))
      s.fix(s.propose(req({ x: 4, y: 0 })), req({ x: 4, y: 0 }), { fixAll: true })
      const p = s.propose(req(cursor))
      expect(anyCross(p)).toBe(false)
      expect(p.p).toEqual([])
    }
  })

  test('a fine-pitch pinout with ground between its halves still starts (fan-outs both sides)', () => {
    // P–GND–N at 0.5 mm: pads 1.0 × 0.25 across x, P at y 0.5, GND at 0, N at −0.5.
    const gnd = pad(0, 0, 0.25)
    const s = new DiffPairSession(world(gnd))
    const start: PrimitivePair = {
      anchorP: { x: 0, y: 0.5 },
      anchorN: { x: 0, y: -0.5 },
      p: { kind: 'pad', fan: { ortho: 1.5, diag: 0.75 } },
      n: { kind: 'pad', fan: { ortho: 1.5, diag: 0.75 } }
    }
    s.begin(start)
    const p = s.propose(req({ x: 4, y: 0 }, { sizes: { width: 0.1, gap: 0.15 } }))
    expect(p.p.length).toBeGreaterThan(1)
    expect(p.blocked).toBe(false)
  })
})

describe('PR3: against the board', () => {
  test('Avoid: a pad in one half’s way is walked round, the other kept clear of it', () => {
    // The pad over P's run: P goes round it, and N, beside, keeps the gap.
    const s = new DiffPairSession(world(pad(2.5, 0.5, 0.4)))
    s.begin(pads(0))
    const p = s.propose(req({ x: 5, y: 0 }))
    expect(p.blocked).toBe(false)
    expect([...p.pViolations, ...p.nViolations].some(Boolean)).toBe(false)
    expect(anyCross(p)).toBe(false)
    // KiCad's pair optimizer straightens back as far as clearance allows.
    expect(nearestBeyond(p, { x: 0, y: 0 }, 4 * pitch)).toBeGreaterThanOrEqual(
      0.1 + sizes.width - 1e-3
    )
  })

  test('Highlight: the head goes straight through and is marked', () => {
    const s = new DiffPairSession(world(pad(2.5, 0, 0.6)))
    s.begin(pads(0))
    const p = s.propose(req({ x: 5, y: 0 }, { mode: 'highlight' }))
    expect(p.blocked).toBe(true)
    expect(p.marks.length).toBeGreaterThan(0)
  })
})

describe('PR4: arriving', () => {
  test('at the far pads the halves run in to their own and the pair arrives', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const p = s.propose(req({ x: 6, y: 0 }), pads(6))
    expect(p.arrived).toBe(true)
    expect(p.p[p.p.length - 1]).toEqual({ x: 6, y: 0.25 })
    expect(p.n[p.n.length - 1]).toEqual({ x: 6, y: -0.25 })
  })

  test.each([1, 2, -3])('at pads off to the side (%d) it arrives without crossing', (dy) => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const p = s.propose(req({ x: 8, y: dy }), pads(8, 0.5, dy))
    expect(p.arrived).toBe(true)
    expect(anyCross(p)).toBe(false)
    expect(turnsOk(p.p) && turnsOk(p.n)).toBe(true)
  })
})

describe('PR5: a via pair', () => {
  const via = { size: 0.6, drill: 0.3, gap: 0.2, layers: ['F.Cu', 'B.Cu'] }
  test('the head ends in two vias spaced by their size and gap, at the halves’ ends, nothing sideways', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const p = s.propose(req({ x: 5, y: 0 }, { via }))
    expect(p.vias).not.toBeNull()
    expect(p.vias!.p).toEqual(p.p[p.p.length - 1])
    expect(p.vias!.n).toEqual(p.n[p.n.length - 1])
    expect(Math.hypot(p.vias!.p.x - p.vias!.n.x, p.vias!.p.y - p.vias!.n.y)).toBeCloseTo(0.8, 6)
  })

  test('laid, the pair goes on from the vias, and may change layer there', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const r = req({ x: 5, y: 0 }, { via })
    expect(s.fix(s.propose(r), r, { fixAll: false })).not.toBeNull()
    expect(s.from()!.p.kind).toBe('via')
    expect(s.canSwitchTo('B.Cu')).toBe(true)
    expect(s.canSwitchTo('In1.Cu')).toBe(false)
  })
})

describe('PR6: clicks', () => {
  test('with Fix all segments off a click lays all but each half’s last segment', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const r = req({ x: 5, y: 2 })
    const p = s.propose(r)
    const laid = s.fix(p, r, { fixAll: false })!
    expect(laid.p).toHaveLength(p.p.length - 1)
    expect(laid.n).toHaveLength(p.n.length - 1)
  })

  test('Backspace takes the click back and the head goes on from where it was', () => {
    const s = new DiffPairSession(world(''))
    s.begin(pads(0))
    const r = req({ x: 5, y: 0 })
    s.fix(s.propose(r), r, { fixAll: true })
    expect(s.from()!.p.kind).toBe('track')
    expect(s.undoClick()).toBe(true)
    expect(s.from()!.p.kind).toBe('pad')
    expect(s.undoClick()).toBe(false)
  })
})
