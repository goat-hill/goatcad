/**
 * 3D model mesh data shared across the process boundary.
 *
 * STEP tessellation happens in a main-process worker (occt-import-js); the
 * renderer receives these plain transferable structures over `step:load` and
 * turns them into Three.js geometry (`lib/engine/modelGeometry.ts`). The file
 * lives in preload because it is the one directory both tsconfig.node.json and
 * tsconfig.web.json can see. All coordinates are millimeters.
 */

/** A run of B-rep faces (triangle index range) carrying an explicit color. */
export interface StepMeshFaceColor {
  /** First triangle index of the face range (inclusive). */
  first: number
  /** Last triangle index of the face range (inclusive). */
  last: number
  /** RGB in 0..1. */
  color: [number, number, number]
}

export interface StepMeshData {
  name: string
  /** Mesh-wide RGB in 0..1, or null when the file assigns no color. */
  color: [number, number, number] | null
  /** Face ranges whose color overrides the mesh color. */
  faceColors: StepMeshFaceColor[]
  /** Vertex positions, xyz triplets. */
  positions: Float32Array
  /** Vertex normals, xyz triplets; null when the kernel emitted none. */
  normals: Float32Array | null
  /** Triangle vertex indices. */
  indices: Uint32Array
}

export interface StepLoadResult {
  success: boolean
  error?: string
  meshes: StepMeshData[]
}

/**
 * Result of resolving a footprint `(model ...)` path to a file on disk.
 * `notFound` covers unset env vars, missing files, and unresolvable relatives —
 * the renderer shows a "model not found" state rather than trying to load.
 * `reason` separates a model the library links but nobody drew (`missing`: its
 * folder is there) from one whose folder or variable is absent (`not-installed`).
 */
export type ModelResolveResult =
  { path: string } | { notFound: true; reason: 'missing' | 'not-installed' }
