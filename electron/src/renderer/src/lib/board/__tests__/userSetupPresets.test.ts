import { afterEach, describe, expect, test } from 'vitest'
import {
  __resetUserSetupPresets,
  findAnyProfile,
  findAnyStackupPreset,
  isUserPresetId,
  removeUserProfile,
  removeUserStackup,
  saveUserProfile,
  saveUserStackup,
  userProfiles
} from '../userSetupPresets'
import { findProfile } from '../../manufacturingProfiles'

afterEach(() => __resetUserSetupPresets())

describe('saved Board Setup presets', () => {
  const jlc = findProfile('jlcpcb-2l-1.6')!

  test('a saved configuration resolves beside the shipped ones, and a same name replaces it', () => {
    const id = saveUserProfile('House rules', jlc.rules, jlc.defaults)!
    expect(isUserPresetId(id)).toBe(true)
    expect(findAnyProfile(id)?.rules).toEqual(jlc.rules)
    saveUserProfile('House rules', { ...jlc.rules, minClearance: 0.2 }, jlc.defaults)
    expect(userProfiles()).toHaveLength(1)
    expect(findAnyProfile(id)?.rules.minClearance).toBe(0.2)
  })

  test('a name removed and saved again is a new preset, not the old one back', () => {
    const first = saveUserStackup('Thin', { ...jlc.stackups[1].spec })!
    removeUserStackup(first)
    const second = saveUserStackup('Thin', { ...jlc.stackups[1].spec })!
    expect(second).not.toBe(first)
    expect(findAnyStackupPreset(first)).toBeNull()
  })

  test('only a saved preset can be removed', () => {
    const id = saveUserStackup('Thin', { ...jlc.stackups[1].spec })!
    expect(findAnyStackupPreset(id)?.spec.boardThickness).toBe(0.8)
    removeUserStackup(id)
    expect(findAnyStackupPreset(id)).toBeNull()
    removeUserProfile(jlc.id)
    expect(findAnyProfile(jlc.id)).not.toBeNull()
  })
})
