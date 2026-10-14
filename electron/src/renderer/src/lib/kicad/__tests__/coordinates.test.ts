import { describe, it, expect } from 'vitest'
import {
  parseValueToNanometers,
  formatNanometersToUnit,
  formatKicadNumber,
  formatNmAtom,
  mmAtomToNm,
  mmToNm,
  nm,
  nmToMm,
  NM_INT32_MAX,
  pointsEqualNm,
  spacingToMm,
  mmToSpacing,
  type Nm
} from '../coordinates'

describe('pointsEqualNm', () => {
  it('is exact integer equality — the migration retired the tolerance', () => {
    expect(pointsEqualNm({ x: 1270000, y: 0 }, { x: 1270000, y: 0 })).toBe(true)
    expect(pointsEqualNm({ x: 1270000, y: 0 }, { x: 1270001, y: 0 })).toBe(false)
  })
})

describe('formatKicadNumber', () => {
  it('writes clean values unchanged', () => {
    expect(formatKicadNumber(1.27)).toBe('1.27')
    expect(formatKicadNumber(0)).toBe('0')
    expect(formatKicadNumber(-2.54)).toBe('-2.54')
    expect(formatKicadNumber(100)).toBe('100')
  })

  it('strips the binary64 tails that repeated mm arithmetic produces', () => {
    // What accumulating 1.27 mm eleven times, and 50 mil twenty times, actually
    // lands on — both would otherwise be written verbatim.
    let x = 1.27
    for (let i = 0; i < 10; i++) x += 1.27
    expect(formatKicadNumber(x)).toBe('13.97')

    let y = 0
    for (let i = 0; i < 20; i++) y += 50 * 0.0254
    expect(formatKicadNumber(y)).toBe('25.4')
  })

  it('never emits exponential notation, which KiCad cannot parse', () => {
    // A 90° rotation of 2.54 mm: cos(pi/2) is not exactly 0, and String() would
    // render the residue as '1.5553014349171386e-16'.
    const residue = Math.cos(Math.PI / 2) * 2.54
    expect(String(residue)).toContain('e-')
    expect(formatKicadNumber(residue)).toBe('0')
    expect(formatKicadNumber(1e-9)).toBe('0')
    expect(formatKicadNumber(-1e-9)).toBe('0')
  })

  it('keeps the full 1 nm grid KiCad writes on', () => {
    expect(formatKicadNumber(0.000001)).toBe('0.000001')
    expect(formatKicadNumber(0.0000004)).toBe('0')
    expect(formatKicadNumber(123.456789)).toBe('123.456789')
  })

  it('normalizes negative zero, so a value never writes as -0', () => {
    expect(formatKicadNumber(-0)).toBe('0')
    expect(formatKicadNumber(-0.0000001)).toBe('0')
  })
})

describe('integer-nanometer conversions (Nm)', () => {
  it('mmToNm rounds fractional mm onto the 1 nm grid', () => {
    expect(mmToNm(1.27)).toBe(1270000)
    expect(mmToNm(-0.0254)).toBe(-25400)
    let x = 1.27
    for (let i = 0; i < 10; i++) x += 1.27
    expect(mmToNm(x)).toBe(13970000)
  })

  it('nmToMm inverts mmToNm for every on-grid value', () => {
    for (const v of [0, 1270000, -25400, 13970000, 123456789, NM_INT32_MAX]) {
      expect(mmToNm(nmToMm(v as Nm))).toBe(v)
    }
  })

  it('nm() re-brands fractional arithmetic results by rounding', () => {
    expect(nm(2.6)).toBe(3)
    expect(nm(-2.5)).toBe(-2)
    expect(nm(1270000)).toBe(1270000)
  })

  it('mmAtomToNm reads KiCad decimal atoms losslessly', () => {
    expect(mmAtomToNm('1.27')).toBe(1270000)
    expect(mmAtomToNm('-0.0254')).toBe(-25400)
    expect(mmAtomToNm('0.000001')).toBe(1)
    expect(mmAtomToNm('2147.483647')).toBe(NM_INT32_MAX)
  })

  it('formatNmAtom emits the canonical decimal and round-trips exactly', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [1270000, '1.27'],
      [-25400, '-0.0254'],
      [1, '0.000001'],
      [-1, '-0.000001'],
      [13970000, '13.97'],
      [123456789, '123.456789'],
      [NM_INT32_MAX, '2147.483647'],
      [-NM_INT32_MAX, '-2147.483647']
    ]
    for (const [v, text] of cases) {
      expect(formatNmAtom(v as Nm)).toBe(text)
      expect(mmAtomToNm(formatNmAtom(v as Nm))).toBe(v)
    }
  })

  it('formatNmAtom never writes -0 and never goes exponential', () => {
    expect(formatNmAtom(-0 as Nm)).toBe('0')
    expect(formatNmAtom(nm(-0.4))).toBe('0')
    for (const v of [1, -1, 10, -10, 100, NM_INT32_MAX]) {
      expect(formatNmAtom(v as Nm)).not.toContain('e')
    }
  })

  it('agrees byte-for-byte with formatKicadNumber over a dense sweep', () => {
    // The two writers must be indistinguishable for on-grid values, or the
    // migration would dirty diffs it promises not to touch. Sweep magnitudes
    // from 1 nm to the int32 edge, plus adversarial decimals.
    const values = [
      1,
      7,
      25400,
      254000,
      1270000,
      3141593,
      99999999,
      100000001,
      2540000000,
      NM_INT32_MAX,
      NM_INT32_MAX - 1
    ]
    for (const base of values) {
      for (const v of [base, -base]) {
        expect(formatNmAtom(v as Nm)).toBe(formatKicadNumber(v / 1e6))
      }
    }
    for (let i = 0; i < 5000; i++) {
      // Deterministic pseudo-random sweep (no Math.random in tests): a simple
      // LCG over the int32 range.
      const v = ((i * 2654435761) % NM_INT32_MAX) - ((i * 40503) % 1000000)
      expect(formatNmAtom(v as Nm)).toBe(formatKicadNumber(v / 1e6))
    }
  })
})

