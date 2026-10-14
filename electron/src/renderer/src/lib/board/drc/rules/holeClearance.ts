import { shapeOn, shapeToShape } from '../../spatialIndex'
import type { DrcContext } from '../context'
import { DRC_EPSILON, fmt, at, between, ownSeverity, keyOf } from '../shared'

export function* holeClearance(ctx: DrcContext): Generator<void> {
  const {
    emit,
    pair,
    copperOf,
    holesFrom,
    maxClearance,
    sharesLayer,
    netsExempt,
    sideOf,
    holeOwner,
    holeClearance,
    requiredHoleClearance,
    index,
    tick,
    flaggedPadPairs,
    padPairKey
  } = ctx
  // A hole against copper of another item on the layers it passes, at the
  // hole clearance the rules give the pair; a pad's own override applies to
  // its hole too.
  // Run whatever the board minimum: a hole may not touch copper of another net even at 0.
  {
    const holeReach = Math.max(holeClearance, maxClearance) + 1e-6
    for (const hole of holesFrom(holeReach)) {
      if (tick()) yield
      const near = index.query(
        hole.box.minX - holeReach,
        hole.box.minY - holeReach,
        hole.box.maxX + holeReach,
        hole.box.maxY + holeReach
      )
      for (const other of near) {
        if (hole.item && other.id === hole.item.id) continue
        const b = copperOf.get(other.id)!
        if (!b.copper || !sharesLayer(hole.layers, other.layers)) continue
        if (netsExempt(hole, hole.net, b, other.net)) continue
        if (hole.footprint !== null && hole.footprint === b.footprint) {
          if (keyOf(hole.subject) === keyOf(b.subject)) continue
        }
        if (
          hole.item?.ref.type === 'pad' &&
          other.ref.type === 'pad' &&
          flaggedPadPairs.has(padPairKey(hole.item.id, other.id))
        )
          continue
        // On each copper layer the hole passes and the other item is on, as
        // KiCad tests each layer apart; a padstack by its copper there.
        for (const layer of hole.layers.filter((l) => other.layers.includes(l))) {
          const required = requiredHoleClearance(holeOwner(hole), sideOf(b), layer)
          if (required.severity === 'ignore') continue
          const actual = shapeToShape(
            hole.shape,
            other.shapes ? shapeOn(other, layer) : other.shape
          )
          if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
          emit(
            {
              code: 'hole-clearance',
              severity: 'error',
              ...ownSeverity(required.severity),
              message: `The hole of ${hole.subject.name} is ${fmt(actual)} from ${b.subject.name} on ${layer}; ${required.rule} needs ${fmt(required.value)}.`,
              measure: {
                actual,
                limit: required.value,
                bound: 'min',
                unit: 'mm',
                rule: required.rule
              },
              position: at(between(hole.shape, other.shape)),
              layer,
              ...pair(b.subject, hole.subject)
            },
            [hole.box, other]
          )
        }
      }
    }
  }
}
