// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * An edge-coupled microstrip pair as KiCad 10.0.6 computes it
 * (`common/transline_calculations/coupled_microstrip.cpp`): Kirschning and
 * Jansen's even- and odd-mode static impedances and permittivities over a
 * zero-thickness single line, Jansen's thickness correction, then their
 * dispersion. The pair's impedance is twice the odd mode's. Only the
 * one-dimensional syntheses KiCad's tuning-profile page uses (width at a fixed
 * gap, gap at a fixed width) are ported, and nothing that feeds only losses.
 * Meters.
 */
import { Microstrip, deltaQThickness } from './microstrip'
import { minimiseZ0Error1D, unitPropagationDelay, ZF0, type Transline } from './translineMath'

export type CoupledMicrostripParam =
  'epsilonR' | 'h' | 'hT' | 't' | 'width' | 'gap' | 'z0Even' | 'z0Odd' | 'frequency'

export class CoupledMicrostrip implements Transline<CoupledMicrostripParam> {
  p: Record<CoupledMicrostripParam, number> = {
    epsilonR: 0,
    h: 0,
    hT: 0,
    t: 0,
    width: 0,
    gap: 0,
    z0Even: 0,
    z0Odd: 0,
    frequency: 0
  }
  /** Picoseconds per centimeter, even and odd mode. */
  unitPropDelayEven = 0
  unitPropDelayOdd = 0
  private single = new Microstrip()
  private wTe = 0
  private wTo = 0
  private erEffE0 = 0
  private erEffO0 = 0
  private erEffE = 0
  private erEffO = 0
  private z0E0 = 0
  private z0O0 = 0

  analyse(): void {
    this.deltaUThickness()
    this.erEffStatic()
    this.z0EvenOdd()
    this.erEffFreq()
    this.z0Dispersion()
  }

  /** Fit the width to the odd-mode target, the gap held. */
  synthesizeWidth(): boolean {
    return minimiseZ0Error1D(this, 'width', 'z0Odd')
  }

  /** Fit the gap to the odd-mode target, the width held. */
  synthesizeGap(): boolean {
    return minimiseZ0Error1D(this, 'gap', 'z0Odd')
  }

  private deltaUThickness(): void {
    const er = this.p.epsilonR
    const u = this.p.width / this.p.h
    const g = this.p.gap / this.p.h
    const th = this.p.t / this.p.h
    let duE = 0.0
    let duO = 0.0
    if (th > 0.0) {
      const du = deltaUThicknessSingle(u, th)
      const dt = th / (g * er)
      duE = du * (1.0 - 0.5 * Math.exp((-0.69 * du) / dt))
      duO = duE + dt
    }
    this.wTe = this.p.width + duE * this.p.h
    this.wTo = this.p.width + duO * this.p.h
  }

  /** The zero-thickness single line both modes are referred to. */
  private computeSingleLine(): void {
    const s = this.single.p
    s.epsilonR = this.p.epsilonR
    s.width = this.p.width
    s.h = this.p.h
    s.t = 0.0
    s.hT = 1e12
    s.frequency = this.p.frequency
    this.single.staticZ0()
    this.single.dispersion()
  }

  private erEffStatic(): void {
    const er = this.p.epsilonR
    this.computeSingleLine()
    const erEffSingle = this.single.erEff0
    const uTe = this.wTe / this.p.h
    const uTo = this.wTo / this.p.h
    const g = this.p.gap / this.p.h
    const h2h = this.p.hT / this.p.h
    const th = this.p.t / this.p.h
    let q = (fillingFactorEven(uTe, g, er) - deltaQThickness(uTe, th)) * deltaQCoverEven(h2h)
    this.erEffE0 = 0.5 * (er + 1.0) + 0.5 * (er - 1.0) * q
    q = (fillingFactorOdd(uTo, g, er) - deltaQThickness(uTo, th)) * deltaQCoverOdd(h2h)
    const aO = 0.7287 * (erEffSingle - 0.5 * (er + 1.0)) * (1.0 - Math.exp(-0.179 * uTo))
    this.erEffO0 = (0.5 * (er + 1.0) + aO - erEffSingle) * q + erEffSingle
  }

