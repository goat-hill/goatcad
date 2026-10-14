import { describe, expect, test } from 'vitest'
import {
  applyFanout,
  fanoutRulesOf,
  planFanout,
  type FanoutEscape,
  type FanoutOptions,
  type FanoutOutcome,
  type FanoutRules
} from '../fanout'
import { boardItems } from '../boardItems'
import { BoardSpatialIndex } from '../spatialIndex'
import {
  parseKicadBoard,
  remapKicadBoard,
  serializeKicadBoard,
  type KicadBoard
} from '../../kicad/board'
import { nmToMm, type Nm } from '../../kicad/coordinates'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'
import { computeConnectivity } from '../boardConnectivity'
import { boardChecks } from '../boardChecks'
import { loadClipper } from '../../geometry/clip'

const ROWS = 'ABCDE'

/** A 5×5 BGA at 0.8 mm, 0.4 mm balls, each on its own net; A1 is no-connect, E5 has none. */
const bga = (at = '50 50', extra = ''): string => {
  const pads: string[] = []
  let net = 1
  for (let r = 0; r < 5; r += 1)
    for (let c = 0; c < 5; c += 1) {
      const name = `${ROWS[r]}${c + 1}`
      const x = (c - 2) * 0.8
      const y = (r - 2) * 0.8
      const netPart =
        name === 'E5'
          ? ''
          : name === 'A1'
            ? '(net 99 "unconnected-(U1-PadA1)")'
            : `(net ${net++} "/N${name}")`
      pads.push(
        `(pad "${name}" smd circle (at ${x} ${y}) (size 0.4 0.4) (layers "F.Cu" "F.Paste" "F.Mask") ${netPart})`
      )
    }
  return `(footprint "Package_BGA:Test" (layer "F.Cu") (uuid "u1") (at ${at})
    (property "Reference" "U1" (at 0 -3 0) (layer "F.SilkS") (uuid "u1-r"))
    ${pads.join('\n    ')})${extra}`
}

const pad = (n: number, x: number, y: number, w: number, h: number): string =>
  `(pad "${n}" smd roundrect (at ${x} ${y}) (size ${w} ${h}) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ${100 + n} "/Q${n}"))`

/** A QFN-16 at 0.5 mm, 0.8×0.25 mm pads, with a 1.7 mm exposed pad on GND. */
const qfnFootprint = (pitch = 0.5, width = 0.25): string => {
  const pads: string[] = []
  let n = 1
  const along = [-1.5, -0.5, 0.5, 1.5].map((k) => k * pitch)
  // Left side (pins 1–4, top to bottom), bottom (5–8), right (9–12), top (13–16).
  for (const y of along) pads.push(pad(n++, -1.9, y, 0.8, width))
  for (const x of along) pads.push(pad(n++, x, 1.9, width, 0.8))
  for (const y of [...along].reverse()) pads.push(pad(n++, 1.9, y, 0.8, width))
  for (const x of [...along].reverse()) pads.push(pad(n++, x, -1.9, width, 0.8))
  pads.push(
    `(pad "17" smd rect (at 0 0) (size 1.7 1.7) (layers "F.Cu" "F.Paste" "F.Mask") (net 50 "GND"))`
  )
  return `(footprint "Package_DFN_QFN:Test" (layer "F.Cu") (uuid "u2") (at 20 20)
    (property "Reference" "U2" (at 0 -3 0) (layer "F.SilkS") (uuid "u2-r"))
    ${pads.join('\n    ')})`
}
const nets = (): string => {
  const out = ['(net 0 "")']
  let net = 1
  for (let r = 0; r < 5; r += 1)
    for (let c = 0; c < 5; c += 1) {
      const name = `${ROWS[r]}${c + 1}`
      if (name === 'E5' || name === 'A1') continue
      out.push(`(net ${net++} "/N${name}")`)
    }
  out.push('(net 99 "unconnected-(U1-PadA1)")', '(net 50 "GND")')
  for (let n = 1; n <= 16; n += 1) out.push(`(net ${100 + n} "/Q${n}")`)
  return out.join('\n  ')
}

/**
 * J1, far from both parts, with one pad on every net: each net has somewhere
 * to go, so a part's pads are not joined to their net until routed to it.
 */
