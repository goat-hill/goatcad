import { beforeEach, describe, expect, test } from 'vitest'
import {
  defaultFootprintViewState,
  footprintViewState,
  setFootprintView,
  FOOTPRINT_LAYERS,
  __resetFootprintViewStore
} from '../footprintView'
import {
  defaultFootprintView,
  normalizeFootprintView,
  FOOTPRINT_LAYERS as MAIN_FOOTPRINT_LAYERS
} from '../../../../main/appConfig'

describe('the default view', () => {
  test('draws every layer, with silkscreen active', () => {
    const defaults = defaultFootprintViewState()
    expect(Object.values(defaults.layerVisibility).every(Boolean)).toBe(true)
    expect(defaults.activeLayer).toBe('F.SilkS')
    expect(defaults.nonActiveDisplay).toBe('show')
  })

  test('agrees with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer,
    // and it owns the persisted value.
    expect(defaultFootprintViewState()).toEqual(defaultFootprintView())
    expect([...FOOTPRINT_LAYERS]).toEqual([...MAIN_FOOTPRINT_LAYERS])
  })
})

// No `window.api` in the suite, so the store degrades to in-memory.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetFootprintViewStore())

  test('reads defaults before anything is written', () => {
    expect(footprintViewState().value).toEqual(defaultFootprintViewState())
  })

  test('a patch changes only what it names', () => {
    const state = footprintViewState()
    setFootprintView({ activeLayer: 'F.Cu' })
    expect(state.value.activeLayer).toBe('F.Cu')
    expect(state.value.nonActiveDisplay).toBe('show')
    expect(state.value.layerVisibility['F.Fab']).toBe(true)
  })
})

describe('normalizeFootprintView', () => {
  test('a partial or garbage value keeps its valid keys and defaults the rest', () => {
    expect(normalizeFootprintView(undefined)).toEqual(defaultFootprintView())
    expect(normalizeFootprintView('nope')).toEqual(defaultFootprintView())
    expect(normalizeFootprintView({ nonActiveDisplay: 'dim' })).toEqual({
      ...defaultFootprintView(),
      nonActiveDisplay: 'dim'
    })
  })

  test('keeps the sketch switches, defaulting a non-boolean one', () => {
    expect(normalizeFootprintView({ sketchPads: true, sketchText: 'yes' })).toEqual({
      ...defaultFootprintView(),
      sketchPads: true
    })
  })

  test('drops an unknown layer and an active layer that is not one', () => {
    const normalized = normalizeFootprintView({
      layerVisibility: { 'F.Cu': false, 'In7.Cu': false },
      activeLayer: 'In7.Cu'
    })
    expect(normalized.layerVisibility['In7.Cu']).toBeUndefined()
    expect(normalized.layerVisibility['F.Cu']).toBe(false)
    expect(normalized.activeLayer).toBe('F.SilkS')
  })

  test('drops an inactive-layer mode it does not recognize', () => {
    expect(normalizeFootprintView({ nonActiveDisplay: 'ghost' }).nonActiveDisplay).toBe('show')
  })
})
