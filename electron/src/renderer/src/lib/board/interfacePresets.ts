/**
 * Interface presets: an interface's layout budget (its impedance, its skew,
 * coupling and via limits) turned into plain KiCad for one net class: a tuning
 * profile solved over the board's stackup, the class naming it, the patterns
 * that put nets in it, and the class's custom rules (`rules/druRules.ts`).
 *
 * Deterministic on purpose: the preset never looks for its nets. The caller
 * names them with KiCad's net class patterns (`/USB_D*`), and the plan says
 * exactly what they match; a differential preset refuses nets that KiCad would
 * not pair (`matchDiffPair`), naming them, rather than guessing a pair. The
 * same request on the same board always plans the same files. Which nets are
 * USB is the human's or the agent's call, made before this runs.
 *
 * Every number comes from the preset's data with its source attached
 * (`interfacePresetData.ts`), and the one input the preset cannot know, the
 * pair's gap (or a coplanar line's gap to its ground), defaults to the board's
 * minimum clearance and may be given.
 */

import type {
  NetClass,
  NetClassAssignment,
  NetClassPattern,
  TuningProfile,
  TuningProfileLayer
} from '../kicad/project'
import { DEFAULT_CLASS_NAME, matchesNetPattern, netClassForNet } from '../kicad/project'
import { matchDiffPair } from './rules/diffPairs'
import { druRuleText, type DruRule } from './rules/druRules'
import { addNetClass, editNetClass } from './boardSetupSchema'
import { AS_PER_PS } from './tuningProfiles'
import {
  analyseLayer,
  boardParameters,
  solveCoplanar,
  solveProfileLayer,
  type SolverStackup
} from './impedance'
import {
  INTERFACE_PRESETS,
  type InterfacePreset,
  type PresetMode,
  type PresetRule,
  type PresetRuleKind,
  type PresetSource
} from './interfacePresetData'

/** A rule's name after its class: short, as a DRC finding prints it. */
const RULE_NAMES: Readonly<Record<PresetRuleKind, string>> = {
  skewWithinPairs: 'skew within pairs',
  skewAcrossClass: 'skew across class',
  uncoupled: 'uncoupled length',
  viaCount: 'via count',
  length: 'length'
}

/** Every rule name a preset may write for a class: what applying again replaces. */
export const presetRuleNames = (className: string): string[] =>
  Object.values(RULE_NAMES).map((name) => `${className} ${name}`)

/** What a solve answers for one layer: its geometry and unit delay, or KiCad's reason it cannot. */
export type LayerSolution =
  | { ok: true; width: number; gap?: number; delay: number; ohms: number }
  | { ok: false; error: string }

/**
 * Solve one signal layer for a target: the width (a pair's, at the given gap),
 * referenced to the planes named. `coplanar` solves a grounded coplanar line
 * whose ground is `gap` away instead. Given a `width`, the gap is solved for it
 * (`gap` then only where the search starts).
 */
export type LayerSolver = (input: {
  frequencyHz?: number
  layer: string
  topReference: string
  bottomReference: string
  differential: boolean
  coplanar: boolean
  ohms: number
  gap: number
  width?: number
}) => LayerSolution

export interface PresetRequest {
  preset: string
  /** The preset's mode (USB's `high` or `full`); its default when omitted. */
  mode?: string
  /** The class the nets take: made from Default when new, its sizes and profile set when not. */
  netClass: string
  /**
   * KiCad net class patterns to add to the class, each once: how an agent gives
   * a new class its nets in the same call. None: the class's nets as they are.
   */
  patterns?: readonly string[]
  /** A pair's gap, or a coplanar line's gap to its ground, mm; derived when omitted (`derivedGap`). */
  gap?: number
  /** The first solved layer's width, mm: the gap is solved for it instead. Wins over `gap`. */
  width?: number
  /** The signal layers the profile solves; default the outer copper. */
  layers?: readonly string[]
}

export interface PresetContext {
  /** The board's copper top to bottom (`copperNamesFor`). */
  copperLayers: readonly string[]
  /** The board's nets by name. */
  netNames: readonly string[]
  classes: readonly NetClass[]
  patterns: readonly NetClassPattern[]
  /** The schematic's per-net classes, which also put nets in a class. */
  assignments?: readonly NetClassAssignment[]
  tuningProfiles: readonly TuningProfile[]
  /** What the fab can hold (Board Setup's Constraints), mm; 0 where the project sets none. */
  minClearance: number
  minTrackWidth: number
}

export interface PresetLayerResult {
  layer: string
  width: number
  gap?: number
  ohms: number
  /** ps/mm */
  delay: number
}

