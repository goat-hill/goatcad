/**
 * What a footprint's `(model …)` link actually is, as facts an agent can act
 * on: whether the file is there, how big the part is, and where its body sits
 * over the land pattern.
 *
 * Three of the four keys
 * need the mesh, so this lives in the renderer beside `modelAssetCache.ts` —
 * STEP arrives over `step:load` and `.wrl` parses here, and both end as the
 * same Three.js group. The placement math is deliberately not re-derived:
 * `placeComponentModel` is what the 3D board uses and what its tests pin, so
 * the box reported here is the box the part occupies on the board.
 *
 * Bounds are measured over vertices, not over a corner-transformed box: a
 * model rotated by anything but a right angle would otherwise report a box
 * larger than the part, and "does the body overhang the fab outline" is
 * exactly the question that would get wrong.
 *
 * These are facts, never verdicts: a model is optional everywhere — never a
 * check finding, a note on a write or a refusal — because a board lays out,
 * fabricates and orders without one. Where a model should come from is the
 * project's convention (`board-intent.md`), not code; GoatCAD names no vendor.
 */
import * as THREE from 'three'
import type { KicadBoardFootprint } from '../../kicad/board'
import type { KicadFootprint, SExprList } from '../../kicad/footprint'
import { nm } from '../../kicad/coordinates'
import { buildStepGroup, buildVrmlGroup } from '../modelGeometry'
import { placeComponentModel } from './componentModels'
import { disposeTree } from './modelAssetCache'

/** Whether the file a link names is on disk, and if not, why not. */
export type ModelStatus = 'resolved' | 'missing' | 'not-installed'

/** A box in the footprint's own frame: millimeters, y down, z off the board. */
export interface ModelBounds {
  x: number
  y: number
  w: number
  h: number
  zMin: number
  zMax: number
}

/** The model's own box, untransformed: what the file holds, in millimeters. */
export interface RawModelBounds {
  w: number
  h: number
  d: number
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/** A rectangle as `footprint_get` reports one. */
export interface MmRect {
  x: number
  y: number
  width: number
  height: number
}

/** The model's XY box against the footprint's own boxes. Numbers only: whether
 *  a 0.3 mm overhang matters is the caller's judgment, not ours. */
export interface ModelFit {
  /** Center offset from the box it is measured against, millimeters. */
  dx: number
  dy: number
  /** How far the model runs past that box on each side; negative is inside. */
  overFab: { left: number; right: number; top: number; bottom: number }
  /** Null when the footprint draws no courtyard. */
  insideCourtyard: boolean | null
  /** Which box `dx`, `dy` and `overFab` are measured against. */
  against: 'fab' | 'courtyard' | 'pads'
}

export interface ModelMeshStats {
  triangles: number
  meshes: number
}

/** The facts a model row carries beyond its record. */
export interface ModelFacts extends ModelMeshStats {
  status: ModelStatus
  resolved: string | null
  bounds: ModelBounds | null
  fit: ModelFit | null
}

/** Millimeters, to the micron: past that is float noise, not a measurement. */
const mm = (value: number): number => Math.round(value * 1000) / 1000

export const meshStats = (root: THREE.Object3D): ModelMeshStats => {
  let triangles = 0
  let meshes = 0
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    meshes++
    const geometry = mesh.geometry
    triangles += Math.floor(
      (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3
    )
  })
  return { triangles, meshes }
}

const boxToRaw = (box: THREE.Box3): RawModelBounds => ({
  w: mm(box.max.x - box.min.x),
  h: mm(box.max.y - box.min.y),
  d: mm(box.max.z - box.min.z),
  min: { x: mm(box.min.x), y: mm(box.min.y), z: mm(box.min.z) },
  max: { x: mm(box.max.x), y: mm(box.max.y), z: mm(box.max.z) }
})

/** The model's own box, before any footprint transform. */
export const rawBounds = (content: THREE.Object3D): RawModelBounds | null => {
  content.updateWorldMatrix(false, true)
  const box = new THREE.Box3().setFromObject(content, true)
  return box.isEmpty() ? null : boxToRaw(box)
}

const inert = (): SExprList => ({ type: 'list', children: [], start: 0, end: 0 })

/**
 * The part's box where the footprint puts it.
 *
 * The footprint is placed at the origin on a board of no thickness, so the
 * board surface is z = 0 and `zMax` reads as the part's height above the
 * copper. `placeComponentModel` supplies the rest — offset, scale and rotate
 * in KiCad's order, with the y inversion the board frame needs.
 */
export const placedBounds = (content: THREE.Object3D, fp: KicadFootprint): ModelBounds | null => {
  const placed: KicadBoardFootprint = {
    libId: fp.name,
    position: { x: nm(0), y: nm(0) },
    layer: 'F.Cu',
    footprint: fp,
    _raw: inert()
  }
  const group = placeComponentModel(content, placed, 0)
  if (!group) return null
  const box = new THREE.Box3().setFromObject(group, true)
  if (box.isEmpty()) return null
  // Engine space is y up; a footprint frame is y down.
  return {
    x: mm(box.min.x),
    y: mm(-box.max.y),
    w: mm(box.max.x - box.min.x),
    h: mm(box.max.y - box.min.y),
    zMin: mm(box.min.z),
    zMax: mm(box.max.z)
  }
}

const contains = (outer: MmRect, inner: ModelBounds): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.width &&
  inner.y + inner.h <= outer.y + outer.height

