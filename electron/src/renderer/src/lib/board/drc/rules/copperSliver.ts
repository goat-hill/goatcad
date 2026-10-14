import { intersection, union, type ClipRegion } from '../../../geometry/clip'
import { shapeOutlines } from '../../shapeOutline'
import { YStripes } from '../../../geometry/yStripes'
import { findSlivers } from '../../necks'
import type { Pt } from '../../spatialIndex'
import type { DrcContext } from '../context'
import { at } from '../shared'

/** KiCad's sliver tolerances (`ADVANCED_CFG`): sharper than 20°, a mouth wider than 0.08 mm. */
const SLIVER = { angle: 20, mouth: 0.08, merge: 0.0008 }

/** How finely a track's or pad's curves are cut, mm: KiCad's low definition, the error inside. */
const CURVE_ERROR = 0.02

/** How far round a tip the layer's copper is joined to read it as KiCad does, mm. */
const AROUND = 0.5

/**
 * Copper slivers (`copper_sliver`): an acute spike on the outline of a copper
 * layer's copper, sharper than 20° with its sides more than 0.08 mm apart —
 * too thin a tip to etch. KiCad joins all of a layer's copper and reads the
 * outer outlines' corners; a spike there can only be an acute corner some
 * polygon already has (a fill, a teardrop, a polygonal pad or drawing), since
 * round copper and two edges crossing make none. So each polygon is read for
 * its tips, joined with itself (an edge crossing itself may undo one, a
 * hole's rim is no outline), and a tip that survives is read once more in all the layer's copper round it. Board-scoped; its findings name the
 * layer, not an item, as KiCad's do.
 */
export function* copperSliver(ctx: DrcContext): Generator<void> {
  const { fills, index, drawings, emit, sliceDone } = ctx
  /**
   * Whether a tip survives KiCad's reading: all of the layer's copper round it
   * joined — each piece cut to a small box first, so a pour costs no more
   * than its corner — and the tip still an acute corner of an outer outline.
   */
  const survives = (tip: Pt, layer: string): boolean => {
    const box: ClipRegion = {
      outer: [
        { x: tip.x - AROUND, y: tip.y - AROUND },
        { x: tip.x + AROUND, y: tip.y - AROUND },
        { x: tip.x + AROUND, y: tip.y + AROUND },
        { x: tip.x - AROUND, y: tip.y + AROUND }
      ],
      holes: []
    }
    const near = (b: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
      b.maxX >= tip.x - AROUND &&
      b.minX <= tip.x + AROUND &&
      b.maxY >= tip.y - AROUND &&
      b.minY <= tip.y + AROUND
    const pieces: ClipRegion[] = []
    for (const fill of fills)
      if (fill.layer === layer && near(fill.box))
        pieces.push(...intersection([{ outer: fill.ring, holes: [] }], [box]))
    for (const item of index.query(
      tip.x - AROUND,
      tip.y - AROUND,
      tip.x + AROUND,
      tip.y + AROUND
    )) {
      const on = ctx.copperOn(item, layer)
      if (on)
        for (const ring of shapeOutlines(on.shape, 0, CURVE_ERROR))
          pieces.push({ outer: ring, holes: [] })
    }
    for (const d of drawings)
      if (d.layers.includes(layer) && near(d))
        for (const ring of shapeOutlines(d.shape, 0, CURVE_ERROR))
          pieces.push({ outer: ring, holes: [] })
    for (const region of union(pieces, [])) {
      const outer = new YStripes(region.outer)
      const holes = region.holes.map((hole) => new YStripes(hole))
      const isCopper = (p: Pt): boolean => outer.contains(p) && !holes.some((h) => h.contains(p))
      if (
        findSlivers(region.outer, isCopper, SLIVER).some(
          (found) => Math.hypot(found.tip.x - tip.x, found.tip.y - tip.y) <= 1e-3
        )
      )
        return true
    }
    return false
  }
  const reported = new Set<string>()
  /**
   * A polygon's tips: its acute corners, read again once the polygon is joined
   * with itself (a stored fill is fractured, a drawn one may cross itself) and
   * only on its outer outlines, each kept where no other copper covers a point
   * inside it.
   */
  const check = (ring: Pt[], layer: string): void => {
    const stripes = new YStripes(ring)
    if (findSlivers(ring, (p) => stripes.contains(p), SLIVER).length === 0) return
    for (const region of union([{ outer: ring, holes: [] }], [])) {
      const outer = new YStripes(region.outer)
      const holes = region.holes.map((hole) => new YStripes(hole))
      const isCopper = (p: Pt): boolean => outer.contains(p) && !holes.some((h) => h.contains(p))
      for (const { tip } of findSlivers(region.outer, isCopper, SLIVER)) {
        if (!survives(tip, layer)) continue
        const key = `${layer}|${tip.x.toFixed(4)}|${tip.y.toFixed(4)}`
        if (reported.has(key)) continue
        reported.add(key)
        emit(
          {
            code: 'copper-sliver',
            severity: 'warning',
            message: `A sliver of copper on ${layer} ends in a tip too thin to etch.`,
            items: [],
            targets: [],
            subject: layer,
            position: at(tip)
          },
          [{ minX: tip.x, minY: tip.y, maxX: tip.x, maxY: tip.y }]
        )
      }
    }
  }
  for (const fill of fills) {
    if (sliceDone()) yield
    check(fill.ring, fill.layer)
  }
  for (const item of [...index.items, ...drawings]) {
    const parts = item.shape.kind === 'compound' ? item.shape.parts : [item.shape]
    for (const part of parts)
      if (part.kind === 'poly' && part.rings[0])
        for (const layer of item.layers) check(part.rings[0] as Pt[], layer)
  }
}
