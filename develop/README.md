# GoatHerd

An Electron app for managing parallel GoatCAD development workstreams. Each git worktree gets a
sidebar entry with one-click sessions, each running in a real embedded terminal (node-pty +
xterm.js — the VS Code terminal stack):

- **Claude** — the Claude toolbar button opens the worktree's Claude session: focuses the
  running one, or starts `claude --continue` when the worktree has prior transcripts under
  `~/.claude/projects/` (plain `claude` otherwise). One Claude thread per worktree by design;
  there is no separate Resume button. Clicking a worktree in the sidebar only selects it —
  nothing auto-starts.
- **Terminal** — the user's login shell in the worktree directory
- **GoatCAD** — the app dev server: `npm run dev` in `<worktree>/electron/`, with
  `ELECTRON_DISABLE_SANDBOX=1` (no chrome-sandbox chown needed) and
  `GOATCAD_WORKSTREAM=<branch>` injected
- **Web** — site dev server: `npm run dev` in `<worktree>/web/` on an auto-allocated port.
  GoatHerd watches the session's output for the URL the server prints and **opens your
  browser** on it. Reading the printed URL rather than assuming our requested port matters:
  Astro falls forward to the next free port when that one is taken, and the tab's
  open-in-browser link is corrected to the real port too
- **GoatHerd** — a dev instance of GoatHerd itself: `npm run dev` in `<worktree>/develop/`
  with `GOATHERD_HOOK_PORT=47822` (see the two-instance workflow below)
