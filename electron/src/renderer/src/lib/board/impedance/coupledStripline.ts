// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * An edge-coupled stripline pair as KiCad 10.0.6 computes it
 * (`common/transline_calculations/coupled_stripline.cpp`): Cohn's
 * zero-thickness even- and odd-mode impedances, corrected for strip thickness
 * by fringing capacitances against a symmetric single stripline. The planes sit
 * symmetrically about the strips whatever the stackup says, as in KiCad; the
 * medium is homogeneous, so both modes share the dielectric's delay. Only the
 * one-dimensional syntheses KiCad's tuning-profile page uses are ported. Meters.
 */
import { Stripline } from './stripline'
import {
  coth,
  E0,
  ellipticIntegral,
  minimiseZ0Error1D,
  sech,
  unitPropagationDelay,
  ZF0,
  type Transline
} from './translineMath'

export type CoupledStriplineParam = 'epsilonR' | 'h' | 't' | 'width' | 'gap' | 'z0Even' | 'z0Odd'

export class CoupledStripline implements Transline<CoupledStriplineParam> {
  p: Record<CoupledStriplineParam, number> = {
    epsilonR: 0,
    h: 0,
    t: 0,
    width: 0,
    gap: 0,
    z0Even: 0,
    z0Odd: 0
  }
  /** Picoseconds per centimeter; the same in both modes. */
  unitPropDelayOdd = 0
  private single = new Stripline()
  private cfT = 0
  private cf0 = 0
  private z0W0 = 0
  private z0WT = 0
  private z0E0 = 0
  private z0O0 = 0

  analyse(): void {
    const { width: w, t, gap: s, h, epsilonR: er } = this.p
    this.zeroThicknessCoupled(h, w, s, er)
    if (t === 0.0) {
      this.p.z0Even = this.z0E0
      this.p.z0Odd = this.z0O0
    } else {
      this.singleStrip()
      this.fringeCapacitances(h, t, er)
      this.p.z0Even =
        1.0 / (1.0 / this.z0WT - (this.cfT / this.cf0) * (1.0 / this.z0W0 - 1.0 / this.z0E0))
      this.z0Odd(t, s)
    }
    this.unitPropDelayOdd = unitPropagationDelay(er)
  }

  synthesizeWidth(): boolean {
    return minimiseZ0Error1D(this, 'width', 'z0Odd')
  }

  synthesizeGap(): boolean {
    return minimiseZ0Error1D(this, 'gap', 'z0Odd')
  }

  private fringeCapacitances(h: number, t: number, er: number): void {
    this.cfT =
      ((E0 * er) / Math.PI) *
      ((2.0 / (1.0 - t / h)) * Math.log(1.0 / (1.0 - t / h) + 1.0) -
        (1.0 / (1.0 - t / h) - 1.0) * Math.log(1.0 / Math.pow(1.0 - t / h, 2.0) - 1.0))
    this.cf0 = ((E0 * er) / Math.PI) * 2.0 * Math.log(2.0)
  }

  private zeroThicknessCoupled(h: number, w: number, s: number, er: number): void {
    const kE = Math.tanh((Math.PI * w) / (2.0 * h)) * Math.tanh((Math.PI * (w + s)) / (2.0 * h))
    const kO = Math.tanh((Math.PI * w) / (2.0 * h)) * coth((Math.PI * (w + s)) / (2.0 * h))
    const kEp = Math.sqrt(1 - Math.pow(kE, 2))
    const kOp = Math.sqrt(1 - Math.pow(kO, 2))
    const scale = ZF0 / (4.0 * Math.sqrt(er))
    this.z0E0 = scale * (ellipticIntegral(kEp).k / ellipticIntegral(kE).k)
    this.z0O0 = scale * (ellipticIntegral(kOp).k / ellipticIntegral(kO).k)
  }

  private singleStrip(): void {
    const { epsilonR: er, h, width: w, t } = this.p
    const s = this.single.p
    s.epsilonR = er
    s.t = t
    s.a = h / 2.0
    s.h = h
    s.width = w
    this.single.analyse()
    this.z0WT = s.z0
    const k = sech((Math.PI * w) / (2.0 * h))
    const kp = Math.tanh((Math.PI * w) / (2.0 * h))
    this.z0W0 = (ZF0 / (4.0 * Math.sqrt(er))) * (ellipticIntegral(k).k / ellipticIntegral(kp).k)
  }

  private z0Odd(t: number, s: number): void {
    const zO1 =
      1.0 / (1.0 / this.z0WT + (this.cfT / this.cf0) * (1.0 / this.z0O0 - 1.0 / this.z0W0))
    const zO2 =
      1.0 /
      (1.0 / this.z0O0 +
        (1.0 / this.z0WT - 1.0 / this.z0W0) -
        (2.0 / ZF0) * (this.cfT / E0 - this.cf0 / E0) +
        (2.0 * t) / (ZF0 * s))
    this.p.z0Odd = s / t >= 5.0 ? zO1 : zO2
  }
}
