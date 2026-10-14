import { describe, expect, it } from 'vitest'
import {
  identifyGerberLayer,
  isGerberFile,
  layerFromFileFunction,
  layerFromFilename
} from '../files'
import { evalExpr } from '../macro'

describe('isGerberFile', () => {
  it('accepts .gbr and the Protel extension family', () => {
    expect(isGerberFile('board-F_Cu.gbr')).toBe(true)
    expect(isGerberFile('board.GTL')).toBe(true)
    expect(isGerberFile('board.gbs')).toBe(true)
    expect(isGerberFile('board.g2')).toBe(true)
    expect(isGerberFile('board.gko')).toBe(true)
  })

  it('rejects non-gerber files', () => {
    expect(isGerberFile('board.kicad_pcb')).toBe(false)
    expect(isGerberFile('board.gbrjob')).toBe(false)
    expect(isGerberFile('notes.txt')).toBe(false)
    expect(isGerberFile('board.drl')).toBe(false)
  })
})

describe('layerFromFileFunction (X2)', () => {
  it('maps copper by layer number and side', () => {
    expect(layerFromFileFunction('Copper,L1,Top').kicadLayer).toBe('F.Cu')
    expect(layerFromFileFunction('Copper,L6,Bot').kicadLayer).toBe('B.Cu')
    expect(layerFromFileFunction('Copper,L3,Inr').kicadLayer).toBe('In2.Cu')
  })

  it('maps the non-copper functions', () => {
    expect(layerFromFileFunction('Soldermask,Bot').kicadLayer).toBe('B.Mask')
    expect(layerFromFileFunction('Legend,Top').kicadLayer).toBe('F.SilkS')
    expect(layerFromFileFunction('Paste,Top').kicadLayer).toBe('F.Paste')
    expect(layerFromFileFunction('Profile,NP').kicadLayer).toBe('Edge.Cuts')
    expect(layerFromFileFunction(null).kicadLayer).toBeNull()
    expect(layerFromFileFunction('SomethingWeird').kicadLayer).toBeNull()
  })
})

describe('layerFromFilename', () => {
  it('maps KiCad plot suffixes', () => {
    expect(layerFromFilename('canary-F_Cu.gbr').kicadLayer).toBe('F.Cu')
    expect(layerFromFilename('canary-In2_Cu.gbr').kicadLayer).toBe('In2.Cu')
    expect(layerFromFilename('canary-B_Silkscreen.gbr').kicadLayer).toBe('B.SilkS')
    expect(layerFromFilename('canary-Edge_Cuts.gbr').kicadLayer).toBe('Edge.Cuts')
    expect(layerFromFilename('canary-F_Mask.gbr').kicadLayer).toBe('F.Mask')
  })

  it('maps Protel extensions', () => {
    expect(layerFromFilename('board.gtl').kicadLayer).toBe('F.Cu')
    expect(layerFromFilename('board.gbo').kicadLayer).toBe('B.SilkS')
    expect(layerFromFilename('board.g1').kicadLayer).toBe('In1.Cu')
    expect(layerFromFilename('board.gm1').kicadLayer).toBe('Edge.Cuts')
  })

  it('returns null for unrecognized names', () => {
    expect(layerFromFilename('mystery.gbr').kicadLayer).toBeNull()
  })
})

describe('identifyGerberLayer', () => {
  it('prefers the X2 attribute over the filename', () => {
    expect(identifyGerberLayer('board.gtl', 'Soldermask,Top').kicadLayer).toBe('F.Mask')
  })

  it('falls back to the filename', () => {
    expect(identifyGerberLayer('board.gtl', null).kicadLayer).toBe('F.Cu')
  })

  it('orders back → inner → front → outline', () => {
    const order = (name: string, fn: string | null): number => identifyGerberLayer(name, fn).order
    expect(order('a.gbl', null)).toBeLessThan(order('a.g1', null))
    expect(order('a.g2', null)).toBeLessThan(order('a.g1', null))
    expect(order('a.g1', null)).toBeLessThan(order('a.gtl', null))
    expect(order('a.gtl', null)).toBeLessThan(order('a.gko', null))
    expect(order('mystery.gbr', null)).toBeLessThan(order('a.gko', null))
  })
})

describe('macro expression evaluator', () => {
  it('follows precedence and unary minus', () => {
    const vars = new Map<number, number>()
    expect(evalExpr('1+2x3', vars)).toBe(7)
    expect(evalExpr('(1+2)x3', vars)).toBe(9)
    expect(evalExpr('-4/2', vars)).toBe(-2)
  })

  it('reads variables, defaulting undefined ones to 0', () => {
    const vars = new Map<number, number>([
      [1, 2],
      [2, 3]
    ])
    expect(evalExpr('$1x($2+1)', vars)).toBe(8)
    expect(evalExpr('$9+5', vars)).toBe(5)
  })
})
