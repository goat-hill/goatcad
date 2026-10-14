// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A teardrop's outline, as KiCad 10 builds it (pcbnew/teardrop/teardrop_utils.cpp:
 * `computeTeardropPolygon`, `findAnchorPointsOnTrack`, `computeAnchorPoints`,
 * `computeCurvedForRoundShape`, `computeCurvedForRectShape`,
 * `computeChordThroughShape`). Followed step by step, rounding included, since
 * the outline is written to the file and has to be KiCad's. Pure: the board
 * reaches it through `TdTrack` and `TdTarget`. Integer nanometers, y down.
 */
import { intersection as clipIntersection } from '../../geometry/clip'
import { bezierPoly } from './kicadBezier'
import {
  add,
  angleOf,
  circlePolygon,
  convexHull,
  half,
  kiRound,
  norm,
  normD,
  polysContain,
  resize,
  ringArea,
  ringIntersectPolyline,
  ringIntersectSeg,
  rotate,
  same,
  segLength,
  sub,
  toInt,
  truncPt,
  type IPolygon,
  type IPt
} from './kicadMath'
import type { TeardropParams } from './params'

/** A track segment or arc, as the teardrop builder reads it. */
export interface TdTrack {
  arc: boolean
  start: IPt
  end: IPt
  /** An arc's middle point. */
  mid?: IPt
  width: number
  layer: string
  net: number
  uuid: string
  /** Its AST node: what the teardrop belongs to (`owners.ts`). */
  raw: unknown
  /** `PCB_TRACK::GetLength`. */
  length: number
}

/** The pad, via or wider track a teardrop flares into. */
export interface TdTarget {
  kind: 'pad' | 'via' | 'track'
  uuid: string
  /** Its AST node (a pad's own, not its footprint's): what the teardrop belongs to. */
  raw: unknown
  /** `GetPosition()`: a pad's anchor, a via's centre. */
  position: IPt
  /** `TEARDROP_MANAGER::IsRound`. */
  round: (layer: string) => boolean
  /** `TEARDROP_MANAGER::GetWidth`: a via's diameter, a pad's smaller side, a track's width. */
  width: (layer: string) => number
  /** `PAD::TransformShapeToPolygon( ERROR_INSIDE )`; only asked of a pad that is not round. */
  polygon: (layer: string) => IPolygon[]
  /** `HitTest( p, 0 )` on any layer, or `HitTest( p, 0, layer )`. */
  hitTest: (p: IPt, layer?: string) => boolean
  /** `PAD::GetBoundingRadius`. */
  boundingRadius: number
  /** A pad's shape on the layer, for the curved corners. */
  padShape?: (layer: string) => {
    shape: string
    size: IPt
    rotation: number
    cornerRadius: number
  }
}

export interface TdContext {
  maxError: number
  /** `findTouchingTrack`: the longest track on `track`'s layer with an end at `point`. */
  touchingTrack: (track: TdTrack, point: IPt) => { track: TdTrack; atStart: boolean } | null
}

const INT_MAX = 2147483647
const OFFSET = 1000 // pcbIUScale.mmToIU( 0.001 )

const unit = (v: IPt): IPt => {
  const n = normD(v)
  return { x: v.x / n, y: v.y / n }
}

function shapeOf(target: TdTarget, layer: string, maxError: number): IPolygon[] {
  if (target.round(layer))
    return [
      {
        outline: circlePolygon(target.position, toInt(target.width(layer) / 2), maxError),
        holes: []
      }
    ]
  return target.polygon(layer)
}

/** `SHAPE_ARC::ConvertToPolyline( maxError )` for a track arc. */
export type ArcPolyline = (track: TdTrack, reversed: boolean) => IPt[]

