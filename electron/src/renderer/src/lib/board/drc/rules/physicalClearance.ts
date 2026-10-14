// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import { allZones } from '../../../kicad/board'
import { isCopperLayer } from '../../../kicad/layers'
import { nmToMm, type Nm } from '../../../kicad/coordinates'
import { EDGE_CUTS, bezierPoints } from '../../../engine/board3d/boardOutline'
import { union } from '../../../geometry/clip'
import type { Box } from '../../../geometry/polygon'
import { boardDrawings } from '../../boardDrawings'
import { polyShape, sampleArc, shapeToShape, type CopperShape, type Pt } from '../../spatialIndex'
import type { LayerItem } from '../../layerIndex'
import type { RuleItem, RuleSeverity } from '../../rules/constraints'
import type { DrcContext } from '../context'
import { boxOf, layerPieces, treeOf, type Piece } from '../pieces'
import {
  DRC_EPSILON,
  at,
  between,
  collides,
  fmt,
  ownSeverity,
  refKey,
  worldOf,
  type Subject
} from '../shared'

/** A piece as physical clearance reads it, with the hole it drills, if any. */
interface Physical extends Piece {
  hole?: CopperShape
}

/** The layers a hole or the board edge pierces on each side (`LSET::FrontBoardTechMask`). */
const FRONT_TECH = ['F.SilkS', 'F.Mask', 'F.Paste', 'F.Adhes']
const BACK_TECH = ['B.SilkS', 'B.Mask', 'B.Paste', 'B.Adhes']

/** How far a joined edge may turn before the outline counts as folding back on itself, degrees. */
const SLIVER_ANGLE_TOLERANCE = 20

/**
 * The project's physical clearances (`physical_clearance`,
 * `physical_hole_clearance`; `mechanical_…` in older files), as KiCad's
 * `drc_test_provider_physical_clearance.cpp` holds them: every item against
 * every other on each layer they share — tracks, vias, pads, graphics, text,
 * a footprint by its courtyard — nets and owners notwithstanding, so a via in
 * its own pour or a pad drilled through its footprint's courtyard collides. A
 * hole pierces its side's technical layers and courtyard (every copper layer
 * when it goes through); the board edge pierces every physical layer and the
 * courtyards. Items meet a zone's fill on copper and its outline elsewhere. A
 * polygon drawn on copper, and a zone's fill, are also held to the clearance
 * within themselves: two of their edges that are not neighbours, or
 * neighbours folded back past 160°, may come no closer than it. Reported as
 * `clearance` and `hole_clearance`, a pair once.
 */
