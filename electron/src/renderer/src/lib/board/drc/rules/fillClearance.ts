import { boxesTouch } from '../../../geometry/polygon'
import { expandLayerToken } from '../../../kicad/layers'
import type { DrcContext } from '../context'
import { DRC_EPSILON, fmt, at, ownSeverity, keyOf } from '../shared'

export function* fillClearance(ctx: DrcContext): Generator<void> {
  const {
    region,
    near: nearRegion,
    itemsFrom,
    holeSlack,
    emit,
    sliceDone,
    pair,
    copperOf,
    maxClearance,
    drawingSet,
    sideOf,
    requiredClearance,
    holesOf,
    copperOn,
    tieNets,
    holeOwner,
    holeClearance,
    requiredHoleClearance,
    fills,
    itemsNear,
    shapeToFill,
    markAt
  } = ctx
  // Copper and holes against the fills of other nets (`testItemAgainstZone`):
  // a zone on no net is tested even against copper on no net.
  // One finding per item, zone and layer, as KiCad tests each layer apart.
  const fillFlagged = new Set<string>()
  const holeReach = Math.max(maxClearance, holeClearance) + 1e-6

  // In a region run, only the region's copper meets the fills: a fill's own
  // changes reach the region through what the refill changed of it.
  // An item's hole may meet the region off its copper: look a drill offset further.
  const regionItems = region ? itemsFrom(holeReach + holeSlack()) : null
  for (const fill of fills) {
    const fillReach = maxClearance + 1e-6
    const near = regionItems
      ? regionItems.filter((item) => boxesTouch(item, fill.box, holeReach))
      : itemsNear(fill.box, holeReach)
    for (const item of near) {
      if (sliceDone()) yield
      if (fill.net !== 0 && item.net === fill.net) continue
      const copper = copperOn(item, fill.layer)
      if (!copper || !boxesTouch(copper.box, fill.box, fillReach)) continue
      const a = copperOf.get(item.id)!
      const key = `${item.id}:${fill.zoneIndex}:${fill.layer}`
      if (!a.copper || fillFlagged.has(key)) continue
      const required = requiredClearance(sideOf(a), fill.side, fill.layer)
      if (required.severity === 'ignore') continue
      if (required.value <= 0) continue
      // A chamfered, trapezoid or custom pad is its exact outline in the index.
      const { actual, edge } = shapeToFill(copper.shape, copper.box, fill, required.value)
      if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
      fillFlagged.add(key)
      emit(
        {
          code: 'copper-clearance',
          severity: 'error',
          ...ownSeverity(required.severity),
          message:
            actual === 0
              ? `${a.subject.name} runs into ${fill.subject.name} on ${fill.layer}; ${required.rule} needs ${fmt(required.value)}. Refill the zone.`
              : `${a.subject.name} and ${fill.subject.name} are ${fmt(actual)} apart on ${fill.layer}; ${required.rule} needs ${fmt(required.value)}. Refill the zone.`,
          measure: { actual, limit: required.value, bound: 'min', unit: 'mm', rule: required.rule },
          position: at(markAt(copper.shape, edge)),
          layer: fill.layer,
          ...pair(a.subject, fill.subject)
        },
        [item]
      )
    }
    // A drawing against a fill of another net, or of no net: a clearance even
    // where it overlaps (`testItemAgainstZone`). A net tie's graphic may meet
    // the fill of a net it joins.
    for (const d of drawingSet.query(
      fill.box.minX - fillReach,
      fill.box.minY - fillReach,
      fill.box.maxX + fillReach,
      fill.box.maxY + fillReach
    )) {
      if (sliceDone()) yield
      if (d.knockout || !d.layers.includes(fill.layer) || !nearRegion(d)) continue
      if (fill.net !== 0 && d.netted && d.net === fill.net) continue
      if (fill.net !== 0 && tieNets(d, true).has(fill.net)) continue
      const key = `${d.id}:${fill.zoneIndex}:${fill.layer}`
      if (fillFlagged.has(key)) continue
      const a = copperOf.get(d.id)!
      const required = requiredClearance(sideOf(a), fill.side, fill.layer)
      if (required.severity === 'ignore') continue
      if (required.value <= 0) continue
      const { actual, edge } = shapeToFill(d.shape, d, fill, required.value)
      if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
      fillFlagged.add(key)
      emit(
        {
          code: 'copper-clearance',
          severity: 'error',
          ...ownSeverity(required.severity),
          message: `${a.subject.name} and ${fill.subject.name} are ${fmt(actual)} apart on ${fill.layer}; ${required.rule} needs ${fmt(required.value)}.`,
          measure: { actual, limit: required.value, bound: 'min', unit: 'mm', rule: required.rule },
          position: at(markAt(d.shape, edge)),
          layer: fill.layer,
          ...pair(a.subject, fill.subject)
        },
        [d]
      )
    }
    if (holeClearance <= 0) continue
    // A hole on no copper layer (a pad with only mask) meets no zone, so only
    // the holes of indexed copper are tried.
    for (const hole of near.flatMap((item) => holesOf.get(item.id) ?? [])) {
      if (sliceDone()) yield
      if (!hole.layers.includes(fill.layer)) continue
      // A pad meets the zones only on its own copper layers, as KiCad tests it:
      // an unplated hole drilled through an inner pour is the filler's, not this check's.
      if (
        hole.pad &&
        !hole.pad.layers.some((l) => expandLayerToken(l, ctx.copperLayers).includes(fill.layer))
      )
        continue
      if (fill.net !== 0 && hole.net === fill.net) continue
      const key = `hole:${keyOf(hole.subject)}:${fill.zoneIndex}:${fill.layer}`
      if (fillFlagged.has(key) || !boxesTouch(hole.box, fill.box, holeReach)) continue
      const required = requiredHoleClearance(holeOwner(hole), fill.side, fill.layer)
      if (required.severity === 'ignore') continue
      const { actual, edge } = shapeToFill(hole.shape, hole.box, fill, required.value)
      if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
      fillFlagged.add(key)
      emit(
        {
          code: 'hole-clearance',
          severity: 'error',
          ...ownSeverity(required.severity),
          message: `The hole of ${hole.subject.name} is ${fmt(actual)} from ${fill.subject.name} on ${fill.layer}; ${required.rule} needs ${fmt(required.value)}.`,
          measure: { actual, limit: required.value, bound: 'min', unit: 'mm', rule: required.rule },
          position: at(markAt(hole.shape, edge)),
          layer: fill.layer,
          ...pair(fill.subject, hole.subject)
        },
        [hole.box]
      )
    }
  }
}
