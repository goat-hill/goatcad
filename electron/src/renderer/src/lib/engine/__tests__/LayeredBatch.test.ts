import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { LayeredPrimitiveBatch } from '../LayeredBatch'

/**
 * `LayeredLabelBatch` has no test here: `LabelBatch` rasterizes glyphs against
 * a DOM canvas and the suite runs in node. Its slot math is `boardLayerSlot` /
 * `boardLabelRenderOrder`, covered in `lib/kicad/__tests__/layers.test.ts`.
 */

const red = new THREE.Color(1, 0, 0)
const blue = new THREE.Color(0, 0, 1)

// One slot per whole number of z; strokes of a slot draw after its fills.
const slotOfZ = (z: number): number => Math.floor(z)
const renderOrderOfSlot = (slot: number): number => slot * 2 + 1

const layered = (): LayeredPrimitiveBatch =>
  new LayeredPrimitiveBatch(slotOfZ, renderOrderOfSlot, {}, 16)

const meshes = (batch: LayeredPrimitiveBatch): THREE.Mesh[] => batch.group.children as THREE.Mesh[]

const instanceCount = (mesh: THREE.Mesh): number =>
  (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount

const colorOf = (mesh: THREE.Mesh, instance: number): number[] => {
  const attr = mesh.geometry.getAttribute('iColor')
  return Array.from((attr.array as Float32Array).slice(instance * 4, instance * 4 + 3))
}

describe('LayeredPrimitiveBatch', () => {
  test('a slot gets a batch on first use, and only then', () => {
    const batch = layered()
    expect(meshes(batch)).toHaveLength(0)

    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 3.2)
    batch.addCapsule('seg:1', 2, 0, 3, 0, 0.1, red, 1, 3.4) // same slot
    expect(meshes(batch)).toHaveLength(1)

    batch.addCapsule('seg:2', 4, 0, 5, 0, 0.1, red, 1, 7.0)
    expect(meshes(batch)).toHaveLength(2)
  })

  test("a batch draws in its slot's place, which is what orders the board", () => {
    const batch = layered()
    batch.addCapsule('low', 0, 0, 1, 0, 0.1, red, 1, 2)
    batch.addCapsule('high', 0, 0, 1, 0, 0.1, red, 1, 9)

    const orders = meshes(batch).map((m) => m.renderOrder)
    expect(orders).toEqual([renderOrderOfSlot(2), renderOrderOfSlot(9)])
  })

  test('strokes land in the batch for their own z, not the one before them', () => {
    const batch = layered()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.addRing('b', 0, 0, 1, 0.1, red, 1, 5)
    batch.addRoundRect('c', 0, 0, 1, 1, 0, 0, red, 1, 5)
    batch.addArc('d', 0, 0, 1, 0.1, 0, 1, red, 1, 5)

    expect(meshes(batch).map(instanceCount)).toEqual([1, 3])
  })

  test('paint never writes depth — draw order alone decides what covers what', () => {
    // Not a caller's choice: being split across slots IS the claim that paint
    // order settles the stacking.
    const batch = layered()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 1)
    expect((meshes(batch)[0].material as THREE.ShaderMaterial).depthWrite).toBe(false)
  })

  test('an element split across slots recolors and restores as one', () => {
    const batch = layered()
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 1) // copper
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 6) // its mask opening

    batch.setElementColor('pad:0', blue)
    for (const mesh of meshes(batch)) expect(colorOf(mesh, 0)).toEqual([0, 0, 1])

    batch.resetColors()
    for (const mesh of meshes(batch)) expect(colorOf(mesh, 0)).toEqual([1, 0, 0])
  })

  test('an element split across slots drags as one', () => {
    const batch = layered()
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 6)

    batch.saveOrigins(['pad:0'])
    batch.translateElement('pad:0', 2, 3)

    for (const mesh of meshes(batch)) {
      const data0 = mesh.geometry.getAttribute('iData0').array as Float32Array
      expect(Array.from(data0.slice(0, 4))).toEqual([2, 3, 3, 3])
    }
  })

  test('removing an element clears it out of every slot it reached', () => {
    const batch = layered()
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.addCapsule('pad:0', 0, 0, 1, 0, 0.1, red, 1, 6)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 1)

    batch.removeElement('pad:0')
    // The slots survive for reuse; the removed element's instances are freed.
    batch.addCapsule('seg:1', 0, 0, 1, 0, 0.1, red, 1, 6)
    expect(meshes(batch).map(instanceCount)).toEqual([2, 1])
  })

  test('bounds cover every slot', () => {
    const batch = layered()
    batch.addCapsule('a', 0, 0, 0, 0, 0, red, 1, 1)
    batch.addCapsule('b', 10, 20, 10, 20, 0, red, 1, 6)

    const box = batch.getBounds(new THREE.Box3().makeEmpty())
    expect(box.max.x).toBeCloseTo(10, 6)
    expect(box.max.y).toBeCloseTo(20, 6)
  })

  test('reset empties the slots but keeps them, so a rebuild refills in place', () => {
    const batch = layered()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.addCapsule('b', 0, 0, 1, 0, 0.1, red, 1, 6)

    batch.reset()
    expect(meshes(batch)).toHaveLength(2)
    expect(meshes(batch).map(instanceCount)).toEqual([0, 0])
  })

  test('dispose takes the batches out of the scene graph', () => {
    const batch = layered()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.dispose()
    expect(meshes(batch)).toHaveLength(0)
  })
})

