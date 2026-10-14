import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMcpSessions, isSessionId } from '../mcpSessions'
import { createAgentViewportRoutes } from '../agentViewportRoutes'

afterEach(() => {
  vi.useRealTimers()
})

describe('agent sessions', () => {
  it('takes visible ASCII ids only', () => {
    expect(isSessionId('3f2a-b')).toBe(true)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId('has space')).toBe(false)
    expect(isSessionId('x'.repeat(129))).toBe(false)
    expect(isSessionId(undefined)).toBe(false)
  })

  it('ends a session once its last stream stays closed, not while a reconnect is in grace', () => {
    vi.useFakeTimers()
    const sessions = createMcpSessions({ graceMs: 100 })
    const ended: string[] = []
    sessions.onEnd((id) => void ended.push(id))
    const first = sessions.hold('a')
    const second = sessions.hold('a')
    first()
    vi.advanceTimersByTime(500)
    expect(ended).toEqual([])
    second()
    vi.advanceTimersByTime(50)
    // The client reconnects within the grace.
    const again = sessions.hold('a')
    vi.advanceTimersByTime(500)
    expect(ended).toEqual([])
    again()
    again()
    vi.advanceTimersByTime(100)
    expect(ended).toEqual(['a'])
  })

  it('ends a session at once on DELETE', () => {
    const sessions = createMcpSessions()
    const ended: string[] = []
    sessions.onEnd((id) => void ended.push(id))
    sessions.end('b')
    expect(ended).toEqual(['b'])
    expect(sessions.mint()).not.toBe(sessions.mint())
  })
})

describe('viewport routes', () => {
  it('keeps one id per connection, unique across windows, and forgets it as the connection ends', () => {
    const routes = createAgentViewportRoutes()
    const mine = routes.idFor('c1')
    routes.opened(mine, 1, 'c1')
    expect(routes.idFor('c1')).toBe(mine)
    const theirs = routes.idFor('c2')
    routes.opened(theirs, 2, 'c2')
    const anonymous = routes.idFor(undefined)
    expect(new Set([mine, theirs, anonymous]).size).toBe(3)
    expect(routes.windowOf(theirs)).toBe(2)
    expect(routes.end('c1')).toEqual({ id: mine, window: 1 })
    expect(routes.end('c1')).toBeNull()
    // A closed one is still routed, so its window can say why it closed.
    expect(routes.windowOf(mine)).toBe(1)
    expect(routes.idFor('c1')).not.toBe(mine)
  })
})
