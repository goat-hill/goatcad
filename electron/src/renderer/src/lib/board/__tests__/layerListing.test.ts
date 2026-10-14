import { describe, expect, it } from 'vitest'
import { boardLayerListing, footprintLayerListing, layerTitle } from '../layerListing'
import type { KicadBoard } from '../../kicad/board'

const label = (key: string): string => key

describe('layer listings', () => {
  it('lists a board’s palette layers under their own names, all activatable', () => {
    const board = {
      layers: [{ name: 'F.Cu', userName: 'Top' }, { name: 'NotALayer' }, { name: 'B.Cu' }]
    } as unknown as KicadBoard
    const listing = boardLayerListing(board, label)
    expect(listing.layers).toEqual([
      { name: 'F.Cu', title: 'Top' },
      { name: 'B.Cu', title: undefined }
    ])
    expect(listing.activatable).toEqual(['F.Cu', 'B.Cu'])
    expect(layerTitle(listing, 'F.Cu')).toBe('Top')
    expect(layerTitle(listing, 'B.Cu')).toBe('B.Cu')
  })

  it('is empty for no board', () => {
    expect(boardLayerListing(null, label).layers).toEqual([])
  })

  it('gives the footprint editor its fixed set, every layer activatable', () => {
    const listing = footprintLayerListing(label)
    expect(listing.layers.map((l) => l.name)).toContain('F.Cu')
    expect(listing.activatable).toBeUndefined()
    expect(listing.presets.length).toBeGreaterThan(0)
  })
})
