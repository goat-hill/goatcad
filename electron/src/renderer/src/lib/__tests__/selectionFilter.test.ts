import { beforeEach, describe, expect, test } from 'vitest'
import {
  allKindsAllowed,
  allowsHitFor,
  defaultFilterState,
  filterableKinds,
  filterMiss,
  filterMissTarget,
  LOCKED_TARGET,
  noteFilterMiss,
  isDefaultFilterState,
  resetSelectionFilter,
  selectionFilterState,
  setAllKindsAllowed,
  setKindAllowed,
  setLockedAllowed,
  supportsLocked,
  __resetSelectionFilterStore
} from '../selectionFilter'
import { SELECTABLE_KINDS } from '../selectionResolve'

describe('the default filter', () => {
  test('excludes nothing and allows locked items', () => {
    // The whole feature has to ship behavior-neutral: today every kind is
    // selectable and locked items can be picked (otherwise there would be no
    // way to select one in order to unlock it).
    expect(defaultFilterState()).toEqual({ excludedKinds: [], allowLocked: true })
    expect(isDefaultFilterState(defaultFilterState())).toBe(true)
  })

  test('allows exactly what the editor could select before', () => {
    for (const [editor, kinds] of Object.entries(SELECTABLE_KINDS)) {
      const allows = allowsHitFor(editor, defaultFilterState())
      for (const kind of kinds) expect(allows({ kind }), `${editor}/${kind}`).toBe(true)
    }
  })
})

describe('allowsHitFor', () => {
  test('AND-s the editor policy with the user filter', () => {
    const allows = allowsHitFor('schematic', { excludedKinds: ['wire'], allowLocked: true })
    expect(allows({ kind: 'symbol' })).toBe(true)
    expect(allows({ kind: 'wire' })).toBe(false)
    // Still not selectable in the schematic whatever the filter says.
    expect(allows({ kind: 'pin' })).toBe(false)
  })

  test('excluding a kind the editor never selects is harmless', () => {
    // The stored exclusion list outlives any one version of SELECTABLE_KINDS,
    // so it will accumulate names that no longer mean anything here.
    const allows = allowsHitFor('symbol', { excludedKinds: ['footprint'], allowLocked: true })
    expect(allows({ kind: 'pin' })).toBe(true)
    expect(allows({ kind: 'graphic' })).toBe(true)
  })

  test('filters lock state independently of kind', () => {
    const noLocked = allowsHitFor('pcb', { excludedKinds: [], allowLocked: false })
    expect(noLocked({ kind: 'track', locked: false })).toBe(true)
    expect(noLocked({ kind: 'track', locked: true })).toBe(false)
    // An item with no lock state at all is never withheld by the lock switch.
    expect(noLocked({ kind: 'track' })).toBe(true)
  })
})

describe('supportsLocked', () => {
  test('offers the switch only where the format has a lock flag', () => {
    // A checkbox that cannot do anything is the same defect as a filter kind no
    // scene produces, so the panel asks before drawing the row.
    expect(supportsLocked('pcb')).toBe(true)
    expect(supportsLocked('footprint')).toBe(true)
    expect(supportsLocked('schematic')).toBe(false)
    expect(supportsLocked('symbol')).toBe(false)
  })
})

describe('filterableKinds', () => {
  test('offers every kind the editor can select, and nothing else', () => {
    for (const [editor, kinds] of Object.entries(SELECTABLE_KINDS)) {
      expect(filterableKinds(editor)).toEqual(kinds)
    }
    expect(filterableKinds('gerber')).toEqual([])
  })
})

