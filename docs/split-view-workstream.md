# Split view, two windows, and cross-select

Two editors on screen at once — an agent's terminal beside the design, a schematic beside its board —
in one window or across two. Built; the mechanism is [ARCHITECTURE.md §3.14](./ARCHITECTURE.md). This
doc holds the rules that govern it and are easy to undo, and what is open (§8). **Section numbers are
cited from source comments; keep them stable.**

## 1. Two panes, never a grid

`MAX_EDITOR_GROUPS = 2` (`lib/editorGroups.ts`), side by side or stacked, draggable ratio. The cap is
not about WebGL contexts; it is there because the shared-panel rule (§4) is only unambiguous at two —
"the focused pane's panels, else the other's" needs exactly one other.

## 2. One tab list; a group is a membership over it

The window keeps its single ordered `openTabs`; a group is `{ id, activeTabPath }` plus a
`path → group` map. `App.activeTabPath` is a writable computed — the focused group's front tab — so
every reader of "the active tab" is unchanged. A rename is announced first (`renamePath`), or
`reconcile` reads it as a close plus an open. **One path, one tab, one group**: there is no same file
in both panes (§8).

## 3. Who holds the keyboard

- Every editor listens on `window`; `useGroupKeydown` (`lib/editorWorkspace.ts`) gates each handler
  on its group being focused. Gating by group rather than by `isTypingTarget()` is what makes the
  terminal case structural: `r` typed into a terminal cannot rotate the schematic beside it.
- Menu commands replay as synthetic keydowns on `window` and land in the focused editor; publishing
  edit actions is gated the same way (`usePublishedEditActions`).
- A group takes focus on a capture-phase `mousedown` or a `focusin` inside it, or on a key
  pressed with the pointer over its canvas (`keystrokeGroup`, as KiCad's canvas takes the keyboard
  on mouse enter; never from a field being typed in or an open dialog). The hover alone changes
  nothing on screen; the key moves the focus and runs in that canvas. The split hotkeys are
  handled in the **capture phase** in `App.vue`, because a focused terminal consumes every key.
- **Module-scope shader uniforms must be written per render** (`primitiveBatchUniforms`,
  `uPixelSize`): with two engines alive, one engine's zoom otherwise smears the other's strokes.
- A pane is not a whole number of pixels wide; the drawing buffer comes from the browser's
  device-pixel box (`lib/engine/devicePixelSize.ts`), or a split goes soft.
- **The focus cue** is a hairline accent ring drawn inward on the focused group plus the unfocused
  group's active tab going neutral. No opacity dim — it would composite over a WebGL canvas, and a
  schematic being read while an agent works must stay legible. A lone group shows no cue.

| Key | Action |
|---|---|
| Ctrl/Cmd+`\` | Send the front tab across the split, opening the second group if needed |
| Ctrl/Cmd+Shift+`\` | Side by side ↔ stacked |
| F6 | Hand the keyboard to the other group |

Ctrl+Tab cycles within the focused group; Ctrl+W closes there.

## 4. One set of panels

The properties rail is **owned by the editor, hosted by the shell**: each editor `<Teleport>`s its
panels into `EditorArea`'s `.context-rail` (`useContextPanels`), so no selection or layer state left
the editor. The group that owns the context is **the focused group, or — when its front tab has no
panels (a terminal, a PDF) — the other**; strict follow-focus would collapse the rail on every click
into the terminal. Interacting with the rail focuses the group that owns it. The rail holds its
editor's width while that editor loads (`contextRailWidth`, `lib/panelLayout.ts`), derived from the
tab's type because the tab is known before the file is read. There is no shared bottom dock; a future
bottom panel would be a second Teleport target owned by the same group.

## 5. Why a tab can move

Undo, dirty state and the disk baseline live on the path-keyed document (ARCHITECTURE §3.13), so
moving a tab across the split is an unmount in one group and a mount in the other. `EditorArea` keeps
what is keyed by path; `EditorGroup` holds what belongs to the front tab, and registers a `FrontView`
that saves and buffer reads ask first.

## 6. Cross-select

Selecting a part in a schematic selects and reveals its footprint in the board, and the reverse; the
Components tab is a third origin answered by both.

- **An event on a bus** (`lib/crossProbe.ts`), not one editor calling the other: local subscribers
  hear it and main relays it to other windows on the same workspace root. Anything else that must
  cross panes takes the same route.
- **The key is the symbol's uuid** (the last segment of a footprint's `(path …)`); a probe also
  carries the reference, the fallback for multi-unit parts.
- **A highlighted net crosses too** (KiCad's `$NET:`), by name, since a board's nets are its
  schematic's (`boardSync.ts`): `` ` `` or `~` in one lights or clears the net in the other and on
  every open sheet, a name the other lacks clears it, and no tab moves.
- **Only the user's own selection or highlight gesture emits**; the receiver acts programmatically,
  so a probe cannot echo.

### Which pane answers (`lib/crossProbeRoute.ts`)

The pane a probe came from never answers it, and the pane that does is not handed the keyboard. The
pane showing a schematic plays KiCad's single schematic window:

| Where the probed sheet is | What happens |
|---|---|
| Open in the schematic pane, behind another sheet | Shown there |
| Not open in this window | Opened in the schematic pane — unless another window holds it (`tab:held-elsewhere`), which answers instead |
| Open in the other pane | Moved to the schematic pane |
| No pane is showing a schematic | Nothing — a pane showing a terminal or a PDF is never taken over |

"Showing" means **in front**, both directions: a board answers only from a pane with a board in
front, a sheet only from a pane with a schematic in front. A file is never opened twice.

### Reveal without re-framing (`lib/engine/bringIntoView.ts`)

**Zoom is working state; pan is navigation.** Fits and is inside the safe rect → select only; fits
but is outside → pan only; does not fit → zoom out and center, never in. The safe rect is measured
from the DOM (`lib/engine/viewportInsets.ts`). The part is centered on the canvas and the chrome is
paid for in the zoom. A pane the user never framed (`viewFramedByUser`) gets a fit-to-part once.

- **The pan cuts; it does not glide.** A reveal moves the whole field of view under someone who did
  not move it, the motion that provokes nausea. If animation is revisited it needs a per-feature
  motion preference under a master switch, not only `prefers-reduced-motion`.
- With the camera usually still, the selection halo is the only confirmation a reveal gives — a known
  cost at board zoom, accepted.
- This is KiCad's default (center on, zoom off) plus the in-view guard; deliberately no preference.
- Limits: a probe that *mounts* a board tab selects but may not pan (the scene has no bounds yet);
  pads and pins are not cross-selected.

## 7. Two windows

Dragging a tab out opens a window of the same workspace (`window:new`); a drop on another window's
strip transfers it (`tab:transfer`); a drag across the split inside one window is a membership change.
Agent design requests go to the window of the caller's workspace that holds the document
(`main/designWindow.ts`) — by the file the request names, else the one window of it with a design
open — never by focus (agent-api.md "Workspaces").

## 8. Open

- **The same document in two views** (a board in 2D and 3D side by side) — needs multi-view sessions.
- **A dirty buffer travelling with a transferred tab**, and one-dirty-owner arbitration between
  windows ([projects.md](./projects.md) §5). `tab:held-elsewhere` is the primitive
  `openFile` would use to focus the holding window.
- **Drop zones** for dragging a tab to a pane's edge to split.
- Two editors draining `lib/cooperate.ts` share one frame budget; unmeasured with two dense boards.
