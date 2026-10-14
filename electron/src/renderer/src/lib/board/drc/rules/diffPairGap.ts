import {
  getNetName,
  type KicadBoard,
  type KicadTrackArc,
  type KicadTrackSegment
} from '../../../kicad/board'
import { findChild, findChildren, getAtomValues } from '../../../kicad/sexpr'
import { nmToMm, type Nm } from '../../../kicad/coordinates'
import { shapeToShape, type CopperItem, type CopperShape, type Pt } from '../../spatialIndex'
import { matchDiffPair } from '../../rules/diffPairs'
import { arcGeometry, arcPieceLength, type NmPt } from '../../netLength'
import type { ConstraintValue, Rule, RuleSeverity } from '../../rules/constraints'
import type { Box } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { DRC_EPSILON, at, idsOf, ownSeverity, worldOf, type Subject } from '../shared'

/** A track of a pair's half, as the coupling test reads it. */
interface Half {
  item: CopperItem
  subject: Subject
  layer: string
  width: number
  seg?: KicadTrackSegment
  arc?: KicadTrackArc
}

/** One pair under one rule set: its halves' items and the rules that hold them. */
interface PairEntry {
  netP: number
  netN: number
  gap: ConstraintValue | null
  gapRule: string
  gapSeverity?: RuleSeverity
  uncoupled: ConstraintValue | null
  uncoupledRule: string
  uncoupledSeverity?: RuleSeverity
  itemsP: CopperItem[]
  itemsN: CopperItem[]
}

/** Two stretches of the halves running side by side, and how far apart. */
interface Coupled {
  p: Half
  n: Half
  /** The stretch's length along the N half, nm. */
  length: number
  /** Edge to edge, nm. */
  gap: number
  failMin: boolean
  failMax: boolean
}

/** KiCad's smallest angle two arcs must share to run side by side, degrees. */
const MIN_PARALLEL_ANGLE = 0.001

/**
 * The differential pair rules, as KiCad's coupling provider holds them: where
 * a pair's two halves run exactly parallel (or as arcs round one center) with
 * nothing between them, they are coupled there, and the gap must stay within
 * `diff_pair_gap`; the rest of the longer half is uncoupled, held to
 * `diff_pair_uncoupled`. A pair is two nets named alike but for a `+`/`-` or
 * `P`/`N` (`rules/diffPairs.ts`). Board-scoped: a pair's lengths read all of it.
 */