const partner = (): string => {
  const numbers = [
    ...Array.from({ length: 23 }, (_, i) => i + 1),
    50,
    ...Array.from({ length: 16 }, (_, i) => 101 + i)
  ]
  const pads = numbers.map(
    (net, i) =>
      `(pad "${i + 1}" smd circle (at ${i % 8} ${Math.floor(i / 8)}) (size 0.3 0.3) (layers "F.Cu" "F.Paste" "F.Mask") (net ${net}))`
  )
  return `(footprint "Connector:Test" (layer "F.Cu") (uuid "j1") (at 30 40)
    (property "Reference" "J1" (at 0 -2 0) (layer "F.SilkS") (uuid "j1-r"))
    ${pads.join('\n    ')})`
}

const boardText = (body: string): string => `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)
    (37 "F.SilkS" user) (44 "Edge.Cuts" user))
  ${nets()}
  ${partner()}
  ${body}
)`

// JLC-like rules: 0.1 mm clearance, 0.45/0.2 vias, 0.1 mm tracks.
const rules: FanoutRules = {
  classOf: () => ({ clearance: 0.1, trackWidth: 0.1, viaDiameter: 0.45, viaDrill: 0.2 }),
  minClearance: 0.1,
  minHoleToHole: 0.25,
  minCopperHoleClearance: 0.2,
  minTrackWidth: 0.1,
  edgeClearance: () => 0.5
}

const plan = (
  body: string,
  reference: string,
  options: FanoutOptions = {},
  r = rules
): { board: KicadBoard; outcome: FanoutOutcome } => {
  const board = parseKicadBoard(boardText(body))
  const index = BoardSpatialIndex.build(board)
  const fpIndex = board.footprints.findIndex((bfp) => bfp.reference === reference)
  return { board, outcome: planFanout(board, index, fpIndex, options, r) }
}

const mm = (value: Nm): number => Math.round(nmToMm(value) * 1000) / 1000

