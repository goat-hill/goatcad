import { padOnLayer, type KicadPad } from '../../../kicad/footprint'
import { isCopperLayer } from '../../../kicad/layers'
import { mmToNm, nmToMm, type Nm } from '../../../kicad/coordinates'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import {
  padHoleShape,
  pointInPoly,
  shapeOn,
  segmentToShape,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../../spatialIndex'
import { shapeOutlines } from '../../shapeOutline'
import { difference, union } from '../../../geometry/clip'
import type { RuleItem, RuleSeverity } from '../../rules/constraints'
import { boxesTouch, ringBox, type Box } from '../../../geometry/polygon'
import type { CheckMeasure } from '../../../schematic/checks'
import type { DrcContext } from '../context'
import { fmt, refKey, worldOf } from '../shared'

export function sizes(ctx: DrcContext): void {
  const {
    copperLayers,
    padSubject,
    one,
    ruleSet,
    itemByRef,
    subjectOfItem,
    board,
    near,
    region,
    itemsFrom
  } = ctx
  // Compared in the file's integer nanometers, as KiCad compares them: a via
  // drawn exactly at the minimum passes, and no float rounding says otherwise.
  /**
   * A size rule for one item, in nanometers: the min and max the resolver
   * finds, and who set each — `board setup constraints` wherever the min came
   * from the board's own rules, as KiCad names it.
   */
  const sizeRule = (
    type: 'track_width' | 'via_diameter' | 'hole_size' | 'annular_width',
    item: RuleItem,
    layer: string | null
  ): {
    min: number | null
    max: number | null
    minName: string
    maxName: string
    severity?: RuleSeverity
  } => {
    const resolved = ruleSet.resolver.evaluate(type, item, null, layer)
    if (resolved.isNull || resolved.severity === 'ignore')
      return { min: null, max: null, minName: '', maxName: '' }
    return {
      min: resolved.value.min !== undefined ? mmToNm(resolved.value.min) : null,
      max: resolved.value.max !== undefined ? mmToNm(resolved.value.max) : null,
      minName: resolved.implicitMin ? 'board setup constraints' : resolved.name,
      maxName: resolved.name,
      ...(resolved.severity ? { severity: resolved.severity } : {})
    }
  }
  /** Held to a size rule: the finding for a value under its min or over its max, else null. */
  const outOfRange = (
    value: number,
    rule: ReturnType<typeof sizeRule>,
    what: string
  ): { message: string; measure: CheckMeasure } | null => {
    const measure = (limit: number, bound: 'min' | 'max', name: string): CheckMeasure => ({
      actual: nmToMm(value as Nm),
      limit: nmToMm(limit as Nm),
      bound,
      unit: 'mm',
      rule: name
    })
    if (rule.max !== null && value > rule.max)
      return {
        message: `${what} is ${fmt(nmToMm(value as Nm))}; ${rule.maxName} allows at most ${fmt(nmToMm(rule.max as Nm))}.`,
        measure: measure(rule.max, 'max', rule.maxName)
      }
    if (rule.min !== null && value < rule.min)
      return {
        message: `${what} is ${fmt(nmToMm(value as Nm))}; ${rule.minName} needs at least ${fmt(nmToMm(rule.min as Nm))}.`,
        measure: measure(rule.min, 'min', rule.minName)
      }
    return null
  }
  const trackWidthFinding = (item: CopperItem | undefined, width: number, at: Pt): void => {
    if (!item || !near(item)) return
    const subject = subjectOfItem(item)
    if (!subject) return
    const rule = sizeRule('track_width', ruleSet.copperItem(item), item.layers[0] ?? null)
    const message = outOfRange(width, rule, `The width of ${subject.name}`)
    if (message)
      one('track-width', 'error', message.message, subject, at, [item], rule.severity, {
        measure: message.measure
      })
  }
  // In a region run, only the region's items: a lookup of each by its reference.
  const regionRefs = region ? new Map(itemsFrom(0).map((item) => [refKey(item.ref), item])) : null
  const itemAt = (key: string): CopperItem | undefined =>
    regionRefs ? regionRefs.get(key) : itemByRef.get(key)
  board.segments.forEach((seg, i) => {
    const item = itemAt(`segment:${i}`)
    if (!item) return
    const start = worldOf(seg.start)
    const end = worldOf(seg.end)
    trackWidthFinding(item, seg.width, {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2
    })
  })
  board.trackArcs.forEach((arc, i) => {
    const item = itemAt(`tarc:${i}`)
    if (item) trackWidthFinding(item, arc.width, worldOf(arc.start))
  })
  board.vias.forEach((via, i) => {
    const item = itemAt(`via:${i}`)
    if (!item || !near(item)) return
    const subject = subjectOfItem(item)
    if (!subject) return
    const ruleItem = ruleSet.copperItem(item)
    const micro = via.type === 'micro'
    const position = worldOf(via.position)
    // The diameter is the front's, as KiCad reads it; the ring is each layer's.
    const sizeLimit = sizeRule('via_diameter', ruleItem, null)
    const size = outOfRange(via.size, sizeLimit, `The diameter of ${subject.name}`)
    if (size)
      one('via-diameter', 'error', size.message, subject, position, [item], sizeLimit.severity, {
        measure: size.measure
      })
    const drillLimit = sizeRule('hole_size', ruleItem, null)
    const drill = outOfRange(via.drill, drillLimit, `The hole of ${subject.name}`)
    if (drill)
      one(
        micro ? 'microvia-drill-out-of-range' : 'drill-out-of-range',
        'error',
        drill.message,
        subject,
        position,
        [item],
        drillLimit.severity,
        { measure: drill.measure }
      )
    // Each padstack entry is measured and reported apart, as KiCad measures
    // each unique padstack layer.
    const ringLimit = sizeRule('annular_width', ruleItem, null)
    // The front entry is the via's own size; the padstack lists the rest.
    const entries: Array<[string | null, number]> = via.padstack
      ? [
          ['F.Cu', via.size],
          ...Object.entries(via.padstack.sizes).filter(([layer]) => layer !== 'F.Cu')
        ]
      : [[null, via.size]]
    for (const [layer, size] of entries) {
      const ring = outOfRange(
        Math.round((size - via.drill) / 2),
        ringLimit,
        `The annular ring of ${subject.name}`
      )
      if (ring)
        one('annular-width', 'error', ring.message, subject, position, [item], ringLimit.severity, {
          measure: ring.measure,
          ...(layer && entries.length > 1 ? { layer } : {})
        })
    }
  })
  /**
   * KiCad's slow annular path: the pad's outline as a polygon, its nearest
   * edge to the hole's centerline less half the hole — nm; 0 when the hole
   * lies off the pad. Null where the index has no copper for the pad.
   */
  const exactAnnular = (
    fpIndex: number,
    padIndex: number,
    pad: KicadPad,
    center: Pt,
    layer: string
  ): number | null => {
    const item = itemAt(`pad:${fpIndex}:${padIndex}`)
    const hole = padHoleShape(pad, center)
    if (!item || !hole || hole.kind !== 'capsule') return null
    const shape = shapeOn(item, layer)
    let rings = shapeOutlines(shape, 0, ruleSet.maxError)
    if (shape.kind === 'compound') {
      rings = union(
        rings.map((outer) => ({ outer, holes: [] })),
        []
      ).flatMap((region) => [region.outer, ...region.holes])
    }
    if (!pointInPoly(rings, center.x, center.y)) return 0
    const capsule: CopperShape = { ...hole, halfWidth: 0 }
    let nearest = Infinity
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        nearest = Math.min(
          nearest,
          segmentToShape(capsule, ring[j].x, ring[j].y, ring[i].x, ring[i].y, 0)
        )
    return Math.round(mmToNm(Math.abs(nearest - hole.halfWidth)))
  }
  /**
   * The ring a pad's hole leaves in the copper of every pad of its number on a
   * layer, joined, less the other pads' holes: 0 where that copper misses the
   * pad's center (KiCad's aggregate annulus). Null without a hole to measure.
   */
  const joinedAnnular = (
    fpIndex: number,
    padIndex: number,
    pad: KicadPad,
    center: Pt,
    layer: string,
    others: ReadonlyArray<{ other: KicadPad; index: number }>
  ): number | null => {
    const hole = padHoleShape(pad, center)
    if (!hole || hole.kind !== 'capsule') return null
    const tf = footprintTransform(board.footprints[fpIndex])
    const copper = [padIndex, ...others.map((o) => o.index)].flatMap((index) => {
      const it = itemAt(`pad:${fpIndex}:${index}`)
      return it && it.layers.includes(layer)
        ? shapeOutlines(shapeOn(it, layer), 0, ruleSet.maxError).map((outer) => ({
            outer,
            holes: []
          }))
        : []
    })
    const cuts = others.flatMap(({ other }) => {
      const otherHole = padHoleShape(other, tfPoint(tf, other.position.x, other.position.y))
      return otherHole
        ? shapeOutlines(otherHole, 0, ruleSet.maxError).map((outer) => ({ outer, holes: [] }))
        : []
    })
    const whole = difference(union(copper, []), cuts)
    const rings = whole.flatMap((region) => [region.outer, ...region.holes])
    if (!pointInPoly(rings, center.x, center.y)) return 0
    const capsule: CopperShape = { ...hole, halfWidth: 0 }
    let nearest = Infinity
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        nearest = Math.min(
          nearest,
          segmentToShape(capsule, ring[j].x, ring[j].y, ring[i].x, ring[i].y, 0)
        )
    return Math.round(mmToNm(Math.max(0, nearest - hole.halfWidth)))
  }
  board.footprints.forEach((bfp, fpIndex) => {
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((pad, padIndex) => {
      const drill = pad.drill
      if (!drill || drill.diameter <= 0) return
      const w = drill.oval?.width ?? drill.diameter
      const h = drill.oval?.height ?? drill.diameter
      if (w <= 0 || h <= 0) return
      const center = tfPoint(tf, pad.position.x, pad.position.y)
      // The pad's copper, or for a pad with none its center.
      const padItem = itemAt(`pad:${fpIndex}:${padIndex}`)
      // A pad with copper is its copper's box; a region run leaves out one not in it.
      if (
        !padItem &&
        region &&
        pad.layers.some((l) => l === '*.Cu' || l === 'F&B.Cu' || isCopperLayer(l))
      )
        return
      const box: Box = padItem ?? {
        minX: center.x,
        minY: center.y,
        maxX: center.x,
        maxY: center.y
      }
      if (!near(box)) return
      const subject = padSubject(bfp, pad, center)
      const ruleItem = ruleSet.padItem(fpIndex, padIndex)
      // KiCad holds the smaller axis to the min and the larger to the max.
      const holeRule = sizeRule('hole_size', ruleItem, null)
      const minor = Math.min(w, h)
      const major = Math.max(w, h)
      const hole =
        holeRule.max !== null && major > holeRule.max
          ? outOfRange(major, holeRule, `The hole of ${subject.name}`)
          : outOfRange(minor, holeRule, `The hole of ${subject.name}`)
      if (hole)
        one(
          'drill-out-of-range',
          'error',
          hole.message,
          subject,
          center,
          [box],
          holeRule.severity,
          { measure: hole.measure }
        )
      if (pad.type !== 'thru_hole') return
      // Annular width: the ring the drill leaves on the narrower axis (KiCad's
      // fast path), or measured on the pad's outline where KiCad measures it
      // so — an offset drill, a custom or trapezoid pad, a deep chamfer. Pads
      // of the same number are one pad: their copper joins this one's, their
      // holes cut it, and the ring is measured to that whole's edge — unless
      // none of them covers this pad or cuts it with a hole, when a round pad
      // keeps its own ring, and another does where that ring passes.
      // A padstack is measured on each of its distinct layers, each reported
      // apart, as KiCad measures each unique padstack layer.
      const ringLimit = sizeRule('annular_width', ruleItem, null)
      const sameNumber = pad.number
        ? bfp.footprint.pads.flatMap((other, index) =>
            other !== pad && other.number === pad.number ? [{ other, index }] : []
          )
        : []
      const rings: Array<{ layer: string; ring: number }> = []
      const seen = new Set<KicadPad>()
      for (const layer of copperLayers) {
        const onLayer = padOnLayer(pad, layer)
        if (seen.has(onLayer)) continue
        seen.add(onLayer)
        const offset = onLayer.drill?.offset
        const exact =
          (offset && (offset.x !== 0 || offset.y !== 0)) ||
          onLayer.shape === 'custom' ||
          onLayer.shape === 'trapezoid' ||
          ((onLayer.chamfer?.length ?? 0) > 0 && (onLayer.chamferRatio ?? 0) > 0.3)
        const axis = Math.min(
          Math.round((onLayer.size.w - w) / 2),
          Math.round((onLayer.size.h - h) / 2)
        )
        // Tight boxes, as KiCad compares pads' bounds.
        const boxOn = (index: number): Box | null => {
          const it = itemAt(`pad:${fpIndex}:${index}`)
          if (!it || !it.layers.includes(layer)) return null
          return shapeOutlines(shapeOn(it, layer), 0, ruleSet.maxError)
            .map(ringBox)
            .reduce(unionBox)
        }
        const own = boxOn(padIndex)
        const overlapping = own
          ? sameNumber.flatMap(({ other, index }) => {
              const otherBox = boxOn(index)
              return otherBox && boxesTouch(otherBox, own) ? [{ other, box: otherBox }] : []
            })
          : []
        let covers = false
        let cuts = false
        for (const { other, box: otherBox } of overlapping) {
          if (
            otherBox.minX <= own!.minX &&
            otherBox.minY <= own!.minY &&
            otherBox.maxX >= own!.maxX &&
            otherBox.maxY >= own!.maxY
          )
            covers = true
          const otherHole = padHoleShape(other, tfPoint(tf, other.position.x, other.position.y))
          if (otherHole && boxesTouch(holeBox(otherHole), own!)) cuts = true
        }
        const minOnly = ringLimit.min !== null && ringLimit.max === null
        if (!exact && overlapping.length && !covers && !cuts && minOnly) {
          if (onLayer.shape === 'circle' || axis >= ringLimit.min!) {
            rings.push({ layer, ring: axis })
            continue
          }
        }
        const ringOn =
          exact || overlapping.length
            ? ((sameNumber.length
                ? joinedAnnular(fpIndex, padIndex, pad, center, layer, sameNumber)
                : exactAnnular(fpIndex, padIndex, pad, center, layer)) ?? axis)
            : axis
        rings.push({ layer, ring: ringOn })
      }
      if (rings.length === 0) return
      for (const { layer, ring: width } of rings) {
        const ring = outOfRange(width, ringLimit, `The annular ring of ${subject.name}`)
        if (ring)
          one('annular-width', 'error', ring.message, subject, center, [box], ringLimit.severity, {
            measure: ring.measure,
            ...(rings.length > 1 ? { layer } : {})
          })
      }
    })
  })
}

/** A hole's bounds: its capsule's, else its shape's center. */
const holeBox = (hole: CopperShape): Box => {
  if (hole.kind === 'capsule')
    return {
      minX: Math.min(hole.x0, hole.x1) - hole.halfWidth,
      minY: Math.min(hole.y0, hole.y1) - hole.halfWidth,
      maxX: Math.max(hole.x0, hole.x1) + hole.halfWidth,
      maxY: Math.max(hole.y0, hole.y1) + hole.halfWidth
    }
  if (hole.kind === 'circle')
    return {
      minX: hole.cx - hole.r,
      minY: hole.cy - hole.r,
      maxX: hole.cx + hole.r,
      maxY: hole.cy + hole.r
    }
  return { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }
}

const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY)
})