export function* diffPairGap(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, emit, tick, itemByRef, copperOn, copperNear } = ctx
  const resolver = ruleSet.resolver
  if (!resolver.hasRules('diff_pair_gap') && !resolver.hasRules('diff_pair_uncoupled')) return
  const netNumber = new Map(board.nets.map((net) => [net.name, net.number]))
  const epsilon = Math.round(DRC_EPSILON * 1e6)

  // Every track, arc and via of a pair's half, under the rules that decide its gap and uncoupled length.
  const entries = new Map<string, PairEntry>()
  const collect = (item: CopperItem, layer: string | null): void => {
    const name = item.net > 0 ? getNetName(board, item.net) : ''
    const pair = matchDiffPair(name)
    const other = pair ? netNumber.get(pair.complement) : undefined
    if (!pair || other === undefined) return
    const [netP, netN] = pair.polarity > 0 ? [item.net, other] : [other, item.net]
    const ruleItem = ruleSet.copperItem(item)
    let gap: { value: ConstraintValue; name: string; severity?: RuleSeverity } | null = null
    for (const type of ['diff_pair_gap', 'diff_pair_uncoupled'] as const) {
      const resolved = resolver.evaluate(type, ruleItem, null, layer)
      if (resolved.isNull || resolved.severity === 'ignore') continue
      const name = ruleName(resolved.rule, resolved.name)
      let uncoupled: { value: ConstraintValue; name: string; severity?: RuleSeverity } | null = null
      if (type === 'diff_pair_gap')
        gap = { value: resolved.value, name, severity: resolved.severity }
      else uncoupled = { value: resolved.value, name, severity: resolved.severity }
      // KiCad files an item under the pair and its gap rule, then again once the
      // uncoupled rule is known: with a gap rule, entries differ by uncoupled rule alone.
      const key = gap ? `${netP}|${netN}|u:${uncoupled?.name ?? ''}` : `${netP}|${netN}|g`
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          netP,
          netN,
          gap: gap?.value ?? null,
          gapRule: gap?.name ?? '',
          gapSeverity: gap?.severity,
          uncoupled: uncoupled?.value ?? null,
          uncoupledRule: uncoupled?.name ?? '',
          uncoupledSeverity: uncoupled?.severity,
          itemsP: [],
          itemsN: []
        }
        entries.set(key, entry)
      }
      const list = item.net === netN ? entry.itemsN : entry.itemsP
      if (!list.includes(item)) list.push(item)
    }
  }
  for (const [kind, list] of [
    ['segment', board.segments],
    ['via', board.vias],
    ['tarc', board.trackArcs]
  ] as const) {
    for (let i = 0; i < list.length; i++) {
      if (tick()) yield
      const item = itemByRef.get(`${kind}:${i}`)
      if (item) collect(item, item.layers[0] ?? null)
    }
  }

  // The tracks a tuning pattern draws (a meander) are neither coupled nor counted.
  const tuned = tuningMembers(board)
  const inPattern = (item: CopperItem): boolean => {
    const uuid =
      item.ref.type === 'segment'
        ? board.segments[item.ref.index].uuid
        : item.ref.type === 'tarc'
          ? board.trackArcs[item.ref.index].uuid
          : undefined
    return !!uuid && tuned.has(uuid)
  }
  const halfOf = (item: CopperItem): Half | null => {
    if (inPattern(item)) return null
    const subject = ctx.subjectOfItem(item)!
    if (item.ref.type === 'segment') {
      const seg = board.segments[item.ref.index]
      return { item, subject, layer: seg.layer, width: seg.width, seg }
    }
    if (item.ref.type === 'tarc') {
      const arc = board.trackArcs[item.ref.index]
      return { item, subject, layer: arc.layer, width: arc.width, arc }
    }
    return null
  }
  const lengthOf = (item: CopperItem): number => {
    if (item.ref.type === 'segment') {
      const s = board.segments[item.ref.index]
      return Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)
    }
    if (item.ref.type === 'tarc') {
      const a = board.trackArcs[item.ref.index]
      return arcPieceLength(a.start, a.mid, a.end)
    }
    return 0
  }
  /** Whether anything stands on the line from one half to the other, bar what joins the coupled stretch. */
  const blocked = (
    from: NmPt,
    to: NmPt,
    layer: string,
    excluded: (other: CopperItem) => boolean
  ): boolean => {
    const a = toWorld(from)
    const b = toWorld(to)
    const line: CopperShape = { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 }
    const minX = Math.min(a.x, b.x)
    const minY = Math.min(a.y, b.y)
    const maxX = Math.max(a.x, b.x)
    const maxY = Math.max(a.y, b.y)
    for (const other of copperNear(minX, minY, maxX, maxY)) {
      if (excluded(other)) continue
      const copper = copperOn(other, layer)
      if (copper && shapeToShape(line, copper.shape) === 0) return true
    }
    return false
  }
  /** Whether a point lies on an item's copper, as KiCad's `HitTest` finds it. */
  const hits = (other: CopperItem, p: NmPt, layer: string): boolean => {
    const copper = copperOn(other, layer) ?? { shape: other.shape }
    const w = toWorld(p)
    return shapeToShape({ kind: 'circle', cx: w.x, cy: w.y, r: 0 }, copper.shape) === 0
  }
  const exitsPad = (pad: CopperItem, half: Half, layer: string): boolean => {
    const t = half.seg ?? half.arc!
    return hits(pad, t.start, layer) !== hits(pad, t.end, layer)
  }

  for (const entry of entries.values()) {
    if (tick()) yield
    const halvesP = entry.itemsP.map(halfOf).filter((h): h is Half => !!h)
    const halvesN = entry.itemsN.map(halfOf).filter((h): h is Half => !!h)
    const coupled: Coupled[] = []

    // Straight stretches: exactly parallel segments, each clipped to where the other runs beside it.
    for (const p of halvesP) {
      if (!p.seg) continue
      for (const n of halvesN) {
        if (!n.seg || n.layer !== p.layer) continue
        const sp = { a: big(p.seg.start), b: big(p.seg.end) }
        const sn = { a: big(n.seg.start), b: big(n.seg.end) }
        if (sqLen(sp) <= 2n || sqLen(sn) <= 2n || !strictlyParallel(sp, sn)) continue
        const clip = parallelProjection(sp, sn)
        if (!clip) continue
        const nearest = nearestPoints(clip.p, clip.n)
        const gap =
          Math.trunc(Math.sqrt(Number(nearest.distSq))) - Math.trunc((p.width + n.width) / 2)
        const ends = [clip.n.a, clip.n.b, clip.p.a, clip.p.b].map(toNm)
        const excluded = (other: CopperItem): boolean => {
          if (other.id === p.item.id || other.id === n.item.id) return true
          if (other.ref.type === 'segment' || other.ref.type === 'tarc' || other.ref.type === 'via')
            return ends.some((e) => hits(other, e, p.layer))
          if (other.ref.type === 'pad')
            return exitsPad(other, p, p.layer) || exitsPad(other, n, p.layer)
          return false
        }
        if (blocked(toNm(nearest.n), toNm(nearest.p), p.layer, excluded)) continue
        const length = Math.round(Math.sqrt(Number(sqLen(clip.n))))
        coupled.push({ p, n, length, gap, failMin: false, failMax: false })
      }
    }

    // Curved stretches: arcs round nearly one center, over the angle both sweep.
    for (const p of halvesP) {
      if (!p.arc) continue
      for (const n of halvesN) {
        if (!n.arc || n.layer !== p.layer) continue
        const gp = arcGeometry(p.arc.start, p.arc.mid, p.arc.end)
        const gn = arcGeometry(n.arc.start, n.arc.mid, n.arc.end)
        if (!gp || !gn) continue
        if (lengthOf(p.item) <= 2 || lengthOf(n.item) <= 2) continue
        const dc = (gp.cx - gn.cx) ** 2 + (gp.cy - gn.cy) ** 2
        if (dc >= p.width * p.width) continue
        const clip = arcProjection(p.arc, n.arc)
        if (!clip) continue
        const gap =
          Math.trunc(Math.sqrt(arcArcDistSq(clip.p, clip.n))) - Math.trunc((p.width + n.width) / 2)
        const excluded = (other: CopperItem): boolean => {
          if (other.id === p.item.id || other.id === n.item.id) return true
          if (other.ref.type === 'segment' || other.ref.type === 'tarc' || other.ref.type === 'via')
            return other.net === entry.netP || other.net === entry.netN
          if (other.ref.type === 'pad')
            return exitsPad(other, p, p.layer) || exitsPad(other, n, p.layer)
          return false
        }
        if (blocked(clip.n.mid, clip.p.mid, p.layer, excluded)) continue
        coupled.push({
          p,
          n,
          length: Math.trunc(clip.n.length),
          gap,
          failMin: false,
          failMax: false
        })
      }
    }

    // How much of the longer half runs coupled, within the gap rule.
    const seen = new Set<number>()
    let totalN = 0
    let totalP = 0
    for (const item of entry.itemsN)
      if (!inPattern(item) && !seen.has(item.id)) {
        seen.add(item.id)
        totalN = Math.trunc(totalN + lengthOf(item))
      }
    for (const item of entry.itemsP)
      if (!inPattern(item) && !seen.has(item.id)) {
        seen.add(item.id)
        totalP = Math.trunc(totalP + lengthOf(item))
      }
    const nm = (mm: number | undefined): number | undefined =>
      mm === undefined ? undefined : Math.round(mm * 1e6)
    let totalCoupled = 0
    for (const c of coupled) {
      const min = nm(entry.gap?.min)
      const max = nm(entry.gap?.max)
      if (min !== undefined && min >= 0 && c.gap < min - epsilon) c.failMin = true
      if (max !== undefined && max >= 0 && c.gap > max + epsilon) c.failMax = true
      if (!c.failMin && !c.failMax) totalCoupled += c.length
    }
    const uncoupled = Math.max(totalN, totalP) - totalCoupled
    const nameP = getNetName(board, entry.netP)
    const nameN = getNetName(board, entry.netN)

    let uncoupledViolation = false
    const limit = nm(entry.uncoupled?.max)
    if (
      entry.uncoupled &&
      (entry.itemsP.length || entry.itemsN.length) &&
      limit !== undefined &&
      limit >= 0 &&
      uncoupled > limit
    ) {
      uncoupledViolation = true
      const items = [...entry.itemsP, ...entry.itemsN]
      const subjects = items.map((item) => ctx.subjectOfItem(item)!)
      const first = entry.itemsN[0] ?? entry.itemsP[0]
      emit(
        {
          code: 'diff-pair-uncoupled-length',
          severity: 'error',
          message: `The pair ${nameP} / ${nameN} runs ${fmt(uncoupled)} uncoupled; ${entry.uncoupledRule} allows at most ${fmt(limit)}.`,
          measure: {
            actual: nmToMm(uncoupled as Nm),
            limit: nmToMm(limit as Nm),
            bound: 'max',
            unit: 'mm',
            rule: entry.uncoupledRule
          },
          items: [...new Set(subjects.map((s) => s.item))],
          targets: [...new Set(subjects.flatMap((s) => s.targets))],
          kicadIds: [...new Set(subjects.flatMap(idsOf))],
          subject: `${nameP} / ${nameN}`,
          position: at(itemPoint(first)),
          ...ownSeverity(entry.uncoupledSeverity)
        },
        items.map(boxOf)
      )
    }

    if (entry.gap && (uncoupledViolation || !entry.uncoupled)) {
      for (const c of coupled) {
        if (!c.failMin && !c.failMax) continue
        // Held again to the rule these two tracks resolve to, which may be narrower.
        const value = resolver.evaluate(
          'diff_pair_gap',
          ruleSet.copperItem(c.p.item),
          ruleSet.copperItem(c.n.item),
          c.p.layer
        ).value
        const min = nm(value.min)
        const max = nm(value.max)
        const failMin = c.failMin && min !== undefined && min >= 0 && c.gap < min
        const failMax = c.failMax && max !== undefined && max >= 0 && c.gap > max
        if (!failMin && !failMax) continue
        emit(
          {
            code: 'diff-pair-gap',
            severity: 'error',
            message: `The pair ${nameP} / ${nameN} runs ${fmt(c.gap)} apart; ${entry.gapRule} needs ${failMin ? `at least ${fmt(min!)}` : `at most ${fmt(max!)}`}.`,
            measure: {
              actual: nmToMm(c.gap as Nm),
              limit: nmToMm((failMin ? min! : max!) as Nm),
              bound: failMin ? 'min' : 'max',
              unit: 'mm',
              rule: entry.gapRule
            },
            items: [c.p.subject.item, c.n.subject.item],
            targets: [...new Set([...c.p.subject.targets, ...c.n.subject.targets])],
            kicadIds: [...new Set([...idsOf(c.p.subject), ...idsOf(c.n.subject)])],
            subject: `${c.p.subject.name} · ${c.n.subject.name}`,
            position: at(itemPoint(c.n.item)),
            ...ownSeverity(entry.gapSeverity)
          },
          [boxOf(c.p.item), boxOf(c.n.item)]
        )
      }
    }
  }

  function itemPoint(item: CopperItem): Pt {
    if (item.ref.type === 'segment') return worldOf(board.segments[item.ref.index].start)
    if (item.ref.type === 'tarc') return worldOf(board.trackArcs[item.ref.index].start)
    return worldOf(board.vias[item.ref.index].position)
  }
}

