/**
 * The clearance outlines the board draws round copper: each item's copper grown
 * by its own clearance — what the rules ask of it with nothing named on the
 * other side, as KiCad's `GetOwnClearance` — on the active copper layer, and
 * for a selected item on every visible copper layer, as KiCad shows them.
 * Which items is the display settings' call (`lib/pcbView.ts`); the scene draws
 * the result as hairlines (`BoardScene.setClearanceOutlines`).
 *
 * A net's outlines on a layer are merged into one shape, drawn as its
 * boundary: copper of one net that touches (a track's segments, the via they
 * meet) would otherwise draw every piece's outline across the others. Nets
 * stay apart, since where two nets' outlines overlap is worth seeing.
 */
import { merged, type ClipRegion } from '../geometry/clip'
import { shapeOutlines } from './shapeOutline'
import { shapeOn, type CopperItem, type CopperShape, type Pt } from './spatialIndex'
import type { BoardRules } from './rules/boardRules'

/** One outline, as the scene's primitives draw it. Coordinates are scene mm (y up). */
export type ClearanceOutline =
  | {
      kind: 'rrect'
      cx: number
      cy: number
      halfW: number
      halfH: number
      cornerR: number
      rotation: number
    }
  | { kind: 'capsule'; x0: number; y0: number; x1: number; y1: number; halfWidth: number }
  | {
      kind: 'arc'
      x0: number
      y0: number
      mx: number
      my: number
      x1: number
      y1: number
      halfWidth: number
    }
  /** Closed rings, drawn edge by edge: a polygon or compound pad grown and merged. */
  | { kind: 'rings'; rings: Pt[][] }

/** A copper shape grown by `clearance`, as outlines; [] when there is nothing to grow. */
export function inflatedOutline(
  shape: CopperShape,
  clearance: number,
  maxError?: number
): ClearanceOutline[] {
  switch (shape.kind) {
    case 'circle': {
      const r = shape.r + clearance
      return [
        { kind: 'rrect', cx: shape.cx, cy: shape.cy, halfW: r, halfH: r, cornerR: r, rotation: 0 }
      ]
    }
    case 'rrect':
      return [
        {
          kind: 'rrect',
          cx: shape.cx,
          cy: shape.cy,
          halfW: shape.halfW + clearance,
          halfH: shape.halfH + clearance,
          cornerR: shape.cornerR + clearance,
          rotation: shape.rotation
        }
      ]
    case 'capsule':
      return [{ ...shape, halfWidth: shape.halfWidth + clearance }]
    case 'arc':
      return [{ ...shape, halfWidth: shape.halfWidth + clearance }]
    case 'poly':
    case 'compound': {
      // Unmerged, each piece's outline would cross the others'.
      return [{ kind: 'rings', rings: mergedRings(shapeOutlines(shape, clearance, maxError)) }]
    }
  }
}

export interface ClearanceQuery {
  /** The active copper layer: every shown item's outline is drawn there. */
  layer: string | null
  /** Copper layers on view: a selected item's outline is drawn on each it is on. */
  visibleLayers: ReadonlySet<string>
  /** Outline pads. */
  pads: boolean
  /** Outline tracks and vias. */
  tracks: boolean
  /** Whether an item is selected, by its own selection or its footprint's. */
  selected: (item: CopperItem) => boolean
  /** The item's own clearance on a layer, mm. */
  clearanceOf: (item: CopperItem, layer: string) => number
  /**
   * Whether an item is being dragged: its outlines merge only with other
   * moving copper and come back `moving`, so the scene can carry them along.
   */
  moving?: (item: CopperItem) => boolean
  /** Items drawn no outline: copper a route violates, whose clearance its halo shows. */
  hidden?: (item: CopperItem) => boolean
  maxError?: number
}

/** One outline to draw, with the copper layer and net it belongs to. */
export interface LayerClearanceOutline {
  layer: string
  net: number
  outline: ClearanceOutline
  /** Drawn round copper being dragged (`ClearanceQuery.moving`). */
  moving?: boolean
}

