import { beforeAll, describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import {
  framedFootprintBox,
  drawBoardForCapture,
  captureDisplayOptions,
  BOARD_FRAME_MARGIN
} from '../boardCapture'
import { DIM_ALPHA_FACTOR } from '../../kicad/layers'
import { BoardScene } from '../BoardScene'
import type { FillWorkRequest, FillWorkResponse } from '../fillWorker'
import { parseKicadBoard } from '../../kicad/board'
import { loadClipper } from '../../geometry/clip'

const bounds = {
  0: { minX: 10, minY: -20, maxX: 12, maxY: -18 },
  1: { minX: 30, minY: -25, maxX: 31, maxY: -24 }
}

const boundsOf = (index: number): (typeof bounds)[0] | undefined =>
  bounds[index as keyof typeof bounds]

describe('framedFootprintBox', () => {
  test('one footprint, with the margin around it', () => {
    expect(framedFootprintBox(boundsOf, [0], false)).toEqual({
      minX: 10 - BOARD_FRAME_MARGIN,
      maxX: 12 + BOARD_FRAME_MARGIN,
      minY: -20 - BOARD_FRAME_MARGIN,
      maxY: -18 + BOARD_FRAME_MARGIN
    })
  })

  test('several footprints union', () => {
    expect(framedFootprintBox(boundsOf, [0, 1], false)).toMatchObject({ minX: 8, maxX: 33 })
  })

  test('the back view mirrors x, and the extremes swap with it', () => {
    // Data x 10..12 is world x -12..-10 when the board is drawn from the back.
    expect(framedFootprintBox(boundsOf, [0], true)).toEqual({
      minX: -12 - BOARD_FRAME_MARGIN,
      maxX: -10 + BOARD_FRAME_MARGIN,
      minY: -20 - BOARD_FRAME_MARGIN,
      maxY: -18 + BOARD_FRAME_MARGIN
    })
  })

  test('y is untouched by the flip', () => {
    const front = framedFootprintBox(boundsOf, [0, 1], false)
    const back = framedFootprintBox(boundsOf, [0, 1], true)
    expect(back?.minY).toBe(front?.minY)
    expect(back?.maxY).toBe(front?.maxY)
  })

  test('a footprint the scene never measured is skipped, and none at all is null', () => {
    expect(framedFootprintBox(boundsOf, [0, 9], false)).toMatchObject({ minX: 8, maxX: 14 })
    expect(framedFootprintBox(boundsOf, [9], false)).toBeNull()
    expect(framedFootprintBox(boundsOf, [], false)).toBeNull()
  })
})

/**
 * The window's triangulation pool, held still: a fill posted to it lands only
 * when the test answers, as a real worker's result arrives some time after the
 * rebuild that asked for it.
 */
class HeldWorker {
  static readonly all: HeldWorker[] = []
  onmessage: ((event: { data: FillWorkResponse }) => void) | null = null
  private posted: FillWorkRequest[] = []

  constructor() {
    HeldWorker.all.push(this)
  }

  postMessage(request: FillWorkRequest): void {
    this.posted.push(request)
  }

  /** Answer every fill posted so far, each fanned from its first point. */
  static answerAll(): void {
    for (const worker of HeldWorker.all) {
      for (const { id, coords } of worker.posted.splice(0)) {
        const points = coords.length / 2
        const index = new Uint32Array((points - 2) * 3)
        for (let i = 0; i < points - 2; i++) index.set([0, i + 1, i + 2], i * 3)
        worker.onmessage?.({ data: { id, index } })
      }
    }
  }
}

/** A board whose one zone is filled with a rectangle `width` mm wide: a fresh width is a cold cache. */
const filledBoard = (width: number): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "GND")
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z0") (hatch edge 0.5)
    (min_thickness 0.25) (fill yes)
    (polygon (pts (xy 0 0) (xy ${width} 0) (xy ${width} 5) (xy 0 5)))
    (filled_polygon (layer "F.Cu") (pts (xy 0.2 0.2) (xy ${width - 0.2} 0.2) (xy ${width - 0.2} 4.8) (xy 0.2 4.8)))
  )
)`)

const meshCount = (root: THREE.Object3D): number => {
  let count = 0
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) count++
  })
  return count
}

describe('drawBoardForCapture', () => {
  const poured = { fills: true }
  beforeAll(async () => {
    vi.stubGlobal('Worker', HeldWorker)
    // Label glyphs rasterize against a DOM canvas this environment lacks.
    const context = {
      measureText: (text: string) => ({ width: text.length * 20 + 8 }),
      fillText: (): void => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4)
      })
    }
    vi.stubGlobal('document', {
      documentElement: {},
      createElement: () => ({ width: 0, height: 0, getContext: () => context })
    })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    await loadClipper()
  })

  test('the picture waits for the zone fills its own drawing sent to the workers', async () => {
    const root = new THREE.Scene()
    const scene = new BoardScene(root)
    const drawn = drawBoardForCapture(scene, filledBoard(10.7), poured)
    // The rebuild has run and posted the fill, and a capture taken now would miss it.
    expect(scene.getFillProgress()).toEqual({ queued: 1, settled: 0 })
    const before = meshCount(root)
    HeldWorker.answerAll()
    expect((await drawn).unfinishedFills).toBe(0)
    expect(meshCount(root)).toBe(before + 1)
    scene.dispose()
  })

  test('draws zones as outlines unless fills is asked for: nothing is poured', async () => {
    const scene = new BoardScene(new THREE.Scene())
    const drawn = await drawBoardForCapture(scene, filledBoard(13.7), {}, 1)
    expect(drawn.unfinishedFills).toBe(0)
    expect(scene.getFillProgress()).toEqual({ queued: 0, settled: 0 })
    scene.dispose()
  })

  test('a fill that has not landed when the time runs out is counted, not waited for', async () => {
    const scene = new BoardScene(new THREE.Scene())
    const drawn = await drawBoardForCapture(scene, filledBoard(11.3), poured, 1)
    expect(drawn.unfinishedFills).toBe(1)
    scene.dispose()
  })

  test('a fill already triangulated is drawn at once', async () => {
    const root = new THREE.Scene()
    const scene = new BoardScene(root)
    const board = filledBoard(12.9)
    const first = drawBoardForCapture(scene, board, poured)
    HeldWorker.answerAll()
    await first
    const again = new BoardScene(new THREE.Scene())
    expect((await drawBoardForCapture(again, filledBoard(12.9), poured, 1)).unfinishedFills).toBe(0)
    expect(again.getFillProgress()).toEqual({ queued: 0, settled: 0 })
    scene.dispose()
    again.dispose()
  })
})

describe('captureDisplayOptions', () => {
  test('draws zones as outlines unless fills is asked for', () => {
    expect(captureDisplayOptions({}).zoneFills).toBe(false)
    expect(captureDisplayOptions({ fills: true }).zoneFills).toBe(true)
  })

  test('dims nothing without an active layer, and the rest to dim with one', () => {
    expect(captureDisplayOptions({})).not.toHaveProperty('nonActiveDisplay')
    expect(captureDisplayOptions({ activeLayer: 'B.Cu', dim: 0.5 })).toMatchObject({
      nonActiveDisplay: 'dim',
      dimStrength: 0.5
    })
    expect(captureDisplayOptions({ activeLayer: 'B.Cu' }).dimStrength).toBe(DIM_ALPHA_FACTOR)
  })
})
