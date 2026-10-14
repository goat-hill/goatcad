// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Which teardrops a board should have after an edit, as KiCad's
 * `TEARDROP_MANAGER` decides (pcbnew/teardrop/teardrop.cpp: `RemoveTeardrops`,
 * `UpdateTeardrops`, `AddTeardropsOnTracks`, `setTeardropPriorities`), and the
 * board adapter the geometry reads. `planTeardrops` answers what to remove and
 * what to add; the session writes it (`applyTeardropPlan`, `kicad/board.ts`).
 *
 * One deliberate difference: KiCad's incremental track-to-track pass skips a
 * pair whose wider track is the edited one and rebuilds every untouched pair
 * (kicad-parity.md, Teardrops); here a pair is rebuilt when either track was
 * edited, and only then.
 */
import {
  buildTeardropZoneNode,
  hasLegacyTeardrops,
  isTeardropZone,
  viaSizeOn,
  type KicadBoard,
  type KicadBoardFootprint,
  type KicadBoardZone,
  type KicadTrackArc,
  type KicadTrackSegment,
  type KicadVia
} from '../../kicad/board'
import { padOnLayer, type KicadPad } from '../../kicad/footprint'
import {
  findChild,
  getFirstAtomValue,
  findChildren,
  getToken,
  makeAtom,
  makeList,
  markNodeDirty,
  setNodeValue,
  type SExprList,
  type SExprNode
} from '../../kicad/sexpr'
import type { Nm } from '../../kicad/coordinates'
import { offset } from '../../geometry/clip'
import { padPolygon } from '../padPolygon'
import { padCopperPieces, padOutline } from '../padCopper'
import { itemsConnect } from '../boardConnectivity'
import type { BoardSpatialIndex, CopperItem } from '../spatialIndex'
import {
  add,
  arcPolyline,
  kiRound,
  pointInside,
  rotate,
  ringArea,
  same,
  segmentHit,
  sub,
  toInt,
  type IPolygon,
  type IPt
} from './kicadMath'
import { chordThroughShape, teardropPolygon, type TdTarget, type TdTrack } from './geometry'
import type { TeardropOwners } from './owners'
import type { TeardropParams, TeardropSettings } from './params'
import { readTeardropParams } from './params'

/** `MAGIC_TEARDROP_ZONE_ID`: a layer's first teardrop priority. */
const PRIORITY_BASE = 30000
/** `m_tolerance` in `UpdateTeardrops`: 0.01 mm. */
const END_TOLERANCE = 10000

export type TrackItem = KicadTrackSegment | KicadTrackArc

export interface TeardropZone {
  type: 'padvia' | 'track_end'
  layer: string
  net: number
  outline: IPt[]
  priority: number
  /** The nodes it belongs to: its track, its pad or via, and a second track it spans. */
  owners: SExprNode[]
  /** The solder mask's companion zone, on a bare outer track. */
  mask?: { layer: string; outline: IPt[]; minThickness: number }
}

export interface TeardropPlan {
  remove: KicadBoardZone[]
  add: TeardropZone[]
}

export interface TeardropOptions {
  /** nm. */
  maxError: number
  settings: TeardropSettings
  /** The board's default solder mask expansion (nm), for a bare track's mask teardrop. */
  maskExpansion: number
}

/**
 * What an edit touched, as `BOARD_COMMIT::Push` gathers it: the pads, vias and
 * tracks it changed on the board after it, and every node it touched,
 * removed ones included (`touched`), which the owner map reads its stale
 * teardrops from. `'all'` rebuilds every teardrop.
 */
export type TeardropDirty =
  | 'all'
  | {
      pads: ReadonlySet<KicadPad>
      vias: ReadonlySet<KicadVia>
      tracks: ReadonlySet<TrackItem>
      touched: ReadonlySet<SExprNode>
    }

const isArc = (t: TrackItem): t is KicadTrackArc => 'mid' in t

