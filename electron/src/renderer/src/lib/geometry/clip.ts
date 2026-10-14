/**
 * Lazy Clipper2 WASM polygon booleans. Coordinates are millimeters; WASM uses
 * KiCad's nanometer grid. The app starts loading it at launch without waiting;
 * whatever needs it awaits `loadClipper()` first (a board's load, a scene's
 * first build, an export, the board worker), and a boolean before then throws
 * rather than quietly answering with something else.
 * The module is our own flat-C-ABI build, not the npm package's embind one, so
 * it runs under the renderer CSP without eval — electron/wasm/clipper2/README.md.
 */

import type { Clipper2Module } from './wasm/clipper2'

export interface ClipPt {
  x: number
  y: number
}

/** One filled area: an outer ring and the holes cut out of it. */
export interface ClipRegion {
  outer: ClipPt[]
  holes: ClipPt[][]
}

/** mm → int64 grid. Matches KiCad's nanometer resolution. */
const SCALE = 1_000_000

const OPS = { difference: 0, intersection: 1, union: 2 } as const

let clipper: Clipper2Module | null = null
let loading: Promise<void> | null = null

export function clipperLoaded(): boolean {
  return clipper !== null
}

/**
 * Load the engine. Idempotent and safe to race; rejects (and every later call
 * with it) if the module cannot load: nothing that needs it can go on.
 */
export function loadClipper(): Promise<void> {
  loading ??= (async () => {
    const { default: factory } = await import('./wasm/clipper2.js')
    if (typeof process !== 'undefined' && process.versions?.node) {
      // Under node (vitest) the loader finds the .wasm next to its own JS
      // via import.meta; the bundler URL below would not be a real path.
      // (Not `typeof window`: the board worker has no window either.)
      clipper = await factory()
    } else {
      // In the renderer only the bundler knows where the .wasm asset went.
      const { default: wasmUrl } = await import('./wasm/clipper2.wasm?url')
      clipper = await factory({ locateFile: () => wasmUrl })
    }
  })()
  return loading
}

/**
 * Past this many paths a set is merged in batches first. Clipper's sweep slows
 * sharply on thousands of overlapping paths (a board's clearance rings around
 * a BGA): 5000 such rings take seconds in one pass and a tenth of that merged
 * sixteen at a time, neighbours with neighbours, then the results likewise.
 */
const BATCH = 16

/**
 * Regions merged into one set of non-overlapping regions, in batches of
 * neighbours: for a large set used more than once, merged once. Throws if the
 * engine is not loaded.
 */
export function merged(regions: readonly ClipRegion[]): ClipRegion[] {
  if (regions.length <= BATCH) return run(OPS.union, regions, [])
  const key = (region: ClipRegion): number => region.outer[0]?.x ?? 0
  let level = [...regions].sort((a, b) => key(a) - key(b))
  while (level.length > BATCH) {
    const next: ClipRegion[] = []
    for (let i = 0; i < level.length; i += BATCH)
      next.push(...run(OPS.union, level.slice(i, i + BATCH), []))
    // Merging no longer shrinks the set (disjoint regions): one last pass.
    if (next.length >= level.length) return run(OPS.union, next, [])
    level = next.sort((a, b) => key(a) - key(b))
  }
  return run(OPS.union, level, [])
}

/** A large set merged first; a small one as it is. */
const prepared = (regions: readonly ClipRegion[]): readonly ClipRegion[] =>
  regions.length > BATCH * 4 ? merged(regions) : regions

/** Subjects minus clips. Throws if the engine is not loaded. */
export function difference(
  subjects: readonly ClipRegion[],
  clips: readonly ClipRegion[]
): ClipRegion[] {
  return run(OPS.difference, prepared(subjects), prepared(clips))
}

/** The parts of subjects inside clips. Throws if the engine is not loaded. */
export function intersection(
  subjects: readonly ClipRegion[],
  clips: readonly ClipRegion[]
): ClipRegion[] {
  return run(OPS.intersection, prepared(subjects), prepared(clips))
}

/** Everything covered by either set. Throws if the engine is not loaded. */
export function union(subjects: readonly ClipRegion[], clips: readonly ClipRegion[]): ClipRegion[] {
  // Each side merged on its own: a large fill joined with many small pieces is
  // swept once, not once per batch.
  return run(OPS.union, prepared(subjects), prepared(clips))
}

/** How an offset turns a corner: KiCad's filler rounds, chamfers or keeps it sharp. */
export type OffsetJoin = 'round' | 'miter' | 'square' | 'bevel'
const JOINS: Record<OffsetJoin, number> = { round: 0, miter: 1, square: 2, bevel: 3 }

/**
 * Regions grown (delta > 0) or shrunk (delta < 0) by `delta` mm, holes with
 * them. `arcTolerance` (mm) bounds how far a round corner's chords fall inside
 * the true arc. Throws if the engine is not loaded.
 */