/** The outlines to draw, each with the copper layer and net it belongs to. */
export function clearanceOutlines(
  items: readonly CopperItem[],
  q: ClearanceQuery
): LayerClearanceOutline[] {
  const out: LayerClearanceOutline[] = []
  const groups = new Map<string, Array<{ item: CopperItem; clearance: number }>>()
  for (const item of items) {
    const type = item.ref.type
    if (type === 'drawing') continue
    if (type === 'pad' ? !q.pads : !q.tracks) continue
    if (q.hidden?.(item)) continue
    const layers = q.selected(item)
      ? item.layers.filter((l) => q.visibleLayers.has(l))
      : q.layer !== null && item.layers.includes(q.layer)
        ? [q.layer]
        : []
    for (const layer of layers) {
      const clearance = q.clearanceOf(item, layer)
      if (!(clearance > 0)) continue
      // Copper on no net shares an outline with nothing, and moving copper
      // with nothing standing still.
      const owner = item.net > 0 ? `${item.net}` : `-${item.id}`
      const key = `${layer}|${owner}${q.moving?.(item) ? '|moving' : ''}`
      const group = groups.get(key)
      if (group) group.push({ item, clearance })
      else groups.set(key, [{ item, clearance }])
    }
  }
  for (const [key, group] of groups) {
    const layer = key.slice(0, key.indexOf('|'))
    const net = group[0].item.net
    const moving = key.endsWith('|moving') ? { moving: true } : {}
    for (const cluster of touching(group)) {
      if (cluster.length === 1) {
        const { item, clearance } = cluster[0]
        for (const outline of inflatedOutline(shapeOn(item, layer), clearance, q.maxError))
          out.push({ layer, net, outline, ...moving })
      } else {
        const rings = mergedGroup(layer, cluster, q.maxError)
        out.push({ layer, net, outline: { kind: 'rings', rings }, ...moving })
      }
    }
  }
  return out
}

type Grown = { item: CopperItem; clearance: number }

/**
 * A net's copper on a layer in clusters whose outlines may touch (their boxes,
 * grown by the clearance, overlap): merged apart, so an edit re-merges only
 * its own cluster and a lone pad keeps its plain outline.
 */
function touching(group: readonly Grown[]): Grown[][] {
  const parent = group.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const box = group.map(({ item, clearance }) => ({
    minX: item.minX - clearance,
    maxX: item.maxX + clearance,
    minY: item.minY - clearance,
    maxY: item.maxY + clearance
  }))
  const order = group.map((_, i) => i).sort((a, b) => box[a].minX - box[b].minX)
  const open: number[] = []
  for (const i of order) {
    for (let k = open.length - 1; k >= 0; k--) {
      const j = open[k]
      if (box[j].maxX < box[i].minX) {
        open.splice(k, 1)
        continue
      }
      if (box[j].minY <= box[i].maxY && box[i].minY <= box[j].maxY) parent[find(i)] = find(j)
    }
    open.push(i)
  }
  const clusters = new Map<number, Grown[]>()
  group.forEach((g, i) => {
    const root = find(i)
    const list = clusters.get(root)
    if (list) list.push(g)
    else clusters.set(root, [g])
  })
  return [...clusters.values()]
}

/**
 * Each shape's serial, for a merge cache: an index rebuilt after an edit
 * copies the items it kept but not their shapes, so a cluster no edit
 * touched is found again.
 */
const serials = new WeakMap<CopperShape, number>()
let nextSerial = 0
const serialOf = (shape: CopperShape): number => {
  let serial = serials.get(shape)
  if (serial === undefined) serials.set(shape, (serial = nextSerial++))
  return serial
}
/**
 * Merged outlines by their pieces, so a selection or layer change redraws
 * without re-merging. Bounded by the points it holds, not by its entries: one
 * entry can be a whole net's pour-side outline on a dense board, tens of
 * thousands of points. It keeps two generations — what was asked for lately,
 * and what was before that — and a lookup brings an old entry back into the
 * young one. When the young one fills, the old one goes: a merge of shapes an
 * edit has since replaced (an undo rebuilds the index with new shapes, so the
 * same copper merges again under new keys) is never asked for again and ages
 * out in a generation rather than lingering.
 */
