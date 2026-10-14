import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { soleSelection, VertexHandles } from '../VertexHandles'

describe('soleSelection', () => {
  test('returns the item only when it is the only one', () => {
    const a = { type: 'graphic', index: 0 }
    const b = { type: 'pin', index: 3 }
    expect(soleSelection([a])).toBe(a)
    expect(soleSelection([])).toBeNull()
    expect(soleSelection([a, b])).toBeNull()
  })
})

describe('VertexHandles', () => {
  const mount = (): { scene: THREE.Scene; handles: VertexHandles; group: THREE.Object3D } => {
    const scene = new THREE.Scene()
    const handles = new VertexHandles(scene)
    return { scene, handles, group: scene.children[0] }
  }

  test('carries the caller payload and marks the handle for the engine raycast', () => {
    const { handles, group } = mount()
    handles.render([{ x: 1, y: 2, data: { graphicIndex: 7, vertexIndex: 1 } }])
    const [handle] = group.children
    // `type: 'vertex'` is the whole contract ViewportEngine raycasts on, and it
    // sits on the parent so a ray hitting either tone resolves to one target.
    expect(handle.userData).toEqual({
      type: 'vertex',
      role: 'resize',
      graphicIndex: 7,
      vertexIndex: 1
    })
    expect(handle.position.x).toBe(1)
    expect(handle.position.y).toBe(2)
    expect(handle.children).toHaveLength(2)
  })

  test('role defaults to resize and is carried through when given', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 0, y: 0, data: {} },
      { x: 1, y: 1, role: 'move', data: {} }
    ])
    expect(group.children.map((h) => h.userData.role)).toEqual(['resize', 'move'])
  })

  test('a move handle is the square turned, so the two roles differ by shape', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 0, y: 0, data: {} },
      { x: 1, y: 1, role: 'move', data: {} }
    ])
    const [resize, move] = group.children
    expect(resize.children.every((m) => m.rotation.z === 0)).toBe(true)
    expect(move.children.every((m) => Math.abs(m.rotation.z - Math.PI / 4) < 1e-9)).toBe(true)
  })

  test('an anchor handle draws as a cross and keeps a square grab area', () => {
    // The glyph distinction: a diamond marks a grab point, a cross a TEXT's
    // anchor — the one point a drawing cannot show. Both drag the same way, so
    // the cross cannot be a 1.5 px target: the invisible pad gives it the
    // square's reach.
    const { handles, group } = mount()
    handles.setWorldPerPixel(1 / 40)
    handles.render([{ x: 0, y: 0, role: 'anchor', data: {} }])
    const [handle] = group.children
    expect(handle.userData.role).toBe('anchor')

    const pad = handle.children.find((part) => part.userData.pad)
    expect(pad).toBeDefined()
    // Transparent, not hidden: three.js skips `visible = false` when raycasting,
    // which would make the handle undraggable.
    expect((pad as THREE.Mesh).visible).toBe(true)
    expect(((pad as THREE.Mesh).material as THREE.Material).opacity).toBe(0)

    // Four bars: a dark pair under a bright pair, one of each axis.
    const bars = handle.children.filter((part) => part.userData.pad === undefined)
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      const [long, short] = bar.userData.vertical
        ? [bar.scale.y, bar.scale.x]
        : [bar.scale.x, bar.scale.y]
      expect(long).toBeGreaterThan(short)
    }
    // The arms reach past the grab pad, so the cross reads as a point marker
    // rather than as the square it replaced.
    const armSpan = Math.max(...bars.map((bar) => Math.max(bar.scale.x, bar.scale.y)))
    expect(armSpan).toBeGreaterThan(pad!.scale.x)
  })

  test('an anchor handle rescales with zoom like every other', () => {
    const { handles, group } = mount()
    handles.setWorldPerPixel(1 / 40)
    handles.render([{ x: 0, y: 0, role: 'anchor', data: {} }])
    const before = group.children[0].children.map((part) => part.scale.x)
    handles.setWorldPerPixel(1 / 400)
    const after = group.children[0].children.map((part) => part.scale.x)
    after.forEach((scale, index) => expect(scale).toBeCloseTo(before[index] / 10, 12))
  })

  test('render replaces rather than appends, and null clears', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 0, y: 0, data: {} },
      { x: 1, y: 0, data: {} }
    ])
    expect(group.children).toHaveLength(2)
    handles.render([{ x: 5, y: 5, data: {} }])
    expect(group.children).toHaveLength(1)
    handles.render(null)
    expect(group.children).toHaveLength(0)
  })

  test('geometry and materials are shared, and survive a re-render', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 0, y: 0, data: {} },
      { x: 1, y: 0, data: {} }
    ])
    const [first, second] = group.children
    const geometryOf = (h: THREE.Object3D): THREE.BufferGeometry =>
      (h.children[1] as THREE.Mesh).geometry
    expect(geometryOf(first)).toBe(geometryOf(second))
    // The rim and the core are deliberately NOT the same material — the pair is
    // what keeps one handle design legible on every editor's palette.
    const materialsOf = (h: THREE.Object3D): unknown[] =>
      h.children.map((m) => (m as THREE.Mesh).material)
    expect(materialsOf(first)[0]).not.toBe(materialsOf(first)[1])
    expect(materialsOf(first)).toEqual(materialsOf(second))

    // Clearing must not dispose what the next render needs: three.js drops the
    // attributes on dispose, so a disposed geometry shows an empty position.
    handles.render([{ x: 2, y: 2, data: {} }])
    const next = group.children[0]
    expect(geometryOf(next)).toBe(geometryOf(first))
    expect(geometryOf(next).getAttribute('position').count).toBeGreaterThan(0)
  })

  test('handles hold a constant on-screen size as zoom changes', () => {
    const { handles, group } = mount()
    handles.setWorldPerPixel(1 / 40)
    handles.render([{ x: 0, y: 0, data: {} }])
    const core = group.children[0].children[1]
    const atFortyPx = core.scale.x

    // Zoom in 10x: one pixel spans a tenth of the world, so the handle's world
    // size must shrink by the same factor to stay the same size on screen.
    handles.setWorldPerPixel(1 / 400)
    expect(core.scale.x).toBeCloseTo(atFortyPx / 10, 12)

    // A handle rendered after the zoom change gets the current scale, not the
    // constructor default — otherwise the first selection after a zoom is wrong.
    handles.render([{ x: 1, y: 1, data: {} }])
    expect(group.children[0].children[1].scale.x).toBeCloseTo(atFortyPx / 10, 12)
  })

  test('the rim is larger than the core, so it reads as an outline', () => {
    const { handles, group } = mount()
    handles.render([{ x: 0, y: 0, data: {} }])
    const [rim, core] = group.children[0].children
    expect(rim.scale.x).toBeGreaterThan(core.scale.x)
  })

  test('translate offsets from the saved origins, and only for saved handles', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 10, y: 20, data: {} },
      { x: 0, y: 0, data: {} }
    ])
    handles.saveOrigins()
    handles.translate({ x: 3, y: -4 })
    // Repeated moves read the ORIGIN each time, so they cannot compound.
    handles.translate({ x: 5, y: 5 })
    const [a, b] = group.children
    expect([a.position.x, a.position.y]).toEqual([15, 25])
    expect([b.position.x, b.position.y]).toEqual([5, 5])

    handles.clearOrigins()
    handles.translate({ x: 100, y: 100 })
    expect(a.position.x).toBe(15)
  })

  test('dispose detaches the group from the scene', () => {
    const { scene, handles } = mount()
    handles.render([{ x: 0, y: 0, data: {} }])
    handles.dispose()
    expect(scene.children).toHaveLength(0)
  })
})