export function offset(
  regions: readonly ClipRegion[],
  delta: number,
  options: { join?: OffsetJoin; miterLimit?: number; arcTolerance?: number } = {}
): ClipRegion[] {
  const engine = clipper
  if (!engine) throw new Error('clipper2 engine not loaded — await loadClipper() first')
  if (regions.length === 0) return []
  const paths = pack(regions)
  const coordsPtr = engine._malloc(Math.max(8, paths.coords.byteLength))
  const lensPtr = engine._malloc(Math.max(4, paths.lens.byteLength))
  let out = 0
  try {
    engine.HEAPF64.set(paths.coords, coordsPtr / 8)
    engine.HEAP32.set(paths.lens, lensPtr / 4)
    out = engine._goat_offset(
      coordsPtr,
      lensPtr,
      paths.lens.length,
      delta,
      JOINS[options.join ?? 'round'],
      options.miterLimit ?? 2,
      options.arcTolerance ?? 0.005,
      SCALE
    )
    if (out === 0) throw new Error('clipper2 offset failed')
    return unpack(engine, out)
  } finally {
    if (out !== 0) engine._goat_free(out)
    engine._free(coordsPtr)
    engine._free(lensPtr)
  }
}

interface PackedPaths {
  coords: Float64Array
  lens: Int32Array
}

function run(
  op: number,
  subjects: readonly ClipRegion[],
  clips: readonly ClipRegion[]
): ClipRegion[] {
  const engine = clipper
  if (!engine) throw new Error('clipper2 engine not loaded — await loadClipper() first')

  const subj = pack(subjects)
  const clip = pack(clips)

  // Four input allocations, written after all four exist: _malloc can grow
  // the wasm memory, and growth replaces the heap views already taken.
  const subjCoordsPtr = engine._malloc(Math.max(8, subj.coords.byteLength))
  const subjLensPtr = engine._malloc(Math.max(4, subj.lens.byteLength))
  const clipCoordsPtr = engine._malloc(Math.max(8, clip.coords.byteLength))
  const clipLensPtr = engine._malloc(Math.max(4, clip.lens.byteLength))
  let out = 0
  try {
    engine.HEAPF64.set(subj.coords, subjCoordsPtr / 8)
    engine.HEAP32.set(subj.lens, subjLensPtr / 4)
    engine.HEAPF64.set(clip.coords, clipCoordsPtr / 8)
    engine.HEAP32.set(clip.lens, clipLensPtr / 4)

    out = engine._goat_clip(
      op,
      subjCoordsPtr,
      subjLensPtr,
      subj.lens.length,
      clipCoordsPtr,
      clipLensPtr,
      clip.lens.length,
      SCALE
    )
    if (out === 0) throw new Error('clipper2 boolean failed')
    return unpack(engine, out)
  } finally {
    if (out !== 0) engine._goat_free(out)
    engine._free(subjCoordsPtr)
    engine._free(subjLensPtr)
    engine._free(clipCoordsPtr)
    engine._free(clipLensPtr)
  }
}

/**
 * Regions as flat coords + ring lengths, with NonZero-consistent winding:
 * outers CCW, holes CW. Input winding is whatever the caller had.
 */
function pack(regions: readonly ClipRegion[]): PackedPaths {
  const rings: { points: readonly ClipPt[]; reverse: boolean }[] = []
  let total = 0
  const add = (points: readonly ClipPt[], asHole: boolean): void => {
    if (points.length < 3) return
    rings.push({ points, reverse: ringIsCCW(points) === asHole })
    total += points.length
  }
  for (const region of regions) {
    add(region.outer, false)
    for (const hole of region.holes) add(hole, true)
  }

  const coords = new Float64Array(total * 2)
  const lens = new Int32Array(rings.length)
  let at = 0
  rings.forEach((ring, index) => {
    lens[index] = ring.points.length
    const n = ring.points.length
    for (let i = 0; i < n; i++) {
      const point = ring.points[ring.reverse ? n - 1 - i : i]
      coords[at++] = point.x
      coords[at++] = point.y
    }
  })
  return { coords, lens }
}

/**
 * Decode the result buffer: `[ringCount][ringCount * (depth, count)][coords]`,
 * rings in PolyTree depth-first order. An even depth opens a region, an odd
 * depth is a hole in the region one level up — depth-first order guarantees
 * the parent was decoded already.
 */
function unpack(engine: Clipper2Module, ptr: number): ClipRegion[] {
  const heap = engine.HEAPF64
  let at = ptr / 8
  const ringCount = heap[at++]
  const meta: { depth: number; count: number }[] = []
  for (let i = 0; i < ringCount; i++) {
    meta.push({ depth: heap[at++], count: heap[at++] })
  }

  const out: ClipRegion[] = []
  const openAtDepth: ClipRegion[] = []
  for (const ring of meta) {
    const points: ClipPt[] = []
    for (let i = 0; i < ring.count; i++) {
      points.push({ x: heap[at++], y: heap[at++] })
    }
    if (ring.depth % 2 === 0) {
      const region: ClipRegion = { outer: points, holes: [] }
      out.push(region)
      openAtDepth[ring.depth] = region
    } else {
      openAtDepth[ring.depth - 1]?.holes.push(points)
    }
  }
  return out
}

function ringIsCCW(ring: readonly ClipPt[]): boolean {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum > 0
}
