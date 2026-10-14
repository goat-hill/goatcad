import { describe, expect, test } from 'vitest'
import { placeAgentViewport } from '../agentViewportPlacement'

const VIEW = { width: 400, height: 200 }
const even = (inset: number): { top: number; right: number; bottom: number; left: number } => ({
  top: inset,
  right: inset,
  bottom: inset,
  left: inset
})

describe('placeAgentViewport', () => {
  test('a box in sight, even partly, shows as itself', () => {
    const rect = { left: 380, top: -50, width: 100, height: 100 }
    expect(placeAgentViewport(VIEW, rect, even(20))).toEqual({ kind: 'box', rect })
  })

  test('a box off to the right puts the marker on the right edge, pointing right', () => {
    expect(
      placeAgentViewport(VIEW, { left: 900, top: 90, width: 20, height: 20 }, even(20))
    ).toEqual({
      kind: 'marker',
      x: 380,
      y: 100,
      angle: 0
    })
  })

  test('a box above lands on the top edge, pointing up', () => {
    expect(
      placeAgentViewport(VIEW, { left: 190, top: -500, width: 20, height: 20 }, even(16))
    ).toEqual({
      kind: 'marker',
      x: 200,
      y: 16,
      angle: -90
    })
  })

  test('a box off a corner meets whichever edge the line reaches first', () => {
    // Center (200, 100) toward (-200, 500): down-left at 45°, the bottom edge first.
    const placed = placeAgentViewport(
      VIEW,
      { left: -210, top: 490, width: 20, height: 20 },
      even(20)
    )
    expect(placed).toMatchObject({ kind: 'marker', x: 120, y: 180, angle: 135 })
  })

  test('a box that only touches the edge is out of sight', () => {
    expect(
      placeAgentViewport(VIEW, { left: 400, top: 0, width: 10, height: 10 }, even(20)).kind
    ).toBe('marker')
  })

  test('a marker keeps clear of the chrome along its edge', () => {
    // A 60 px rail on the left: a box off to the left stops 60 px in, not 20.
    expect(
      placeAgentViewport(
        VIEW,
        { left: -300, top: 90, width: 20, height: 20 },
        { ...even(20), left: 60 }
      )
    ).toEqual({ kind: 'marker', x: 60, y: 100, angle: 180 })
  })
})
