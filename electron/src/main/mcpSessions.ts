/**
 * Agent connections, as the HTTP server sees them: what a viewport belongs
 * to (docs/agent-api.md, "The agent viewport").
 *
 * A connection is a session id. An MCP client gets one minted on `initialize`
 * and sends it back as `Mcp-Session-Id` (Streamable HTTP); the Python client
 * makes its own and sends it under the same header. Ids the server did not
 * mint are taken as they come, so a client keeps its session across an app
 * restart.
 *
 * A connection ends on a DELETE with its id, the MCP way to close a session
 * (the Python client sends one as it exits), or when the last GET stream it
 * holds open has stayed closed for `STREAM_GRACE_MS`, which is how a client
 * that quits without saying so is noticed. A client that holds no stream and
 * never sends DELETE is never seen to leave; its viewport idles out instead.
 *
 * Electron-free: the server holds one of these, and the app listens for ends.
 */
import { randomUUID } from 'node:crypto'

/** How long a session's last stream may stay closed before it counts as gone: a client reconnects within it. */
export const STREAM_GRACE_MS = 5_000

/** Visible ASCII, as the MCP spec allows for a session id, and short. */
export const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value)

export interface McpSessions {
  /** A new session id, for an `initialize`. */
  mint(): string
  /** A GET stream opened on a session; the answer releases it when the stream closes. */
  hold(id: string): () => void
  /** The session ended: its client said so. */
  end(id: string): void
  onEnd(listener: (id: string) => void): () => void
  /** Sessions holding a stream, or within the grace after their last closed. */
  active(): number
}

export const createMcpSessions = (
  options: { graceMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}
): McpSessions => {
  const graceMs = options.graceMs ?? STREAM_GRACE_MS
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const listeners = new Set<(id: string) => void>()
  /** Open streams per session. */
  const streams = new Map<string, number>()
  /** Sessions whose last stream closed, waiting out the grace. */
  const leaving = new Map<string, ReturnType<typeof setTimeout>>()

  const end = (id: string): void => {
    const timer = leaving.get(id)
    if (timer !== undefined) clearTimer(timer)
    leaving.delete(id)
    streams.delete(id)
    for (const listener of listeners) listener(id)
  }

  return {
    mint: () => randomUUID(),
    hold(id) {
      const timer = leaving.get(id)
      if (timer !== undefined) clearTimer(timer)
      leaving.delete(id)
      streams.set(id, (streams.get(id) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        // An ended session (a DELETE while its stream was held) does not end again.
        if (!streams.has(id)) return
        const left = streams.get(id)! - 1
        if (left > 0) {
          streams.set(id, left)
          return
        }
        streams.delete(id)
        const timer = setTimer(() => end(id), graceMs)
        // A client that never comes back must not hold the app open.
        ;(timer as { unref?: () => void }).unref?.()
        leaving.set(id, timer)
      }
    },
    end,
    onEnd(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    active: () => streams.size + leaving.size
  }
}
