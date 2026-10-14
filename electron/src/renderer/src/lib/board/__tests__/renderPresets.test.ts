import { describe, expect, test } from 'vitest'
import { boardRenderPresetLayers } from '../renderPresets'

const FOUR_LAYER = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']

describe('render.board presets', () => {
  test('copper is the copper the board has, in stack order, with the outline', () => {
    expect(boardRenderPresetLayers('copper', FOUR_LAYER)).toEqual([
      'F.Cu',
      'In1.Cu',
      'In2.Cu',
      'B.Cu',
      'Edge.Cuts'
    ])
    expect(boardRenderPresetLayers('copper', ['F.Cu', 'B.Cu'])).toEqual([
      'F.Cu',
      'B.Cu',
      'Edge.Cuts'
    ])
  })

  test('front and back are one side each, the same layers mirrored', () => {
    const front = boardRenderPresetLayers('front', FOUR_LAYER)!
    expect(front).toEqual(['F.Cu', 'F.SilkS', 'F.Fab', 'F.CrtYd', 'Edge.Cuts'])
    expect(boardRenderPresetLayers('back', FOUR_LAYER)).toEqual(
      front.map((layer) => layer.replace(/^F\./, 'B.'))
    )
  })

  test('silk draws both sides with pads as mask openings and no copper', () => {
    const silk = boardRenderPresetLayers('silk', FOUR_LAYER)!
    expect(silk).toEqual(expect.arrayContaining(['F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask']))
    expect(silk.some((layer) => layer.endsWith('.Cu'))).toBe(false)
  })

  test('all draws every layer', () => {
    expect(boardRenderPresetLayers('all', FOUR_LAYER)).toBeNull()
  })
})
