import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import {
  emptyFilterState,
  filterCapabilities,
  filtersEqual,
  isFilterActive,
  describeAppliedFilters,
  labelKey,
  matchFacetOptions,
  parameterScope,
  removeAppliedFilter,
  toggleParameter,
  toggleValue,
  toPlainFilters
} from '../partsFilter'

describe('isFilterActive', () => {
  it('is false only for a wholly empty state', () => {
    expect(isFilterActive(emptyFilterState())).toBe(false)
    expect(isFilterActive({ ...emptyFilterState(), inStock: true })).toBe(true)
    expect(isFilterActive({ ...emptyFilterState(), manufacturerIds: ['296'] })).toBe(true)
    expect(isFilterActive({ ...emptyFilterState(), parameters: { 2049: ['0.1 uF'] } })).toBe(true)
  })

  it('ignores a parameter entry left with no values', () => {
    expect(isFilterActive({ ...emptyFilterState(), parameters: { 2049: [] } })).toBe(false)
  })
})

describe('filtersEqual', () => {
  // Drives whether Apply is offered, so it must not report a difference that
  // would produce an identical request — that would spend a call for nothing.
  it('ignores ordering within a multi-select', () => {
    const a = { ...emptyFilterState(), manufacturerIds: ['296', '511'] }
    const b = { ...emptyFilterState(), manufacturerIds: ['511', '296'] }
    expect(filtersEqual(a, b)).toBe(true)
  })

  it('ignores a parameter entry emptied back out', () => {
    const a = emptyFilterState()
    const b = { ...emptyFilterState(), parameters: { 2049: [] } }
    expect(filtersEqual(a, b)).toBe(true)
  })

  it('sees a real change', () => {
    expect(filtersEqual(emptyFilterState(), { ...emptyFilterState(), rohs: true })).toBe(false)
    expect(
      filtersEqual(
        { ...emptyFilterState(), parameters: { 2049: ['0.1 uF'] } },
        { ...emptyFilterState(), parameters: { 2049: ['1 uF'] } }
      )
    ).toBe(false)
  })
})

describe('toggleParameter', () => {
  it('adds a value under its parameter', () => {
    expect(toggleParameter({}, 2049, '0.1 uF')).toEqual({ 2049: ['0.1 uF'] })
  })

  it('removes the parameter entirely once its last value goes', () => {
    // Leaving an empty array behind would make filtersEqual report a change
    // that produces the same request.
    expect(toggleParameter({ 2049: ['0.1 uF'] }, 2049, '0.1 uF')).toEqual({})
  })

  it('leaves other parameters alone', () => {
    const before = { 2049: ['0.1 uF'], 1989: ['0402'] }
    expect(toggleParameter(before, 2049, '1 uF')).toEqual({
      2049: ['0.1 uF', '1 uF'],
      1989: ['0402']
    })
  })
})

describe('filterCapabilities', () => {
  it('limits Universal to what both APIs implement', () => {
    // Anything more would apply to one distributor and silently not the other.
    const caps = filterCapabilities('universal')
    expect(caps).toEqual({ basics: true, digikeyOptions: false, facets: false })
  })

  it('gives DigiKey its facets, and Mouser only the basics', () => {
    expect(filterCapabilities('digikey')).toEqual({
      basics: true,
      digikeyOptions: true,
      facets: true
    })
    expect(filterCapabilities('mouser')).toEqual({
      basics: true,
      digikeyOptions: false,
      facets: false
    })
  })
})