/** `computeChordThroughShape`: the copper span of the track's line through the shape. */
export function chordThroughShape(
  track: TdTrack,
  target: TdTarget,
  layer: string,
  inside: IPt,
  maxError: number
): number {
  if (track.arc) return INT_MAX
  const delta = sub(track.end, track.start)
  const len = normD(delta)
  if (len === 0) return INT_MAX
  const shape = shapeOf(target, layer, maxError)
  const dir = { x: delta.x / len, y: delta.y / len }
  const mid = half(add(track.start, track.end))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const poly of shape)
    for (const p of poly.outline) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  const reach = kiRound(norm({ x: maxX - minX, y: maxY - minY }) + len)
  const step = { x: kiRound(dir.x * reach), y: kiRound(dir.y * reach) }
  const extStart = sub(mid, step)
  const extEnd = add(mid, step)
  const hits: IPt[] = []
  for (const poly of shape)
    for (const ring of [poly.outline, ...poly.holes])
      hits.push(...ringIntersectSeg(ring, extStart, extEnd))
  if (hits.length < 2) return INT_MAX
  const proj = hits
    .map((h) => (h.x - extStart.x) * dir.x + (h.y - extStart.y) * dir.y)
    .sort((a, b) => a - b)
  const insideProj = (inside.x - extStart.x) * dir.x + (inside.y - extStart.y) * dir.y
  for (let i = 0; i + 1 < proj.length; i++) {
    const m = (proj[i] + proj[i + 1]) / 2
    const spanMid = add(extStart, { x: kiRound(dir.x * m), y: kiRound(dir.y * m) })
    if (!polysContain(shape, spanMid)) continue
    if (insideProj >= proj[i] && insideProj <= proj[i + 1]) return kiRound(proj[i + 1] - proj[i])
  }
  return INT_MAX
}

interface Anchors {
  start: IPt
  end: IPt
  intersection: IPt
  track: TdTrack
  length: number
}

/** `findAnchorPointsOnTrack`. */
function findAnchorPointsOnTrack(
  params: TeardropParams,
  track0: TdTrack,
  other: TdTarget,
  otherPos: IPt,
  ctx: TdContext,
  arcPolyline: ArcPolyline
): Anchors | null {
  let track = track0
  let start = track.start
  let end = track.end
  const layer = track.layer
  const radius = toInt(other.width(layer) / 2)
  let targetLength = kiRound(other.width(layer) * params.bestLengthRatio)
  if (params.maxLength > 0) targetLength = Math.min(params.maxLength, targetLength)
  let needSwap = false
  if (!other.hitTest(start)) {
    ;[start, end] = [end, start]
    needSwap = true
  }
  const shape = other.round(layer)
    ? [{ outline: circlePolygon(otherPos, radius, ctx.maxError), holes: [] }]
    : other.polygon(layer)
  if (shape.length === 0) return null
  const outline = shape[0].outline
  const hits = track.arc
    ? ringIntersectPolyline(outline, arcPolyline(track, false))
    : ringIntersectSeg(outline, start, end)
  if (hits.length < 1) return null
  const intersection = hits[0]
  start = intersection
  let actual = Math.min(targetLength, segLength(start, end))
  const ref = start

  if (actual < targetLength && params.allowTwoSegments) {
    let consumed = 0
    while (actual + consumed < targetLength) {
      const touching = ctx.touchingTrack(track, end)
      if (!touching) break
      const firstDir = unit(sub(end, ref))
      const next = touching.track
      const secondDir = unit(
        touching.atStart ? sub(next.end, next.start) : sub(next.start, next.end)
      )
      if (firstDir.x * secondDir.x + firstDir.y * secondDir.y < 0.5) break
      consumed += actual
      actual = Math.min(targetLength - consumed, toInt(next.length))
      track = next
      end = next.end
      start = next.start
      needSwap = false
      if (!touching.atStart) {
        ;[start, end] = [end, start]
        needSwap = true
      }
      break
    }
  }

  if (track.arc) {
    const poly = arcPolyline(track, needSwap)
    if (poly.length > 2) {
      for (let i = poly.length - 1; i >= 0; i--) {
        const dist = norm(sub(poly[i], start))
        if (dist < actual || i === 0) {
          start = poly[i]
          if (i < poly.length - 1) end = poly[i + 1]
          actual -= norm(sub(start, ref))
          if (actual < 0) actual = 0
          actual = Math.min(actual, norm(sub(end, start)))
          break
        }
      }
    }
  }
  return { start, end, intersection, track, length: actual }
}