const padHasLayer = (pad: KicadPad, layer: string): boolean =>
  pad.layers.some(
    (l) =>
      l === layer ||
      (l === '*.Cu' && layer.endsWith('.Cu')) ||
      (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu'))
  )

/** A pad's position on the board: the footprint's, plus its offset turned (`SetFPRelativePosition`). */
export function padBoardPosition(fp: KicadBoardFootprint, pad: KicadPad): IPt {
  return add(rotate({ x: pad.position.x, y: pad.position.y }, fp.position.angle ?? 0), fp.position)
}

/** `TEARDROP_MANAGER::IsRound` for a pad on a layer. */
const padIsRound = (pad: KicadPad, layer: string): boolean => {
  const on = padOnLayer(pad, layer)
  return on.shape === 'circle' || (on.shape === 'oval' && on.size.w === on.size.h)
}

/** The pad as a teardrop target. A shape `padPolygon` does not build answers no polygon. */
export function padTarget(fp: KicadBoardFootprint, pad: KicadPad, maxError: number): TdTarget {
  const position = padBoardPosition(fp, pad)
  const polys = new Map<string, IPolygon[]>()
  const polygon = (layer: string): IPolygon[] => {
    let p = polys.get(layer)
    if (!p) {
      const on = padOnLayer(pad, layer)
      const ring = padPolygon(on, position, maxError) ?? cornerPolygon(on, position)
      p = ring ? [{ outline: ring, holes: [] }] : copperOutline(on, position)
      polys.set(layer, p)
    }
    return p
  }
  const copperLayers = pad.layers.filter((l) => l.endsWith('.Cu'))
  let boundingRadius = 0
  for (const layer of copperLayers.length ? copperLayers : ['F.Cu'])
    for (const poly of polygon(layer === '*.Cu' || layer === 'F&B.Cu' ? 'F.Cu' : layer))
      for (const p of poly.outline)
        boundingRadius = Math.max(
          boundingRadius,
          kiRound(Math.hypot(p.x - position.x, p.y - position.y))
        )
  const drillW = pad.drill ? (pad.drill.oval?.width ?? pad.drill.diameter) : 0
  const drillH = pad.drill ? (pad.drill.oval?.height ?? pad.drill.diameter) : 0
  boundingRadius = Math.max(boundingRadius, kiRound(drillW / 2), kiRound(drillH / 2))
  const containsOn = (p: IPt, layer: string): boolean =>
    polygon(layer).some((poly) => pointInside(poly.outline, p))
  const hitLayers = (): string[] =>
    pad.layers.flatMap((l) =>
      l === '*.Cu' || l === 'F&B.Cu' ? ['F.Cu', 'B.Cu'] : l.endsWith('.Cu') ? [l] : []
    )
  const inHole = (p: IPt): boolean => {
    const drill = pad.drill
    if (!drill || !drillW) return false
    const angle = pad.position.angle ?? 0
    const center = add(position, drill.offset ? rotate(drill.offset, angle) : { x: 0, y: 0 })
    const w = drillW
    const h = drillH || w
    const r = toInt(Math.min(w, h) / 2)
    const halfLen = toInt(Math.abs(w - h) / 2)
    const axis = rotate(w >= h ? { x: halfLen, y: 0 } : { x: 0, y: halfLen }, angle)
    return segmentHit(p, sub(center, axis), add(center, axis), r)
  }
  return {
    kind: 'pad',
    raw: pad._raw,
    uuid: pad.uuid ?? '',
    position,
    round: (layer) => padIsRound(pad, layer),
    width: (layer) => {
      const on = padOnLayer(pad, layer)
      return Math.min(on.size.w, on.size.h)
    },
    polygon,
    hitTest: (p, layer) => {
      const dx = p.x - position.x
      const dy = p.y - position.y
      if (dx * dx + dy * dy > boundingRadius * boundingRadius) return false
      if (layer !== undefined) return padHasLayer(pad, layer) && containsOn(p, layer)
      return hitLayers().some((l) => containsOn(p, l)) || inHole(p)
    },
    boundingRadius,
    padShape: (layer) => {
      const on = padOnLayer(pad, layer)
      return {
        shape: on.shape,
        size: { x: on.size.w, y: on.size.h },
        rotation: pad.position.angle ?? 0,
        cornerRadius: kiRound(Math.min(on.size.w, on.size.h) * (on.roundrectRatio ?? 0))
      }
    }
  }
}

const CHAMFER_ORDER = ['top_left', 'top_right', 'bottom_right', 'bottom_left'] as const

/**
 * A trapezoid, or a chamfered rectangle with square corners, as KiCad lists its
 * corners (`TransformTrapezoidToPolygon`, `TransformRoundChamferedRectToPolygon`);
 * null for any other shape.
 */
function cornerPolygon(pad: KicadPad, position: IPt): IPt[] | null {
  const angle = pad.position.angle ?? 0
  const offset = pad.drill?.offset
  const center = add(position, offset ? rotate(offset, angle) : { x: 0, y: 0 })
  const sx = toInt(pad.size.w / 2)
  const sy = toInt(pad.size.h / 2)
  let corners: IPt[]
  if (pad.shape === 'trapezoid') {
    const dx = toInt((pad.rectDelta?.x ?? 0) / 2)
    const dy = toInt((pad.rectDelta?.y ?? 0) / 2)
    corners = [
      { x: -sx + dy, y: -sy - dx },
      { x: sx - dy, y: -sy + dx },
      { x: sx + dy, y: sy - dx },
      { x: -sx - dy, y: sy + dx }
    ]
  } else if ((pad.shape === 'rect' || pad.shape === 'roundrect') && pad.chamfer?.length) {
    if (pad.shape === 'roundrect' && (pad.roundrectRatio ?? 0) > 0) return null
    corners = [
      { x: -sx, y: -sy },
      { x: sx, y: -sy },
      { x: sx, y: sy },
      { x: -sx, y: sy }
    ]
    const shorter = Math.min(pad.size.w, pad.size.h)
    const chamfer = Math.max(0, kiRound((pad.chamferRatio ?? 0) * shorter))
    const sign = [0, 1, -1, 0, 0, -1, 1, 0]
    if (chamfer > 0)
      for (let cc = 0, pos = 0; cc < 4; cc++, pos++) {
        if (!pad.chamfer.includes(CHAMFER_ORDER[cc])) continue
        const c = corners[pos]
        corners.splice(pos + 1, 0, { ...c })
        corners[pos] = {
          x: c.x + sign[(2 * cc) & 7] * chamfer,
          y: c.y + sign[(2 * cc - 2) & 7] * chamfer
        }
        corners[pos + 1] = {
          x: c.x + sign[(2 * cc + 1) & 7] * chamfer,
          y: c.y + sign[(2 * cc - 1) & 7] * chamfer
        }
        pos++
      }
    corners = corners.filter((c, i) => !same(c, corners[(i + 1) % corners.length]))
  } else return null
  return corners.map((c) => add(rotate(c, angle), center))
}

/**
 * A custom pad's copper, or a chamfered one with round corners, which `padPolygon` does not
 * build exactly: its outline (`padCopper.ts`, scene millimetres, y up), back on
 * the file's grid. Its curves are not KiCad's chords, a difference of
 * micrometres.
 */
function copperOutline(pad: KicadPad, position: IPt): IPolygon[] {
  const rotation = ((pad.position.angle ?? 0) * Math.PI) / 180
  const regions = padOutline(
    padCopperPieces(pad, { x: position.x / 1e6, y: -position.y / 1e6 }, rotation)
  )
  const nm = (p: { x: number; y: number }): IPt => ({
    x: Math.round(p.x * 1e6),
    y: Math.round(-p.y * 1e6)
  })
  return (regions ?? []).map((r) => ({
    outline: r.outer.map(nm),
    holes: r.holes.map((h) => h.map(nm))
  }))
}

export function viaTarget(via: KicadVia): TdTarget {
  const position = { x: via.position.x, y: via.position.y }
  const widths = via.layers.map((l) => viaSizeOn(via, l))
  return {
    kind: 'via',
    raw: via._raw,
    uuid: via.uuid ?? '',
    position,
    round: () => true,
    width: (layer) => viaSizeOn(via, layer),
    polygon: () => [],
    hitTest: (p) =>
      widths.some((w) => {
        const max = toInt(w / 2)
        return (p.x - position.x) ** 2 + (p.y - position.y) ** 2 <= max * max
      }),
    boundingRadius: Math.max(...widths, via.size) / 2
  }
}

export function trackOf(t: TrackItem, maxError: number): TdTrack {
  const start = { x: t.start.x, y: t.start.y }
  const end = { x: t.end.x, y: t.end.y }
  if (isArc(t)) {
    const poly = arcPolyline(start, t.mid, end, t.width, maxError)
    let length = 0
    for (let i = 1; i < poly.length; i++)
      length += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y)
    return {
      arc: true,
      start,
      end,
      mid: { x: t.mid.x, y: t.mid.y },
      width: t.width,
      layer: t.layer,
      net: t.net,
      uuid: t.uuid ?? '',
      raw: t._raw,
      length
    }
  }
  return {
    arc: false,
    start,
    end,
    width: t.width,
    layer: t.layer,
    net: t.net,
    uuid: t.uuid ?? '',
    raw: t._raw,
    length: Math.hypot(end.x - start.x, end.y - start.y)
  }
}

