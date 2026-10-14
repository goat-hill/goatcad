import { boxesTouch } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { DRC_EPSILON, fmt, at, isRound, ownSeverity } from '../shared'

export function* holeToHole(ctx: DrcContext): Generator<void> {
  const { emit, pair, ruleSet, holes, sharesLayer, holeOwner, tick } = ctx
  // Round drills by a sweep over x: the minimum spacing bounds the window.
  {
    // The window is the widest spacing any rule asks; each pair gets its own.
    const spacing = ruleSet.resolver.worst('hole_to_hole')
    const sorted = holes
      .filter((hole) => isRound(hole.shape))
      .sort((a, b) => a.box.minX - b.box.minX)
    for (let i = 0; i < sorted.length; i++) {
      if (tick()) yield
      const a = sorted[i]
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]
        if (b.box.minX > a.box.maxX + spacing) break
        if (!boxesTouch(a.box, b.box, spacing)) continue
        if (a.micro && b.micro) continue
        if (
          a.item?.ref.type === 'via' &&
          b.item?.ref.type === 'via' &&
          !sharesLayer(a.layers, b.layers)
        )
          continue
        const distance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)
        if (distance < DRC_EPSILON) {
          emit(
            {
              code: 'holes-co-located',
              severity: 'warning',
              message: `The holes of ${a.subject.name} and ${b.subject.name} are at one point.`,
              position: at(a.center),
              ...pair(a.subject, b.subject)
            },
            []
          )
          continue
        }
        const actual = Math.max(0, distance - a.shape.halfWidth - b.shape.halfWidth)
        const rule = ruleSet.resolver.evaluate('hole_to_hole', holeOwner(a), holeOwner(b), null)
        const required = rule.value.min ?? 0
        if (rule.isNull || rule.severity === 'ignore') continue
        if (actual >= Math.max(0, required - DRC_EPSILON)) continue
        emit(
          {
            code: 'holes-too-close',
            severity: 'warning',
            message: `The holes of ${a.subject.name} and ${b.subject.name} are ${fmt(actual)} apart; ${rule.implicitMin ? 'board setup constraints' : rule.name} needs ${fmt(required)}.`,
            measure: {
              actual,
              limit: required,
              bound: 'min',
              unit: 'mm',
              rule: rule.implicitMin ? 'board setup constraints' : rule.name
            },
            position: at(a.center),
            ...pair(a.subject, b.subject),
            ...ownSeverity(rule.severity)
          },
          []
        )
      }
    }
  }
}
