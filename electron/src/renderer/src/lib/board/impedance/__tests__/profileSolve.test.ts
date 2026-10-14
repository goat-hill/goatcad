import { describe, expect, test } from 'vitest'
import { analyseLayer, solveProfileLayer, type SolveFor } from '../profileSolve'
import type { SolverStackup, SolverStackupLayer } from '../stackupInput'

/*
 * Expected values are KiCad 10.0.6's: its `common/transline_calculations`
 * compiled unchanged and driven with the inputs PANEL_SETUP_TUNING_PROFILE_INFO
 * assembles for each row (its dielectric mean, its 1 GHz, its integer units).
 */

const cu = (name: string, nm: number): SolverStackupLayer => ({
  kind: 'copper',
  name,
  thicknessMm: nm / 1e6,
  epsilonR: 1,
  lossTangent: 0
})
const di = (name: string, nm: number, epsilonR = 4.5, lossTangent = 0.02): SolverStackupLayer => ({
  kind: 'dielectric',
  name,
  thicknessMm: nm / 1e6,
  epsilonR,
  lossTangent
})

const stacks: Record<string, SolverStackup> = {
  // Generic 2-layer 1.6 mm FR-4, as setBoardStackupInAST writes it.
  two: [cu('F.Cu', 35000), di('dielectric 1', 1530000), cu('B.Cu', 35000)],
  // JLC04161H-7628, from lib/manufacturingProfiles.ts.
  four: [
    cu('F.Cu', 35000),
    di('dielectric 1', 210400),
    cu('In1.Cu', 15200),
    di('dielectric 2', 1078800),
    cu('In2.Cu', 15200),
    di('dielectric 3', 210400),
    cu('B.Cu', 35000)
  ],
  // Mixed dielectrics, one with two sublayers, and asymmetric references inside.
  six: [
    cu('F.Cu', 35000),
    di('dielectric 1', 100000, 3.7, 0.01),
    di('dielectric 1', 80000, 4.2, 0.015),
    cu('In1.Cu', 17500),
    di('dielectric 2', 300000, 4.6, 0.02),
    cu('In2.Cu', 17500),
    di('dielectric 3', 400000, 4.3, 0.018),
    cu('In3.Cu', 17500),
    di('dielectric 4', 250000, 3.9, 0.012),
    cu('In4.Cu', 17500),
    di('dielectric 5', 120000, 4.1, 0.02),
    cu('B.Cu', 35000)
  ]
}

interface Case {
  stack: string
  signal: string
  top: string
  bottom: string
  differential: boolean
  ohms: number
  solveFor: SolveFor
  widthNm: number
  gapNm: number
  expect: { widthNm?: number; gapNm?: number; delay?: number; ohms?: number; error?: string }
}