export function* physicalClearance(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, index, layerIndex, tick, emit, pair } = ctx
  const resolver = ruleSet.resolver
  if (!resolver.hasRules('physical_clearance') && !resolver.hasRules('physical_hole_clearance'))
    return
  const reach =
    Math.max(resolver.worst('physical_clearance'), resolver.worst('physical_hole_clearance')) +
    DRC_EPSILON
  const { pieceOf, padsOn } = layerPieces(ctx)

  // Every item, on every layer KiCad files it under.
  const byLayer = new Map<string, Physical[]>()
  const add = (layer: string, piece: Physical): void => {
    const list = byLayer.get(layer)
    if (list) list.push(piece)
    else byLayer.set(layer, [piece])
  }
  const copperLayers = ctx.copperLayers
  const holeShapeOf = (id: number): CopperShape | undefined => ctx.holesOf.get(id)?.[0]?.shape

  // Copper: the index's tracks, vias and pads, as their copper (or hole) on each layer.
  for (const item of index.items) {
    if (tick()) yield
    const copper = ctx.copperOf.get(item.id)
    if (!copper) continue
    const hole = holeShapeOf(item.id)
    for (const layer of ctx.layersOf(item)) {
      if (!isCopperLayer(layer)) continue
      const on = ctx.copperOn(item, layer)
      if (!on) continue
      add(layer, {
        id: refKey(item.ref),
        shape: on.shape,
        box: on.box,
        subject: copper.subject,
        rule: ruleSet.copperItem(item),
        graphic: false,
        ...(item.ref.type === 'pad' ? { fp: item.ref.index } : {}),
        ...(hole ? { hole } : {})
      })
    }
  }
  // Copper drawings.
  for (const d of ctx.drawings) {
    const copper = ctx.copperOf.get(d.id)
    if (!copper) continue
    for (const layer of d.layers)
      if (isCopperLayer(layer))
        add(layer, {
          id: `drawing:${d.id}`,
          shape: d.shape,
          box: d,
          subject: copper.subject,
          rule: ruleSet.copperItem(d),
          graphic: true,
          ...(d.fp !== undefined ? { fp: d.fp } : {})
        })
  }

  // Holes: on every copper layer they pass, the ones with no copper of their own;
  // and through their side's technical layers and courtyard.
  for (const hole of ctx.holes) {
    const holeId = hole.item
      ? refKey(hole.item.ref)
      : `pad:${hole.footprint}:${board.footprints[hole.footprint!]?.footprint.pads.indexOf(hole.pad!)}`
    const piece: Physical = {
      id: holeId,
      shape: hole.shape,
      box: hole.box,
      subject: hole.subject,
      rule: hole.item ? ruleSet.copperItem(hole.item) : ctx.holeOwner(hole),
      graphic: false,
      hole: hole.shape,
      ...(hole.footprint !== null ? { fp: hole.footprint } : {})
    }
    if (!hole.item) for (const layer of hole.layers) if (isCopperLayer(layer)) add(layer, piece)
    const pierced = [
      ...(hole.layers.includes('F.Cu') ? [...FRONT_TECH, 'F.CrtYd'] : []),
      ...(hole.layers.includes('B.Cu') ? [...BACK_TECH, 'B.CrtYd'] : [])
    ]
    for (const layer of pierced) {
      // A pad drawn on the layer is there by its copper (below), not its hole.
      if (hole.pad && hole.pad.layers.some((l) => l === layer || l === `*.${layer.slice(2)}`))
        continue
      add(layer, piece)
    }
  }

  // Beyond copper: the layer index's drawings, footprints by their courtyards,
  // and the pads drawn on a technical layer by their copper.
  const physicalPiece = (item: LayerItem): Physical | null => {
    if (item.kind === 'courtyard') {
      const bfp = board.footprints[item.fp!]
      return {
        id: `footprint:${item.fp}`,
        shape: item.shape,
        box: { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY },
        subject: ctx.footprintSubject(bfp),
        rule: ruleSet.footprintItem(item.fp!),
        graphic: false,
        fp: item.fp
      }
    }
    return pieceOf(item)
  }
  const technical = new Set(board.layers.map((l) => l.name).filter((name) => !isCopperLayer(name)))
  technical.delete(EDGE_CUTS)
  for (const layer of technical) {
    if (tick()) yield
    for (const item of layerIndex.layer(layer).items) {
      // Openings and zones are not items here: pads come by their copper, zones below.
      if (item.kind === 'pad' || item.kind === 'via' || item.kind === 'track') continue
      if (item.kind === 'zone' || item.kind === 'edge') continue
      const piece = physicalPiece(item)
      if (piece) add(layer, piece)
    }
    const side = layer.startsWith('F.') ? 'F.Cu' : layer.startsWith('B.') ? 'B.Cu' : null
    if (side && !layer.endsWith('CrtYd'))
      for (const pad of padsOn(layer, side)) {
        const hole = pad.pad?.drill ? holeOfPad(pad) : undefined
        add(layer, hole ? { ...pad, hole } : pad)
      }
  }

  // The board edge, by its strokes, on Edge.Cuts and every physical layer and courtyard.
  const edges = edgePieces(ctx, pieceOf)
  const physical = [
    ...copperLayers,
    ...FRONT_TECH,
    ...BACK_TECH,
    'F.CrtYd',
    'B.CrtYd',
    EDGE_CUTS
  ].filter((name) => name === EDGE_CUTS || copperLayers.includes(name) || technical.has(name))
  for (const layer of physical) for (const edge of edges) add(layer, edge)

  function holeOfPad(piece: Piece): CopperShape | undefined {
    const copper = ctx.itemByRef.get(piece.id)
    return copper ? holeShapeOf(copper.id) : undefined
  }

  // ---- Item against item, layer by layer ------------------------------------------
  const reported = new Set<string>()
  const pairKey = (a: Piece, b: Piece): string =>
    a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
  const report = (
    code: 'copper-clearance' | 'hole-clearance',
    a: { subject: Subject; shape: CopperShape; box: Box },
    b: { subject: Subject; shape: CopperShape; box: Box },
    limit: { min: number; name: string; severity?: RuleSeverity }
  ): void => {
    const [rule, clearance] = [limit.name, limit.min]
    const actual = Math.max(0, shapeToShape(a.shape, b.shape))
    emit(
      {
        code,
        severity: 'error',
        message: `${a.subject.name} and ${b.subject.name} are ${fmt(actual)} apart; ${rule} needs ${fmt(clearance)} (physical clearance${code === 'hole-clearance' ? ', from the hole' : ''}).`,
        measure: { actual, limit: clearance, bound: 'min', unit: 'mm', rule },
        position: at(between(a.shape, b.shape)),
        ...pair(a.subject, b.subject),
        ...ownSeverity(limit.severity)
      },
      [a.box, b.box]
    )
  }
  const allowed = (
    type: 'physical_clearance' | 'physical_hole_clearance',
    a: RuleItem,
    b: RuleItem | null,
    layer: string
  ): { min: number; name: string; severity?: RuleSeverity } | null => {
    const resolved = resolver.evaluate(type, a, b, layer)
    const min = resolved.value.min ?? 0
    return resolved.isNull || resolved.severity === 'ignore' || min <= 0
      ? null
      : { min, name: resolved.name, severity: resolved.severity }
  }

  for (const [layer, pieces] of byLayer) {
    const tree = treeOf(pieces)
    for (let i = 0; i < pieces.length; i++) {
      if (tick()) yield
      const a = pieces[i]
      const near: number[] = []
      tree.search(
        a.box.minX - reach,
        a.box.minY - reach,
        a.box.maxX + reach,
        a.box.maxY + reach,
        (j) => {
          if (j > i) near.push(j)
        }
      )
      for (const j of near) {
        const b = pieces[j]
        if (a.id === b.id) continue
        const key = pairKey(a, b)
        if (reported.has(key)) continue
        let found = false
        const rule = allowed('physical_clearance', a.rule, b.rule, layer)
        if (rule && collides(a.shape, b.shape, rule.min)) {
          report('copper-clearance', a, b, rule)
          found = true
        }
        if (a.hole || b.hole) {
          const holeRule = allowed('physical_hole_clearance', b.rule, a.rule, layer)
          if (holeRule && a.hole && collides(a.hole, b.shape, holeRule.min)) {
            report('hole-clearance', { ...a, shape: a.hole }, b, holeRule)
            found = true
          }
          if (holeRule && b.hole && collides(b.hole, a.shape, holeRule.min)) {
            report('hole-clearance', a, { ...b, shape: b.hole }, holeRule)
            found = true
          }
        }
        if (found) reported.add(key)
      }
    }
  }

  // ---- Items against zones: a fill on copper, an outline elsewhere ------------------
  const zoneShapes = (zoneIndex: number, layer: string): CopperShape[] =>
    isCopperLayer(layer)
      ? ctx.fills
          .filter((fill) => fill.zoneIndex === zoneIndex && fill.layer === layer)
          .map((fill) => polyShape([fill.ring]))
      : layerIndex
          .layer(layer)
          .items.filter(
            (item) => item.kind === 'zone' && item.fp === undefined && item.index === zoneIndex
          )
          .map((item) => item.shape)
  // A footprint's zone off copper is a drawing of the footprint's, measured as a piece.
  for (const [zoneIndex, zone] of allZones(board).entries()) {
    if (zone.isKeepout) continue
    const zoneRule = ruleSet.zoneItem(zone)
    const zoneSubject = ctx.zoneSubject(zone)
    for (const layer of zone.layers) {
      const pieces = byLayer.get(layer)
      if (!pieces || (zone.footprint !== undefined && !isCopperLayer(layer))) continue
      const shapes = zoneShapes(zoneIndex, layer)
      if (shapes.length === 0) continue
      const zoneShape: CopperShape =
        shapes.length === 1 ? shapes[0] : { kind: 'compound', parts: shapes }
      const zoneBox = boxOf(zoneShape)
      for (const piece of pieces) {
        if (tick()) yield
        if (
          piece.box.maxX + reach < zoneBox.minX ||
          piece.box.minX - reach > zoneBox.maxX ||
          piece.box.maxY + reach < zoneBox.minY ||
          piece.box.minY - reach > zoneBox.maxY
        )
          continue
        const key = `${piece.id}|zone:${zoneIndex}`
        if (reported.has(key)) continue
        const z = { subject: zoneSubject, shape: zoneShape, box: zoneBox }
        const rule = allowed('physical_clearance', piece.rule, zoneRule, layer)
        if (rule && collides(piece.shape, zoneShape, rule.min)) {
          report('copper-clearance', piece, z, rule)
          reported.add(key)
        }
        const holeRule = piece.hole
          ? allowed('physical_hole_clearance', piece.rule, zoneRule, layer)
          : null
        if (holeRule && collides(piece.hole!, zoneShape, holeRule.min)) {
          report('hole-clearance', { ...piece, shape: piece.hole! }, z, holeRule)
          reported.add(key)
        }
      }
    }
  }

  // ---- Within one polygon: a copper drawing's outline, a zone's fill -----------------
  const within = (
    subject: Subject,
    rule: RuleItem,
    layer: string,
    chains: ReadonlyArray<{ points: Pt[]; closed: boolean; width: number }>,
    box: Box
  ): void => {
    const limit = allowed('physical_clearance', rule, null, layer)
    if (!limit || limit.min - DRC_EPSILON <= 0) return
    for (const chain of chains) {
      const close = foldsWithin(chain.points, chain.closed, limit.min + chain.width - DRC_EPSILON)
      if (close) {
        emit(
          {
            code: 'copper-clearance',
            severity: 'error',
            message: `${subject.name} comes within ${fmt(close.actual)} of itself; ${limit.name} needs ${fmt(limit.min)} (physical clearance).`,
            measure: {
              actual: close.actual,
              limit: limit.min,
              bound: 'min',
              unit: 'mm',
              rule: limit.name
            },
            position: at(close.at),
            items: [subject.item],
            targets: subject.targets,
            subject: subject.item,
            ...(subject.ids ? { kicadIds: subject.ids } : {}),
            ...ownSeverity(limit.severity)
          },
          [box]
        )
        return
      }
    }
  }
  for (const d of ctx.drawings) {
    if (d.fp !== undefined) continue
    const chains = drawingChains(board, d.uuid)
    if (chains.length === 0) continue
    for (const layer of d.layers)
      if (isCopperLayer(layer))
        within(ctx.copperOf.get(d.id)!.subject, ruleSet.copperItem(d), layer, chains, d)
  }
  for (const [zoneIndex, zone] of allZones(board).entries()) {
    if (zone.isKeepout) continue
    for (const layer of zone.layers) {
      if (!isCopperLayer(layer)) continue
      if (tick()) yield
      const fills = ctx.fills.filter((f) => f.zoneIndex === zoneIndex && f.layer === layer)
      if (fills.length === 0) continue
      const limit = allowed('physical_clearance', ruleSet.zoneItem(zone), null, layer)
      if (!limit || limit.min - DRC_EPSILON <= 0) continue
      // The stored fill is fractured: its holes joined to its outline. Rejoin them.
      const islands = union(
        fills.map((f) => ({ outer: f.ring, holes: [] })),
        []
      )
      const subject = ctx.zoneSubject(zone)
      const box = boxOf({ kind: 'compound', parts: fills.map((f) => polyShape([f.ring])) })
      let flagged = false
      for (let i = 0; i < islands.length && !flagged; i++)
        for (let j = i + 1; j < islands.length && !flagged; j++)
          if (ringDistance(islands[i].outer, islands[j].outer) < limit.min - DRC_EPSILON)
            flagged = true
      if (flagged) {
        emit(
          {
            code: 'copper-clearance',
            severity: 'error',
            message: `Two islands of ${subject.name} come within ${limit.name}'s ${fmt(limit.min)} of each other (physical clearance).`,
            position: at({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }),
            items: [subject.item],
            targets: subject.targets,
            subject: subject.item,
            ...(subject.ids ? { kicadIds: subject.ids } : {}),
            ...ownSeverity(limit.severity)
          },
          [box]
        )
        continue
      }
      within(
        subject,
        ruleSet.zoneItem(zone),
        layer,
        islands.flatMap((island) =>
          island.holes.map((points) => ({ points, closed: true, width: 0 }))
        ),
        box
      )
    }
  }
}