  private z0EvenOdd(): void {
    const uTe = this.wTe / this.p.h
    const uTo = this.wTo / this.p.h
    const g = this.p.gap / this.p.h
    const h2h = this.p.hT / this.p.h
    const z0Single = this.single.z00
    const erEffSingle = this.single.erEff0

    let erEff = this.erEffE0
    const Q1 = 0.8695 * Math.pow(uTe, 0.194)
    const Q2 = 1.0 + 0.7519 * g + 0.189 * Math.pow(g, 2.31)
    const Q3 =
      0.1975 +
      Math.pow(16.6 + Math.pow(8.4 / g, 6.0), -0.387) +
      Math.log(Math.pow(g, 10.0) / (1.0 + Math.pow(g / 3.4, 10.0))) / 241.0
    const Q4 =
      (2.0 * Q1) /
      (Q2 * (Math.exp(-g) * Math.pow(uTe, Q3) + (2.0 - Math.exp(-g)) * Math.pow(uTe, -Q3)))
    this.z0E0 =
      (z0Single * Math.sqrt(erEffSingle / erEff)) /
      (1.0 - (Math.sqrt(erEffSingle) * Q4 * z0Single) / ZF0)
    this.z0E0 = this.z0E0 - deltaZ0EvenCover(g, uTe, h2h) / Math.sqrt(erEff)

    erEff = this.erEffO0
    const Q5 = 1.794 + 1.14 * Math.log(1.0 + 0.638 / (g + 0.517 * Math.pow(g, 2.43)))
    const Q6 =
      0.2305 +
      Math.log(Math.pow(g, 10.0) / (1.0 + Math.pow(g / 5.8, 10.0))) / 281.3 +
      Math.log(1.0 + 0.598 * Math.pow(g, 1.154)) / 5.1
    const Q7 = (10.0 + 190.0 * g * g) / (1.0 + 82.3 * g * g * g)
    const Q8 = Math.exp(-6.5 - 0.95 * Math.log(g) - Math.pow(g / 0.15, 5.0))
    const Q9 = Math.log(Q7) * (Q8 + 1.0 / 16.5)
    const Q10 = (Q2 * Q4 - Q5 * Math.exp(Math.log(uTo) * Q6 * Math.pow(uTo, -Q9))) / Q2
    this.z0O0 =
      (z0Single * Math.sqrt(erEffSingle / erEff)) /
      (1.0 - (Math.sqrt(erEffSingle) * Q10 * z0Single) / ZF0)
    this.z0O0 = this.z0O0 - deltaZ0OddCover(g, uTo, h2h) / Math.sqrt(erEff)
  }