// No `window.api` in the suite, so the store degrades to in-memory — which is
// the behavior a non-Electron host gets too, and worth holding to.
describe('the shared store without a config bridge', () => {
  beforeEach(() => __resetSelectionFilterStore())

  test('reads defaults before anything is written', () => {
    expect(selectionFilterState('pcb').value).toEqual(defaultFilterState())
  })

  test('switching a kind off excludes only that kind', () => {
    setKindAllowed('pcb', 'via', false)
    expect(selectionFilterState('pcb').value.excludedKinds).toEqual(['via'])
    setKindAllowed('pcb', 'via', true)
    expect(selectionFilterState('pcb').value.excludedKinds).toEqual([])
  })

  test('switching the same kind off twice does not duplicate it', () => {
    setKindAllowed('pcb', 'via', false)
    setKindAllowed('pcb', 'via', false)
    expect(selectionFilterState('pcb').value.excludedKinds).toEqual(['via'])
  })

  test('each editor keeps its own filter', () => {
    setKindAllowed('pcb', 'via', false)
    expect(selectionFilterState('schematic').value).toEqual(defaultFilterState())
  })

  test('"All items" unticked switches every kind off but leaves locked alone', () => {
    // One checkbox labelled "All items" must not also mean "and locked", or it
    // would promise two different things at once.
    setLockedAllowed('pcb', false)
    setAllKindsAllowed('pcb', false)
    const state = selectionFilterState('pcb').value
    expect([...state.excludedKinds].sort()).toEqual([...SELECTABLE_KINDS.pcb].sort())
    expect(state.allowLocked).toBe(false)
  })

  test('"All items" ticked switches every kind back on, locked untouched', () => {
    setLockedAllowed('pcb', false)
    setAllKindsAllowed('pcb', false)
    setAllKindsAllowed('pcb', true)
    const state = selectionFilterState('pcb').value
    expect(state.excludedKinds).toEqual([])
    expect(state.allowLocked).toBe(false)
  })

  test('allKindsAllowed drives the master checkbox, and ignores locked', () => {
    expect(allKindsAllowed('pcb', selectionFilterState('pcb').value)).toBe(true)
    // Locked off is not a kind being off, so the master row stays ticked.
    setLockedAllowed('pcb', false)
    expect(allKindsAllowed('pcb', selectionFilterState('pcb').value)).toBe(true)
    setKindAllowed('pcb', 'via', false)
    expect(allKindsAllowed('pcb', selectionFilterState('pcb').value)).toBe(false)
  })

  test('the badge reset clears everything, including locked', () => {
    // Deliberately a stronger promise than "All items": "put it all back".
    setAllKindsAllowed('pcb', false)
    setLockedAllowed('pcb', false)
    expect(isDefaultFilterState(selectionFilterState('pcb').value)).toBe(false)
    resetSelectionFilter('pcb')
    expect(selectionFilterState('pcb').value).toEqual(defaultFilterState())
  })

  test('a narrowed filter reads as non-default, which is what shows the badge', () => {
    expect(isDefaultFilterState(selectionFilterState('pcb').value)).toBe(true)
    setLockedAllowed('pcb', false)
    expect(isDefaultFilterState(selectionFilterState('pcb').value)).toBe(false)
  })
})

describe('a click the filter turned away', () => {
  beforeEach(() => __resetSelectionFilterStore())

  const at = (
    kind: string,
    locked = false
  ): { levels: Array<{ kind: string; locked: boolean; ref: string }> } => ({
    levels: [{ kind, locked, ref: kind }]
  })

  test('names the kind switched off under the click', () => {
    const state = { excludedKinds: ['via'], allowLocked: true }
    expect(filterMissTarget('pcb', state, [at('via')])).toBe('via')
  })

  test('names locked when the item under the click is locked and locked is off', () => {
    const state = { excludedKinds: [], allowLocked: false }
    expect(filterMissTarget('pcb', state, [at('footprint', true)])).toBe(LOCKED_TARGET)
  })

  test('is null when the click selects something further down the ranking', () => {
    const state = { excludedKinds: ['via'], allowLocked: true }
    expect(filterMissTarget('pcb', state, [at('via'), at('track')])).toBeNull()
  })

  test('is null over empty space, and over what the editor never selects', () => {
    const state = { excludedKinds: ['via'], allowLocked: true }
    expect(filterMissTarget('pcb', state, [])).toBeNull()
    expect(filterMissTarget('schematic', defaultFilterState(), [at('pin')])).toBeNull()
  })

  test('each miss bumps the signal, so the same target flashes twice', () => {
    setKindAllowed('pcb', 'via', false)
    const miss = filterMiss('pcb')
    noteFilterMiss('pcb', [at('via')])
    expect(miss.value).toEqual({ target: 'via', seq: 1 })
    noteFilterMiss('pcb', [at('track')])
    expect(miss.value?.seq).toBe(1)
    noteFilterMiss('pcb', [at('via')])
    expect(miss.value).toEqual({ target: 'via', seq: 2 })
  })
})
