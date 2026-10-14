import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { buildStepGroup, KICAD_VRML_UNIT_MM } from '../modelGeometry'
import type { StepMeshData } from '../../../../../preload/modelTypes'

const quad = (overrides: Partial<StepMeshData> = {}): StepMeshData => ({
  name: 'part',
  color: [0.2, 0.4, 0.6],
  faceColors: [],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  ...overrides
})

describe('buildStepGroup', () => {
  test('builds one mesh per entry with the mesh color', () => {
    const group = buildStepGroup([quad()])
    expect(group.children).toHaveLength(1)
    const mesh = group.children[0] as THREE.Mesh
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.color.b).toBeCloseTo(0.6)
    expect(mesh.geometry.getAttribute('position').count).toBe(4)
    expect(mesh.geometry.getIndex()?.count).toBe(6)
  })

  test('computes normals when the kernel emitted none', () => {
    const group = buildStepGroup([quad({ normals: null })])
    const mesh = group.children[0] as THREE.Mesh
    const normal = mesh.geometry.getAttribute('normal')
    expect(normal.count).toBe(4)
    expect(normal.getZ(0)).toBeCloseTo(1)
  })

  test('face color ranges become geometry groups over a material palette', () => {
    const group = buildStepGroup([quad({ faceColors: [{ first: 1, last: 1, color: [1, 0, 0] }] })])
    const mesh = group.children[0] as THREE.Mesh
    const materials = mesh.material as THREE.Material[]
    expect(materials).toHaveLength(2)
    // Triangle 0 keeps the base material, triangle 1 gets the red override.
    expect(mesh.geometry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 }
    ])
    expect((materials[1] as THREE.MeshStandardMaterial).color.r).toBeCloseTo(1)
  })

  test('identical face colors share one material', () => {
    const group = buildStepGroup([
      quad({
        faceColors: [
          { first: 0, last: 0, color: [1, 0, 0] },
          { first: 1, last: 1, color: [1, 0, 0] }
        ]
      })
    ])
    const mesh = group.children[0] as THREE.Mesh
    expect(mesh.material as THREE.Material[]).toHaveLength(2)
  })
})

describe('KiCad VRML unit convention', () => {
  test('one VRML unit is 0.1 inch in millimeters', () => {
    expect(KICAD_VRML_UNIT_MM).toBeCloseTo(2.54)
  })
})
