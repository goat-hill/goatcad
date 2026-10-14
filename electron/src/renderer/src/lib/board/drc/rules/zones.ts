import { allZones, isTeardropZone } from '../../../kicad/board'
import { resolveLayers } from '../../keepouts'
import { isCopperLayer } from '../../../kicad/layers'
import { YStripes } from '../../../geometry/yStripes'
import { boxesTouch, ringBox } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { fmt, at, worldOf, ringsWithin, outlinesMeet } from '../shared'

export function* zones(ctx: DrcContext): Generator<void> {
  const { emit, zoneSubject, pair, maxClearance, requiredClearance, fills, board, tick } = ctx
  // Zone against zone (`testZonesToZones`): fills of two nets by their edges;
  // two outlines of one net at one priority, which leave the fill ambiguous.
  // Each on every copper layer the pair shares, as KiCad tests each layer apart.
  {
    const zonePairs = new Set<string>()
    // A sweep over x per layer: no pair further apart than any clearance is tried.
    const swept = [...fills].sort(
      (a, b) => a.layer.localeCompare(b.layer) || a.box.minX - b.box.minX
    )
    for (let i = 0; i < swept.length; i++) {
      if (tick()) yield
      const a = swept[i]
      for (let j = i + 1; j < swept.length; j++) {
        const b = swept[j]
        if (b.layer !== a.layer || b.box.minX > a.box.maxX + maxClearance) break
        if (a.zone === b.zone || a.net === b.net) continue
        const key = `${Math.min(a.zoneIndex, b.zoneIndex)}:${Math.max(a.zoneIndex, b.zoneIndex)}:${a.layer}`
        if (zonePairs.has(key)) continue
        const required = requiredClearance(a.side, b.side, a.layer)
        if (required.value <= 0 || !boxesTouch(a.box, b.box, required.value)) continue
        if (tick(8)) yield
        const hit = ringsWithin(a, b, required.value)
        if (!hit) continue
        zonePairs.add(key)
        emit(
          {
            code: 'copper-clearance',
            severity: 'error',
            message: `${a.subject.name} and ${b.subject.name} are ${fmt(hit.actual)} apart on ${a.layer}; ${required.rule} needs ${fmt(required.value)}. Refill the zones.`,
            measure: {
              actual: hit.actual,
              limit: required.value,
              bound: 'min',
              unit: 'mm',
              rule: required.rule
            },
            position: at(hit.at),
            layer: a.layer,
            ...pair(a.subject, b.subject)
          },
          []
        )
      }
    }
    // Only copper pours: a zone on no copper layer fills nothing to overlap.
    // A footprint's zones are the board's own here, as in KiCad.
    const pours = allZones(board)
      .filter((zone) => !zone.isKeepout && !isTeardropZone(zone) && zone.points.length >= 3)
      .map((zone) => {
        const ring = zone.points.map(worldOf)
        return {
          zone,
          ring,
          stripes: new YStripes(ring),
          box: ringBox(ring),
          layers: resolveLayers(zone.layers, board).filter(isCopperLayer)
        }
      })
      .filter((pour) => pour.layers.length > 0)
    for (let i = 0; i < pours.length; i++) {
      const a = pours[i]
      for (let j = i + 1; j < pours.length; j++) {
        const b = pours[j]
        if ((a.zone.net ?? 0) !== (b.zone.net ?? 0)) continue
        if ((a.zone.priority ?? 0) !== (b.zone.priority ?? 0)) continue
        const shared = a.layers.filter((layer) => b.layers.includes(layer))
        if (shared.length === 0 || !boxesTouch(a.box, b.box)) continue
        if (tick(8)) yield
        const hit = outlinesMeet(a, b)
        if (!hit) continue
        const sa = zoneSubject(a.zone)
        const sb = zoneSubject(b.zone)
        for (const layer of shared)
          emit(
            {
              code: 'zones-intersect',
              severity: 'error',
              message: `${sa.name} and ${sb.name} overlap on ${layer} at the same priority, so which one fills there is undefined. Give one a higher priority.`,
              position: at(hit),
              layer,
              ...pair(sa, sb)
            },
            []
          )
      }
    }
  }
}
