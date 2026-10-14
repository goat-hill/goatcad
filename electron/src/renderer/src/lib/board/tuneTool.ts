/**
 * The length tuner's steps (docs/router-behavior.md T1–T6), shared by the
 * editor's `7`/`8`/`9` and an agent's tune session (`routeAgentTools.ts`):
 * what a tuned track measures, the rule it is tuned to, where a pattern starts, and
 * what a laid tune writes. The engine is `router/tuning.ts`; scene mm.
 */
import {
  addSegmentToBoardAST,
  addTrackArcToBoardAST,
  addTuningPatternToBoardAST,
  getNetName,
  removeBoardNodeFromAST,
  type BaseLinePoint,
  type KicadBoard,
  type TuningPatternData
} from '../kicad/board'
import { mmToNm, type Nm } from '../kicad/coordinates'
import type { BoardDesignSettings, TuningDelays } from '../kicad/project'
import { AS_PER_PS } from './tuningProfiles'
import { boardRules } from './rules/boardRules'
import { routedNetLength, tunedPathLength, tunedPathStats } from './tuneLength'
import { matchDiffPair } from './rules/diffPairs'
import { patternMembership } from './tuningPatterns'
import type { BoardSpatialIndex, CopperItem, Pt } from './spatialIndex'
import type { RouterWorld } from './router/world'
import { chordsOf } from './router/engine'
import {
  TuneSession,
  delayAt,
  type LinePoint,
  type TuneMode,
  type TuneRule,
  type TuneTarget,
  type TuneTimeScale,
  type TuneUpdate
} from './router/tuning'
import type { MeanderSettings } from './router/meander'

/** The design settings the rules are read from: Board Setup's. */
export type TuneSetup = Pick<
  BoardDesignSettings,
  'rules' | 'classes' | 'patterns' | 'assignments' | 'tuning'
> & {
  customRules?: string
}

/** A net's whole routed length, mm: tracks, arcs, via heights, pad-to-die. */
export function netTrackLength(
  board: KicadBoard,
  net: number,
  rules: Pick<BoardDesignSettings['rules'], 'useHeightForLengthCalcs' | 'maxError'>
): number {
  return (
    routedNetLength(board, net, {
      useHeight: rules.useHeightForLengthCalcs,
      maxError: rules.maxError
    }) / 1e6
  )
}

/**
 * What the tuner measures through a track, mm (T2): its path between its two
 * pads, with the vias it passes and those pads' pad-to-die.
 */
export function tunedTrackLength(
  board: KicadBoard,
  track: { ref: { type: string; index: number } },
  rules: Pick<BoardDesignSettings['rules'], 'useHeightForLengthCalcs' | 'maxError'>
): number {
  const { type, index } = track.ref
  if (type !== 'segment' && type !== 'tarc') return 0
  return (
    tunedPathLength(
      board,
      { type, index },
      { useHeight: rules.useHeightForLengthCalcs, maxError: rules.maxError }
    ) / 1e6
  )
}

const roundMm = (value: number): number => Math.round(value * 1000) / 1000

/** A rule's bounds as an answer reads them, mm, or ps (`unit`) for a time-domain rule; none set reads null. */
const ruleRecord = (rule: TuneRule | null): Record<string, number | string> | null => {
  const out = Object.fromEntries(
    (['min', 'opt', 'max'] as const).flatMap((key) =>
      rule?.[key] !== undefined && Number.isFinite(rule[key]) ? [[key, roundMm(rule[key]!)]] : []
    )
  )
  if (!Object.keys(out).length) return null
  return rule?.timeDomain ? { ...out, unit: 'ps' } : out
}

/**
 * Nets' whole routed lengths by name (`netTrackLength`): each with its
 * length rule, and a pair half with its partner's skew and skew rule. A name
 * the board does not have refuses the whole read.
 */
export function netLengthRows(
  board: KicadBoard,
  setup: TuneSetup,
  names: readonly string[]
):
  | { rows: Array<Record<string, unknown>> }
  | { error: 'net-not-found'; detail: string; candidates: string[] } {
  const byName = new Map(board.nets.filter((n) => n.number !== 0).map((n) => [n.name, n.number]))
  const missing = names.find((name) => !byName.has(name))
  if (missing !== undefined)
    return {
      error: 'net-not-found',
      detail: `No net called ${missing} is on the board.`,
      candidates: [...byName.keys()]
        .filter((name) => name.toLowerCase().includes(missing.toLowerCase().slice(0, 3)))
        .slice(0, 12)
    }
  const layerOf = (net: number): string =>
    board.segments.find((s) => s.net === net)?.layer ??
    board.trackArcs.find((a) => a.net === net)?.layer ??
    board.layers.find((l) => l.name.endsWith('.Cu'))?.name ??
    'F.Cu'
  const rows = names.map((name) => {
    const net = byName.get(name)!
    const layer = layerOf(net)
    const length = netTrackLength(board, net, setup.rules)
    const pair = matchDiffPair(name)
    const partner = pair && byName.has(pair.complement) ? pair.complement : null
    const rule = ruleRecord(tuneRuleFor(board, setup, net, layer, 'single'))
    const skewRule = partner ? ruleRecord(tuneRuleFor(board, setup, net, layer, 'skew')) : null
    return {
      net: name,
      length: roundMm(length),
      ...(rule ? { rule } : {}),
      ...(partner
        ? {
            partner,
            skew: roundMm(length - netTrackLength(board, byName.get(partner)!, setup.rules)),
            ...(skewRule ? { skewRule } : {})
          }
        : {})
    }
  })
  return { rows }
}