/** The edge strokes of Edge.Cuts, one piece per drawn item. */
function edgePieces(ctx: DrcContext, pieceOf: (item: LayerItem) => Piece | null): Physical[] {
  const bySource = new Map<number, CopperShape[]>()
  const first = new Map<number, { drawing: LayerItem['kind']; fp?: number; uuid?: string }>()
  for (const piece of boardDrawings(ctx.board, ctx.ruleSet.textVariables, true, {
    layer: EDGE_CUTS
  }).get(EDGE_CUTS) ?? []) {
    const list = bySource.get(piece.source) ?? []
    list.push(...(piece.glyphs ?? [piece.shape]))
    bySource.set(piece.source, list)
    if (!first.has(piece.source))
      first.set(piece.source, {
        drawing: piece.drawing,
        ...(piece.fp !== undefined ? { fp: piece.fp } : {}),
        ...(piece.uuid ? { uuid: piece.uuid } : {})
      })
  }
  const out: Physical[] = []
  for (const [source, parts] of bySource) {
    const shape: CopperShape = parts.length === 1 ? parts[0] : { kind: 'compound', parts }
    const box = boxOf(shape)
    const meta = first.get(source)!
    const piece = pieceOf({
      id: source,
      layer: EDGE_CUTS,
      kind: meta.drawing,
      shape,
      ...(meta.fp !== undefined ? { fp: meta.fp } : {}),
      ...(meta.uuid ? { uuid: meta.uuid } : {}),
      ...box
    })
    if (piece) out.push({ ...piece, id: `edge:${source}` })
  }
  return out
}

