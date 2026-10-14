import { describe, expect, test } from 'vitest'
import { TuneSession, retunePattern, statusOf, stepMeander, tuneTargetOf } from '../tuning'
import { DEFAULT_MEANDER, piecesLength } from '../meander'
import { segmentToShape, type Pt } from '../../spatialIndex'
import { seedAt, track, via, world } from './routerFixture'

// docs/router-behavior.md T1–T5.

const square = { ...DEFAULT_MEANDER, cornerRadiusPercent: 0 }

describe('T1, T2: a single track tuned', () => {
  test('meanders from the click to the cursor bring it to its target', () => {
    const w = world(track(0, 0, 20, 0, 1))
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: { min: 22.9, opt: 23, max: 23.1 },
        clearance: 0.2,
        length: 20
      }
    )
    const u = session.update({ x: 18, y: 1 })
    expect(u.status).toBe('tuned')
    expect(u.length).toBeCloseTo(23, 3)
    expect(piecesLength(u.lines[0].pieces)).toBeCloseTo(23, 3)
    // On the cursor's side: above.
    expect(Math.max(...u.lines[0].pieces.map((p) => p.a.y))).toBeGreaterThan(0.5)
    expect(u.blocked).toBe(false)
  })

  test('T4: the pattern holds the meanders, the leads either side stay plain track', () => {
    const w = world(track(0, 0, 20, 0, 1))
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: { min: 22.9, opt: 23, max: 23.1 },
        clearance: 0.2,
        length: 20,
        // Held right, whichever side the cursor is on (a pattern re-tuned).
        side: -1
      }
    )
    const line = session.update({ x: 18, y: 1 }).lines[0]
    const [from, to] = line.span
    expect(line.pieces[0].a.x).toBe(0)
    expect(line.pieces[0].b).toMatchObject({ x: 2 })
    expect(from).toBe(1)
    expect(to).toBe(line.pieces.length - 1)
    expect(line.pieces[to - 1].b.x).toBeCloseTo(18, 9)
    // The first bump below the track, the cursor above it.
    const firstOff = line.pieces.slice(from).find((p) => Math.abs(p.b.y) > 0.1)!
    expect(firstOff.b.y).toBeLessThan(0)
  })

  test('T4: too short where the stretch cannot hold enough', () => {
    const w = world(track(0, 0, 20, 0, 1))
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: { min: 59, opt: 60, max: 61 },
        clearance: 0.2,
        length: 20
      }
    )
    expect(session.update({ x: 6, y: 1 }).status).toBe('too_short')
  })
})

const continuous = (pieces: ReadonlyArray<{ a: Pt; b: Pt }>): void => {
  for (let i = 1; i < pieces.length; i++) {
    expect(pieces[i].a.x).toBeCloseTo(pieces[i - 1].b.x, 6)
    expect(pieces[i].a.y).toBeCloseTo(pieces[i - 1].b.y, 6)
  }
}
const noTarget = { min: 0, opt: Infinity, max: Infinity }