export class MergeCache {
  private young = new Map<string, Pt[][]>()
  private old = new Map<string, Pt[][]>()
  private youngPoints = 0

  constructor(private readonly pointsPerGeneration: number) {}

  public get(key: string): Pt[][] | undefined {
    const young = this.young.get(key)
    if (young) return young
    const old = this.old.get(key)
    if (old) {
      this.old.delete(key)
      this.set(key, old)
    }
    return old
  }

  public set(key: string, rings: Pt[][]): void {
    const points = rings.reduce((sum, ring) => sum + ring.length, 0)
    if (this.youngPoints + points > this.pointsPerGeneration && this.young.size > 0) {
      this.old = this.young
      this.young = new Map()
      this.youngPoints = 0
    }
    this.young.set(key, rings)
    this.youngPoints += points
  }

  /** Points held, both generations: what the bound is on. */
  public get points(): number {
    let points = this.youngPoints
    for (const rings of this.old.values()) for (const ring of rings) points += ring.length
    return points
  }
}

/** About 25 MB a generation at a point's ~50 bytes. */
const mergeCache = new MergeCache(500_000)

function mergedGroup(
  layer: string,
  group: ReadonlyArray<{ item: CopperItem; clearance: number }>,
  maxError: number | undefined
): Pt[][] {
  const key = `${maxError ?? ''}|${group.map((g) => `${serialOf(shapeOn(g.item, layer))}:${g.clearance}`).join(',')}`
  const cached = mergeCache.get(key)
  if (cached) return cached
  const rings = mergedRings(
    group.flatMap(({ item, clearance }) => shapeOutlines(shapeOn(item, layer), clearance, maxError))
  )
  mergeCache.set(key, rings)
  return rings
}

/** Closed outlines merged into one shape's boundary: its outer rings and its holes. */
export function mergedRings(rings: readonly Pt[][]): Pt[][] {
  if (rings.length <= 1) return [...rings]
  const regions: ClipRegion[] = rings.map((outer) => ({ outer, holes: [] }))
  return merged(regions).flatMap((region) => [region.outer, ...region.holes])
}

/**
 * The clearance a route or drag in progress keeps, as one merged outline
 * round its tracks and vias (scene mm, y up).
 */
export function previewClearanceRings(
  tracks: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; halfWidth: number }>,
  vias: ReadonlyArray<{ x: number; y: number; r: number }>,
  maxError?: number
): Pt[][] {
  return mergedRings([
    ...tracks.flatMap((t) => shapeOutlines({ kind: 'capsule', ...t }, 0, maxError)),
    ...vias.flatMap((v) => shapeOutlines({ kind: 'circle', cx: v.x, cy: v.y, r: v.r }, 0, maxError))
  ])
}

/**
 * An item's own clearance on a layer, as the rules resolve it with nothing on
 * the other side. The memo remembers answers by the item's copper, net and
 * layer for as long as the rules' inputs stay the same (`BoardRules.inputs`):
 * an edit rebuilds the rules, and the copper it did not touch keeps its
 * answer. Each viewport owns one, since the inputs can hold the board itself.
 */
export function ownClearanceMemo(): (
  rules: BoardRules
) => (item: CopperItem, layer: string) => number {
  let memo: {
    inputs: readonly unknown[]
    byShape: WeakMap<CopperShape, Map<string, number>>
  } | null = null
  return (rules) => {
    const same =
      memo !== null &&
      memo.inputs.length === rules.inputs.length &&
      memo.inputs.every((input, i) => input === rules.inputs[i])
    if (!same) memo = { inputs: rules.inputs, byShape: new WeakMap() }
    const byShape = memo!.byShape
    return (item, layer) => {
      let answers = byShape.get(item.shape)
      if (!answers) byShape.set(item.shape, (answers = new Map()))
      const key = `${item.net}|${layer}`
      let value = answers.get(key)
      if (value === undefined) {
        value =
          rules.resolver.evaluate('clearance', rules.copperItem(item), null, layer).value.min ?? 0
        answers.set(key, value)
      }
      return value
    }
  }
}