describe('fanout of a BGA', () => {
  test('reads a grid and dogbones each ball to the corner away from the center', () => {
    const { outcome } = plan(bga(), 'U1')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { plan: p } = outcome
    expect([p.layout, p.style, p.layer, p.viaLayers]).toEqual([
      'grid',
      'dogbone',
      'F.Cu',
      ['F.Cu', 'B.Cu']
    ])
    expect(p.refused).toEqual([])
    expect(p.escapes).toHaveLength(23)
    // B2 is up-left of center: its via sits half a pitch further up-left.
    const b2 = p.escapes.find((e) => e.pad === 'U1.B2')!
    expect([mm(b2.via.x), mm(b2.via.y)]).toEqual([48.8, 48.8])
    // The center ball has no side; it goes to the south-east corner.
    const c3 = p.escapes.find((e) => e.pad === 'U1.C3')!
    expect([mm(c3.via.x), mm(c3.via.y)]).toEqual([50.4, 50.4])
    expect(c3.track?.layer).toBe('F.Cu')
    expect(mm(c3.track!.width)).toBe(0.1)
  })

  test('names what it leaves: no net, and a no-connect', () => {
    const { outcome } = plan(bga(), 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.skipped).toEqual([
      { pad: 'U1.A1', reason: 'no-connect' },
      { pad: 'U1.E5', reason: 'no net' }
    ])
  })

  test('two balls never share a via site, whatever the direction', () => {
    for (const direction of ['out', 'in', 'ne', 'sw'] as const) {
      const { outcome } = plan(bga(), 'U1', { direction })
      if (!outcome.ok) throw new Error(outcome.detail)
      const sites = outcome.plan.escapes.map((e) => `${e.via.x},${e.via.y}`)
      expect(new Set(sites).size).toBe(sites.length)
      expect(outcome.plan.refused).toEqual([])
    }
  })

  test('in turns every via towards the center; a compass corner is the same for all', () => {
    const inward = plan(bga(), 'U1', { direction: 'in' }).outcome
    const ne = plan(bga(), 'U1', { direction: 'ne' }).outcome
    if (!inward.ok || !ne.ok) throw new Error('refused')
    const b2 = inward.plan.escapes.find((e) => e.pad === 'U1.B2')!
    expect([mm(b2.via.x), mm(b2.via.y)]).toEqual([49.6, 49.6])
    for (const escape of ne.plan.escapes) {
      const from = escape.track!.from
      expect(mm(escape.via.x) - mm(from.x)).toBeCloseTo(0.4, 3)
      expect(mm(escape.via.y) - mm(from.y)).toBeCloseTo(-0.4, 3)
    }
  })

  test("a class's via that does not fit between balls is refused with the gap, never made smaller", () => {
    // A rail class as boards have them: 0.6 mm vias and 0.5 mm tracks, on
    // 0.4 mm balls at 0.8 mm pitch, where the via sits 0.066 mm from the next ball.
    const rail: FanoutRules = {
      ...rules,
      classOf: (net) =>
        net === '/NB2'
          ? { clearance: 0.1, trackWidth: 0.5, viaDiameter: 0.6, viaDrill: 0.3 }
          : rules.classOf(net)
    }
    const { outcome } = plan(bga(), 'U1', {}, rail)
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.escapes.find((e) => e.pad === 'U1.B2')).toBeUndefined()
    expect(outcome.plan.refused.map((r) => r.pad)).toEqual(['U1.B2'])
    expect(outcome.plan.refused[0].reason).toMatch(
      /^via 0\.066 mm from U1\.\w+ on F\.Cu; the rule is 0\.1 mm$/
    )
    // Every other pad takes its own class's via.
    expect(outcome.plan.escapes.every((e) => mm(e.size) === 0.45 && mm(e.drill) === 0.2)).toBe(true)
    // A smaller via is the caller's to ask for, and is then what every pad takes.
    const smaller = plan(bga(), 'U1', { via: { size: 0.45, drill: 0.2 } }, rail).outcome
    if (!smaller.ok) throw new Error(smaller.detail)
    expect(smaller.plan.refused).toEqual([])
    const b2 = smaller.plan.escapes.find((e) => e.pad === 'U1.B2')!
    expect([mm(b2.size), mm(b2.drill), mm(b2.track!.width)]).toEqual([0.45, 0.2, 0.4])
    // An override too large is refused where it does not fit: only the corner
    // balls' outer corners have room for it.
    const forced = plan(bga(), 'U1', { via: { size: 0.6, drill: 0.3 } }, rail).outcome
    if (!forced.ok) throw new Error(forced.detail)
    expect(forced.plan.escapes.map((e) => e.pad).sort()).toEqual(['U1.A5', 'U1.E1'])
    expect(forced.plan.escapes.every((e) => mm(e.size) === 0.6)).toBe(true)
  })

  test('a crowded pad is refused; the rest of its class keep the class via', () => {
    // Two rail nets in one class; only B2's corner is crowded (a foreign via beside it).
    const rail: FanoutRules = {
      ...rules,
      classOf: (net) =>
        net === '/NB2' || net === '/ND4'
          ? { name: 'Power', clearance: 0.1, trackWidth: 0.3, viaDiameter: 0.5, viaDrill: 0.25 }
          : rules.classOf(net)
    }
    const foreign = `(via (at 48.24 48.8) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net 50) (uuid "v-near"))`
    const { outcome } = plan(bga('50 50', `\n  ${foreign}`), 'U1', { direction: 'nw' }, rail)
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.refused).toContainEqual({
      pad: 'U1.B2',
      reason: 'via 0.085 mm from v-near on F.Cu; the rule is 0.1 mm'
    })
    expect(mm(outcome.plan.escapes.find((e) => e.pad === 'U1.D4')!.size)).toBe(0.5)
  })

  test('two vias of one net are spaced as any two are', () => {
    const same = (net: string): string => (net === '/Q3' ? '/Q2' : net)
    const body = qfnFootprint(0.4, 0.2).replace('(net 103 "/Q3")', '(net 102 "/Q2")')
    const { outcome } = plan(
      body,
      'U2',
      {},
      { ...rules, classOf: (net) => rules.classOf(same(net)) }
    )
    if (!outcome.ok) throw new Error(outcome.detail)
    const at = (pad: string): FanoutEscape => outcome.plan.escapes.find((e) => e.pad === pad)!
    const [a, b] = [at('U2.2'), at('U2.3')]
    const apart = Math.hypot(mm(a.via.x) - mm(b.via.x), mm(a.via.y) - mm(b.via.y))
    expect(apart).toBeGreaterThanOrEqual(mm(a.size) / 2 + mm(b.size) / 2 + 0.1 - 0.001)
  })

  test('surfaceRows leaves the outer ring for surface routing', () => {
    const { outcome } = plan(bga(), 'U1', { surfaceRows: 1 })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.escapes.map((e) => e.pad).sort()).toEqual(
      ['B2', 'B3', 'B4', 'C2', 'C3', 'C4', 'D2', 'D3', 'D4'].map((n) => `U1.${n}`)
    )
    // A1 and E5 are skipped before the ring is asked about.
    expect(outcome.plan.surface).toHaveLength(14)
  })

  test('under-pads puts the via on the ball, with no track', () => {
    const { outcome } = plan(bga(), 'U1', { style: 'under-pads' })
    if (!outcome.ok) throw new Error(outcome.detail)
    const b2 = outcome.plan.escapes.find((e) => e.pad === 'U1.B2')!
    expect([mm(b2.via.x), mm(b2.via.y), b2.track]).toEqual([49.2, 49.2, undefined])
  })

  test('pads and nets narrow it; a pad the part does not have is named', () => {
    const byPad = plan(bga(), 'U1', { pads: ['U1.C3'] }).outcome
    const byNet = plan(bga(), 'U1', { nets: ['/NB2', '/ND4'] }).outcome
    if (!byPad.ok || !byNet.ok) throw new Error('refused')
    expect(byPad.plan.escapes.map((e) => e.pad)).toEqual(['U1.C3'])
    expect(byPad.plan.skipped).toEqual([])
    expect(byNet.plan.escapes.map((e) => e.pad)).toEqual(['U1.B2', 'U1.D4'])
    const missing = plan(bga(), 'U1', { pads: ['U1.Z9'] }).outcome
    expect(missing.ok === false && [missing.error, missing.detail]).toEqual([
      'pad-not-found',
      'U1.Z9 is not a pad of U1.'
    ])
  })

  test('a via that would break a rule is refused with the gap it measured and what it is near', () => {
    // Another net's via 0.3 mm right of B2's site (48.8, 48.8).
    const foreign = `(via (at 49.1 48.8) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net 50) (uuid "v-foreign"))`
    // A compass corner is what was asked for, so B2 is refused, not moved.
    const { outcome } = plan(bga('50 50', `\n  ${foreign}`), 'U1', { direction: 'nw' })
    if (!outcome.ok) throw new Error(outcome.detail)
    const b2 = outcome.plan.refused.find((r) => r.pad === 'U1.B2')
    expect(b2?.reason).toBe('via 0 mm from v-foreign on F.Cu; the rule is 0.1 mm')
  })

  test('out is a preference: a taken corner gives way to the next one', () => {
    const foreign = `(via (at 49.1 48.8) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net 50) (uuid "v-foreign"))`
    const { outcome } = plan(bga('50 50', `\n  ${foreign}`), 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.refused).toEqual([])
    const b2 = outcome.plan.escapes.find((e) => e.pad === 'U1.B2')!
    expect([mm(b2.via.x), mm(b2.via.y)]).toEqual([48.8, 49.6])
  })

  test('pads joined only to each other still get vias: an airwire leaves them', () => {
    // B2 and B3 on one net, joined by a short track; J1's pad of it is not.
    const shared = bga().replace('(net 7 "/NB3")', '(net 6 "/NB2")')
    const track = `(segment (start 49.2 49.2) (end 50 49.2) (width 0.1) (layer "F.Cu") (net 6) (uuid "t1"))`
    const { outcome } = plan(`${shared}\n  ${track}`, 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.skipped.filter((row) => row.reason === 'joined')).toEqual([])
    const pads = outcome.plan.escapes.map((e) => e.pad)
    expect(pads).toContain('U1.B2')
    expect(pads).toContain('U1.B3')
  })

  test('a pad a pour on its layer joins to the rest of its net is skipped', () => {
    // A strip of B2's net on F.Cu from J1's pad of it (35, 40) to B2 (49.2, 49.2).
    const pts = '(xy 35 39.9) (xy 49.2 49.1) (xy 49.2 49.3) (xy 35 40.1)'
    const pour = `(zone (net 6) (net_name "/NB2") (layer "F.Cu") (uuid "z1") (hatch edge 0.5)
    (connect_pads yes (clearance 0.1)) (min_thickness 0.1)
    (fill yes (thermal_gap 0.2) (thermal_bridge_width 0.2))
    (polygon (pts ${pts}))
    (filled_polygon (layer "F.Cu") (pts ${pts})))`
    const { outcome } = plan(bga('50 50', `\n  ${pour}`), 'U1', { pads: ['U1.B2', 'U1.B3'] })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.skipped).toEqual([{ pad: 'U1.B2', reason: 'joined' }])
    expect(outcome.plan.escapes.map((e) => e.pad)).toEqual(['U1.B3'])
  })

  test('a via in the spot of one already there is refused, never stacked', () => {
    // A via of B2's net on B2's north-west site, its stub gone: B2 does not reach it.
    const left = `(via (at 48.8 48.8) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net 6) (uuid "v-b2"))`
    const { outcome } = plan(bga('50 50', `\n  ${left}`), 'U1', {
      pads: ['U1.B2'],
      direction: 'nw'
    })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.escapes).toEqual([])
    expect(outcome.plan.refused).toEqual([
      { pad: 'U1.B2', reason: "drill on v-b2's, in the same spot" }
    ])
  })

  test('a re-run skips each pad its first run gave a via', () => {
    const { board, outcome } = plan(bga(), 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    applyFanout(board, outcome.plan)
    const next = remapKicadBoard(parseKicadBoard(serializeKicadBoard(board)))
    const again = planFanout(
      next,
      BoardSpatialIndex.build(next),
      next.footprints.findIndex((bfp) => bfp.reference === 'U1'),
      {},
      rules
    )
    if (!again.ok) throw new Error(again.detail)
    expect(again.plan.escapes).toEqual([])
    expect(again.plan.refused).toEqual([])
    const fanned = outcome.plan.escapes.map((e) => e.pad).sort()
    expect(
      again.plan.skipped
        .filter((row) => row.reason === 'via')
        .map((row) => row.pad)
        .sort()
    ).toEqual(fanned)
  })

  test('the plan written is the plan read back: one track and one via per escape', () => {
    const { board, outcome } = plan(bga(), 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    const nodes = applyFanout(board, outcome.plan)
    const next = remapKicadBoard(parseKicadBoard(serializeKicadBoard(board)))
    expect(next.vias).toHaveLength(23)
    expect(next.segments).toHaveLength(23)
    expect(nodes).toHaveLength(23)
    const b2 = outcome.plan.escapes.findIndex((e) => e.pad === 'U1.B2')
    const via = next.vias[b2]
    expect([mm(via.position.x), mm(via.position.y), via.net, via.layers]).toEqual([
      48.8,
      48.8,
      6,
      ['F.Cu', 'B.Cu']
    ])
    expect(boardItems(next).filter((item) => item.kind === 'via')).toHaveLength(23)
  })

  test('a footprint on the back fans out on B.Cu', () => {
    const back = bga().replace('(layer "F.Cu") (uuid "u1")', '(layer "B.Cu") (uuid "u1")')
    const flipped = back.replaceAll('"F.Cu" "F.Paste" "F.Mask"', '"B.Cu" "B.Paste" "B.Mask"')
    const { outcome } = plan(flipped, 'U1')
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.layer).toBe('B.Cu')
    expect(outcome.plan.escapes.every((e) => e.track?.layer === 'B.Cu')).toBe(true)
  })
})

