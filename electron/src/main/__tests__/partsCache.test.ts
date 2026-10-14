import { describe, it, expect } from 'vitest'
import { PartsCache, RESULT_TTL_MS, searchKey } from '../partsCache'
import type { PartRecord } from '../../preload/partsTypes'

const record = (mpn: string): PartRecord => ({
  provider: 'mouser',
  providerPartId: `mouser-${mpn}`,
  mpn,
  manufacturer: 'Acme',
  description: 'a part',
  datasheetUrl: null,
  photoUrl: null,
  productUrl: null,
  lifecycle: 'active',
  rohs: null,
  parameters: [],
  offers: [],
  cad: { mode: 'none' },
  fetchedAt: 0
})

const FACETS = { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }

const clock = (start: number): { now: () => number; advance: (ms: number) => void } => {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

describe('searchKey', () => {
  it('folds case and whitespace so equivalent queries share an entry', () => {
    expect(searchKey('mouser', '  ESP32   S3 ', 20, 0)).toBe(searchKey('mouser', 'esp32 s3', 20, 0))
  })

  it('keeps different pages and providers apart', () => {
    expect(searchKey('mouser', 'x', 20, 0)).not.toBe(searchKey('mouser', 'x', 20, 20))
    expect(searchKey('mouser', 'x', 20, 0)).not.toBe(searchKey('digikey', 'x', 20, 0))
  })
})

describe('PartsCache', () => {
  it('serves a result that is still on screen', () => {
    const time = clock(1_000)
    const cache = new PartsCache(time.now)
    cache.put(record('R1'))
    expect(cache.get('mouser', 'mouser-R1')?.mpn).toBe('R1')
  })

  it('lets a result expire rather than accumulating', () => {
    const time = clock(1_000)
    const cache = new PartsCache(time.now)
    cache.put(record('R1'))

    time.advance(RESULT_TTL_MS + 1)
    expect(cache.get('mouser', 'mouser-R1')).toBeNull()
  })

  it('makes re-running the same search free', () => {
    const time = clock(1_000)
    const cache = new PartsCache(time.now)
    const key = searchKey('mouser', 'esp32', 20, 0)
    const stored = { parts: [record('R1'), record('R2')], total: 42, facets: FACETS }
    cache.putSearch(key, stored)

    expect(cache.getSearch(key)).toEqual(stored)
    // Every part in a result set stays individually addressable.
    expect(cache.get('mouser', 'mouser-R2')?.mpn).toBe('R2')
  })

  it('expires a stored search on the same clock', () => {
    const time = clock(1_000)
    const cache = new PartsCache(time.now)
    const key = searchKey('mouser', 'esp32', 20, 0)
    cache.putSearch(key, { parts: [record('R1')], total: 1, facets: FACETS })

    time.advance(RESULT_TTL_MS + 1)
    expect(cache.getSearch(key)).toBeNull()
  })
})
