import { describe, expect, test } from 'vitest'
import { pairOpKeys, routeOpKeys, tuneOpKeys, type RouteHintContext } from '../routeHints'

const ctx = (over: Partial<RouteHintContext> = {}): RouteHintContext => ({
  live: true,
  state: 'clear',
  viaArmed: false,
  narrower: false,
  nearViaPad: false,
  echo: null,
  ...over
})

describe('routeOpKeys (K1–K4)', () => {
  test('a clear head leads with via, width and posture; the card holds every route key', () => {
    const keys = routeOpKeys(ctx())
    expect(keys.hint.slice(0, 3)).toEqual(['via', 'width', 'posture'])
    expect(keys.max).toBe(3)
    expect(keys.card).toEqual(keys.hint)
    expect(keys.card).toContain('layerPair')
  })

  test('before a route starts, nothing, but an echo', () => {
    expect(routeOpKeys(ctx({ live: false }))).toEqual({ hint: [], max: 3, card: [] })
    expect(routeOpKeys(ctx({ live: false, echo: 'pcb.viaSizeNext' })).hint).toEqual(['viaSize'])
  })

  test('blocked with a narrower width to try: Shift+W alone, standing for width', () => {
    const keys = routeOpKeys(ctx({ state: 'blocked', narrower: true }))
    expect(keys.hint[0]).toBe('narrower')
    expect(keys.max).toBe(1)
    expect(keys.hint).not.toContain('width')
    expect(keys.card).toContain('width')
    expect(routeOpKeys(ctx({ state: 'blocked' })).hint[0]).toBe('via')
  })

  test('near a pad of the net on another layer: V alone', () => {
    const keys = routeOpKeys(ctx({ nearViaPad: true, state: 'blocked', narrower: true }))
    expect(keys.hint[0]).toBe('via')
    expect(keys.max).toBe(1)
  })

  test('an armed via leads with its size and how to drop it, in place of stepping back', () => {
    const keys = routeOpKeys(ctx({ viaArmed: true }))
    expect(keys.hint.slice(0, 2)).toEqual(['viaSize', 'dropVia'])
    expect(keys.card).not.toContain('unroute')
  })

  test("an echo leads, after a moment's own key, and is not repeated", () => {
    const keys = routeOpKeys(ctx({ echo: 'pcb.trackWidthNext' }))
    expect(keys.hint.slice(0, 3)).toEqual(['width', 'via', 'posture'])
    expect(keys.hint.filter((r) => r === 'width')).toHaveLength(1)
    expect(
      routeOpKeys(ctx({ nearViaPad: true, echo: 'pcb.routeCorner' })).hint.slice(0, 2)
    ).toEqual(['via', 'corner'])
  })
})

describe('pairOpKeys (PR1–PR6)', () => {
  test('none until the pair starts, then more than fit: the card holds them all', () => {
    expect(pairOpKeys(false).hint).toEqual([])
    const keys = pairOpKeys(true)
    expect(keys.hint.length).toBeGreaterThan(keys.max)
    expect(keys.card).toEqual(keys.hint)
  })
})

describe('tuneOpKeys (T1)', () => {
  test('armed, none; a pattern in hand, spacing and amplitude, which fit', () => {
    expect(tuneOpKeys({ live: false, short: false }).hint).toEqual([])
    expect(tuneOpKeys({ live: true, short: false }).hint).toEqual(['spacing', 'amplitude'])
  })

  test('short of the target: the keys that add length', () => {
    expect(tuneOpKeys({ live: true, short: true }).hint).toEqual(['tighter', 'taller'])
  })
})