describe('T1: the whole line through the clicked track (KiCad’s)', () => {
  test('meanders run on round a bend, each stretch to the cursor’s side of it', () => {
    // Along x to 10, then up (world y) to 10.
    const w = world(`${track(0, 0, 10, 0, 1)}\n${track(10, 0, 10, -10, 1)}`)
    const u = new TuneSession(
      w,
      seedAt(w, 5, 0),
      { x: 1, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: noTarget,
        clearance: 0.2,
        length: 20
      }
    ).update({ x: 9, y: 9 })
    const line = u.lines[0]
    expect(line.replaces).toHaveLength(2)
    continuous(line.pieces)
    expect(line.pieces[0].a).toEqual({ x: 0, y: 0 })
    expect(line.pieces[line.pieces.length - 1].b).toMatchObject({ x: 10, y: 10 })
    // Up off the first stretch, and left (toward the cursor) off the second.
    expect(line.pieces.some((p) => p.a.x < 8 && p.a.y > 0.5)).toBe(true)
    expect(line.pieces.some((p) => p.a.y > 2 && p.a.x < 9.5)).toBe(true)
    expect(u.length).toBeGreaterThan(30)
  })

  test('an arc on the line passes through as it is', () => {
    const arc =
      '(arc (start 5 0) (mid 7.5 -2.5) (end 10 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "a-1"))'
    const w = world(`${track(0, 0, 5, 0, 1)}\n${arc}\n${track(10, 0, 20, 0, 1)}`)
    const u = new TuneSession(
      w,
      seedAt(w, 2, 0),
      { x: 1, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: noTarget,
        clearance: 0.2,
        length: 20
      }
    ).update({ x: 19, y: -1 })
    const line = u.lines[0]
    expect(line.replaces).toHaveLength(3)
    continuous(line.pieces)
    const arcs = line.pieces.filter((p) => p.mid)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].mid!.x).toBeCloseTo(7.5, 6)
    expect(arcs[0].mid!.y).toBeCloseTo(2.5, 6)
    // Bumps either side of it, below the line (the cursor's side).
    expect(line.pieces.some((p) => p.a.x < 5 && p.a.y < -0.5)).toBe(true)
    expect(line.pieces.some((p) => p.a.x > 10 && p.a.y < -0.5)).toBe(true)
  })

  test('a pair is meandered over each stretch its halves run coupled, round the bend', () => {
    // The seed along x then up; its partner 1 mm outside it, the same way.
    const w = world(
      [
        track(0, 0, 10, 0, 1),
        track(10, 0, 10, -10, 1),
        track(0, 1, 11, 1, 3),
        track(11, 1, 11, -10, 3)
      ].join('\n')
    )
    const u = new TuneSession(
      w,
      seedAt(w, 5, 0),
      { x: 1, y: 0 },
      {
        mode: 'pair',
        settings: square,
        target: noTarget,
        clearance: 0.2,
        length: 20,
        mate: seedAt(w, 5, -1),
        mateLength: 22
      }
    ).update({ x: 9, y: 9 })
    expect(u.lines).toHaveLength(2)
    for (const l of u.lines) {
      continuous(l.pieces)
      expect(l.replaces).toHaveLength(2)
    }
    const seed = u.lines.find((l) => l.net === 1)!.pieces
    expect(seed.some((p) => p.a.x < 8 && p.a.y > 0.5)).toBe(true)
    expect(seed.some((p) => p.a.y > 2 && p.a.x < 9.5)).toBe(true)
  })
})

describe('T5: a pair tuned together', () => {
  test('a mate shorter than the seed holds the stretch to its own ends', () => {
    // The seed along y 0 from x 0 to 20; the mate along y 1 only from x 5 to 15.
    const w = world(`${track(0, 0, 20, 0, 1)}\n${track(5, -1, 15, -1, 3)}`)
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'pair',
        settings: square,
        target: { min: 0, opt: Infinity, max: Infinity },
        clearance: 0.2,
        length: 20,
        mate: seedAt(w, 10, 1),
        mateLength: 10
      }
    )
    const u = session.update({ x: 18, y: 2 })
    const mate = u.lines.find((l) => l.net === 3)!.pieces
    // One run from the mate's one end to its other, never past either.
    expect(mate[0].a).toEqual({ x: 5, y: 1 })
    expect(mate[mate.length - 1].b).toEqual({ x: 15, y: 1 })
    for (let i = 1; i < mate.length; i++) expect(mate[i].a).toEqual(mate[i - 1].b)
    for (const p of mate.flatMap((m) => [m.a, m.b])) {
      expect(p.x).toBeGreaterThanOrEqual(5 - 1e-9)
      expect(p.x).toBeLessThanOrEqual(15 + 1e-9)
    }
    // Neither half doubles back along its line.
    for (const l of u.lines)
      for (const m of l.pieces)
        if (Math.abs(m.a.y - m.b.y) < 1e-9) expect(m.b.x).toBeGreaterThanOrEqual(m.a.x - 1e-9)
  })

  test('both halves meander side by side, neither violating the other', () => {
    const w = world(`${track(0, 0, 20, 0, 1)}\n${track(0, -1, 20, -1, 3)}`)
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'pair',
        settings: square,
        target: { min: 0, opt: Infinity, max: Infinity },
        clearance: 0.2,
        length: 20,
        mate: seedAt(w, 10, 1),
        mateLength: 20
      }
    )
    expect(session.valid).toBe(true)
    const u = session.update({ x: 18, y: -2 })
    expect(u.lines).toHaveLength(2)
    expect(u.blocked).toBe(false)
    expect(u.length).toBeGreaterThan(20)
    // Every piece of one half keeps clearance from every piece of the other (0.5 mm tracks).
    let gap = Infinity
    for (const a of u.lines[0].pieces)
      for (const b of u.lines[1].pieces)
        gap = Math.min(
          gap,
          segmentToShape(
            { kind: 'capsule', x0: a.a.x, y0: a.a.y, x1: a.b.x, y1: a.b.y, halfWidth: 0.25 },
            b.a.x,
            b.a.y,
            b.b.x,
            b.b.y,
            0.25
          )
        )
    expect(gap).toBeGreaterThanOrEqual(0.2 - 1e-6)
  })
})

