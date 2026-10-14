// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A single microstrip's impedance and delay as KiCad 10.0.6 computes them
 * (`common/transline_calculations/microstrip.cpp`): Hammerstad and Jensen's
 * static impedance with thickness and cover corrections, then Kirschning and
 * Jansen's dispersion. Only what reaches Z0 and the propagation delay is
 * ported; KiCad's losses and electrical length change neither. Meters.
 */
import { minimiseZ0Error1D, unitPropagationDelay, ZF0, type Transline } from './translineMath'

export type MicrostripParam = 'epsilonR' | 'h' | 'hT' | 't' | 'width' | 'z0' | 'frequency'

export class Microstrip implements Transline<MicrostripParam> {
  p: Record<MicrostripParam, number> = {
    epsilonR: 0,
    h: 0,
    hT: 0,
    t: 0,
    width: 0,
    z0: 0,
    frequency: 0
  }
  epsilonEff = 0
  /** Picoseconds per centimeter. */
  unitPropDelay = 0
  /** The static effective permittivity and impedance, before dispersion. */
  erEff0 = 0
  z00 = 0
  private z0h1 = 0

  analyse(): void {
    this.staticZ0()
    this.dispersion()
  }

  /** KiCad's `Synthesize`: Wheeler's width as the first guess, then Newton on the width. */
  synthesize(): boolean {
    const target = this.p.z0
    this.p.width = this.synthesizeWidth()
    if (!minimiseZ0Error1D(this, 'width', 'z0')) return false
    this.analyse()
    this.p.z0 = target
    return true
  }

  private synthesizeWidth(): number {
    const er = this.p.epsilonR
    const a =
      (this.p.z0 / ZF0 / 2 / Math.PI) * Math.sqrt((er + 1) / 2) +
      ((er - 1) / (er + 1)) * (0.23 + 0.11 / er)
    const b = ((ZF0 / 2) * Math.PI) / (this.p.z0 * Math.sqrt(er))
    const wh =
      a > 1.52
        ? (8 * Math.exp(a)) / (Math.exp(2 * a) - 2)
        : (2 / Math.PI) *
          (b -
            1 -
            Math.log(2 * b - 1) +
            ((er - 1) / (2 * er)) * (Math.log(b - 1) + 0.39 - 0.61 / er))
    return this.p.h > 0.0 ? wh * this.p.h : 0
  }

  /** Static impedance and permittivity, corrected for thickness, cover and the mixed medium. */
  staticZ0(): void {
    const er = this.p.epsilonR
    const h2h = this.p.hT / this.p.h
    let u = this.p.width / this.p.h
    const th = this.p.t / this.p.h
    const du1 = deltaUThickness(u, th, 1.0)
    this.z0h1 = z0Homogeneous(u + du1)
    u += deltaUThickness(u, th, er)
    const z0hr = z0Homogeneous(u)
    const qInf = fillingFactor(u, er)
    const qc = deltaQCover(h2h)
    const qt = deltaQThickness(u, th)
    const q = (qInf - qt) * qc
    const erEffT = 0.5 * (er + 1.0) + 0.5 * q * (er - 1.0)
    this.erEff0 = erEffT * Math.pow(this.z0h1 / z0hr, 2.0)
    this.p.z0 = z0hr / Math.sqrt(erEffT)
    this.z00 = this.p.z0
  }

  dispersion(): void {
    const er = this.p.epsilonR
    const u = this.p.width / this.p.h
    // Normalized frequency, GHz × mm.
    const fn = (this.p.frequency * this.p.h) / 1e6
    const P = erDispersion(u, er, fn)
    const erEffF = er - (er - this.erEff0) / (1.0 + P)
    const D = z0Dispersion(u, er, this.erEff0, erEffF, fn)
    this.unitPropDelay = unitPropagationDelay(erEffF)
    this.epsilonEff = erEffF
    this.p.z0 = this.z00 * D
  }
}