describe('LayeredPrimitiveBatch — the selected band', () => {
  // Slots 0–99 are the document; slot s lifts to s + 100, its z by 100.
  const band = { offset: 100, dz: 100 }
  const banded = (): LayeredPrimitiveBatch =>
    new LayeredPrimitiveBatch(slotOfZ, renderOrderOfSlot, {}, 16, band)

  /** The slots holding a key's paint, and each instance's z (data1[2]). */
  const where = (batch: LayeredPrimitiveBatch, key: string): Array<[number, number[]]> =>
    [...batch.debugElements()]
      .filter(([k]) => k.endsWith(`|${key}`))
      .map(([k, rows]) => [Number(k.split('|')[0]), rows.map((r) => Number(r.split(',')[6]))])

  test('a lifted element draws a band up — every slot it has paint in, z raised', () => {
    const batch = banded()
    batch.addCapsule('fp:0', 0, 0, 1, 0, 0.1, red, 1, 2.5)
    batch.addRoundRect('fp:0', 0, 0, 1, 1, 0, 0, red, 1, 7.25)
    batch.addCapsule('other:0', 0, 0, 1, 0, 0.1, red, 1, 7.5)

    batch.liftElements(new Set(['fp:0']))

    expect(where(batch, 'fp:0')).toEqual([
      [102, [102.5]],
      [107, [107.25]]
    ])
    expect(where(batch, 'other:0')).toEqual([[7, [7.5]]])
    const lifted = meshes(batch).find((m) => m.renderOrder === renderOrderOfSlot(107))
    expect(lifted && instanceCount(lifted)).toBeGreaterThan(0)
  })

  test('its parts go with it', () => {
    const batch = banded()
    batch.addCapsule('fp:0/pad:0', 0, 0, 1, 0, 0.1, red, 1, 3)
    batch.liftElements(new Set(['fp:0']))
    expect(where(batch, 'fp:0/pad:0')).toEqual([[103, [103]]])
  })

  test('an element no longer named goes home, and lifting again changes nothing', () => {
    const batch = banded()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.addCapsule('b', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.liftElements(new Set(['a']))
    batch.liftElements(new Set(['a']))
    expect(where(batch, 'a')).toEqual([[104, [104]]])

    batch.liftElements(new Set(['b']))
    expect(where(batch, 'a')).toEqual([[4, [4]]])
    expect(where(batch, 'b')).toEqual([[104, [104]]])

    batch.liftElements(new Set())
    expect(where(batch, 'b')).toEqual([[4, [4]]])
  })

  test('an element drawn again at home while selected lifts on the next call', () => {
    // An edit re-renders what it changed at home; the band is read, not remembered.
    const batch = banded()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.liftElements(new Set(['a']))
    batch.removeElement('a')
    batch.addCapsule('a', 5, 0, 6, 0, 0.1, red, 1, 4)
    batch.liftElements(new Set(['a']))
    expect(where(batch, 'a')).toEqual([[104, [104]]])
  })

  test('a lift carries what an instance is: its tint, its default color, a hide', () => {
    const batch = banded()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.shiftElementColors('a', 0.5)
    batch.setElementHidden('a', true)
    batch.liftElements(new Set(['a']))

    const lifted = meshes(batch).find((m) => m.renderOrder === renderOrderOfSlot(104))!
    const [x, y, z] = colorOf(lifted, 0)
    expect([x, y, z]).not.toEqual([1, 0, 0])
    batch.resetColors()
    expect(colorOf(lifted, 0)).toEqual([1, 0, 0])
    batch.setElementHidden('a', false)
    expect(where(batch, 'a')).toEqual([[104, [104]]])
  })

  test('a lift carries a drag origin: what is lifted after its origin is saved still follows', () => {
    // The board's placement ghost: drawn, its origin saved, then lifted as if selected.
    const batch = banded()
    batch.addCapsule('fp:-1/pad:0', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.saveOrigins(['fp:-1'])
    batch.liftElements(new Set(['fp:-1']))
    batch.translateElement('fp:-1', 10, 5)

    const [row] = [...batch.debugElements()].find(([k]) => k.endsWith('|fp:-1/pad:0'))![1]
    expect(row.split(',').slice(0, 4).map(Number)).toEqual([10, 5, 11, 5])
  })

  test('an element drawn again after its removal follows from where it is now drawn', () => {
    // The ghost redrawn turned (R): the old drawing's origin must not come back.
    const batch = banded()
    const ghost = (x: number): void => {
      batch.removeElement('fp:-1')
      batch.addCapsule('fp:-1/pad:0', x, 0, x + 1, 0, 0.1, red, 1, 4)
      batch.saveOrigins(['fp:-1'])
      batch.liftElements(new Set(['fp:-1']))
    }
    ghost(0)
    ghost(3)
    batch.translateElement('fp:-1', 10, 5)

    const rows = [...batch.debugElements()].find(([k]) => k.endsWith('|fp:-1/pad:0'))![1]
    expect(rows.map((row) => row.split(',').slice(0, 4).map(Number))).toEqual([[13, 5, 14, 5]])
  })

  test('selecting and deselecting leave home paint where it is, and send only its visibility', () => {
    const batch = banded()
    for (let i = 0; i < 6; i++) batch.addCapsule(`seg:${i}`, i, 0, i, 1, 0.1, red, 1, 4)
    const home = meshes(batch).find((m) => m.renderOrder === renderOrderOfSlot(4))!
    const order = batch.debugDrawOrder().get(4)
    const attrs = ['iData0', 'iData1', 'iColor'].map(
      (name) => home.geometry.getAttribute(name) as THREE.InstancedBufferAttribute
    )
    for (const attr of attrs) {
      attr.clearUpdateRanges()
      attr.onUploadCallback()
    }

    batch.liftElements(new Set(['seg:2']))
    batch.liftElements(new Set())
    // The type (iData1.w) hid and showed seg:2; nothing else at home was written.
    expect(attrs.map((attr) => attr.updateRanges)).toEqual([[], [{ start: 8, count: 4 }], []])
    expect(batch.debugDrawOrder().get(4)).toEqual(order)
    expect(where(batch, 'seg:2')).toEqual([[4, [4]]])
  })

  test('a preview showing what it hid leaves a lifted element hidden at home', () => {
    const batch = banded()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, red, 1, 4)
    batch.liftElements(new Set(['a']))
    batch.setElementHidden('a', true)
    batch.setElementHidden('a', false)
    expect(where(batch, 'a')).toEqual([[104, [104]]])
    batch.liftElements(new Set())
    expect(where(batch, 'a')).toEqual([[4, [4]]])
  })

  test('a batch without a band lifts nothing', () => {
    const batch = layered()
    batch.addCapsule('a', 0, 0, 1, 0, 0.1, blue, 1, 4)
    expect(batch.liftElements(new Set(['a']))).toEqual([])
    expect(meshes(batch)).toHaveLength(1)
  })
})