/** The length or skew rule a net's track is tuned to on a layer (T2). */
export function tuneRuleFor(
  board: KicadBoard,
  setup: TuneSetup,
  net: number,
  layer: string,
  mode: TuneMode
): TuneRule | null {
  const rules = boardRules(
    board,
    {
      rules: setup.rules,
      classes: setup.classes,
      patterns: setup.patterns,
      assignments: setup.assignments,
      tuning: setup.tuning
    },
    setup.customRules
  )
  return rules.resolver.evaluate(
    mode === 'skew' ? 'skew' : 'length',
    rules.newItem('track', net, [layer]),
    null,
    layer
  ).value
}

/** The delays a net's class's tuning profile gives, as DRC reads them; null where it has none. */
export function tuneDelaysFor(
  board: KicadBoard,
  setup: TuneSetup,
  net: number
): TuningDelays | null {
  const tuning = setup.tuning
  if (!tuning) return null
  const cls = boardRules(board, {
    rules: setup.rules,
    classes: setup.classes,
    patterns: setup.patterns,
    assignments: setup.assignments,
    tuning
  }).netClassOf(net)
  const names = cls.constituents ?? [cls.name]
  const profile = names.map((name) => tuning.classProfiles[name]).find(Boolean)
  return (profile && tuning.delays?.[profile]) || null
}

/**
 * How a tune's delay follows its length (T2, KiCad's time-domain tuning): the
 * tuned track's path (a pair's longer half; a skew, the half less its
 * partner) measured with its net's tuning profile, and the profile's delay on
 * the tuned layer. Null where the net has no profile or the layer no delay.
 */
export function tuneTimeScale(
  board: KicadBoard,
  setup: TuneSetup,
  mode: TuneMode,
  seed: { ref: { type: string; index: number } },
  mate: { ref: { type: string; index: number } } | null,
  net: number,
  layer: string
): TuneTimeScale | null {
  const delays = tuneDelaysFor(board, setup, net)
  const perMm = delays?.layers[layer] ?? 0
  if (!delays?.timeDomain || perMm <= 0) return null
  const opts = { useHeight: setup.rules.useHeightForLengthCalcs, maxError: setup.rules.maxError }
  const stats = (track: { ref: { type: string; index: number } }): { mm: number; ps: number } => {
    const { type, index } = track.ref
    const s =
      type === 'segment' || type === 'tarc'
        ? tunedPathStats(board, { type, index }, opts, delays)
        : null
    return { mm: (s?.total ?? 0) / 1e6, ps: (s?.totalDelay ?? 0) / AS_PER_PS }
  }
  const a = stats(seed)
  const b = mate ? stats(mate) : null
  const q =
    mode === 'skew' && b
      ? { mm: a.mm - b.mm, ps: a.ps - b.ps }
      : mode === 'pair' && b && b.mm > a.mm
        ? b
        : a
  return { length: q.mm, delay: q.ps, psPerMm: perMm / AS_PER_PS }
}

/** Whether a track is one of a tuning pattern's: KiCad's tuner starts no pattern inside another (T1). */
export function inTuningPattern(board: KicadBoard, ref: { type: string; index: number }): boolean {
  return patternMembership(board).has(`${ref.type}:${ref.index}`)
}

/** The track a tuner's first click at `point` starts a pattern on (T1): a straight one, else an arc, as KiCad's. */
export function tuneSeedAt(index: BoardSpatialIndex, point: Pt): CopperItem | undefined {
  const near = index.near(point.x, point.y, 0.5, {})
  return (
    near.find((h) => h.item.ref.type === 'segment' && h.item.shape.kind === 'capsule')?.item ??
    near.find((h) => h.item.ref.type === 'tarc' && h.item.shape.kind === 'arc')?.item
  )
}

/**
 * A tune begun on `seed` where it was grabbed (T1, T5): null where the tuner
 * cannot start — a pair or skew tune with no partner track beside it.
 */
export function startTune(
  world: RouterWorld,
  seed: CopperItem,
  grab: Pt,
  opts: {
    mode: TuneMode
    settings: MeanderSettings
    target: TuneTarget
    clearance: number
    /** What the tuner measures through a track, mm (`tunedTrackLength`). */
    lengthOf: (track: CopperItem) => number
    mate: CopperItem | null
  }
): TuneSession | null {
  if (opts.mode !== 'single' && !opts.mate) return null
  const session = new TuneSession(world, seed, grab, {
    mode: opts.mode,
    settings: opts.settings,
    target: opts.target,
    clearance: opts.clearance,
    length: opts.lengthOf(seed),
    ...(opts.mate ? { mate: opts.mate, mateLength: opts.lengthOf(opts.mate) } : {})
  })
  return session.valid ? session : null
}

