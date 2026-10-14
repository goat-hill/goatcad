import { allZones } from '../../../kicad/board'
import { isCopperLayer } from '../../../kicad/layers'
import type { Nm } from '../../../kicad/coordinates'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import type { RuleItem } from '../../rules/constraints'
import type { Pt } from '../../spatialIndex'
import { boardTexts } from '../../boardTexts'
import type { DrcContext } from '../context'
import { positional, worldOf, type Subject } from '../shared'

/** One item of the board as the misc rules visit it: what it is, where, and on which layers. */
interface Visited {
  subject: Subject
  /** The layer it reports on: a track's, a via's top, a pad's principal, a drawing's. */
  layer: string | null
  /** For the disabled-layer test: the copper it sits on (a via its two ends). */
  copper: readonly string[]
  position: Pt
  rule: () => RuleItem
}

/**
 * The rules KiCad's miscellaneous provider runs that are not about the
 * outline: an item on a copper layer the board does not have
 * (`item_on_disabled_layer`), the project's assertions (`assertion_failure`),
 * and a net class naming a tuning profile the project lacks
 * (`missing_tuning_profile`).
 */
export function* misc(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, one, emit, tick, itemByRef, footprintSubject, padSubject, zoneSubject } =
    ctx
  const enabled = new Set(board.layers.map((l) => l.name))
  const disabled = (layer: string): boolean => isCopperLayer(layer) && !enabled.has(layer)
  const assertions = ruleSet.resolver.rules.filter((rule) => rule.constraints.has('assertion'))

  const visit = function* (): Generator<Visited | null> {
    for (const [list, kind] of [
      [board.segments, 'segment'],
      [board.trackArcs, 'tarc']
    ] as const)
      for (let i = 0; i < list.length; i++) {
        const track = list[i]
        const item = itemByRef.get(`${kind}:${i}`)
        const subject: Subject = item
          ? ctx.subjectOfItem(item)!
          : {
              item: track.uuid ?? positional('track', worldOf(track.start)),
              name: 'track',
              targets: track.uuid ? [track.uuid] : []
            }
        yield {
          subject,
          layer: track.layer,
          copper: [track.layer],
          position: worldOf(track.start),
          rule: () =>
            item
              ? ruleSet.copperItem(item)
              : { kind: 'track', label: 'track', layers: [track.layer], nonCopper: false }
        }
      }
    for (let i = 0; i < board.vias.length; i++) {
      const via = board.vias[i]
      const item = itemByRef.get(`via:${i}`)
      if (!item) continue
      yield {
        subject: ctx.subjectOfItem(item)!,
        layer: via.layers[0] ?? null,
        copper: [via.layers[0], via.layers[via.layers.length - 1]].filter(Boolean),
        position: worldOf(via.position),
        rule: () => ruleSet.copperItem(item)
      }
    }
    for (const zone of allZones(board)) {
      const first = zone.points[0] ?? { x: 0 as Nm, y: 0 as Nm }
      yield {
        subject: zoneSubject(zone),
        layer: zone.layers[0] ?? null,
        // A zone is never on a disabled layer: it takes what layers there are.
        copper: [],
        position: worldOf(first),
        rule: () => ruleSet.zoneItem(zone)
      }
    }
    for (let fp = 0; fp < board.footprints.length; fp++) {
      const bfp = board.footprints[fp]
      const tf = footprintTransform(bfp)
      for (let p = 0; p < bfp.footprint.pads.length; p++) {
        const pad = bfp.footprint.pads[p]
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const principal = pad.layers.find(isCopperLayer) ?? null
        const surface = pad.type === 'smd' || pad.type === 'connect'
        yield {
          subject: padSubject(bfp, pad, center),
          layer: principal,
          copper: surface && principal ? [principal] : [],
          position: center,
          rule: () => ruleSet.padItem(fp, p)
        }
      }
      yield {
        subject: footprintSubject(bfp),
        layer: bfp.layer,
        copper: [],
        position: worldOf(bfp.position),
        rule: () => ruleSet.footprintItem(fp)
      }
    }
    // Graphics, board and footprint, by the layer each is drawn on.
    const graphic = (g: Graphic, fp: number | undefined, at: Pt): Visited | null => {
      if (!g.layer) return null
      const owner = fp !== undefined ? footprintSubject(board.footprints[fp]) : null
      const layer = g.layer
      return {
        subject: {
          item: ctx.drawingId(g.uuid, fp) ?? positional('graphic', at),
          name: owner ? `graphic of ${owner.name}` : `graphic on ${layer}`,
          targets: owner ? owner.targets : g.uuid ? [g.uuid] : [],
          ...(owner && g.uuid ? { ids: [g.uuid] } : {})
        },
        layer,
        copper: [layer],
        position: at,
        rule: () => ({
          kind: 'graphic',
          label: 'graphic',
          layers: [layer],
          nonCopper: !isCopperLayer(layer),
          ...(fp !== undefined
            ? {
                footprint: board.footprints[fp].reference,
                footprintLayer: board.footprints[fp].layer
              }
            : {})
        })
      }
    }
    for (const g of [
      ...board.grLines,
      ...board.grArcs,
      ...board.grCircles,
      ...board.grRects,
      ...board.grPolys,
      ...board.grCurves
    ]) {
      const anchor = anchorOf(g)
      yield graphic(g, undefined, anchor ? worldOf(anchor) : { x: 0, y: 0 })
    }
    for (let fp = 0; fp < board.footprints.length; fp++) {
      const bfp = board.footprints[fp]
      const f = bfp.footprint
      const tf = footprintTransform(bfp)
      for (const g of [
        ...f.fpLines,
        ...f.fpArcs,
        ...f.fpCircles,
        ...f.fpRects,
        ...f.fpPolys,
        ...f.fpCurves
      ]) {
        const anchor = anchorOf(g)
        yield graphic(g, fp, anchor ? tfPoint(tf, anchor.x, anchor.y) : worldOf(bfp.position))
      }
    }
    for (const t of boardTexts(board)) {
      const owner = t.fp !== undefined ? footprintSubject(board.footprints[t.fp]) : null
      const layer = t.layer
      yield {
        subject: {
          item: ctx.drawingId(t.uuid, t.fp) ?? positional(t.kind, t.position),
          name: owner ? `${t.field ?? t.kind} of ${owner.name}` : `${t.kind} on ${layer}`,
          targets: owner ? owner.targets : t.uuid ? [t.uuid] : [],
          ...(owner && t.uuid ? { ids: [t.uuid] } : {})
        },
        layer,
        copper: [layer],
        position: t.position,
        rule: () => ({
          kind: t.kind === 'field' ? 'text' : t.kind,
          label: t.kind,
          layers: [layer],
          nonCopper: !isCopperLayer(layer),
          ...(t.fp !== undefined
            ? {
                footprint: board.footprints[t.fp].reference,
                footprintLayer: board.footprints[t.fp].layer
              }
            : {})
        })
      }
    }
  }
  // Most boards use only the layers they have and set no assertions: then no
  // item needs visiting, and building each one's subject is most of the cost.
  const usesDisabledLayer = (): boolean => {
    const onDisabled = (layer: string | undefined): boolean => !!layer && disabled(layer)
    if (board.segments.some((t) => onDisabled(t.layer))) return true
    if (board.trackArcs.some((t) => onDisabled(t.layer))) return true
    if (board.vias.some((v) => v.layers.some(onDisabled))) return true
    const graphics = [
      board.grLines,
      board.grArcs,
      board.grCircles,
      board.grRects,
      board.grPolys,
      board.grCurves
    ]
    if (graphics.some((list) => list.some((g) => onDisabled(g.layer)))) return true
    if (boardTexts(board).some((t) => onDisabled(t.layer))) return true
    return board.footprints.some(
      ({ footprint: f }) =>
        f.pads.some(
          (pad) =>
            (pad.type === 'smd' || pad.type === 'connect') &&
            onDisabled(pad.layers.find(isCopperLayer))
        ) ||
        [f.fpLines, f.fpArcs, f.fpCircles, f.fpRects, f.fpPolys, f.fpCurves].some((list) =>
          list.some((g) => onDisabled(g.layer))
        )
    )
  }
  const walk = assertions.length > 0 || usesDisabledLayer()
  for (const visited of walk ? visit() : []) {
    if (!visited) continue
    if (tick()) yield
    const box = {
      minX: visited.position.x,
      minY: visited.position.y,
      maxX: visited.position.x,
      maxY: visited.position.y
    }
    const bad = visited.copper.find(disabled)
    if (bad)
      one(
        'item-on-disabled-layer',
        'error',
        `${visited.subject.name} is on ${bad}, a copper layer the board does not have.`,
        visited.subject,
        visited.position,
        [box]
      )
    if (assertions.length === 0) continue
    const item = visited.rule()
    for (const rule of assertions) {
      const context = { a: item, b: null, layer: visited.layer, type: 'assertion' as const }
      if (rule.condition && !rule.condition(context)) continue
      const test = rule.constraints.get('assertion')?.assertion
      if (!test || test(context)) continue
      one(
        'assertion-failure',
        'error',
        `${visited.subject.name} fails the assertion of ${rule.name}.`,
        visited.subject,
        visited.position,
        [box]
      )
    }
  }

  const tuning = ctx.settings.tuning
  if (tuning) {
    const profiles = new Set(tuning.profiles)
    for (const [name, profile] of Object.entries(tuning.classProfiles)) {
      if (!profile || profiles.has(profile)) continue
      emit(
        {
          code: 'missing-tuning-profile',
          severity: 'warning',
          message: `Net class ${name} uses the tuning profile ${profile}, which the project does not define.`,
          items: [],
          targets: [],
          subject: `Net class ${name}`
        },
        []
      )
    }
  }
}

/** A graphic as the misc rules read it: its layer, uuid and the points that place it. */
interface Graphic {
  layer?: string
  uuid?: string
  start?: { x: Nm; y: Nm }
  center?: { x: Nm; y: Nm }
  points?: Array<{ x: Nm; y: Nm }>
}

/** Where a graphic is, as KiCad's `GetPosition` places it: its start, or its center. */
const anchorOf = (g: Graphic): { x: Nm; y: Nm } | null =>
  g.start ?? g.center ?? g.points?.[0] ?? null
