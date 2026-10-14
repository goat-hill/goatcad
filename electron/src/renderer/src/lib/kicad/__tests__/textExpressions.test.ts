import { describe, expect, test } from 'vitest'
import { shownText } from '../textExpressions'

describe('shownText', () => {
  const vars = (name: string): string | undefined => ({ '#': '3', SHEETNAME: 'ch' })[name]

  test('replaces variables and evaluates arithmetic', () => {
    expect(shownText('Out@{(${#}-2)*8+0}', vars)).toBe('Out8')
    expect(shownText('${SHEETNAME}_@{${#}*2}', vars)).toBe('ch_6')
  })

  test('leaves what it cannot resolve as written', () => {
    expect(shownText('${UNKNOWN}', vars)).toBe('${UNKNOWN}')
    expect(shownText('@{max(1,2)}', vars)).toBe('@{max(1,2)}')
    expect(shownText('PLAIN', vars)).toBe('PLAIN')
  })
})
