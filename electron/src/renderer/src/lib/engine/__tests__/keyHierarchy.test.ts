import { describe, expect, it, test } from 'vitest'
import { dropKeysCoveredByParent, KeyHierarchy } from '../keyHierarchy'

describe('KeyHierarchy', () => {
  /** Stand-in for "this map holds paint under that key". */
  const owns =
    (...keys: string[]) =>
    (key: string): boolean =>
      keys.includes(key)
  const none = (): boolean => false

  test('a key with no parts resolves to itself — the PCB and footprint case', () => {
    const h = new KeyHierarchy()
    h.add('segment:0')
    h.add('via:3')
    expect(h.expand('segment:0', owns('segment:0'))).toEqual(['segment:0'])
    expect(h.hasChildren('segment:0')).toBe(false)
  })

  test('a parent resolves to its parts', () => {
    const h = new KeyHierarchy()
    h.add('symbol:3/pin:0.1.1.0')
    h.add('symbol:3/graphic:0.0.1.0')
    expect(h.expand('symbol:3', none)).toEqual(['symbol:3/pin:0.1.1.0', 'symbol:3/graphic:0.0.1.0'])
  })

  test('a parent holding paint of its own is included alongside its parts', () => {
    const h = new KeyHierarchy()
    h.add('symbol:3')
    h.add('symbol:3/pin:0.1.1.0')
    expect(h.expand('symbol:3', owns('symbol:3'))).toEqual(['symbol:3', 'symbol:3/pin:0.1.1.0'])
    // Field text still lives under the symbol's own key today, so this is the
    // real shape — not a hypothetical.
    expect(h.expand('symbol:3', none)).toEqual(['symbol:3/pin:0.1.1.0'])
  })

  test('a key that merely shares a prefix is not a part', () => {
    const h = new KeyHierarchy()
    h.add('symbol:1/pin:0.1.1.0')
    h.add('symbol:11/pin:0.1.1.0')
    // `symbol:11` starts with `symbol:1`. Recording parents on insert makes
    // this structurally impossible; prefix matching would get it wrong.
    expect(h.expand('symbol:1', none)).toEqual(['symbol:1/pin:0.1.1.0'])
    expect(h.expand('symbol:11', none)).toEqual(['symbol:11/pin:0.1.1.0'])
  })

  test('only the first separator splits, so a part name may contain more', () => {
    const h = new KeyHierarchy()
    h.add('symbol:3/pin:0.1.1.0/sub')
    expect(h.expand('symbol:3', none)).toEqual(['symbol:3/pin:0.1.1.0/sub'])
  })

  test('delete drops a parent index; clear drops everything', () => {
    const h = new KeyHierarchy()
    h.add('symbol:3/pin:0.1.1.0')
    h.delete('symbol:3')
    expect(h.expand('symbol:3', none)).toEqual(['symbol:3'])

    h.add('symbol:4/pin:0.1.1.0')
    h.clear()
    expect(h.expand('symbol:4', none)).toEqual(['symbol:4'])
  })
})

// A parent already carries its parts, so a selection holding both would move
// the part twice — reachable the moment anything inside a container becomes
// separately selectable (shift-click a symbol, then its Reference text).
describe('dropKeysCoveredByParent', () => {
  it('drops a part whose parent is selected alongside it', () => {
    expect(dropKeysCoveredByParent(['symbol:0', 'symbol:0/field:Reference', 'wire:3'])).toEqual([
      'symbol:0',
      'wire:3'
    ])
  })

  it('keeps a part whose parent is not selected', () => {
    expect(dropKeysCoveredByParent(['symbol:0/field:Reference', 'wire:3'])).toEqual([
      'symbol:0/field:Reference',
      'wire:3'
    ])
  })

  it('is not fooled by a parent name that merely shares a prefix', () => {
    // `symbol:1` must not cover `symbol:11`'s parts.
    expect(dropKeysCoveredByParent(['symbol:1', 'symbol:11/field:Reference'])).toEqual([
      'symbol:1',
      'symbol:11/field:Reference'
    ])
  })

  it('preserves order, so the caller ranking survives', () => {
    expect(dropKeysCoveredByParent(['wire:3', 'symbol:0/field:Value', 'symbol:0'])).toEqual([
      'wire:3',
      'symbol:0'
    ])
  })

  it('leaves a list with no parts untouched — every PCB selection', () => {
    const flat = ['segment:0', 'via:1', 'zone:2']
    expect(dropKeysCoveredByParent(flat)).toEqual(flat)
  })
})
