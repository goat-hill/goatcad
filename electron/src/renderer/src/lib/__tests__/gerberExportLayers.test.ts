import { describe, test, expect } from 'vitest'
import { defaultExportLayers } from '../gerberExportLayers'
import { KICAD_LAYER_COLORS } from '../kicad/layers'

describe('defaultExportLayers', () => {
  test('a 2-layer board has exactly two copper layers, F.Cu and B.Cu', () => {
    const copper = defaultExportLayers(2).filter((l) => l.category === 'copper')
    expect(copper.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu'])
  })

  test('a 4-layer board inserts inner copper between front and back', () => {
    const copper = defaultExportLayers(4).filter((l) => l.category === 'copper')
    expect(copper.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })

  test('the board outline is present and on by default', () => {
    const edge = defaultExportLayers(2).find((l) => l.name === 'Edge.Cuts')
    expect(edge).toBeDefined()
    expect(edge!.defaultOn).toBe(true)
    expect(edge!.category).toBe('board')
  })

  test('fabrication layers are included but off by default', () => {
    const fab = defaultExportLayers(2).filter((l) => l.name === 'F.Fab' || l.name === 'B.Fab')
    expect(fab).toHaveLength(2)
    expect(fab.every((l) => !l.defaultOn)).toBe(true)
  })

  test('every layer carries the shared KiCad color', () => {
    for (const layer of defaultExportLayers(4)) {
      expect(layer.color).toBe(KICAD_LAYER_COLORS[layer.name])
    }
  })
})