/** The uuids of every item a tuning pattern generated (`(generated (type tuning_pattern) (members …))`). */
function tuningMembers(board: KicadBoard): Set<string> {
  const out = new Set<string>()
  if (board._raw.type !== 'list') return out
  for (const node of findChildren(board._raw, 'generated')) {
    const type = findChild(node, 'type')
    if (!type || getAtomValues(type)[0] !== 'tuning_pattern') continue
    const members = findChild(node, 'members')
    for (const uuid of members ? getAtomValues(members) : []) out.add(uuid)
  }
  return out
}

const fmt = (nm: number): string => `${nmToMm(nm as Nm).toFixed(4)} mm`

const boxOf = (item: CopperItem): Box => ({
  minX: item.minX,
  minY: item.minY,
  maxX: item.maxX,
  maxY: item.maxY
})

/** A user rule by its own name, as KiCad names a pair's rule; an implicit one as it reads. */
const ruleName = (rule: Rule | null, fallback: string): string =>
  rule && rule.implicit === null ? rule.name.replace(/^rule '(.*)'$/, '$1') : fallback

const toWorld = (p: NmPt): Pt => ({ x: p.x / 1e6, y: -p.y / 1e6 })

// ---- Integer segment geometry, as KiCad's `SEG` computes it ----------------------