const trackTarget = (t: TdTrack): TdTarget => ({
  kind: 'track',
  raw: t.raw,
  uuid: t.uuid,
  position: t.start,
  round: () => true,
  width: () => t.width,
  polygon: () => [],
  hitTest: (p) => segmentHit(p, t.start, t.end, toInt(t.width / 2)),
  boundingRadius: toInt(t.width / 2)
})

/** `KIID::Combine`, as hex: the bytes of two uuids xored. */
export function combineUuids(a: string, b: string): string {
  const hexA = a.replace(/-/g, '').padEnd(32, '0')
  const hexB = b.replace(/-/g, '').padEnd(32, '0')
  let out = ''
  for (let i = 0; i < 32; i += 2)
    out += (parseInt(hexA.slice(i, i + 2), 16) ^ parseInt(hexB.slice(i, i + 2), 16))
      .toString(16)
      .padStart(2, '0')
  return out
}

interface Built {
  zone: TeardropZone
  area: number
  uuid: string
}

/**
 * The teardrops to remove and add after an edit (`dirty`), or every teardrop
 * the board should have (`'all'`). A board with KiCad 7's teardrops is left
 * alone, as KiCad leaves it.
 */
export function planTeardrops(
  board: KicadBoard,
  index: BoardSpatialIndex,
  dirty: TeardropDirty,
  opts: TeardropOptions,
  /** What each teardrop belongs to, true for `board` (`owners.ts`); an edit's plan needs it. */
  owners?: TeardropOwners
): TeardropPlan {
  if (hasLegacyTeardrops(board)) return { remove: [], add: [] }
  const full = dirty === 'all'
  const sets =
    dirty === 'all'
      ? null
      : {
          pads: new Set(dirty.pads),
          vias: new Set(dirty.vias),
          tracks: new Set(dirty.tracks),
          touched: dirty.touched
        }
  const tracks: TrackItem[] = [...board.segments, ...board.trackArcs]
  const tdTracks = new Map<TrackItem, TdTrack>()
  const td = (t: TrackItem): TdTrack => {
    let v = tdTracks.get(t)
    if (!v) tdTracks.set(t, (v = trackOf(t, opts.maxError)))
    return v
  }

  // Connectivity, item by item (`GetConnectedPadsAndVias`).
  const itemOf = new Map<unknown, CopperItem>()
  for (const item of index.items) {
    const ref = item.ref
    if (ref.type === 'segment') itemOf.set(board.segments[ref.index], item)
    else if (ref.type === 'tarc') itemOf.set(board.trackArcs[ref.index], item)
    else if (ref.type === 'via') itemOf.set(board.vias[ref.index], item)
    else if (ref.type === 'pad')
      itemOf.set(board.footprints[ref.index]?.footprint.pads[ref.pad], item)
  }
  const padOf = (item: CopperItem): { fp: KicadBoardFootprint; pad: KicadPad } | null => {
    if (item.ref.type !== 'pad') return null
    const fp = board.footprints[item.ref.index]
    const pad = fp?.footprint.pads[item.ref.pad]
    return fp && pad ? { fp, pad } : null
  }
  const connected = (
    t: TrackItem
  ): { pads: { fp: KicadBoardFootprint; pad: KicadPad }[]; vias: KicadVia[] } => {
    const item = itemOf.get(t)
    const pads: { fp: KicadBoardFootprint; pad: KicadPad }[] = []
    const vias: KicadVia[] = []
    if (!item) return { pads, vias }
    for (const other of index.query(item.minX, item.minY, item.maxX, item.maxY)) {
      if (other === item || itemsConnect(board, item, other).length === 0) continue
      if (other.ref.type === 'via') vias.push(board.vias[other.ref.index])
      else {
        const p = padOf(other)
        if (p) pads.push(p)
      }
    }
    return { pads, vias }
  }

  // An edited track dirties the pads and vias it joins, and copper taken from
  // a place dirties what is left there (`BOARD_COMMIT::Push`).
  if (sets) {
    for (const t of sets.tracks) {
      const { pads, vias } = connected(t)
      for (const { pad } of pads) sets.pads.add(pad)
      for (const via of vias) sets.vias.add(via)
    }
  }

  // Remove: every teardrop touching what the edit touched (`RemoveTeardrops`).
  const remove: KicadBoardZone[] = []
  const teardrops = board.zones.filter(isTeardropZone)
  if (full) remove.push(...teardrops)
  else if (sets && owners && teardrops.length > 0) {
    // What the edit touched, as nodes: a footprint stands for its pads.
    const dirtyNodes = new Set<SExprNode>()
    for (const node of sets.touched) {
      dirtyNodes.add(node)
      if (node.type === 'list' && getToken(node) === 'footprint')
        for (const pad of findChildren(node, 'pad')) dirtyNodes.add(pad)
    }
    for (const pad of sets.pads) dirtyNodes.add(pad._raw)
    for (const via of sets.vias) dirtyNodes.add(via._raw)
    for (const t of sets.tracks) dirtyNodes.add(t._raw)
    // The pads and vias a dirty item's teardrops joined are dirty too, as KiCad
    // reads them off connectivity before rebuilding it: all their teardrops
    // are rebuilt.
    const first = owners.zonesOf(dirtyNodes)
    if (first.size > 0) {
      const padOfNode = new Map<SExprNode, KicadPad>()
      for (const fp of board.footprints)
        for (const pad of fp.footprint.pads) padOfNode.set(pad._raw, pad)
      const viaOfNode = new Map<SExprNode, KicadVia>(board.vias.map((v) => [v._raw, v]))
      for (const zone of first)
        for (const owner of owners.ownersOf(zone)) {
          const pad = padOfNode.get(owner)
          const via = viaOfNode.get(owner)
          if (pad) sets.pads.add(pad)
          if (via) sets.vias.add(via)
          if (pad || via) dirtyNodes.add(owner)
        }
    }
    const stale = owners.zonesOf(dirtyNodes)
    for (const zone of teardrops) if (stale.has(zone._raw)) remove.push(zone)
  }

  // Add (`UpdateTeardrops`).
  const built: Built[] = []
  /** The tracks the index holds within `reach` (nm) of a point, by the file's coordinates. */
  const tracksNear = (p: IPt, reach: number): TrackItem[] => {
    const x = p.x / 1e6
    const y = -p.y / 1e6
    const r = reach / 1e6
    const out: TrackItem[] = []
    for (const item of index.query(x - r, y - r, x + r, y + r)) {
      const ref = item.ref
      const t =
        ref.type === 'segment'
          ? board.segments[ref.index]
          : ref.type === 'tarc'
            ? board.trackArcs[ref.index]
            : undefined
      if (t) out.push(t)
    }
    return out
  }
  const touchingTrack = (
    track: TdTrack,
    point: IPt
  ): { track: TdTrack; atStart: boolean } | null => {
    let best: { track: TdTrack; atStart: boolean } | null = null
    for (const t of tracksNear(point, END_TOLERANCE)) {
      if (t.layer !== track.layer) continue
      const other = td(t)
      if (other.uuid === track.uuid && same(other.start, track.start) && same(other.end, track.end))
        continue
      const atStart = Math.hypot(other.start.x - point.x, other.start.y - point.y) <= END_TOLERANCE
      const atEnd = Math.hypot(other.end.x - point.x, other.end.y - point.y) <= END_TOLERANCE
      if (!atStart && !atEnd) continue
      if (best && best.track.length >= other.length) continue
      best = { track: other, atStart: atStart && !atEnd }
    }
    return best
  }
  const ctx = { maxError: opts.maxError, touchingTrack }
  const arcPoly = (t: TdTrack, reversed: boolean): IPt[] => {
    const poly = arcPolyline(t.start, t.mid!, t.end, t.width, opts.maxError)
    return reversed ? poly.reverse() : poly
  }
  const maskOf = (t: TrackItem, outline: IPt[]): TeardropZone['mask'] => {
    if (!t.mask || (t.layer !== 'F.Cu' && t.layer !== 'B.Cu')) return undefined
    const expansion = t.mask.margin ?? opts.maskExpansion
    return {
      layer: t.layer === 'F.Cu' ? 'F.Mask' : 'B.Mask',
      outline: expansion ? inflateMiter(outline, expansion) : outline,
      minThickness: Math.max(TEARDROP_MIN_THICKNESS, expansion)
    }
  }
  const tryCreate = (
    params: TeardropParams,
    type: TeardropZone['type'],
    item: TrackItem,
    track: TdTrack,
    target: TdTarget,
    pos: IPt
  ): void => {
    const made = teardropPolygon(params, track, target, pos, ctx, arcPoly)
    if (!made) return
    const outline = made.outline
    const owned = [item._raw, target.raw, ...(made.spans ? [made.spans.raw] : [])]
    built.push({
      zone: {
        type,
        layer: track.layer,
        net: track.net,
        outline,
        priority: 0,
        mask: maskOf(item, outline),
        owners: owned as SExprNode[]
      },
      area: Math.abs(ringArea(outline)),
      uuid: combineUuids(track.uuid, target.uuid)
    })
  }
  const asSegment = (t: TdTrack, start: IPt, end: IPt): TdTrack => ({
    ...t,
    arc: false,
    mid: undefined,
    start,
    end,
    length: Math.hypot(end.x - start.x, end.y - start.y)
  })

  // The tracks to visit: every one for a full rebuild; for an edit, the
  // edited ones and those meeting a dirty pad or via, found through the index
  // rather than by walking the board.
  let visit: Iterable<TrackItem> = tracks
  if (sets) {
    const near = new Set<TrackItem>(sets.tracks)
    for (const owner of [...sets.pads, ...sets.vias]) {
      const item = itemOf.get(owner)
      if (!item) continue
      for (const other of index.query(item.minX, item.minY, item.maxX, item.maxY)) {
        const ref = other.ref
        if (ref.type === 'segment') near.add(board.segments[ref.index])
        else if (ref.type === 'tarc') near.add(board.trackArcs[ref.index])
      }
    }
    visit = near
  }
  for (const t of visit) {
    const track = td(t)
    const { pads, vias } = connected(t)
    const forceUpdate = full || sets!.tracks.has(t)
    // A pad's zone connection override, else its footprint's (`GetZoneConnectionOverrides`).
    const padZoneConnect = new Map<TdTarget, number | null>()
    const tryTarget = (target: TdTarget, params: TeardropParams, annular: number): void => {
      if (!params.enabled) return
      if (
        track.width >= params.maxWidth ||
        track.width >= annular * params.bestWidthRatio ||
        track.width >= annular * params.filterRatio
      )
        return
      const layer = track.layer
      const startHits =
        target.kind === 'pad' ? target.hitTest(track.start, layer) : target.hitTest(track.start)
      const endHits =
        target.kind === 'pad' ? target.hitTest(track.end, layer) : target.hitTest(track.end)
      if (startHits && endHits) return
      if (
        startHits !== endHits &&
        chordThroughShape(
          track,
          target,
          layer,
          startHits ? track.start : track.end,
          opts.maxError
        ) < track.width
      )
        return
      const padZone = padZoneConnect.get(target)
      if (
        padZone !== undefined &&
        params.preferZoneConnections &&
        sameZone(board, target, padZone, track)
      )
        return
      tryCreate(params, 'padvia', t, track, target, target.position)
      if (
        !startHits &&
        !endHits &&
        segmentHit(target.position, track.start, track.end, toInt(track.width / 2))
      ) {
        tryCreate(
          params,
          'padvia',
          t,
          asSegment(track, track.end, target.position),
          target,
          target.position
        )
        tryCreate(
          params,
          'padvia',
          t,
          asSegment(track, track.start, target.position),
          target,
          target.position
        )
      }
    }
    for (const { fp, pad } of pads) {
      if (!forceUpdate && !sets!.pads.has(pad)) continue
      const target = padTarget(fp, pad, opts.maxError)
      const local = findChild(pad._raw as SExprList, 'zone_connect')
      padZoneConnect.set(
        target,
        local ? Number(getFirstAtomValue(local)) : (fp.footprint.zoneConnect ?? null)
      )
      tryTarget(target, readTeardropParams(pad._raw as SExprList), target.width(track.layer))
    }
    for (const via of vias) {
      if (!forceUpdate && !sets!.vias.has(via)) continue
      const target = viaTarget(via)
      tryTarget(target, readTeardropParams(via._raw), viaSizeOn(via, track.layer))
    }
  }

  // Track to track (`AddTeardropsOnTracks`).
  const trackParams = opts.settings.track
  if (trackParams.enabled && (full || sets!.tracks.size > 0)) {
    // An edit's pass looks only at the net and layer groups it touched.
    const touchedGroups = sets
      ? new Set([...sets.tracks].map((t) => `${t.net}\u0000${t.layer}`))
      : null
    const groups = new Map<string, TrackItem[]>()
    for (const t of tracks) {
      const key = `${t.net}\u0000${t.layer}`
      if (touchedGroups && !touchedGroups.has(key)) continue
      const g = groups.get(key)
      if (g) g.push(t)
      else groups.set(key, [t])
    }
    const filterRatio = Math.max(trackParams.filterRatio, 0.1)
    const params = { ...trackParams, filterRatio }
    const isDirty = (t: TrackItem): boolean => full || sets!.tracks.has(t)
    for (const sublist of groups.values()) {
      if (sublist.length <= 1) continue
      const sorted = [...sublist].sort((a, b) => a.width - b.width)
      if (sorted[0].width === sorted[sorted.length - 1].width) continue
      for (let i = 0; i < sorted.length - 1; i++) {
        const t = sorted[i]
        const track = td(t)
        const trackLen = toInt(track.length)
        const minWidth = kiRound(t.width * (1 / filterRatio))
        for (let j = i + 1; j < sorted.length; j++) {
          const c = sorted[j]
          if (minWidth >= c.width) continue
          if (trackLen <= toInt(c.width / 2)) continue
          const onEnds = (p: IPt): boolean =>
            Math.hypot(track.start.x - p.x, track.start.y - p.y) <= END_TOLERANCE ||
            Math.hypot(track.end.x - p.x, track.end.y - p.y) <= END_TOLERANCE
          let pos: IPt = { x: c.start.x, y: c.start.y }
          if (!onEnds(pos)) {
            pos = { x: c.end.x, y: c.end.y }
            if (!onEnds(pos)) continue
          }
          if (!isDirty(t) && !isDirty(c)) continue
          const { pads, vias } = connected(t)
          const onPadOrVia =
            pads.some(({ fp, pad }) => padTarget(fp, pad, opts.maxError).hitTest(pos)) ||
            vias.some((v) => viaTarget(v).hitTest(pos))
          if (onPadOrVia) continue
          tryCreate(params, 'track_end', t, track, trackTarget(td(c)), pos)
        }
      }
    }
  }

  // Priorities (`setTeardropPriorities`): per layer, larger first, then by id.
  const byLayer = new Map<string, Built[]>()
  for (const b of built) {
    const g = byLayer.get(b.zone.layer)
    if (g) g.push(b)
    else byLayer.set(b.zone.layer, [b])
  }
  for (const group of byLayer.values()) {
    group.sort((a, b) =>
      a.area !== b.area ? b.area - a.area : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
    )
    group.forEach((b, i) => (b.zone.priority = PRIORITY_BASE + i))
  }
  return { remove, add: built.map((b) => b.zone) }
}