  private erEffFreq(): void {
    const er = this.p.epsilonR
    const u = this.p.width / this.p.h
    const g = this.p.gap / this.p.h
    // Normalized frequency, GHz × mm.
    const fn = (this.p.frequency * this.p.h) / 1e6
    const P1 =
      0.27488 +
      (0.6315 + 0.525 / Math.pow(1.0 + 0.0157 * fn, 20.0)) * u -
      0.065683 * Math.exp(-8.7513 * u)
    const P2 = 0.33622 * (1.0 - Math.exp(-0.03442 * er))
    const P3 = 0.0363 * Math.exp(-4.6 * u) * (1.0 - Math.exp(-Math.pow(fn / 38.7, 4.97)))
    const P4 = 1.0 + 2.751 * (1.0 - Math.exp(-Math.pow(er / 15.916, 8.0)))
    const P5 = 0.334 * Math.exp(-3.3 * Math.pow(er / 15.0, 3.0)) + 0.746
    const P6 = P5 * Math.exp(-Math.pow(fn / 18.0, 0.368))
    const P7 =
      1.0 +
      4.069 *
        P6 *
        Math.pow(g, 0.479) *
        Math.exp(-1.347 * Math.pow(g, 0.595) - 0.17 * Math.pow(g, 2.5))
    const Fe = P1 * P2 * Math.pow((P3 * P4 + 0.1844 * P7) * fn, 1.5763)
    this.erEffE = er - (er - this.erEffE0) / (1.0 + Fe)
    this.unitPropDelayEven = unitPropagationDelay(this.erEffE)

    const P8 = 0.7168 * (1.0 + 1.076 / (1.0 + 0.0576 * (er - 1.0)))
    const P9 =
      P8 -
      0.7913 *
        (1.0 - Math.exp(-Math.pow(fn / 20.0, 1.424))) *
        Math.atan(2.481 * Math.pow(er / 8.0, 0.946))
    const P10 = 0.242 * Math.pow(er - 1.0, 0.55)
    const P11 =
      0.6366 * (Math.exp(-0.3401 * fn) - 1.0) * Math.atan(1.263 * Math.pow(u / 3.0, 1.629))
    const P12 = P9 + (1.0 - P9) / (1.0 + 1.183 * Math.pow(u, 1.376))
    const P13 = (1.695 * P10) / (0.414 + 1.605 * P10)
    const P14 = 0.8928 + 0.1072 * (1.0 - Math.exp(-0.42 * Math.pow(fn / 20.0, 3.215)))
    const P15 = Math.abs(
      1.0 - (0.8928 * (1.0 + P11) * P12 * Math.exp(-P13 * Math.pow(g, 1.092))) / P14
    )
    const Fo = P1 * P2 * Math.pow((P3 * P4 + 0.1844) * fn * P15, 1.5763)
    this.erEffO = er - (er - this.erEffO0) / (1.0 + Fo)
    this.unitPropDelayOdd = unitPropagationDelay(this.erEffO)
  }

