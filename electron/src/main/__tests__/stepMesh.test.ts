import { describe, expect, test } from 'vitest'
import { toStepMeshes } from '../stepMesh'

// Shaped like real occt-import-js output (see the package README): plain JSON
// with number arrays; colors are 0..1 floats; brep_faces cover triangle ranges.
const cubeFace = {
  name: 'Part 1',
  color: [0.8, 0.2, 0.1],
  brep_faces: [
    { first: 0, last: 0, color: [0, 0.5, 1] },
    { first: 1, last: 1, color: null }
  ],
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] }
  },
  index: { array: [0, 1, 2, 0, 2, 3] }
}

describe('toStepMeshes', () => {
  test('converts a successful occt result to typed transferable meshes', () => {
    const meshes = toStepMeshes({ success: true, meshes: [cubeFace] })
    expect(meshes).toHaveLength(1)
    const mesh = meshes[0]
    expect(mesh.name).toBe('Part 1')
    expect(mesh.color).toEqual([0.8, 0.2, 0.1])
    expect(mesh.positions).toBeInstanceOf(Float32Array)
    expect(mesh.positions).toHaveLength(12)
    expect(mesh.normals).toBeInstanceOf(Float32Array)
    expect(mesh.indices).toBeInstanceOf(Uint32Array)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3])
  })

  test('keeps only face ranges that carry an explicit color', () => {
    const meshes = toStepMeshes({ success: true, meshes: [cubeFace] })
    expect(meshes[0].faceColors).toEqual([{ first: 0, last: 0, color: [0, 0.5, 1] }])
  })

  test('drops a normal array whose length disagrees with positions', () => {
    const broken = {
      ...cubeFace,
      attributes: { ...cubeFace.attributes, normal: { array: [0, 0, 1] } }
    }
    const meshes = toStepMeshes({ success: true, meshes: [broken] })
    expect(meshes[0].normals).toBeNull()
  })

  test('clamps out-of-range colors', () => {
    const tinted = { ...cubeFace, color: [1.5, -0.2, 0.5] }
    const meshes = toStepMeshes({ success: true, meshes: [tinted] })
    expect(meshes[0].color).toEqual([1, 0, 0.5])
  })

  test('throws on kernel failure and on empty geometry', () => {
    expect(() => toStepMeshes({ success: false })).toThrow(/STEP/)
    expect(() => toStepMeshes({ success: true, meshes: [] })).toThrow(/no renderable/)
    expect(() => toStepMeshes({ success: true, meshes: [{ name: 'empty' }] })).toThrow(
      /no renderable/
    )
  })
})
