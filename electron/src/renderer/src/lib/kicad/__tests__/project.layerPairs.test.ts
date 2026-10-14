import { describe, expect, test } from 'vitest'
import { extractLayerPairs, patchLayerPairs } from '../project'

describe('board.layer_pairs (R42)', () => {
  const text = JSON.stringify({
    board: {
      layer_pairs: [
        { bottomLayer: 2, enabled: true, name: 'Outer', topLayer: 0 },
        { bottomLayer: 6, enabled: false, topLayer: 4 }
      ],
      other: 1
    },
    meta: { version: 3 }
  })

  test('reads KiCad’s ids as layer names', () => {
    expect(extractLayerPairs(text)).toEqual([
      { top: 'F.Cu', bottom: 'B.Cu', enabled: true, name: 'Outer' },
      { top: 'In1.Cu', bottom: 'In2.Cu', enabled: false }
    ])
    expect(extractLayerPairs('{}')).toEqual([])
    expect(extractLayerPairs('nope')).toBeNull()
  })

  test('writes them back as KiCad does, leaving the rest alone', () => {
    const patched = patchLayerPairs(text, [{ top: 'F.Cu', bottom: 'In1.Cu', enabled: true }])!
    const root = JSON.parse(patched)
    expect(root.board.layer_pairs).toEqual([{ bottomLayer: 4, enabled: true, topLayer: 0 }])
    expect(root.board.other).toBe(1)
    expect(root.meta).toEqual({ version: 3 })
  })
})