  private z0Dispersion(): void {
    const er = this.p.epsilonR
    const u = this.p.width / this.p.h
    const g = this.p.gap / this.p.h
    const fn = (this.p.frequency * this.p.h) / 1e6
    const erEffSingleF = this.single.epsilonEff
    const erEffSingle0 = this.single.erEff0
    const z0SingleF = this.single.p.z0
    const erEffOF = this.erEffO
    const erEffO0 = this.erEffO0

    const Q11 = 0.893 * (1.0 - 0.3 / (1.0 + 0.7 * (er - 1.0)))
    const Q12 =
      2.121 *
      (Math.pow(fn / 20.0, 4.91) / (1.0 + Q11 * Math.pow(fn / 20.0, 4.91))) *
      Math.exp(-2.87 * g) *
      Math.pow(g, 0.902)
    const Q13 = 1.0 + 0.038 * Math.pow(er / 8.0, 5.1)
    const Q14 = 1.0 + (1.203 * Math.pow(er / 15.0, 4.0)) / (1.0 + Math.pow(er / 15.0, 4.0))
    const Q15 =
      (1.887 * Math.exp(-1.5 * Math.pow(g, 0.84)) * Math.pow(g, Q14)) /
      (1.0 +
        (0.41 * Math.pow(fn / 15.0, 3.0) * Math.pow(u, 2.0 / Q13)) /
          (0.125 + Math.pow(u, 1.626 / Q13)))
    const Q16 = (1.0 + 9.0 / (1.0 + 0.403 * Math.pow(er - 1.0, 2))) * Q15
    const Q17 =
      0.394 *
      (1.0 - Math.exp(-1.47 * Math.pow(u / 7.0, 0.672))) *
      (1.0 - Math.exp(-4.25 * Math.pow(fn / 20.0, 1.87)))
    const Q18 =
      (0.61 * (1.0 - Math.exp(-2.13 * Math.pow(u / 8.0, 1.593)))) /
      (1.0 + 6.544 * Math.pow(g, 4.17))
    const Q19 =
      (0.21 * g * g * g * g) /
      ((1.0 + 0.18 * Math.pow(g, 4.9)) * (1.0 + 0.1 * u * u) * (1.0 + Math.pow(fn / 24.0, 3.0)))
    const Q20 = (0.09 + 1.0 / (1.0 + 0.1 * Math.pow(er - 1, 2.7))) * Q19
    const Q21 = Math.abs(
      1.0 -
        (42.54 * Math.pow(g, 0.133) * Math.exp(-0.812 * g) * Math.pow(u, 2.5)) /
          (1.0 + 0.033 * Math.pow(u, 2.5))
    )
    const rE = Math.pow(fn / 28.843, 12)
    const qE = 0.016 + Math.pow(0.0514 * er * Q21, 4.524)
    const pE = 4.766 * Math.exp(-3.228 * Math.pow(u, 0.641))
    const dE =
      5.086 *
      qE *
      (rE / (0.3838 + 0.386 * qE)) *
      (Math.exp(-22.2 * Math.pow(u, 1.92)) / (1.0 + 1.2992 * rE)) *
      (Math.pow(er - 1.0, 6.0) / (1.0 + 10 * Math.pow(er - 1.0, 6.0)))
    const Ce =
      1.0 +
      1.275 *
        (1.0 - Math.exp(-0.004625 * pE * Math.pow(er, 1.674) * Math.pow(fn / 18.365, 2.745))) -
      Q12 +
      Q16 -
      Q17 +
      Q18 +
      Q20
    const R1 = 0.03891 * Math.pow(er, 1.4)
    const R2 = 0.267 * Math.pow(u, 7.0)
    const R7 = 1.206 - 0.3144 * Math.exp(-R1) * (1.0 - Math.exp(-R2))
    const R10 = 0.00044 * Math.pow(er, 2.136) + 0.0184
    let tmpf = Math.pow(fn / 19.47, 6.0)
    const R11 = tmpf / (1.0 + 0.0962 * tmpf)
    const R12 = 1.0 / (1.0 + 0.00245 * u * u)
    const R15 = 0.707 * R10 * Math.pow(fn / 12.3, 1.097)
    const R16 = 1.0 + 0.0503 * er * er * R11 * (1.0 - Math.exp(-Math.pow(u / 15.0, 6.0)))
    const Q0 = R7 * (1.0 - 1.1241 * (R12 / R16) * Math.exp(-0.026 * Math.pow(fn, 1.15656) - R15))
    this.p.z0Even =
      (this.z0E0 * Math.pow(0.9408 * Math.pow(erEffSingleF, Ce) - 0.9603, Q0)) /
      Math.pow((0.9408 - dE) * Math.pow(erEffSingle0, Ce) - 0.9603, Q0)

    const Q29 = 15.16 / (1.0 + 0.196 * Math.pow(er - 1.0, 2.0))
    tmpf = Math.pow(er - 1.0, 3.0)
    const Q28 = (0.149 * tmpf) / (94.5 + 0.038 * tmpf)
    tmpf = Math.pow(er - 1.0, 1.5)
    const Q27 = 0.4 * Math.pow(g, 0.84) * (1.0 + (2.5 * tmpf) / (5.0 + tmpf))
    tmpf = Math.pow((er - 1.0) / 13.0, 12.0)
    const Q26 = 30.0 - 22.2 * (tmpf / (1.0 + 3.0 * tmpf)) - Q29
    tmpf = (er - 1.0) * (er - 1.0)
    const Q25 = ((0.3 * fn * fn) / (10.0 + fn * fn)) * (1.0 + (2.333 * tmpf) / (5.0 + tmpf))
    const Q24 =
      (2.506 * Q28 * Math.pow(u, 0.894) * Math.pow(((1.0 + 1.3 * u) * fn) / 99.25, 4.29)) /
      (3.575 + Math.pow(u, 0.894))
    const Q23 =
      1.0 + (0.005 * fn * Q27) / ((1.0 + 0.812 * Math.pow(fn / 15.0, 1.9)) * (1.0 + 0.025 * u * u))
    const Q22 = (0.925 * Math.pow(fn / Q26, 1.536)) / (1.0 + 0.3 * Math.pow(fn / 30.0, 1.536))
    this.p.z0Odd =
      z0SingleF +
      (this.z0O0 * Math.pow(erEffOF / erEffO0, Q22) - z0SingleF * Q23) /
        (1.0 + Q24 + Math.pow(0.46 * g, 2.2) * Q25)
  }
}