// A live resize repositions the handles from the shape being previewed, so the
// one under the cursor tracks it instead of waiting for the commit to redraw it
// somewhere else. See ARCHITECTURE.md §3.7.
describe('VertexHandles.setPositions', () => {
  const mount = (): { handles: VertexHandles; group: THREE.Object3D } => {
    const scene = new THREE.Scene()
    const handles = new VertexHandles(scene)
    return { handles, group: scene.children[0] }
  }

  test('moves handles in render order without rebuilding them', () => {
    const { handles, group } = mount()
    handles.render([
      { x: 0, y: 0, data: { vertexIndex: 0 } },
      { x: 5, y: 0, data: { vertexIndex: 1 } }
    ])
    const before = [...group.children]

    handles.setPositions([
      { x: 0, y: 0, data: { vertexIndex: 0 } },
      { x: 8, y: 3, data: { vertexIndex: 1 } }
    ])

    // Same objects — a rebuild per mouse move would churn a mesh pair each.
    expect(group.children).toEqual(before)
    expect([group.children[0].position.x, group.children[0].position.y]).toEqual([0, 0])
    expect([group.children[1].position.x, group.children[1].position.y]).toEqual([8, 3])
    // What a handle writes back cannot change under a resize.
    expect(group.children[1].userData.vertexIndex).toBe(1)
  })

  test('ignores positions with no handle to move', () => {
    const { handles, group } = mount()
    handles.render([{ x: 1, y: 1, data: {} }])
    expect(() =>
      handles.setPositions([
        { x: 2, y: 2, data: {} },
        { x: 9, y: 9, data: {} }
      ])
    ).not.toThrow()
    expect(group.children).toHaveLength(1)
    expect(group.children[0].position.x).toBe(2)
  })

  test('keeps the constant on-screen size a rebuild would have reapplied', () => {
    const { handles, group } = mount()
    handles.setWorldPerPixel(1 / 10)
    handles.render([{ x: 0, y: 0, data: {} }])
    const scaled = group.children[0].children[1].scale.x

    handles.setPositions([{ x: 4, y: 4, data: {} }])
    expect(group.children[0].children[1].scale.x).toBe(scaled)
  })
})