describe('Coordinate Unit Parsing and Formatting', () => {
  describe('parseValueToNanometers', () => {
    it('should parse simple numbers using the default unit', () => {
      expect(parseValueToNanometers('10', 'mm')).toBe(10000000)
      expect(parseValueToNanometers('-5.5', 'mm')).toBe(-5500000)
      expect(parseValueToNanometers('100', 'mil')).toBe(2540000)
      expect(parseValueToNanometers('0.1', 'mil')).toBe(2540)
    })

    it('should parse numbers with explicit mm unit', () => {
      expect(parseValueToNanometers('1.5mm', 'mil')).toBe(1500000)
      expect(parseValueToNanometers('  -2.4   mm ', 'mil')).toBe(-2400000)
      expect(parseValueToNanometers('10MM', 'mil')).toBe(10000000)
    })

    it('should parse numbers with explicit mil/mils unit', () => {
      expect(parseValueToNanometers('100mil', 'mm')).toBe(2540000)
      expect(parseValueToNanometers(' 50 mils', 'mm')).toBe(1270000)
      expect(parseValueToNanometers('-2.5Mil', 'mm')).toBe(-63500)
    })

    it('should parse inches, by suffix or as the default unit', () => {
      expect(parseValueToNanometers('0.1in', 'mm')).toBe(2540000)
      expect(parseValueToNanometers('1 inch', 'mm')).toBe(25400000)
      expect(parseValueToNanometers('2 inches', 'mil')).toBe(50800000)
      expect(parseValueToNanometers('0.05"', 'mm')).toBe(1270000)
      expect(parseValueToNanometers('0.05', 'in')).toBe(1270000)
    })

    it('should handle decimals without leading zero', () => {
      expect(parseValueToNanometers('.5', 'mm')).toBe(500000)
      expect(parseValueToNanometers('-.25mil', 'mm')).toBe(-6350)
    })

    it('should throw on invalid formats', () => {
      expect(() => parseValueToNanometers('abc', 'mm')).toThrow()
      expect(() => parseValueToNanometers('1.2.3', 'mm')).toThrow()
      expect(() => parseValueToNanometers('10px', 'mm')).toThrow()
    })
  })

  describe('spacingToMm / mmToSpacing', () => {
    it('convert every unit through its exact factor', () => {
      expect(spacingToMm(0.05, 'in')).toBeCloseTo(1.27, 12)
      expect(spacingToMm(50, 'mil')).toBeCloseTo(1.27, 12)
      expect(mmToSpacing(1.27, 'in')).toBeCloseTo(0.05, 12)
      expect(mmToSpacing(2.54, 'mm')).toBe(2.54)
    })
  })

  describe('formatNanometersToUnit', () => {
    it('should format to mm correctly', () => {
      expect(formatNanometersToUnit(10000000, 'mm')).toBe('10')
      expect(formatNanometersToUnit(1270000, 'mm')).toBe('1.27')
      expect(formatNanometersToUnit(-5500000, 'mm')).toBe('-5.5')
      expect(formatNanometersToUnit(2540000, 'mm')).toBe('2.54')
    })

    it('should format to mil correctly', () => {
      expect(formatNanometersToUnit(2540000, 'mil')).toBe('100')
      expect(formatNanometersToUnit(1270000, 'mil')).toBe('50')
      expect(formatNanometersToUnit(-63500, 'mil')).toBe('-2.5')
    })

    it('should format to inches at a hundredth of a mil', () => {
      expect(formatNanometersToUnit(2540000, 'in')).toBe('0.1')
      expect(formatNanometersToUnit(1270000, 'in')).toBe('0.05')
      expect(formatNanometersToUnit(254, 'in')).toBe('0.00001')
      expect(formatNanometersToUnit(1000000, 'in')).toBe('0.03937')
    })
  })
})
