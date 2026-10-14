import { mmToNm, nmToMm, type Nm } from '../../../kicad/coordinates'
import { pointToShape, type CopperItem, type Pt } from '../../spatialIndex'
import type { DrcContext } from '../context'
import { arcLength, fmt, ownSeverity, worldOf } from '../shared'

/**
 * The track shape rules: the angle two joined segments make (`track_angle`),
 * a segment's or arc's length (`track_segment_length`), and a track ending
 * inside a via but off its center (`track_not_centered_on_via`). The first
 * two ask the project's rules and run only where one sets them.
 */
export function* trackGeometry(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, one, emit, pair, subjectOfItem, itemByRef, near, index, tick, region } =
    ctx
  const inRegion = region ? new Set(ctx.itemsFrom(0).map((item) => item.id)) : null
  const tracks: CopperItem[] = []
  for (const [key, item] of itemByRef) {
    if (!key.startsWith('segment:') && !key.startsWith('tarc:')) continue
    if (inRegion && !inRegion.has(item.id)) continue
    tracks.push(item)
  }
  tracks.sort((a, b) => a.id - b.id)

  const lengthRules = ruleSet.resolver.hasRules('track_segment_length')
  // KiCad meets each joint from both tracks; it is one finding.
  const joints = new Set<string>()
  const angleRules = ruleSet.resolver.hasRules('track_angle')
  const endsOf = (item: CopperItem): [Pt, Pt] => {
    const t =
      item.ref.type === 'segment' ? board.segments[item.ref.index] : board.trackArcs[item.ref.index]
    return [worldOf(t.start), worldOf(t.end)]
  }
  /** Two points one whole-nanometer position, as KiCad compares them. */
  const same = (a: Pt, b: Pt): boolean => mmToNm(a.x) === mmToNm(b.x) && mmToNm(a.y) === mmToNm(b.y)

  for (const item of tracks) {
    if (tick()) yield
    const subject = subjectOfItem(item)!
    const layer = item.layers[0] ?? null
    if (lengthRules) {
      const arc = item.ref.type === 'tarc' ? board.trackArcs[item.ref.index] : null
      const seg = item.ref.type === 'segment' ? board.segments[item.ref.index] : null
      const [a, b] = endsOf(item)
      const length = arc
        ? arcLength(worldOf(arc.start), worldOf(arc.mid), worldOf(arc.end))
        : Math.hypot(b.x - a.x, b.y - a.y)
      const actual = Math.round(mmToNm(length))
      const resolved = ruleSet.resolver.evaluate(
        'track_segment_length',
        ruleSet.copperItem(item),
        null,
        layer
      )
      if (!resolved.isNull && resolved.severity !== 'ignore') {
        const { min, max } = resolved.value
        const at = seg ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a
        const message =
          min !== undefined && actual < mmToNm(min)
            ? `${subject.name} is ${fmt(nmToMm(actual as Nm))} long; ${resolved.implicitMin ? 'board setup constraints' : resolved.name} needs at least ${fmt(min)}.`
            : max !== undefined && actual > mmToNm(max)
              ? `${subject.name} is ${fmt(nmToMm(actual as Nm))} long; ${resolved.name} allows at most ${fmt(max)}.`
              : null
        const short = min !== undefined && actual < mmToNm(min)
        if (message)
          one('track-segment-length', 'error', message, subject, at, [item], resolved.severity, {
            measure: {
              actual: nmToMm(actual as Nm),
              limit: (short ? min : max)!,
              bound: short ? 'min' : 'max',
              unit: 'mm',
              rule: short && resolved.implicitMin ? 'board setup constraints' : resolved.name
            }
          })
      }
    }

    // The tracks and vias joined to this one: an end of one inside the other.
    const joined = index
      .query(item.minX, item.minY, item.maxX, item.maxY)
      .filter((other) => other.id !== item.id && other.net === item.net)
    const [start, end] = endsOf(item)
    const within = (p: Pt, other: CopperItem): boolean => pointToShape(other.shape, p.x, p.y) <= 0

    if (angleRules && item.ref.type === 'segment') {
      for (const other of joined) {
        if (other.ref.type !== 'segment' || other.layers[0] !== item.layers[0]) continue
        const [c, d] = endsOf(other)
        if (!within(c, item) && !within(d, item) && !within(start, other) && !within(end, other))
          continue
        const joint = item.id < other.id ? `${item.id}:${other.id}` : `${other.id}:${item.id}`
        if (joints.has(joint)) continue
        joints.add(joint)
        const p0 = intersection(start, end, c, d)
        if (!p0) continue
        // A joint on a pad is the pad's to shape, not the tracks'.
        const onPad = index
          .query(p0.x, p0.y, p0.x, p0.y)
          .some(
            (pad) =>
              pad.ref.type === 'pad' &&
              pad.layers.includes(item.layers[0]) &&
              pointToShape(pad.shape, p0.x, p0.y) <= 0
          )
        if (onPad) continue
        let u = unit(start, end)
        let v = unit(c, d)
        let below90 = false
        if (same(end, p0)) u = { x: -u.x, y: -u.y }
        else if (!same(start, p0)) below90 = true
        if (same(d, p0)) v = { x: -v.x, y: -v.y }
        else if (!same(c, p0)) below90 = true
        let actual = (Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))) * 180) / Math.PI
        if (below90 && actual > 90) actual -= 90
        const resolved = ruleSet.resolver.evaluate(
          'track_angle',
          ruleSet.copperItem(item),
          ruleSet.copperItem(other),
          item.layers[0] ?? null
        )
        if (resolved.isNull || resolved.severity === 'ignore') continue
        const { min, max } = resolved.value
        const limit =
          max !== undefined && actual > max
            ? `at most ${max.toFixed(1)}°`
            : min !== undefined && actual < min
              ? `at least ${min.toFixed(1)}°`
              : null
        if (!limit || !near(item)) continue
        const otherSubject = subjectOfItem(other)!
        emit(
          {
            code: 'track-angle',
            severity: 'error',
            message: `${subject.name} meets ${otherSubject.name} at ${actual.toFixed(1)}°; ${resolved.name} allows ${limit}.`,
            measure:
              max !== undefined && actual > max
                ? { actual, limit: max, bound: 'max', unit: 'deg', rule: resolved.name }
                : { actual, limit: min!, bound: 'min', unit: 'deg', rule: resolved.name },
            position: { x: Math.round(p0.x * 1e4) / 1e4, y: Math.round(-p0.y * 1e4) / 1e4 },
            ...pair(subject, otherSubject),
            ...ownSeverity(resolved.severity)
          },
          [item, other]
        )
      }
    }

    // A track that ends inside a via ends at its center, unless another track on
    // its layer already reaches the center there.
    for (const via of joined) {
      if (via.ref.type !== 'via') continue
      const center = worldOf(board.vias[via.ref.index].position)
      const radius = nmToMm(board.vias[via.ref.index].size) / 2
      const inVia = (p: Pt): boolean => Math.hypot(p.x - center.x, p.y - center.y) <= radius
      const startOff = inVia(start) && !same(start, center)
      const endOff = inVia(end) && !same(end, center)
      if (!startOff && !endOff) continue
      const centered = index.query(center.x, center.y, center.x, center.y).some((other) => {
        if (other.ref.type !== 'segment' && other.ref.type !== 'tarc') return false
        if (other.layers[0] !== item.layers[0] || other.net !== via.net) return false
        const [c, d] = endsOf(other)
        return same(c, center) || same(d, center)
      })
      if (centered) continue
      const viaSubject = subjectOfItem(via)!
      emit(
        {
          code: 'track-not-centered-on-via',
          severity: 'warning',
          message: `${subject.name} ends inside ${viaSubject.name} but not at its center.`,
          position: {
            x: Math.round((startOff ? start : end).x * 1e4) / 1e4,
            y: Math.round(-(startOff ? start : end).y * 1e4) / 1e4
          },
          ...pair(subject, viaSubject)
        },
        [item, via]
      )
      break
    }
  }
}

const unit = (a: Pt, b: Pt): Pt => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
}

/** Where two segments meet, ends included; null when apart or collinear. */
function intersection(p: Pt, q: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: q.x - p.x, y: q.y - p.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-18) return null
  const t = ((c.x - p.x) * s.y - (c.y - p.y) * s.x) / denom
  const u = ((c.x - p.x) * r.y - (c.y - p.y) * r.x) / denom
  const eps = 1e-9
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null
  return { x: p.x + t * r.x, y: p.y + t * r.y }
}