describe('T5: a pair tuned with rounded corners', () => {
  test('each half runs concentric with the centerline, end to end and clear of the other', () => {
    const w = world(`${track(0, 0, 20, 0, 1)}\n${track(0, -1, 20, -1, 3)}`)
    const u = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'pair',
        settings: DEFAULT_MEANDER,
        target: { min: 0, opt: Infinity, max: Infinity },
        clearance: 0.2,
        length: 20,
        mate: seedAt(w, 10, 1),
        mateLength: 20
      }
    ).update({ x: 18, y: -2 })
    expect(u.blocked).toBe(false)
    const sample = (pieces: Array<{ a: Pt; b: Pt; mid?: Pt }>): Pt[] =>
      pieces.flatMap((p) => (p.mid ? [p.a, p.mid, p.b] : [p.a, p.b]))
    for (const l of u.lines) {
      expect(l.pieces.some((p) => p.mid)).toBe(true)
      for (let i = 1; i < l.pieces.length; i++) {
        expect(l.pieces[i].a.x).toBeCloseTo(l.pieces[i - 1].b.x, 9)
        expect(l.pieces[i].a.y).toBeCloseTo(l.pieces[i - 1].b.y, 9)
      }
    }
    // Every point of one half at least a track (0.5 mm) and clearance from the other's.
    const [a, b] = u.lines.map((l) => sample(l.pieces))
    const gap = Math.min(...a.flatMap((p) => b.map((q) => Math.hypot(p.x - q.x, p.y - q.y))))
    expect(gap).toBeGreaterThanOrEqual(0.7 - 1e-6)
  })
})

describe('T3: past a place no bump fits', () => {
  test('the next bump stands a spacing on, so no corner rounds back over the last (a pair’s halves never cross)', () => {
    // A pair 0.9 mm apart, a via of another net beside it that lowers or skips a bump.
    for (const vx of [8, 10.3, 12.7]) {
      const w = world(
        [track(0, 0, 30, 0, 1), track(0, -0.9, 30, -0.9, 3), via(vx, -2.2, 2)].join('\n')
      )
      const u = new TuneSession(
        w,
        seedAt(w, 5, 0),
        { x: 1, y: 0 },
        {
          mode: 'pair',
          settings: { ...DEFAULT_MEANDER, spacing: 1.6 },
          target: noTarget,
          clearance: 0.2,
          length: 30,
          mate: seedAt(w, 5, 0.9),
          mateLength: 30
        }
      ).update({ x: 29, y: 3 })
      for (const l of u.lines) {
        continuous(l.pieces)
        // Along the pair, every stretch runs forward or across: none doubles back.
        for (const p of l.pieces)
          if (!p.mid && Math.abs(p.b.y - p.a.y) < 1e-9) expect(p.b.x).toBeGreaterThan(p.a.x - 1e-9)
      }
    }
  })
})

describe('T5: a pair is as long as its longer half', () => {
  const pair = (seedLength: number, mateLength: number, target: number): TuneSession => {
    const w = world(`${track(0, 0, 20, 0, 1)}\n${track(0, -1, 20, -1, 3)}`)
    return new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'pair',
        settings: square,
        target: { min: target - 0.1, opt: target, max: target + 0.1 },
        clearance: 0.2,
        length: seedLength,
        mate: seedAt(w, 10, 1),
        mateLength
      }
    )
  }

  test('already at the target by its longer half, nothing is added', () => {
    // The seed's net is 20 mm, its partner's 24: the pair reads 24, so a 24 mm target is met.
    const u = pair(20, 24, 24).update({ x: 18, y: -2 })
    expect(u.length).toBeCloseTo(24, 6)
    expect(u.status).toBe('tuned')
    expect(piecesLength(u.lines[0].pieces)).toBeCloseTo(20, 6)
  })

  test('the readout and the status follow the longer half, not the mean', () => {
    const u = pair(20, 22, 26).update({ x: 18, y: -2 })
    const gain = (l: number): number => piecesLength(u.lines[l].pieces) - 20
    expect(u.length).toBeCloseTo(Math.max(20 + gain(0), 22 + gain(1)), 6)
    expect(u.length).toBeGreaterThan(22)
    expect(u.status).toBe('tuned')
  })
})

