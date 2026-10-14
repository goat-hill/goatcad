import {
  shapeOn,
  pointToShape,
  shapeCenter,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../../spatialIndex'
import {
  CONNECT_EPSILON,
  zoneMayConnect,
  connectShape,
  itemsConnect
} from '../../boardConnectivity'
import { boxesTouch, type Box } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { type FillRing } from '../shared'

/**
 * Whether a track's or via's copper reaches something, as KiCad's
 * `TestTrackEndpointDangling` asks, one item at a time. Copper `remove`d
 * from the probe no longer counts, so a cleanup can delete what dangles and
 * ask again of what touched it (`trackCleanup.ts`).
 */
export interface DanglingProbe {
  /** The layers a via joins copper on: it dangles on fewer than two, unless it is netless and joins nothing. */
  viaLayers: (item: CopperItem) => Set<string>
  /** A track's or arc's end that connects to nothing, or null when both connect. */
  openEnd: (item: CopperItem) => Pt | null
  /** What `item` touches, and on which layers, among the copper still counted. */
  touching: (item: CopperItem) => Array<{ other: CopperItem; layers: string[] }>
  /** Count an item as gone from here on. */
  remove: (id: number) => void
}

/** The probe over a check's context, its fills gathered round `tested` (all of the index when omitted). */
export function* danglingProbe(
  ctx: DrcContext,
  tested: readonly CopperItem[] = ctx.index.items
): Generator<void, DanglingProbe> {
  const {
    region,
    copperLayers,
    sliceDone,
    drawingSet,
    fills,
    itemsNear,
    shapeToFill,
    board,
    index
  } = ctx
  const gone = new Set<number>()
  // KiCad's `TestTrackEndpointDangling`: a track needs copper at both ends,
  // within half its width, and one item at both ends only counts for the
  // nearer (a zone counts for both); a via needs copper on two layers. Copper
  // of any net counts: KiCad joins a track or via to whatever it touches,
  // and leaves the short to the clearance rules.
  const stackOrder = new Map(copperLayers.map((layer, i) => [layer, i]))
  const firstLayer = (layers: readonly string[]): string =>
    [...layers].sort((a, b) => (stackOrder.get(a) ?? 0) - (stackOrder.get(b) ?? 0))[0]
  // The fills whose box reaches each track and via, gathered once from the fills' side.
  const fillsNear = new Map<number, FillRing[]>()
  for (const fill of fills) {
    const near = region
      ? tested.filter((item) => boxesTouch(item, fill.box, CONNECT_EPSILON))
      : itemsNear(fill.box, CONNECT_EPSILON)
    for (const item of near) {
      if (sliceDone()) yield
      if (item.ref.type === 'pad' || !item.layers.includes(fill.layer)) continue
      const list = fillsNear.get(item.id) ?? []
      list.push(fill)
      fillsNear.set(item.id, list)
    }
  }
  const fillsOn = (item: CopperItem): FillRing[] => fillsNear.get(item.id) ?? []
  // What an item touches, and on which layers, as connectivity joins them:
  // a via without its unused layers is only its hole where it is not flashed.
  // A board graphic is copper a track or via joins; footprint graphics and text are not.
  const touching = (item: CopperItem): Array<{ other: CopperItem; layers: string[] }> =>
    [
      ...index.query(
        item.minX - CONNECT_EPSILON,
        item.minY - CONNECT_EPSILON,
        item.maxX + CONNECT_EPSILON,
        item.maxY + CONNECT_EPSILON
      ),
      ...drawingSet
        .query(
          item.minX - CONNECT_EPSILON,
          item.minY - CONNECT_EPSILON,
          item.maxX + CONNECT_EPSILON,
          item.maxY + CONNECT_EPSILON
        )
        .filter((d) => d.connected)
    ]
      .filter((other) => other.id !== item.id && !gone.has(other.id))
      .map((other) => ({ other, layers: itemsConnect(board, item, other) }))
      .filter(({ layers }) => layers.length > 0)
  // A track's ends are tested against a via as KiCad draws it on the track's
  // layer (`PCB_VIA::FlashLayer`): a conditionally flashed via has its pad
  // there only when copper of its own net joins it on that layer, else its hole.
  const flashedOn = new Map<string, boolean>()
  const endShape = (other: CopperItem, layer: string): CopperShape => {
    const hole = connectShape(board, other, layer)
    if (hole === shapeOn(other, layer)) return hole
    const key = `${other.id}:${layer}`
    let flashed = flashedOn.get(key)
    if (flashed === undefined) {
      // Connected anywhere to copper of its own net that spans this layer, as KiCad asks.
      flashed = touching(other).some(
        (contact) =>
          contact.other.net === other.net && other.net > 0 && contact.other.layers.includes(layer)
      )
      flashedOn.set(key, flashed)
    }
    return flashed ? shapeOn(other, layer) : hole
  }
  const fillTouches = (fill: FillRing, shape: CopperShape, box: Box): boolean =>
    boxesTouch(fill.box, box, CONNECT_EPSILON) &&
    shapeToFill(shape, box, fill, CONNECT_EPSILON).actual <= CONNECT_EPSILON
  const ends = (shape: CopperShape): [Pt, Pt] | null =>
    shape.kind === 'capsule' || shape.kind === 'arc'
      ? [
          { x: shape.x0, y: shape.y0 },
          { x: shape.x1, y: shape.y1 }
        ]
      : null
  const viaLayers = (item: CopperItem): Set<string> => {
    const layers = new Set<string>()
    for (const contact of touching(item)) layers.add(firstLayer(contact.layers))
    for (const fill of fillsOn(item))
      if (
        zoneMayConnect(board, item.ref, fill.layer) &&
        fillTouches(fill, shapeOn(item, fill.layer), item)
      )
        layers.add(fill.layer)
    return layers
  }
  const openEnd = (item: CopperItem): Pt | null => {
    const trackEnds = ends(item.shape)
    if (!trackEnds) return null
    const [start, end] = trackEnds
    const reach =
      (item.shape.kind === 'capsule' || item.shape.kind === 'arc' ? item.shape.halfWidth : 0) + 1e-9
    let startCount = 0
    let endCount = 0
    let joined = false
    for (const fill of fillsOn(item)) {
      const hit = (p: Pt): boolean =>
        fillTouches(
          fill,
          { kind: 'circle', cx: p.x, cy: p.y, r: reach },
          {
            minX: p.x - reach,
            minY: p.y - reach,
            maxX: p.x + reach,
            maxY: p.y + reach
          }
        )
      const hitStart = hit(start)
      const hitEnd = hit(end)
      if (hitStart && hitEnd) joined = true
      if (hitStart) startCount++
      if (hitEnd) endCount++
    }
    if (!joined) {
      const trackLayer = item.layers[0]
      for (const { other } of touching(item)) {
        const contact = endShape(other, trackLayer)
        const hitStart = pointToShape(contact, start.x, start.y) <= reach
        const hitEnd = pointToShape(contact, end.x, end.y) <= reach
        if (hitStart && hitEnd) {
          if (other.ref.type === 'pad' || other.ref.type === 'via') {
            joined = true
            break
          }
          // A graphic is placed at its first point (`GetPosition`).
          const placed = drawingSet.byId(other.id)?.anchors.slice(0, 1)
          const toStart = Math.min(
            ...(placed ?? ends(other.shape) ?? [shapeCenter(other.shape)]).map((p) =>
              Math.hypot(p.x - start.x, p.y - start.y)
            )
          )
          const toEnd = Math.min(
            ...(placed ?? ends(other.shape) ?? [shapeCenter(other.shape)]).map((p) =>
              Math.hypot(p.x - end.x, p.y - end.y)
            )
          )
          if (toStart < toEnd) startCount++
          else endCount++
        } else if (hitStart) startCount++
        else if (hitEnd) endCount++
      }
    }
    if (joined || (startCount > 0 && endCount > 0)) return null
    return startCount === 0 ? start : end
  }
  return {
    viaLayers,
    openEnd,
    touching,
    remove: (id) => {
      gone.add(id)
      flashedOn.clear()
    }
  }
}

export function* dangling(ctx: DrcContext): Generator<void> {
  const { itemsFrom, sliceDone, one, ruleSet, copperOf } = ctx
  const tested = itemsFrom(0)
  const probe = yield* danglingProbe(ctx, tested)
  {
    for (const item of tested) {
      if (sliceDone()) yield
      const type = item.ref.type
      if (type === 'pad') continue
      const subject = copperOf.get(item.id)!.subject
      if (type === 'via') {
        const layers = probe.viaLayers(item)
        if (layers.size >= 2 || (layers.size === 0 && item.net <= 0)) continue
        // A rule may rank this via's dangling end, or set it aside.
        const rule = ruleSet.resolver.evaluate(
          'via_dangling',
          ruleSet.copperItem(item),
          null,
          item.layers[0] ?? null
        )
        if (rule.severity === 'ignore') continue
        one(
          'via-dangling',
          rule.severity === 'error' ? 'error' : 'warning',
          layers.size === 0
            ? `${subject.name} connects to nothing.`
            : `${subject.name} connects only on ${[...layers][0]}, so it joins nothing.`,
          subject,
          shapeCenter(item.shape),
          [item],
          rule.severity
        )
        continue
      }
      const open = probe.openEnd(item)
      if (!open) continue
      one(
        'track-dangling',
        'warning',
        `${subject.name} has an end that connects to nothing.`,
        subject,
        open,
        [item]
      )
    }
  }
}