export interface PresetPlan {
  preset: InterfacePreset
  mode: PresetMode
  /** The profile's name, the class's, and the key of its block of rules. */
  profileName: string
  /** The sources this mode's numbers come from, each once. */
  sources: PresetSource[]
  /** The project's profiles, classes and patterns whole, after the preset. */
  tuningProfiles: TuningProfile[]
  classes: NetClass[]
  patterns: NetClassPattern[]
  /** The class's block of custom rules, keyed by the class's name. */
  rules: DruRule[]
  /** What the plan found: the nets its patterns take, the pairs, each layer's solve. */
  report: {
    nets: string[]
    pairs: Array<[string, string]>
    /** False where the mode holds no impedance: no layers solved, no profile written. */
    controlled: boolean
    layers: PresetLayerResult[]
    gap: number
    /** Where the gap came from: given, the Default class's clearance, the fab's minimum, or widened until the width could be built. */
    gapSource: GapSource
    /** The top layer's width at a few other gaps, for the trade-off; `buildable` against the fab's minimums. */
    alternatives: Array<{ gap: number; width: number; buildable: boolean }>
    rules: string[]
  }
}

export type GapSource = 'given' | 'fromWidth' | 'classClearance' | 'fabClearance' | 'widened'

export type PresetFailure = {
  ok: false
  code:
    | 'unknown-preset'
    | 'unknown-mode'
    | 'no-nets'
    | 'unpaired'
    | 'bad-layer'
    | 'solve-failed'
    | 'below-fab'
  detail: string
  candidates?: string[]
}

const fail = (
  code: PresetFailure['code'],
  detail: string,
  candidates?: readonly string[]
): PresetFailure => ({
  ok: false,
  code,
  detail,
  ...(candidates?.length ? { candidates: [...candidates] } : {})
})

/** Gaps the plan shows beside its own, mm: 4, 5, 6, 8, 10 and 12 mil, a fab's usual steps. */
const ALTERNATIVE_GAPS = [0.1, 0.127, 0.15, 0.2, 0.25, 0.3]
/** How far a gap is widened at a time while its width is narrower than the fab builds, and how far at most. */
const GAP_STEP = 0.01
const GAP_MAX = 1

/**
 * The gap a pair (or a coplanar line's ground) takes when none is given: the
 * board's working clearance, the Default class's, so the halves keep the
 * spacing everything else on the board keeps; never under the fab's minimum.
 */
export function derivedGap(
  classes: readonly NetClass[],
  minClearance: number
): { gap: number; source: GapSource } {
  const working = classes.find((c) => c.name === DEFAULT_CLASS_NAME)?.clearance ?? 0
  return working >= minClearance
    ? { gap: working, source: 'classClearance' }
    : { gap: minClearance, source: 'fabClearance' }
}

/** The layers a line can run on: every copper, or the outer two for a coplanar line on the surface. */
const solvableLayers = (preset: InterfacePreset, copper: readonly string[]): string[] =>
  preset.model === 'coplanar' ? copper.filter((l) => l === 'F.Cu' || l === 'B.Cu') : [...copper]

/**
 * Each layer's references as KiCad's Add row gives them (`addProfileLayer`):
 * the neighbors in the stack, none past the surface.
 */
const referencesOf = (
  layer: string,
  copper: readonly string[]
): { topReference: string; bottomReference: string } => {
  const at = copper.indexOf(layer)
  return { topReference: copper[at - 1] ?? '', bottomReference: copper[at + 1] ?? '' }
}

/** A rule's constraint clause, KiCad's syntax, in its unit. */
const constraintText = (rule: PresetRule): string => {
  const max = `${rule.max.value}${rule.unit === 'count' ? '' : rule.unit}`
  switch (rule.kind) {
    case 'skewWithinPairs':
      return `(constraint skew (max ${max}) (within_diff_pairs))`
    case 'skewAcrossClass':
      return `(constraint skew (max ${max}))`
    case 'uncoupled':
      return `(constraint diff_pair_uncoupled (max ${max}))`
    case 'viaCount':
      return `(constraint via_count (max ${max}))`
    case 'length':
      return `(constraint length (max ${max}))`
  }
}