describe('fanout of a QFN', () => {
  test('reads rows, staggers the vias off each side, and arrays the exposed pad', () => {
    const { outcome } = plan(qfnFootprint(), 'U2')
    if (!outcome.ok) throw new Error(outcome.detail)
    const p = outcome.plan
    expect([p.layout, p.style]).toEqual(['rows', 'staggered'])
    // Pin 1 on the left edge leaves left: its via is left of the pad, at its height.
    const one = p.escapes.find((e) => e.pad === 'U2.1')!
    expect(mm(one.via.x)).toBeLessThan(20 - 1.9 - 0.4)
    expect(mm(one.via.y)).toBe(20 - 0.75)
    // The exposed pad: a 1.7 mm pad holds a 2×2 array at 1 mm pitch.
    expect(p.escapes.filter((e) => e.pad === 'U2.17')).toHaveLength(4)
    expect(p.escapes.filter((e) => e.pad === 'U2.17').every((e) => !e.track)).toBe(true)
  })

  test('inline tries every pad on the inner ring, and steps out where a neighbour took it', () => {
    const { outcome } = plan(qfnFootprint(), 'U2', { style: 'inline' })
    if (!outcome.ok) throw new Error(outcome.detail)
    // 0.5 mm pitch cannot hold 0.45 mm vias 0.1 mm apart in one line: pin 1
    // takes the inner ring, pin 2 beside it the next, pin 3 the inner again.
    expect(outcome.plan.refused).toEqual([])
    const x = (pad: string): number => mm(outcome.plan.escapes.find((e) => e.pad === pad)!.via.x)
    expect(x('U2.1')).toBe(x('U2.3'))
    expect(x('U2.2')).toBeLessThan(x('U2.1'))
  })

  test('a via whose every ring is taken is refused with the gap it measured', () => {
    // Another net's tracks on the back across the whole left side, past the outermost ring.
    const blocker = Array.from({ length: 16 }, (_, i) => i)
      .map(
        (i) =>
          `(segment (start ${17.9 - i * 0.25} 18) (end ${17.9 - i * 0.25} 22) (width 0.1) (layer "B.Cu") (net 50) (uuid "w${i}"))`
      )
      .join('\n  ')
    const { outcome } = plan(`${qfnFootprint()}\n  ${blocker}`, 'U2')
    if (!outcome.ok) throw new Error(outcome.detail)
    const left = outcome.plan.refused.filter((r) =>
      ['U2.1', 'U2.2', 'U2.3', 'U2.4'].includes(r.pad)
    )
    expect(left).toHaveLength(4)
    for (const refusal of left) expect(refusal.reason).toMatch(/on B\.Cu; the rule is 0\.1 mm$/)
  })

  test("at 0.4 mm pitch, a rail pin among signals takes its class's via on the outer ring", () => {
    // The benchmark's RP2040 in miniature: 0.2 mm pads at 0.4 mm pitch, one
    // rail pin whose class asks for a 0.6 mm via and a 0.4 mm track. Staggered,
    // its via sits past its neighbours', its stub narrowed to pass theirs.
    const board: FanoutRules = {
      classOf: (net) =>
        net === '/Q2'
          ? { clearance: 0.1, trackWidth: 0.4, viaDiameter: 0.6, viaDrill: 0.3 }
          : { clearance: 0.1, trackWidth: 0.127, viaDiameter: 0.45, viaDrill: 0.2 },
      minClearance: 0.1,
      minHoleToHole: 0.25,
      minCopperHoleClearance: 0.15,
      minTrackWidth: 0.1,
      edgeClearance: () => 0.5
    }
    const { outcome } = plan(qfnFootprint(0.4, 0.2), 'U2', {}, board)
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.plan.refused).toEqual([])
    const at = (n: number): FanoutEscape => outcome.plan.escapes.find((e) => e.pad === `U2.${n}`)!
    expect([mm(at(2).size), mm(at(2).drill), mm(at(2).track!.width)]).toEqual([0.6, 0.3, 0.15])
    expect([1, 3, 4].map((n) => mm(at(n).size))).toEqual([0.45, 0.45, 0.45])
    // Pin 2 is on the left side: its via is further out than its neighbours'.
    expect(mm(at(2).via.x)).toBeLessThan(mm(at(1).via.x))
  })

  test('a via or stub that would come nearer the board edge than its clearance is refused', () => {
    // The outline's left side 1 mm past the left pads' ends: no ring fits there.
    const outline = `(gr_rect (start 17 10) (end 60 60) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge"))`
    const { outcome } = plan(`${qfnFootprint()}\n  ${outline}`, 'U2')
    if (!outcome.ok) throw new Error(outcome.detail)
    const left = ['U2.1', 'U2.2', 'U2.3', 'U2.4']
    const refused = outcome.plan.refused.filter((r) => left.includes(r.pad))
    expect(refused.map((r) => r.pad)).toEqual(left)
    for (const refusal of refused)
      expect(refusal.reason).toMatch(/from the board edge; the rule is 0\.5 mm$/)
    // The other sides are clear of it.
    expect(outcome.plan.refused).toHaveLength(4)
    for (const escape of outcome.plan.escapes) expect(mm(escape.via.x)).toBeGreaterThan(17.5)
  })

  test('the edge clearance is the one the rules give the new copper', () => {
    const outline = `(gr_rect (start 17 10) (end 60 60) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge"))`
    const asked: string[] = []
    const loose: FanoutRules = {
      ...rules,
      edgeClearance: (_net, kind, layers) => (asked.push(`${kind} ${layers.join(',')}`), null)
    }
    const { outcome } = plan(`${qfnFootprint()}\n  ${outline}`, 'U2', {}, loose)
    if (!outcome.ok) throw new Error(outcome.detail)
    // No rule holds the edge: nothing is refused for it.
    expect(outcome.plan.refused).toEqual([])
    expect(asked).toContain('via F.Cu,In1.Cu,In2.Cu,B.Cu')
    expect(asked).toContain('track F.Cu')
  })

  test('a style the pads cannot take is refused before anything is planned', () => {
    const rows = plan(qfnFootprint(), 'U2', { style: 'dogbone' }).outcome
    const grid = plan(bga(), 'U1', { style: 'staggered' }).outcome
    const corner = plan(qfnFootprint(), 'U2', { direction: 'ne' }).outcome
    expect([rows.ok, grid.ok, corner.ok]).toEqual([false, false, false])
    expect(rows.ok === false && rows.error).toBe('not-applicable')
  })
})

