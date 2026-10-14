import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PartsFilterState } from '../../../../preload/partsTypes'
import {
  applyPartsFilters,
  appliedQuery,
  filters,
  mode,
  pendingFilters,
  pendingSearchWithin,
  query,
  result,
  runPartsSearch,
  searching
} from '../partsSearch'
import { emptyFilterState } from '../partsFilter'

/**
 * The store's apply path, end to end up to the bridge.
 *
 * Written because "Apply did not change the results" has now had two distinct
 * causes — a reactive proxy that failed to clone, and a mis-named request key —
 * and neither was visible from the outside. This asserts the one thing the UI
 * cannot show: that the filters the user ticked actually reach `window.api`.
 */
const calls: Array<{ keyword: string; filters?: PartsFilterState; categoryId?: number }> = []

const emptyResult = {
  parts: [],
  total: 0,
  facets: { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }
}

beforeEach(() => {
  calls.length = 0
  mode.value = 'digikey'
  query.value = ''
  filters.value = emptyFilterState()
  pendingFilters.value = emptyFilterState()
  pendingSearchWithin.value = ''
  result.value = null
  appliedQuery.value = ''
  searching.value = false

  vi.stubGlobal('window', {
    api: {
      partsSearch: (
        _provider: string,
        keyword: string,
        _limit: number,
        _offset: number,
        categoryId: number | undefined,
        filterState: PartsFilterState
      ) => {
        calls.push({ keyword, filters: filterState, categoryId })
        return Promise.resolve({ ok: true, value: emptyResult })
      },
      partsSearchAll: (keyword: string, _limit: unknown, filterState: PartsFilterState) => {
        calls.push({ keyword, filters: filterState })
        return Promise.resolve({ groups: [], facets: emptyResult.facets, providers: [] })
      },
      partsImage: () => Promise.resolve(null)
    }
  })
})

describe('applying filters', () => {
  it('sends the ticked filters to the bridge', async () => {
    query.value = 'stm32'
    await runPartsSearch()
    expect(calls).toHaveLength(1)
    expect(calls[0].filters?.inStock).toBe(false)

    pendingFilters.value = { ...emptyFilterState(), inStock: true, manufacturerIds: ['296'] }
    await applyPartsFilters()

    expect(calls).toHaveLength(2)
    expect(calls[1].filters?.inStock).toBe(true)
    expect(calls[1].filters?.manufacturerIds).toEqual(['296'])
  })

  it('sends a plain object, not the reactive proxy', async () => {
    query.value = 'stm32'
    await runPartsSearch()
    pendingFilters.value = { ...emptyFilterState(), rohs: true }
    await applyPartsFilters()

    // A Vue proxy has no structured clone, and Electron clones every IPC
    // argument — this is the failure that once rendered as an empty screen.
    expect(() => structuredClone(calls[1].filters)).not.toThrow()
  })

  it('records the applied state, so the chips can report it', async () => {
    query.value = 'stm32'
    await runPartsSearch()
    pendingFilters.value = { ...emptyFilterState(), rohs: true }
    await applyPartsFilters()

    expect(filters.value.rohs).toBe(true)
  })

  it('appends search-within to the query rather than replacing it', async () => {
    query.value = 'stm32'
    await runPartsSearch()
    pendingSearchWithin.value = 'lqfp'
    await applyPartsFilters()

    expect(calls[1].keyword).toBe('stm32 lqfp')
  })

  it('carries filters through universal mode too', async () => {
    mode.value = 'universal'
    query.value = 'stm32'
    await runPartsSearch()
    pendingFilters.value = { ...emptyFilterState(), inStock: true }
    await applyPartsFilters()

    expect(calls[1].filters?.inStock).toBe(true)
  })

  it('does nothing while a search is already running', async () => {
    // The guard that would silently swallow an Apply if `searching` ever stuck.
    query.value = 'stm32'
    await runPartsSearch()
    searching.value = true
    pendingFilters.value = { ...emptyFilterState(), inStock: true }
    await applyPartsFilters()

    expect(calls).toHaveLength(1)
  })

  /**
   * The applied chips describe what produced the results on screen. Bound to the
   * live box instead, a chip appears letter by letter and claims a narrowing
   * that has not been requested.
   */
  it('does not treat typing as an applied query until a search runs', async () => {
    query.value = 'stm32'
    expect(appliedQuery.value).toBe('')

    await runPartsSearch()
    expect(appliedQuery.value).toBe('stm32')

    // Still the applied one while the next query is only being typed.
    query.value = 'lm358'
    expect(appliedQuery.value).toBe('stm32')

    await runPartsSearch()
    expect(appliedQuery.value).toBe('lm358')
  })

  it('starts a new query fresh rather than on top of the applied filters', async () => {
    query.value = 'stm32'
    await runPartsSearch()
    pendingFilters.value = { ...emptyFilterState(), inStock: true }
    await applyPartsFilters()
    expect(calls[1].filters?.inStock).toBe(true)

    // Enter in the top bar is a new question, not a further narrowing of the
    // old one — the previous search's filters must not ride along.
    query.value = 'lm358'
    await runPartsSearch()
    expect(calls[2].keyword).toBe('lm358')
    expect(calls[2].filters?.inStock).toBe(false)
    expect(filters.value).toEqual(emptyFilterState())
  })
})
