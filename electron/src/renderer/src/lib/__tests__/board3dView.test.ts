import { beforeEach, describe, expect, test } from 'vitest'
import {
  board3dPresentation,
  defaultBoard3DPresentation,
  board3dViewState,
  defaultBoard3DViewState,
  isDefaultBoard3DPresentation,
  isDefaultBoard3DView,
  resetBoard3DPresentation,
  resetBoard3DView,
  setBoard3DPresentation,
  setBoard3DView,
  __resetBoard3DViewStore
} from '../board3dView'
import {
  defaultBoard3DPresentation as mainBoard3DPresentation,
  defaultBoard3DView
} from '../../../../main/appConfig'

describe('the default view', () => {
  test('shows the board as manufactured, minus annotation and unfitted parts', () => {
    const defaults = defaultBoard3DViewState()
    // Everything physical is on…
    expect(defaults.boardBody).toBe(true)
    expect(defaults.copper).toBe(true)
    expect(defaults.solderMask).toBe(true)
    expect(defaults.solderPaste).toBe(true)
    expect(defaults.silkscreen).toBe(true)
    expect(defaults.holes).toBe(true)
    expect(defaults.models).toBe(true)
    // …and the two things that are not part of the finished board are off.
    expect(defaults.drawings).toBe(false)
    expect(defaults.modelsDnp).toBe(false)
    expect(defaults.axes).toBe(false)
    expect(isDefaultBoard3DView(defaults)).toBe(true)
  })

  test('agrees with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer, and
    // it owns the persisted value. A drift here would mean a fresh install and
    // a fresh window disagree about what the view shows.
    expect(defaultBoard3DViewState()).toEqual(defaultBoard3DView())
  })
})

// No `window.api` in the suite, so the store degrades to in-memory — the same
// behavior a non-Electron host gets.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetBoard3DViewStore())

  test('reads defaults before anything is written', () => {
    expect(board3dViewState().value).toEqual(defaultBoard3DViewState())
  })

  test('a patch changes only the switches it names', () => {
    const state = board3dViewState()
    setBoard3DView({ silkscreen: false, drawings: true })
    expect(state.value.silkscreen).toBe(false)
    expect(state.value.drawings).toBe(true)
    expect(state.value.copper).toBe(true)
    expect(isDefaultBoard3DView(state.value)).toBe(false)
  })

  test('presentation changes a setting at a time and is not a switch to reset', () => {
    const shown = board3dPresentation()
    expect(shown.value).toEqual(defaultBoard3DPresentation())
    setBoard3DPresentation({ background: 'white' })
    setBoard3DPresentation({ projection: 'orthographic' })
    expect(shown.value).toEqual({
      projection: 'orthographic',
      lighting: 'studio',
      exposure: 1,
      background: 'white'
    })
    resetBoard3DView()
    expect(shown.value.background).toBe('white')
    expect(isDefaultBoard3DPresentation(shown.value)).toBe(false)
    resetBoard3DPresentation()
    expect(shown.value).toEqual(defaultBoard3DPresentation())
    expect(isDefaultBoard3DPresentation(shown.value)).toBe(true)
  })

  test('the presentation defaults agree with the main process', () => {
    expect(defaultBoard3DPresentation()).toEqual(mainBoard3DPresentation())
  })

  test('reset puts every switch back', () => {
    const state = board3dViewState()
    setBoard3DView({ boardBody: false, modelsDnp: true })
    resetBoard3DView()
    expect(state.value).toEqual(defaultBoard3DViewState())
    expect(isDefaultBoard3DView(state.value)).toBe(true)
  })
})
