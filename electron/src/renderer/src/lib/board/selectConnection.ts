/**
 * Select Connection (U), Select Net and the reach of Delete Full Track —
 * KiCad's `PCB_SELECTION_TOOL::expandConnection`, `selectAllConnectedTracks`,
 * `selectAllConnectedShapes` and `SelectAllItemsOnNet`, on the board's copper
 * index.
 *
 * KiCad's rules, kept:
 * - Tracks join where their ends coincide exactly, on a shared copper layer. A
 *   via joins every track end inside its copper; a pad stops or passes the
 *   walk only when a track ends exactly on it.
 * - Each press widens the reach one step: stop at the first junction (more
 *   than two tracks meeting, a via, or a pad the walk did not start from),
 *   then at pads, then never — taking the first step that adds anything.
 * - A footprint in the selection starts the walk from each of its pads.
 * - With no copper selected, a selected non-copper line or arc selects the
 *   outline it belongs to (every line and arc whose end meets its ends, on its
 *   layer); with nothing of either, the caller seeds the walk from the item
 *   under the cursor.
 * - The selection filter bounds the walk: a track it refuses is not taken, and
 *   a pad or via it refuses ends the walk there.
 *
 * Where ours differs: a pad is found at its copper's center, which is KiCad's
 * pad position except on a pad whose copper is offset from its hole; and an
 * outline's pieces join end to end, where KiCad also takes a line that merely
 * passes through the end.
 *
 * Positions are integer nm (the index's world mm, scaled), so "coincide" is
 * exact equality, as KiCad's is.
 */

import { shapeCenter, type BoardSpatialIndex } from './spatialIndex'

export interface ConnPt {
  x: number
  y: number
}

/** An item's id, as `BoardItemRef` spells it: `segment:3`, `via:0`, `pad:2/1`. */
export type ConnId = string

export interface ConnTrack {
  id: ConnId
  a: ConnPt
  b: ConnPt
  layer: string
}

export interface ConnVia {
  id: ConnId
  at: ConnPt
  radius: number
  layers: readonly string[]
}

export interface ConnPad {
  id: ConnId
  /** The owning footprint's id (`footprint:N`). */
  footprint: ConnId
  at: ConnPt
  layers: readonly string[]
}

export interface ConnectionWorld {
  tracks: ConnTrack[]
  vias: ConnVia[]
  pads: ConnPad[]
}

export type StopCondition = 'junction' | 'pad' | 'never'

/** Whether the selection filter lets the walk take (or pass) this item. */
export type ConnPasses = (id: ConnId) => boolean

const key = (p: ConnPt): string => `${p.x},${p.y}`
const shares = (a: readonly string[], b: readonly string[]): boolean => a.some((l) => b.includes(l))

/** The copper index as the walk reads it: nm positions, `type:index` ids. */
export function connectionWorldFromIndex(index: BoardSpatialIndex): ConnectionWorld {
  const n = (mm: number): number => Math.round(mm * 1e6)
  const world: ConnectionWorld = { tracks: [], vias: [], pads: [] }
  for (const item of index.items) {
    const { ref, shape } = item
    if (ref.type === 'pad') {
      const center = shapeCenter(shape)
      world.pads.push({
        id: `pad:${ref.index}/${ref.pad}`,
        footprint: `footprint:${ref.index}`,
        at: { x: n(center.x), y: n(center.y) },
        layers: item.layers
      })
    } else if (ref.type === 'via' && shape.kind === 'circle') {
      world.vias.push({
        id: `via:${ref.index}`,
        at: { x: n(shape.cx), y: n(shape.cy) },
        radius: n(shape.r),
        layers: item.layers
      })
    } else if (shape.kind === 'capsule' || shape.kind === 'arc') {
      world.tracks.push({
        id: `${ref.type}:${ref.index}`,
        a: { x: n(shape.x0), y: n(shape.y0) },
        b: { x: n(shape.x1), y: n(shape.y1) },
        layer: item.layers[0] ?? ''
      })
    }
  }
  return world
}

