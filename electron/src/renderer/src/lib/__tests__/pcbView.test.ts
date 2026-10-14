import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick, watch } from 'vue'
import {
  defaultPcbViewState,
  loadPcbView,
  pcbViewState,
  setPcbView,
  __resetPcbViewStore
} from '../pcbView'
import { defaultPcbView, normalizePcbView } from '../../../../main/appConfig'

describe('the default view', () => {
  test('draws copper solid with fills on', () => {
    const defaults = defaultPcbViewState()
    expect(defaults.zoneFills).toBe(true)
    expect(defaults.sketchTracks).toBe(false)
    expect(defaults.sketchVias).toBe(false)
    expect(defaults.sketchPads).toBe(false)
    expect(defaults.ratsnest).toBe(true)
  })

  test("shows clearance as KiCad's defaults do", () => {
    const defaults = defaultPcbViewState()
    expect(defaults.padClearance).toBe(true)
    expect(defaults.trackClearance).toBe('routing')
  })

  test('agrees with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer,
    // and it owns the persisted value.
    expect(defaultPcbViewState()).toEqual(defaultPcbView())
  })
})

// No `window.api` in the suite, so the store degrades to in-memory.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetPcbViewStore())

  test('reads defaults before anything is written', () => {
    expect(pcbViewState().value).toEqual(defaultPcbViewState())
  })

  test('a patch changes only the switches it names', () => {
    const state = pcbViewState()
    setPcbView({ sketchTracks: true, zoneFills: false })
    expect(state.value.sketchTracks).toBe(true)
    expect(state.value.zoneFills).toBe(false)
    expect(state.value.sketchPads).toBe(false)
  })
})

describe('a loaded mode this build does not offer', () => {
  test('falls back to the default', async () => {
    __resetPcbViewStore()
    const listeners: Array<(config: { pcbView: unknown }) => void> = []
    const bridge = {
      getConfig: () => Promise.resolve({ pcbView: { trackClearance: 'routingWithVia' } }),
      onConfigChanged: (cb: (config: { pcbView: unknown }) => void) => listeners.push(cb),
      updateConfig: () => Promise.resolve()
    }
    vi.stubGlobal('window', { api: bridge })
    try {
      await loadPcbView()
      expect(pcbViewState().value.trackClearance).toBe(defaultPcbViewState().trackClearance)
    } finally {
      vi.unstubAllGlobals()
      __resetPcbViewStore()
    }
  })
})

describe('a config broadcast that leaves the view as it was', () => {
  test('does not read as a change of view', async () => {
    __resetPcbViewStore()
    const saved = { ...defaultPcbViewState(), fpValues: false }
    const listeners: Array<(config: { pcbView: unknown }) => void> = []
    vi.stubGlobal('window', {
      api: {
        getConfig: () => Promise.resolve({ pcbView: saved }),
        onConfigChanged: (cb: (config: { pcbView: unknown }) => void) => listeners.push(cb),
        updateConfig: () => Promise.resolve()
      }
    })
    try {
      await loadPcbView()
      const state = pcbViewState()
      let changes = 0
      watch(state, () => changes++, { deep: true })
      // Another setting changed (a selection filter toggle): the whole config arrives again.
      for (const listener of listeners) listener({ pcbView: { ...saved } })
      await nextTick()
      expect(changes).toBe(0)
      for (const listener of listeners) listener({ pcbView: { ...saved, fpValues: true } })
      await nextTick()
      expect(changes).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      __resetPcbViewStore()
    }
  })
})

describe('normalizePcbView', () => {
  test('a partial or garbage value keeps its valid keys and defaults the rest', () => {
    expect(normalizePcbView(undefined)).toEqual(defaultPcbView())
    expect(normalizePcbView('nope')).toEqual(defaultPcbView())
    expect(normalizePcbView({ sketchVias: true, zoneFills: 'yes' })).toEqual({
      ...defaultPcbView(),
      sketchVias: true
    })
  })

  test('keeps a known track clearance display and drops an unknown one', () => {
    expect(normalizePcbView({ trackClearance: 'always' }).trackClearance).toBe('always')
    expect(normalizePcbView({ trackClearance: 'sometimes' }).trackClearance).toBe(
      defaultPcbView().trackClearance
    )
  })
})