describe('toggleValue', () => {
  it('adds and removes', () => {
    expect(toggleValue<string>([], 'a')).toEqual(['a'])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('toPlainFilters', () => {
  // Electron structured-clones every IPC argument and a Vue Proxy has no clone,
  // so passing reactive state straight through rejects the invoke — which
  // renders as a search that silently returns nothing.
  it('returns a structured-cloneable copy of reactive state', () => {
    const state = reactive({
      ...emptyFilterState(),
      manufacturerIds: ['296'],
      parameters: { 2049: ['0.1 uF'] }
    })
    const plain = toPlainFilters(state)

    expect(() => structuredClone(plain)).not.toThrow()
    expect(plain).toEqual({
      inStock: false,
      rohs: false,
      hasDatasheet: false,
      has3dModel: false,
      manufacturerIds: ['296'],
      packagingIds: [],
      statusIds: [],
      seriesIds: [],
      parameters: { 2049: ['0.1 uF'] }
    })
  })

  it('copies the nested arrays rather than aliasing them', () => {
    const state = reactive({ ...emptyFilterState(), manufacturerIds: ['296'] })
    const plain = toPlainFilters(state)
    state.manufacturerIds.push('511')
    expect(plain.manufacturerIds).toEqual(['296'])
  })
})

describe('matchFacetOptions', () => {
  const value = (
    id: string,
    label: string
  ): { id: string; label: string; productCount: number } => ({
    id,
    label,
    productCount: 1
  })
  const OPTIONS = [
    value('296', 'Texas Instruments'),
    value('511', 'STMicroelectronics'),
    value('1', 'Vishay')
  ]

  it('returns everything for an empty search', () => {
    expect(matchFacetOptions(OPTIONS, '', [])).toHaveLength(3)
    expect(matchFacetOptions(OPTIONS, '   ', [])).toHaveLength(3)
  })

  it('matches anywhere in the label, case-insensitively', () => {
    expect(matchFacetOptions(OPTIONS, 'instr', []).map((o) => o.id)).toEqual(['296'])
    expect(matchFacetOptions(OPTIONS, 'ELECTRO', []).map((o) => o.id)).toEqual(['511'])
  })

  it('never hides a selected option', () => {
    // A ticked box that disappears is a filter the user cannot see or undo.
    expect(matchFacetOptions(OPTIONS, 'vishay', ['296']).map((o) => o.id)).toEqual(['296', '1'])
  })

  it('preserves order, so a group does not reshuffle as you type', () => {
    expect(matchFacetOptions(OPTIONS, 's', []).map((o) => o.id)).toEqual(['296', '511', '1'])
  })

  it('returns an empty list when nothing matches and nothing is selected', () => {
    expect(matchFacetOptions(OPTIONS, 'zzz', [])).toEqual([])
  })
})

describe('describeAppliedFilters', () => {
  it('lists nothing for an empty state', () => {
    expect(describeAppliedFilters(emptyFilterState(), {})).toEqual([])
  })

  it('describes boolean filters without needing a captured label', () => {
    const chips = describeAppliedFilters({ ...emptyFilterState(), inStock: true, rohs: true }, {})
    expect(chips.map((c) => c.kind)).toEqual(['flag', 'flag'])
    expect(chips).toContainEqual({ key: 'flag:inStock', kind: 'flag', flag: 'inStock' })
  })

  it('uses the label captured when the box was ticked', () => {
    const chips = describeAppliedFilters(
      { ...emptyFilterState(), manufacturerIds: ['296'] },
      { [labelKey('manufacturerIds', '296')]: { label: 'Texas Instruments' } }
    )
    expect(chips[0]).toMatchObject({ kind: 'facet', id: '296', label: 'Texas Instruments' })
  })

  it('falls back to the raw id rather than rendering nothing', () => {
    // The case this exists for: the facet that supplied the label may not come
    // back, and a filter you cannot see is worse than an ugly one.
    const chips = describeAppliedFilters({ ...emptyFilterState(), manufacturerIds: ['296'] }, {})
    expect(chips[0]).toMatchObject({ label: '296' })
  })

  it('carries the parameter name so a value reads in context', () => {
    // "0.1 µF" alone says little; "Capacitance: 0.1 µF" says what was narrowed.
    const chips = describeAppliedFilters(
      { ...emptyFilterState(), parameters: { 2049: ['0.1 uF'] } },
      { [labelKey(parameterScope(2049), '0.1 uF')]: { label: '0.1 µF', group: 'Capacitance' } }
    )
    expect(chips[0]).toMatchObject({
      kind: 'parameter',
      parameterId: 2049,
      label: '0.1 µF',
      group: 'Capacitance'
    })
  })

  it('gives every chip a unique key', () => {
    const chips = describeAppliedFilters(
      {
        ...emptyFilterState(),
        inStock: true,
        manufacturerIds: ['296', '511'],
        seriesIds: ['296'],
        parameters: { 2049: ['0.1 uF'] }
      },
      {}
    )
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length)
  })
})

describe('removeAppliedFilter', () => {
  it('clears a boolean', () => {
    const state = { ...emptyFilterState(), inStock: true }
    const [chip] = describeAppliedFilters(state, {})
    expect(removeAppliedFilter(state, chip).inStock).toBe(false)
  })

  it('removes one facet value and leaves its siblings', () => {
    const state = { ...emptyFilterState(), manufacturerIds: ['296', '511'] }
    const chip = describeAppliedFilters(state, {}).find((c) => 'id' in c && c.id === '296')
    expect(removeAppliedFilter(state, chip!).manufacturerIds).toEqual(['511'])
  })

  it('removes a parameter value, dropping the parameter when it empties', () => {
    const state = { ...emptyFilterState(), parameters: { 2049: ['0.1 uF'] } }
    const [chip] = describeAppliedFilters(state, {})
    expect(removeAppliedFilter(state, chip).parameters).toEqual({})
  })

  it('does not confuse the same id in two dimensions', () => {
    // A manufacturer and a series can share an id; removing one must not remove
    // the other, which is why a chip carries its dimension.
    const state = { ...emptyFilterState(), manufacturerIds: ['296'], seriesIds: ['296'] }
    const chip = describeAppliedFilters(state, {}).find(
      (c) => c.kind === 'facet' && c.dimension === 'manufacturerIds'
    )
    const next = removeAppliedFilter(state, chip!)
    expect(next.manufacturerIds).toEqual([])
    expect(next.seriesIds).toEqual(['296'])
  })
})
