import { beforeEach, describe, expect, test } from 'vitest'
import {
  buildLayerPresets,
  isSavedPresetId,
  matchingPresetId,
  nextNonActiveDisplay,
  savedPresetId,
  savedPresetName,
  usableSavedPresets,
  type LayerPreset
} from '../layerPresets'
import type { SavedLayerPreset } from '../../../../../preload/layerPresetTypes'
import {
  deleteLayerPreset,
  savedLayerPresets,
  saveLayerPreset,
  __resetLayerPresetStore
} from '../layerPresetStore'
import { normalizeLayerPresets, MAX_LAYER_PRESETS } from '../../../../../main/appConfig'

const BOARD_LAYERS = { 'F.Cu': true, 'B.Cu': true, 'F.SilkS': true, 'Edge.Cuts': true }

describe('nextNonActiveDisplay', () => {
  test('cycles show → dim → hide → show', () => {
    expect(nextNonActiveDisplay('show')).toBe('dim')
    expect(nextNonActiveDisplay('dim')).toBe('hide')
    expect(nextNonActiveDisplay('hide')).toBe('show')
  })
})

describe('a saved preset’s identity', () => {
  test('round-trips through its id, and never collides with a generated one', () => {
    expect(savedPresetName(savedPresetId('My view'))).toBe('My view')
    expect(isSavedPresetId(savedPresetId('all'))).toBe(true)
    for (const preset of buildLayerPresets(Object.keys(BOARD_LAYERS), (key) => key)) {
      expect(isSavedPresetId(preset.id)).toBe(false)
    }
  })
})

describe('which saved presets a document is offered', () => {
  test('only those whose every layer it has', () => {
    const saved: SavedLayerPreset[] = [
      { name: 'front only', visibility: { 'F.Cu': true, 'B.Cu': false } },
      { name: 'inner', visibility: { 'In1.Cu': true } }
    ]
    expect(usableSavedPresets(saved, BOARD_LAYERS).map((p) => p.label)).toEqual(['front only'])
  })

  test('carries the saved visibility through unchanged', () => {
    const visibility = { 'F.Cu': true, 'B.Cu': false }
    expect(usableSavedPresets([{ name: 'x', visibility }], BOARD_LAYERS)[0]).toEqual({
      id: savedPresetId('x'),
      label: 'x',
      visibility
    })
  })
})

describe('which preset the layers currently are', () => {
  const presets: LayerPreset[] = [
    { id: 'all', label: 'All', visibility: { ...BOARD_LAYERS } },
    { id: 'front', label: 'Front', visibility: { ...BOARD_LAYERS, 'B.Cu': false } }
  ]

  test('names the one that matches', () => {
    expect(matchingPresetId(presets, { ...BOARD_LAYERS, 'B.Cu': false })).toBe('front')
  })

  test('is none of them once a layer is toggled away', () => {
    expect(matchingPresetId(presets, { ...BOARD_LAYERS, 'F.SilkS': false })).toBe('')
  })

  test('is that one again the moment the layer is toggled back', () => {
    const edited = { ...BOARD_LAYERS, 'B.Cu': false, 'F.SilkS': false }
    expect(matchingPresetId(presets, edited)).toBe('')
    expect(matchingPresetId(presets, { ...edited, 'F.SilkS': true })).toBe('front')
  })

  test('matches a partial preset on the layers it names, ignoring the rest', () => {
    const partial: LayerPreset[] = [
      { id: 'user:copper', label: 'copper', visibility: { 'F.Cu': true } }
    ]
    expect(matchingPresetId(partial, { ...BOARD_LAYERS, 'F.SilkS': false })).toBe('user:copper')
  })

  test('keeps the built-in name when a saved preset duplicates it', () => {
    const withDuplicate = [
      ...presets,
      { id: 'user:mine', label: 'mine', visibility: { ...BOARD_LAYERS } }
    ]
    expect(matchingPresetId(withDuplicate, BOARD_LAYERS)).toBe('all')
  })
})

// No `window.api` in the suite, so the store degrades to in-memory.
describe('the saved-preset collection', () => {
  beforeEach(() => __resetLayerPresetStore())

  test('starts empty and keeps what is saved', () => {
    const presets = savedLayerPresets()
    expect(presets.value).toEqual([])
    saveLayerPreset('Front work', { 'F.Cu': true })
    expect(presets.value).toEqual([{ name: 'Front work', visibility: { 'F.Cu': true } }])
  })

  test('saving a name that exists replaces it rather than listing it twice', () => {
    const presets = savedLayerPresets()
    saveLayerPreset('mine', { 'F.Cu': true })
    saveLayerPreset('mine', { 'F.Cu': false })
    expect(presets.value).toEqual([{ name: 'mine', visibility: { 'F.Cu': false } }])
  })

  test('trims the name, and refuses one that is only spaces', () => {
    const presets = savedLayerPresets()
    saveLayerPreset('  padded  ', { 'F.Cu': true })
    saveLayerPreset('   ', { 'F.Cu': true })
    expect(presets.value.map((p) => p.name)).toEqual(['padded'])
  })

  test('copies the visibility it was handed, so later edits do not rewrite it', () => {
    const presets = savedLayerPresets()
    const live: Record<string, boolean> = { 'F.Cu': true }
    saveLayerPreset('snapshot', live)
    live['F.Cu'] = false
    expect(presets.value[0].visibility).toEqual({ 'F.Cu': true })
  })

  test('deletes by name', () => {
    const presets = savedLayerPresets()
    saveLayerPreset('a', { 'F.Cu': true })
    saveLayerPreset('b', { 'F.Cu': false })
    deleteLayerPreset('a')
    expect(presets.value.map((p) => p.name)).toEqual(['b'])
  })
})

describe('normalizeLayerPresets', () => {
  test('drops entries with no name or no usable visibility', () => {
    expect(
      normalizeLayerPresets([
        { name: 'keep', visibility: { 'F.Cu': true } },
        { name: '', visibility: { 'F.Cu': true } },
        { name: 'empty', visibility: {} },
        { name: 'junk', visibility: 'nope' },
        'not an entry'
      ])
    ).toEqual([{ name: 'keep', visibility: { 'F.Cu': true } }])
  })

  test('drops non-boolean layer values rather than the whole preset', () => {
    expect(
      normalizeLayerPresets([{ name: 'x', visibility: { 'F.Cu': true, 'B.Cu': 'yes' } }])
    ).toEqual([{ name: 'x', visibility: { 'F.Cu': true } }])
  })

  test('a duplicated name keeps the last, matching what saving over one does', () => {
    expect(
      normalizeLayerPresets([
        { name: 'x', visibility: { 'F.Cu': true } },
        { name: 'x', visibility: { 'F.Cu': false } }
      ])
    ).toEqual([{ name: 'x', visibility: { 'F.Cu': false } }])
  })

  test('caps a runaway list, keeping the most recent', () => {
    const many = Array.from({ length: MAX_LAYER_PRESETS + 5 }, (_, i) => ({
      name: `p${i}`,
      visibility: { 'F.Cu': true }
    }))
    const normalized = normalizeLayerPresets(many)
    expect(normalized).toHaveLength(MAX_LAYER_PRESETS)
    expect(normalized[normalized.length - 1].name).toBe(`p${MAX_LAYER_PRESETS + 4}`)
  })

  test('anything that is not a list is no presets', () => {
    expect(normalizeLayerPresets(undefined)).toEqual([])
    expect(normalizeLayerPresets({ name: 'x' })).toEqual([])
  })
})
