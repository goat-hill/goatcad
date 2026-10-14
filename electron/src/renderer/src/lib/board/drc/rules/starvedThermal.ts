import { padOnLayer, type KicadPad } from '../../../kicad/footprint'
import { findChild, findChildren } from '../../../kicad/sexpr'
import {
  shapeOn,
  padFrame,
  shapeCenter,
  shapeToShape,
  type CopperItem,
  type Pt
} from '../../spatialIndex'
import { CONNECT_EPSILON, itemsConnect } from '../../boardConnectivity'
import { shapeOutlines } from '../../shapeOutline'
import { boxesTouch, pointInRegion, ringBox } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { at, ringCrossings, customPadRing, ownSeverity } from '../shared'

export function* starvedThermal(ctx: DrcContext): Generator<void> {
  const {
    emit,
    sliceDone,
    pair,
    ruleSet,
    copperOf,
    drawingSet,
    copperNear,
    fills,
    itemsNear,
    islandOf,
    board,
    index
  } = ctx
  // Thermal reliefs with too few spokes (`DRC_TEST_PROVIDER_ZONE_CONNECTIONS`):
  // spokes are counted where the fill crosses a ring halfway across the gap.
  // The count a pad owes a zone is the rules' for the pair; the pass runs if any rule asks one.
  if (ruleSet.resolver.worst('min_resolved_spokes') > 0) {
    /** Whether copper of one net joins two items without its zones (`EXCLUDE_ZONES`). */
    const joinedWithoutZones = (from: CopperItem, to: CopperItem): boolean => {
      const seen = new Set([from.id])
      const queue = [from]
      while (queue.length > 0) {
        const item = queue.pop()!
        if (item.id === to.id) return true
        for (const other of copperNear(
          item.minX - CONNECT_EPSILON,
          item.minY - CONNECT_EPSILON,
          item.maxX + CONNECT_EPSILON,
          item.maxY + CONNECT_EPSILON
        )) {
          if (seen.has(other.id) || other.net !== from.net) continue
          if (drawingSet.byId(other.id) && !drawingSet.byId(other.id)!.connected) continue
          if (itemsConnect(board, item, other).length === 0) continue
          seen.add(other.id)
          queue.push(other)
        }
      }
      return false
    }
    const spokeFlagged = new Set<string>()
    for (const fill of fills) {
      if (fill.net <= 0 || fill.teardrop) continue
      const zone = fill.zone
      for (const item of itemsNear(fill.box, 0)) {
        if (sliceDone()) yield
        if (item.ref.type !== 'pad' || item.net !== fill.net || !item.layers.includes(fill.layer))
          continue
        const key = `${item.id}:${fill.zoneIndex}:${fill.layer}`
        if (spokeFlagged.has(key)) continue
        spokeFlagged.add(key)
        const bfp = board.footprints[item.ref.index]
        const pad = bfp.footprint.pads[item.ref.pad]
        // The same answer the filler builds from (`BoardRules.zoneConnection`).
        const connection = ruleSet.zoneConnection(ruleSet.copperItem(item), zone, fill.layer)
        if (connection.style !== 'thermal') continue
        const spokeRule = ruleSet.resolver.evaluate(
          'min_resolved_spokes',
          ruleSet.copperItem(item),
          fill.side,
          fill.layer
        )
        const minSpokes = spokeRule.severity === 'ignore' ? 0 : (spokeRule.value.min ?? 0)
        if (minSpokes <= 0) continue
        const gap = connection.gap
        const padShape = shapeOn(item, fill.layer)
        const ring =
          customPadRing(padOnLayer(pad, fill.layer), padFrame(padShape), gap / 2) ??
          shapeOutlines(padFrame(padShape) ?? padShape, gap / 2)[0]
        const ringBoxed = ringBox(ring)
        // Spokes into an island this pad is the only thing touching join
        // nothing, so they count only when there is nothing else.
        let spokes = 0
        let ignored = 0
        for (const island of fills) {
          if (island.zone !== zone || island.layer !== fill.layer) continue
          if (!boxesTouch(island.box, ringBoxed)) continue
          const crossings = ringCrossings(ring, island)
          if (crossings < 2) continue
          const single = islandOf.get(`${island.zoneIndex}:${island.polyIndex}`)?.connections === 1
          if (single) ignored += Math.floor(crossings / 2)
          else spokes += Math.floor(crossings / 2)
        }
        if (spokes === 0 && ignored === 0) continue
        const padInfo = copperOf.get(item.id)!
        const report = (actual: number, limit: number, custom: boolean): void =>
          emit(
            {
              code: 'starved-thermal',
              severity: 'error',
              message: `${padInfo.subject.name} joins ${fill.subject.name} on ${fill.layer} by ${actual} thermal spoke${actual === 1 ? '' : 's'}; ${custom ? 'its spoke templates ask' : 'the minimum is'} ${limit}.`,
              measure: { actual, limit, bound: 'min', unit: 'count' },
              detail: fill.layer,
              position: at(shapeCenter(item.shape)),
              ...pair(fill.subject, padInfo.subject),
              ...ownSeverity(spokeRule.severity)
            },
            []
          )
        // A custom pad's spoke templates set its count, which only the pour's
        // own spokes meet (KiCad's custom spoke count).
        const templates = spokeTemplateCount(padOnLayer(pad, fill.layer))
        if (templates > 0) {
          if (spokes < templates) report(spokes, templates, true)
          continue
        }
        if (spokes >= minSpokes) continue
        // A track run by hand from the pad into the pour counts as a spoke, on
        // whatever layer it joins the pad: its start inside the ring and its
        // end over the fill, else the reverse.
        const inRing = (p: Pt): boolean => pointInRegion(p, { outer: ring, holes: [] })
        const inFill = (p: Pt): boolean =>
          fills.some((f) => f.zone === zone && f.layer === fill.layer && f.stripes.contains(p))
        for (const track of index.query(
          ringBoxed.minX,
          ringBoxed.minY,
          ringBoxed.maxX,
          ringBoxed.maxY
        )) {
          if (track.net !== fill.net) continue
          const s = track.shape
          if (s.kind !== 'capsule' && s.kind !== 'arc') continue
          const layer = track.layers[0]
          if (!layer || !item.layers.includes(layer)) continue
          if (shapeToShape(s, shapeOn(item, layer)) > CONNECT_EPSILON) continue
          const p = { x: s.x0, y: s.y0 }
          const q = { x: s.x1, y: s.y1 }
          if (inRing(p) ? inFill(q) : inRing(q) && inFill(p)) spokes++
        }
        // A board graphic of the pad's copper counts as KiCad counts it: one of
        // its points in the ring and another in the fill.
        for (const d of drawingSet.query(
          ringBoxed.minX,
          ringBoxed.minY,
          ringBoxed.maxX,
          ringBoxed.maxY
        )) {
          if (!d.connected || d.net !== fill.net || !d.layers.includes(fill.layer)) continue
          const inside = d.anchors.find(inRing)
          if (!inside || !d.anchors.some((p) => p !== inside && inFill(p))) continue
          if (joinedWithoutZones(item, d)) spokes++
        }
        if (spokes === 0) spokes = ignored
        if (spokes >= minSpokes) continue
        report(spokes, minSpokes, false)
      }
    }
  }
}

/** A custom pad's spoke templates: its `(gr_vector …)` primitives. */
function spokeTemplateCount(pad: KicadPad): number {
  if (pad.shape !== 'custom' || pad._raw.type !== 'list') return 0
  const primitives = findChild(pad._raw, 'primitives')
  return primitives ? findChildren(primitives, 'gr_vector').length : 0
}
