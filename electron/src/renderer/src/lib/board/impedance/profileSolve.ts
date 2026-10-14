// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * One row of a tuning profile solved as KiCad 10.0.6's Tuning Profiles page
 * solves it (`pcbnew/dialogs/panel_setup_tuning_profile_info.cpp`): the cell
 * edited decides what is solved (the width, a pair's gap, or the delay of what
 * is given), F.Cu and B.Cu are microstrip over their one reference and every
 * inner layer stripline between two, and the dielectric between a layer and its
 * reference is the thickness-weighted mean of the layers there (KiCad's comment
 * calls it geometric; the arithmetic is arithmetic). The solver runs at 1 GHz,
 * a pair's target is split as KiCad splits it (each mode half the pair's), and
 * results land in KiCad's integer units: widths in nanometers, truncated, and
 * the delay in attoseconds per millimeter. A failure is one of KiCad's own
 * refusals, by code.
 */
import { CoupledMicrostrip } from './coupledMicrostrip'
import { CoupledStripline } from './coupledStripline'
import { Microstrip } from './microstrip'
import type { SolverStackup } from './stackupInput'
import { Stripline } from './stripline'

export type SolveFor = 'width' | 'gap' | 'delay'

export type ProfileSolveError =
  | 'target-not-positive'
  | 'signal-layer-missing'
  | 'zero-signal-thickness'
  | 'reference-missing'
  | 'reference-same-as-signal'
  | 'top-reference-missing'
  | 'top-reference-not-above'
  | 'bottom-reference-missing'
  | 'bottom-reference-not-below'
  | 'zero-dielectric'
  | 'gap-required'
  | 'width-required'
  | 'width-and-gap-required'
  /** A single-ended profile has no gap to solve; KiCad's page offers none. */
  | 'gap-on-single'
  | 'width-failed'
  | 'gap-failed'
  | 'no-width'
  | 'no-gap'
  | 'no-delay'

/** Where a layer sits: its references, and the stackup around it. */
export interface LayerGeometryInput {
  stackup: SolverStackup
  signalLayer: string
  /** The plane above; an inner layer's, or B.Cu's one reference. */
  topReference?: string
  /** The plane below; an inner layer's, or F.Cu's one reference. */
  bottomReference?: string
  differential: boolean
}

export interface ProfileLayerInput extends LayerGeometryInput {
  targetOhms: number
  solveFor: SolveFor
  /** What is held: the width for a gap or a delay, the gap for a pair's width or delay. */
  widthMm?: number
  gapMm?: number
}

export type ProfileSolveResult =
  | { ok: true; widthMm: number; gapMm?: number; delay: number }
  | { ok: false; error: ProfileSolveError }

export interface AnalyseLayerInput extends LayerGeometryInput {
  widthMm: number
  gapMm?: number
}

export type AnalyseLayerResult =
  { ok: true; ohms: number; delay: number } | { ok: false; error: ProfileSolveError }

/** The dielectric and copper a layer's model is fed, meters. */
export interface BoardParameters {
  epsilonR: number
  /** To the reference above (microstrip: to its one reference). */
  topHeightM: number
  bottomHeightM: number
  signalThicknessM: number
  lossTangent: number
}

/** A refusal, typed to fit any of this module's results. */
const fail = (error: ProfileSolveError): { ok: false; error: ProfileSolveError } => ({
  ok: false,
  error
})

const FREQUENCY = 1000000000.0
/** KiCad's "infinitely" far cover over a microstrip. */
const NO_COVER = 1e20

export const isMicrostripLayer = (layer: string): boolean => layer === 'F.Cu' || layer === 'B.Cu'

/** A double to an int as C++'s cast does on the platforms KiCad ships: out of range is INT_MIN. */
const toInt = (value: number): number =>
  Number.isFinite(value) && Math.abs(value) < 2147483648 ? Math.trunc(value) : -2147483648

/** Meters to KiCad's nanometers, as `FromUserUnit(MM)` and the cast write them. */
const toNm = (m: number): number => toInt(m * 1000.0 * 1e6)

/** Picoseconds per centimeter to attoseconds per millimeter. */
const toDelay = (psPerCm: number): number => toInt((psPerCm / 10) * 1e6)

/** A grid value: millimeters held as whole nanometers, then meters. */
const gridMeters = (mm: number | undefined): number => Math.round((mm ?? 0) * 1e6) / 1e6 / 1000.0
const gridNm = (mm: number | undefined): number => Math.round((mm ?? 0) * 1e6)

