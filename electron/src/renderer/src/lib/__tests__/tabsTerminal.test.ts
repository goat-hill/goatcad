import { describe, expect, test } from 'vitest'
import {
  isSingleTerminalKind,
  isTerminalTab,
  terminalSessionId,
  terminalTab,
  terminalTabKind,
  terminalTabPath
} from '../tabs'

describe('terminal tab paths', () => {
  test('round-trips the kind and the session id', () => {
    const path = terminalTabPath('claude', 'term-7')
    expect(isTerminalTab(path)).toBe(true)
    expect(terminalTabKind(path)).toBe('claude')
    expect(terminalSessionId(path)).toBe('term-7')
  })

  test('an unrecognized kind reads as a plain shell rather than throwing', () => {
    expect(terminalTabKind('goatcad://terminal/whatever/term-1')).toBe('shell')
  })

  test('does not claim other virtual tabs', () => {
    expect(isTerminalTab('goatcad://settings')).toBe(false)
    expect(isTerminalTab(null)).toBe(false)
  })

  test('only the agents are one per window', () => {
    expect(isSingleTerminalKind('shell')).toBe(false)
    expect(isSingleTerminalKind('claude')).toBe(true)
    expect(isSingleTerminalKind('codex')).toBe(true)
  })

  test('the tab carries its fallback title', () => {
    expect(terminalTab('codex', 'term-2', 'Codex')).toEqual({
      name: 'Codex',
      path: 'goatcad://terminal/codex/term-2'
    })
  })
})
