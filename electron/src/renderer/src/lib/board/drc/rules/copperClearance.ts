import { shapeCenter, shapeToShape, type CopperItem } from '../../spatialIndex'
import { boxesTouch, segmentsMeet } from '../../../geometry/polygon'
import { nm } from '../../../kicad/coordinates'
import type { SExprNode } from '../../../kicad/sexpr'
import type { DrcContext } from '../context'
import { DRC_EPSILON, collides, fmt, at, between, ownSeverity, worldOf } from '../shared'

export function* copperClearance(ctx: DrcContext): Generator<void> {
  const {
    board,
    emit,
    netName,
    pair,
    copperOf,
    maxClearance,
    sharesLayer,
    netsExempt,
    sideOf,
    requiredClearance,
    copperOn,
    flashesByLayer,
    layersOf,
    tiedPads,
    index,
    near: nearRegion,
    itemsFrom,
    tick,
    flaggedPadPairs,
    padPairKey
  } = ctx
  const reach = maxClearance + 1e-6
  // A pad's own net, `unconnected-(…)`, read without its sheet path.
  const unconnected = (net: number): boolean => {
    const name = netName(net)
    return name.slice(name.lastIndexOf('/') + 1).startsWith('unconnected-(')
  }
  /** The copper layers two items share where they come within the farthest clearance. */
  const layersWithinReach = (item: CopperItem, other: CopperItem): string[] => {
    const otherLayers = layersOf(other)
    return layersOf(item).filter((layer) => {
      if (!otherLayers.includes(layer)) return false
      const ca = copperOn(item, layer)
      const cb = copperOn(other, layer)
      return !!ca && !!cb && collides(ca.shape, cb.shape, maxClearance)
    })
  }
  const claims = freePadClaims(ctx)
  /** A free pad and a track or via of the net that claimed it: not tested, as KiCad does not. */
  const claimed = (pad: CopperItem, track: CopperItem): boolean =>
    pad.ref.type === 'pad' && track.ref.type !== 'pad' && claims.get(pad.id) === track.net
  for (const from of itemsFrom(0)) {
    if (tick()) yield
    if (!copperOf.get(from.id)!.copper) continue
    const near = index.query(
      from.minX - reach,
      from.minY - reach,
      from.maxX + reach,
      from.maxY + reach
    )
    for (const to of near) {
      // Each pair once, from its first item: in a region run, from whichever is in it.
      if (to.id <= from.id && nearRegion(to)) continue
      // Measured in the board's order whichever side found it, so it reads the same.
      const [item, other] = to.id < from.id ? [to, from] : [from, to]
      const a = copperOf.get(item.id)!
      const b = copperOf.get(other.id)!
      if (!a.copper || !b.copper || !sharesLayer(item.layers, other.layers)) continue
      if (netsExempt(a, item.net, b, other.net)) continue
      if (claimed(item, other) || claimed(other, item)) continue
      // Pads a footprint ties together (`net_tie_pad_groups`) may touch.
      if (a.footprint !== null && a.footprint === b.footprint && tiedPads(a, b)) continue
      // One logical pad: a shared number in one footprint is one connection, so
      // two nets on it are a short wherever the pads come within reach.
      if (
        a.footprint !== null &&
        a.footprint === b.footprint &&
        a.padNumber !== null &&
        a.padNumber === b.padNumber
      ) {
        if (item.net !== 0 && other.net !== 0 && !(unconnected(item.net) && unconnected(other.net)))
          for (const layer of layersWithinReach(item, other))
            emit(
              {
                code: 'copper-short',
                severity: 'error',
                message: `${a.subject.name} and ${b.subject.name} are one pad on two nets (${netName(item.net)} and ${netName(other.net)}).`,
                detail: `${netName(item.net)} · ${netName(other.net)}`,
                position: at(other.anchor ?? shapeCenter(other.shape)),
                layer,
                ...pair(a.subject, b.subject)
              },
              [item, other]
            )
        continue
      }
      // KiCad tests a pair on each copper layer the two share, each item as its
      // copper there (a via or pad not flashed on a layer is only its hole),
      // and reports every layer it fails on.
      const otherLayers = layersOf(other)
      const layers = layersOf(item).filter((layer) => otherLayers.includes(layer))
      const uniform = !flashesByLayer(item) && !flashesByLayer(other)
      for (const layer of layers) {
        const ca = uniform ? { shape: item.shape } : copperOn(item, layer)
        const cb = uniform ? { shape: other.shape } : copperOn(other, layer)
        if (!ca || !cb) continue
        const required = requiredClearance(sideOf(a), sideOf(b), layer)
        if (required.value <= 0 || required.severity === 'ignore') continue
        const actual = shapeToShape(ca.shape, cb.shape)
        if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
        const shapeA = ca.shape
        const shapeB = cb.shape

        // Two tracks whose centerlines meet at all — crossing, end to end or
        // along one line — cross, as KiCad tests them before their clearance.
        if (item.ref.type === 'segment' && other.ref.type === 'segment') {
          const s = board.segments[item.ref.index]
          const t = board.segments[other.ref.index]
          const meet = segmentsMeet(s.start, s.end, t.start, t.end)
          if (meet) {
            emit(
              {
                code: 'tracks-crossing',
                severity: 'error',
                message: `${a.subject.name} and ${b.subject.name} cross.`,
                position: at(worldOf({ x: nm(meet.x), y: nm(meet.y) })),
                layer,
                ...pair(a.subject, b.subject),
                ...ownSeverity(required.severity)
              },
              [item, other]
            )
            continue
          }
        }
        // Touching copper is a short when it joins nets; two pads on no net
        // only fail their clearance.
        const bothPads = a.footprint !== null && b.footprint !== null
        const short = bothPads
          ? item.net !== 0 && other.net !== 0
          : item.net !== 0 || other.net !== 0
        if (bothPads) flaggedPadPairs.add(padPairKey(item.id, other.id))
        if (actual === 0 && short) {
          emit(
            {
              code: 'copper-short',
              severity: 'error',
              message: `${a.subject.name} and ${b.subject.name} touch on ${layer} (nets ${netName(item.net) || '(none)'} and ${netName(other.net) || '(none)'}).`,
              detail: `${netName(item.net) || '(none)'} · ${netName(other.net) || '(none)'}`,
              position: at(between(shapeA, shapeB)),
              layer,
              ...pair(a.subject, b.subject),
              ...ownSeverity(required.severity)
            },
            [item, other]
          )
          continue
        }
        emit(
          {
            code: 'copper-clearance',
            severity: 'error',
            message: `${a.subject.name} and ${b.subject.name} are ${fmt(actual)} apart on ${layer}; ${required.rule} needs ${fmt(required.value)}.`,
            measure: {
              actual,
              limit: required.value,
              bound: 'min',
              unit: 'mm',
              rule: required.rule
            },
            position: at(between(shapeA, shapeB)),
            layer,
            ...pair(a.subject, b.subject),
            ...ownSeverity(required.severity)
          },
          [item, other]
        )
      }
    }
  }
}

