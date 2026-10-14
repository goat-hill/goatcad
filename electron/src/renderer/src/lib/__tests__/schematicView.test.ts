import { beforeEach, describe, expect, test } from 'vitest'
import {
  defaultSchematicViewState,
  schematicViewState,
  setSchematicView,
  __resetSchematicViewStore
} from '../schematicView'
import { defaultSchematicView } from '../../../../main/appConfig'

describe('the default schematic view', () => {
  test('highlights the net under the pointer', () => {
    expect(defaultSchematicViewState().netHighlight).toBe(true)
  })

  test('agrees with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer, and
    // it owns the persisted value.
    expect(defaultSchematicViewState()).toEqual(defaultSchematicView())
  })
})

// No `window.api` in the suite, so the store degrades to in-memory — the same
// behavior a non-Electron host gets.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetSchematicViewStore())

  test('reads defaults before anything is written', () => {
    expect(schematicViewState().value).toEqual(defaultSchematicViewState())
  })

  test('a patch turns the highlight off, and a reset brings the default back', () => {
    const state = schematicViewState()
    setSchematicView({ netHighlight: false })
    expect(state.value.netHighlight).toBe(false)
    __resetSchematicViewStore()
    expect(state.value.netHighlight).toBe(true)
  })

  test('the hidden pins and fields switches start off and change one at a time', () => {
    const state = schematicViewState()
    expect(state.value.showHiddenPins).toBe(false)
    expect(state.value.showHiddenFields).toBe(false)
    setSchematicView({ showHiddenPins: true })
    expect(state.value).toEqual({
      netHighlight: true,
      showHiddenPins: true,
      showHiddenFields: false
    })
    setSchematicView({ showHiddenFields: true })
    expect(state.value.showHiddenFields).toBe(true)
    expect(state.value.showHiddenPins).toBe(true)
  })
})