/** `computeAnchorPoints`: C and E on the target's outline, from the hull of A, B and the shape. */
function computeAnchorPoints(
  params: TeardropParams,
  layer: string,
  item: TdTarget,
  pos: IPt,
  pts: IPt[],
  maxError: number
): boolean {
  let preferred = kiRound(item.width(layer) * params.bestWidthRatio)
  let forceClip = params.bestWidthRatio < 1
  let shape: IPolygon[]
  if (item.round(layer))
    shape = [{ outline: circlePolygon(pos, toInt(item.width(layer) / 2), maxError), holes: [] }]
  else {
    if (item.kind !== 'pad') return false
    forceClip = true
    preferred = kiRound(item.width(layer) * params.bestWidthRatio)
    shape = item.polygon(layer)
  }
  if (forceClip || (params.maxWidth > 0 && params.maxWidth < preferred)) {
    const halfSize = toInt(Math.min(params.maxWidth, preferred) / 2)
    const refOnTrack = half(add(pts[0], pts[1]))
    const axis = sub(pts[3], refOnTrack)
    const orient = angleOf(axis)
    const len = norm(axis)
    const rect = [
      { x: 0, y: -halfSize },
      { x: 0, y: halfSize },
      { x: len, y: halfSize },
      { x: len, y: -halfSize }
    ].map((p) => add(rotate(p, -orient), refOnTrack))
    const clipped = shape.length > 0 ? clipToRect(shape[0].outline, rect) : null
    shape = clipped ? [{ outline: clipped, holes: [] }] : []
  }
  if (shape.length === 0) return false
  const initial = [pts[0], pts[1], ...shape[0].outline]
  const hull = convexHull(initial)
  let pointC: IPt = { x: 0, y: 0 }
  let pointE: IPt = { x: 0, y: 0 }
  let foundStart = -1
  let foundEnd = -1
  const startPt = pts[0]
  const endPt = pts[1]
  for (let i = 0; i < hull.length; i++) {
    const next = i + 1 >= hull.length ? 0 : i + 1
    const prev = i - 1 < 0 ? hull.length - 1 : i - 1
    if (same(hull[i], startPt)) {
      pointE = !same(hull[next], endPt) ? hull[next] : hull[prev]
      foundStart = i
    }
    if (same(hull[i], endPt)) {
      pointC = !same(hull[next], startPt) ? hull[next] : hull[prev]
      foundEnd = i
    }
  }
  if (foundStart < 0) pointE = hull[foundEnd - 1 < 0 ? hull.length - 1 : foundEnd - 1]
  if (foundEnd < 0) pointC = hull[foundStart - 1 < 0 ? hull.length - 1 : foundStart - 1]
  pts[2] = pointC
  pts[4] = pointE
  const area1 = Math.abs(ringArea(pts))
  ;[pts[2], pts[4]] = [pts[4], pts[2]]
  const area2 = Math.abs(ringArea(pts))
  if (area1 > area2) [pts[2], pts[4]] = [pts[4], pts[2]]
  return true
}

/** `SHAPE_POLY_SET::BooleanIntersection` with the width rectangle, back on the integer grid. */
function clipToRect(shape: readonly IPt[], rect: readonly IPt[]): IPt[] | null {
  const toMm = (p: IPt): { x: number; y: number } => ({ x: p.x / 1e6, y: p.y / 1e6 })
  const out = clipIntersection(
    [{ outer: shape.map(toMm), holes: [] }],
    [{ outer: rect.map(toMm), holes: [] }]
  )
  return out.length > 0
    ? out[0].outer.map((p) => ({ x: Math.round(p.x * 1e6), y: Math.round(p.y * 1e6) }))
    : null
}

/** `computeCurvedForRoundShape`. */
function curvedForRound(
  params: TeardropParams,
  out: IPt[],
  layer: string,
  trackHalfWidth: number,
  trackDir: IPt,
  other: TdTarget,
  otherPos: IPt,
  pts: IPt[],
  maxError: number
): void {
  let vpercent = params.bestWidthRatio
  const tdHeight = kiRound(other.width(layer) * vpercent)
  if (params.maxWidth > 0 && params.maxWidth < tdHeight) vpercent *= params.maxWidth / tdHeight
  let radius = toInt(other.width(layer) / 2)
  if (radius === 0) radius = 1
  const minVpercent = trackHalfWidth / radius
  const weaken = (vpercent - minVpercent) / (1 - minVpercent) / radius
  let vecC = sub(pts[2], otherPos)
  const distC = norm(vecC)
  if (distC > 0 && Math.abs(distC - radius) > maxError) {
    pts[2] = add(otherPos, resize(vecC, radius))
    vecC = sub(pts[2], otherPos)
  }
  let vecE = sub(pts[4], otherPos)
  const distE = norm(vecE)
  if (distE > 0 && Math.abs(distE - radius) > maxError) {
    pts[4] = add(otherPos, resize(vecE, radius))
    vecE = sub(pts[4], otherPos)
  }
  const biasBC = 0.5 * segLength(pts[1], pts[2])
  const biasAE = 0.5 * segLength(pts[4], pts[0])
  const tangentC = truncPt(pts[2].x - vecC.y * biasBC * weaken, pts[2].y + vecC.x * biasBC * weaken)
  const tangentE = truncPt(pts[4].x + vecE.y * biasAE * weaken, pts[4].y - vecE.x * biasAE * weaken)
  const tangentB = truncPt(pts[1].x - trackDir.x * biasBC, pts[1].y - trackDir.y * biasBC)
  const tangentA = truncPt(pts[0].x - trackDir.x * biasAE, pts[0].y - trackDir.y * biasAE)
  out.push(...bezierPoly(pts[1], tangentB, tangentC, pts[2], maxError))
  out.push(pts[3])
  out.push(...bezierPoly(pts[4], tangentE, tangentA, pts[0], maxError))
}

