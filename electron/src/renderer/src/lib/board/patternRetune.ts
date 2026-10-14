/**
 * A tuning pattern on the board laid again (docs/router-behavior.md T4), as
 * KiCad regenerates one when its settings or handles change: shared by the
 * editor's Properties rows, handles and *Update all tuning patterns*, and an
 * agent's `items.update` and `board.update_tuning_patterns`.
 */
import {
  getNetName,
  removeBoardNodeFromAST,
  updateTuningPatternInAST,
  type BaseLinePoint,
  type KicadBoard,
  type KicadTuningPattern,
  type TuningPatternData
} from '../kicad/board'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { defaultNetClass, netClassForNet } from '../kicad/project'
import type { BoardSpatialIndex, CopperItem } from './spatialIndex'
import type { RouterWorld } from './router/world'
import type { MeanderSettings } from './router/meander'
import {
  patternRunItem,
  retunePattern,
  tuneTargetOf,
  type LinePoint,
  type PatternRun,
  type TuneMode,
  type TuneTimeScale,
  type TuneUpdate
} from './router/tuning'
import { pairMateOf } from './pairRoute'
import {
  tuneRuleFor,
  tuneTimeScale,
  tunedPatternData,
  tunedTrackLength,
  writeTunedLines,
  type TuneSetup
} from './tuneTool'
import { membersLength, patternBaselines, patternMembers, runLength } from './tuningPatterns'

/** What a re-tune reads: the board as it is, its copper and router, and Board Setup's rules. */
export interface RetuneHost {
  board: KicadBoard
  index: BoardSpatialIndex
  world: RouterWorld
  setup: TuneSetup
}

export const TUNE_MODE_OF: Record<TuningPatternData['mode'], TuneMode> = {
  single: 'single',
  diff_pair: 'pair',
  diff_pair_skew: 'skew'
}

/** The meanders a pattern's settings draw. */
export const patternMeander = (data: TuningPatternData): MeanderSettings => ({
  minAmplitude: data.minAmplitude,
  maxAmplitude: data.maxAmplitude,
  spacing: data.minSpacing,
  cornerRadiusPercent: data.rounded ? data.cornerRadiusPercent : 0,
  singleSided: data.singleSided,
  side: data.initialSide === 'right' ? -1 : 1
})

const sameRef = (a: { type: string; index: number }, b: { type: string; index: number }): boolean =>
  a.type === b.type && a.index === b.index

/** PR6: the other half's track beside a pair half's, within a little over its class's pitch. */
const mateOf = (h: RetuneHost, item: CopperItem): CopperItem | null =>
  pairMateOf(h.board, h.index, item, (name) => {
    const cls = netClassForNet(name, h.setup.classes, h.setup.patterns, h.setup.assignments)
    return cls.diffPairGap + cls.diffPairWidth
  })

/**
 * A pattern laid again with `data` its settings: its tracks back to the run
 * they replaced and the tuner run over it (`retunePattern`). Null where the
 * tuner cannot lay it: a run that bends, as KiCad's tuner may leave one.
 */
export function retuneOf(
  h: RetuneHost,
  pattern: KicadTuningPattern,
  data: TuningPatternData
): TuneUpdate | null {
  const b = h.board
  const mode = TUNE_MODE_OF[data.mode]
  const baselines = patternBaselines(b, pattern)
  if (baselines.length === 0 || baselines.some((run) => run.points.length < 2)) return null
  const scene = (p: { x: Nm; y: Nm }): { x: number; y: number } => ({
    x: nmToMm(p.x),
    y: -nmToMm(p.y)
  })
  const scenePath = (points: readonly BaseLinePoint[]): LinePoint[] =>
    points.map((p) => ({ ...scene(p), ...(p.mid ? { mid: scene(p.mid) } : {}) }))
  const members = patternMembers(b, pattern)
  // The tuned length through the pattern's tracks, less them, plus the run they replaced.
  const runs: PatternRun[] = baselines.map((run) => {
    const member = members.find((ref) =>
      ref.type === 'segment'
        ? b.segments[ref.index].net === run.net
        : b.trackArcs[ref.index].net === run.net
    )
    return {
      net: run.net,
      layer: run.layer,
      width: nmToMm(run.width),
      path: scenePath(run.points),
      length:
        (member ? tunedTrackLength(b, { ref: member }, h.setup.rules) : 0) -
        membersLength(b, pattern, run.net) +
        runLength(run.points)
    }
  })
  const tracks = h.index.items.filter(
    (item): item is CopperItem => !!item && members.some((ref) => sameRef(ref, item.ref))
  )
  const seed = runs[0]
  const runItem = mode === 'skew' ? patternRunItem(seed) : null
  const mate = runItem ? mateOf(h, runItem) : null
  if (mode === 'skew' && !mate) return null
  const name = getNetName(b, seed.net)
  const cls = name
    ? netClassForNet(name, h.setup.classes, h.setup.patterns, h.setup.assignments)
    : defaultNetClass(h.setup.classes)
  const typed = mode === 'skew' ? data.targetSkew.opt : data.targetLength.opt
  const target = tuneTargetOf(
    mode,
    Number.isFinite(typed) ? typed : null,
    tuneRuleFor(b, h.setup, seed.net, seed.layer, mode),
    data.overrideCustomRules,
    patternTimeOf(h, pattern, data)
  )
  return retunePattern(h.world, {
    mode,
    tracks,
    runs,
    ...(mate ? { mate, mateLength: tunedTrackLength(b, mate, h.setup.rules) } : {}),
    origin: scene(data.origin),
    end: scene(data.end),
    side: data.initialSide === 'right' ? -1 : 1,
    settings: patternMeander(data),
    target,
    clearance: cls.clearance
  })
}

