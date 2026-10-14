import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  boardAutomationFor,
  DEFAULT_AUTOMATION,
  resetBoardAutomation,
  setBoardAutomation
} from '../boardAutomation'

afterEach(() => {
  resetBoardAutomation()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('board automation', () => {
  test('is per board, on the defaults until set', () => {
    const a = boardAutomationFor(() => '/w/a.kicad_pcb')
    const b = boardAutomationFor(() => '/w/b.kicad_pcb')
    expect(a.value).toEqual(DEFAULT_AUTOMATION)
    setBoardAutomation('/w/a.kicad_pcb', { zoneFill: 'off' })
    expect(a.value).toEqual({ zoneFill: 'off', drc: 'greedy' })
    expect(b.value).toEqual(DEFAULT_AUTOMATION)
  })

  test('stores only what differs from the defaults', () => {
    const updates: unknown[] = []
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        getConfig: async () => ({ boardAutomation: {} }),
        onConfigChanged: () => () => {},
        updateConfig: vi.fn(async (patch: unknown) => updates.push(patch))
      }
    }
    setBoardAutomation('/w/a.kicad_pcb', { drc: 'full' })
    setBoardAutomation('/w/a.kicad_pcb', { drc: 'greedy', zoneFill: 'off' })
    setBoardAutomation('/w/a.kicad_pcb', { zoneFill: 'full' })
    expect(updates).toEqual([
      { boardAutomation: { '/w/a.kicad_pcb': { drc: 'full' } } },
      { boardAutomation: { '/w/a.kicad_pcb': { zoneFill: 'off' } } },
      { boardAutomation: {} }
    ])
  })
})
