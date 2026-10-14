import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { PrimitiveBatch } from '../PrimitiveBatch'

// Mimic what three's WebGLAttributes does when it consumes an upload:
// bufferSubData, then clear ranges and fire the attribute's onUpload callback
const consumeUpload = (attr: THREE.InstancedBufferAttribute): void => {
  attr.clearUpdateRanges()
  attr.onUploadCallback()
}

const getAttr = (batch: PrimitiveBatch, name: string): THREE.InstancedBufferAttribute =>
  batch.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute

describe('PrimitiveBatch partial GPU uploads', () => {
  const red = new THREE.Color(1, 0, 0)
  const blue = new THREE.Color(0, 0, 1)

  test('translateElement adds update ranges only for the touched instances', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('seg:1', 5, 5, 6, 5, 0.1, red, 1, 0)
    const attr0 = getAttr(batch, 'iData0')
    consumeUpload(attr0) // initial full upload lands on the GPU

    batch.saveOrigins(['seg:0'])
    batch.translateElement('seg:0', 2, 3)

    expect(attr0.updateRanges.length).toBe(1)
    expect(attr0.updateRanges[0]).toEqual({ start: 0, count: 4 })
    // Both capsule endpoints moved; the untouched element stayed put
    expect(Array.from(attr0.array.slice(0, 4))).toEqual([2, 3, 3, 3])
    expect(Array.from(attr0.array.slice(4, 8))).toEqual([5, 5, 6, 5])
  })

  test('a new instance sends itself, and a run of them one range', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    const attr0 = getAttr(batch, 'iData0')
    const attr1 = getAttr(batch, 'iData1')
    consumeUpload(attr0)
    consumeUpload(attr1)

    batch.addCapsule('seg:1', 9, 9, 10, 9, 0.1, red, 1, 0)
    batch.addCapsule('seg:2', 9, 9, 10, 9, 0.1, red, 1, 0)
    expect(attr0.updateRanges).toEqual([{ start: 4, count: 8 }])
    expect(batch.mesh.geometry).toHaveProperty('instanceCount', 3)

    // A removal hides in place: only the type is sent
    consumeUpload(attr0)
    consumeUpload(attr1)
    batch.removeElement('seg:1')
    expect(attr0.updateRanges.length).toBe(0)
    expect(attr1.updateRanges).toEqual([{ start: 4, count: 4 }])
  })

  test('a reorder sends the whole buffer, and ranges wait until it lands', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 1)
    batch.addCapsule('seg:1', 0, 0, 1, 0, 0.1, red, 1, 0)
    const attr0 = getAttr(batch, 'iData0')
    consumeUpload(attr0)

    // A range now would truncate the reorder's rewrite to 4 floats
    batch.finalizeSorted()
    batch.saveOrigins(['seg:0'])
    batch.translateElement('seg:0', 1, 1)
    expect(attr0.updateRanges.length).toBe(0)

    consumeUpload(attr0)
    batch.translateElement('seg:0', 2, 2)
    expect(attr0.updateRanges.length).toBe(1)
  })

  test('past the range cap, the whole attribute is sent', () => {
    const batch = new PrimitiveBatch(4096)
    for (let i = 0; i < 2000; i++) batch.addCapsule(`seg:${i}`, i, 0, i, 1, 0.1, red, 1, 0)
    const attrColor = getAttr(batch, 'iColor')
    consumeUpload(attrColor)
    // Every other instance: no two ranges join
    for (let i = 0; i < 2000; i += 2) batch.setElementColor(`seg:${i}`, blue)
    expect(attrColor.updateRanges.length).toBe(0)
  })

  test('resetColors restores exactly the recolored instances', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('seg:1', 5, 5, 6, 5, 0.1, red, 1, 0)
    const attrColor = getAttr(batch, 'iColor')
    consumeUpload(attrColor)

    batch.setElementColor('seg:1', blue)
    expect(attrColor.updateRanges).toEqual([{ start: 4, count: 4 }])
    expect(Array.from(attrColor.array.slice(4, 7))).toEqual([0, 0, 1])
    consumeUpload(attrColor)

    batch.resetColors()
    expect(attrColor.updateRanges).toEqual([{ start: 4, count: 4 }])
    expect(Array.from(attrColor.array.slice(4, 7))).toEqual([1, 0, 0])

    // Nothing highlighted anymore: reset is a no-op, no ranges, no upload
    consumeUpload(attrColor)
    batch.resetColors()
    expect(attrColor.updateRanges.length).toBe(0)
  })

  test('shifts selected elements from their own default colors', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, new THREE.Color(0.2, 0.4, 0.6), 1, 0)
    const attrColor = getAttr(batch, 'iColor')
    consumeUpload(attrColor)

    batch.shiftElementColors('seg:0', 0.5)
    Array.from(attrColor.array.slice(0, 3)).forEach((value, index) => {
      expect(value).toBeCloseTo([0.6, 0.7, 0.8][index])
    })
    consumeUpload(attrColor)

    batch.shiftElementColors('seg:0', -0.5)
    Array.from(attrColor.array.slice(0, 3)).forEach((value, index) => {
      expect(value).toBeCloseTo([0.1, 0.2, 0.3][index])
    })
  })
})