/** `areItemsInSameZone`: a filled zone of the track's net holding the pad's anchor and a track end. */
function sameZone(
  board: KicadBoard,
  target: TdTarget,
  zoneConnect: number | null,
  track: TdTrack
): boolean {
  for (const zone of board.zones) {
    if (isTeardropZone(zone) || zone.isKeepout) continue
    if (!zone.layers.includes(track.layer) || (zone.net ?? 0) !== track.net) continue
    const fills = zone.filledPolys.filter((f) => (f.layer ?? zone.layers[0]) === track.layer)
    if (fills.length === 0) continue
    const contains = (p: IPt): boolean => fills.some((f) => pointInside(f.points, p))
    if (!contains(target.position)) continue
    if (!contains(track.start) && !contains(track.end)) continue
    return zone.padConnection !== 'none' && zoneConnect !== 0
  }
  return false
}

/** `SHAPE_POLY_SET::Inflate( ALLOW_ACUTE_CORNERS )`: a mitred offset, limit 10. */
function inflateMiter(outline: IPt[], delta: number): IPt[] {
  const grown = offset(
    [{ outer: outline.map((p) => ({ x: p.x / 1e6, y: p.y / 1e6 })), holes: [] }],
    delta / 1e6,
    {
      join: 'miter',
      miterLimit: 10
    }
  )
  return (grown[0]?.outer ?? []).map((p) => ({
    x: Math.round(p.x * 1e6),
    y: Math.round(p.y * 1e6)
  }))
}