/**
 * A board polygon's, arc's or curve's centerline on copper, by its uuid: the
 * chains the self-clearance reads, with the stroke width.
 */
function drawingChains(
  board: DrcContext['board'],
  uuid: string | undefined
): Array<{ points: Pt[]; closed: boolean; width: number }> {
  if (!uuid) return []
  const world = (p: { x: Nm; y: Nm }): Pt => worldOf(p)
  const poly = board.grPolys.find((g) => g.uuid === uuid)
  if (poly)
    return [
      { points: poly.points.map(world), closed: true, width: nmToMm(poly.strokeWidth ?? (0 as Nm)) }
    ]
  const arc = board.grArcs.find((g) => g.uuid === uuid)
  if (arc) {
    const [s, m, e] = [world(arc.start), world(arc.mid), world(arc.end)]
    return [
      {
        points: sampleArc(s.x, s.y, m.x, m.y, e.x, e.y),
        closed: false,
        width: nmToMm(arc.strokeWidth ?? (0 as Nm))
      }
    ]
  }
  const curve = board.grCurves.find((g) => g.uuid === uuid)
  if (curve && curve.points.length === 4)
    return [
      {
        points: bezierPoints(curve.points.map(world) as [Pt, Pt, Pt, Pt]),
        closed: false,
        width: nmToMm(curve.strokeWidth ?? (0 as Nm))
      }
    ]
  return []
}

