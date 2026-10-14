/**
 * The box a tessellated model fills, from the vertices themselves.
 *
 * Main's half of the measurement `footprint_cache_model` answers with: the file has just
 * been parsed by the STEP worker, so the positions are already here and there
 * is nothing to load. The renderer measures the same box with Three's `Box3`
 * over the decoded scene (`engine/board3d/modelFacts.ts`), because there the
 * model is a group of meshes under a transform rather than a list of arrays;
 * both walk every vertex, so both answer the same numbers for the same file.
 *
 * Millimeters, the model's own frame, no footprint transform.
 */
import type { StepMeshData } from '../preload/modelTypes'

export interface MeshBounds {
  w: number
  h: number
  d: number
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export interface MeshMeasurement {
  bounds: MeshBounds | null
  triangles: number
  /** How many meshes the file tessellated to. A part is usually a handful; a
   *  file with dozens is commonly an assembly rather than one component. */
  meshes: number
}

/** Millimeters, to the micron: past that is float noise, not a measurement. */
const mm = (value: number): number => Math.round(value * 1000) / 1000

export function measureMeshes(meshes: readonly StepMeshData[]): MeshMeasurement {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let triangles = 0

  for (const mesh of meshes) {
    triangles += Math.floor(mesh.indices.length / 3)
    const positions = mesh.positions
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i]
      const y = positions[i + 1]
      const z = positions[i + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  }

  if (minX === Infinity) return { bounds: null, triangles, meshes: meshes.length }
  return {
    bounds: {
      w: mm(maxX - minX),
      h: mm(maxY - minY),
      d: mm(maxZ - minZ),
      min: { x: mm(minX), y: mm(minY), z: mm(minZ) },
      max: { x: mm(maxX), y: mm(maxY), z: mm(maxZ) }
    },
    triangles,
    meshes: meshes.length
  }
}
