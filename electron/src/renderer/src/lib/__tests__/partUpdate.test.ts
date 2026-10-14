/** The update dialog's scopes (`partUpdate.ts`): KiCad's, matched with its wildcards. */
import { describe, expect, test } from 'vitest'
import { inScope, matchesPattern } from '../partUpdate'

const part = { reference: 'R12', value: '10k', libId: 'Device:R' }

describe('update scopes', () => {
  test('match a reference, a value or a lib id with * and ?, ignoring case', () => {
    expect(matchesPattern('R*', 'R12')).toBe(true)
    expect(matchesPattern('r1?', 'R12')).toBe(true)
    expect(matchesPattern('C*', 'R12')).toBe(false)
    expect(inScope({ scope: 'reference', pattern: 'R1*' }, part, false)).toBe(true)
    expect(inScope({ scope: 'value', pattern: '10K' }, part, false)).toBe(true)
    expect(inScope({ scope: 'libId', pattern: 'Device:*' }, part, false)).toBe(true)
    expect(inScope({ scope: 'libId', pattern: 'Device:C' }, part, false)).toBe(false)
  })

  test('the selection takes what is selected; all takes everything', () => {
    expect(inScope({ scope: 'selection', pattern: '' }, part, true)).toBe(true)
    expect(inScope({ scope: 'selection', pattern: '' }, part, false)).toBe(false)
    expect(inScope({ scope: 'all', pattern: '' }, part, false)).toBe(true)
  })
})