function deltaUThicknessSingle(u: number, th: number): number {
  if (!(th > 0.0)) return 0.0
  return (
    ((1.25 * th) / Math.PI) *
    (1.0 +
      Math.log(
        (2.0 + (4.0 * Math.PI * u - 2.0) / (1.0 + Math.exp(-100.0 * (u - 1.0 / (2.0 * Math.PI))))) /
          th
      ))
  )
}

function fillingFactorEven(u: number, g: number, er: number): number {
  const v = (u * (20.0 + g * g)) / (10.0 + g * g) + g * Math.exp(-g)
  const v3 = v * v * v
  const v4 = v3 * v
  const aE =
    1.0 +
    Math.log((v4 + (v * v) / 2704.0) / (v4 + 0.432)) / 49.0 +
    Math.log(1.0 + v3 / 5929.741) / 18.7
  const bE = 0.564 * Math.pow((er - 0.9) / (er + 3.0), 0.053)
  return Math.pow(1.0 + 10.0 / v, -aE * bE)
}

function fillingFactorOdd(u: number, g: number, er: number): number {
  const bOdd = (0.747 * er) / (0.15 + er)
  const cOdd = bOdd - (bOdd - 0.207) * Math.exp(-0.414 * u)
  const dOdd = 0.593 + 0.694 * Math.exp(-0.562 * u)
  return Math.exp(-cOdd * Math.pow(g, dOdd))
}

const deltaQCoverEven = (h2h: number): number =>
  h2h <= 39 ? Math.tanh(1.626 + 0.107 * h2h - 1.733 / Math.sqrt(h2h)) : 1.0

const deltaQCoverOdd = (h2h: number): number =>
  h2h <= 7 ? Math.tanh(9.575 / (7.0 - h2h) - 2.965 + 1.68 * h2h - 0.311 * h2h * h2h) : 1.0

function deltaZ0EvenCover(g: number, u: number, h2h: number): number {
  const A = -4.351 / Math.pow(1.0 + h2h, 1.842)
  const B = 6.639 / Math.pow(1.0 + h2h, 1.861)
  const C = -2.291 / Math.pow(1.0 + h2h, 1.9)
  const fE = 1.0 - Math.atanh(A + (B + C * u) * u)
  const x = Math.pow(10.0, 0.103 * g - 0.159)
  const y = Math.pow(10.0, 0.0492 * g - 0.073)
  const D = 0.747 / Math.sin(0.5 * Math.PI * x)
  const E = 0.725 * Math.sin(0.5 * Math.PI * y)
  const F = Math.pow(10.0, 0.11 - 0.0947 * g)
  const gE = 270.0 * (1.0 - Math.tanh(D + E * Math.sqrt(1.0 + h2h) - F / (1.0 + h2h)))
  return fE * gE
}

function deltaZ0OddCover(g: number, u: number, h2h: number): number {
  const J = Math.tanh(Math.pow(1.0 + h2h, 1.585) / 6.0)
  const fO = Math.pow(u, J)
  const G = 2.178 - 0.796 * g
  const K = g > 0.858 ? Math.log10(20.492 * Math.pow(g, 0.174)) : 1.3
  const L = g > 0.873 ? 2.51 * Math.pow(g, -0.462) : 2.674
  const gO = 270.0 * (1.0 - Math.tanh(G + K * Math.sqrt(1.0 + h2h) - L / (1.0 + h2h)))
  return fO * gO
}