describe('T1: the spacing and amplitude keys', () => {
  test('one KiCad step (0.05 mm) at a time', () => {
    const s = { ...DEFAULT_MEANDER }
    expect(stepMeander(s, 'spacing', 1, 0.4).spacing).toBe(0.65)
    expect(stepMeander(s, 'spacing', -1, 0.4).spacing).toBe(0.55)
    expect(stepMeander(s, 'amplitude', 1, 0.4).maxAmplitude).toBe(1.05)
    expect(stepMeander(s, 'amplitude', -1, 0.4).maxAmplitude).toBe(0.95)
  })

  test('spacing never under width plus clearance, amplitude never under the least', () => {
    expect(stepMeander({ ...DEFAULT_MEANDER, spacing: 0.42 }, 'spacing', -1, 0.4).spacing).toBe(0.4)
    const low = { ...DEFAULT_MEANDER, maxAmplitude: 0.22, minAmplitude: 0.2 }
    expect(stepMeander(low, 'amplitude', -1, 0.4).maxAmplitude).toBe(0.2)
  })

  test('a live tune takes the new settings on its next move', () => {
    const w = world(track(0, 0, 20, 0, 1))
    const session = new TuneSession(
      w,
      seedAt(w, 10, 0),
      { x: 2, y: 0 },
      {
        mode: 'single',
        settings: square,
        target: tuneTargetOf('single', null, null),
        clearance: 0.2,
        length: 20
      }
    )
    const before = session.update({ x: 18, y: 1 }).length
    session.meanderSettings = stepMeander(
      session.meanderSettings,
      'amplitude',
      -1,
      session.spacingFloor
    )
    expect(session.update({ x: 18, y: 1 }).length).toBeLessThan(before)
    expect(session.spacingFloor).toBeCloseTo(0.7, 9)
  })
})

describe('statusOf', () => {
  test('within the range tuned, else short or long', () => {
    const t = { min: 9, opt: 10, max: 11 }
    expect(statusOf(10.5, t)).toBe('tuned')
    expect(statusOf(8, t)).toBe('too_short')
    expect(statusOf(12, t)).toBe('too_long')
  })
})

describe('T2: the target a tune works to', () => {
  test('the rule wins over a typed value unless override custom rules is on (KiCad)', () => {
    expect(tuneTargetOf('single', 30, { min: 10 }).opt).toBe(10)
    expect(tuneTargetOf('single', 30, { min: 10 }, true).opt).toBe(30)
    expect(tuneTargetOf('skew', 0.2, { max: 1 }).opt).toBe(0)
    const skew = tuneTargetOf('skew', 0.2, { max: 1 }, true)
    expect(skew.min).toBeCloseTo(0.1, 9)
    expect(skew.opt).toBe(0.2)
    expect(skew.max).toBeCloseTo(0.3, 9)
  })

  test('with no rule a typed value applies, KiCad’s 0.1 mm either side', () => {
    const t = tuneTargetOf('single', 30, null)
    expect(t.opt).toBe(30)
    expect(t.min).toBeCloseTo(29.9, 9)
    expect(t.max).toBeCloseTo(30.1, 9)
  })

  test('a rule in ps is held to through the tuned layer’s delay (KiCad’s time domain)', () => {
    // 20 mm is 140 ps now, and each mm more 7 ps: 175 ps is 25 mm, 0.1 ps either side.
    const time = { length: 20, delay: 140, psPerMm: 7 }
    const t = tuneTargetOf('single', null, { opt: 175, timeDomain: true }, false, time)
    expect(t.opt).toBeCloseTo(25, 9)
    expect(t.min).toBeCloseTo(25 - 0.1 / 7, 9)
    expect(t.max).toBeCloseTo(25 + 0.1 / 7, 9)
    // With no profile to read it by, it holds nothing: never 175 mm.
    expect(tuneTargetOf('single', null, { opt: 175, timeDomain: true }).opt).toBe(Infinity)
  })

  test('override with nothing typed: no length target, a skew of nothing', () => {
    expect(tuneTargetOf('single', null, { max: 10 }, true)).toEqual({
      min: 0,
      opt: Infinity,
      max: Infinity
    })
    expect(tuneTargetOf('skew', null, { max: 1 }, true)).toEqual({ min: -0.1, opt: 0, max: 0.1 })
  })

  test("a skew rule bounding one side leaves the other 0.1 mm from its opt, as KiCad's", () => {
    const max = tuneTargetOf('skew', null, { max: 0.5 })
    expect(max.min).toBeCloseTo(-0.1, 9)
    expect(max.opt).toBe(0)
    expect(max.max).toBe(0.5)
    const min = tuneTargetOf('skew', null, { min: -0.3 })
    expect(min.min).toBe(-0.3)
    expect(min.opt).toBe(-0.3)
    expect(min.max).toBeCloseTo(-0.2, 9)
  })

  test('a skew target is always finite: KiCad reads it into an integer', () => {
    for (const rule of [null, {}, { max: 0.5 }, { min: -0.3 }, { opt: 0.1 }, { min: 0, max: 1 }]) {
      const t = tuneTargetOf('skew', null, rule)
      expect([t.min, t.opt, t.max].every(Number.isFinite)).toBe(true)
      expect(t.min).toBeLessThanOrEqual(t.opt)
      expect(t.opt).toBeLessThanOrEqual(t.max)
    }
  })

  test('a length with no rule has no target; a rule with no opt aims at its min, a max alone at nothing', () => {
    expect(tuneTargetOf('single', null, null)).toEqual({ min: 0, opt: Infinity, max: Infinity })
    expect(tuneTargetOf('pair', null, { min: 12, max: 20 })).toEqual({ min: 12, opt: 12, max: 20 })
    const min = tuneTargetOf('single', null, { min: 12 })
    expect(min.opt).toBe(12)
    expect(min.max).toBeCloseTo(12.1, 9)
    const max = tuneTargetOf('single', null, { max: 20 })
    expect(max.opt).toBe(0)
    expect(max.max).toBe(20)
  })
})

