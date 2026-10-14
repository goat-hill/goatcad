import { boxesTouch } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { DRC_EPSILON, fmt, at, ownSeverity, type Capsule, type FillRing } from '../shared'

export function* knockoutText(ctx: DrcContext): Generator<void> {
  const {
    emit,
    sliceDone,
    pair,
    copperOf,
    maxClearance,
    drawings,
    sideOf,
    requiredClearance,
    fills,
    shapeToFill,
    markAt
  } = ctx
  // Knockout text against the zones (`testKnockoutTextAgainstZone`): it is
  // knocked out of a pour, so it takes the net of the first zone it meets, in
  // the board's order, and is held to every zone of another net — from a
  // clearance of 0, touching it a short once it has a net.
  for (const text of drawings) {
    if (!text.knockout) continue
    const layer = text.layers[0]
    const a = copperOf.get(text.id)!
    let inherited: number | null = null
    const zonesOnLayer = new Map<number, FillRing[]>()
    for (const fill of fills)
      if (fill.layer === layer && !fill.teardrop && boxesTouch(fill.box, text, maxClearance))
        zonesOnLayer.set(fill.zoneIndex, [...(zonesOnLayer.get(fill.zoneIndex) ?? []), fill])
    for (const [, zoneFills] of [...zonesOnLayer].sort(([x], [y]) => x - y)) {
      if (sliceDone()) yield
      const zone = zoneFills[0]
      const touches = zoneFills.some((fill) => shapeToFill(text.shape, text, fill, 0).actual === 0)
      if (inherited === null && touches) inherited = zone.net
      if (zone.net === inherited) continue
      const required = requiredClearance(sideOf(a), zone.side, layer)
      if (required.value < 0 || required.severity === 'ignore') continue
      let actual = Infinity
      let edge: Capsule | null = null
      for (const fill of zoneFills) {
        const hit = shapeToFill(text.shape, text, fill, required.value)
        if (hit.actual < actual) ({ actual, edge } = hit)
      }
      if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
      const short = actual === 0 && inherited !== null
      emit(
        {
          code: short ? 'copper-short' : 'copper-clearance',
          severity: 'error',
          message: short
            ? `${a.subject.name} joins ${zone.subject.name} to the net of the zone it sits in.`
            : `${a.subject.name} and ${zone.subject.name} are ${fmt(actual)} apart on ${layer}; ${required.rule} needs ${fmt(required.value)}.`,
          ...(short
            ? {}
            : {
                measure: {
                  actual,
                  limit: required.value,
                  bound: 'min' as const,
                  unit: 'mm' as const,
                  rule: required.rule
                }
              }),
          position: at(markAt(text.shape, edge)),
          ...pair(a.subject, zone.subject),
          ...ownSeverity(required.severity)
        },
        []
      )
    }
  }
}
