import type { CheckMeasure } from '../../../schematic/checks'
import { getNetName, viaSizeOn } from '../../../kicad/board'
import { findChild, getAtomValues } from '../../../kicad/sexpr'
import { mmAtomToNm, nmToMm, type Nm } from '../../../kicad/coordinates'
import { isCopperLayer } from '../../../kicad/layers'
import type { TuningDelays } from '../../../kicad/project'
import type { KicadPad } from '../../../kicad/footprint'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import { padOnLayer } from '../../../kicad/footprint'
import { inPolygon, padPolygon, polygonCrossing, type IPt } from '../../padPolygon'
import { itemsConnect } from '../../boardConnectivity'
import { pointToShape, shapeOn, type CopperItem } from '../../spatialIndex'
import type { Rule, RuleItem } from '../../rules/constraints'
import { matchDiffPair } from '../../rules/diffPairs'
import {
  copperRank,
  netLength,
  stackupHeights,
  type LengthInput,
  type LengthPad,
  type LengthVia,
  type NmPt,
  type Piece
} from '../../netLength'
import type { Box } from '../../../geometry/polygon'
import type { DrcContext } from '../context'
import { at, fmt, idsOf, ownSeverity, worldOf, type Subject } from '../shared'

/** One item a length rule holds: its subject, net, box and what the length calculator reads. */
interface Held {
  subject: Subject
  net: number
  box: Box
  position: { x: number; y: number }
  line?: { layer: string; pieces: Piece[] }
  via?: LengthVia
  pad?: LengthPad
}

/** Attoseconds per picosecond: KiCad's time unit. */
const AS_PER_PS = 1e6

/**
 * The matched-length rules (`length`, `skew`, `via_count`), as KiCad's length
 * provider holds them: every track, arc, via and pad a rule applies to,
 * gathered by the rule that decided it and then by net; each net's length
 * (or, for a rule in picoseconds, its propagation delay) and via count from
 * the length calculator (`netLength.ts`). Skew is each net's difference from
 * the rule's longest, within each diff pair where the rule says so.
 * Board-scoped: a net's length reads all of it.
 */
