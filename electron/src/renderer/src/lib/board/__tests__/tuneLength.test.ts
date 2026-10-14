/**
 * T2: lengths as the tuner reads them — tracks and arcs, each via's height
 * through the stackup between the layers it joins, and pad-to-die — over a
 * whole net, and over the tuned track's path between its two pads.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { routedNetLength, tunedPathLength } from '../tuneLength'

const LAYERS_2 = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user))`
const LAYERS_4 = `(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))`

/** A 4-layer stackup: 35 µm copper, 0.2 mm prepreg, 1 mm core. */
const STACKUP = `(setup (stackup
    (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "prepreg") (thickness 0.2))
    (layer "In1.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 2" (type "core") (thickness 1))
    (layer "In2.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 3" (type "prepreg") (thickness 0.2))
    (layer "B.Cu" (type "copper") (thickness 0.035))))`

const board = (layers: string, body: string, setup = ''): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  ${layers}
  ${setup}
  (net 0 "") (net 1 "SIG") (net 2 "OTHER")
  ${body}
)`)

const seg = (net: number, x0: number, y0: number, x1: number, y1: number, layer = 'F.Cu'): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.2) (layer "${layer}") (net ${net}) (uuid "${crypto.randomUUID()}"))`
const via = (x: number, y: number, layers = '"F.Cu" "B.Cu"'): string =>
  `(via (at ${x} ${y}) (size 0.6) (drill 0.3) (layers ${layers}) (net 1) (uuid "${crypto.randomUUID()}"))`

const on = { useHeight: true, maxError: 0.005 }

describe('routedNetLength (T2)', () => {
  test('tracks and arcs on the net, and nothing of another net', () => {
    const b = board(
      LAYERS_2,
      `${seg(1, 100, 100, 110, 100)}
  (arc (start 110 100) (mid 112.828427 101.171573) (end 114 104) (width 0.2) (layer "F.Cu") (net 1) (uuid "a1"))
  ${seg(2, 100, 120, 150, 120)}`
    )
    // 10 mm and a quarter circle of radius 4 mm.
    const want = 10_000_000 + 2 * Math.PI * 1_000_000
    expect(Math.abs(routedNetLength(b, 1, on) - want)).toBeLessThan(10)
  })

  test("a via counts its height between the layers it joins, KiCad's default stackup where the board has none", () => {
    const b = board(
      LAYERS_2,
      `${seg(1, 100, 100, 110, 100)}
  ${via(110, 100)}
  ${seg(1, 110, 100, 110, 105, 'B.Cu')}`
    )
    // KiCad's default two-layer stackup puts B.Cu 1.58 mm under F.Cu.
    expect(routedNetLength(b, 1, on)).toBe(15_000_000 + 1_580_000)
    // Without via heights (use_height_for_length_calcs off) the tracks alone.
    expect(routedNetLength(b, 1, { ...on, useHeight: false })).toBe(15_000_000)
  })

  test("the board's own stackup, between the layers the via's tracks reach, not its whole span", () => {
    const b = board(
      LAYERS_4,
      `${seg(1, 100, 100, 110, 100)}
  ${via(110, 100)}
  ${seg(1, 110, 100, 110, 105, 'In1.Cu')}`,
      STACKUP
    )
    // F.Cu whole (outer), the prepreg, half of In1.Cu (inner): 35 + 200 + 17.5 µm.
    expect(routedNetLength(b, 1, on)).toBe(15_000_000 + 252_500)
  })

  test('a via its tracks meet on one layer only adds nothing', () => {
    const b = board(
      LAYERS_2,
      `${seg(1, 100, 100, 110, 100)}
  ${via(110, 100)}
  ${seg(1, 110, 100, 110, 105)}`
    )
    expect(routedNetLength(b, 1, on)).toBe(15_000_000)
  })

  test("each pad's pad-to-die length is added", () => {
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 100 100) (uuid "f1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (die_length 2.5) (uuid "p1")))
  ${seg(1, 100, 100, 110, 100)}`
    )
    expect(routedNetLength(b, 1, on)).toBe(12_500_000)
  })

  test("a via in an SMD pad carries the signal to the pad's side", () => {
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 100 100) (uuid "f1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "p1")))
  ${via(100.2, 100)}
  ${seg(1, 100.2, 100, 110, 100, 'B.Cu')}`
    )
    expect(routedNetLength(b, 1, on)).toBe(9_800_000 + 1_580_000)
  })
})

