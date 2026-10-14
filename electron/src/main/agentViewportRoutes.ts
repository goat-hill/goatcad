/**
 * Which window holds each agent viewport, app-wide (docs/agent-api.md,
 * "The agent viewport").
 *
 * Each window keeps its own boxes (`renderer/src/lib/agentViewports.ts`), so
 * main gives every viewport its id: unique across windows, so a request naming
 * one goes to the window that holds it. An agent connection (`mcpSessions.ts`)
 * keeps one id per workspace it works in, so subagents sharing a connection,
 * each in its own workspace, each keep a box; its next `viewport.open` there
 * reuses it, and the connection's end closes them all.
 *
 * Pure and Electron-free: the bridge (`partsMcpBridge.ts`) sends the requests.
 */

/** Ids remembered with their window, closed ones included, so a late call still reaches the window that knows why it closed. */
const REMEMBERED = 256

export interface AgentViewportRoutes {
  /** The window that holds (or last held) a viewport, or null. */
  windowOf(id: string): number | null
  /** The id an open uses: the connection's own in this workspace, else a new one. */
  idFor(connection: string | undefined, workspace: string): string
  /** A window answered an open with this id. */
  opened(id: string, window: number, connection: string | undefined, workspace: string): void
  /** Forget a connection, answering its viewports and the windows holding them. */
  end(connection: string): { id: string; window: number }[]
}

/** A connection's box in one workspace. */
const ownerKey = (connection: string, workspace: string): string => `${connection}\n${workspace}`

export const createAgentViewportRoutes = (): AgentViewportRoutes => {
  const windows = new Map<string, number>()
  const byConnection = new Map<string, string>()
  let count = 0

  return {
    windowOf: (id) => windows.get(id) ?? null,
    idFor: (connection, workspace) =>
      (connection !== undefined ? byConnection.get(ownerKey(connection, workspace)) : undefined) ??
      `viewport-${++count}`,
    opened(id, window, connection, workspace) {
      windows.delete(id)
      windows.set(id, window)
      if (windows.size > REMEMBERED) windows.delete(windows.keys().next().value!)
      if (connection !== undefined) byConnection.set(ownerKey(connection, workspace), id)
    },
    end(connection) {
      const held: { id: string; window: number }[] = []
      for (const [owner, id] of byConnection) {
        if (!owner.startsWith(`${connection}\n`)) continue
        byConnection.delete(owner)
        const window = windows.get(id)
        if (window !== undefined) held.push({ id, window })
      }
      return held
    }
  }
}
