import * as THREE from 'three'
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js'
import type { StepMeshData, StepMeshFaceColor } from '../../../../preload/modelTypes'

/**
 * Builds Three.js scene content for the 3D model viewer: STEP meshes arrive
 * pre-tessellated from the main-process worker (`step:load`), VRML is parsed
 * here by three's self-contained VRMLLoader. Output units are millimeters.
 */

/** Neutral body color for STEP files that assign none. */
const DEFAULT_STEP_COLOR = new THREE.Color('#8f9a94')

/**
 * KiCad's VRML convention: 1 VRML unit = 0.1 inch, so models scale by 2.54 to
 * arrive in millimeters (StepUp-style exporters keep .wrl and .step in the
 * same coordinate frame apart from this factor).
 */
export const KICAD_VRML_UNIT_MM = 2.54

const makeMaterial = (color: THREE.Color): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    metalness: 0.2,
    roughness: 0.5,
    // STEP sheet bodies (and some tessellations) are not closed solids.
    side: THREE.DoubleSide
  })

/**
 * Per-face colors become geometry groups sharing a small material palette;
 * triangles outside every colored range keep the mesh's base material.
 */
const applyFaceColors = (
  geometry: THREE.BufferGeometry,
  faceColors: StepMeshFaceColor[],
  base: THREE.MeshStandardMaterial,
  triangleCount: number
): THREE.Material[] => {
  const materials: THREE.Material[] = [base]
  const materialIndexByColor = new Map<string, number>()

  const ranges = [...faceColors].sort((a, b) => a.first - b.first)
  let cursor = 0
  for (const range of ranges) {
    const first = Math.max(0, range.first)
    const last = Math.min(triangleCount - 1, range.last)
    if (last < first) continue
    if (first > cursor) geometry.addGroup(cursor * 3, (first - cursor) * 3, 0)
    const key = range.color.join(',')
    let index = materialIndexByColor.get(key)
    if (index === undefined) {
      index = materials.length
      materials.push(makeMaterial(new THREE.Color(...range.color)))
      materialIndexByColor.set(key, index)
    }
    geometry.addGroup(first * 3, (last - first + 1) * 3, index)
    cursor = last + 1
  }
  if (cursor < triangleCount) geometry.addGroup(cursor * 3, (triangleCount - cursor) * 3, 0)
  return materials
}

/** Assembles the tessellated STEP meshes into one renderable group. */
export function buildStepGroup(meshes: StepMeshData[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'step-model'
  for (const mesh of meshes) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    if (mesh.normals) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
    }
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    if (!mesh.normals) geometry.computeVertexNormals()

    const baseColor = mesh.color ? new THREE.Color(...mesh.color) : DEFAULT_STEP_COLOR.clone()
    const base = makeMaterial(baseColor)
    const triangleCount = mesh.indices.length / 3

    let material: THREE.Material | THREE.Material[] = base
    if (mesh.faceColors.length > 0) {
      material = applyFaceColors(geometry, mesh.faceColors, base, triangleCount)
    }
    const object = new THREE.Mesh(geometry, material)
    object.name = mesh.name
    group.add(object)
  }
  return group
}

/** Parses VRML text and scales it to millimeters (KiCad unit convention). */
export function buildVrmlGroup(text: string): THREE.Group {
  const scene = new VRMLLoader().parse(text, '')
  const group = new THREE.Group()
  group.name = 'vrml-model'
  group.add(scene)
  group.scale.setScalar(KICAD_VRML_UNIT_MM)
  return group
}
