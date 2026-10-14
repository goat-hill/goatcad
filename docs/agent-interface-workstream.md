# Agent interface: workspaces, background work, the stdio relay

An agent outside Claude Code can work on a project in the background, several agents can work on
several projects at once, and none of them follows the person's focus. The rules are
[agent-api.md](./agent-api.md) "Workspaces"; the wiring is [ARCHITECTURE.md](./ARCHITECTURE.md)
§3.0, §3.10 and §3.11. This doc holds what is open.

## Built

1. **Workspaces and attachment** (`main/workspaces.ts`, `workspaceService.ts`, `ops/workspace/`).
   Every op acts in the caller's workspace; the focused-window fallback is gone. `project.open`,
   `close`, `save` and `create_file` are `workspace.*` now, the old names kept one release.
2. **Hidden workspaces and `--background`.** A workspace with no window is a renderer never shown;
   GUI opens of its folder show it. A background launch quits after 10 idle minutes.
3. **Socket, relay, discovery.** The user-only socket, `goatcad-endpoint.json`, `goatcad mcp`,
   `goatcad help agents`, `goatcad open <folder>`, and the Python client over the socket.

Deliberate differences from the first design:

- **Implicit open stays** inside the attached workspace: a document no tab holds still opens behind
  the active tab. Once a project is in one workspace, that cannot open a file twice, and
  `board_sync`, sheet hierarchies and every run so far rely on it.
- **Agent tabs stay on HTTP**, attached by the `X-GoatCAD-Workspace` header. A relay is a full
  Electron process (about 390 MB RSS across its processes on Linux), and a tab never needs the
  launch-on-demand it buys. The `runAsNode` fuse is off (RELEASES.md), so the relay cannot run as
  plain Node.
- **No peer-uid check.** Node cannot read one; the socket's 0600 mode is the fence on Linux and
  macOS, and the Windows pipe takes the token.
- **The session-tracking module keeps its name** (`mcpSessions.ts`); attachment lives in
  `workspaces.ts`.

## Open

- **Windows stdio.** Piped stdio to `GoatCAD.exe` is untested; if it fails, ship a console
  launcher (`goatcad.com`) and name it in RELEASES.md.
- **macOS dock.** A relay hides its dock icon at startup; check it does not flash.
- **Moved AppImage.** A registration names `$APPIMAGE`; moving the image breaks it. Settings
  should flag a registered path that no longer exists.
- **TCP default.** The port stays on with its token for existing `claude mcp add --transport http`
  registrations. Make it opt-in a release after the relay ships.
- **Closing a window an agent depends on** closes its workspace. Decide whether a workspace an
  agent started hidden should go back to hidden instead.
- **A GUI list of workspaces**, to open a window on a hidden one, and a quit prompt that names
  hidden workspaces with unsaved edits (today the window is shown and asks).
- **Relay weight.** A small native or console helper would cut the relay to a few MB.