- **VSCode** — opens the worktree in VS Code (not a session; launches `code` detached)
- **Git Diff** — a per-worktree review tab: the branch against `master`, in aggregate or
  commit by commit; see [Git Diff](#git-diff-reviewing-a-workstream)
- **Workspace** — a per-worktree demos tab (`.goatherd/`); see [Workspace](#workspace-agent-demos)

Fresh worktrees run `npm install` in `electron/`, `web/`, and `develop/` sequentially upon creation (in a single tab) — there is no button for the install; it only appears as a tab. Claude sessions are not opened by default.

## Tabs & splits (VS Code model)

Everything you open — Claude, terminals, dev servers, the Workspace — is a **tab**, and every
tab lives in an **editor group (split)**. It works like VS Code:

- Opening a session adds a tab to the active split. Selecting a workstream in the sidebar only
  changes what the action row acts on — it never touches the splits.
- The **split** button at the right of a split's tab bar (or `mod+shift+P`) moves the active
  tab into a **new split to the right**. Tabs **drag between splits**, and reorder within one.
  Closing a split's last tab closes the split.
- Tabs are **numbered sequentially across all splits**; `mod+1…9` jumps to the Nth tab
  wherever it lives. Tab strips **scroll horizontally** when they overflow, and middle-click
  closes a tab. The focused split is the one keyboard input goes to (its active tab is
  highlighted; the others read as dimmed). Unfocused splits also dim slightly as a whole —
  enough to tell them apart at a glance in a two-up view, not enough to hurt reading them.

Creating a worktree in the sidebar puts it in `.claude/worktrees/<branch>` (alongside the ones
Claude Code creates itself); existing worktrees are picked up wherever they live via
`git worktree list`.

**Renaming a workstream.** Double-click a sidebar row to give it a friendlier name than its
branch — `auth rework` over `goatherd-dev-2`. This is a label only: the git branch never
changes, and it stays visible in small type under the name (and in tab tooltips). Clearing
the field reverts to the branch name. The main checkout can't be renamed. Names are stored
per-worktree in `.goatherd/.meta.json` — a dotfile, so the Workspace tab ignores it, and it
disappears with the worktree.

This directory is a self-contained npm project (like `../web/`), outside the root build.

## Setup

```bash
source ~/.nvm/nvm.sh   # npm is behind nvm on this machine
npm install
```

Then `./bin/dev` to run it — like the other `bin/` wrappers, it sources nvm itself, so no shell
setup is needed after the one-time install.

## Checks

Run `./bin/pre-cm-checks` before committing GoatHerd changes; it formats, lints, and typechecks
the main, preload, and renderer processes, then runs the Vitest suite. `./bin/pre-merge-checks`
performs the bundle-only check when landing. The individual `./bin/format`, `./bin/lint`,
`./bin/typecheck`, `./bin/test`, and `./bin/build` wrappers are available for focused work.

`node-pty` is a native module; the `electron-builder install-app-deps` postinstall rebuilds it
against Electron. Install scripts are gated by npm's allowScripts policy — approvals are recorded
in `package.json` (`npm approve-scripts <pkg>` if a new native dep is added).

## Claude status badges (hooks)

GoatHerd listens on `http://127.0.0.1:47821/hook` and flips each worktree's status dot:
🟢 pulsing = working, 🟡 = waiting on you (permission request / needs input), ⚪ = at its prompt.

**Sessions GoatHerd launches report automatically.** The Claude button passes
`--settings <userData>/hooks/claude-hooks.json`, a file GoatHerd writes on every launch whose hooks
POST `/hook/<status>` on this instance's port — so a dev instance on 47822 gets its dots too.
Those hooks run _beside_ anything in your own settings, never instead of it. Working starts at
`UserPromptSubmit` and is re-asserted around every tool call; `Stop`, `SessionStart` and
`SessionEnd` are idle; a `Notification` is "waiting" only when it wants you (`permission_prompt`,
elicitation dialogs, `agent_needs_input`) — the idle reminder after a minute at the prompt is idle.

**Sessions started elsewhere** (a plain terminal in a worktree) can report too. Add to
`~/.claude/settings.json` — the bare `/hook` path is read by event name, and unmatched paths are
simply ignored:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47821/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47821/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47821/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The hook pipes Claude Code's own JSON payload (`hook_event_name`, `cwd`, `session_id`) straight
through; the `-m 2 … || true` keeps sessions unaffected when GoatHerd isn't running.

## Hotkeys

All bindings live in `src/renderer/src/hotkeys.ts` (matcher + hover-hint text); every button
and sidebar row shows its hotkey in the hover tooltip, rows 1–9 carry a number chip, and each
hotkeyed toolbar button wears its letter as a small chip, with the shared `mod+shift +` prefix
shown once to the left of the button row. mod = Cmd on macOS, Ctrl elsewhere. Letter combos use
mod+shift to stay off keys the embedded terminals need (plain ctrl+letter belongs to the shell;
ctrl+shift+C/V are terminal copy/paste, below).

| Binding     | Action                                   |
| ----------- | ---------------------------------------- |
| mod+1…9     | jump to tab N (sequential across splits) |
| mod+shift+F | find workstream by name (fuzzy palette)  |
| mod+shift+P | split: move active tab to a new split    |
| mod+\`      | cycle focus through the splits           |
| mod+shift+L | Claude session in current worktree       |
| mod+shift+T | Terminal in current worktree             |
| mod+shift+A | GoatCAD app dev server                   |
| mod+shift+W | Web (site) dev server                    |
| mod+shift+O | open worktree in VSCode                  |
| mod+shift+G | open the worktree's Git Diff             |
| mod+shift+D | open the worktree's Workspace (demos)    |
| mod+shift+N | focus the new-branch input               |
| mod+shift++ | zoom terminals in (font size)            |
| mod+shift+- | zoom terminals out                       |
| mod+shift+0 | reset terminal zoom to default           |

Terminal zoom is app-wide — one font size shared by every embedded terminal (Claude,
shells, dev servers), persisted across restarts (`src/renderer/src/terminalFont.ts`). The
same controls live under a **View** menu for discovery: in the title bar on Windows and
Linux, in the system menu bar on macOS (see below).

**The title bar is platform-split.** Windows and Linux get a fully frameless window whose
whole title bar — brand, branch chip, View menu, window controls — is drawn by `App.vue`.
macOS cannot work that way: the menu bar belongs to the system, and `frame: false` would
take the traffic lights with it. So on darwin the window uses `titleBarStyle: 'hidden'`
with the native lights positioned in the 34px bar, `App.vue` drops its View menu, its
window-control buttons and its wordmark (branding is the Windows/Linux title bar's job — macOS
already names the app in the menu bar and the Dock; the branch chip leads there instead), and `src/main/appMenu.ts` declares the menu bar explicitly —
`appMenu`, Edit, View (the three zoom commands), `windowMenu`. Declaring it is the
point: left alone, Electron fills the bar with a stock template whose Help menu links to
electronjs.org and whose View menu offers Chromium _page_ zoom, the exact thing
`interceptZoomShortcuts` exists to prevent. The native items send the same `zoom` message
the interception does, so the renderer's font store stays the one place the size changes;
the interception itself is skipped on macOS, since a key claimed by the system menu never
reaches the page and running both would double every step. The live "14px · default 13px"
readout is formatted in the renderer and pushed over `menu:zoom-label`, which rebuilds the
menu — a static native template has no other way to show changing state.

Drawing the bar also means drawing the cue the OS would give for free: when the window is not
the active one its bar flattens toward the window background and its contents fade together,
the way a backdrop window's title bar does on GNOME, macOS and Windows. Whether the window is
active is something only main can answer (`window:focus-changed`) — the page's own focus events
track the focused element, which stays exactly where it was when you click away to another app.
Dragging the window by its title bar dims it too, since the desktop takes an input grab to move
the window and the grab reaches the app as a plain blur — VS Code does the same thing here, and
there is no signal that separates the two cases, so it is left alone rather than papered over.

## Copy & paste

A terminal cannot use the platform's plain clipboard keys — ctrl+C is SIGINT and ctrl+V is
readline's literal-next, and both have to reach the shell untouched — so GoatHerd does what every
terminal emulator does instead:

| Binding                    | Action                    |
| -------------------------- | ------------------------- |
| ctrl+shift+C / ⌘C          | copy the selection        |
| ctrl+shift+V / ⌘V          | paste                     |
| ctrl+insert / shift+insert | the same two, classically |
| ⌘A                         | select all (macOS)        |

**Right-click** anywhere in a terminal for the same three as a native menu — the only way to
reach Select All off macOS, since ctrl+shift+A is already the GoatCAD dev server. Dragging out a
selection also puts it on the Linux PRIMARY buffer, so it middle-click-pastes into other apps the
way a system terminal's selection does.

All of it goes through the main process (`clipboard:*` IPC): a renderer — the preload included —
has had no `clipboard` module since Electron 44, and calling it there fails silently.

The chords are matched at the window (`hotkeys.ts` → `terminalClipboard.ts`) rather than inside
xterm, because the app's own text fields — the finder, the rename box, the new-branch input —
answer to them too, and because stopping the event there is what keeps ctrl+shift+V from also
reaching Chromium's paste-as-plain-text and pasting twice. Paste goes through xterm rather than
straight to the pty so bracketed-paste mode is honored: multi-line text lands in Claude's prompt
as one block instead of the shell running it line by line as it arrives. The macOS Edit menu's
Copy/Paste/Select All are plain items rather than `role`s for the same reason a terminal needs
any of this — a role acts on the DOM, and a terminal's selection is drawn, not selected — so they
report to the same router the keys do.

## Git Diff (reviewing a workstream)

The **Git Diff** button in a worktree's action row (hotkey `mod+shift+G`, badge = commits
ahead) opens a review tab for that workstream — one per worktree, like the Workspace.
It is the surface for reading what an agent actually did before landing it.

The left rail is the **scope** picker; the right pane shows that scope's files. Clicking
anywhere on a row selects that scope and **expands** it into a **file tree** of what it
touches, the way a pull request lists changed files — folders collapse, and a folder chain
that offers no choice folds into one `src/renderer/src` row rather than spending a row per
level. Clicking the row you are already on toggles its grouping shut again; clicking a
different row selects and opens it, rather than collapsing the very thing the click asked for.
The caret toggles any row without changing the selection.

Selecting a commit prints its **full message** — subject, body, trailers — above that commit's
files, with its sha, author, and date. Click a file to select that scope, open that file, and jump straight to it; as you scroll the
diff, the tree marks the file you are currently reading. Drag the divider to widen the rail
(double-click resets it).

Picking a file also hands the **keyboard** to the diff pane, so Page Up/Down and the arrows
scroll it from where the jump landed. The pane takes focus through the same `focusSignal`
App.vue uses to hand a terminal the keyboard, so `mod+1…9`, a tab click, and cycling splits
all reach it — plus an `onMounted` claim, since a freshly opened tab fires its signal before
this component exists to hear it.

The scopes:

- **Working tree** — everything uncommitted: staged, unstaged, and untracked. Untracked
  files have no revision to diff against, so they go through `git diff --no-index` against
  `/dev/null`; the listing caps at 200 of them and says how many it left out.
- **All commits** — the aggregate, `base...HEAD`, i.e. everything the branch added since it
  forked. Three-dot, so the base's own commits never show up as reversed changes.
- **Each commit**, newest first, with its subject, short sha, date, and `+`/`−` counts.
  A commit is diffed against its **first parent**, so a merge shows what it brought in and a
  root commit (which has no parent) is read with `git show` instead.

The base defaults to `master` and is a dropdown of the repo's local branches, most recently
committed first. A base that doesn't exist is reported, not thrown; one that isn't a local
branch at all (a tag, a raw sha) stays selectable rather than being dropped from the list.

Each file is a collapsible card with an **Expand / Collapse** button on its right, switching
that file between git's own three lines of context and its entire contents — the whole-file
read just asks git for more context than the file has lines, so one patch parser serves both.
It is per file because one file is usually the only one you want in full. The toolbar's
**Show all / Hide all** are a different axis: they open and close the cards themselves, which
is why they don't share the words. Files open on their own until 1500 changed lines
are accounted for and the rest wait for a click, and one file mounts at most 4000 rows; both
limits report what they held back rather than quietly showing a partial diff as if it were
whole.

**The view re-reads itself** whenever the window is foregrounded, and on returning to a tab
that has been away for 30 seconds — an agent commits while you are elsewhere, and coming back
to the app is exactly when the diff is most likely to be stale. Only a change of base or
worktree starts clean.

A re-read is **in place, and silent when nothing changed** — which is the whole difficulty of
refreshing on a signal as frequent as window focus. Reactive state is only written when it
actually differs (the overview, the file listing, each rail row's list, and each file's patch
are all compared first), because assigning an equal-but-new object still invalidates every
computed and binding below it, and that is visible as a flash. There is deliberately **no
progress indicator for a refresh** — on a signal this frequent it is just a blink, and it
reports nothing worth reading. The two remaining "Reading…" placeholders are gated to first
loads, where there is genuinely nothing on screen yet; an open file keeps its rows and the
rail keeps its tree until replacements arrive. Each file's open/whole state and the scroll
position survive throughout.

Code rows are syntax-highlighted by `src/renderer/src/syntax.ts` — a small in-house lexer
(TS/JS/Vue, CSS, JSON; everything else renders plain) rather than a dependency. It reads one
line at a time carrying only block-comment state, so a string left open at end of line closes
there, and packed mode resets that state at each hunk since hunks are not contiguous.

The code canvas (`--code-*`, `--syntax-*` in `assets/main.css`) is deliberately darker than
`--bg`: dropping the surface lifts every token's contrast at once. **Every value there is
measured** to clear WCAG AA against the canvas _and_ against both row tints at their 20%
strength — the tinted rows bind, and comments and the gutter are the tightest at 4.86:1. If
you darken a token or raise `--tint`, re-measure; the earlier palette had comments at 3.92:1
on the canvas and 3.17:1 on an added row, which is what prompted this.

The git side lives in `src/main/gitDiff.ts` (`git:overview`, `git:files`, `git:patch`), which
returns raw patch text; `src/renderer/src/gitDiff.ts` turns it into numbered rows. Both halves
are pure enough to unit-test, and the main-side tests run against a real throwaway repository
so git's own output is the fixture.

**The view's scope must not be a deep `ref`.** Electron's IPC serializes with structured
clone, which throws `DataCloneError` on a Proxy, and Vue's `ref` wraps an object value in one.
`GitDiffView` holds `scope`/`overview`/`listing` in `shallowRef` for that reason (they are
replaced wholesale, never mutated); `src/renderer/src/__tests__/gitDiff.test.ts` pins it,
because the symptom is a silently empty diff that reads as an unchanged branch.

## Workspace (agent demos)

Each worktree has an optional `.goatherd/` directory that an agent working the
branch can drop artifacts into — screenshots and screen recordings (the
`screenshot-app` / `record-app` skills take an `--out` path, so point it at
`.goatherd/`), plus any `.md`/`.html` writeup that wraps them with context. The
**Workspace** button in a worktree's action row (under VSCode, hotkey
`mod+shift+D`) shows a badge with the file count and opens the demos as a tab
(one per worktree) alongside your terminals:

- images and videos play inline (video seeks natively — bytes stream over the
  `goatherd-media://` protocol rather than crossing IPC),
- `.md` renders (embedded relative image paths resolve against `.goatherd/`, so
  a writeup can show its own screenshots), `.html` renders in a sandboxed
  iframe (scripts off), and anything else offers "Open externally".

`.goatherd/` is meant to be gitignored — it's scratch space for the herder to
review a workstream's output, not committed content. Add `.goatherd/` to the
repo's `.gitignore` (it's shared across all worktrees).

## Quota display

The bottom of the sidebar shows Claude usage limits — the same windows as `/usage` in Claude
Code (5h session, weekly overall, model-scoped like Fable) — with bars turning amber at 75%
and red at 90%. Data comes from the (undocumented) `api.anthropic.com/api/oauth/usage`
endpoint, authenticated with the OAuth token Claude Code maintains in
`~/.claude/.credentials.json`; GoatHerd only reads the token and never refreshes it, so if it
expires the widget shows the last good reading until the next `claude` session rotates it.
Polled every 5 minutes; click the widget to refresh now. Real fetches are spaced ≥60s apart
and cached in the main process (persisted to userData), so renderer hot-reloads and app
restarts during development serve the cache instead of hitting the endpoint.

## Managed repo

By default GoatHerd manages the repo it lives in (its parent directory). Point it elsewhere with
`GOATHERD_REPO=/path/to/repo npm run dev`.

## Developing GoatHerd while it's hosting live sessions

Renderer edits hot-reload safely (terminal panes replay scrollback from the main process on
remount), but `src/main/` edits make electron-vite **relaunch the app, killing every hosted pty**.
So improve GoatHerd from a second instance:

1. Keep the stable instance running from the master checkout — its files aren't being edited, so it
   never restarts. It hosts your real sessions, including the Claude session working on GoatHerd
   itself in a worktree.
2. Launch the dev instance from that worktree on an alternate hook port — the **GoatHerd**
   toolbar button does exactly this, or by hand:

   ```bash
   cd <repo>/.claude/worktrees/<branch>/develop
   npm install   # first time only
   GOATHERD_HOOK_PORT=47822 npm run dev
   ```

The title bar shows which checkout an instance runs from as an amber branch chip — absent on
master, i.e. the chip marks the throwaway dev instance. Each instance writes its own hooks file
with its own port at every Claude launch, so both get their dots; only the manual
`~/.claude/settings.json` hooks (for sessions started outside GoatHerd) name the stable port.

After merging to master, restart the stable instance at a calm moment: sessions die, but the
Claude button brings each worktree's conversation back via `claude --continue`, and dev
servers are one click to respawn.

## Screenshots & recordings

`bin/screenshot` and `bin/record` capture the real app for verifying UI changes —
the GoatHerd siblings of `../electron/bin/*`. They build (`electron-vite build`),
launch via Playwright's Electron driver (headless under `xvfb-run`), and write a
PNG or an ffmpeg-encoded mp4/gif. Runs are isolated (throwaway `--user-data-dir`,
`GOATHERD_HOOK_PORT=0`) so they never touch real state or collide with a running
GoatHerd.

```bash
./bin/screenshot --out shot.png --size 1400x900
./bin/record --script demo.mjs --out demo.mp4 --fps 12   # --script is required
```

Options and driver-writing are documented in the `screenshot-app` / `record-app`
skills (`.claude/skills/`), which cover both apps.

## Roadmap (post-MVP)

- Desktop notifications on `waiting` transitions
- Embedded web preview pane instead of open-in-browser
- Live-watch `.goatherd/` so the Workspace badge updates without a refresh