describe('T4: a pattern on the board re-tuned', () => {
  // A track from x 0 to 20 meandered from x 5 to 15 once: its meanders are
  // tracks of their own, which the re-tune takes off and lays again.
  const body = [
    track(0, 0, 5, 0, 1),
    track(5, 0, 5, -2, 1),
    track(5, -2, 15, -2, 1),
    track(15, -2, 15, 0, 1),
    track(15, 0, 20, 0, 1)
  ].join('\n')

  test('from the straight run it replaced, its own way: target, side, settings', () => {
    const w = world(body)
    const tracks = [seedAt(w, 5, 1), seedAt(w, 10, 2), seedAt(w, 15, 1)]
    const u = retunePattern(w, {
      mode: 'single',
      tracks,
      runs: [
        {
          net: 1,
          layer: 'F.Cu',
          width: 0.5,
          path: [
            { x: 5, y: 0 },
            { x: 15, y: 0 }
          ],
          length: 20
        }
      ],
      origin: { x: 5, y: 0 },
      end: { x: 15, y: 0 },
      side: -1,
      settings: square,
      target: { min: 25.9, opt: 26, max: 26.1 },
      clearance: 0.2
    })!
    expect(u.status).toBe('tuned')
    expect(u.length).toBeCloseTo(26, 3)
    // Its old meanders are gone from under it: nothing it lays meets them.
    expect(u.blocked).toBe(false)
    const line = u.lines[0]
    expect(line.replaces).toEqual([])
    expect(line.pieces[0].a).toEqual({ x: 5, y: 0 })
    expect(line.pieces[line.pieces.length - 1].b).toEqual({ x: 15, y: 0 })
    const firstOff = line.pieces.find((p) => Math.abs(p.b.y) > 0.1)!
    expect(firstOff.b.y).toBeLessThan(0)
  })

  test('a pair needs both its runs', () => {
    const w = world(body)
    expect(
      retunePattern(w, {
        mode: 'pair',
        tracks: [],
        runs: [
          {
            net: 1,
            layer: 'F.Cu',
            width: 0.5,
            path: [
              { x: 5, y: 0 },
              { x: 15, y: 0 }
            ],
            length: 20
          }
        ],
        origin: { x: 5, y: 0 },
        end: { x: 15, y: 0 },
        side: 1,
        settings: square,
        target: { min: 0, opt: Infinity, max: Infinity },
        clearance: 0.2
      })
    ).toBeNull()
  })
})
