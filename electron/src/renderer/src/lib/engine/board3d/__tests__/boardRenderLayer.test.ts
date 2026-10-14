/**
 * The layer's contract is about what it does NOT do: build twice for the same
 * board, and build at all before it is switched on.
 */
import type * as THREE from 'three'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DIM_ALPHA_FACTOR } from '../../../kicad/layers'
import { parseKicadBoard } from '../../../kicad/board'
import { loadClipper } from '../../../geometry/clip'
import { defaultBoard3DViewState } from '../../../board3dView'
import {
  BoardRenderLayer,
  REBUILD_SETTLE_MS,
  type BoardRenderLayerSources,
  type RenderLayerHost
} from '../boardRenderLayer'

const source = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts")
    (stroke (width 0.1) (type solid)) (fill none)))
`

const sourceWithPart = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "R_0603" (layer "F.Cu") (at 5 5)
    (attr smd)
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS"))
    (fp_rect (start -1.5 -0.8) (end 1.5 0.8) (layer "F.CrtYd")
      (stroke (width 0.05) (type default)) (fill none))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.9) (layers "F.Cu")))
  (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts")
    (stroke (width 0.1) (type solid)) (fill none)))
`

class FakeHost implements RenderLayerHost {
  attached: THREE.Object3D | null = null
  attachments: Array<THREE.Object3D | null> = []
  opacity = 1
  renders = 0
  refreshes = 0
  invalidations = 0

  /** Last (near, far, scale) handed over — the side policy's whole output. */
  sides: { near: THREE.Object3D | null; far: THREE.Object3D | null; scale: number } = {
    near: null,
    far: null,
    scale: 1
  }

  setRenderLayer(root: THREE.Object3D | null): void {
    this.attached = root
    this.attachments.push(root)
  }
  setRenderLayerSides(
    near: THREE.Object3D | null,
    far: THREE.Object3D | null,
    scale: number
  ): void {
    this.sides = { near, far, scale }
  }
  setRenderLayerOpacity(opacity: number): void {
    this.opacity = opacity
  }
  invalidateRenderLayer(): void {
    this.invalidations++
  }
  refreshRenderLayer(): void {
    this.refreshes++
  }
  render(): void {
    this.renders++
  }
}

const sourcesFor = (board: ReturnType<typeof parseKicadBoard> | null): BoardRenderLayerSources => ({
  board,
  filePath: null,
  projectDir: null,
  flipped: false,
  nonActiveDisplay: 'dim',
  options: defaultBoard3DViewState()
})

