/**
 * Tuning patterns on the board (docs/router-behavior.md T4), as KiCad keeps
 * them (`PCB_TUNING_PATTERN`): a pattern owns its meandered tracks by uuid,
 * and is selected, re-tuned and removed as one.
 *
 * The run a pattern replaced is its base line (and, for a pair, the coupled
 * half's), carried out to where its tracks meet the rest of their net: a
 * pattern KiCad wrote holds only the meanders, one we wrote before also the
 * leads either side, and both give back the track (and arcs) that was there.
 */

import {
  addSegmentToBoardAST,
  addTrackArcToBoardAST,
  removeBoardNodeFromAST,
  updateTuningPatternInAST,
  type BaseLinePoint,
  type KicadBoard,
  type KicadTuningPattern,
  type TuningPatternData
} from '../kicad/board'
import type { PropertyEditValue } from '../propertyTable'
import { tuningFromShape, type VertexShape } from './graphicVertices'
import type { Nm } from '../kicad/coordinates'
import {
  PackedSegmentNode,
  findChild,
  getFirstAtomValue,
  getToken,
  type SExprList
} from '../kicad/sexpr'
import { arcLength } from './drc/shared'

export interface PatternMember {
  type: 'segment' | 'tarc'
  index: number
}

type NmPt = { x: Nm; y: Nm }

/** Each pattern's tracks, by `segment:i` / `tarc:i`, to the pattern's index. */
export function patternMembership(board: KicadBoard): Map<string, number> {
  const out = new Map<string, number>()
  if (board.tuningPatterns.length === 0) return out
  const byUuid = trackRefsByUuid(board)
  board.tuningPatterns.forEach((pattern, i) => {
    for (const uuid of pattern.members) {
      const ref = byUuid.get(uuid)
      if (ref) out.set(`${ref.type}:${ref.index}`, i)
    }
  })
  return out
}

/** The tracks a pattern holds that are still on the board. */
export function patternMembers(board: KicadBoard, pattern: KicadTuningPattern): PatternMember[] {
  const byUuid = trackRefsByUuid(board)
  return pattern.members.flatMap((uuid) => {
    const ref = byUuid.get(uuid)
    return ref ? [ref] : []
  })
}

function trackRefsByUuid(board: KicadBoard): Map<string, PatternMember> {
  const out = new Map<string, PatternMember>()
  board.segments.forEach((s, index) => s.uuid && out.set(s.uuid, { type: 'segment', index }))
  board.trackArcs.forEach((a, index) => a.uuid && out.set(a.uuid, { type: 'tarc', index }))
  return out
}

/** A run a pattern replaced: one net's track, file coordinates, an arc's point carrying its middle. */
export interface Baseline {
  net: number
  layer: string
  width: Nm
  points: BaseLinePoint[]
}

/** The runs a pattern's tracks replaced, one per net: the tuned half's first. */
export function patternBaselines(board: KicadBoard, pattern: KicadTuningPattern): Baseline[] {
  const tracks = patternMembers(board, pattern).map((ref) =>
    ref.type === 'segment' ? board.segments[ref.index] : board.trackArcs[ref.index]
  )
  const nets = [...new Set(tracks.map((t) => t.net))]
  const tuned = board.nets.find((n) => n.name === pattern.lastNetName)?.number
  nets.sort((a, b) => (a === tuned ? -1 : b === tuned ? 1 : 0))
  return nets.map((net, i) => {
    const own = tracks.filter((t) => t.net === net)
    const base = i === 0 ? pattern.baseLine : (pattern.baseLineCoupled ?? [])
    return {
      net,
      layer: own[0].layer,
      width: own[0].width,
      points: carriedOut(base, looseEnds(own))
    }
  })
}

/** The ends of a run of tracks: points only one of them reaches. */
function looseEnds(tracks: ReadonlyArray<{ start: NmPt; end: NmPt }>): NmPt[] {
  const count = new Map<string, { p: NmPt; n: number }>()
  for (const t of tracks)
    for (const p of [t.start, t.end]) {
      const key = `${p.x},${p.y}`
      const seen = count.get(key)
      if (seen) seen.n++
      else count.set(key, { p, n: 1 })
    }
  return [...count.values()].filter((c) => c.n === 1).map((c) => c.p)
}

/** A base line extended to the run's loose ends beyond it; the ends alone without one. */
function carriedOut(base: readonly BaseLinePoint[], ends: readonly NmPt[]): BaseLinePoint[] {
  if (base.length < 2) return ends.length >= 2 ? [ends[0], ends[1]] : [...base]
  const d = (a: NmPt, b: NmPt): number => Math.hypot(a.x - b.x, a.y - b.y)
  const nearest = (p: NmPt): NmPt | undefined => [...ends].sort((a, b) => d(a, p) - d(b, p))[0]
  const first = nearest(base[0])
  const last = nearest(base[base.length - 1])
  const out: BaseLinePoint[] = [...base]
  if (first && d(first, base[0]) > 1) out.unshift(first)
  if (last && last !== first && d(last, base[base.length - 1]) > 1) out.push(last)
  // A lead in line with the base line runs on as one track; an arc's ends stay.
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1 || p.mid || out[i + 1].mid) return true
    const a = out[i - 1]
    const b = out[i + 1]
    return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) > d(a, b)
  })
}

/** A net's length in a pattern's tracks, mm. */
export function membersLength(board: KicadBoard, pattern: KicadTuningPattern, net: number): number {
  let total = 0
  for (const ref of patternMembers(board, pattern)) {
    if (ref.type === 'segment') {
      const s = board.segments[ref.index]
      if (s.net === net) total += Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)
    } else {
      const a = board.trackArcs[ref.index]
      if (a.net === net) total += arcLength(a.start, a.mid, a.end)
    }
  }
  return total / 1e6
}