/** A tune's tracks as drawn where they would land, scene mm, each flagged where it violates. */
export function tuneSegments(u: TuneUpdate): Array<{
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  layer: string
  violation?: boolean
}> {
  return u.lines.flatMap((l) =>
    chordsOf(
      l.pieces.map((p, i) => ({
        x0: p.a.x,
        y0: p.a.y,
        x1: p.b.x,
        y1: p.b.y,
        ...(p.mid ? { mid: p.mid } : {}),
        width: l.width,
        layer: l.layer,
        ...(l.violations[i] ? { violation: true } : {})
      }))
    )
  )
}

const nmPoint = (p: Pt): { x: Nm; y: Nm } => ({ x: mmToNm(p.x), y: mmToNm(-p.y) })
/** A base line's point in the file's coordinates, an arc's middle with it. */
const nmLinePoint = (p: LinePoint): BaseLinePoint => ({
  ...nmPoint(p),
  ...(p.mid ? { mid: nmPoint(p.mid) } : {})
})

/**
 * A tune's tracks written to the board, in place of the tracks it replaced;
 * the uuids of those its pattern holds — the meanders, not the leads (T4).
 */
export function writeTunedLines(b: KicadBoard, u: TuneUpdate): string[] {
  const members: string[] = []
  // Found before any goes, since each removal moves the indices after it.
  const old = u.lines.flatMap((line) =>
    line.replaces.flatMap((ref) => {
      const item = ref.type === 'segment' ? b.segments[ref.index] : b.trackArcs[ref.index]
      return item ? [item._raw] : []
    })
  )
  for (const raw of old) removeBoardNodeFromAST(b, raw)
  for (const line of u.lines)
    line.pieces.forEach((p, i) => {
      const uuid = crypto.randomUUID()
      if (i >= line.span[0] && i < line.span[1]) members.push(uuid)
      const common = {
        start: nmPoint(p.a),
        end: nmPoint(p.b),
        width: mmToNm(line.width),
        layer: line.layer,
        net: line.net,
        uuid
      }
      if (p.mid) addTrackArcToBoardAST(b, { ...common, mid: nmPoint(p.mid) })
      else addSegmentToBoardAST(b, common)
    })
  return members
}

/** What KiCad's tuning pattern records of a tune (T4). */
export function tunedPatternData(
  b: KicadBoard,
  u: TuneUpdate,
  mode: TuneMode,
  settings: MeanderSettings,
  overrideCustomRules: boolean,
  members: string[],
  initialSide: TuningPatternData['initialSide'] = u.pattern.side,
  time: TuneTimeScale | null = null
): TuningPatternData {
  const first = u.lines[0]
  const coupled = u.pattern.baseCoupled
  const gap = coupled
    ? Math.hypot(coupled[0].x - u.pattern.base[0].x, coupled[0].y - u.pattern.base[0].y) -
      first.width
    : 0
  return {
    layer: first.layer,
    mode: mode === 'pair' ? 'diff_pair' : mode === 'skew' ? 'diff_pair_skew' : 'single',
    origin: nmPoint(u.pattern.origin),
    end: nmPoint(u.pattern.end),
    baseLine: u.pattern.base.map(nmLinePoint),
    ...(coupled ? { baseLineCoupled: coupled.map(nmLinePoint) } : {}),
    initialSide,
    minAmplitude: settings.minAmplitude,
    maxAmplitude: settings.maxAmplitude,
    minSpacing: settings.spacing,
    cornerRadiusPercent: settings.cornerRadiusPercent,
    rounded: settings.cornerRadiusPercent > 0,
    singleSided: settings.singleSided,
    targetLength: mode === 'skew' ? { min: 0, opt: Infinity, max: Infinity } : u.target,
    targetSkew: mode === 'skew' ? u.target : { min: -0.1, opt: 0, max: 0.1 },
    // A time-domain tune keeps its target in ps too, as KiCad's (`is_time_domain`).
    ...(time
      ? {
          targetDelay: {
            min: delayAt(time, u.target.min),
            opt: delayAt(time, u.target.opt),
            max: delayAt(time, u.target.max)
          }
        }
      : {}),
    overrideCustomRules,
    lastNetName: getNetName(b, first.net),
    lastStatus: u.status,
    lastTrackWidth: first.width,
    lastDiffPairGap: gap,
    lastTuningLength: u.length,
    members
  }
}

/** A laid tune: the meanders and their pattern, one undo step's body (T4). */
export function writeTune(
  b: KicadBoard,
  u: TuneUpdate,
  mode: TuneMode,
  settings: MeanderSettings,
  overrideCustomRules: boolean,
  time: TuneTimeScale | null = null
): void {
  const members = writeTunedLines(b, u)
  addTuningPatternToBoardAST(
    b,
    tunedPatternData(b, u, mode, settings, overrideCustomRules, members, u.pattern.side, time)
  )
}