/**
 * The tracks and vias reachable from `starts` (tracks, vias and pads) under
 * one stop condition — `selectAllConnectedTracks`. The starting tracks and vias
 * are in the result; pads never are.
 */
export function connectedTracks(
  world: ConnectionWorld,
  starts: readonly ConnId[],
  stop: StopCondition,
  passes: ConnPasses = () => true
): Set<ConnId> {
  const trackMap = new Map<string, ConnTrack[]>()
  for (const t of world.tracks) {
    for (const p of [t.a, t.b]) {
      const list = trackMap.get(key(p))
      if (list) list.push(t)
      else trackMap.set(key(p), [t])
    }
  }
  const viaAt = new Map(world.vias.map((v) => [key(v.at), v]))
  const padAt = new Map(world.pads.map((p) => [key(p.at), p]))
  const byId = new Map<ConnId, ConnTrack | ConnVia | ConnPad>()
  for (const item of [...world.tracks, ...world.vias, ...world.pads]) byId.set(item.id, item)

  const startPads = new Set(starts.filter((id) => id.startsWith('pad:')))
  const selected = new Set<ConnId>()
  const visited = new Set<ConnId>()

  const viaHit = (pt: ConnPt, layers: readonly string[]): ConnVia | null => {
    const exact = viaAt.get(key(pt))
    if (exact && shares(exact.layers, layers)) return exact
    for (const via of world.vias) {
      if (!shares(via.layers, layers)) continue
      if ((pt.x - via.at.x) ** 2 + (pt.y - via.at.y) ** 2 <= via.radius ** 2) return via
    }
    return null
  }

  for (const id of starts) {
    const item = byId.get(id)
    if (!item) continue
    if (!('footprint' in item) && passes(id)) selected.add(id)
  }

  for (const id of starts) {
    const item = byId.get(id)
    if (!item || visited.has(id)) continue
    const queue: Array<{ pt: ConnPt; layers: readonly string[] }> =
      'a' in item
        ? [
            { pt: item.a, layers: [item.layer] },
            { pt: item.b, layers: [item.layer] }
          ]
        : [{ pt: item.at, layers: item.layers }]

    // KiCad re-sweeps its active points until nothing grows; a point's second
    // sweep only meets items already visited, so one visit each is the same walk.
    for (let q = 0; q < queue.length; q++) {
      const { pt, layers } = queue[q]
      const via = viaHit(pt, layers)
      const pad = padAt.get(key(pt))
      const onPad = !!pad && shares(pad.layers, layers)
      const nonStartPad = onPad && !startPads.has(pad.id)
      if (onPad && !passes(pad.id)) continue
      if (via && !passes(via.id)) continue
      const here = (trackMap.get(key(pt)) ?? []).filter((t) => layers.includes(t.layer))
      if (stop === 'junction') {
        const real = here.filter((t) => t.a.x !== t.b.x || t.a.y !== t.b.y).length
        if (real > 2 || via || nonStartPad) continue
      } else if (stop === 'pad' && nonStartPad) {
        continue
      }
      if (onPad && !visited.has(pad.id)) {
        visited.add(pad.id)
        queue.push({ pt: pad.at, layers: pad.layers })
      }
      for (const track of here) {
        if (!passes(track.id)) continue
        selected.add(track.id)
        if (visited.has(track.id)) continue
        visited.add(track.id)
        const far = track.a.x === pt.x && track.a.y === pt.y ? track.b : track.a
        queue.push({ pt: far, layers: [track.layer] })
      }
      if (via) {
        selected.add(via.id)
        if (visited.has(via.id)) continue
        visited.add(via.id)
        for (const [at, tracks] of trackMap) {
          const [x, y] = at.split(',').map(Number)
          if ((x - via.at.x) ** 2 + (y - via.at.y) ** 2 > via.radius ** 2) continue
          if (tracks.some((t) => via.layers.includes(t.layer))) {
            queue.push({ pt: { x, y }, layers: via.layers })
          }
        }
      }
    }
  }
  return selected
}