/**
 * What a command touched, for `planTeardrops`: the pads, vias and tracks of the
 * nodes it added or changed, on the board it left, and every node it touched.
 */
export function teardropDirtyOf(
  after: KicadBoard,
  touched: ReadonlySet<SExprNode>
): Exclude<TeardropDirty, 'all'> {
  const pads = new Set<KicadPad>()
  const vias = new Set<KicadVia>()
  const tracks = new Set<TrackItem>()
  for (const fp of after.footprints)
    if (touched.has(fp._raw)) for (const pad of fp.footprint.pads) pads.add(pad)
  for (const via of after.vias) if (touched.has(via._raw)) vias.add(via)
  for (const t of [...after.segments, ...after.trackArcs]) if (touched.has(t._raw)) tracks.add(t)
  return { pads, vias, tracks, touched }
}

/** Whether a command's nodes hold copper a teardrop can hang on. */
export function touchesTeardropCopper(raws: ReadonlySet<SExprNode>): boolean {
  for (const raw of raws) {
    const token = raw.type === 'list' ? getToken(raw) : null
    if (token === 'footprint' || token === 'segment' || token === 'arc' || token === 'via')
      return true
  }
  return false
}

/**
 * Write a plan into the board's AST: its stale teardrops out, its new ones in
 * at the end, as KiCad appends them. Answers the nodes it added and removed.
 */
