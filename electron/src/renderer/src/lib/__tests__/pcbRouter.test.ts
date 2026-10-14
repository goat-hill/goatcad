import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  commitsViolations,
  defaultPcbRouterState,
  dragCorner,
  nextRouterCorner,
  nextRouterMode,
  pcbRouterState,
  routeCorner,
  routerSettings,
  setPcbRouter,
  __resetPcbRouterStore,
  type PcbRouterState
} from '../pcbRouter'
import { defaultPcbRouter } from '../../../../main/appConfig'

describe('the default router settings', () => {
  test('Walkaround, KiCad’s default mode', () => {
    expect(defaultPcbRouterState()).toEqual({ mode: 'walkaround' })
  })

  test('agree with the main-process defaults', () => {
    // Two copies by necessity: the main process cannot import the renderer,
    // and it owns the persisted value.
    expect(defaultPcbRouterState()).toEqual(defaultPcbRouter())
  })

  test('KiCad’s defaults for the Highlight switches', () => {
    expect(routerSettings({ mode: 'highlight' })).toMatchObject({
      allowViolations: false,
      freeAngle: false
    })
  })
})

describe('the mode cycle', () => {
  test('steps shove → walkaround → highlight → shove', () => {
    expect(nextRouterMode('shove')).toBe('walkaround')
    expect(nextRouterMode('walkaround')).toBe('highlight')
    expect(nextRouterMode('highlight')).toBe('shove')
  })
})

describe('Allow DRC violations (R19)', () => {
  const allowed = (mode: PcbRouterState['mode']): PcbRouterState => ({
    mode,
    settings: { allowViolations: true }
  })

  test('commits violations only in Highlight, as KiCad reads it', () => {
    expect(commitsViolations(allowed('highlight'))).toBe(true)
    expect(commitsViolations(allowed('shove'))).toBe(false)
    expect(commitsViolations(allowed('walkaround'))).toBe(false)
    expect(commitsViolations({ mode: 'highlight' })).toBe(false)
  })
})

describe('the corner mode (R3)', () => {
  test('Ctrl+/ steps 45°, rounded 45°, 90°, rounded 90°, as KiCad’s', () => {
    expect(nextRouterCorner('45')).toBe('arc45')
    expect(nextRouterCorner('arc45')).toBe('90')
    expect(nextRouterCorner('90')).toBe('arc90')
    expect(nextRouterCorner('arc90')).toBe('45')
  })

  test('a route draws its angle, rounded in the arc modes', () => {
    expect(routeCorner({ mode: 'shove' })).toEqual({ cornerMode: '45', rounded: false })
    expect(routeCorner({ mode: 'shove', corner: 'arc90' })).toEqual({
      cornerMode: '90',
      rounded: true
    })
  })

  test('Free angle mode takes effect only in Highlight', () => {
    const free = { settings: { freeAngle: true }, corner: 'arc45' as const }
    expect(routeCorner({ mode: 'highlight', ...free })).toEqual({
      cornerMode: 'free',
      rounded: false
    })
    expect(routeCorner({ mode: 'walkaround', ...free })).toEqual({
      cornerMode: '45',
      rounded: true
    })
  })

  test('a drag takes the angle, never free', () => {
    expect(dragCorner({ mode: 'highlight', corner: 'arc90', settings: { freeAngle: true } })).toBe(
      '90'
    )
  })
})

// No `window.api` in the suite, so the store degrades to in-memory.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetPcbRouterStore())

  test('reads defaults before anything is written', () => {
    expect(pcbRouterState().value).toEqual(defaultPcbRouterState())
  })

  test('a patch changes only what it names', () => {
    const state = pcbRouterState()
    setPcbRouter({ mode: 'highlight' })
    expect(state.value).toEqual({ mode: 'highlight' })
  })
})

describe('the shared store with a config bridge', () => {
  const sent: unknown[] = []
  beforeEach(() => {
    sent.length = 0
    // IPC structured-clones its payload, and a Vue proxy cannot be cloned.
    ;(globalThis as { window?: unknown }).window = {
      api: {
        getConfig: () => new Promise(() => {}),
        onConfigChanged: () => {},
        updateConfig: (patch: unknown) => {
          sent.push(structuredClone(patch))
          return Promise.resolve()
        }
      }
    }
    __resetPcbRouterStore()
  })
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
    __resetPcbRouterStore()
  })

  test('persists plain data, the nested settings included', () => {
    // The settings are a nested object the store holds: sent as it reads back,
    // a proxy, the next change would throw before it lands.
    setPcbRouter({ settings: { shoveVias: true } })
    expect(() => setPcbRouter({ mode: 'shove' })).not.toThrow()
    expect(sent.at(-1)).toMatchObject({
      pcbRouter: { mode: 'shove', settings: { shoveVias: true } }
    })
  })
})
