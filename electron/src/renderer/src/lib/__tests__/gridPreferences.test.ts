import { describe, expect, it } from 'vitest'
import type { GridSettings } from '../engine/ViewportEngine'
import {
  fastGridSpacing,
  gridKeyUpdate,
  gridSpacingsFor,
  PCB_UNIT_SPACINGS,
  steppedGridSpacing,
  toggledGridUnit,
  toggledUnitFor,
  updateGridSettings,
  useGridSettings
} from '../gridPreferences'

const mm: GridSettings = { spacing: 1.0, unit: 'mm', visible: true, snap: true }

describe('useGridSettings', () => {
  it('seeds from defaults and shares one source across instances of a kind', () => {
    const a = useGridSettings('footprint', mm)
    expect(a.value.spacing).toBe(1.0)

    // Same kind, different defaults → the already-seeded value wins (a saved
    // grid isn't clobbered), and both refs share one reactive source.
    const b = useGridSettings('footprint', { ...mm, spacing: 0.25 })
    expect(b.value.spacing).toBe(1.0)

    a.value = { ...a.value, spacing: 0.5 }
    expect(b.value.spacing).toBe(0.5)
  })

  it('keeps separate state per editor kind', () => {
    const sym = useGridSettings('symbol', { spacing: 50, unit: 'mil', visible: true, snap: true })
    const pcb = useGridSettings('pcb', { ...mm, spacing: 0.25 })
    expect(sym.value.unit).toBe('mil')
    expect(pcb.value.unit).toBe('mm')
    expect(sym.value.spacing).toBe(50)
  })

  it('fills a missing field from defaults over a partial saved value', () => {
    // First call seeds the store; a later call with an added default field must
    // not drop the existing value but should provide any new field.
    const first = useGridSettings('schematic', {
      spacing: 50,
      unit: 'mil',
      visible: true,
      snap: true
    })
    first.value = { ...first.value, snap: false }
    const again = useGridSettings('schematic', {
      spacing: 50,
      unit: 'mil',
      visible: true,
      snap: true
    })
    expect(again.value.snap).toBe(false) // preserved
    expect(again.value.visible).toBe(true)
  })
})

describe('updateGridSettings', () => {
  const spacings = PCB_UNIT_SPACINGS

  it('uses the editor default for a newly selected unit', () => {
    expect(updateGridSettings(mm, { unit: 'mil' }, spacings)).toEqual({
      spacing: 10,
      unit: 'mil',
      visible: true,
      snap: true
    })
  })

  it('lands inches on the editor inch grid', () => {
    expect(updateGridSettings(mm, { unit: 'in' }, spacings).spacing).toBe(0.01)
  })

  it('keeps the existing spacing for edits that do not change units', () => {
    expect(updateGridSettings(mm, { visible: false }, spacings)).toEqual({
      ...mm,
      visible: false
    })
  })
})

describe('grid stepping (KiCad N / Shift+N)', () => {
  it('lists the unit presets with an off-list spacing among them', () => {
    expect(gridSpacingsFor({ unit: 'in', spacing: 0.05 })).toContain(0.05)
    expect(gridSpacingsFor({ unit: 'mm', spacing: 0.3 })).toEqual([
      0.05, 0.1, 0.25, 0.3, 0.5, 1, 1.27, 2.54
    ])
  })

  it('steps to the finer grid on next and the coarser on previous', () => {
    expect(steppedGridSpacing({ unit: 'mil', spacing: 50 }, 'next')).toBe(25)
    expect(steppedGridSpacing({ unit: 'mil', spacing: 50 }, 'previous')).toBe(100)
  })

  it('wraps around both ends, as KiCad does', () => {
    expect(steppedGridSpacing({ unit: 'mil', spacing: 1 }, 'next')).toBe(100)
    expect(steppedGridSpacing({ unit: 'in', spacing: 0.1 }, 'previous')).toBe(0.001)
  })

  it('steps on from a spacing that is not a preset', () => {
    expect(steppedGridSpacing({ unit: 'mm', spacing: 0.3 }, 'next')).toBe(0.25)
    expect(steppedGridSpacing({ unit: 'mm', spacing: 0.3 }, 'previous')).toBe(0.5)
  })
})

describe('fast grids (KiCad Alt+1 / 2 / 4)', () => {
  const spacings = { mm: 1.27, mil: 50, in: 0.05 }

  it('are the editor grid in this unit and the next finer preset', () => {
    expect(fastGridSpacing({ unit: 'mil', spacing: 10 }, 1, spacings)).toBe(50)
    expect(fastGridSpacing({ unit: 'mil', spacing: 10 }, 2, spacings)).toBe(25)
    expect(fastGridSpacing({ unit: 'mm', spacing: 1 }, 2, spacings)).toBe(1)
  })

  it('cycle between the two', () => {
    expect(fastGridSpacing({ unit: 'in', spacing: 0.05 }, 'cycle', spacings)).toBe(0.025)
    expect(fastGridSpacing({ unit: 'in', spacing: 0.025 }, 'cycle', spacings)).toBe(0.05)
    expect(fastGridSpacing({ unit: 'in', spacing: 0.1 }, 'cycle', spacings)).toBe(0.05)
  })

  it('stay on the finest preset when there is none finer', () => {
    expect(fastGridSpacing({ unit: 'mil', spacing: 1 }, 2, { ...spacings, mil: 1 })).toBe(1)
  })
})

describe('unit toggle (KiCad Ctrl/Cmd+U)', () => {
  it('goes metric to imperial and back', () => {
    expect(toggledGridUnit('mm')).toBe('mil')
    expect(toggledGridUnit('mm', 'in')).toBe('in')
    expect(toggledGridUnit('mil')).toBe('mm')
    expect(toggledGridUnit('in')).toBe('mm')
  })

  it('returns to the imperial unit this kind last showed', () => {
    const grid = useGridSettings('footprint', mm)
    grid.value = { ...grid.value, unit: 'in', spacing: 0.05 }
    grid.value = { ...grid.value, unit: 'mm', spacing: 1 }
    expect(toggledUnitFor('footprint', 'mm')).toBe('in')
  })
})

describe('gridKeyUpdate', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...mods
    }) as KeyboardEvent
  const mil: GridSettings = { spacing: 50, unit: 'mil', visible: true, snap: true }
  const spacings = { mm: 1.27, mil: 50, in: 0.05 }

  it('reads the grid keys', () => {
    expect(gridKeyUpdate(key('n'), 'schematic', mil, spacings)).toEqual({ spacing: 25 })
    expect(gridKeyUpdate(key('N', { shiftKey: true }), 'schematic', mil, spacings)).toEqual({
      spacing: 100
    })
    expect(gridKeyUpdate(key('2', { altKey: true }), 'schematic', mil, spacings)).toEqual({
      spacing: 25
    })
    expect(gridKeyUpdate(key('u', { ctrlKey: true }), 'schematic', mil, spacings)).toEqual({
      unit: 'mm'
    })
  })

  it('passes on every other key', () => {
    expect(gridKeyUpdate(key('n', { ctrlKey: true }), 'schematic', mil, spacings)).toBeNull()
    expect(gridKeyUpdate(key('3', { altKey: true }), 'schematic', mil, spacings)).toBeNull()
  })
})