/** Plan a preset on one class: validated whole, written by the caller. */
export function planInterfacePreset(
  ctx: PresetContext,
  request: PresetRequest,
  solve: LayerSolver
): { ok: true; plan: PresetPlan } | PresetFailure {
  const preset = INTERFACE_PRESETS.find((p) => p.id === request.preset)
  if (!preset)
    return fail(
      'unknown-preset',
      `No interface preset is ${request.preset}.`,
      INTERFACE_PRESETS.map((p) => p.id)
    )
  const modeId = request.mode ?? preset.defaultMode
  const mode = preset.modes.find((m) => m.id === modeId)
  if (!mode)
    return fail(
      'unknown-mode',
      `${preset.id} has no mode ${modeId}.`,
      preset.modes.map((m) => m.id)
    )
  const className = request.netClass.trim()
  if (!className || className === DEFAULT_CLASS_NAME)
    return fail('no-nets', 'Name the class the nets take; Default is every unassigned net.')

  // The nets: those the given patterns name, or the class's own as Assignments
  // and the schematic make them; never looked for.
  const patterns = (request.patterns ?? []).map((p) => p.trim()).filter(Boolean)
  for (const pattern of patterns) {
    if (!ctx.netNames.some((net) => matchesNetPattern(pattern, net)))
      return fail('no-nets', `${pattern} matches no net of this board.`)
  }
  const inClass = (net: string): boolean => {
    const effective = netClassForNet(net, ctx.classes, ctx.patterns, ctx.assignments ?? [])
    return (effective.constituents ?? [effective.name]).includes(className)
  }
  const nets = ctx.netNames.filter(
    (net) => patterns.some((p) => matchesNetPattern(p, net)) || inClass(net)
  )
  // No nets yet is fine: everything written targets the class, so nets assigned
  // later take it as they arrive; only the pair check below waits for them.

  // A pair is KiCad's: a P/N or +/- suffix whose complement is among the nets.
  const pairs: Array<[string, string]> = []
  if (preset.type === 'differential') {
    const taken = new Set(nets)
    const unpaired: string[] = []
    for (const net of nets) {
      const name = matchDiffPair(net)
      if (!name || !taken.has(name.complement)) unpaired.push(net)
      else if (name.polarity === 1) pairs.push([net, name.complement])
    }
    if (unpaired.length)
      return fail(
        'unpaired',
        `KiCad pairs nets by a P/N or +/- suffix; ${unpaired.join(', ')} ${unpaired.length > 1 ? 'have' : 'has'} no partner among the nets matched. Rename them (e.g. USB_D+ / USB_D-) or narrow the patterns.`,
        unpaired
      )
  }

  type Solution = {
    ok: true
    rows: TuningProfileLayer[]
    results: PresetLayerResult[]
    gap: number
    gapSource: GapSource
    alternatives: PresetPlan['report']['alternatives']
  }
  const solveLayers = (): Solution | PresetFailure => {
    // The layers, solved for the target: the outer copper unless others are named.
    const allowed = solvableLayers(preset, ctx.copperLayers)
    const outer = allowed.filter((l) => l === 'F.Cu' || l === 'B.Cu')
    const layers = request.layers?.length ? [...request.layers] : outer
    const outside = layers.filter((l) => !allowed.includes(l))
    if (outside.length)
      return fail(
        'bad-layer',
        `${preset.name} runs on ${allowed.join(', ')}; not ${outside.join(', ')}.`,
        allowed
      )
    const hasGap = preset.type === 'differential' || preset.model === 'coplanar'
    const lineOn = (layer: string, gap: number): LayerSolution =>
      solve({
        layer,
        ...referencesOf(layer, ctx.copperLayers),
        differential: preset.type === 'differential',
        coplanar: preset.model === 'coplanar',
        ohms: mode.impedance.value,
        gap,
        ...(mode.frequencyHz ? { frequencyHz: mode.frequencyHz } : {})
      })
    const solveAll = (
      gap: number
    ): { ok: true; solved: Array<LayerSolution & { ok: true }> } | PresetFailure => {
      const solved: Array<LayerSolution & { ok: true }> = []
      for (const layer of layers) {
        const one = lineOn(layer, gap)
        if (!one.ok) return fail('solve-failed', `${layer}: ${one.error}`)
        solved.push(one)
      }
      return { ok: true, solved }
    }
    const narrowest = (solved: ReadonlyArray<{ width: number }>): number =>
      Math.min(...solved.map((s) => s.width))

    // The gap: given, or the board's working clearance; widened, when derived,
    // until every layer's width is one the fab builds.
    let gap: number
    let gapSource: GapSource
    if (hasGap && request.width !== undefined) {
      if (request.width < ctx.minTrackWidth)
        return fail(
          'below-fab',
          `A ${request.width} mm track is under the fab's minimum width, ${ctx.minTrackWidth} mm.`
        )
      const held = solve({
        layer: layers[0],
        ...referencesOf(layers[0], ctx.copperLayers),
        differential: preset.type === 'differential',
        coplanar: preset.model === 'coplanar',
        ohms: mode.impedance.value,
        gap: derivedGap(ctx.classes, ctx.minClearance).gap,
        width: request.width,
        ...(mode.frequencyHz ? { frequencyHz: mode.frequencyHz } : {})
      })
      if (!held.ok || held.gap === undefined)
        return fail('solve-failed', `${layers[0]}: ${held.ok ? 'no gap' : held.error}`)
      gap = Math.round(held.gap * 1000) / 1000
      gapSource = 'fromWidth'
      if (gap < ctx.minClearance)
        return fail(
          'below-fab',
          `A ${request.width} mm track needs a ${gap} mm gap here, under the fab's minimum clearance, ${ctx.minClearance} mm.`
        )
    } else if (request.gap !== undefined || !hasGap) {
      gap = request.gap ?? 0
      gapSource = 'given'
      if (hasGap && gap < ctx.minClearance)
        return fail(
          'below-fab',
          `A ${gap} mm gap is under the fab's minimum clearance, ${ctx.minClearance} mm.`
        )
    } else ({ gap, source: gapSource } = derivedGap(ctx.classes, ctx.minClearance))
    let planned = solveAll(gap)
    if (!planned.ok) return planned
    if (hasGap && request.gap === undefined && request.width === undefined) {
      while (narrowest(planned.solved) < ctx.minTrackWidth && gap + GAP_STEP <= GAP_MAX) {
        gap = Math.round((gap + GAP_STEP) * 1000) / 1000
        gapSource = 'widened'
        planned = solveAll(gap)
        if (!planned.ok) return planned
      }
    }
    if (narrowest(planned.solved) < ctx.minTrackWidth)
      return fail(
        'below-fab',
        `${mode.impedance.value} Ω needs a ${narrowest(planned.solved).toFixed(3)} mm track here, under the fab's minimum width, ${ctx.minTrackWidth} mm.`
      )
    const rows: TuningProfileLayer[] = []
    const results: PresetLayerResult[] = []
    planned.solved.forEach((solved, i) => {
      const layer = layers[i]
      rows.push({
        layer,
        ...referencesOf(layer, ctx.copperLayers),
        width: solved.width,
        gap: preset.type === 'differential' ? (solved.gap ?? gap) : 0,
        delay: solved.delay
      })
      results.push({
        layer,
        width: solved.width,
        ...(preset.type === 'differential' ? { gap: solved.gap ?? gap } : {}),
        ohms: solved.ohms,
        delay: solved.delay / AS_PER_PS
      })
    })
    // The trade-off on the first layer: what other gaps would ask of the width.
    const alternatives = hasGap
      ? [...new Set([...ALTERNATIVE_GAPS, gap])]
          .sort((a, b) => a - b)
          .flatMap((g) => {
            const one = lineOn(layers[0], g)
            return one.ok
              ? [
                  {
                    gap: g,
                    width: one.width,
                    buildable: g >= ctx.minClearance && one.width >= ctx.minTrackWidth
                  }
                ]
              : []
          })
      : []
    return { ok: true, rows, results, gap, gapSource, alternatives }
  }

  type Model = {
    classes: readonly NetClass[]
    patterns: readonly NetClassPattern[]
    edited: boolean
  }
  let model: Model = { classes: ctx.classes, patterns: ctx.patterns, edited: false }
  if (!model.classes.some((c) => c.name === className)) model = addNetClass(model, className)
  const at = (): number => model.classes.findIndex((c) => c.name === className)
  let tuningProfiles = [...ctx.tuningProfiles]
  let solution: Solution | null = null
  if (mode.uncontrolled) {
    // No impedance to hold: the board's ordinary sizes, the Default class's, and no profile.
    const base = ctx.classes.find((c) => c.name === DEFAULT_CLASS_NAME)
    if (preset.type === 'differential') {
      model = editNetClass(model, at(), 'diffPairWidth', base?.diffPairWidth ?? null)
      model = editNetClass(model, at(), 'diffPairGap', base?.diffPairGap ?? null)
    } else model = editNetClass(model, at(), 'trackWidth', base?.trackWidth ?? null)
    model = editNetClass(model, at(), 'tuningProfile', '')
  } else {
    const solved = solveLayers()
    if (!solved.ok) return solved
    solution = solved
    const { rows, gap } = solved
    // The profile, named for its class, replacing one of that name.
    const profile: TuningProfile = {
      name: className,
      differential: preset.type === 'differential',
      targetImpedance: mode.impedance.value,
      timeDomain: mode.rules.some((r) => r.unit === 'ps'),
      layers: rows,
      viaDelay: 0,
      overrides: []
    }
    tuningProfiles = [...ctx.tuningProfiles.filter((p) => p.name !== className), profile]
    // The class: its sizes the top layer's solve, its profile the one above.
    const top = rows[0]
    if (preset.type === 'differential') {
      model = editNetClass(model, at(), 'diffPairWidth', top.width)
      model = editNetClass(model, at(), 'diffPairGap', top.gap)
    } else model = editNetClass(model, at(), 'trackWidth', top.width)
    // A coplanar line's gap is its ground's clearance: the pour stands exactly that far off.
    if (preset.model === 'coplanar') model = editNetClass(model, at(), 'clearance', gap)
    model = editNetClass(model, at(), 'tuningProfile', className)
  }
  const added = patterns.filter(
    (pattern) => !model.patterns.some((p) => p.pattern === pattern && p.netClass === className)
  )
  const nextPatterns = [
    ...model.patterns,
    ...added.map((pattern) => ({ pattern, netClass: className }))
  ]

  // The rules, named for the class: what an apply again finds and replaces.
  const condition = `A.NetClass == '${className}'`
  const rules: DruRule[] = mode.rules.map((rule) => ({
    name: `${className} ${RULE_NAMES[rule.kind]}`,
    condition,
    constraints: [constraintText(rule)]
  }))
  // Only what this mode cites, in the order it cites it.
  const cited = [
    mode.impedance.source,
    ...(mode.tolerance ? [mode.tolerance.source] : []),
    ...mode.rules.map((r) => r.max.source)
  ]
  const sources = [...new Set(cited)].flatMap((key) =>
    preset.sources[key] ? [preset.sources[key]] : []
  )

  return {
    ok: true,
    plan: {
      preset,
      mode,
      profileName: className,
      sources,
      tuningProfiles,
      classes: [...model.classes],
      patterns: nextPatterns,
      rules,
      report: {
        nets,
        pairs,
        controlled: solution !== null,
        layers: solution?.results ?? [],
        gap: solution?.gap ?? 0,
        gapSource: solution?.gapSource ?? 'given',
        alternatives: solution?.alternatives ?? [],
        rules: rules.map(druRuleText)
      }
    }
  }
}

