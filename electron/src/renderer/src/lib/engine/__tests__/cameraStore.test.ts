import { beforeEach, describe, expect, test } from 'vitest'
import {
  camerasForPath,
  clearCameras,
  hydrateCameras,
  loadCamera,
  retargetCameras,
  saveCamera
} from '../cameraStore'

const state = (zoom: number): { x: number; y: number; zoom: number } => ({ x: 0, y: 0, zoom })

describe('cameraStore', () => {
  beforeEach(() => clearCameras())

  test('remembers a camera per key', () => {
    saveCamera('a.kicad_mod', state(2))
    saveCamera('b.kicad_mod', state(4))
    expect(loadCamera('a.kicad_mod')?.zoom).toBe(2)
    expect(loadCamera('b.kicad_mod')?.zoom).toBe(4)
    expect(loadCamera('never-opened')).toBeUndefined()
  })

  test('a re-save replaces rather than accumulating', () => {
    saveCamera('a', state(1))
    saveCamera('a', state(9))
    expect(loadCamera('a')?.zoom).toBe(9)
  })

  test('evicts the least recently written past the cap', () => {
    for (let i = 0; i < 100; i++) saveCamera(`f${i}`, state(i))
    expect(loadCamera('f0')?.zoom).toBe(0)

    saveCamera('overflow', state(-1))
    expect(loadCamera('f0')).toBeUndefined()
    expect(loadCamera('f1')?.zoom).toBe(1)
    expect(loadCamera('overflow')?.zoom).toBe(-1)
  })

  test('retargeting carries every unit of a renamed subject across', () => {
    saveCamera('lib.kicad_sym::R_Small::1', state(3))
    saveCamera('lib.kicad_sym::R_Small::2', state(5))
    saveCamera('lib.kicad_sym::C_Small::1', state(7))

    retargetCameras('lib.kicad_sym::R_Small::', 'lib.kicad_sym::R_Tiny::')

    expect(loadCamera('lib.kicad_sym::R_Tiny::1')?.zoom).toBe(3)
    expect(loadCamera('lib.kicad_sym::R_Tiny::2')?.zoom).toBe(5)
    expect(loadCamera('lib.kicad_sym::R_Small::1')).toBeUndefined()
    // A subject that was not renamed keeps its own framing.
    expect(loadCamera('lib.kicad_sym::C_Small::1')?.zoom).toBe(7)
  })

  test('retargeting onto itself is a no-op, and an unframed subject moves nothing', () => {
    saveCamera('lib::R::1', state(2))
    retargetCameras('lib::R::', 'lib::R::')
    retargetCameras('lib::Absent::', 'lib::Other::')
    expect(loadCamera('lib::R::1')?.zoom).toBe(2)
    expect(loadCamera('lib::Other::1')).toBeUndefined()
  })

  test('re-saving refreshes recency, so an active document is not evicted', () => {
    for (let i = 0; i < 100; i++) saveCamera(`f${i}`, state(i))
    saveCamera('f0', state(42))

    saveCamera('overflow', state(-1))
    expect(loadCamera('f0')?.zoom).toBe(42)
    expect(loadCamera('f1')).toBeUndefined()
  })
})

describe('carrying cameras on the window session', () => {
  beforeEach(() => clearCameras())

  test('gathers every camera a tab owns, keyed by what follows its path', () => {
    saveCamera('/w/a.kicad_pcb', { x: 1, y: 2, zoom: 3 })
    saveCamera('/w/lib.kicad_sym::R::1', { x: 4, y: 5, zoom: 6 })
    saveCamera('/w/lib.kicad_sym::R::2', { x: 7, y: 8, zoom: 9 })
    saveCamera('/w/other.kicad_pcb', { x: 0, y: 0, zoom: 1 })

    expect(camerasForPath('/w/a.kicad_pcb')).toEqual({ '': { x: 1, y: 2, zoom: 3 } })
    expect(camerasForPath('/w/lib.kicad_sym')).toEqual({
      '::R::1': { x: 4, y: 5, zoom: 6 },
      '::R::2': { x: 7, y: 8, zoom: 9 }
    })
    expect(camerasForPath('/w/never-opened.kicad_pcb')).toBeUndefined()
  })

  test('puts a restored tab back where it was', () => {
    hydrateCameras('/w/a.kicad_pcb', { '': { x: 1, y: 2, zoom: 3 } })
    expect(loadCamera('/w/a.kicad_pcb')).toEqual({ x: 1, y: 2, zoom: 3 })
  })

  test('never displaces a camera already in hand', () => {
    saveCamera('/w/a.kicad_pcb', { x: 9, y: 9, zoom: 9 })
    hydrateCameras('/w/a.kicad_pcb', { '': { x: 1, y: 2, zoom: 3 } })
    expect(loadCamera('/w/a.kicad_pcb')).toEqual({ x: 9, y: 9, zoom: 9 })
  })

  test('refuses a framing that could not show anything', () => {
    hydrateCameras('/w/a.kicad_pcb', {
      '::zero': { x: 0, y: 0, zoom: 0 },
      '::inf': { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 }
    })
    expect(loadCamera('/w/a.kicad_pcb::zero')).toBeUndefined()
    expect(loadCamera('/w/a.kicad_pcb::inf')).toBeUndefined()
  })
})