interface BigPt {
  x: bigint
  y: bigint
}
interface BigSeg {
  a: BigPt
  b: BigPt
}

const big = (p: { x: number; y: number }): BigPt => ({ x: BigInt(p.x), y: BigInt(p.y) })
const toNm = (p: BigPt): NmPt => ({ x: Number(p.x), y: Number(p.y) })
const sub = (p: BigPt, q: BigPt): BigPt => ({ x: p.x - q.x, y: p.y - q.y })
const dot = (p: BigPt, q: BigPt): bigint => p.x * q.x + p.y * q.y
const cross = (p: BigPt, q: BigPt): bigint => p.x * q.y - p.y * q.x
const sqLen = (s: BigSeg): bigint => dot(sub(s.b, s.a), sub(s.b, s.a))

/** `a * b / c` rounded half away from zero, as KiCad's `rescale`. */
function rescale(a: bigint, b: bigint, c: bigint): bigint {
  const n = a * b
  const negative = n < 0n !== c < 0n
  const an = n < 0n ? -n : n
  const ac = c < 0n ? -c : c
  const q = (an + ac / 2n) / ac
  return negative ? -q : q
}

const INT_MAX = 2147483647n
const INT_MIN = -2147483648n

/**
 * Whether two segments' lines never meet, as KiCad's `SEG::Intersect` finds
 * with lines: parallel and apart, or so nearly parallel that they meet beyond
 * the coordinate range (which KiCad reports as no intersection).
 */
