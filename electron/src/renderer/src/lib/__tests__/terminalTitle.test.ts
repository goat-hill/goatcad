import { describe, expect, test } from 'vitest'
import { terminalLabel, terminalNeedsCloseConfirm, terminalStatus } from '../terminalTitle'
import type { TerminalState } from '../../../../preload/terminalTypes'

const idle: TerminalState = { shell: 'fish', process: null, exitCode: null, activity: 'unknown' }
const running: TerminalState = {
  shell: 'fish',
  process: 'claude',
  exitCode: null,
  activity: 'unknown'
}
const exited: TerminalState = { shell: 'fish', process: null, exitCode: 130, activity: 'unknown' }
const agent = (activity: TerminalState['activity']): TerminalState => ({ ...running, activity })

describe('terminalStatus', () => {
  test('classifies the three states', () => {
    expect(terminalStatus(idle)).toBe('idle')
    expect(terminalStatus(running)).toBe('running')
    expect(terminalStatus(exited)).toBe('exited')
  })

  test('an exited session is exited even if a process was still reported', () => {
    expect(terminalStatus({ ...running, exitCode: 0 })).toBe('exited')
  })

  test('an agent that reports narrows running to what it said', () => {
    // Alive at its prompt reads as idle, like a shell's: nothing to glance at.
    expect(terminalStatus(agent('idle'))).toBe('idle')
    expect(terminalStatus(agent('working'))).toBe('running')
    expect(terminalStatus(agent('attention'))).toBe('attention')
  })

  test('an agent that never reported is running while its process is', () => {
    expect(terminalStatus(agent('unknown'))).toBe('running')
  })

  test('a report outlives nothing: an exited agent is exited', () => {
    expect(terminalStatus({ ...agent('working'), exitCode: 0 })).toBe('exited')
  })

  test('treats an unpolled session as idle', () => {
    expect(terminalStatus(undefined)).toBe('idle')
  })
})

describe('terminalLabel', () => {
  test('prefers the running command over the shell', () => {
    expect(terminalLabel(running, 'bash')).toBe('claude')
  })

  test('falls back to the shell at a prompt', () => {
    expect(terminalLabel(idle, 'bash')).toBe('fish')
  })

  test('uses the fallback before the first poll answers', () => {
    expect(terminalLabel(undefined, 'bash')).toBe('bash')
  })
})

describe('terminalNeedsCloseConfirm', () => {
  test('only a running foreground process is worth a prompt', () => {
    expect(terminalNeedsCloseConfirm(running)).toBe(true)
    expect(terminalNeedsCloseConfirm(idle)).toBe(false)
    expect(terminalNeedsCloseConfirm(exited)).toBe(false)
  })

  test('an agent at its prompt closes unasked; one mid-turn does not', () => {
    expect(terminalNeedsCloseConfirm(agent('idle'))).toBe(false)
    expect(terminalNeedsCloseConfirm(agent('working'))).toBe(true)
    expect(terminalNeedsCloseConfirm(agent('attention'))).toBe(true)
    expect(terminalNeedsCloseConfirm(agent('unknown'))).toBe(true)
  })
})
