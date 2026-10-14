import { beforeEach, describe, expect, test } from 'vitest'
import {
  defaultSymbolViewState,
  setSymbolView,
  symbolViewState,
  __resetSymbolViewStore
} from '../symbolView'
import { defaultSymbolView } from '../../../../main/appConfig'

describe('the default symbol view', () => {
  test('draws hidden pins and fields', () => {
    // The editor must open showing the whole symbol: a pin drawn on top of a
    // hidden one you were never shown is an edit made blind.
    const defaults = defaultSymbolViewState()
    expect(defaults.showHiddenPins).toBe(true)
    expect(defaults.showHiddenFields).toBe(true)
  })

  test('agrees with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer, and
    // it owns the persisted value.
    expect(defaultSymbolViewState()).toEqual(defaultSymbolView())
  })
})

// No `window.api` in the suite, so the store degrades to in-memory — the same
// behavior a non-Electron host gets.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetSymbolViewStore())

  test('reads defaults before anything is written', () => {
    expect(symbolViewState().value).toEqual(defaultSymbolViewState())
  })

  test('a patch changes only the switch it names', () => {
    const state = symbolViewState()
    setSymbolView({ showHiddenPins: false })
    expect(state.value.showHiddenPins).toBe(false)
    expect(state.value.showHiddenFields).toBe(true)
  })
})