function strictlyParallel(p: BigSeg, n: BigSeg): boolean {
  const d1 = sub(p.b, p.a)
  const d2 = sub(n.b, n.a)
  const offset = sub(n.a, p.a)
  const determinant = cross(d2, d1)
  if (determinant === 0n) return cross(d1, offset) !== 0n
  const t = cross(d1, offset)
  const x = n.a.x + rescale(t, d2.x, determinant)
  const y = n.a.y + rescale(t, d2.y, determinant)
  return x > INT_MAX || x < INT_MIN || y > INT_MAX || y < INT_MIN
}

/** A point projected onto a segment's line (`SEG::LineProject`). */
function lineProject(s: BigSeg, q: BigPt): BigPt {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d)
  if (l2 === 0n) return s.a
  const t = dot(d, sub(q, s.a))
  return { x: s.a.x + rescale(t, d.x, l2), y: s.a.y + rescale(t, d.y, l2) }
}

/** Where two parallel segments overlap, each clipped to it; null when they don't. */
function parallelProjection(p: BigSeg, n: BigSeg): { p: BigSeg; n: BigSeg } | null {
  const d = sub(p.b, p.a)
  const tcoef = (q: BigPt): bigint => dot(d, sub(q, p.a))
  const pa = lineProject(p, n.a)
  const pb = lineProject(p, n.b)
  let ta = 0n
  let tb = tcoef(p.b)
  let pta = tcoef(pa)
  let ptb = tcoef(pb)
  if (tb < ta) [ta, tb] = [tb, ta]
  if (ptb < pta) [pta, ptb] = [ptb, pta]
  if (tb <= pta || ta >= ptb) return null
  const tv = [0n, tcoef(p.b), tcoef(pa), tcoef(pb)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  const len2 = dot(d, d)
  const clipA = { x: p.a.x + rescale(d.x, tv[1], len2), y: p.a.y + rescale(d.y, tv[1], len2) }
  const clipB = { x: p.a.x + rescale(d.x, tv[2], len2), y: p.a.y + rescale(d.y, tv[2], len2) }
  return {
    p: { a: clipA, b: clipB },
    n: { a: lineProject(n, clipA), b: lineProject(n, clipB) }
  }
}

/** The nearest point of a segment to a point, rounded (`SEG::NearestPoint`). */
function nearestOn(s: BigSeg, q: BigPt): BigPt {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d)
  if (l2 === 0n) return s.a
  const t = dot(d, sub(q, s.a))
  if (t <= 0n) return s.a
  if (t >= l2) return s.b
  return { x: s.a.x + rescale(t, d.x, l2), y: s.a.y + rescale(t, d.y, l2) }
}

/** The nearest pair of points between two segments that do not meet (`SEG::NearestPoints`). */
function nearestPoints(p: BigSeg, n: BigSeg): { p: BigPt; n: BigPt; distSq: bigint } {
  const candidates: Array<[BigPt, BigPt]> = [
    [p.a, nearestOn(n, p.a)],
    [p.b, nearestOn(n, p.b)],
    [nearestOn(p, n.a), n.a],
    [nearestOn(p, n.b), n.b]
  ]
  let best = candidates[0]
  let bestD = dot(sub(best[1], best[0]), sub(best[1], best[0]))
  for (const c of candidates.slice(1)) {
    const dd = dot(sub(c[1], c[0]), sub(c[1], c[0]))
    if (dd < bestD) {
      best = c
      bestD = dd
    }
  }
  return { p: best[0], n: best[1], distSq: bestD }
}

// ---- Arcs ------------------------------------------------------------------------