describe('what a fanout writes', () => {
  // The fixture's rules as Board Setup holds them; the edge clearance is KiCad's default 0.3 mm.
  const settings: BoardDesignSettings = {
    rules: {
      ...DEFAULT_DESIGN_RULES,
      minClearance: 0.1,
      minHoleToHole: 0.25,
      minCopperHoleClearance: 0.2,
      minViaDiameter: 0.45,
      minThroughHoleDiameter: 0.2,
      minViaAnnularWidth: 0.1,
      minTrackWidth: 0.1,
      minConnectionWidth: 0.1
    },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({
      ...cls,
      clearance: 0.1,
      trackWidth: 0.1,
      viaDiameter: 0.45,
      viaDrill: 0.2
    })),
    patterns: [],
    assignments: []
  }

  // The planner's own clearance model against the board's DRC: whatever it
  // places, the checks find nothing between copper or holes.
  test('passes the design checks it planned against', async () => {
    await loadClipper()
    const outline = `
  (gr_rect (start 10 10) (end 60 60) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge"))`
    // The outline's left side close enough that the QFN's left vias would cross it.
    const tight = `
  (gr_rect (start 17 10) (end 60 60) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge"))`
    for (const [body, reference] of [
      [bga() + outline, 'U1'],
      [qfnFootprint() + outline, 'U2'],
      [qfnFootprint() + tight, 'U2']
    ] as const) {
      const board = parseKicadBoard(boardText(body))
      const fp = board.footprints.findIndex((bfp) => bfp.reference === reference)
      const outcome = planFanout(
        board,
        BoardSpatialIndex.build(board),
        fp,
        {},
        fanoutRulesOf(settings, board)
      )
      if (!outcome.ok) throw new Error(outcome.detail)
      // Only the tight outline turns pads away, each at the edge.
      expect(outcome.plan.refused.every((r) => r.reason.includes('board edge'))).toBe(true)
      expect(outcome.plan.refused.length > 0).toBe(body.endsWith(tight))
      applyFanout(board, outcome.plan)
      const next = remapKicadBoard(parseKicadBoard(serializeKicadBoard(board)))
      const index = BoardSpatialIndex.build(next)
      const findings = boardChecks({
        board: next,
        index,
        connectivity: computeConnectivity(next, index),
        settings
      })
      // A via no track leaves yet dangles until it is routed, and J1 is not
      // routed to; the fixture's text is drawn thinner than the rules ask. Nothing else.
      const codes = [...new Set(findings.map((finding) => finding.code))].sort()
      expect({ reference, codes }).toEqual({
        reference,
        codes: ['text-thickness', 'unconnected-items', 'via-dangling']
      })
    }
  })
})
