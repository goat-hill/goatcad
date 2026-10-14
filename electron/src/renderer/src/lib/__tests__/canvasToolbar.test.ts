import { describe, expect, it } from 'vitest'
import { planToolbarFit, splitToolTitle, type ToolbarFitItem } from '../canvasToolbar'

const chip = (late = false): ToolbarFitItem => ({ width: 32, divider: false, late })
const divider: ToolbarFitItem = { width: 9, divider: true, late: false }

// undo redo | select wire label | annotate
const bar = [chip(), chip(), divider, chip(), chip(), chip(), divider, chip()]
const FIXED = 100
const GAP = 2
const natural = FIXED + bar.reduce((sum, item) => sum + item.width + GAP, 0)

const hide = (items: ToolbarFitItem[], budget: number): number[] =>
  [...planToolbarFit(items, FIXED, GAP, budget)].sort((a, b) => a - b)

describe('planToolbarFit', () => {
  it('hides nothing when the bar fits', () => {
    expect(hide(bar, natural)).toEqual([])
  })

  it('hides from the end, taking a divider left with nothing after it', () => {
    // Dropping annotate leaves the second divider trailing into the search.
    expect(hide(bar, natural - 1)).toEqual([6, 7])
  })

  it('keeps hiding inward until the bar fits', () => {
    expect(hide(bar, natural - 34 - 11 - 34)).toEqual([5, 6, 7])
    expect(hide(bar, FIXED + 2 * 34)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('hides the armed tool and its options only after every other chip', () => {
    const armed = [chip(), chip(), divider, chip(true), chip(), chip(), divider, chip()]
    expect(hide(armed, FIXED + 34 + 11 + 34)).toEqual([1, 4, 5, 6, 7])
  })

  it('hides an early chip before any other', () => {
    // undo redo | rotate mirror | select wire: rotate and mirror go before wire.
    const items = [
      chip(),
      chip(),
      divider,
      { ...chip(), early: true },
      { ...chip(), early: true },
      divider,
      chip(),
      chip()
    ]
    const full = FIXED + items.reduce((sum, item) => sum + item.width + GAP, 0)
    expect(hide(items, full - 1)).toEqual([4])
    expect(hide(items, full - 34 - 34 - 11)).toEqual([3, 4, 5])
  })

  it('hides a group of neighbors as one', () => {
    // select route | width via pair: short of one chip, all three sizes go.
    const sizes = { ...chip(), group: 'sizes' }
    const items = [chip(), chip(), divider, sizes, sizes, sizes]
    const full = FIXED + items.reduce((sum, item) => sum + item.width + GAP, 0)
    expect(hide(items, full - 1)).toEqual([2, 3, 4, 5])
  })

  it('never shows two dividers in a row', () => {
    // a | b | c: hiding b first would leave "a | | c".
    const items = [chip(), divider, chip(), divider, chip(true)]
    const hidden = planToolbarFit(items, FIXED, GAP, FIXED + 34 + 11 + 34)
    expect([...hidden].sort()).toEqual([2, 3])
  })

  it('shows the search alone when nothing fits', () => {
    expect(hide(bar, FIXED)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

describe('splitToolTitle', () => {
  it('splits a toolTitle into its name and hotkey', () => {
    expect(splitToolTitle('Arc (Ctrl+Shift+A)')).toEqual({
      name: 'Arc',
      hotkeys: ['Ctrl+Shift+A']
    })
  })

  it('splits out every hotkey of a several-binding title', () => {
    expect(splitToolTitle('Zoom to fit (Home, Ctrl+0)')).toEqual({
      name: 'Zoom to fit',
      hotkeys: ['Home', 'Ctrl+0']
    })
    expect(splitToolTitle('Zoom to fit (Home, ⌘0)').hotkeys).toEqual(['Home', '⌘0'])
  })

  it('leaves a title with no hotkey whole', () => {
    expect(splitToolTitle('Annotate')).toEqual({ name: 'Annotate', hotkeys: [] })
    expect(splitToolTitle('Block violations (while routing)')).toEqual({
      name: 'Block violations (while routing)',
      hotkeys: []
    })
  })
})
