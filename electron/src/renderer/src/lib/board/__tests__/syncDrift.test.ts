import { describe, expect, test } from 'vitest'
import type { CheckResult } from '../../schematic/checks'
import { driftOf } from '../syncDrift'

const finding = (code: string, overrides: Partial<CheckResult> = {}): CheckResult => ({
  code,
  severity: 'warning',
  message: code,
  items: [],
  ...overrides
})

describe('driftOf', () => {
  test('is all zeros on a board with no parity findings', () => {
    expect(driftOf([finding('clearance', { targets: ['t1'] })])).toEqual({
      state: 'checked',
      added: 0,
      removed: 0,
      edited: 0
    })
  })

  test('sorts parity findings into added, removed and edited, each footprint once', () => {
    expect(
      driftOf([
        finding('missing-footprint', { subject: 'R7' }),
        finding('missing-footprint', { subject: 'R8' }),
        finding('extra-footprint', { items: ['J9'], targets: ['j9-uuid'] }),
        // A value and two pads of one footprint are one footprint to edit.
        finding('footprint-symbol-mismatch', { items: ['C1'], targets: ['c1-uuid'] }),
        finding('net-conflict', { items: ['C1.1'], targets: ['c1-uuid'] }),
        finding('net-conflict', { items: ['C1.2'], targets: ['c1-uuid'] }),
        finding('footprint-symbol-field-mismatch', { items: ['U1'], targets: ['u1-uuid'] })
      ])
    ).toEqual({ state: 'checked', added: 2, removed: 1, edited: 2 })
  })

  test('leaves out excluded findings and what an update does not fix', () => {
    expect(
      driftOf([
        finding('missing-footprint', {
          subject: 'R7',
          excluded: { comment: '', exclusion: 'x' }
        }),
        finding('footprint-filters-mismatch', { items: ['U2'], targets: ['u2-uuid'] }),
        finding('duplicate-footprints', { items: ['R1', 'R1'], targets: ['a', 'b'] })
      ])
    ).toEqual({ state: 'checked', added: 0, removed: 0, edited: 0 })
  })
})