/** `computeCornerTangentControlPoint`. */
function cornerTangentControl(anchor: IPt, center: IPt, bias: number, desired: IPt): IPt {
  const radial = sub(anchor, center)
  if (normD(radial) === 0) return anchor
  const t1 = { x: radial.y, y: -radial.x }
  const t2 = { x: -radial.y, y: radial.x }
  const dot1 = t1.x * desired.x + t1.y * desired.y
  const dot2 = t2.x * desired.x + t2.y * desired.y
  return add(anchor, resize(dot1 > dot2 ? t1 : t2, kiRound(bias)))
}

/** `isPointOnOvalEnd`: the cap's centre when the point is past the straight sides. */
function ovalEnd(p: IPt, pos: IPt, size: IPt, rotation: number): IPt | null {
  const local = rotate(sub(p, pos), rotation)
  const halfW = toInt(size.x / 2)
  const halfH = toInt(size.y / 2)
  const radius = Math.min(halfW, halfH)
  let center: IPt
  if (halfW > halfH) {
    const offset = halfW - radius
    if (Math.abs(local.x) <= offset) return null
    center = { x: local.x > 0 ? offset : -offset, y: 0 }
  } else {
    const offset = halfH - radius
    if (Math.abs(local.y) <= offset) return null
    center = { x: 0, y: local.y > 0 ? offset : -offset }
  }
  return add(rotate(center, -rotation), pos)
}

/** `isPointOnRoundedCorner`: the corner arc's centre when the point is in a corner. */
function roundedCorner(p: IPt, pos: IPt, size: IPt, r: number, rotation: number): IPt | null {
  const local = rotate(sub(p, pos), rotation)
  const innerW = toInt(size.x / 2) - r
  const innerH = toInt(size.y / 2) - r
  if (!(Math.abs(local.x) > innerW) || !(Math.abs(local.y) > innerH)) return null
  const center = { x: local.x > 0 ? innerW : -innerW, y: local.y > 0 ? innerH : -innerH }
  return add(rotate(center, -rotation), pos)
}

/** `computeCurvedForRectShape`. */
function curvedForRect(
  out: IPt[],
  pts: IPt[],
  intersection: IPt,
  other: TdTarget,
  otherPos: IPt,
  layer: string,
  maxError: number
): void {
  const side1 = sub(pts[2], pts[1])
  const side2 = sub(pts[4], pts[0])
  const trackDir = sub(intersection, half(add(pts[0], pts[1])))
  const info = other.kind === 'pad' ? other.padShape?.(layer) : undefined
  const isRoundRect = info?.shape === 'roundrect'
  const isOval = info?.shape === 'oval'
  const cornerRadius = isRoundRect ? info.cornerRadius : 0
  const towardTrack = { x: -trackDir.x, y: -trackDir.y }
  const curveCenter = (p: IPt): IPt | null => {
    if (!info) return null
    if (isRoundRect && cornerRadius > 0)
      return roundedCorner(p, otherPos, info.size, cornerRadius, info.rotation)
    if (isOval) return ovalEnd(p, otherPos, info.size, info.rotation)
    return null
  }

  let ctrl1 = add(pts[1], resize(trackDir, toInt(norm(side1) / 4)))
  let ctrl2 = half(add(pts[2], intersection))
  const c2 = curveCenter(pts[2])
  if (c2) ctrl2 = cornerTangentControl(pts[2], c2, 0.5 * norm(side1), towardTrack)
  out.push(...bezierPoly(pts[1], ctrl1, ctrl2, pts[2], maxError))
  out.push(pts[3])

  ctrl1 = half(add(pts[4], intersection))
  const c4 = curveCenter(pts[4])
  if (c4) ctrl1 = cornerTangentControl(pts[4], c4, 0.5 * norm(side2), towardTrack)
  ctrl2 = add(pts[0], resize(trackDir, toInt(norm(side2) / 4)))
  out.push(...bezierPoly(pts[4], ctrl1, ctrl2, pts[0], maxError))
}

