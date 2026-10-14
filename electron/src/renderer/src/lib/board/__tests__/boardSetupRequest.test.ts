import { describe, it, expect } from 'vitest'
import { boardSetupSectionRequest, requestBoardSetupSection } from '../boardSetupRequest'

describe('Board Setup section requests', () => {
  it('wait per board, and the same section asked twice is a new request', () => {
    const a = boardSetupSectionRequest(() => '/w/a.kicad_pcb')
    const b = boardSetupSectionRequest(() => '/w/b.kicad_pcb')
    expect(a.value).toBeNull()
    requestBoardSetupSection('/w/a.kicad_pcb', 'netClasses')
    const first = a.value
    expect(first?.id).toBe('netClasses')
    expect(b.value).toBeNull()
    requestBoardSetupSection('/w/a.kicad_pcb', 'netClasses')
    expect(a.value?.seq).not.toBe(first?.seq)
  })

  it('has nothing for a board with no path', () => {
    expect(boardSetupSectionRequest(() => null).value).toBeNull()
  })
})
