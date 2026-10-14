import { describe, expect, it } from 'vitest'
import { footprintGestureTool } from '../footprintTools'
import { pcbToolClick, pcbToolShape } from '../../board/pcbTools'

describe('footprintGestureTool', () => {
  it('lends the shape tools the board’s gestures', () => {
    expect(footprintGestureTool('line')).toBe('line')
    expect(footprintGestureTool('arc')).toBe('arc')
    expect(footprintGestureTool('rectangle')).toBe('rectangle')
    expect(footprintGestureTool('circle')).toBe('circle')
    expect(footprintGestureTool('polygon')).toBe('polygon')
  })

  it('leaves the one-click tools their own', () => {
    for (const tool of ['select', 'pad', 'text', 'anchor', 'gridOrigin'] as const) {
      expect(footprintGestureTool(tool)).toBeNull()
    }
  })

  it('commits a circle on its second click, center then rim', () => {
    const first = pcbToolClick('circle', [], { x: 0, y: 0 })
    expect(first.commit).toBeNull()
    const second = pcbToolClick('circle', first.draft, { x: 1_000_000, y: 0 })
    expect(pcbToolShape('circle', second.commit!)).toEqual({
      kind: 'circle',
      center: { x: 0, y: 0 },
      end: { x: 1_000_000, y: 0 }
    })
  })
})
