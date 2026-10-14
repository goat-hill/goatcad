import { describe, test, expect } from 'vitest'
import {
  BUILT_IN_EXPORT_PROFILES,
  DEFAULT_EXPORT_PROFILE_ID,
  ALL_OUTPUTS,
  findExportProfile,
  hasOutput,
  bomPartNumber,
  exportProfileForVendor,
  deriveExportProfile
} from '../exportProfiles'

describe('export profiles', () => {
  test('the built-in set is JLCPCB, OSH Park and Generic', () => {
    // JLCPCB stays built in beside the launch manufacturers (MILESTONES Scope).
    expect(BUILT_IN_EXPORT_PROFILES.map((p) => p.vendor)).toEqual(['JLCPCB', 'OSH Park', 'Generic'])
  })

  test('the default profile exists and is first', () => {
    expect(findExportProfile(DEFAULT_EXPORT_PROFILE_ID)).not.toBeNull()
    expect(BUILT_IN_EXPORT_PROFILES[0].id).toBe(DEFAULT_EXPORT_PROFILE_ID)
  })

  test('every built-in output is a known FabOutput, and it zips only what it makes', () => {
    for (const p of BUILT_IN_EXPORT_PROFILES) {
      for (const output of Object.keys(p.outputs)) expect(ALL_OUTPUTS).toContain(output)
      for (const output of p.archive) expect(hasOutput(p, output)).toBe(true)
    }
  })

  test('a profile that sets a format names its source', () => {
    for (const p of BUILT_IN_EXPORT_PROFILES) {
      const settings = Object.values(p.outputs).flatMap((format) => Object.keys(format ?? {}))
      if (settings.length) expect(p.sources.length).toBeGreaterThan(0)
      for (const url of p.sources) expect(url).toMatch(/^https:\/\//)
    }
  })

  test("JLCPCB's BOM keys on the LCSC family under JLCPCB's own header", () => {
    const jlc = findExportProfile('jlcpcb')!
    expect(bomPartNumber(jlc)).toBe('LCSC')
    expect(jlc.outputs.bom?.columns?.map((c) => c.label)).toEqual([
      'Comment',
      'Designator',
      'Footprint',
      'JLCPCB Part #'
    ])
    expect(jlc.archive).toEqual(['gerber', 'drill'])
  })

  test('exportProfileForVendor matches by vendor and falls back to the default', () => {
    expect(exportProfileForVendor('Generic').vendor).toBe('Generic')
    // A vendor with no export profile still yields a usable default, never null.
    expect(exportProfileForVendor('PCBWay').id).toBe(DEFAULT_EXPORT_PROFILE_ID)
    expect(exportProfileForVendor(null).id).toBe(DEFAULT_EXPORT_PROFILE_ID)
  })

  test('deriveExportProfile forks without mutating the built-in', () => {
    const base = findExportProfile('jlcpcb')!
    const derived = deriveExportProfile(base, { archive: [] })
    expect(derived.builtIn).toBe(false)
    expect(derived.derivedFrom).toBe('jlcpcb')
    expect(derived.archive).toEqual([])
    expect(base.archive).toEqual(['gerber', 'drill'])
  })

  test('deriving twice keeps pointing at the original built-in', () => {
    const base = findExportProfile('generic')!
    const twice = deriveExportProfile(deriveExportProfile(base, {}), {})
    expect(twice.derivedFrom).toBe('generic')
  })
})
