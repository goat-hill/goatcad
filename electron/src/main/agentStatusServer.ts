import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { isAgentActivity } from './agentActivity'
import type { AgentActivity } from '../preload/terminalTypes'

/**
 * The loopback door an agent's hooks knock on.
 *
 * One listener for the process, started the first time an agent tab launches
 * and bound to 127.0.0.1 on whatever port is free — the URL is handed to the
 * tab through its environment, so nothing needs a fixed port. Each session
 * registers for a token of its own, and a report is only taken for a session
 * whose token matches: a local process that guesses the port can change a dot
 * at most, but it should not get to change it for a tab it was not given.
 *
 * `POST /agent/<session>/<token>/<activity>`, no body. The answer is empty;
 * the hook does not wait on anything it says (`agentActivity.ts`).
 */
export class AgentStatusServer {
  private server: Server | null = null
  private port: number | null = null
  private tokens = new Map<string, string>()

  constructor(private report: (session: string, activity: AgentActivity) => void) {}

  /** Bind once, lazily: an app that never opens an agent tab never listens. */
  async start(): Promise<number> {
    if (this.port !== null) return this.port
    const server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.port
  }

  /** A session's own URL, minus the activity; the hook appends that. */
  register(session: string): string {
    if (this.port === null) throw new Error('agent status server is not listening')
    const token = randomBytes(16).toString('base64url')
    this.tokens.set(session, token)
    return `http://127.0.0.1:${this.port}/agent/${session}/${token}`
  }

  unregister(session: string): void {
    this.tokens.delete(session)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.tokens.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Whatever was sent is drained and dropped; the path is the message.
    req.resume()
    const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
    const [root, session, token, activity] = parts
    const accepted =
      req.method === 'POST' &&
      parts.length === 4 &&
      root === 'agent' &&
      session !== undefined &&
      this.tokens.get(session) === token &&
      activity !== undefined &&
      isAgentActivity(activity)
    if (!accepted) {
      res.statusCode = 404
      res.end()
      return
    }
    this.report(session, activity as AgentActivity)
    res.statusCode = 204
    res.end()
  }
}
