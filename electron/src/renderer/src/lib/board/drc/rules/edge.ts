import { mmToNm, nmToMm } from '../../../kicad/coordinates'
import { EDGE_CUTS } from '../../../engine/board3d/boardOutline'
import { boardEdgeShapes } from '../../outlineShapes'
import { outlineProblems } from '../../outlineValidation'
import {
  ANY_LAYER,
  padHoleShape,
  pointToShape,
  shapeOn,
  segmentToShape,
  type Pt
} from '../../spatialIndex'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import { padProperty } from '../../../footprint/klc'
import type { RuleItem } from '../../rules/constraints'
import { boxesTouch, segmentDistance } from '../../../geometry/polygon'
import type { DrcContext, Required } from '../context'
import {
  DRC_EPSILON,
  OUTLINE_PROBLEM,
  fmt,
  at,
  idsOf,
  ownSeverity,
  type Capsule,
  nearestPoint,
  edgesNear,
  type FillRing
} from '../shared'

/** KiCad's board outline `chainingEpsilon` (mm): how far apart edge ends may be and still join. */
const OUTLINE_JOIN = nmToMm(mmToNm(0.01))

export function* edge(ctx: DrcContext): Generator<void> {
  const {
    emit,
    ruleSet,
    copperOf,
    drawingId,
    drawingSet,
    layerIndex,
    itemOf,
    sideOf,
    fills,
    board,
    index,
    tick
  } = ctx
  // Every problem with the outline, one finding each, as KiCad's outline
  // check reports them (`outlineValidation.ts`); a board with no edges at all, one.
  const shapes = boardEdgeShapes(board)
  const problems =
    shapes.all.length > 0
      ? outlineProblems(shapes.outline, { epsilon: OUTLINE_JOIN, board: { all: shapes.all } })
      : null
  for (const problem of problems ?? [null])
    emit(
      {
        code: 'invalid-outline',
        severity: 'error',
        message: problem
          ? `The Edge.Cuts outline ${OUTLINE_PROBLEM[problem.reason]}.`
          : 'No edges were found on the Edge.Cuts layer.',
        items: problem ? problem.shapes.map((id) => drawingId(id, undefined) ?? id) : ['Edge.Cuts'],
        targets: problem ? [...problem.shapes] : [],
        subject: 'Edge.Cuts',
        ...(problem ? { position: at(problem.at), detail: OUTLINE_PROBLEM[problem.reason] } : {})
      },
      []
    )
  // The search reaches as far as any rule asks; each item is held to its own.
  const edgeClearance = ruleSet.resolver.worst('edge_clearance')
  // Each edge as the rules see it: the drawing it is part of, so a rule may
  // name it (`A.memberOfGroup('board_edge')`).
  const edgeItems = new Map<string, RuleItem>()
  const edgeItemOf = (uuid?: string, fp?: number): RuleItem => {
    const key = `${uuid ?? ''}|${fp ?? ''}`
    let item = edgeItems.get(key)
    if (!item) {
      item = {
        kind: 'graphic',
        label: 'Edge.Cuts',
        layers: ['Edge.Cuts'],
        nonCopper: true,
        ...(fp !== undefined ? ruleSet.ownerOf(fp) : {}),
        ...(uuid ? { uuid } : {})
      }
      edgeItems.set(key, item)
    }
    return item
  }
  const edgeRule = (edge: RuleItem, item: RuleItem): Required | null => {
    const resolved = ruleSet.resolver.evaluate('edge_clearance', edge, item, null)
    if (resolved.isNull || resolved.severity === 'ignore') return null
    return {
      value: resolved.value.min ?? 0,
      rule: resolved.implicitMin ? 'board setup constraints edge' : resolved.name,
      ...(resolved.severity ? { severity: resolved.severity } : {})
    }
  }
  // A clearance of 0 still forbids touching or crossing the edge: KiCad collides at 0.
  if (edgeClearance >= 0) {
    // Every Edge.Cuts shape counts, closed outline or not, as a centerline
    // with no width. A track or arc is reported against each edge shape it
    // comes too close to (KiCad, with every track error reported); anything
    // else once, at its nearest approach.
    const nearest = new Map<
      string,
      { id: number; actual: number; edge: Capsule; edgeId: string; rule: Required }
    >()
    const edges = layerIndex.layer(EDGE_CUTS).items.map((edge, i) => ({
      ends: edge.ends!,
      edgeId: drawingId(edge.uuid, edge.fp) ?? EDGE_CUTS,
      rule: edgeItemOf(edge.uuid, edge.fp),
      shape: `${edge.uuid ?? `edge:${i}`}#${edge.piece ?? 0}`
    }))
    // A track may meet the edge inside a castellated pad's hole, which the edge cuts by design.
    const castellated = board.footprints.flatMap((bfp) => {
      const tf = footprintTransform(bfp)
      return bfp.footprint.pads.flatMap((pad) => {
        if (padProperty(pad._raw) !== 'pad_prop_castellated') return []
        return padHoleShape(pad, tfPoint(tf, pad.position.x, pad.position.y)) ?? []
      })
    })
    const isTrack = (id: number): boolean => {
      const type = itemOf(id).ref.type
      return type === 'segment' || type === 'tarc'
    }
    for (const { ends, edgeId, rule: edgeSide, shape } of edges) {
      const [p, q] = ends
      if (tick()) yield
      for (const hit of index.nearSegment(p.x, p.y, q.x, q.y, edgeClearance + 1e-6)) {
        const a = copperOf.get(hit.item.id)!
        if (!a.copper || !a.edgeTested) continue
        const actual = segmentToShape(shapeOn(hit.item, ANY_LAYER), p.x, p.y, q.x, q.y, 0)
        const rule = edgeRule(edgeSide, sideOf(a))
        if (!rule || (actual > 0 && actual >= rule.value - DRC_EPSILON)) continue
        const edge: Capsule = { kind: 'capsule', x0: p.x, y0: p.y, x1: q.x, y1: q.y, halfWidth: 0 }
        if (castellated.length && isTrack(hit.item.id)) {
          const contact = nearestPoint(edge, shapeOn(hit.item, ANY_LAYER))
          if (castellated.some((hole) => pointToShape(hole, contact.x, contact.y) <= 0)) continue
        }
        const key = isTrack(hit.item.id) ? `${hit.item.id}|${shape}` : `${hit.item.id}`
        const known = nearest.get(key)
        if (known && known.actual <= actual) continue
        nearest.set(key, { id: hit.item.id, actual, edge, edgeId, rule })
      }
      // Copper drawings and text, by their own shapes (`GetEffectiveShape`).
      const reachEdge = edgeClearance + 1e-6
      for (const d of drawingSet.query(
        Math.min(p.x, q.x) - reachEdge,
        Math.min(p.y, q.y) - reachEdge,
        Math.max(p.x, q.x) + reachEdge,
        Math.max(p.y, q.y) + reachEdge
      )) {
        if (!d.inCopperTree) continue
        const actual = segmentToShape(d.shape, p.x, p.y, q.x, q.y, 0)
        const rule = edgeRule(edgeSide, sideOf(copperOf.get(d.id)!))
        if (!rule || (actual > 0 && actual >= rule.value - DRC_EPSILON)) continue
        const known = nearest.get(`${d.id}`)
        if (known && known.actual <= actual) continue
        nearest.set(`${d.id}`, {
          id: d.id,
          actual,
          edge: { kind: 'capsule', x0: p.x, y0: p.y, x1: q.x, y1: q.y, halfWidth: 0 },
          edgeId,
          rule
        })
      }
    }
    for (const { id, actual, edge, edgeId, rule } of nearest.values()) {
      const item = itemOf(id)
      const a = copperOf.get(id)!
      // On the item's layer where it has one, as KiCad reports a track; a via
      // or pad through several is reported once, on none.
      const layer = item.layers.length === 1 ? item.layers[0] : undefined
      emit(
        {
          code: 'copper-edge-clearance',
          severity: 'error',
          message: `${a.subject.name} is ${fmt(actual)} from the board edge; ${rule.rule} needs ${fmt(rule.value)}.`,
          ...(layer ? { layer } : {}),
          measure: { actual, limit: rule.value, bound: 'min', unit: 'mm', rule: rule.rule },
          items: [edgeId, a.subject.item],
          targets: a.subject.targets,
          kicadIds: idsOf(a.subject),
          subject: a.subject.name,
          position: at(nearestPoint(item.shape, edge)),
          ...ownSeverity(rule.severity)
        },
        []
      )
    }
    // A fill against the edge, once per zone and layer at its nearest approach;
    // an edge lying inside the fill (a cutout poured over) is at no distance at
    // all. A layer whose fill meets the same edge shape at the same point as
    // another layer's is that one finding, as KiCad reports an item, edge and
    // point once.
    const nearestZone = new Map<
      string,
      { actual: number; at: Pt; fill: FillRing; rule: Required; shape: string; edgeId: string }
    >()
    for (const fill of fills) {
      if (tick()) yield
      for (const { ends, edgeId, rule: edgeSide, shape } of edges) {
        const [p, q] = ends
        const box = {
          minX: Math.min(p.x, q.x),
          minY: Math.min(p.y, q.y),
          maxX: Math.max(p.x, q.x),
          maxY: Math.max(p.y, q.y)
        }
        if (!boxesTouch(box, fill.box, edgeClearance)) continue
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
        let actual = fill.stripes.contains(mid) ? 0 : Infinity
        let near = mid
        if (actual > 0)
          edgesNear(fill, p, q, edgeClearance, (c, d) => {
            const dist = segmentDistance(p, q, c, d)
            if (dist < actual) {
              actual = dist
              near = closestOnSegment(p, q, c, d)
            }
            return actual === 0
          })
        const rule = edgeRule(edgeSide, fill.side)
        if (!rule || (actual > 0 && actual >= rule.value - DRC_EPSILON)) continue
        const zoneLayer = `${fill.zoneIndex}|${fill.layer}`
        const known = nearestZone.get(zoneLayer)
        if (known && known.actual <= actual) continue
        nearestZone.set(zoneLayer, { actual, at: near, fill, rule, shape, edgeId })
      }
    }
    const emitted = new Set<string>()
    for (const { actual, at: where, fill, rule, shape, edgeId } of nearestZone.values()) {
      const point = `${fill.zoneIndex}|${shape}|${where.x.toFixed(6)},${where.y.toFixed(6)}`
      if (emitted.has(point)) continue
      emitted.add(point)
      emit(
        {
          code: 'copper-edge-clearance',
          severity: 'error',
          message: `${fill.subject.name} is ${fmt(actual)} from the board edge on ${fill.layer}; ${rule.rule} needs ${fmt(rule.value)}. Refill the zone.`,
          measure: { actual, limit: rule.value, bound: 'min', unit: 'mm', rule: rule.rule },
          items: [edgeId, fill.subject.item],
          targets: fill.subject.targets,
          kicadIds: idsOf(fill.subject),
          subject: fill.subject.name,
          position: at(where),
          layer: fill.layer,
          ...ownSeverity(rule.severity)
        },
        []
      )
    }
  }
}

/** Where segment pq comes closest to segment cd: an end of pq, or c or d projected onto it. */
function closestOnSegment(p: Pt, q: Pt, c: Pt, d: Pt): Pt {
  const project = (r: Pt): Pt => {
    const dx = q.x - p.x
    const dy = q.y - p.y
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((r.x - p.x) * dx + (r.y - p.y) * dy) / len))
    return { x: p.x + t * dx, y: p.y + t * dy }
  }
  let best = p
  let bestDistance = Infinity
  for (const candidate of [p, q, project(c), project(d)]) {
    const distance = segmentDistance(candidate, candidate, c, d)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
