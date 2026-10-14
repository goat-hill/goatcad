---
name: screenshot-app
description: Capture a PNG of a real surface in this repo — the GoatCAD ECAD app, the GoatHerd worktree manager, or the goatcad.com marketing site (web/) — to visually verify a UI/renderer/page change against the actual thing, not just tests.
---

# Screenshot a GoatCAD surface

Three surfaces each ship the same-shaped harness under their own project dir, so
pick the `bin/` that matches what you changed:

```bash
# GoatCAD (the ECAD app) — electron/
./electron/bin/screenshot --out shot.png --size 1400x900

# GoatHerd (the worktree manager) — develop/
./develop/bin/screenshot --out shot.png --size 1400x900

# The marketing site (web/) — a page, not an app; see "The web/ site" below
./web/bin/screenshot --path /docs/installation --out shot.png --size 1400x900
```

Each is a whole verified path that ends in a PNG. **Look at the PNG — a blank
frame means the launch failed.** The two Electron harnesses are near-identical
(GoatCAD's in `electron/scripts/screenshot.mjs`, GoatHerd's in
`develop/scripts/screenshot.mjs`): they build the app (`electron-vite build`),
launch it with Playwright's Electron driver (`playwright-core`, a declared
devDependency — do not install anything), wait for the first window, resize it,
and capture.

