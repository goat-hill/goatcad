import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { buildNotices, LIST_PATH, NOTICES_PATH } from '../../../scripts/third-party-notices.mjs'

describe('THIRD_PARTY_NOTICES.txt', () => {
  it('lists what the build ships, and so does the About list', () => {
    const { text, list } = buildNotices()
    // Compared as flags: a diff of a 300 KB file helps nobody.
    const stale = readFileSync(NOTICES_PATH, 'utf8') !== text
    expect(stale, 'stale: run ./bin/notices').toBe(false)
    const listStale = readFileSync(LIST_PATH, 'utf8') !== list
    expect(listStale, 'stale: run ./bin/notices').toBe(false)
  })
})