/**
 * The solver a preset plans with, over a board's stackup: KiCad's profile
 * models for a line, its calculator's grounded coplanar waveguide for a
 * coplanar line, fed the same dielectric the profile page assembles. Errors
 * are the solvers' codes.
 */
export const stackupSolver =
  (stackup: SolverStackup): LayerSolver =>
  (input) => {
    const geometry = {
      stackup,
      signalLayer: input.layer,
      topReference: input.topReference || undefined,
      bottomReference: input.bottomReference || undefined
    }
    if (input.coplanar) {
      const board = boardParameters({ ...geometry, differential: false })
      if (!board.ok) return { ok: false, error: board.error }
      const { params } = board
      const solved = solveCoplanar({
        grounded: true,
        widthMm: input.width ?? 0,
        gapMm: input.gap,
        // A surface line's one reference: the dielectric under F.Cu, over B.Cu.
        heightMm: params.topHeightM * 1000,
        thicknessMm: params.signalThicknessM * 1000,
        epsilonR: params.epsilonR,
        frequencyHz: input.frequencyHz ?? 1e9,
        targetOhms: input.ohms,
        solveFor: input.width === undefined ? 'width' : 'gap'
      })
      return solved.ok
        ? {
            ok: true,
            width: solved.widthMm,
            ...(input.width === undefined ? {} : { gap: solved.gapMm }),
            delay: solved.delay,
            ohms: solved.ohms
          }
        : { ok: false, error: solved.error }
    }
    const holdWidth = input.differential && input.width !== undefined
    const solved = solveProfileLayer({
      ...geometry,
      differential: input.differential,
      targetOhms: input.ohms,
      ...(holdWidth
        ? { solveFor: 'gap', widthMm: input.width }
        : { solveFor: 'width', ...(input.differential ? { gapMm: input.gap } : {}) })
    })
    if (!solved.ok) return { ok: false, error: solved.error }
    const gap = holdWidth ? solved.gapMm : input.gap
    const read = analyseLayer({
      ...geometry,
      differential: input.differential,
      widthMm: solved.widthMm,
      ...(input.differential ? { gapMm: gap } : {})
    })
    return {
      ok: true,
      width: solved.widthMm,
      ...(input.differential ? { gap } : {}),
      delay: solved.delay,
      ohms: read.ok ? read.ohms : input.ohms
    }
  }