function dielectricBetween(
  stackup: SolverStackup,
  a: number,
  b: number
): { heightM: number; epsilonR: number; lossTangent: number } {
  let total = 0
  let er = 0
  let lt = 0
  for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) {
    const layer = stackup[i]
    if (layer.kind !== 'dielectric') continue
    total += layer.thicknessMm
    er += layer.epsilonR * layer.thicknessMm
    lt += layer.lossTangent * layer.thicknessMm
  }
  return { heightM: total / 1000.0, epsilonR: er / total, lossTangent: lt / total }
}

const indexOf = (stackup: SolverStackup, name: string | undefined): number =>
  name ? stackup.findIndex((l) => l.kind === 'copper' && l.name === name) : -1

/**
 * The model's inputs for a layer, or KiCad's refusal: a microstrip's one
 * reference (F.Cu's is below it, B.Cu's above), a stripline's two, each on
 * its own side.
 */
export function boardParameters(
  input: LayerGeometryInput
): { ok: true; params: BoardParameters } | { ok: false; error: ProfileSolveError } {
  const { stackup, signalLayer } = input
  const signal = indexOf(stackup, signalLayer)
  if (signal < 0) return fail('signal-layer-missing')
  const t = stackup[signal].thicknessMm / 1000.0
  if (!(t > 0)) return fail('zero-signal-thickness')
  if (isMicrostripLayer(signalLayer)) {
    const reference = indexOf(
      stackup,
      signalLayer === 'F.Cu' ? input.bottomReference : input.topReference
    )
    if (reference < 0) return fail('reference-missing')
    if (reference === signal) return fail('reference-same-as-signal')
    const d = dielectricBetween(stackup, signal, reference)
    if (!(d.heightM > 0.0)) return fail('zero-dielectric')
    return {
      ok: true,
      params: {
        epsilonR: d.epsilonR,
        topHeightM: d.heightM,
        bottomHeightM: 0.0,
        signalThicknessM: t,
        lossTangent: d.lossTangent
      }
    }
  }
  const top = indexOf(stackup, input.topReference)
  if (top < 0) return fail('top-reference-missing')
  if (!(signal > top)) return fail('top-reference-not-above')
  const bottom = indexOf(stackup, input.bottomReference)
  if (bottom < 0) return fail('bottom-reference-missing')
  if (!(bottom > signal)) return fail('bottom-reference-not-below')
  const above = dielectricBetween(stackup, signal, top)
  const below = dielectricBetween(stackup, signal, bottom)
  if (above.heightM <= 0.0 && below.heightM <= 0.0) return fail('zero-dielectric')
  // The mean over both sides, summed as KiCad sums it: the layers above, then below.
  const all = [...stackup.slice(top + 1, signal), ...stackup.slice(signal + 1, bottom)].filter(
    (l) => l.kind === 'dielectric'
  )
  let total = 0
  let er = 0
  let lt = 0
  for (const layer of all) {
    total += layer.thicknessMm
    er += layer.epsilonR * layer.thicknessMm
    lt += layer.lossTangent * layer.thicknessMm
  }
  return {
    ok: true,
    params: {
      epsilonR: er / total,
      topHeightM: above.heightM,
      bottomHeightM: below.heightM,
      signalThicknessM: t,
      lossTangent: lt / total
    }
  }
}

interface Raw {
  widthM: number
  widthOk: boolean
  gapM: number
  gapOk: boolean
  psPerCm: number
  ohms: number
}

const finitePositive = (v: number): boolean => Number.isFinite(v) && v > 0

function runSingle(
  params: BoardParameters,
  microstrip: boolean,
  solve: boolean,
  targetOhms: number,
  widthM: number
): Raw {
  if (microstrip) {
    const line = new Microstrip()
    line.p.width = solve ? 0.001 : widthM
    line.p.epsilonR = params.epsilonR
    line.p.hT = NO_COVER
    line.p.h = params.topHeightM
    line.p.t = params.signalThicknessM
    line.p.z0 = targetOhms
    line.p.frequency = FREQUENCY
    if (solve) line.synthesize()
    else line.analyse()
    const w = line.p.width
    return {
      widthM: w,
      widthOk: finitePositive(w),
      gapM: 0,
      gapOk: true,
      psPerCm: line.unitPropDelay,
      ohms: line.p.z0
    }
  }
  const line = new Stripline()
  line.p.width = solve ? 0.001 : widthM
  line.p.epsilonR = params.epsilonR
  line.p.t = params.signalThicknessM
  line.p.a = params.topHeightM
  line.p.h = params.topHeightM + params.signalThicknessM + params.bottomHeightM
  line.p.z0 = targetOhms
  if (solve) line.synthesize()
  else line.analyse()
  const w = line.p.width
  return {
    widthM: w,
    // KiCad fails a synthesized width whose strip reaches the far plane; an analysis it lets through.
    widthOk: finitePositive(w) && (!solve || line.geometryValid),
    gapM: 0,
    gapOk: true,
    psPerCm: line.unitPropDelay,
    ohms: line.p.z0
  }
}

