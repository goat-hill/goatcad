// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A coplanar waveguide, with or without a ground plane beneath, as KiCad
 * 10.0.6's PCB Calculator computes it (`pcb_calculator/transline/coplanar.cpp`
 * over `transline.cpp`'s helpers): conformal-mapping quasi-statics, a strip
 * thickness correction and a TE0 dispersion term. KiCad's tuning profiles have
 * no coplanar model, so this is held to the calculator: its synthesis is the
 * older Newton search, capped at 100 steps. The 50 Ω RF feed is the usual use.
 */
import {
  C0,
  ellipticIntegral,
  minimiseZ0Error1D,
  unitPropagationDelay,
  ZF0,
  type Transline
} from './translineMath'

type CoplanarParam = 'epsilonR' | 'h' | 't' | 'width' | 'gap' | 'z0' | 'frequency'

class Coplanar implements Transline<CoplanarParam> {
  p: Record<CoplanarParam, number> = {
    epsilonR: 0,
    h: 0,
    t: 0,
    width: 0,
    gap: 0,
    z0: 0,
    frequency: 0
  }
  epsilonEff = 0
  constructor(private readonly backMetal: boolean) {}

  analyse(): void {
    const { width: w, gap: s, h, t, epsilonR: er, frequency: f } = this.p
    const ellipk = (k: number): number => ellipticIntegral(k).k
    const k1 = w / (w + s + s)
    const q1 = ellipk(k1) / ellipk(Math.sqrt(1 - k1 * k1))
    let q3 = 0
    let er0: number
    let zlFactor: number
    if (this.backMetal) {
      const k3 = Math.tanh((Math.PI / 4) * (w / h)) / Math.tanh(((Math.PI / 4) * (w + s + s)) / h)
      q3 = ellipk(k3) / ellipk(Math.sqrt(1 - k3 * k3))
      const qz = 1 / (q1 + q3)
      er0 = 1 + q3 * qz * (er - 1)
      zlFactor = (ZF0 / 2) * qz
    } else {
      const k2 = Math.sinh((Math.PI / 4) * (w / h)) / Math.sinh(((Math.PI / 4) * (w + s + s)) / h)
      const q2 = ellipk(k2) / ellipk(Math.sqrt(1 - k2 * k2))
      er0 = 1 + ((er - 1) / 2) * (q2 / q1)
      zlFactor = ZF0 / 4 / q1
    }
    if (t > 0) {
      const d = ((t * 1.25) / Math.PI) * (1 + Math.log((4 * Math.PI * w) / t))
      const se = s - d
      const We = w + d
      const ke = We / (We + se + se)
      const qe = ellipk(ke) / ellipk(Math.sqrt(1 - ke * ke))
      if (this.backMetal) {
        const qz = 1 / (qe + q3)
        er0 = 1 + q3 * qz * (er - 1)
        zlFactor = (ZF0 / 2) * qz
      } else {
        zlFactor = ZF0 / 4 / qe
      }
      er0 = er0 - (0.7 * (er0 - 1) * t) / s / (q1 + (0.7 * t) / s)
    }
    const srEr = Math.sqrt(er)
    const srEr0 = Math.sqrt(er0)
    // The TE0 mode's cut-off frequency, and the dispersion factor G.
    const fte = C0 / 4 / (h * Math.sqrt(er - 1))
    const p = Math.log(w / h)
    const u = 0.54 - (0.64 - 0.015 * p) * p
    const v = 0.43 - (0.86 - 0.54 * p) * p
    const G = Math.exp(u * Math.log(w / s) + v)
    let srErF = srEr0
    srErF += (srEr - srEr0) / (1 + G * Math.pow(f / fte, -1.8))
    this.epsilonEff = srErF * srErF
    this.p.z0 = zlFactor / srErF
  }
}

export interface CoplanarInput {
  /** A ground plane beneath (grounded coplanar waveguide), or air. */
  grounded: boolean
  widthMm: number
  /** The gap from the strip's edge to the coplanar ground, each side. */
  gapMm: number
  /** Dielectric height to the plane beneath (or the substrate's thickness). */
  heightMm: number
  thicknessMm: number
  epsilonR: number
  frequencyHz: number
}

export interface CoplanarAnalysis {
  ohms: number
  epsilonEff: number
  /** Attoseconds per millimeter, as KiCad stores a delay. */
  delay: number
}

const lineOf = (input: CoplanarInput): Coplanar => {
  const line = new Coplanar(input.grounded)
  line.p.epsilonR = input.epsilonR
  line.p.h = input.heightMm / 1000
  line.p.t = input.thicknessMm / 1000
  line.p.width = input.widthMm / 1000
  line.p.gap = input.gapMm / 1000
  line.p.frequency = input.frequencyHz
  return line
}

/** Attoseconds per millimeter from ps/cm, truncated as KiCad's grid stores it. */
const delayOf = (epsilonEff: number): number =>
  Math.trunc((unitPropagationDelay(epsilonEff) / 10) * 1e6)

export function analyseCoplanar(input: CoplanarInput): CoplanarAnalysis {
  const line = lineOf(input)
  line.analyse()
  return { ohms: line.p.z0, epsilonEff: line.epsilonEff, delay: delayOf(line.epsilonEff) }
}

export type CoplanarSolveError = 'target-not-positive' | 'no-width' | 'no-gap'

export type CoplanarSolveResult =
  | ({ ok: true; widthMm: number; gapMm: number } & CoplanarAnalysis)
  | { ok: false; error: CoplanarSolveError }

const fail = (error: CoplanarSolveError): CoplanarSolveResult => ({ ok: false, error })

/**
 * The width (gap held) or the gap (width held) for a target impedance, from
 * the held input's value as the calculator starts from its field (none: 1 mm).
 */
export function solveCoplanar(
  input: CoplanarInput & { targetOhms: number; solveFor: 'width' | 'gap' }
): CoplanarSolveResult {
  if (!(input.targetOhms > 0)) return fail('target-not-positive')
  const line = lineOf(input)
  line.p.z0 = input.targetOhms
  const solved = input.solveFor === 'width' ? 'width' : 'gap'
  minimiseZ0Error1D(line, solved, 'z0', 100)
  line.analyse()
  const value = line.p[solved]
  if (!Number.isFinite(value) || value <= 0) return fail(solved === 'width' ? 'no-width' : 'no-gap')
  return {
    ok: true,
    widthMm: line.p.width * 1000,
    gapMm: line.p.gap * 1000,
    ohms: input.targetOhms,
    epsilonEff: line.epsilonEff,
    delay: delayOf(line.epsilonEff)
  }
}