/** A clipped arc: its circle, the angles it spans (radians, increasing), its mid and length. */
interface ArcSpan {
  cx: number
  cy: number
  r: number
  from: number
  to: number
  mid: NmPt
  length: number
}

/** KiCad's `PCB_ARC::IsCCW`: the turn from start through mid to end, in file coordinates. */
const isCcw = (arc: KicadTrackArc): boolean =>
  (arc.end.x - arc.start.x) * (arc.mid.y - arc.start.y) -
    (arc.end.y - arc.start.y) * (arc.mid.x - arc.start.x) <
  0

/**
 * Where two arcs round nearly one center sweep the same angles, each clipped
 * to that span; null when they share too little (KiCad's arc
 * `commonParallelProjection`). Angles are the file's, taken from the P arc's start.
 */
function arcProjection(p: KicadTrackArc, n: KicadTrackArc): { p: ArcSpan; n: ArcSpan } | null {
  const gp = arcGeometry(p.start, p.mid, p.end)
  const gn = arcGeometry(n.start, n.mid, n.end)
  if (!gp || !gn) return null
  const ratio = Math.abs(gp.r - gn.r) / Math.max(gp.r, gn.r)
  const centers = Math.hypot(gp.cx - gn.cx, gp.cy - gn.cy)
  if (ratio > 0.5 || centers > Math.max(gp.r, gn.r) * 0.5) return null
  const TAU = 2 * Math.PI
  const norm = (t: number): number => ((t % TAU) + TAU) % TAU
  // Each arc's span, walked with increasing angle.
  const span = (arc: KicadTrackArc, g: { cx: number; cy: number }): [number, number] => {
    const [s, e] = isCcw(arc) ? [arc.start, arc.end] : [arc.end, arc.start]
    return [Math.atan2(s.y - g.cy, s.x - g.cx), Math.atan2(e.y - g.cy, e.x - g.cx)]
  }
  const [ps, pe] = span(p, gp)
  const [ns, ne] = span(n, gn)
  const pEnd = norm(pe - ps)
  const nStart = norm(ns - ps)
  const nEnd = norm(ne - ps)
  if (nStart >= pEnd || nEnd <= 0) return null
  const clipStart = Math.max(0, nStart)
  const clipEnd = Math.min(pEnd, nEnd)
  const total = clipEnd - clipStart
  if (total <= (MIN_PARALLEL_ANGLE * Math.PI) / 180) return null
  const make = (g: { cx: number; cy: number; r: number }): ArcSpan => {
    const from = ps + clipStart
    const to = ps + clipEnd
    const m = (from + to) / 2
    return {
      cx: g.cx,
      cy: g.cy,
      r: g.r,
      from,
      to,
      mid: { x: Math.round(g.cx + g.r * Math.cos(m)), y: Math.round(g.cy + g.r * Math.sin(m)) },
      length: g.r * total
    }
  }
  const clipP = make(gp)
  const clipN = make(gn)
  if (clipP.length < 1 || clipN.length < 1) return null
  return { p: clipP, n: clipN }
}

/** The squared distance between two arc spans' centerlines, nm². */
function arcArcDistSq(a: ArcSpan, b: ArcSpan): number {
  const point = (s: ArcSpan, t: number): NmPt => ({
    x: s.cx + s.r * Math.cos(t),
    y: s.cy + s.r * Math.sin(t)
  })
  const within = (s: ArcSpan, q: NmPt): boolean => {
    const t = Math.atan2(q.y - s.cy, q.x - s.cx)
    const TAU = 2 * Math.PI
    const rel = (((t - s.from) % TAU) + TAU) % TAU
    return rel <= s.to - s.from + 1e-12
  }
  const toCircle = (s: ArcSpan, q: NmPt): NmPt => {
    const d = Math.hypot(q.x - s.cx, q.y - s.cy) || 1
    return { x: s.cx + ((q.x - s.cx) * s.r) / d, y: s.cy + ((q.y - s.cy) * s.r) / d }
  }
  const d2 = (p: NmPt, q: NmPt): number => (p.x - q.x) ** 2 + (p.y - q.y) ** 2
  let best = Infinity
  const endsA = [point(a, a.from), point(a, a.to)]
  const endsB = [point(b, b.from), point(b, b.to)]
  for (const p of endsA) for (const q of endsB) best = Math.min(best, d2(p, q))
  for (const p of endsA) if (within(b, p)) best = Math.min(best, d2(p, toCircle(b, p)))
  for (const q of endsB) if (within(a, q)) best = Math.min(best, d2(q, toCircle(a, q)))
  return best
}