const segDistance = (a: Pt, b: Pt, c: Pt, d: Pt): number =>
  shapeToShape(
    { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 },
    { kind: 'capsule', x0: c.x, y0: c.y, x1: d.x, y1: d.y, halfWidth: 0 }
  )

/** The least distance between two closed rings' edges. */
function ringDistance(a: readonly Pt[], b: readonly Pt[]): number {
  let least = Infinity
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      least = Math.min(least, segDistance(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]))
  return least
}

/**
 * Where a chain comes within `limit` of itself between two edges that are not
 * neighbours: the edges next to one, either way round a closed chain, are
 * passed over while they turn less than 160° from it, so a curve's gentle
 * facets never count and a fold back on itself does. Null where none does.
 */
function foldsWithin(
  points: readonly Pt[],
  closed: boolean,
  limit: number
): { at: Pt; actual: number } | null {
  const segs: Array<[Pt, Pt]> = []
  for (let i = 0; i + 1 < points.length; i++) segs.push([points[i], points[i + 1]])
  if (closed && points.length > 2) segs.push([points[points.length - 1], points[0]])
  const n = segs.length
  if (n < 3) return null
  const tolerance = ((180 - SLIVER_ANGLE_TOLERANCE) * Math.PI) / 180
  const shortest = DRC_EPSILON * 2
  // Each edge's direction; a vanishing edge borrows its neighbour's.
  const angles: number[] = []
  for (let i = 0; i < n; i++) {
    const [a, b] = segs[i]
    if (Math.hypot(b.x - a.x, b.y - a.y) > shortest) angles.push(Math.atan2(b.y - a.y, b.x - a.x))
    else angles.push(i > 0 ? angles[i - 1] : NaN)
  }
  const firstReal = angles.find((a) => !Number.isNaN(a)) ?? 0
  for (let i = 0; i < n; i++) if (Number.isNaN(angles[i])) angles[i] = firstReal
  const turn = (a: number, b: number): number => {
    const d = Math.abs(a - b) % (2 * Math.PI)
    return d > Math.PI ? 2 * Math.PI - d : d
  }
  for (let i = 0; i < n; i++) {
    const near = new Set<number>([i])
    for (let j = i + 1; j < n && turn(angles[i], angles[j]) < tolerance; j++) near.add(j)
    if (closed)
      for (let k = 1; k < n; k++) {
        const j = (i - k + n) % n
        if (near.has(j) || turn(angles[i], angles[j]) >= tolerance) break
        near.add(j)
      }
    for (let j = i + 1; j < n; j++) {
      if (near.has(j)) continue
      const [a, b] = segs[i]
      const [c, d] = segs[j]
      const actual = segDistance(a, b, c, d)
      if (actual < limit) return { at: { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, actual }
    }
  }
  return null
}