describe('tunedPathLength (T2): the tuned track between its two pads', () => {
  const pad = (n: string, x: number, y: number, extra = ''): string =>
    `(pad "${n}" smd rect (at ${x} ${y}) (size 1 1) (layers "F.Cu") (net 1 "SIG") ${extra} (uuid "p${n}"))`
  const tht = (n: string, x: number, y: number): string =>
    `(pad "${n}" thru_hole circle (at ${x} ${y}) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (net 1 "SIG") (uuid "p${n}"))`

  test('only its own path: copper of the net elsewhere is not counted', () => {
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 0 0) (uuid "f1")
    ${pad('1', 100, 100)} ${pad('2', 110, 100)} ${pad('3', 120, 100)} ${pad('4', 130, 100)})
  ${seg(1, 100, 100, 105, 100)}
  ${seg(1, 105, 100, 110, 100)}
  ${seg(1, 120, 100, 130, 100)}`
    )
    expect(routedNetLength(b, 1, on)).toBe(20_000_000)
    expect(tunedPathLength(b, { type: 'segment', index: 0 }, on)).toBe(10_000_000)
  })

  test("a track bending inside its pad is read from the pad's anchor to where it leaves (KiCad's OptimiseTraceInPad)", () => {
    // Up 0.3 inside pad 1 (1 × 1 at 100, 100), then out along y 100.3 to pad 2.
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 0 0) (uuid "f1")
    ${pad('1', 100, 100)} ${pad('2', 110, 100.3)})
  ${seg(1, 100, 100, 100, 100.3)}
  ${seg(1, 100, 100.3, 110, 100.3)}`
    )
    // Anchor to the edge at (100.5, 100.3), then on to pad 2: not the 10.3 mm laid.
    const expected = (Math.hypot(0.5, 0.3) + 9.5) * 1e6
    expect(tunedPathLength(b, { type: 'segment', index: 1 }, on)).toBeCloseTo(expected, -2)
    expect(routedNetLength(b, 1, on)).toBeCloseTo(expected, -2)
  })

  test("through a via to its far pad, with the two end pads' pad-to-die alone", () => {
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 0 0) (uuid "f1")
    ${pad('1', 100, 100, '(die_length 2.5)')} ${tht('2', 110, 105)} ${pad('3', 140, 100, '(die_length 1)')})
  ${seg(1, 100, 100, 110, 100)}
  ${via(110, 100)}
  ${seg(1, 110, 100, 110, 105, 'B.Cu')}
  ${seg(1, 130, 100, 140, 100)}`
    )
    expect(tunedPathLength(b, { type: 'segment', index: 1 }, on)).toBe(
      15_000_000 + 1_580_000 + 2_500_000
    )
  })

  test('on through an in-line pad, and the longer way where it branches', () => {
    const b = board(
      LAYERS_2,
      `(footprint "R" (layer "F.Cu") (at 0 0) (uuid "f1")
    ${pad('1', 100, 100)} ${pad('2', 110, 100)} ${pad('3', 120, 100)} ${pad('4', 110, 103)})
  ${seg(1, 100, 100, 110, 100)}
  ${seg(1, 110, 100, 120, 100)}
  ${seg(1, 110, 100, 110, 103)}`
    )
    expect(tunedPathLength(b, { type: 'segment', index: 0 }, on)).toBe(20_000_000)
  })
})
