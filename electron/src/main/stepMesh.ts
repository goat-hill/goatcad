import type { StepMeshData, StepMeshFaceColor } from '../preload/modelTypes'

/**
 * Converts the raw occt-import-js result (untyped JSON from the wasm kernel)
 * into the typed, transferable `StepMeshData[]` the renderer consumes. Pure
 * and defensive: malformed meshes are skipped rather than crashing the worker.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberArray = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  return value as number[]
}

/** Typed arrays survive postMessage/IPC; plain arrays also pass through. */
const attributeArray = (value: unknown): number[] | null => {
  if (!isRecord(value)) return null
  return numberArray(value.array)
}

const colorTriple = (value: unknown): [number, number, number] | null => {
  const arr = numberArray(value)
  if (!arr || arr.length < 3) return null
  const clamp = (n: number): number => Math.min(1, Math.max(0, typeof n === 'number' ? n : 0))
  return [clamp(arr[0]), clamp(arr[1]), clamp(arr[2])]
}

const faceColorRanges = (value: unknown): StepMeshFaceColor[] => {
  if (!Array.isArray(value)) return []
  const ranges: StepMeshFaceColor[] = []
  for (const face of value) {
    if (!isRecord(face)) continue
    const color = colorTriple(face.color)
    if (!color) continue
    const first = face.first
    const last = face.last
    if (typeof first !== 'number' || typeof last !== 'number' || last < first) continue
    ranges.push({ first, last, color })
  }
  return ranges
}

const toMesh = (value: unknown): StepMeshData | null => {
  if (!isRecord(value)) return null
  const attributes = isRecord(value.attributes) ? value.attributes : null
  if (!attributes) return null
  const positions = attributeArray(attributes.position)
  const indices = isRecord(value.index) ? numberArray(value.index.array) : null
  if (!positions || !indices) return null
  const normals = attributeArray(attributes.normal)
  return {
    name: typeof value.name === 'string' ? value.name : '',
    color: colorTriple(value.color),
    faceColors: faceColorRanges(value.brep_faces),
    positions: Float32Array.from(positions),
    normals: normals && normals.length === positions.length ? Float32Array.from(normals) : null,
    indices: Uint32Array.from(indices)
  }
}

/** Throws when the kernel reports failure or the result carries no geometry. */
export function toStepMeshes(result: unknown): StepMeshData[] {
  if (!isRecord(result) || result.success !== true) {
    throw new Error('The file could not be read as STEP geometry')
  }
  const rawMeshes = Array.isArray(result.meshes) ? result.meshes : []
  const meshes: StepMeshData[] = []
  for (const raw of rawMeshes) {
    const mesh = toMesh(raw)
    if (mesh) meshes.push(mesh)
  }
  if (meshes.length === 0) {
    throw new Error('The STEP file contains no renderable geometry')
  }
  return meshes
}
