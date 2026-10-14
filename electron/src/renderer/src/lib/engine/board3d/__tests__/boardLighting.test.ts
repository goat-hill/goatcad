import { describe, expect, test } from 'vitest'
import { BOARD_RIG, applyBoardLighting, createBoardRig } from '../boardLighting'

describe('applyBoardLighting', () => {
  test('studio is the rig as built', () => {
    const rig = createBoardRig()
    expect(applyBoardLighting(rig, 'studio')).toBe(BOARD_RIG.environment)
    expect(rig.key.intensity).toBe(BOARD_RIG.key)
    expect(rig.fill.intensity).toBe(BOARD_RIG.fill)
  })

  test('a preset is set whole, whatever came before it', () => {
    const rig = createBoardRig()
    expect(applyBoardLighting(rig, 'flat')).toBe(0)
    expect(rig.key.intensity).toBe(0)
    expect(rig.ambient.intensity).toBeGreaterThan(1)

    applyBoardLighting(rig, 'dramatic')
    expect(rig.key.intensity).toBeGreaterThan(BOARD_RIG.key)

    applyBoardLighting(rig, 'studio')
    expect(rig.key.intensity).toBe(BOARD_RIG.key)
    expect(rig.overhead.intensity).toBe(BOARD_RIG.overhead)
    expect(rig.fill.intensity).toBe(BOARD_RIG.fill)
    expect(rig.ambient.intensity).toBe(BOARD_RIG.ambient)
  })
})