/** A run's length, mm, its arcs by their sweep. */
export const runLength = (points: readonly BaseLinePoint[]): number =>
  points
    .slice(1)
    .reduce(
      (sum, p, i) =>
        sum +
        (p.mid ? arcLength(points[i], p.mid, p) : Math.hypot(p.x - points[i].x, p.y - points[i].y)),
      0
    ) / 1e6

/** Take a pattern's tracks off the board, and the pattern with them. */
export function deletePatternInAST(board: KicadBoard, pattern: KicadTuningPattern): void {
  for (const ref of patternMembers(board, pattern)) {
    const item = ref.type === 'segment' ? board.segments[ref.index] : board.trackArcs[ref.index]
    removeBoardNodeFromAST(board, item._raw)
  }
  removeBoardNodeFromAST(board, pattern._raw)
}

/**
 * Remove a pattern and give back the run it replaced, as KiCad's
 * does when only the pattern is deleted: the routing stays connected.
 */
export function restorePatternInAST(board: KicadBoard, pattern: KicadTuningPattern): void {
  const runs = patternBaselines(board, pattern)
  deletePatternInAST(board, pattern)
  for (const run of runs)
    for (let i = 0; i < run.points.length - 1; i++) {
      const a = run.points[i]
      const { mid, ...end } = run.points[i + 1]
      const track = {
        start: { x: a.x, y: a.y },
        end,
        width: run.width,
        layer: run.layer,
        net: run.net
      }
      if (mid) addTrackArcToBoardAST(board, { ...track, mid })
      else addSegmentToBoardAST(board, track)
    }
}

/**
 * After an edit: a pattern whose tracks are all gone goes too, and one that
 * lost some lists only those left. True when anything changed.
 */
export function prunePatternsInAST(board: KicadBoard): boolean {
  if (board.tuningPatterns.length === 0) return false
  // Read off the tree: mid-command, the board's lists are not rebuilt yet.
  const live = new Set<string>()
  for (const node of (board._raw as SExprList).children) {
    if (node.type !== 'list') continue
    const token = getToken(node)
    if (token !== 'segment' && token !== 'arc') continue
    // A packed segment's record holds its uuid; its children would materialize it.
    const packed = node instanceof PackedSegmentNode ? node.packedRecord() : null
    const uuid = packed ? null : findChild(node, 'uuid')
    const value = packed ? packed.uuid : uuid ? getFirstAtomValue(uuid) : undefined
    if (value) live.add(value)
  }
  let changed = false
  for (const pattern of board.tuningPatterns) {
    if (!(board._raw as SExprList).children.includes(pattern._raw)) continue
    const members = pattern.members.filter((uuid) => live.has(uuid))
    if (members.length === pattern.members.length) continue
    changed = true
    if (members.length === 0) removeBoardNodeFromAST(board, pattern._raw)
    else updateTuningPatternInAST(pattern, { ...pattern, members })
  }
  return changed
}

/** A typed target's tolerance either side, mm (KiCad's `DEFAULT_LENGTH_TOLERANCE`, router/tuning.ts). */
const TARGET_TOLERANCE = 0.1

/** A pattern with one of its Properties rows changed (pcbPropertySchema.ts `tuningPatternGroup`). */
export function patternEdit(
  pattern: TuningPatternData,
  key: string,
  value: PropertyEditValue
): TuningPatternData {
  const data: TuningPatternData = { ...pattern }
  const n = Number(value)
  switch (key) {
    case 'target': {
      const skew = pattern.mode === 'diff_pair_skew'
      const typed = value === null || !Number.isFinite(n) ? null : n
      const range =
        typed === null
          ? skew
            ? { min: -TARGET_TOLERANCE, opt: 0, max: TARGET_TOLERANCE }
            : { min: 0, opt: Infinity, max: Infinity }
          : { min: typed - TARGET_TOLERANCE, opt: typed, max: typed + TARGET_TOLERANCE }
      return skew ? { ...data, targetSkew: range } : { ...data, targetLength: range }
    }
    case 'overrideCustomRules':
      return { ...data, overrideCustomRules: !!value }
    // KiCad's setters: either amplitude past the other carries the other with it.
    case 'minAmplitude':
      return { ...data, minAmplitude: n, maxAmplitude: Math.max(n, data.maxAmplitude) }
    case 'maxAmplitude':
      return { ...data, maxAmplitude: n, minAmplitude: Math.min(n, data.minAmplitude) }
    case 'spacing':
      return { ...data, minSpacing: n }
    case 'initialSide':
      return value === 'left' || value === 'right' || value === 'default'
        ? { ...data, initialSide: value }
        : data
    case 'singleSided':
      return { ...data, singleSided: !!value }
    case 'rounded':
      return { ...data, rounded: !!value }
    case 'cornerRadiusPercent':
      return { ...data, cornerRadiusPercent: Math.min(100, Math.max(0, n)) }
    default:
      return data
  }
}

/**
 * A pattern with handle `vertex` where `shape` has it, as KiCad reads back
 * only the handle moved: an end, the largest amplitude with the first side,
 * or the spacing.
 */
export function handlesEdit(
  pattern: KicadTuningPattern,
  shape: Extract<VertexShape, { kind: 'tuning' }>,
  vertex: number
): TuningPatternData {
  const read = tuningFromShape(shape)
  switch (vertex) {
    case 0:
      return { ...pattern, origin: read.origin }
    case 1:
      return { ...pattern, end: read.end }
    case 2:
      return {
        ...patternEdit(pattern, 'maxAmplitude', read.maxAmplitude),
        initialSide: read.side === 1 ? 'left' : 'right'
      }
    default:
      return { ...pattern, minSpacing: read.spacing }
  }
}