describe('BoardRenderLayer', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('builds nothing until it is switched on', async () => {
    const host = new FakeHost()
    let builds = 0
    let visibleWhileBuilding: boolean | undefined
    const layer = new BoardRenderLayer(host, (busy) => {
      if (!busy) return
      builds++
      visibleWhileBuilding = host.attached?.visible
    })

    layer.setSources(sourcesFor(parseKicadBoard(source)))
    await layer.settled()
    expect(builds).toBe(0)
    expect(host.attached).toBeNull()

    layer.setEnabled(true)
    await layer.settled()
    expect(builds).toBe(1)
    expect(host.attached).not.toBeNull()
    expect(visibleWhileBuilding).toBe(false)
    expect(host.attached?.visible).toBe(true)
    layer.dispose()
  })

  it('keeps the built scene across a toggle — the second switch-on is free', async () => {
    const host = new FakeHost()
    let builds = 0
    const layer = new BoardRenderLayer(host, (busy) => busy && builds++)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()
    const root = host.attached
    expect(builds).toBe(1)

    layer.setEnabled(false)
    await layer.settled()
    expect(host.attached).toBeNull()

    layer.setEnabled(true)
    await layer.settled()
    expect(builds).toBe(1)
    // The same scene object comes back, not an equivalent rebuild of it.
    expect(host.attached).toBe(root)
    layer.dispose()
  })

  it('rebuilds after the first build is switched off in flight', async () => {
    const host = new FakeHost()
    let interrupted = false
    const holder: { layer?: BoardRenderLayer } = {}
    const layer = new BoardRenderLayer(host, (busy) => {
      if (busy && !interrupted) {
        interrupted = true
        holder.layer?.setEnabled(false)
      }
    })
    holder.layer = layer
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()
    expect(host.attached).toBeNull()

    layer.setEnabled(true)
    await layer.settled()
    const body = host.attached?.getObjectByName('body')
    expect(body?.children.length).toBeGreaterThan(0)
    layer.dispose()
  })

  it('owes a rebuild when the board changes, and defers it while switched off', async () => {
    const host = new FakeHost()
    let builds = 0
    const layer = new BoardRenderLayer(host, (busy) => busy && builds++)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()
    expect(builds).toBe(1)

    layer.setEnabled(false)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    await layer.settled()
    // Off: the debt is recorded, not paid.
    expect(builds).toBe(1)

    layer.setEnabled(true)
    await layer.settled()
    expect(builds).toBe(2)
    layer.dispose()
  })

  it('rebuilds a lone board change at once, and a burst once it settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const host = new FakeHost()
      let builds = 0
      const layer = new BoardRenderLayer(host, (busy) => busy && builds++)
      layer.setSources(sourcesFor(parseKicadBoard(source)))
      layer.setEnabled(true)
      await layer.settled()
      expect(builds).toBe(1)

      vi.advanceTimersByTime(REBUILD_SETTLE_MS)
      layer.setSources(sourcesFor(parseKicadBoard(source)))
      await layer.settled()
      expect(builds).toBe(2)

      // An agent's writes, each followed by its refill: one rebuild, after.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(REBUILD_SETTLE_MS / 2)
        layer.setSources(sourcesFor(parseKicadBoard(source)))
      }
      const settled = layer.settled()
      await Promise.resolve()
      expect(builds).toBe(2)
      vi.advanceTimersByTime(REBUILD_SETTLE_MS)
      await settled
      expect(builds).toBe(3)
      layer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns the render over to match a flipped (view-from-back) layout', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources({ ...sourcesFor(parseKicadBoard(source)), flipped: true })
    layer.setEnabled(true)
    await layer.settled()
    expect(host.attached?.rotation.y).toBeCloseTo(Math.PI, 6)

    layer.setSources({ ...sourcesFor(parseKicadBoard(source)), flipped: false })
    await layer.settled()
    expect(host.attached?.rotation.y).toBeCloseTo(0, 6)
    layer.dispose()
  })

  it('casts from the parts and receives on the board, but never casts the mask', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()

    const groups = new Map(host.attached!.children.map((child) => [child.name, child]))
    expect(groups.get('components')?.castShadow).toBe(true)
    expect(groups.get('components')?.receiveShadow).toBe(false)
    expect(groups.get('body')?.receiveShadow).toBe(true)
    // Translucent: casting would print the board's own outline back onto it.
    expect(groups.get('mask')?.castShadow).toBe(false)
    expect(groups.get('mask')?.receiveShadow).toBe(true)
    expect(groups.get('body')?.visible).toBe(true)
    expect(groups.get('mask')?.visible).toBe(false)
    expect(groups.get('copper')?.visible).toBe(false)
    expect(host.refreshes).toBeGreaterThan(0)
    layer.dispose()
  })

  it('restores the complete physical board for the unified 3D presentation', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()

    const body = host.attached!.getObjectByName('board-body') as THREE.Mesh
    const assemblyMaterial = body.material
    expect(host.attached!.getObjectByName('mask')?.visible).toBe(false)

    layer.setPresentation('3d')
    expect(body.material).not.toBe(assemblyMaterial)
    expect(host.attached!.getObjectByName('mask')?.visible).toBe(true)
    expect(host.attached!.getObjectByName('copper')?.visible).toBe(true)
    layer.dispose()
  })

  it('reloads component bodies when the model master switch changes', async () => {
    const host = new FakeHost()
    const board = parseKicadBoard(sourceWithPart)
    const layer = new BoardRenderLayer(host)
    const hidden = sourcesFor(board)
    hidden.options = { ...hidden.options, models: false }
    layer.setSources(hidden)
    layer.setEnabled(true)
    await layer.settled()
    expect(host.attached?.getObjectByName('standin:R1')).toBeUndefined()

    layer.setSources({ ...hidden, options: { ...hidden.options, models: true } })
    await layer.settled()
    expect(host.attached?.getObjectByName('standin:R1')).toBeDefined()
    layer.dispose()
  })

  it('moves a rendered footprint with the interactive layout drag', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(sourceWithPart)))
    layer.setEnabled(true)
    await layer.settled()
    expect(host.attached).not.toBeNull()
    const body = host.attached!.getObjectByName('standin:R1')!
    const start = body.position.clone()

    layer.beginComponentDrag([{ type: 'footprint', index: 0 }])
    layer.translateComponentDrag({ x: 3, y: -2 })
    expect(body.position.x).toBeCloseTo(start.x + 3)
    expect(body.position.y).toBeCloseTo(start.y - 2)
    expect(host.invalidations).toBeGreaterThan(0)
    layer.dispose()
  })

  // Which half is FAR follows the layout's flip, because the overlay is
  // registered pixel-for-pixel on the layout and has to agree with it about
  // which way the board faces. See BoardRenderLayer.applySides.
  it('calls the far side by the view, not by the active layer', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()

    const unflipped = host.sides
    expect(unflipped.near?.name).toBe('components:front')
    expect(unflipped.far?.name).toBe('components:back')

    layer.setSources({ ...sourcesFor(parseKicadBoard(source)), flipped: true })
    await layer.settled()
    expect(host.sides.near?.name).toBe('components:back')
    expect(host.sides.far?.name).toBe('components:front')
  })

  it('fades the far side by the layout rule that governs non-active layers', async () => {
    const board = parseKicadBoard(source)
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)

    layer.setSources({ ...sourcesFor(board), nonActiveDisplay: 'show' })
    layer.setEnabled(true)
    await layer.settled()
    expect(host.sides.scale).toBe(1)

    layer.setSources({ ...sourcesFor(board), nonActiveDisplay: 'dim' })
    await layer.settled()
    expect(host.sides.scale).toBe(DIM_ALPHA_FACTOR)

    layer.setSources({ ...sourcesFor(board), nonActiveDisplay: 'hide' })
    await layer.settled()
    expect(host.sides.scale).toBe(0)
  })

  // In 3D the board is a real opaque object; occlusion is physical and a
  // side policy would only fight it.
  it('applies no side policy in 3D preview', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setPresentation('3d')
    layer.setEnabled(true)
    await layer.settled()

    expect(host.sides.near).toBeNull()
    expect(host.sides.far).toBeNull()
    expect(host.sides.scale).toBe(1)
  })

  it('recovers after a sync failure instead of staying wedged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const host = new FakeHost()
      let failures = 1
      const attach = host.setRenderLayer.bind(host)
      host.setRenderLayer = (root): void => {
        if (failures > 0) {
          failures--
          throw new Error('host rejected the layer')
        }
        attach(root)
      }
      let builds = 0
      const layer = new BoardRenderLayer(host, (busy) => {
        if (busy) builds++
      })

      layer.setSources(sourcesFor(parseKicadBoard(source)))
      layer.setEnabled(true)
      await layer.settled()
      expect(builds).toBe(0)
      expect(host.attached).toBeNull()

      // The next nudge must find a healthy chain and build normally.
      layer.setSources(sourcesFor(parseKicadBoard(source)))
      await layer.settled()
      expect(builds).toBe(1)
      expect(host.attached).not.toBeNull()
      layer.dispose()
    } finally {
      errors.mockRestore()
    }
  })

  it('detaches on dispose so a destroyed viewport keeps nothing alive', async () => {
    const host = new FakeHost()
    const layer = new BoardRenderLayer(host)
    layer.setSources(sourcesFor(parseKicadBoard(source)))
    layer.setEnabled(true)
    await layer.settled()

    layer.dispose()
    expect(host.attached).toBeNull()
  })
})
