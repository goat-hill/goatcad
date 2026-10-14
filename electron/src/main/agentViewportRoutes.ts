/**
 * Which window holds each agent viewport, app-wide (docs/agent-api.md,
 * "The agent viewport").
 *
 * Each window keeps its own boxes (`renderer/src/lib/agentViewports.ts`), so
 * main gives every viewport its id: unique across windows, so a request naming
 * one goes to the window that holds it. An agent connection (`mcpSessions.ts`)
 * keeps one id for its life; its next `viewport.open` reuses it, and its end
 * closes it.
 *
 * Pure and Electron-free: the bridge (`partsMcpBridge.ts`) sends the requests.
 */

/** Ids remembered with their window, closed ones included, so a late call still reaches the window that knows why it closed. */
const REMEMBERED = 256

export interface AgentViewportRoutes {
  /** The window that holds (or last held) a viewport, or null. */
  windowOf(id: string): number | null
  /** The id an open uses: the connection's own, else a new one. */
  idFor(connection: string | undefined): string
  /** A window answered an open with this id. */
  opened(id: string, window: number, connection: string | undefined): void
  /** Forget a connection, answering its viewport and the window holding it. */
  end(connection: string): { id: string; window: number } | null
}

export const createAgentViewportRoutes = (): AgentViewportRoutes => {
  const windows = new Map<string, number>()
  const byConnection = new Map<string, string>()
  let count = 0

  return {
    windowOf: (id) => windows.get(id) ?? null,
    idFor: (connection) =>
      (connection !== undefined ? byConnection.get(connection) : undefined) ??
      `viewport-${++count}`,
    opened(id, window, connection) {
      windows.delete(id)
      windows.set(id, window)
      if (windows.size > REMEMBERED) windows.delete(windows.keys().next().value!)
      if (connection !== undefined) byConnection.set(connection, id)
    },
    end(connection) {
      const id = byConnection.get(connection)
      if (id === undefined) return null
      byConnection.delete(connection)
      const window = windows.get(id)
      return window === undefined ? null : { id, window }
    }
  }
}
