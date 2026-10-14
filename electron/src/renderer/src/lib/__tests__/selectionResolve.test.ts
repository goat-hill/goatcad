import { describe, expect, it } from 'vitest'
import {
  allowsKindFor,
  resolveHit,
  resolveSweep,
  schematicItemKind,
  SELECTABLE_KINDS,
  type HitCandidate
} from '../selectionResolve'

/** A symbol's pin: a hit on the pin and on the symbol at once. */
const pinOfSymbol = (symbol: string, pin: string): HitCandidate<string> => ({
  levels: [
    { kind: 'pin', ref: `${symbol}/${pin}` },
    { kind: 'symbol', ref: symbol }
  ]
})

const flat = (kind: string, ref: string): HitCandidate<string> => ({
  levels: [{ kind, ref }]
})

describe('resolveHit', () => {
  it('walks up to the nearest level the editor allows', () => {
    const candidate = pinOfSymbol('symbol:3', 'pin:7')
    // The schematic does not select pins: the click resolves to the symbol.
    expect(resolveHit([candidate], allowsKindFor('schematic'))).toBe('symbol:3')
    // The symbol editor has no symbol level — the pin stands for itself.
    expect(resolveHit([candidate], allowsKindFor('symbol'))).toBe('symbol:3/pin:7')
  })

  it('stops at the most specific allowed level, not the outermost', () => {
    // Field text is the schematic's one exception: it must NOT resolve up.
    const field: HitCandidate<string> = {
      levels: [
        { kind: 'field', ref: 'symbol:3/field:Reference' },
        { kind: 'symbol', ref: 'symbol:3' }
      ]
    }
    expect(resolveHit([field], ({ kind }) => kind === 'field' || kind === 'symbol')).toBe(
      'symbol:3/field:Reference'
    )
  })

  it('leaves things that contain nothing untouched', () => {
    expect(resolveHit([flat('wire', 'wire:12')], allowsKindFor('schematic'))).toBe('wire:12')
  })

  it('takes the scene ranking as given rather than reordering it', () => {
    // A junction over a wire: the scene already decided the junction wins.
    const ranked = [flat('junction', 'junction:1'), flat('wire', 'wire:12')]
    expect(resolveHit(ranked, allowsKindFor('schematic'))).toBe('junction:1')
  })

  // The reason a disallowed candidate must not end the search. With symbols
  // filtered out, clicking a symbol lying over a wire should give the wire —
  // otherwise a filter is a way of making clicks stop working.
  it('falls through to the next candidate when a whole chain is disallowed', () => {
    const ranked = [pinOfSymbol('symbol:3', 'pin:7'), flat('wire', 'wire:12')]
    const wiresOnly = ({ kind }: { kind: string }): boolean => kind === 'wire'
    expect(resolveHit(ranked, wiresOnly)).toBe('wire:12')
  })

  it('selects nothing when nothing under the cursor is allowed', () => {
    expect(resolveHit([flat('symbol', 'symbol:3')], ({ kind }) => kind === 'wire')).toBeNull()
    expect(resolveHit([], allowsKindFor('schematic'))).toBeNull()
  })
})

describe('resolveSweep', () => {
  it('takes a symbol once however many of its parts the band touched', () => {
    const swept = [
      pinOfSymbol('symbol:3', 'pin:1'),
      pinOfSymbol('symbol:3', 'pin:2'),
      flat('wire', 'wire:12')
    ]
    expect(resolveSweep(swept, allowsKindFor('schematic'), (r) => r)).toEqual([
      'symbol:3',
      'wire:12'
    ])
  })

  it('keeps parts distinct where the editor selects them individually', () => {
    const swept = [pinOfSymbol('symbol:0', 'pin:1'), pinOfSymbol('symbol:0', 'pin:2')]
    expect(resolveSweep(swept, allowsKindFor('symbol'), (r) => r)).toEqual([
      'symbol:0/pin:1',
      'symbol:0/pin:2'
    ])
  })

  it('drops what the editor does not allow instead of resolving it up', () => {
    const swept = [pinOfSymbol('symbol:3', 'pin:1'), flat('wire', 'wire:12')]
    const wiresOnly = ({ kind }: { kind: string }): boolean => kind === 'wire'
    expect(resolveSweep(swept, wiresOnly, (r) => r)).toEqual(['wire:12'])
  })
})

describe('allowsKindFor', () => {
  it('reproduces the selectable kinds each editor has today', () => {
    const schematic = allowsKindFor('schematic')
    expect(schematic({ kind: 'symbol' })).toBe(true)
    expect(schematic({ kind: 'wire' })).toBe(true)
    // Named for highlighting and netlist sync, deliberately not selectable.
    expect(schematic({ kind: 'pin' })).toBe(false)
    // Every item the sheet draws is its own kind to click, and to filter.
    for (const kind of ['graphic', 'text', 'image', 'rule_area', 'sheet_pin'])
      expect(schematic({ kind }), kind).toBe(true)
    expect(schematic({ kind: 'pad' })).toBe(false)
  })

  it('files each schematic item type under its filter kind', () => {
    expect(schematicItemKind('bus')).toBe('wire')
    expect(schematicItemKind('bus_entry')).toBe('wire')
    expect(schematicItemKind('netclass_flag')).toBe('label')
    expect(schematicItemKind('text_box')).toBe('text')
    expect(schematicItemKind('table')).toBe('text')
    for (const type of ['shape', 'polyline', 'circle', 'arc', 'bezier'])
      expect(schematicItemKind(type)).toBe('graphic')
    expect(schematicItemKind('sheet_field')).toBe('field')
    expect(schematicItemKind('symbol')).toBe('symbol')
    // Every kind a type files under is one the editor offers.
    const schematic = allowsKindFor('schematic')
    for (const type of [
      'bus',
      'netclass_flag',
      'text_box',
      'arc',
      'image',
      'rule_area',
      'sheet_pin'
    ])
      expect(schematic({ kind: schematicItemKind(type) }), type).toBe(true)
  })

  it('allows everything for a viewport that has not opted in', () => {
    const unknown = allowsKindFor('gerber')
    expect(unknown({ kind: 'anything' })).toBe(true)
  })

  it('lists no kind twice, in any editor', () => {
    for (const [editor, kinds] of Object.entries(SELECTABLE_KINDS)) {
      expect(new Set(kinds).size, editor).toBe(kinds.length)
    }
  })
})