/**
 * The model box against the footprint's boxes. The fab outline is the part's
 * drawn body and so the honest comparison; a footprint without one is measured
 * against its courtyard, and one with neither against its copper.
 */
export const modelFit = (
  bounds: ModelBounds,
  boxes: { fab: MmRect | null; courtyard: MmRect | null; pads: MmRect | null }
): ModelFit | null => {
  const against = boxes.fab
    ? ('fab' as const)
    : boxes.courtyard
      ? ('courtyard' as const)
      : boxes.pads
        ? ('pads' as const)
        : null
  if (!against) return null
  const box = (boxes[against] ?? null) as MmRect
  return {
    dx: mm(bounds.x + bounds.w / 2 - (box.x + box.width / 2)),
    dy: mm(bounds.y + bounds.h / 2 - (box.y + box.height / 2)),
    overFab: {
      left: mm(box.x - bounds.x),
      right: mm(bounds.x + bounds.w - (box.x + box.width)),
      top: mm(box.y - bounds.y),
      bottom: mm(bounds.y + bounds.h - (box.y + box.height))
    },
    insideCourtyard: boxes.courtyard ? contains(boxes.courtyard, bounds) : null,
    against
  }
}

// ---- Loading ---------------------------------------------------------------

const isVrml = (path: string): boolean => path.toLowerCase().endsWith('.wrl')

/**
 * Decoded models, keyed by file and modification time, so a model replaced by
 * `footprint_cache_model --refresh` is re-read rather than remembered. Small: these are
 * read one at a time to answer a question, not to fill a scene.
 */
const MAX_CACHED = 16

interface CachedModel {
  key: string
  content: THREE.Object3D
}

const cached: CachedModel[] = []

const evict = (): void => {
  while (cached.length > MAX_CACHED) {
    const dropped = cached.shift()
    if (dropped) disposeTree(dropped.content)
  }
}

/**
 * Read and decode a model file. Uncached and owned by the caller — a group
 * handed to a scene that disposes it must be nobody else's, since a clone
 * shares its geometry with the original.
 */
export const decodeModel = async (resolved: string): Promise<THREE.Object3D | null> => {
  const api = typeof window !== 'undefined' ? window.api : null
  if (!api) return null
  if (isVrml(resolved)) {
    const file = await api.readFile(resolved)
    return file.success && file.content !== undefined ? buildVrmlGroup(file.content) : null
  }
  const step = await api.loadStepModel(resolved)
  return step.success ? buildStepGroup(step.meshes) : null
}

/** The decoded model at an absolute path, kept for the next reader. Never hand
 *  it, or a clone of it, to anything that disposes what it draws. */
export const loadModelTemplate = async (resolved: string): Promise<THREE.Object3D | null> => {
  const api = typeof window !== 'undefined' ? window.api : null
  if (!api) return null
  const stat = await api.statFile(resolved).catch(() => ({ success: false }) as const)
  const key = `${resolved}\0${'modifiedMs' in stat ? (stat.modifiedMs ?? 0) : 0}`
  const hit = cached.find((entry) => entry.key === key)
  if (hit) return hit.content
  const content = await decodeModel(resolved)
  if (!content) return null
  cached.push({ key, content })
  evict()
  return content
}

/** Drop every decoded model. The library door has no lifetime of its own; a
 *  test that swaps the bridge out needs the cache gone with it. */
export const clearModelCache = (): void => {
  for (const entry of cached) disposeTree(entry.content)
  cached.length = 0
}

export interface ModelFactsInput {
  /** The link as the footprint spells it. */
  path: string
  /** The footprint's own file, for a relative link. */
  footprintFile: string | null
  projectPath: string | null
  /** The footprint the link belongs to; supplies the model's transform and
   *  the boxes the fit is measured against. Omitted for a bare path. */
  footprint?: KicadFootprint
  boxes?: { fab: MmRect | null; courtyard: MmRect | null; pads: MmRect | null }
  /** false: resolve the link and stop, without decoding the file — which is
   *  the slow part, seconds for a large STEP. */
  decode?: boolean
}

/**
 * One model row's facts. Every field but `status` needs the file, so a link
 * that does not resolve answers with the status alone — which is the answer,
 * not a failure.
 */
export const modelFacts = async (input: ModelFactsInput): Promise<ModelFacts> => {
  const api = typeof window !== 'undefined' ? window.api : null
  const empty = { bounds: null, fit: null, triangles: 0, meshes: 0 }
  if (!api) return { status: 'not-installed', resolved: null, ...empty }
  const resolved = await api.resolveModelPath(input.path, input.footprintFile, input.projectPath)
  if ('notFound' in resolved) {
    return { status: resolved.reason, resolved: null, ...empty }
  }
  if (input.decode === false) return { status: 'resolved', resolved: resolved.path, ...empty }
  const content = await loadModelTemplate(resolved.path)
  if (!content) return { status: 'resolved', resolved: resolved.path, ...empty }
  const stats = meshStats(content)
  // The clone is what gets placed: the cached template must stay untransformed
  // for the next reader, and for the scene that clones it.
  const bounds = input.footprint ? placedBounds(content.clone(), input.footprint) : null
  return {
    status: 'resolved',
    resolved: resolved.path,
    bounds,
    fit: bounds && input.boxes ? modelFit(bounds, input.boxes) : null,
    ...stats
  }
}
