# Agent interface: workspaces, background work, discovery

An agent outside Claude Code can work on a project in the background, several agents can work on
several projects at once, and none of them follows the person's focus. The rules are
[agent-api.md](./agent-api.md) "Workspaces"; the wiring is [ARCHITECTURE.md](./ARCHITECTURE.md)
§3.0, §3.10 and §3.11. This doc holds what is open.

## Built

1. **Workspaces** (`main/workspaces.ts`, `workspaceService.ts`, `ops/workspace/`). Every op acts
   in the workspace it names, else the only one open; the focused-window fallback is gone. `project.open`,
   `close`, `save` and `create_file` are `workspace.*` now, the old names kept one release.
2. **Hidden workspaces and `--background`.** A workspace with no window is a renderer never shown;
   GUI opens of its folder show it, and it goes with the connection that started it. A background
   launch quits once nothing uses it.
3. **Socket, discovery.** The user-only socket, `goatcad-endpoint.json`, `goatcad help agents`,
   `goatcad open <folder>`, and the Python client over the socket.

Deliberate differences from the first design:

- **Implicit open stays** inside the call's workspace: a document no tab holds still opens behind
  the active tab. Once a project is in one workspace, that cannot open a file twice, and
  `board_sync`, sheet hierarchies and every run so far rely on it.
- **No stdio relay.** `goatcad mcp` relayed a client's stdio to the socket and started the app
  when nothing answered. It was a full Electron process (about 390 MB RSS across its processes on
  Linux) in every session that registered it, used or not, and the `runAsNode` fuse is off
  (RELEASES.md), so it could not run as plain Node. Removed: clients use HTTP while the app runs,
  as in-app tabs do (naming their workspace with the `X-GoatCAD-Workspace` header), and an agent
  that needs the app starts it.
- **No peer-uid check.** Node cannot read one; the socket's 0600 mode is the fence on Linux and
  macOS, and the Windows pipe takes the token.
- **No attachment.** A call names its workspace, or there is only one; nothing is kept per
  connection but the viewport, so subagents sharing one connection work in separate workspaces.
  The session-tracking module keeps its name (`mcpSessions.ts`).

## Open

- **Late open.** Claude Code connects at session start, so GoatCAD opened after the session
  needs `/mcp`. A dev build's port changes each launch, so its registration lasts one run.
- **Closing a window an agent depends on** closes its workspace. Decide whether a workspace an
  agent started hidden should go back to hidden instead.
- **A GUI list of workspaces**, to open a window on a hidden one, and a quit prompt that names
  hidden workspaces with unsaved edits (today the window is shown and asks).