export function applyTeardropPlan(
  board: KicadBoard,
  plan: TeardropPlan,
  /** Kept true: the removed teardrops dropped, the new ones entered with their owners. */
  owners?: TeardropOwners
): Set<SExprNode> {
  const root = board._raw as SExprList
  const touched = new Set<SExprNode>()
  const gone = new Set<SExprNode>(plan.remove.map((z) => z._raw))
  if (gone.size > 0) {
    root.children = root.children.filter((node) => !gone.has(node))
    for (const node of gone) {
      touched.add(node)
      owners?.drop(node)
    }
  }
  const netName = (net: number): string => board.nets.find((n) => n.number === net)?.name ?? ''
  for (const zone of plan.add) {
    const copper = buildTeardropZoneNode(
      root.start,
      {
        type: zone.type,
        layer: zone.layer,
        net: zone.net,
        netName: netName(zone.net),
        priority: zone.priority,
        minThickness: TEARDROP_MIN_THICKNESS,
        points: zone.outline as Array<{ x: Nm; y: Nm }>
      },
      board.netRefStyle
    )
    root.children.push(copper)
    touched.add(copper)
    owners?.add(copper, zone.owners)
    if (zone.mask) {
      const mask = buildTeardropZoneNode(
        root.start,
        {
          type: zone.type,
          layer: zone.mask.layer,
          net: 0,
          netName: '',
          minThickness: zone.mask.minThickness as Nm,
          points: zone.mask.outline as Array<{ x: Nm; y: Nm }>
        },
        board.netRefStyle
      )
      root.children.push(mask)
      touched.add(mask)
      owners?.add(mask, zone.owners)
    }
  }
  return touched
}