function runPair(
  params: BoardParameters,
  microstrip: boolean,
  solveFor: SolveFor,
  targetOhms: number,
  widthM: number,
  gapM: number
): Raw {
  const line = microstrip ? new CoupledMicrostrip() : new CoupledStripline()
  line.p.z0Even = targetOhms / 2.0
  line.p.z0Odd = targetOhms / 2.0
  line.p.width = widthM
  line.p.gap = gapM
  line.p.epsilonR = params.epsilonR
  line.p.t = params.signalThicknessM
  if (line instanceof CoupledMicrostrip) {
    line.p.h = params.topHeightM
    line.p.hT = NO_COVER
    line.p.frequency = FREQUENCY
  } else {
    line.p.h = params.topHeightM + params.signalThicknessM + params.bottomHeightM
  }
  if (solveFor === 'width') line.synthesizeWidth()
  else if (solveFor === 'gap') line.synthesizeGap()
  else line.analyse()
  return {
    widthM: line.p.width,
    widthOk: finitePositive(line.p.width),
    gapM: line.p.gap,
    gapOk: finitePositive(line.p.gap),
    psPerCm: line.unitPropDelayOdd,
    ohms: 2 * line.p.z0Odd
  }
}

function run(
  input: LayerGeometryInput & { widthMm?: number; gapMm?: number },
  solveFor: SolveFor,
  targetOhms: number
): { ok: true; raw: Raw } | { ok: false; error: ProfileSolveError } {
  const board = boardParameters(input)
  if (!board.ok) return board
  const microstrip = isMicrostripLayer(input.signalLayer)
  if (!input.differential) {
    if (solveFor === 'gap') return fail('gap-on-single')
    return {
      ok: true,
      raw: runSingle(
        board.params,
        microstrip,
        solveFor === 'width',
        targetOhms,
        gridMeters(input.widthMm)
      )
    }
  }
  const widthNm = gridNm(input.widthMm)
  const gapNm = gridNm(input.gapMm)
  if (solveFor === 'width' && !(gapNm > 0)) return fail('gap-required')
  if (solveFor === 'gap' && !(widthNm > 0)) return fail('width-required')
  if (solveFor === 'delay' && !(widthNm > 0 && gapNm > 0)) return fail('width-and-gap-required')
  const widthM = solveFor === 'width' ? 0.0 : gridMeters(input.widthMm)
  const gapM = solveFor === 'gap' ? 0.0 : gridMeters(input.gapMm)
  return { ok: true, raw: runPair(board.params, microstrip, solveFor, targetOhms, widthM, gapM) }
}

/** Solve one profile row for the cell edited, as KiCad's page fills its grid. */
export function solveProfileLayer(input: ProfileLayerInput): ProfileSolveResult {
  if (!(input.targetOhms > 0)) return fail('target-not-positive')
  const out = run(input, input.solveFor, input.targetOhms)
  if (!out.ok) return out
  const { raw } = out
  if (!raw.widthOk) return fail('width-failed')
  if (!raw.gapOk) return fail('gap-failed')
  const widthNm = toNm(raw.widthM)
  const delay = toDelay(raw.psPerCm)
  if (!(widthNm > 0)) return fail('no-width')
  if (!input.differential) {
    if (!(delay > 0)) return fail('no-delay')
    return { ok: true, widthMm: widthNm / 1e6, delay }
  }
  const gapNm = toNm(raw.gapM)
  if (!(gapNm > 0)) return fail('no-gap')
  if (!(delay > 0)) return fail('no-delay')
  return { ok: true, widthMm: widthNm / 1e6, gapMm: gapNm / 1e6, delay }
}

/**
 * The impedance and delay of a width (and a pair's gap) on a layer: KiCad's
 * delay cell, with the impedance the model reports. A pair's is twice its odd
 * mode, the quantity a solve holds to the target.
 */
export function analyseLayer(input: AnalyseLayerInput): AnalyseLayerResult {
  const out = run(input, 'delay', 0)
  if (!out.ok) return out
  const { raw } = out
  if (!raw.widthOk) return fail('width-failed')
  if (!raw.gapOk) return fail('gap-failed')
  const delay = toDelay(raw.psPerCm)
  if (!(delay > 0)) return fail('no-delay')
  return { ok: true, ohms: raw.ohms, delay }
}