// Paint is filed under the most specific name a part has, so a single pin can
// be moved or highlighted. Everything that predates this — and every key in the
// PCB and footprint editors — has no children and must behave exactly as before.
// See ARCHITECTURE.md §3.7.
describe('PrimitiveBatch part hierarchy', () => {
  const red = new THREE.Color(1, 0, 0)
  const blue = new THREE.Color(0, 0, 1)
  const dataOf = (batch: PrimitiveBatch): Float32Array =>
    (getAttr(batch, 'iData0').array as Float32Array).slice()

  const withParts = (): PrimitiveBatch => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('symbol:0/pin:0.1.1.0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('symbol:0/graphic:0.0.1.0', 2, 0, 3, 0, 0.1, red, 1, 0)
    batch.addCapsule('symbol:1/pin:0.1.1.0', 8, 8, 9, 8, 0.1, red, 1, 0)
    return batch
  }

  test('moving a parent moves every part filed beneath it', () => {
    const batch = withParts()
    batch.saveOrigins(['symbol:0'])
    batch.translateElement('symbol:0', 10, 0)
    const data = dataOf(batch)
    expect([data[0], data[4]]).toEqual([10, 12])
    // A different symbol's parts are untouched.
    expect(data[8]).toBe(8)
  })

  test('a part can be moved without disturbing its siblings', () => {
    const batch = withParts()
    batch.saveOrigins(['symbol:0/pin:0.1.1.0'])
    batch.translateElement('symbol:0/pin:0.1.1.0', 0, 5)
    const data = dataOf(batch)
    expect(data[1]).toBe(5)
    expect(data[5]).toBe(0) // the sibling graphic stayed put
  })

  test('coloring a parent colors its parts, and reset restores them', () => {
    const batch = withParts()
    batch.setElementColor('symbol:0', blue)
    const colored = getAttr(batch, 'iColor').array as Float32Array
    expect([colored[2], colored[6]]).toEqual([1, 1]) // both parts blue
    expect(colored[10]).toBe(0) // the other symbol untouched

    batch.resetColors()
    expect([colored[2], colored[6]]).toEqual([0, 0])
  })

  test('removing a parent removes its parts, not just its own paint', () => {
    const batch = withParts()
    batch.removeElement('symbol:0')
    batch.saveOrigins(['symbol:0/pin:0.1.1.0'])
    batch.translateElement('symbol:0/pin:0.1.1.0', 100, 100)
    // Nothing left to move: the part's instances were recycled with the parent.
    expect(dataOf(batch)[0]).not.toBe(100)
  })

  test('a childless key behaves exactly as before — the PCB and footprint case', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('segment:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('segment:1', 5, 5, 6, 5, 0.1, red, 1, 0)
    batch.saveOrigins(['segment:0'])
    batch.translateElement('segment:0', 2, 3)
    const data = dataOf(batch)
    expect([data[0], data[1]]).toEqual([2, 3])
    expect([data[4], data[5]]).toEqual([5, 5])
  })

  test('a parent name that shares a prefix with another is not swept up', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('symbol:1/pin:0.1.1.0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('symbol:11/pin:0.1.1.0', 5, 5, 6, 5, 0.1, red, 1, 0)
    batch.saveOrigins(['symbol:1'])
    batch.translateElement('symbol:1', 10, 0)
    const data = dataOf(batch)
    expect(data[0]).toBe(10)
    // `symbol:11` merely starts with `symbol:1` — a prefix scan would move it.
    expect(data[4]).toBe(5)
  })
})

// Hiding stands an element down without recycling it, so the symbol editor's
// resize can draw the changed shape in the preview batch while the real one
// waits underneath. See ARCHITECTURE.md §3.7.
describe('PrimitiveBatch hiding', () => {
  const red = new THREE.Color(1, 0, 0)
  /** The shape-type slot — TYPE_HIDDEN (-1) means "draw nothing". */
  const typeOf = (batch: PrimitiveBatch, instance: number): number =>
    (getAttr(batch, 'iData1').array as Float32Array)[instance * 4 + 3]

  test('hiding and showing restores the original shape type', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('graphic:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    const drawn = typeOf(batch, 0)
    expect(drawn).not.toBe(-1)

    batch.setElementHidden('graphic:0', true)
    expect(typeOf(batch, 0)).toBe(-1)

    batch.setElementHidden('graphic:0', false)
    expect(typeOf(batch, 0)).toBe(drawn)
  })

  test('hiding a parent hides every part filed beneath it', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('symbol:0/pin:0.1.1.0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.addCapsule('symbol:0/graphic:0.0.1.0', 2, 0, 3, 0, 0.1, red, 1, 0)
    batch.setElementHidden('symbol:0', true)
    expect([typeOf(batch, 0), typeOf(batch, 1)]).toEqual([-1, -1])

    batch.showAllHidden()
    expect(typeOf(batch, 0)).not.toBe(-1)
    expect(typeOf(batch, 1)).not.toBe(-1)
  })

  test('hiding twice still shows back the shape, not the hidden marker', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('graphic:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    const drawn = typeOf(batch, 0)
    batch.setElementHidden('graphic:0', true)
    // The second hide must not record TYPE_HIDDEN as the type to come back to.
    batch.setElementHidden('graphic:0', true)
    batch.setElementHidden('graphic:0', false)
    expect(typeOf(batch, 0)).toBe(drawn)
  })

  // removeElement recycles instances onto the free list. A hide recorded
  // against one of those slots outlives the element unless it is dropped, and
  // showAllHidden would then stamp the dead element's shape type onto whoever
  // moved in — a ring redrawn as a capsule, or a hidden element resurrected.
  test('removing a hidden element does not corrupt whatever reuses its slot', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('graphic:0', 0, 0, 1, 0, 0.1, red, 1, 0)
    batch.setElementHidden('graphic:0', true)
    batch.removeElement('graphic:0')

    batch.addRing('ring:0', 0, 0, 1, 0.1, red, 1, 0)
    const ringType = typeOf(batch, 0) // took the recycled slot
    batch.showAllHidden()
    expect(typeOf(batch, 0)).toBe(ringType)
  })
})