/** `createTeardrop`'s minimum thickness, 0.0254 mm. */
const TEARDROP_MIN_THICKNESS = 25400 as Nm

/** Whether a full rebuild would leave the board's teardrops as they are. */
export function teardropsUnchanged(board: KicadBoard, plan: TeardropPlan): boolean {
  const key = (layer: string, points: readonly IPt[], priority: number | undefined): string =>
    `${layer}|${priority ?? 0}|${points.map((p) => `${p.x},${p.y}`).join(' ')}`
  const had = board.zones
    .filter(isTeardropZone)
    .map((z) => key(z.layers[0] ?? '', z.points, z.priority))
    .sort()
  const will = plan.add
    .flatMap((z) => [
      key(z.layer, z.outline, z.priority),
      ...(z.mask ? [key(z.mask.layer, z.mask.outline, undefined)] : [])
    ])
    .sort()
  return had.length === will.length && had.every((k, i) => k === will[i])
}

/**
 * Take a board's teardrops over from KiCad 7's (`SetLegacyTeardrops( false )`,
 * as Edit Teardrops does): `(legacy_teardrops no)` in its `(general …)`.
 */
export function clearLegacyTeardrops(board: KicadBoard): void {
  const root = board._raw as SExprList
  const general = findChild(root, 'general')
  if (!general) return
  const flag = findChild(general, 'legacy_teardrops')
  if (flag && getFirstAtomValue(flag) === 'no') return
  markNodeDirty(general)
  if (flag) setNodeValue(flag, 'no')
  else
    general.children.push(
      makeList(
        [makeAtom('legacy_teardrops', false, general.start), makeAtom('no', false, general.start)],
        general.start
      )
    )
}
