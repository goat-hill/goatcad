import { describe, expect, test } from 'vitest'
import { compareNames } from '../nameOrder'

describe('compareNames', () => {
  test('walks digit runs numerically, so R10 follows R2', () => {
    // The reason plain string order is wrong for a symbol or reference list:
    // '1' < '2' puts R10 above R2 in every library with ten of anything.
    expect(['R10', 'R2', 'R1'].sort(compareNames)).toEqual(['R1', 'R2', 'R10'])
    expect(['C100', 'C20', 'C3'].sort(compareNames)).toEqual(['C3', 'C20', 'C100'])
  })

  test('ignores case, so one list does not split into two runs', () => {
    // Plain code-point order sorts every capital ahead of every lowercase, which
    // reads as two lists rather than one.
    expect(['opamp', 'LED', 'adc', 'Buzzer'].sort(compareNames)).toEqual([
      'adc',
      'Buzzer',
      'LED',
      'opamp'
    ])
    expect(compareNames('ADC', 'adc')).toBe(0)
  })

  test('a leading digit run is a NUMBER, not a prefix', () => {
    // Which puts the 74-series ahead of the 4000-series, since 74 < 4001. It
    // reads oddly next to a plain alphabetical list and is the right answer:
    // KiCad's StrNumCmp compares digit runs numerically wherever they fall
    // (`common/string_utils.cpp`), so its tree orders these the same way.
    expect(['4001', '74HC00', '74HC02'].sort(compareNames)).toEqual(['74HC00', '74HC02', '4001'])
  })

  test('a tie keeps the input order, since sort is stable', () => {
    // Two names that differ only by case are one name as far as the order goes,
    // so whichever the library listed first stays first.
    expect(['adc', 'ADC', 'led'].sort(compareNames)).toEqual(['adc', 'ADC', 'led'])
  })
})
