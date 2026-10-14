import { describe, expect, it } from 'vitest'
import { matchPinsToPads, pinPadNumbers } from '../pinPadMatch'

const pin = (number: string, name = ''): { number: string; name: string } => ({ number, name })

describe('matchPinsToPads', () => {
  it('matches every pin to a pad of its number', () => {
    const result = matchPinsToPads([pin('1', 'A'), pin('2', 'K')], ['1', '2'])
    expect(result).toEqual({ matched: 2, pinsWithoutPad: [], padsWithoutPin: [] })
  })

  it('names pins with no pad and pads with no pin, in pad order', () => {
    const result = matchPinsToPads(
      [pin('1', 'VIN'), pin('2', 'GND'), pin('10', 'EN'), pin('3', 'OUT')],
      ['1', '2', '3', '4', 'EP']
    )
    expect(result.pinsWithoutPad).toEqual([pin('10', 'EN')])
    expect(result.padsWithoutPin).toEqual(['4', 'EP'])
    expect(result.matched).toBe(3)
  })

  it('reads a stacked pin as each of its pads', () => {
    const result = matchPinsToPads([pin('[1,3-4]', 'GND'), pin('2', 'IO')], ['1', '2', '3', '4'])
    expect(result).toEqual({ matched: 4, pinsWithoutPad: [], padsWithoutPin: [] })
  })

  it('counts a pin repeated across units once, and ignores unnumbered pads', () => {
    const result = matchPinsToPads([pin('1'), pin('1'), pin('2')], ['1', '2', '', '2'])
    expect(result).toEqual({ matched: 2, pinsWithoutPad: [], padsWithoutPin: [] })
  })
})

describe('pinPadNumbers', () => {
  it('is the distinct pads the pins name', () => {
    expect([...pinPadNumbers([pin('1'), pin('[2-3]'), pin('1'), pin('')])]).toEqual(['1', '2', '3'])
  })
})
