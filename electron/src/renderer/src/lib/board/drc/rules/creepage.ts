import { effectiveClassName } from '../../../kicad/project'
import { getNetName } from '../../../kicad/board'
import { shapeOn, type CopperShape } from '../../spatialIndex'
import { CreepSurface, creepCopper, type CreepCopper } from '../../creepage'
import type { RuleItem } from '../../rules/constraints'
import type { Box } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { at, fmt, idsOf, ownSeverity, type Subject } from '../shared'

/**
 * Creepage (KiCad's `creepage`): for every two nets and every copper layer
 * the project's rules give a creepage distance, the shortest way over the
 * board's surface between their copper there (`board/creepage.ts`) must be at
 * least that long. Each pair of items is reported once, at the shortest path
 * between them. Board-scoped: a path runs round the whole board's edges.
 */
export function* creepage(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, index, copperLayers, copperOf, drawings, fills, emit, pair, tick } = ctx
  if (!ruleSet.resolver.hasRules('creepage')) return
  const worst = ruleSet.resolver.worst('creepage')
  if (worst <= 0) return

  // Each net's copper on each layer, as creepage paths meet it, and each net's box.
  const subjects: Subject[] = []
  const byNet = new Map<number, { layers: Map<string, CreepCopper[]>; box: Box }>()
  const add = (net: number, layer: string, shape: CopperShape, subject: Subject): void => {
    const item = subjects.length
    subjects.push(subject)
    let entry = byNet.get(net)
    if (!entry) {
      entry = {
        layers: new Map(),
        box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      }
      byNet.set(net, entry)
    }
    const list = entry.layers.get(layer) ?? []
    for (const piece of creepCopper(shape, item)) {
      list.push(piece)
      entry.box = {
        minX: Math.min(entry.box.minX, piece.a.x - piece.r, piece.b.x - piece.r),
        minY: Math.min(entry.box.minY, piece.a.y - piece.r, piece.b.y - piece.r),
        maxX: Math.max(entry.box.maxX, piece.a.x + piece.r, piece.b.x + piece.r),
        maxY: Math.max(entry.box.maxY, piece.a.y + piece.r, piece.b.y + piece.r)
      }
    }
    entry.layers.set(layer, list)
  }
  for (const item of index.items) {
    const subject = copperOf.get(item.id)!.subject
    for (const layer of item.layers)
      if (copperLayers.includes(layer)) add(item.net, layer, shapeOn(item, layer), subject)
  }
  // Copper drawn on the board with a net, and every zone's fill.
  for (const d of drawings) {
    if (!d.connected) continue
    const subject = copperOf.get(d.id)!.subject
    for (const layer of d.layers) add(d.net, layer, d.shape, subject)
  }
  for (const fill of fills)
    add(fill.net, fill.layer, { kind: 'poly', rings: [fill.ring], ...fill.box }, fill.subject)

  const nets = [...new Set([0, ...board.nets.map((n) => n.number), ...byNet.keys()])].sort(
    (a, b) => a - b
  )
  const trackOf = new Map<number, (layer: string) => RuleItem>()
  const probe = (net: number, layer: string): RuleItem => {
    let make = trackOf.get(net)
    if (!make) {
      const netName = net > 0 ? getNetName(board, net) : ''
      const netClass = effectiveClassName(ruleSet.netClassOf(net))
      make = (l) => ({
        kind: 'track',
        label: `track${netName ? ` ${netName}` : ''}`,
        net,
        netName,
        netClass,
        layers: [l],
        nonCopper: false
      })
      trackOf.set(net, make)
    }
    return make(layer)
  }

  // A tie between equally short paths goes to the items with the higher KiCad uuid: KiCad's
  // own pick among them follows its memory order.
  const rank = (item: number): string => idsOf(subjects[item]).join(',')
  let surface: CreepSurface | null = null
  const reported = new Set<string>()
  for (let i = 0; i < nets.length; i++) {
    const a = byNet.get(nets[i])
    if (!a) continue
    for (let j = i + 1; j < nets.length; j++) {
      const b = byNet.get(nets[j])
      if (!b) continue
      if (tick()) yield
      for (const layer of copperLayers) {
        const from = a.layers.get(layer)
        const to = b.layers.get(layer)
        if (!from || !to) continue
        const resolved = ruleSet.resolver.evaluate(
          'creepage',
          probe(nets[i], layer),
          probe(nets[j], layer),
          layer
        )
        const value =
          resolved.isNull || resolved.severity === 'ignore' ? 0 : (resolved.value.min ?? 0)
        if (value <= 0 || boxGap(a.box, b.box) > value) continue
        surface ??= new CreepSurface(board, worst)
        const path = surface.shortest(from, to, layer, value, rank)
        if (!path || path.distance >= value) continue
        const first = subjects[path.from]
        const second = subjects[path.to]
        const key = [first.item, second.item].sort().join('|')
        if (reported.has(key)) continue
        reported.add(key)
        emit(
          {
            code: 'creepage',
            severity: 'error',
            message: `${first.name} and ${second.name} are ${fmt(path.distance)} apart over the board surface; ${resolved.name} needs ${fmt(value)}.`,
            measure: {
              actual: path.distance,
              limit: value,
              bound: 'min',
              unit: 'mm',
              rule: resolved.name
            },
            position: at(path.start),
            ...pair(first, second),
            ...ownSeverity(resolved.severity)
          },
          []
        )
      }
    }
  }
}

const boxGap = (a: Box, b: Box): number =>
  Math.hypot(
    Math.max(0, a.minX - b.maxX, b.minX - a.maxX),
    Math.max(0, a.minY - b.maxY, b.minY - a.maxY)
  )