describe('PrimitiveBatch selection z lift', () => {
  const red = new THREE.Color(1, 0, 0)
  const zOf = (batch: PrimitiveBatch, instance: number): number =>
    (getAttr(batch, 'iData1').array as Float32Array)[instance * 4 + 2]

  test('lifts one element, leaves neighbors, and restores exactly', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0.05)
    batch.addCapsule('seg:1', 5, 5, 6, 5, 0.1, red, 1, 0.07)

    batch.setElementZOffset('seg:0', 0.5)
    expect(zOf(batch, 0)).toBeCloseTo(0.55, 6)
    expect(zOf(batch, 1)).toBeCloseTo(0.07, 6)

    // Re-applying the same offset is a no-op, not a second lift — the scene
    // re-runs its selection pass freely and must not stack offsets.
    batch.setElementZOffset('seg:0', 0.5)
    expect(zOf(batch, 0)).toBeCloseTo(0.55, 6)

    batch.setElementZOffset('seg:0', 0)
    expect(zOf(batch, 0)).toBeCloseTo(0.05, 6)
  })

  test('lifting a parent lifts every part filed beneath it', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('symbol:0/pin:a', 0, 0, 1, 0, 0.1, red, 1, 0.05)
    batch.addCapsule('symbol:0/graphic:b', 2, 2, 3, 2, 0.1, red, 1, 0.03)

    batch.setElementZOffset('symbol:0', 0.5)
    expect(zOf(batch, 0)).toBeCloseTo(0.55, 6)
    expect(zOf(batch, 1)).toBeCloseTo(0.53, 6)

    batch.setElementZOffset('symbol:0', 0)
    expect(zOf(batch, 0)).toBeCloseTo(0.05, 6)
    expect(zOf(batch, 1)).toBeCloseTo(0.03, 6)
  })

  test('a removed element does not leave a stale lift on its recycled slot', () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0.05)
    batch.setElementZOffset('seg:0', 0.5)
    batch.removeElement('seg:0')

    batch.addCapsule('seg:0', 0, 0, 1, 0, 0.1, red, 1, 0.05) // recycled slot
    // A stale "already lifted" claim would make this restore SINK the fresh
    // instance by a full lift instead of doing nothing.
    batch.setElementZOffset('seg:0', 0)
    expect(zOf(batch, 0)).toBeCloseTo(0.05, 6)
  })
})

describe('PrimitiveBatch.elementBounds', () => {
  const red = new THREE.Color(1, 0, 0)

  test("covers one element and its parts, by each shape's own extent", () => {
    const batch = new PrimitiveBatch(16)
    batch.addCapsule('fp:0', 0, 0, 2, 0, 0.5, red, 1, 0)
    batch.addRing('fp:0/pad:1', 10, 0, 1, 0.25, red, 1, 0)
    batch.addRoundRect('fp:1', 50, 50, 3, 4, 0, 0, red, 1, 0)
    const box = batch.elementBounds('fp:0', new THREE.Box3())
    expect(box.min.x).toBe(-0.5)
    expect(box.max.x).toBe(11.25)
    expect(box.min.y).toBe(-1.25)
    expect(box.max.y).toBe(1.25)
  })

  test('follows a drag and still counts a hidden element', () => {
    const batch = new PrimitiveBatch(16)
    batch.addRing('via:0', 0, 0, 1, 0, red, 1, 0)
    batch.saveOrigins(['via:0'])
    batch.translateElement('via:0', 5, 0)
    batch.setElementHidden('via:0', true)
    const box = batch.elementBounds('via:0', new THREE.Box3())
    expect([box.min.x, box.max.x]).toEqual([4, 6])
  })

  test('leaves the box empty for a key it never drew', () => {
    const batch = new PrimitiveBatch(16)
    expect(batch.elementBounds('nothing', new THREE.Box3()).isEmpty()).toBe(true)
  })
})