/** What a U press starts from, and how much of the selection is copper. */
export interface ConnectionSeed {
  /** Selected tracks, vias and zones, and footprints (each counts once). */
  copperCount: number
  /** Everything selected, copper or not. */
  selectionSize: number
  /** Track, via and pad ids to walk from (a footprint's pads stand for it). */
  starts: ConnId[]
}

/**
 * One press of Select Connection over a selection already holding copper:
 * the tracks and vias to add, at the narrowest reach that adds anything.
 */
export function expandConnection(
  world: ConnectionWorld,
  seed: ConnectionSeed,
  passes: ConnPasses = () => true
): Set<ConnId> {
  let found = new Set<ConnId>()
  for (const stop of ['junction', 'pad', 'never'] as const) {
    found = connectedTracks(world, seed.starts, stop, passes)
    const added = [...found].filter((id) => !seed.starts.includes(id)).length
    if (seed.selectionSize + added > seed.copperCount) break
  }
  return found
}

/**
 * KiCad's Unroute Segment: the tracks and vias one step out from `ids` — what
 * the selection walks to once `ids` are deleted, so each press peels the next
 * piece off the route. KiCad's walk (`selectAllConnectedTracks`, stopping at
 * each segment) over the copper directly connected to each deleted item: from
 * a track's ends, the tracks ending there on its layer and a via whose copper
 * covers the end; from a via, the tracks ending at its center. A track ending
 * on a pad's center goes on through the pad to the tracks ending there with it.
 * `ids` themselves are not in the result.
 *
 * Each walk marks what it visits, and a deleted item another walk reached
 * walks no more. KiCad takes the deleted items in memory order, so whether a
 * via deleted with its track steps onto its other layers is chance; vias walk
 * first here, so it always does: the route peels back on every layer.
 */
export function unrouteNeighbors(
  world: ConnectionWorld,
  ids: readonly ConnId[],
  passes: ConnPasses = () => true
): Set<ConnId> {
  const gone = new Set(ids)
  const selected = new Set<ConnId>()
  // KiCad's SKIP_STRUCT: what one start's walk visited, no later one revisits.
  const visited = new Set<ConnId>()
  const same = (p: ConnPt, q: ConnPt): boolean => p.x === q.x && p.y === q.y
  const covers = (via: ConnVia, pt: ConnPt): boolean =>
    (pt.x - via.at.x) ** 2 + (pt.y - via.at.y) ** 2 <= via.radius ** 2
  const tracksById = new Map(world.tracks.map((t) => [t.id, t]))
  const viasById = new Map(world.vias.map((v) => [v.id, v]))

  const order = [...ids].sort((a, b) => Number(!viasById.has(a)) - Number(!viasById.has(b)))
  for (const id of order) {
    if (visited.has(id)) continue
    const track = tracksById.get(id)
    const via = viasById.get(id)
    if (!track && !via) continue
    // The copper directly connected to it (KiCad's `GetConnectedItems`).
    const ends = track ? [track.a, track.b] : []
    const tracks = world.tracks.filter((t) =>
      track
        ? t.id === track.id ||
          (t.layer === track.layer && ends.some((e) => same(e, t.a) || same(e, t.b)))
        : via!.layers.includes(t.layer) && (covers(via!, t.a) || covers(via!, t.b))
    )
    const vias = track
      ? world.vias.filter((v) => v.layers.includes(track.layer) && ends.some((e) => covers(v, e)))
      : [via!]
    const pads = world.pads.filter((p) =>
      track
        ? p.layers.includes(track.layer) && ends.some((e) => same(e, p.at))
        : shares(p.layers, via!.layers) && same(p.at, via!.at)
    )
    const trackMap = new Map<string, ConnTrack[]>()
    for (const t of tracks)
      for (const pt of [t.a, t.b]) trackMap.set(key(pt), [...(trackMap.get(key(pt)) ?? []), t])
    const active: Array<{ pt: ConnPt; layers: readonly string[] }> = track
      ? [
          { pt: track.a, layers: [track.layer] },
          { pt: track.b, layers: [track.layer] }
        ]
      : [{ pt: via!.at, layers: via!.layers }]

    let expand = true
    for (let guard = 0; expand && guard < 100000; guard++) {
      expand = false
      for (let i = active.length - 1; i >= 0; i--) {
        const { pt, layers } = active[i]
        const hitVia =
          vias.find((v) => same(v.at, pt) && shares(v.layers, layers)) ??
          vias.find((v) => shares(v.layers, layers) && covers(v, pt))
        const pad = pads.find((p) => same(p.at, pt) && shares(p.layers, layers))
        if (hitVia && !passes(hitVia.id)) {
          active.splice(i, 1)
          continue
        }
        if (pad && !visited.has(pad.id)) {
          visited.add(pad.id)
          active.push({ pt: pad.at, layers: pad.layers })
          expand = true
        }
        for (const t of trackMap.get(key(pt)) ?? []) {
          if (!layers.includes(t.layer) || !passes(t.id)) continue
          selected.add(t.id)
          if (!visited.has(t.id)) {
            visited.add(t.id)
            active.push({ pt: same(t.a, pt) ? t.b : t.a, layers: [t.layer] })
          }
        }
        if (hitVia) {
          selected.add(hitVia.id)
          if (!visited.has(hitVia.id)) {
            visited.add(hitVia.id)
            // The tracks' ends inside its copper go on the list, as KiCad's do;
            // only a pad met on this step brings the walk back to them.
            for (const [k, list] of trackMap) {
              const [x, y] = k.split(',').map(Number)
              const at = { x, y }
              if (list.some((t) => hitVia.layers.includes(t.layer)) && covers(hitVia, at))
                active.push({ pt: at, layers: hitVia.layers })
            }
          }
        }
        active.splice(i, 1)
      }
    }
  }
  for (const id of gone) selected.delete(id)
  return selected
}

