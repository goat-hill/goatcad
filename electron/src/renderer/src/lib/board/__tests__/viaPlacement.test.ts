import { describe, expect, test } from 'vitest'
import { nextLayerPair, viaFileForm, viaSpan, viaTarget } from '../viaPlacement'

// docs/router-behavior.md R35, R40–R42.

const four = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
const outer = { top: 'F.Cu', bottom: 'B.Cu' }
const inner = { top: 'In1.Cu', bottom: 'In2.Cu' }

describe('viaTarget', () => {
  test('R35: a through via goes to the layer of the copper it is headed for', () => {
    expect(
      viaTarget({ type: 'through', current: 'F.Cu', pair: outer, copper: four, toward: ['In2.Cu'] })
    ).toEqual({ target: 'In2.Cu', type: 'through' })
  })

  test('R40: toward copper on every layer, or none, it crosses the pair', () => {
    expect(
      viaTarget({ type: 'through', current: 'F.Cu', pair: outer, copper: four, toward: four })!
        .target
    ).toBe('B.Cu')
    expect(viaTarget({ type: 'through', current: 'B.Cu', pair: outer, copper: four })!.target).toBe(
      'F.Cu'
    )
    // Off the pair, to its top.
    expect(
      viaTarget({ type: 'through', current: 'In1.Cu', pair: outer, copper: four })!.target
    ).toBe('F.Cu')
  })

  test('already on the layer it is headed for, it crosses the pair', () => {
    expect(
      viaTarget({ type: 'through', current: 'F.Cu', pair: outer, copper: four, toward: ['F.Cu'] })!
        .target
    ).toBe('B.Cu')
  })

  test('R41: a blind via crosses the pair, or goes from off it to its top', () => {
    expect(viaTarget({ type: 'blind', current: 'In1.Cu', pair: inner, copper: four })).toEqual({
      target: 'In2.Cu',
      type: 'blind'
    })
    expect(viaTarget({ type: 'blind', current: 'F.Cu', pair: inner, copper: four })).toEqual({
      target: 'In1.Cu',
      type: 'blind'
    })
  })

  test('a blind via or microvia joining the outer layers is a through via', () => {
    expect(viaTarget({ type: 'micro', current: 'F.Cu', pair: outer, copper: four })).toEqual({
      target: 'B.Cu',
      type: 'through'
    })
  })

  test('a via that would go nowhere is none', () => {
    expect(
      viaTarget({
        type: 'blind',
        current: 'In1.Cu',
        pair: { top: 'In1.Cu', bottom: 'In1.Cu' },
        copper: four
      })
    ).toBeNull()
  })
})

describe('viaSpan and viaFileForm', () => {
  test('a through via spans every layer and is written without a marker', () => {
    expect(viaSpan('through', 'F.Cu', 'In1.Cu', four)).toEqual(four)
    expect(viaFileForm('through', four, four)).toEqual({ layers: ['F.Cu', 'B.Cu'] })
  })

  test('a blind via spans its layers, written blind from an outer one and buried between inner ones', () => {
    const span = viaSpan('blind', 'In1.Cu', 'F.Cu', four)
    expect(span).toEqual(['F.Cu', 'In1.Cu'])
    expect(viaFileForm('blind', span, four)).toEqual({ layers: ['F.Cu', 'In1.Cu'], type: 'blind' })
    expect(viaFileForm('blind', viaSpan('blind', 'In1.Cu', 'In2.Cu', four), four)).toEqual({
      layers: ['In1.Cu', 'In2.Cu'],
      type: 'buried'
    })
  })

  test('a microvia is written micro', () => {
    expect(viaFileForm('micro', ['F.Cu', 'In1.Cu'], four).type).toBe('micro')
  })
})

describe('nextLayerPair', () => {
  test('R42: steps through the enabled presets, round to the first', () => {
    const presets = [
      { ...outer, enabled: true },
      { ...inner, enabled: false },
      { top: 'F.Cu', bottom: 'In1.Cu', enabled: true }
    ]
    expect(nextLayerPair(presets, outer)).toMatchObject({ top: 'F.Cu', bottom: 'In1.Cu' })
    expect(nextLayerPair(presets, { top: 'F.Cu', bottom: 'In1.Cu' })).toMatchObject(outer)
    expect(nextLayerPair([], outer)).toBeNull()
  })
})