**The `web/` harness is different machinery for the same goal** — there is no
Electron window, so it builds the static site (`astro build`), serves `dist/`
through Astro's own preview server, and drives **system Google Chrome** with
Playwright (`web/scripts/screenshot.mjs`). Its distinct options and notes are in
[The web/ site](#the-web-site) below; the Electron options come first.

## Options (Electron: electron/ and develop/)

- `--out <path>` — output PNG (default `screenshot.png`). Point it at the worktree's
  `.goatherd/` (grouped in a `.goatherd/<name>/` subfolder) so the result surfaces
  in GoatHerd's **Workspace** tab for review — that is where visual artifacts belong,
  not a scratch/tmp path or the repo root. Images render inline there; a `review.md`
  can embed them with `![](rel.png)` (RULES.md §3; `develop/README.md`).
- `--size WxH` — window size (default `1400x900`)
- `--open <file>` — **GoatCAD only.** KiCad file(s) to open on launch, exactly
  like an OS double-click (repeatable). The containing directory becomes the
  project, so point it at a copy if the real folder holds `.lck`/`.history` noise
  you don't want in the file explorer. GoatHerd has no `--open` — it discovers the
  repo's worktrees itself and renders them.
- `--dpr <n>` — device pixel ratio (`--force-device-scale-factor`); use 2 for
  crisp retina/marketing captures. Note the window manager may size the window
  independently of `--size` at dpr>1 — check the reported output dimensions.
- `--wait <ms>` — settle delay before capture (default `1000`; GoatCAD: use
  ~5000+ when opening a board so parsing and the first render finish)
- `--script <file.mjs>` — driver hook to steer the app to a state before capture:
  `export default async ({ app, page }) => { … }` where `app` is Playwright's
  `ElectronApplication` and `page` its first window. Use `app.evaluate()` for
  main-process APIs and normal `page.*` for the renderer.
- `--visible` — show the app on the real desktop instead of headless (skips
  xvfb-run and the X11/Wayland pinning); handy for watching what a driver does.
- `--no-build` — reuse the existing `out/`. Only when you're sure it's fresh;
  a stale build silently screenshots the previous UI.
- `--timeout <ms>` — whole-run deadline, launch to PNG, build not counted
  (default `120000`). Also on the web harness, counted from Chrome's launch.

## Properties you can rely on

- **A run always ends.** Past `--timeout` the harness says which stage it was
  stuck in (`gave up after … ms while running the driver`), kills the app and
  exits `124`, so a driver waiting on something that never comes cannot hold the
  caller. A driver that *throws* leaves `<out>.failed.png` — the window as it
  stood — beside the error; read it before re-running. GoatCAD is closed through
  `app.exit()`, so a driver may leave documents dirty: the unsaved-changes prompt
  is never raised. (That prompt is therefore not something a driver can test by
  closing the app — drive the tab's close button instead.)

- **No side effects:** userData points at a throwaway temp dir, so real
  config/session/recents are untouched, and the single-instance lock (keyed by
  userData) never collides with a running app. GoatCAD honors
  `GOATCAD_USER_DATA_DIR`, and serves its agent API on an ephemeral port
  (`GOATCAD_MCP_PORT=0`, overridable) so it never contends for a running
  GoatCAD's 8788 — a driver reads the URL and token from
  `page.evaluate(() => window.api.mcpStatus())` and calls `POST /v1/ops/<name>`
  with the bearer, which is how to exercise an agent operation end to end
  against a copy of a project; GoatHerd uses Electron's native `--user-data-dir`
  switch and sets `GOATHERD_HOOK_PORT=0` (ephemeral) so it never binds the real
  Claude-status hook port (47821) of a running GoatHerd.
- **No open debug ports:** Playwright drives Electron over
  `--remote-debugging-pipe`.
- **Display:** prefers `xvfb-run` when installed (invisible, CI-friendly);
  otherwise uses the real `$DISPLAY` and a window briefly appears. A fresh GoatCAD
  launch shows the Welcome tab; GoatHerd shows the workstream sidebar.

## GoatHerd-specific notes

- **Driving the UI:** `page` is a normal Playwright page. Titlebar/menus,
  sidebar rows (`.worktree-list li`), and action buttons are plain DOM — locate
  them by class/text. The View menu (terminal zoom) is `.menu-trigger` →
  `.menu-dropdown`.
- **Starting a session spawns a real pty** (a shell/Claude in the worktree). For
  a pure screenshot prefer UI states that don't; if you do start one, it's cleaned
  up when the app closes.

## The web/ site

`./web/bin/screenshot` captures a page of the marketing site (goatcad.com). It is
a web page, not an Electron app, so the machinery differs even though the goal and
the driver shape are the same.

```bash
# A docs page, viewport-sized
./web/bin/screenshot --path /docs/installation --out shot.png --size 1400x900

# The whole landing page at retina scale (great for marketing)
./web/bin/screenshot --path / --out home.png --dpr 2 --full-page

# An already-running URL — the live site, or `web/bin/dev` — skips build+serve
./web/bin/screenshot --url http://localhost:4321/docs --out shot.png
```

It builds the site, serves `dist/` through Astro's preview server (so routing,
trailing slashes and 404s match production), drives headless system Chrome, and
writes the PNG. **Headless by default — nothing appears on screen, and no xvfb is
involved** (that is an Electron-only concern); `--visible` opens a real Chrome
window to watch a `--script` run.

### Options (web only)

- `--path <route>` — page to capture, e.g. `/docs/installation` (default `/`).
- `--url <url>` — capture an arbitrary running URL instead; **skips the
  build+serve**. Use for the live site or a running `web/bin/dev`.
- `--out <path>` — output PNG (default `screenshot.png`).
- `--size WxH` — browser viewport (default `1400x900`). The PNG is size×dpr.
- `--dpr <n>` — device pixel ratio (default `1`); use `2` for crisp captures.
- `--full-page` — capture the whole scrollable page, not just the viewport.
- `--wait <ms>` — settle delay after load (default `300`; pages are static).
- `--color-scheme <dark|light>` — OS colour preference to emulate (default
  `dark`). Docs pages follow it (they ship light and dark); the landing page is
  pinned dark, so it looks identical either way. Capture both when you change
  docs styling.
- `--script <file.mjs>` — driver run before capture:
  `export default async ({ browser, context, page }) => { … }`, where `page` is a
  normal Playwright page. **Same shape as the GoatHerd DOM drivers** — locate by
  class/text and click/type. Nav links, the `.sidebar` docs rail, and `.toc`
  entries are all plain DOM.
- `--visible` — open a real Chrome window instead of headless.
- `--no-build` — reuse the existing `dist/`; skips `astro build`. Only when you
  know it's fresh (a stale `dist/` screenshots the previous version of the page).

### Properties you can rely on

- **No browser download.** The harness drives the machine's installed Google
  Chrome via Playwright's `channel: 'chrome'`; `playwright-core` ships no browser
  binary, so `web/`'s install and CI stay light. Point at a specific binary with
  `--chrome /path` or `$PLAYWRIGHT_CHROME` if Chrome isn't found.
- **Faithful render.** Serving the real `dist/` build (not the dev server) means
  production CSS and no Astro dev toolbar in the frame.
- **Deterministic.** The capture context requests `prefers-reduced-motion:
  reduce`, so animations (e.g. the hero motif) sit at their end state instead of
  a random frame. Use `record` when motion is the point.
- **No side effects.** Everything is a fresh build served on an ephemeral
  localhost port and torn down in a `finally`; nothing is written outside the
  output PNG and `dist/`.