/**
 * How a pattern's delay follows its length (T2), read off its tracks as they
 * are: the scale is linear, so a run with the meanders taken out reads by it too.
 */
export function patternTimeOf(
  h: RetuneHost,
  pattern: KicadTuningPattern,
  data: TuningPatternData
): TuneTimeScale | null {
  const b = h.board
  const mode = TUNE_MODE_OF[data.mode]
  const members = patternMembers(b, pattern)
  const netOf = (ref: { type: string; index: number }): number =>
    ref.type === 'segment' ? b.segments[ref.index].net : b.trackArcs[ref.index].net
  const tuned = b.nets.find((n) => n.name === pattern.lastNetName)?.number
  const seed = members.find((ref) => netOf(ref) === tuned) ?? members[0]
  if (!seed) return null
  const coupled = members.find((ref) => netOf(ref) !== netOf(seed))
  const seedItem = h.index.items.find((i): i is CopperItem => !!i && sameRef(i.ref, seed))
  const mate =
    mode === 'pair' && coupled
      ? { ref: coupled }
      : mode === 'skew' && seedItem
        ? mateOf(h, seedItem)
        : null
  return tuneTimeScale(b, h.setup, mode, { ref: seed }, mate, netOf(seed), data.layer)
}

/** Lay a re-tune: the old tracks off, the new ones on, the pattern rewritten in place (T4). */
export function writeRetune(
  b: KicadBoard,
  pattern: KicadTuningPattern,
  data: TuningPatternData,
  u: TuneUpdate,
  time: TuneTimeScale | null
): void {
  for (const ref of patternMembers(b, pattern)) {
    const item = ref.type === 'segment' ? b.segments[ref.index] : b.trackArcs[ref.index]
    if (item) removeBoardNodeFromAST(b, item._raw)
  }
  const members = writeTunedLines(b, u)
  updateTuningPatternInAST(pattern, {
    ...tunedPatternData(
      b,
      u,
      TUNE_MODE_OF[data.mode],
      patternMeander(data),
      data.overrideCustomRules,
      members,
      data.initialSide,
      time
    ),
    // Square corners keep the radius they would round by, as KiCad's switch does.
    cornerRadiusPercent: data.cornerRadiusPercent,
    rounded: data.rounded
  })
}

/** A pattern's re-tune worked out: the tune, or null where the tuner cannot lay it. */
export interface RetunePlan {
  pattern: KicadTuningPattern
  data: TuningPatternData
  u: TuneUpdate | null
  time: TuneTimeScale | null
}

/**
 * Patterns' re-tunes, each with its data, every one worked out on the board
 * as it is before any is written, since each write moves the board's indices.
 */
export const planRetunes = (
  h: RetuneHost,
  edits: ReadonlyArray<readonly [KicadTuningPattern, TuningPatternData]>
): RetunePlan[] =>
  edits.map(([pattern, data]) => ({
    pattern,
    data,
    u: retuneOf(h, pattern, data),
    time: patternTimeOf(h, pattern, data)
  }))

/** The plans laid; a run the tuner cannot lay keeps its settings for KiCad to re-tune by. */
export function writeRetunes(b: KicadBoard, plans: readonly RetunePlan[]): void {
  for (const { pattern, data, u, time } of plans)
    if (u) writeRetune(b, pattern, data, u, time)
    else updateTuningPatternInAST(pattern, data)
}

const roundMm = (value: number): number => Math.round(value * 1000) / 1000

/**
 * A re-tune as an answer reads it: the pattern's net, its length (a skew
 * pattern's skew), the target and the status, `blocked` where the meanders
 * break a rule; `laid: false` where the tuner could not lay it, its settings
 * kept.
 */
export function retuneRow(b: KicadBoard, plan: RetunePlan, id: string): Record<string, unknown> {
  const { u, data } = plan
  const net = plan.pattern.lastNetName
  if (!u) return { id, net, laid: false }
  const skew = data.mode === 'diff_pair_skew'
  const bound = (key: 'min' | 'opt' | 'max'): Record<string, number> =>
    Number.isFinite(u.target[key]) ? { [key]: roundMm(u.target[key]) } : {}
  return {
    id,
    net: getNetName(b, u.lines[0]?.net ?? 0) || net,
    ...(skew ? { skew: roundMm(u.skew ?? 0) } : { length: roundMm(u.length) }),
    ...(Number.isFinite(u.target.opt)
      ? { target: { ...bound('min'), ...bound('opt'), ...bound('max') } }
      : {}),
    status: u.status,
    ...(u.blocked ? { blocked: true } : {})
  }
}