const cases: Case[] = [
  {
    stack: 'two',
    signal: 'F.Cu',
    top: '',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 2841618, delay: 6136505 }
  },
  {
    stack: 'two',
    signal: 'B.Cu',
    top: 'F.Cu',
    bottom: '',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 2841618, delay: 6136505 }
  },
  {
    stack: 'two',
    signal: 'F.Cu',
    top: '',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'delay',
    widthNm: 300000,
    gapNm: 0,
    expect: { widthNm: 300000, delay: 5681964, ohms: 124.19563406590925 }
  },
  {
    stack: 'two',
    signal: 'F.Cu',
    top: '',
    bottom: 'B.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 150000,
    expect: { widthNm: 754791, gapNm: 150000, delay: 5585286 }
  },
  {
    stack: 'two',
    signal: 'F.Cu',
    top: '',
    bottom: 'B.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'gap',
    widthNm: 200000,
    gapNm: 0,
    expect: { widthNm: 200000, gapNm: 58234, delay: 5560545 }
  },
  {
    stack: 'two',
    signal: 'F.Cu',
    top: '',
    bottom: 'B.Cu',
    differential: true,
    ohms: 100,
    solveFor: 'delay',
    widthNm: 150000,
    gapNm: 200000,
    expect: { widthNm: 150000, gapNm: 200000, delay: 5560679, ohms: 139.00158587110701 }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 374744, delay: 5950607 }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 127000,
    expect: { widthNm: 304366, gapNm: 127000, delay: 5808950 }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 85,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 100000,
    expect: { widthNm: 313582, gapNm: 100000, delay: 5796796 }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 100,
    solveFor: 'gap',
    widthNm: 120000,
    gapNm: 0,
    expect: { widthNm: 120000, gapNm: 46841, delay: 5643803 }
  },
  {
    stack: 'four',
    signal: 'B.Cu',
    top: 'In2.Cu',
    bottom: '',
    differential: true,
    ohms: 90,
    solveFor: 'delay',
    widthNm: 150000,
    gapNm: 127000,
    expect: { widthNm: 150000, gapNm: 127000, delay: 5702287, ohms: 119.61627553032741 }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: 'F.Cu',
    bottom: 'In2.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 301882, delay: 7094716 }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: 'F.Cu',
    bottom: 'In2.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 150000,
    expect: { widthNm: 235405, gapNm: 150000, delay: 7094716 }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: 'F.Cu',
    bottom: 'In2.Cu',
    differential: true,
    ohms: 100,
    solveFor: 'gap',
    widthNm: 100000,
    gapNm: 0,
    expect: { widthNm: 100000, gapNm: 84917, delay: 7094716 }
  },
  {
    stack: 'four',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 301882, delay: 7094716 }
  },
  {
    stack: 'four',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'delay',
    widthNm: 150000,
    gapNm: 0,
    expect: { widthNm: 150000, delay: 7094716, ohms: 67.614128526563277 }
  },
  {
    stack: 'six',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 353383, delay: 5618873 }
  },
  {
    stack: 'six',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 120000,
    expect: { widthNm: 303409, gapNm: 120000, delay: 5523528 }
  },
  {
    stack: 'six',
    signal: 'F.Cu',
    top: '',
    bottom: 'In2.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 899431, delay: 5973735 }
  },
  {
    stack: 'six',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'In3.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 281348, delay: 7038184 }
  },
  {
    stack: 'six',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'In3.Cu',
    differential: true,
    ohms: 100,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 150000,
    expect: { widthNm: 139906, gapNm: 150000, delay: 7038184 }
  },
  {
    stack: 'six',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'In3.Cu',
    differential: true,
    ohms: 85,
    solveFor: 'gap',
    widthNm: 100000,
    gapNm: 0,
    expect: { widthNm: 100000, gapNm: 54819, delay: 7038184 }
  },
  {
    stack: 'six',
    signal: 'In2.Cu',
    top: 'In1.Cu',
    bottom: 'In3.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'delay',
    widthNm: 120000,
    gapNm: 0,
    expect: { widthNm: 120000, delay: 7038184, ohms: 70.421753554978082 }
  },
  {
    stack: 'six',
    signal: 'In2.Cu',
    top: 'F.Cu',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 529281, delay: 6869145 }
  },
  {
    stack: 'six',
    signal: 'In3.Cu',
    top: 'In2.Cu',
    bottom: 'In4.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'delay',
    widthNm: 100000,
    gapNm: 150000,
    expect: { widthNm: 100000, gapNm: 150000, delay: 6810069, ohms: 114.3862070617883 }
  },
  {
    stack: 'six',
    signal: 'B.Cu',
    top: 'In4.Cu',
    bottom: '',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { widthNm: 223945, delay: 5631996 }
  },
  {
    stack: 'six',
    signal: 'B.Cu',
    top: 'In4.Cu',
    bottom: '',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 100000,
    expect: { widthNm: 205875, gapNm: 100000, delay: 5671295 }
  },
  // KiCad's refusals.
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: false,
    ohms: 0,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'target-not-positive' }
  },
  {
    stack: 'four',
    signal: 'In5.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'signal-layer-missing' }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'F.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'reference-same-as-signal' }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In9.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'reference-missing' }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: 'In2.Cu',
    bottom: 'B.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'top-reference-not-above' }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: 'F.Cu',
    bottom: 'In1.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'bottom-reference-not-below' }
  },
  {
    stack: 'four',
    signal: 'In1.Cu',
    top: '',
    bottom: 'In2.Cu',
    differential: false,
    ohms: 50,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'top-reference-missing' }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'width',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'gap-required' }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'gap',
    widthNm: 0,
    gapNm: 0,
    expect: { error: 'width-required' }
  },
  {
    stack: 'four',
    signal: 'F.Cu',
    top: '',
    bottom: 'In1.Cu',
    differential: true,
    ohms: 90,
    solveFor: 'delay',
    widthNm: 100000,
    gapNm: 0,
    expect: { error: 'width-and-gap-required' }
  }
]

const name = (c: Case): string =>
  `${c.stack} ${c.signal} ${c.differential ? 'pair' : 'single'} ${c.ohms} Ω ${c.solveFor}` +
  (c.expect.error ? ` → ${c.expect.error}` : '')

const geometry = (c: Case): Parameters<typeof analyseLayer>[0] => ({
  stackup: stacks[c.stack],
  signalLayer: c.signal,
  topReference: c.top || undefined,
  bottomReference: c.bottom || undefined,
  differential: c.differential,
  widthMm: c.widthNm / 1e6,
  gapMm: c.gapNm / 1e6
})

describe('solveProfileLayer, held to KiCad 10.0.6', () => {
  test.each(cases)('$stack $signal', (c) => {
    const result = solveProfileLayer({ ...geometry(c), targetOhms: c.ohms, solveFor: c.solveFor })
    if (c.expect.error) {
      expect(result, name(c)).toEqual({ ok: false, error: c.expect.error })
      return
    }
    expect(result, name(c)).toEqual({
      ok: true,
      widthMm: c.expect.widthNm! / 1e6,
      ...(c.differential ? { gapMm: c.expect.gapNm! / 1e6 } : {}),
      delay: c.expect.delay
    })
  })
})

describe('analyseLayer', () => {
  test.each(cases.filter((c) => c.expect.ohms !== undefined))('$stack $signal', (c) => {
    const result = analyseLayer(geometry(c))
    expect(result.ok, name(c)).toBe(true)
    if (!result.ok) return
    expect(result.delay).toBe(c.expect.delay)
    expect(Math.abs(result.ohms - c.expect.ohms!) / c.expect.ohms!).toBeLessThan(1e-9)
  })

  test('a solved width analyses back to its target', () => {
    const geometryOf = {
      stackup: stacks.four,
      signalLayer: 'F.Cu',
      bottomReference: 'In1.Cu',
      differential: true
    }
    const solved = solveProfileLayer({
      ...geometryOf,
      targetOhms: 90,
      solveFor: 'width',
      gapMm: 0.127
    })
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    const analysed = analyseLayer({ ...geometryOf, widthMm: solved.widthMm, gapMm: 0.127 })
    expect(analysed.ok && Math.abs(analysed.ohms - 90)).toBeLessThan(0.01)
  })

  test('a single-ended profile has no gap to solve', () => {
    expect(
      solveProfileLayer({
        stackup: stacks.two,
        signalLayer: 'F.Cu',
        bottomReference: 'B.Cu',
        differential: false,
        targetOhms: 50,
        solveFor: 'gap',
        widthMm: 0.2
      })
    ).toEqual({ ok: false, error: 'gap-on-single' })
  })
})