function z0Dispersion(u: number, er: number, erEff0: number, erEffF: number, fn: number): number {
  const R1 = 0.03891 * Math.pow(er, 1.4)
  const R2 = 0.267 * Math.pow(u, 7.0)
  const R3 = 4.766 * Math.exp(-3.228 * Math.pow(u, 0.641))
  const R4 = 0.016 + Math.pow(0.0514 * er, 4.524)
  const R5 = Math.pow(fn / 28.843, 12.0)
  const R6 = 22.2 * Math.pow(u, 1.92)
  const R7 = 1.206 - 0.3144 * Math.exp(-R1) * (1.0 - Math.exp(-R2))
  const R8 =
    1.0 +
    1.275 * (1.0 - Math.exp(-0.004625 * R3 * Math.pow(er, 1.674) * Math.pow(fn / 18.365, 2.745)))
  let tmpf = Math.pow(er - 1.0, 6.0)
  const R9 =
    5.086 *
    R4 *
    (R5 / (0.3838 + 0.386 * R4)) *
    (Math.exp(-R6) / (1.0 + 1.2992 * R5)) *
    (tmpf / (1.0 + 10.0 * tmpf))
  const R10 = 0.00044 * Math.pow(er, 2.136) + 0.0184
  tmpf = Math.pow(fn / 19.47, 6.0)
  const R11 = tmpf / (1.0 + 0.0962 * tmpf)
  const R12 = 1.0 / (1.0 + 0.00245 * u * u)
  const R13 = 0.9408 * Math.pow(erEffF, R8) - 0.9603
  const R14 = (0.9408 - R9) * Math.pow(erEff0, R8) - 0.9603
  const R15 = 0.707 * R10 * Math.pow(fn / 12.3, 1.097)
  const R16 = 1.0 + 0.0503 * er * er * R11 * (1.0 - Math.exp(-Math.pow(u / 15.0, 6.0)))
  const R17 = R7 * (1.0 - 1.1241 * (R12 / R16) * Math.exp(-0.026 * Math.pow(fn, 1.15656) - R15))
  return Math.pow(R13 / R14, R17)
}

function z0Homogeneous(u: number): number {
  const freq = 6.0 + (2.0 * Math.PI - 6.0) * Math.exp(-Math.pow(30.666 / u, 0.7528))
  return (ZF0 / (2.0 * Math.PI)) * Math.log(freq / u + Math.sqrt(1.0 + 4.0 / (u * u)))
}

function fillingFactor(u: number, er: number): number {
  const u2 = u * u
  const u3 = u2 * u
  const u4 = u3 * u
  const a =
    1.0 + Math.log((u4 + u2 / 2704) / (u4 + 0.432)) / 49.0 + Math.log(1.0 + u3 / 5929.741) / 18.7
  const b = 0.564 * Math.pow((er - 0.9) / (er + 3.0), 0.053)
  return Math.pow(1.0 + 10.0 / u, -a * b)
}

const deltaQCover = (h2h: number): number => Math.tanh(1.043 + 0.121 * h2h - 1.164 / h2h)

/** The thickness effect on the filling factor; the coupled model reuses it. */
export const deltaQThickness = (u: number, th: number): number =>
  ((2.0 * Math.log(2.0)) / Math.PI) * (th / Math.sqrt(u))

function deltaUThickness(u: number, th: number, er: number): number {
  if (!(th > 0.0)) return 0.0
  // Thickness correction for a homogeneous microstrip, then for a strip on a substrate of er.
  const du =
    (th / Math.PI) *
    Math.log(1.0 + (4.0 * Math.E * Math.pow(Math.tanh(Math.sqrt(6.517 * u)), 2.0)) / th)
  return 0.5 * du * (1.0 + 1.0 / Math.cosh(Math.sqrt(er - 1.0)))
}

function erDispersion(u: number, er: number, fn: number): number {
  const P1 =
    0.27488 +
    u * (0.6315 + 0.525 / Math.pow(1.0 + 0.0157 * fn, 20.0)) -
    0.065683 * Math.exp(-8.7513 * u)
  const P2 = 0.33622 * (1.0 - Math.exp(-0.03442 * er))
  const P3 = 0.0363 * Math.exp(-4.6 * u) * (1.0 - Math.exp(-Math.pow(fn / 38.7, 4.97)))
  const P4 = 1.0 + 2.751 * (1.0 - Math.exp(-Math.pow(er / 15.916, 8.0)))
  return P1 * P2 * Math.pow((P3 * P4 + 0.1844) * fn, 1.5763)
}