/** The ids of a footprint's pads, for a seed. */
export const footprintPads = (world: ConnectionWorld, footprint: ConnId): ConnId[] =>
  world.pads.filter((p) => p.footprint === footprint).map((p) => p.id)

/** A non-copper line or arc an outline is chained from. */
export interface ConnShape {
  id: ConnId
  a: ConnPt
  b: ConnPt
  layer: string
  /** Stroke width, nm: ends meet within half of it. */
  width: number
}

/**
 * Every shape joined end to end to `starts`, on the same layer —
 * `selectAllConnectedShapes`, which selects a board outline from one of its
 * edges.
 */
export function connectedShapes(
  shapes: readonly ConnShape[],
  starts: readonly ConnId[],
  passes: ConnPasses = () => true
): Set<ConnId> {
  const byId = new Map(shapes.map((s) => [s.id, s]))
  const selected = new Set<ConnId>()
  const seen = new Set<ConnId>()
  const stack = starts.filter((id) => byId.has(id))
  const meets = (p: ConnPt, s: ConnShape, reach: number): boolean =>
    [s.a, s.b].some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= reach ** 2)
  while (stack.length > 0) {
    const shape = byId.get(stack.pop()!)!
    if (seen.has(shape.id)) continue
    seen.add(shape.id)
    if (!passes(shape.id)) continue
    selected.add(shape.id)
    for (const end of [shape.a, shape.b]) {
      for (const other of shapes) {
        if (seen.has(other.id) || other.layer !== shape.layer) continue
        if (meets(end, other, Math.max(shape.width, other.width) / 2)) stack.push(other.id)
      }
    }
  }
  return selected
}

/**
 * Select Net: every track and via on the nets of the selected copper — KiCad's
 * `SelectAllItemsOnNet`, which leaves pads, zones and footprints out. Net 0
 * (no net) selects nothing.
 */
export function netItems(
  index: BoardSpatialIndex,
  nets: ReadonlySet<number>,
  passes: ConnPasses = () => true
): ConnId[] {
  const out: ConnId[] = []
  for (const item of index.items) {
    if (item.ref.type === 'pad' || item.net <= 0 || !nets.has(item.net)) continue
    const id = `${item.ref.type}:${item.ref.index}`
    if (passes(id)) out.push(id)
  }
  return out
}
