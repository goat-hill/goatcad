import { union, type ClipRegion } from '../../../geometry/clip'
import { ringBox, type Box } from '../../../geometry/polygon'
import { shapeOutlines } from '../../shapeOutline'
import { findNecks } from '../../necks'
import { pointToShape, type CopperItem, type CopperShape, type Pt } from '../../spatialIndex'
import type { RuleItem } from '../../rules/constraints'
import type { DrcContext } from '../context'
import {
  DRC_EPSILON,
  at,
  fmt,
  idsOf,
  keyOf,
  ownSeverity,
  type FillRing,
  type Subject
} from '../shared'

/** KiCad's extra clearance its zone knockouts are cut with, mm (`m_ExtraClearance`). */
const EXTRA_CLEARANCE = 0.0005

/** How finely a track's or pad's curves are cut into the copper outline, mm (KiCad's high definition). */
const CURVE_ERROR = 0.005

/**
 * The minimum connection width (`connection_width`): each net's copper on
 * each layer — its tracks, the vias and pads flashed there, its zones' fills
 * — joined into one outline, and every neck in it narrower than a width some
 * rule asks for (`necks.ts`). A neck is a finding when the rule for the copper
 * found at its middle asks for that width: the items within the width of the
 * middle are what it names. A neck is allowed the DRC epsilon, the board's
 * arc error and KiCad's knockout margin on each side, which a pour's cut
 * edges carry. Only runs where a rule sets a width; board-scoped.
 */
export function* connectionWidth(ctx: DrcContext): Generator<void> {
  const { index, ruleSet, fills, emit, tick, sliceDone } = ctx
  const widths = [
    ...new Set(
      ruleSet.resolver.rules
        .map((rule) => rule.constraints.get('connection_width')?.min ?? 0)
        .filter((min) => min > 0)
    )
  ].sort((a, b) => a - b)
  if (widths.length === 0) return
  const epsilon = 2 * (DRC_EPSILON + ruleSet.maxError + EXTRA_CLEARANCE)

  // Each net's copper on each layer, as outlines to join.
  const copper = new Map<string, { net: number; layer: string; pieces: ClipRegion[] }>()
  const add = (net: number, layer: string, rings: readonly Pt[][]): void => {
    const key = `${net}|${layer}`
    let entry = copper.get(key)
    if (!entry) copper.set(key, (entry = { net, layer, pieces: [] }))
    for (const ring of rings) if (ring.length >= 3) entry.pieces.push({ outer: ring, holes: [] })
  }
  for (const item of index.items) {
    if (tick()) yield
    for (const layer of item.layers) {
      const on = flashedOn(ctx, item, layer)
      if (on) add(item.net, layer, shapeOutlines(on, 0, CURVE_ERROR))
    }
  }
  for (const fill of fills) add(fill.net, fill.layer, [fill.ring])

  for (const { layer, pieces } of copper.values()) {
    if (sliceDone()) yield
    for (const region of union(pieces, [])) {
      for (const width of widths) {
        for (const neck of findNecks(region, width - epsilon)) {
          const middle = { x: (neck.a.x + neck.b.x) / 2, y: (neck.a.y + neck.b.y) / 2 }
          const found = contributors(ctx, middle, layer, width)
          if (found.length === 0) continue
          const resolved = ruleSet.resolver.evaluate(
            'connection_width',
            found[0].rule,
            found[1]?.rule ?? null,
            layer
          )
          if (resolved.isNull || resolved.severity === 'ignore') continue
          if (Math.abs((resolved.value.min ?? 0) - width) > 1e-9) continue
          const subjects = found.map((f) => f.subject)
          const boxes: Box[] = found.map((f) => f.box)
          emit(
            {
              code: 'connection-width',
              severity: 'warning',
              message: `The copper of ${subjects.map((s) => s.name).join(', ')} narrows to ${fmt(neck.width)} on ${layer}; ${resolved.implicitMin ? 'board setup constraints' : resolved.name} needs ${fmt(width)}.`,
              measure: {
                actual: neck.width,
                limit: width,
                bound: 'min',
                unit: 'mm',
                rule: resolved.implicitMin ? 'board setup constraints' : resolved.name
              },
              items: subjects.map((s) => s.item),
              targets: [...new Set(subjects.flatMap((s) => s.targets))],
              kicadIds: [...new Set(subjects.flatMap(idsOf))],
              subject: subjects.map((s) => s.name).join(' · '),
              position: at(middle),
              ...ownSeverity(resolved.severity)
            },
            boxes
          )
        }
      }
    }
  }
}

/**
 * An item's copper on a layer where it is flashed there: a track on its
 * layer, a pad or via only where its copper is (never its bare hole).
 */
function flashedOn(ctx: DrcContext, item: CopperItem, layer: string): CopperShape | null {
  if (item.ref.type === 'drawing') return null
  const on = ctx.copperOn(item, layer)
  if (!on) return null
  if (item.ref.type === 'via' || item.ref.type === 'pad') {
    const hole = ctx.holesOf.get(item.id)?.[0]
    if (hole && on.shape === hole.shape) return null
  }
  return on.shape
}

/**
 * What makes the copper at a point, as KiCad hit-tests a neck's middle within
 * the width: tracks, vias and pads of any net on the layer, then zones whose
 * fill there reaches it.
 */
function contributors(
  ctx: DrcContext,
  p: Pt,
  layer: string,
  width: number
): Array<{ subject: Subject; rule: RuleItem; box: Box }> {
  const out: Array<{ subject: Subject; rule: RuleItem; box: Box }> = []
  for (const item of ctx.index.query(p.x - width, p.y - width, p.x + width, p.y + width)) {
    if (!item.layers.includes(layer)) continue
    const on = ctx.copperOn(item, layer)
    if (!on || pointToShape(on.shape, p.x, p.y) > width) continue
    const copper = ctx.copperOf.get(item.id)!
    out.push({ subject: copper.subject, rule: ctx.sideOf(copper), box: item })
  }
  const zones = new Set<FillRing['zone']>()
  for (const fill of ctx.fills) {
    if (fill.layer !== layer || zones.has(fill.zone)) continue
    const b = fill.box
    if (
      p.x < b.minX - width ||
      p.x > b.maxX + width ||
      p.y < b.minY - width ||
      p.y > b.maxY + width
    )
      continue
    if (!reaches(fill, p, width)) continue
    zones.add(fill.zone)
    out.push({ subject: fill.subject, rule: fill.side, box: ringBox(fill.ring) })
  }
  // In a fixed order, which also picks the two the rule is asked about.
  return out.sort((a, b) => keyOf(a.subject).localeCompare(keyOf(b.subject)))
}

/** Whether a fill covers a point or comes within `reach` of it. */
function reaches(fill: FillRing, p: Pt, reach: number): boolean {
  if (fill.stripes.contains(p)) return true
  let hit = false
  fill.stripes.someEdgeInYRange(p.y - reach, p.y + reach, (a, b) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
    )
    hit = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= reach
    return hit
  })
  return hit
}
