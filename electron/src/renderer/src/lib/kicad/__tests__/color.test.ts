import { describe, expect, it } from 'vitest'
import { parseSExpr, serializeSExpr, type SExprList } from '../sexpr'
import {
  COLOR_UNSET,
  colorAtoms,
  isColorUnset,
  parseColorChild,
  parseColorNode,
  removeColorChild,
  setColorChild
} from '../color'

const list = (src: string): SExprList => parseSExpr(src) as SExprList

describe('color model', () => {
  it('parses a (color r g b a) node', () => {
    const c = parseColorNode(list('(color 132 0 132 1)'))
    expect(c).toEqual({ r: 132, g: 0, b: 132, a: 1 })
  })

  it('parses fractional alpha', () => {
    expect(parseColorNode(list('(color 194 194 194 0.5)')).a).toBe(0.5)
  })

  it('recognizes the unset sentinel', () => {
    expect(isColorUnset(parseColorNode(list('(color 0 0 0 0)')))).toBe(true)
    expect(isColorUnset(COLOR_UNSET)).toBe(true)
    expect(isColorUnset({ r: 0, g: 0, b: 0, a: 1 })).toBe(false)
  })

  it('reads a color child, undefined when absent', () => {
    expect(parseColorChild(list('(stroke (width 0.1) (color 1 2 3 1))'))).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 1
    })
    expect(parseColorChild(list('(stroke (width 0.1))'))).toBeUndefined()
  })

  it('creates a color child in place, leaving siblings untouched', () => {
    const stroke = list('(stroke (width 0.1) (type default))')
    setColorChild(stroke, { r: 255, g: 128, b: 0, a: 1 })
    // A list holding sub-lists always breaks (KiCad's own shape); the point
    // here is the order and that siblings survive.
    expect(serializeSExpr(stroke)).toBe(
      '(stroke\n\t(width 0.1)\n\t(type default)\n\t(color 255 128 0 1)\n)'
    )
    expect(parseColorChild(stroke)).toEqual({ r: 255, g: 128, b: 0, a: 1 })
  })

  it('updates an existing color child without reordering', () => {
    const stroke = list('(stroke (color 1 1 1 1) (width 0.1))')
    setColorChild(stroke, { r: 10, g: 20, b: 30, a: 0.25 })
    expect(serializeSExpr(stroke)).toBe('(stroke\n\t(color 10 20 30 0.25)\n\t(width 0.1)\n)')
  })

  it('formats alpha cleanly (no float noise)', () => {
    const at = 0
    const atoms = colorAtoms({ r: 0, g: 0, b: 0, a: 0.1 + 0.2 }, at)
    expect(atoms[3]).toMatchObject({ value: '0.3' })
  })

  it('clamps out-of-range channels', () => {
    const atoms = colorAtoms({ r: 300, g: -5, b: 128.6, a: 2 }, 0)
    expect(atoms.map((a) => (a.type === 'atom' ? a.value : ''))).toEqual(['255', '0', '129', '1'])
  })

  it('removes a color child', () => {
    const stroke = list('(stroke (width 0.1) (color 1 2 3 1))')
    removeColorChild(stroke)
    expect(serializeSExpr(stroke)).toBe('(stroke\n\t(width 0.1)\n)')
  })

  // Written in KiCad's own shape, which is what a round trip must reproduce.
  it('round-trips an untouched color byte-identically', () => {
    const src = '(fill\n\t(type color)\n\t(color 88 99 110 0.75)\n)'
    expect(serializeSExpr(parseSExpr(src))).toBe(src)
  })
})
