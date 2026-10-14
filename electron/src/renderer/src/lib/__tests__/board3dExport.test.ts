import { describe, expect, test } from 'vitest'
import {
  BOARD3D_EXPORT_MAX_PIXELS,
  BOARD3D_EXPORT_MIN_PIXELS,
  board3dExportPath,
  clampExportPixels,
  compositeCapture,
  fitExportSize,
  fitWithin,
  resolveExportSize,
  sizeAtAspect
} from '../board3dExport'

describe('export sizes', () => {
  test('a typed size is rounded and held between the floor and the ceiling', () => {
    expect(clampExportPixels(1920.4)).toBe(1920)
    expect(clampExportPixels(1)).toBe(BOARD3D_EXPORT_MIN_PIXELS)
    expect(clampExportPixels(99999)).toBe(BOARD3D_EXPORT_MAX_PIXELS)
    expect(clampExportPixels(Number.NaN)).toBe(BOARD3D_EXPORT_MIN_PIXELS)
  })

  test("the view's own size is used as it is when it fits", () => {
    expect(
      resolveExportSize('view', { width: 1600, height: 900 }, { width: 1, height: 1 })
    ).toEqual({ width: 1600, height: 900 })
  })

  test('a view larger than the ceiling keeps its shape', () => {
    expect(fitExportSize({ width: 8192, height: 4096 })).toEqual({ width: 4096, height: 2048 })
  })

  test('a preset ignores the view and the custom fields', () => {
    expect(
      resolveExportSize('uhd', { width: 800, height: 600 }, { width: 10, height: 10 })
    ).toEqual({ width: 3840, height: 2160 })
  })

  test('a custom size is clamped a side at a time', () => {
    expect(
      resolveExportSize('custom', { width: 800, height: 600 }, { width: 5000, height: 2 })
    ).toEqual({ width: BOARD3D_EXPORT_MAX_PIXELS, height: BOARD3D_EXPORT_MIN_PIXELS })
  })
})

describe('locked proportions', () => {
  test('typing one side sets the other from the held proportion', () => {
    expect(sizeAtAspect('width', 1280, 16 / 9)).toEqual({ width: 1280, height: 720 })
    expect(sizeAtAspect('height', 1080, 16 / 9)).toEqual({ width: 1920, height: 1080 })
  })

  test('the proportion is held, not re-read from rounded sizes', () => {
    const small = sizeAtAspect('width', 100, 16 / 9)
    expect(small).toEqual({ width: 100, height: 56 })
    expect(sizeAtAspect('width', 1920, 16 / 9)).toEqual({ width: 1920, height: 1080 })
  })

  test('a side past the ceiling scales the whole size down', () => {
    expect(sizeAtAspect('height', 4096, 2)).toEqual({ width: 4096, height: 2048 })
  })
})

describe('the preview', () => {
  test('fits the picture inside its box, shape kept', () => {
    expect(fitWithin({ width: 3840, height: 2160 }, 480, 300)).toEqual({ width: 480, height: 270 })
    expect(fitWithin({ width: 2048, height: 2048 }, 480, 300)).toEqual({ width: 300, height: 300 })
  })
})

describe('the suggested file', () => {
  test('sits beside the board, named after it', () => {
    expect(board3dExportPath('/work/clock/canary.kicad_pcb', 'canary.kicad_pcb')).toBe(
      '/work/clock/canary-3d.png'
    )
    expect(board3dExportPath('C:\\work\\canary.kicad_pcb', 'canary.kicad_pcb')).toBe(
      'C:\\work\\canary-3d.png'
    )
  })

  test('is a bare name for a board with no file on disk', () => {
    expect(board3dExportPath(null, 'draft.kicad_pcb')).toBe('draft-3d.png')
    expect(board3dExportPath('goatcad://sample/demo.kicad_pcb', 'demo.kicad_pcb')).toBe(
      'demo-3d.png'
    )
    expect(board3dExportPath(null, '')).toBe('board-3d.png')
  })
})

describe('compositeCapture', () => {
  // Opaque red, half-covered premultiplied red, nothing.
  const buffer = (): Uint8ClampedArray =>
    new Uint8ClampedArray([200, 0, 0, 255, 100, 0, 0, 128, 0, 0, 0, 0])

  test('transparent undoes the premultiply and keeps the alpha', () => {
    const data = buffer()
    compositeCapture(data, null)
    expect([...data]).toEqual([200, 0, 0, 255, 199, 0, 0, 128, 0, 0, 0, 0])
  })

  test('a background is laid under the picture, and the result is opaque', () => {
    const data = buffer()
    compositeCapture(data, [255, 255, 255])
    expect([...data.slice(0, 4)]).toEqual([200, 0, 0, 255])
    expect([...data.slice(4, 8)]).toEqual([227, 127, 127, 255])
    expect([...data.slice(8, 12)]).toEqual([255, 255, 255, 255])
  })
})
