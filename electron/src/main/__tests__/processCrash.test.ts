import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, crashReporter: {}, dialog: {} }))

import { crashLine } from '../processCrash'

describe('crashLine', () => {
  it('writes one JSON line, time first', () => {
    const line = crashLine(new Date('2026-10-07T19:12:50Z'), {
      process: 'renderer',
      reason: 'crashed',
      exitCode: 133
    })
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      at: '2026-10-07T19:12:50.000Z',
      process: 'renderer',
      reason: 'crashed',
      exitCode: 133
    })
  })
})