/** `computeTeardropPolygon`: the outline, or null when no teardrop fits. */
export function teardropPolygon(
  params: TeardropParams,
  track0: TdTrack,
  other: TdTarget,
  otherPos: IPt,
  ctx: TdContext,
  arcPolyline: ArcPolyline
): { outline: IPt[]; spans: TdTrack | null } | null {
  const anchors = findAnchorPointsOnTrack(params, track0, other, otherPos, ctx, arcPolyline)
  if (!anchors) return null
  const { start, end, intersection, track } = anchors
  const stubLen = anchors.length
  if (same(start, end)) return null
  const vecT = unit(sub(end, start))
  const twoSegments = track !== track0
  let vecVia = vecT
  if (twoSegments && !same(start, intersection)) vecVia = unit(sub(start, intersection))

  const halfWidth = toInt(track.width / 2)
  const pointB = add(
    start,
    truncPt(vecT.x * stubLen + vecT.y * halfWidth, vecT.y * stubLen - vecT.x * halfWidth)
  )
  const pointA = add(
    start,
    truncPt(vecT.x * stubLen - vecT.y * halfWidth, vecT.y * stubLen + vecT.x * halfWidth)
  )
  const layer = track.layer
  const round = other.round(layer)
  if (!round && (other.hitTest(pointA, layer) || other.hitTest(pointB, layer))) return null

  const padRadius = toInt(other.width(layer) / 2)
  const intToPad = sub(otherPos, intersection)
  const projOnTrack = -(intToPad.x * vecVia.x + intToPad.y * vecVia.y)
  const isCustomPad = other.kind === 'pad' && other.padShape?.(layer).shape === 'custom'
  let effectiveDist = isCustomPad ? padRadius : Math.max(projOnTrack, padRadius)

  if (!round && other.kind === 'pad') {
    const padPoly = other.polygon(layer)
    const reach = effectiveDist + 2 * other.boundingRadius + OFFSET
    const rayEnd = add(intersection, {
      x: kiRound(-vecVia.x * reach),
      y: kiRound(-vecVia.y * reach)
    })
    const crossings: number[] = []
    for (const poly of padPoly)
      for (const ring of [poly.outline, ...poly.holes])
        for (const hit of ringIntersectSeg(ring, intersection, rayEnd)) {
          const d = norm(sub(hit, intersection))
          if (d > OFFSET) crossings.push(d)
        }
    crossings.sort((a, b) => a - b)
    let exitEdge = 0
    for (const d of crossings) {
      const probe = add(intersection, {
        x: kiRound(-vecVia.x * (d + OFFSET)),
        y: kiRound(-vecVia.y * (d + OFFSET))
      })
      if (!polysContain(padPoly, probe)) {
        exitEdge = d
        break
      }
    }
    effectiveDist = Math.min(effectiveDist, Math.max(0, exitEdge - 2 * OFFSET))
  } else {
    const R = padRadius
    const distCenterSq = intToPad.x * intToPad.x + intToPad.y * intToPad.y
    const disc = projOnTrack * projOnTrack - (distCenterSq - R * R)
    if (disc >= 0) {
      const maxAllowed = Math.max(0, projOnTrack + Math.sqrt(disc) - 2 * OFFSET)
      if (effectiveDist > maxAllowed) effectiveDist = maxAllowed
    }
  }

  const pointD = add(intersection, {
    x: kiRound(-vecVia.x * (effectiveDist + OFFSET)),
    y: kiRound(-vecVia.y * (effectiveDist + OFFSET))
  })

  let jB2: IPt = { x: 0, y: 0 }
  let jB1: IPt = { x: 0, y: 0 }
  let jA2: IPt = { x: 0, y: 0 }
  let jA1: IPt = { x: 0, y: 0 }
  let skipA = false
  let skipB = false
  if (twoSegments) {
    jB2 = add(start, { x: kiRound(vecT.y * halfWidth), y: kiRound(-vecT.x * halfWidth) })
    jA2 = add(start, { x: kiRound(-vecT.y * halfWidth), y: kiRound(vecT.x * halfWidth) })
    jB1 = add(start, { x: kiRound(vecVia.y * halfWidth), y: kiRound(-vecVia.x * halfWidth) })
    jA1 = add(start, { x: kiRound(-vecVia.y * halfWidth), y: kiRound(vecVia.x * halfWidth) })
    const transA = sub(jA2, jA1)
    const anchorA = sub(pointA, jA1)
    skipA = transA.x * anchorA.x + transA.y * anchorA.y < 0
    const transB = sub(jB2, jB1)
    const anchorB = sub(pointB, jB1)
    skipB = transB.x * anchorB.x + transB.y * anchorB.y < 0
  }

  const pts: IPt[] = [
    twoSegments ? jA1 : pointA,
    twoSegments ? jB1 : pointB,
    { x: 0, y: 0 },
    pointD,
    { x: 0, y: 0 }
  ]
  computeAnchorPoints(params, layer, other, otherPos, pts, ctx.maxError)

  if (round) {
    const perpVia = { x: -vecVia.y, y: vecVia.x }
    const padOffset = sub(otherPos, intersection)
    const perpDist = padOffset.x * perpVia.x + padOffset.y * perpVia.y
    if (Math.abs(perpDist) > padRadius * 0.1) {
      const d = Math.abs(perpDist)
      if (d < padRadius) {
        const maxSymmetric = padRadius - d
        const preferred = kiRound(other.width(layer) * params.bestWidthRatio)
        let maxHalf = toInt(preferred / 2)
        if (params.maxWidth > 0) maxHalf = Math.min(maxHalf, toInt(params.maxWidth / 2))
        const symHalf = Math.min(maxSymmetric, maxHalf)
        if (symHalf > halfWidth) {
          const R = padRadius
          const along = padOffset.x * vecVia.x + padOffset.y * vecVia.y
          const lineAt = (perp: number): IPt => {
            const origin = {
              x: intersection.x + vecVia.x * along + perpVia.x * perp,
              y: intersection.y + vecVia.y * along + perpVia.y * perp
            }
            const oc = { x: origin.x - otherPos.x, y: origin.y - otherPos.y }
            const b = oc.x * vecVia.x + oc.y * vecVia.y
            const c = oc.x * oc.x + oc.y * oc.y - R * R
            const disc = b * b - c
            if (disc < 0) return { x: kiRound(origin.x), y: kiRound(origin.y) }
            const s = Math.sqrt(disc)
            const p1 = { x: origin.x + vecVia.x * (-b - s), y: origin.y + vecVia.y * (-b - s) }
            const p2 = { x: origin.x + vecVia.x * (-b + s), y: origin.y + vecVia.y * (-b + s) }
            const d1 = Math.hypot(p1.x - intersection.x, p1.y - intersection.y)
            const d2 = Math.hypot(p2.x - intersection.x, p2.y - intersection.y)
            const p = d1 < d2 ? p1 : p2
            return { x: kiRound(p.x), y: kiRound(p.y) }
          }
          pts[2] = lineAt(-symHalf)
          pts[4] = lineAt(symHalf)
        }
      }
    }
  }

  const corners: IPt[] = []
  if (!params.curvedEdges) {
    if (!twoSegments) return { outline: pts, spans: null }
    corners.push(pointA, pointB)
    if (!skipB) corners.push(jB2)
    corners.push(pts[1], pts[2], pts[3], pts[4], pts[0])
    if (!skipA) corners.push(jA2)
    return { outline: corners, spans: track }
  }

  const curve: IPt[] = []
  if (round)
    curvedForRound(
      params,
      curve,
      layer,
      halfWidth,
      twoSegments ? vecVia : vecT,
      other,
      otherPos,
      pts,
      ctx.maxError
    )
  else curvedForRect(curve, pts, intersection, other, otherPos, layer, ctx.maxError)
  if (!twoSegments) return { outline: curve, spans: null }
  corners.push(pointB)
  if (!skipB) corners.push(jB2)
  corners.push(...curve)
  if (!skipA) corners.push(jA2)
  corners.push(pointA)
  return { outline: corners, spans: track }
}
