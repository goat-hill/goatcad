import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentStatusServer } from '../agentStatusServer'

describe('AgentStatusServer', () => {
  let server: AgentStatusServer
  afterEach(() => server.stop())

  const post = (url: string): Promise<number> =>
    fetch(url, { method: 'POST' }).then((r) => r.status)

  test('takes a report for a registered session and hands it on', async () => {
    const report = vi.fn()
    server = new AgentStatusServer(report)
    await server.start()
    const url = server.register('term-1')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/term-1\/[A-Za-z0-9_-]+$/)
    expect(await post(`${url}/working`)).toBe(204)
    expect(await post(`${url}/attention`)).toBe(204)
    expect(report.mock.calls).toEqual([
      ['term-1', 'working'],
      ['term-1', 'attention']
    ])
  })

  test('refuses a wrong token, an unknown session, a made-up activity, and a GET', async () => {
    const report = vi.fn()
    server = new AgentStatusServer(report)
    const port = await server.start()
    const url = server.register('term-2')
    expect(await post(`${url}x/idle`)).toBe(404)
    expect(await post(`http://127.0.0.1:${port}/agent/term-9/${url.split('/').pop()}/idle`)).toBe(
      404
    )
    expect(await post(`${url}/busy`)).toBe(404)
    expect((await fetch(`${url}/idle`)).status).toBe(404)
    expect(report).not.toHaveBeenCalled()
  })

  test('a session that was unregistered can no longer report', async () => {
    const report = vi.fn()
    server = new AgentStatusServer(report)
    await server.start()
    const url = server.register('term-3')
    server.unregister('term-3')
    expect(await post(`${url}/idle`)).toBe(404)
    expect(report).not.toHaveBeenCalled()
  })

  test('starts once: a second start answers the same port', async () => {
    server = new AgentStatusServer(() => {})
    expect(await server.start()).toBe(await server.start())
  })
})
