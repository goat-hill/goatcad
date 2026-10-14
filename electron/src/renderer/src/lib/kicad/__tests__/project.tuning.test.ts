import { describe, expect, test } from 'vitest'
import {
  DEFAULT_TUNING_PATTERN_SETTINGS,
  extractTuningPatternSettings,
  patchTuningPatternSettings
} from '../project'

describe('board.design_settings.tuning_pattern_settings (T6)', () => {
  const text = JSON.stringify({
    board: {
      design_settings: {
        other: 1,
        tuning_pattern_settings: {
          diff_pair_defaults: {
            corner_radius_percentage: 100,
            corner_style: 0,
            max_amplitude: 1.5,
            min_amplitude: 0.1,
            single_sided: true,
            spacing: 0.8,
            future_key: 'kept'
          },
          // Missing keys read as KiCad's MEANDER_SETTINGS constructor leaves them.
          single_track_defaults: { max_amplitude: 2 }
        }
      }
    },
    meta: { version: 3 }
  })

  test('reads the three sets, each with KiCad’s own default where it saves none', () => {
    const s = extractTuningPatternSettings(text)!
    expect(s.pair).toEqual({
      minAmplitude: 0.1,
      maxAmplitude: 1.5,
      spacing: 0.8,
      cornerRadiusPercent: 100,
      singleSided: true
    })
    expect(s.single).toEqual({ ...DEFAULT_TUNING_PATTERN_SETTINGS.single, maxAmplitude: 2 })
    expect(s.skew).toEqual(DEFAULT_TUNING_PATTERN_SETTINGS.skew)
    expect(extractTuningPatternSettings('nope')).toBeNull()
  })

  test('KiCad’s defaults: a pair’s spacing is 1 mm, the others 0.6 mm', () => {
    const s = extractTuningPatternSettings('{}')!
    expect(s).toEqual(DEFAULT_TUNING_PATTERN_SETTINGS)
    expect(s.pair.spacing).toBe(1)
    expect(s.single.spacing).toBe(0.6)
    expect(s.skew.spacing).toBe(0.6)
    expect(s.single).toMatchObject({ minAmplitude: 0.2, maxAmplitude: 1, cornerRadiusPercent: 80 })
  })

  test('writes all three as KiCad does, keeping what it does not model', () => {
    const s = extractTuningPatternSettings(text)!
    const patched = patchTuningPatternSettings(text, {
      ...s,
      single: { ...s.single, spacing: 0.75 }
    })!
    const root = JSON.parse(patched)
    const tps = root.board.design_settings.tuning_pattern_settings
    expect(tps.single_track_defaults).toEqual({
      corner_radius_percentage: 80,
      corner_style: 1,
      max_amplitude: 2,
      min_amplitude: 0.2,
      single_sided: false,
      spacing: 0.75
    })
    // An entry read keeps its corner style and any key from a later KiCad.
    expect(tps.diff_pair_defaults.corner_style).toBe(0)
    expect(tps.diff_pair_defaults.future_key).toBe('kept')
    expect(Object.keys(tps.diff_pair_skew_defaults)).toEqual([
      'corner_radius_percentage',
      'corner_style',
      'max_amplitude',
      'min_amplitude',
      'single_sided',
      'spacing'
    ])
    expect(root.board.design_settings.other).toBe(1)
    expect(root.meta).toEqual({ version: 3 })
    // Read back, it is what was written.
    expect(extractTuningPatternSettings(patched)!.single.spacing).toBe(0.75)
  })
})