export function* signal(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, settings, emit, tick, itemByRef, index } = ctx
  const resolver = ruleSet.resolver
  const types = (['length', 'skew', 'via_count'] as const).filter((t) => resolver.hasRules(t))
  if (types.length === 0) return

  const heights = stackupHeights(board)
  const copperOrder = board.layers
    .map((l) => l.name)
    .filter(isCopperLayer)
    .sort((a, b) => copperRank(a) - copperRank(b))
  const useHeight = settings.rules.useHeightForLengthCalcs
  const maxError = Math.round(settings.rules.maxError * 1e6)
  const nmOf = (p: { x: Nm; y: Nm }): NmPt => ({ x: p.x, y: p.y })
  const boxOf = (item: CopperItem): Box => ({
    minX: item.minX,
    minY: item.minY,
    maxX: item.maxX,
    maxY: item.maxY
  })

  // Every track, arc, via and pad, with the rule each type's constraint comes from.
  const byRule = new Map<Rule, Held[]>()
  const hold = (held: Held, item: RuleItem, layer: string | null): void => {
    for (const type of types) {
      const resolved = resolver.evaluate(type, item, null, layer)
      if (resolved.isNull || !resolved.rule) continue
      const list = byRule.get(resolved.rule) ?? []
      if (!list.includes(held)) list.push(held)
      byRule.set(resolved.rule, list)
    }
  }

  for (const [kind, list] of [
    ['segment', board.segments],
    ['tarc', board.trackArcs]
  ] as const) {
    for (let i = 0; i < list.length; i++) {
      if (tick()) yield
      const item = itemByRef.get(`${kind}:${i}`)
      if (!item) continue
      const track = list[i]
      const pieces: Piece[] =
        kind === 'segment'
          ? [{ kind: 'seg', a: nmOf(track.start), b: nmOf(track.end) }]
          : [
              {
                kind: 'arc',
                a: nmOf(track.start),
                m: nmOf((track as (typeof board.trackArcs)[number]).mid),
                b: nmOf(track.end)
              }
            ]
      hold(
        {
          subject: ctx.subjectOfItem(item)!,
          net: item.net,
          box: boxOf(item),
          position: worldOf(track.start),
          line: { layer: track.layer, pieces }
        },
        ruleSet.copperItem(item),
        track.layer
      )
    }
  }

  for (let i = 0; i < board.vias.length; i++) {
    if (tick()) yield
    const item = itemByRef.get(`via:${i}`)
    if (!item) continue
    const via = board.vias[i]
    const radiusOn = (layer: string): number => viaSizeOn(via, layer) / 2
    const maxRadius = Math.max(...via.layers.map(radiusOn), via.size / 2)
    // A pad the via sits in carries the signal to its own side.
    let padSide: string | null = null
    for (const other of index.query(item.minX, item.minY, item.maxX, item.maxY)) {
      if (other.ref.type !== 'pad' || itemsConnect(board, item, other).length === 0) continue
      const bfp = board.footprints[other.ref.index]
      const pad = bfp.footprint.pads[other.ref.pad]
      padSide =
        pad.type === 'smd' || pad.type === 'connect'
          ? (copperOrder.find((layer) => other.layers.includes(layer)) ?? bfp.layer)
          : bfp.layer
      break
    }
    hold(
      {
        subject: ctx.subjectOfItem(item)!,
        net: item.net,
        box: boxOf(item),
        position: worldOf(via.position),
        via: {
          position: nmOf(via.position),
          top: via.layers[0],
          bottom: via.layers[via.layers.length - 1],
          radiusOn,
          maxRadius,
          padSide
        }
      },
      ruleSet.copperItem(item),
      via.layers[0] ?? null
    )
  }

  for (let fp = 0; fp < board.footprints.length; fp++) {
    if (tick()) yield
    const bfp = board.footprints[fp]
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((pad, p) => {
      const onCopper = pad.layers.some((l) => l === '*.Cu' || l === 'F&B.Cu' || isCopperLayer(l))
      if (!pad.drill && !onCopper) return
      const center = tfPoint(tf, pad.position.x, pad.position.y)
      const item = itemByRef.get(`pad:${fp}:${p}`)
      const position = { x: Math.round(center.x * 1e6), y: Math.round(-center.y * 1e6) }
      const principal =
        pad.layers.find(isCopperLayer) ?? (onCopper ? 'F.Cu' : (pad.layers[0] ?? null))
      // KiCad clips against the pad's error-inside polygon, one per padstack layer.
      const polygons = new Map<string, IPt[] | null>()
      const polygonOf = (layer: string): IPt[] | null => {
        if (!polygons.has(layer))
          polygons.set(layer, padPolygon(padOnLayer(pad, layer), position, maxError))
        return polygons.get(layer)!
      }
      hold(
        {
          subject: ctx.padSubject(bfp, pad, center),
          net: pad.net?.number ?? 0,
          box: item
            ? boxOf(item)
            : { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y },
          position: center,
          pad: {
            position,
            contains: (q, layer) => {
              if (!item || !item.layers.includes(layer)) return false
              const ring = polygonOf(layer)
              return ring
                ? inPolygon(ring, q)
                : pointToShape(shapeOn(item, layer), q.x / 1e6, -q.y / 1e6) === 0
            },
            crossing: (outside, inside, layer) => {
              const ring = polygonOf(layer)
              return ring ? polygonCrossing(ring, outside, inside) : null
            },
            flashed: (layer) => !!item && item.layers.includes(layer),
            dieLength: padValue(pad, 'die_length'),
            // A die delay is picoseconds in the file, as a length is millimeters: the same scale.
            dieDelay: padValue(pad, 'die_delay')
          }
        },
        item ? ruleSet.copperItem(item) : ruleSet.padItem(fp, p),
        principal
      )
    })
  }

  const netName = (net: number): string => (net > 0 ? getNetName(board, net) : '')
  const delaysOf = (net: number): TuningDelays | null => {
    const tuning = settings.tuning
    if (!tuning) return null
    const cls = ruleSet.netClassOf(net)
    const names = cls.constituents ?? [cls.name]
    const profile = names.map((name) => tuning.classProfiles[name]).find(Boolean)
    return (profile && tuning.delays?.[profile]) || null
  }

  for (const [rule, held] of byRule) {
    if (tick()) yield
    const byNet = new Map<number, Held[]>()
    for (const h of held) {
      const list = byNet.get(h.net) ?? []
      list.push(h)
      byNet.set(h.net, list)
    }
    const connections = [...byNet].map(([net, items]) => {
      const input: LengthInput = {
        lines: items.flatMap((h) => (h.line ? [h.line] : [])),
        vias: items.flatMap((h) => (h.via ? [h.via] : [])),
        pads: items.flatMap((h) => (h.pad ? [h.pad] : [])),
        stackupHeight: heights,
        copperOrder,
        useHeight,
        delays: delaysOf(net)
      }
      return { net, name: netName(net), items, stats: netLength(input) }
    })
    connections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const report = (
      code: string,
      message: string,
      c: (typeof connections)[number],
      measure: CheckMeasure
    ): void => {
      const subjects = c.items.map((h) => h.subject)
      emit(
        {
          code,
          severity: 'error',
          message,
          measure,
          items: [...new Set(subjects.map((s) => s.item))],
          targets: [...new Set(subjects.flatMap((s) => s.targets))],
          kicadIds: [...new Set(subjects.flatMap(idsOf))],
          subject: c.name ? `net ${c.name}` : 'no net',
          position: at(c.items[0].position),
          ...ownSeverity(rule.severity)
        },
        c.items.map((h) => h.box)
      )
    }
    const ignored = rule.severity === 'ignore'
    const measure = (value: { timeDomain?: boolean }, c: (typeof connections)[number]): number =>
      value.timeDomain ? c.stats.totalDelay : c.stats.total
    const scale = (value: { timeDomain?: boolean }, limit: number): number =>
      value.timeDomain ? Math.round(limit * AS_PER_PS) : Math.round(limit * 1e6)
    const show = (value: { timeDomain?: boolean }, amount: number): string =>
      value.timeDomain ? `${(amount / AS_PER_PS).toFixed(2)} ps` : fmt(nmToMm(amount as Nm))
    /** A length or delay held to its limit, as a row shows it. */
    const measured = (
      value: { timeDomain?: boolean },
      actual: number,
      limit: number,
      bound: 'min' | 'max'
    ): CheckMeasure => ({
      actual: value.timeDomain ? actual / AS_PER_PS : nmToMm(actual as Nm),
      limit,
      bound,
      unit: value.timeDomain ? 'ps' : 'mm',
      rule: rule.name
    })

    const length = rule.constraints.get('length')
    if (length && !ignored) {
      for (const c of connections) {
        const actual = measure(length, c)
        const below = length.min !== undefined && actual < scale(length, length.min)
        const above = !below && length.max !== undefined && actual > scale(length, length.max)
        if (!below && !above) continue
        const limit = below ? length.min! : length.max!
        report(
          'length-out-of-range',
          `The ${c.name ? `net ${c.name}` : 'connection'} is ${show(length, actual)} long; ${rule.name} needs ${below ? 'at least' : 'at most'} ${show(length, scale(length, limit))}.`,
          c,
          measured(length, actual, limit, below ? 'min' : 'max')
        )
      }
    }

    const skew = rule.constraints.get('skew')
    if (skew && !ignored) {
      const groups: Array<typeof connections> = []
      if (skew.withinDiffPairs) {
        // Each net with its pair's other half, if the rule holds that too.
        const byNet = new Map(connections.map((c) => [c.net, c]))
        for (const net of [...byNet.keys()].sort((a, b) => a - b)) {
          const c = byNet.get(net)
          if (!c) continue
          const pair = matchDiffPair(c.name)
          const other = pair
            ? [...byNet.values()].find((o) => o.name === pair.complement && o !== c)
            : undefined
          if (!other) continue
          groups.push([c, other])
          byNet.delete(other.net)
        }
      } else groups.push(connections)
      for (const group of groups) {
        let longest = 0
        let longestName = ''
        for (const c of group) {
          const value = measure(skew, c)
          if (value > longest) {
            longest = value
            longestName = c.name
          }
        }
        for (const c of group) {
          const actual = Math.round(measure(skew, c) - longest)
          const over = skew.max !== undefined && Math.abs(actual) > scale(skew, skew.max)
          const under = !over && skew.min !== undefined && Math.abs(actual) < scale(skew, skew.min)
          if (!over && !under) continue
          report(
            'skew-out-of-range',
            `The ${c.name ? `net ${c.name}` : 'connection'} is ${show(skew, Math.abs(actual))} ${actual < 0 ? 'shorter' : 'longer'} than ${longestName || 'the longest'}; ${rule.name} allows ${over ? 'at most' : 'at least'} ${show(skew, scale(skew, over ? skew.max! : skew.min!))}.`,
            c,
            measured(skew, Math.abs(actual), over ? skew.max! : skew.min!, over ? 'max' : 'min')
          )
        }
      }
    }

    const vias = rule.constraints.get('via_count')
    if (vias && !ignored) {
      for (const c of connections) {
        const count = c.stats.viaCount
        const over = vias.max !== undefined && count > vias.max
        const under = !over && vias.min !== undefined && count < vias.min
        if (!over && !under) continue
        report(
          'too-many-vias',
          `The ${c.name ? `net ${c.name}` : 'connection'} has ${count} ${count === 1 ? 'via' : 'vias'}; ${rule.name} allows ${over ? 'at most' : 'at least'} ${over ? vias.max : vias.min}.`,
          c,
          {
            actual: count,
            limit: (over ? vias.max : vias.min)!,
            bound: over ? 'max' : 'min',
            unit: 'count',
            rule: rule.name
          }
        )
      }
    }
  }
}

/** A pad's `(die_length …)` or `(die_delay …)`, in the file's scale times a million: nm, or attoseconds. */
function padValue(pad: KicadPad, token: string): number {
  const node = pad._raw.type === 'list' ? findChild(pad._raw, token) : null
  const value = node ? getAtomValues(node)[0] : undefined
  return value !== undefined ? mmAtomToNm(value) : 0
}