/**
 * The net each free pad takes (`unconnected-(…)`, pin type free): that of the
 * first track or via, in file order, whose copper touches it. KiCad's track
 * pass lets that net, and only it, meet the pad.
 */
function freePadClaims(ctx: DrcContext): Map<number, number> {
  const { board, index, copperOn, layersOf, netName } = ctx
  const claims = new Map<number, number>()
  const free = index.items.filter((item) => {
    if (item.ref.type !== 'pad') return false
    const pad = board.footprints[item.ref.index].footprint.pads[item.ref.pad]
    const name = netName(item.net)
    return (
      pad.pinType === 'free' && name.slice(name.lastIndexOf('/') + 1).startsWith('unconnected-(')
    )
  })
  if (free.length === 0) return claims
  const order = new Map<SExprNode, number>(
    board._raw.type === 'list' ? board._raw.children.map((node, i) => [node, i]) : []
  )
  const placeOf = (item: CopperItem): number => {
    const raw =
      item.ref.type === 'segment'
        ? board.segments[item.ref.index]._raw
        : item.ref.type === 'tarc'
          ? board.trackArcs[item.ref.index]._raw
          : board.vias[item.ref.index]._raw
    return order.get(raw) ?? 0
  }
  const tracks = index.items
    .filter(
      (item) => item.ref.type === 'segment' || item.ref.type === 'tarc' || item.ref.type === 'via'
    )
    .sort((a, b) => placeOf(a) - placeOf(b))
  for (const track of tracks)
    for (const pad of free) {
      if (claims.has(pad.id) || !boxesTouch(track, pad)) continue
      const touch = layersOf(track).some((layer) => {
        const a = copperOn(track, layer)
        const b = copperOn(pad, layer)
        return !!a && !!b && shapeToShape(a.shape, b.shape) <= 0
      })
      if (touch) claims.set(pad.id, track.net)
    }
  return claims
}
