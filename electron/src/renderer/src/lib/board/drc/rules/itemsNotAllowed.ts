// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import { allZones } from '../../../kicad/board'
import { sampleArc, shapeCenter, type CopperShape, type Pt } from '../../spatialIndex'
import { boardKeepouts, ringEntersRegion, shapeEntersRegion, type Keepout } from '../../keepouts'
import type { RuleItem, RuleSeverity } from '../../rules/constraints'
import { distanceToSegment } from '../../../geometry/distance'
import {
  boxesTouch,
  pointInRegion,
  regionBoundaryDistance,
  segmentsCrossProperly,
  segmentsCrossing,
  type Region
} from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { layerPieces } from '../pieces'
import { isCopperLayer } from '../../../kicad/layers'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import {
  DRAWING_NAMES,
  DRC_EPSILON,
  worldOf,
  type Subject,
  samplesAlong,
  edgesNear,
  type FillRing
} from '../shared'

export function* itemsNotAllowed(ctx: DrcContext): Generator<void> {
  const {
    footprintSubject,
    zoneSubject,
    one,
    ruleSet,
    copperOf,
    sharesLayer,
    fills,
    courtyards,
    board,
    index,
    tick
  } = ctx
  // KiCad's implicit keepout rules (`drc_test_provider_disallow.cpp`): an item
  // is flagged once, however many areas it enters, except a track, which is
  // flagged per area it crosses. A footprint's own area never flags it.
  const keepouts = boardKeepouts(board)
  // An item flagged once, by an area or a rule, is not flagged again.
  const flagged = new Set<string>()
  if (keepouts.length) {
    const areaName = (k: Keepout): string =>
      k.footprint === null
        ? 'a keepout area'
        : `the keepout area of ${footprintSubject(board.footprints[k.footprint]).name}`
    const flag = (key: string, subject: Subject, k: Keepout, what: string, position: Pt): void => {
      if (flagged.has(key)) return
      flagged.add(key)
      one(
        'items-not-allowed',
        'error',
        `${subject.name} is in ${areaName(k)}, which allows no ${what}.`,
        subject,
        position
      )
    }
    /** A point of the item inside the area, for the marker. */
    const inside = (shape: CopperShape, k: Keepout): Pt => {
      const points =
        shape.kind === 'capsule'
          ? samplesAlong(shape.x0, shape.y0, shape.x1, shape.y1)
          : shape.kind === 'arc'
            ? sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1)
            : [shapeCenter(shape)]
      return points.find((p) => pointInRegion(p, k.region)) ?? points[0]
    }
    /**
     * Where a fill reaches into an area past the epsilon, as KiCad's
     * deflated-area collision: each boundary is cut where it meets the other,
     * and a piece whose middle lies inside the other deeper than the epsilon
     * is an overlap. Only edges near the other shape are cut.
     */
    const fillEnters = (fill: FillRing, k: Keepout): Pt | null => {
      const area = k.region.outer
      const cutAt = (p: Pt, q: Pt, others: Array<[Pt, Pt]>): Pt[] => {
        const ts = [0, 1]
        for (const [c, d] of others) {
          if (!segmentsCrossProperly(p, q, c, d)) continue
          const x = segmentsCrossing(p, q, c, d)
          ts.push(
            Math.abs(q.x - p.x) > Math.abs(q.y - p.y)
              ? (x.x - p.x) / (q.x - p.x)
              : (x.y - p.y) / (q.y - p.y)
          )
        }
        ts.sort((a, b) => a - b)
        return ts.slice(1).map((t, i) => {
          const m = (ts[i] + t) / 2
          return { x: p.x + m * (q.x - p.x), y: p.y + m * (q.y - p.y) }
        })
      }
      const areaEdges: Array<[Pt, Pt]> = area.map((q, i) => [
        area[(i + area.length - 1) % area.length],
        q
      ])
      // The fill's boundary inside the area.
      let hit: Pt | null = null
      edgesNear(
        fill,
        { x: k.box.minX, y: k.box.minY },
        { x: k.box.maxX, y: k.box.maxY },
        0,
        (c, d) => {
          for (const m of cutAt(c, d, areaEdges)) {
            if (pointInRegion(m, k.region) && regionBoundaryDistance(m, k.region) > DRC_EPSILON) {
              hit = m
              return true
            }
          }
          return false
        }
      )
      if (hit) return hit
      // The area's boundary inside the fill (an area the fill surrounds).
      for (const [p, q] of areaEdges) {
        const near: Array<[Pt, Pt]> = []
        edgesNear(fill, p, q, DRC_EPSILON, (c, d) => {
          near.push([c, d])
          return false
        })
        for (const m of cutAt(p, q, near)) {
          if (!fill.stripes.contains(m)) continue
          if (near.every(([c, d]) => distanceToSegment(m, c, d) > DRC_EPSILON)) return m
        }
      }
      return null
    }
    const courtyardOf = new Map(courtyards.map((c) => [c.fp, c]))
    for (let ki = 0; ki < keepouts.length; ki++) {
      const k = keepouts[ki]
      for (const item of index.query(k.box.minX, k.box.minY, k.box.maxX, k.box.maxY)) {
        if (tick()) yield
        const type = item.ref.type
        // An area's "no vias" is through vias only, as KiCad sets it.
        const through = type === 'via' && ruleSet.copperItem(item).viaType === 'through'
        const allowed =
          type === 'pad' ? k.rules.pads : type === 'via' ? k.rules.vias || !through : k.rules.tracks
        if (allowed || !sharesLayer(item.layers, k.layers)) continue
        const key = type === 'segment' || type === 'tarc' ? `${item.id}:${ki}` : `${item.id}`
        if (flagged.has(key) || !shapeEntersRegion(item.shape, k.region, DRC_EPSILON)) continue
        const what = type === 'pad' ? 'pads' : type === 'via' ? 'vias' : 'tracks'
        flag(key, copperOf.get(item.id)!.subject, k, what, inside(item.shape, k))
      }
      if (!k.rules.footprints) {
        const front = k.layers.some((l) => l.startsWith('F.'))
        const back = k.layers.some((l) => l.startsWith('B.'))
        const enters = (regions: Region[]): boolean =>
          regions.length > 0 && ringEntersRegion(regions[0].outer, k.region)
        for (let fpIndex = 0; fpIndex < board.footprints.length; fpIndex++) {
          const courtyard = courtyardOf.get(fpIndex)
          if (fpIndex === k.footprint || !courtyard?.box || !boxesTouch(courtyard.box, k.box))
            continue
          if (!((front && enters(courtyard.front)) || (back && enters(courtyard.back)))) continue
          flag(
            `fp:${fpIndex}`,
            courtyard.subject,
            k,
            'footprints',
            worldOf(board.footprints[fpIndex].position)
          )
        }
      }
      // A teardrop is track copper: an area that forbids tracks forbids it, read by its fill.
      if (!k.rules.tracks) {
        for (const fill of fills) {
          if (tick()) yield
          if (!fill.teardrop) continue
          const key = `zone:${fill.zoneIndex}:${ki}`
          if (flagged.has(key) || !k.layers.includes(fill.layer) || !boxesTouch(fill.box, k.box))
            continue
          const hit = fillEnters(fill, k)
          if (hit) flag(key, fill.subject, k, 'tracks', hit)
        }
      }
      if (!k.rules.copperpour) {
        for (const fill of fills) {
          if (tick()) yield
          if (fill.teardrop) continue
          const key = `zone:${fill.zoneIndex}`
          if (flagged.has(key) || !k.layers.includes(fill.layer) || !boxesTouch(fill.box, k.box))
            continue
          const hit = fillEnters(fill, k)
          if (hit) flag(key, fill.subject, k, 'copper pours', hit)
        }
      }
    }
  }

  // `(constraint disallow …)` in the .kicad_dru (`drc_test_provider_disallow.cpp`):
  // each item asks the rules once as itself and once as its hole.
  if (ruleSet.resolver.hasUserRules('disallow')) {
    const disallowedBy = (ruleItem: RuleItem): { name: string; severity?: RuleSeverity } | null => {
      const rule = ruleSet.resolver.evaluate('disallow', ruleItem, null, null)
      if (!rule.rule || rule.severity === 'ignore' || !rule.value.disallow) return null
      return { name: rule.name, severity: rule.severity }
    }
    const report = (key: string, subject: Subject, ruleItem: RuleItem, at: Pt): void => {
      if (flagged.has(key)) return
      const by =
        disallowedBy(ruleItem) ??
        (ruleItem.hasHole ? disallowedBy({ ...ruleItem, kind: 'hole' }) : null)
      if (!by) return
      flagged.add(key)
      one(
        'items-not-allowed',
        'error',
        `${subject.name} is not allowed here (${by.name}).`,
        subject,
        at,
        [],
        by.severity
      )
    }
    // Every item on the board, as KiCad walks them: tracks and vias, each
    // footprint and every pad of it, graphics and text on any layer, zones.
    for (const item of index.items) {
      if (tick()) yield
      if (item.ref.type === 'pad') continue
      report(
        `${item.id}`,
        copperOf.get(item.id)!.subject,
        ruleSet.copperItem(item),
        shapeCenter(item.shape)
      )
    }
    for (const [fp, bfp] of board.footprints.entries()) {
      if (tick()) yield
      report(
        `footprint:${fp}`,
        ctx.footprintSubject(bfp),
        ruleSet.footprintItem(fp),
        worldOf(bfp.position)
      )
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, index) => {
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        report(
          `pad:${fp}:${index}`,
          ctx.padSubject(bfp, pad, center),
          ruleSet.padItem(fp, index),
          center
        )
      })
    }
    for (const d of ctx.drawings) {
      const copper = copperOf.get(d.id)
      if (copper)
        report(
          `drawing:${d.uuid ?? d.id}`,
          copper.subject,
          ruleSet.copperItem(d),
          shapeCenter(d.shape)
        )
    }
    const { pieceOf } = layerPieces(ctx)
    for (const { name } of board.layers) {
      if (isCopperLayer(name)) continue
      if (tick()) yield
      for (const item of ctx.layerIndex.layer(name).items) {
        if (!(item.kind in DRAWING_NAMES)) continue
        const piece = pieceOf(item)
        if (piece)
          report(
            `drawing:${item.uuid ?? `${name}:${item.id}`}`,
            piece.subject,
            piece.rule,
            shapeCenter(item.shape)
          )
      }
    }
    allZones(board).forEach((zone, zoneIndex) => {
      if (zone.isKeepout || zone.points.length === 0) return
      report(
        `zone:${zoneIndex}`,
        zoneSubject(zone),
        ruleSet.zoneItem(zone),
        worldOf(zone.points[0])
      )
    })
  }
}
