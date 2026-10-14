---
name: record-app
description: Steer a real surface in this repo through a scripted demo and record an mp4/gif — the GoatCAD ECAD app, the GoatHerd worktree manager, or the goatcad.com marketing site (web/). Use to show a UI/interaction change in motion (dirty tabs, find widget, tool flows, terminal zoom, a docs page scroll); the moving-picture sibling of screenshot-app.
---

# Record a demo video of a GoatCAD surface

Three surfaces each ship the same-shaped harness under their own project dir, so
pick the `bin/` that matches what you changed:

```bash
# GoatCAD (the ECAD app) — electron/
./electron/bin/record --script demo-driver.mjs --out demo.mp4 --size 1400x900 --fps 12

# GoatHerd (the worktree manager) — develop/
./develop/bin/record --script demo-driver.mjs --out demo.mp4 --size 1400x900 --fps 12

# The marketing site (web/) — a page, not an app; see "The web/ site" below
./web/bin/record --path /docs --script demo-driver.mjs --out demo.mp4 --fps 12
```

Each runs a `--script` driver while grabbing page-level frames on a timer, then
encodes them to mp4 (H.264) or gif with ffmpeg. **`--script` is required** — a
video of a static idle screen is not worth encoding. The two Electron harnesses
are near-identical (GoatCAD's in `electron/scripts/record.mjs`, GoatHerd's in
`develop/scripts/record.mjs`): they build the app (`electron-vite build`) and
launch it with Playwright's Electron driver. The board-canvas, fixture, and
`__goatcad` bridge material below is **GoatCAD-only** — GoatHerd is all DOM.

**The `web/` harness is different machinery for the same goal** — no Electron
window: it builds the static site (`astro build`), serves `dist/` through Astro's
preview server, and drives **system Google Chrome** with Playwright
(`web/scripts/record.mjs`). Its distinct options and driver notes are in
[The web/ site](#the-web-site) at the end; everything between here and there is
about the Electron apps.

Frames are captured with `page.screenshot()`, not an OS screen grab, so the
output is exactly the window content at the exact resolution — no desktop
background, no OS cursor, identical whether it runs on a real display or headless
Xvfb. The driver injects its own on-screen cursor when it wants clicks to read
(see the demo driver referenced below).

## Prerequisites

- **ffmpeg** on PATH (encodes the frames). The script exits early if missing.
- **xvfb** for invisible/offscreen recording (`sudo apt install xvfb`).
  `bin/record` prefers `xvfb-run -a` when installed; otherwise it falls back to
  the real `$DISPLAY` and the window briefly appears. Xvfb is what makes this
  usable in an unattended GoatHerd workstream.
- **Wayland note:** on a Wayland session, Electron will render on the real
  compositor and ignore the Xvfb `DISPLAY` unless forced onto X11 — the window
  then pops up on the actual desktop even under `xvfb-run`. `record.mjs` handles
  this by launching with `--ozone-platform=x11` and stripping `WAYLAND_DISPLAY` /
  `GDK_BACKEND` from the child env, so the app always uses the X display it's
  given (Xvfb's, or XWayland's `:0` on the fallback path). `screenshot.mjs` does
  the same.

## Options (parsed in each app's `scripts/record.mjs`)

- `--script <file.mjs>` — **required** ESM driver:
  `export default async ({ app, page }) => { … }`, where `app` is Playwright's
  `ElectronApplication` and `page` its first window. Run while the recorder
  captures frames; every state you want on film just needs to be held on screen
  ~1s so a few frames land at the capture rate.
- `--out <path>` — output file (default `demo.mp4`). Point it at the worktree's
  `.goatherd/` (grouped in a `.goatherd/<name>/` subfolder) so the result surfaces
  in GoatHerd's **Workspace** tab for review — that is where demo artifacts belong,
  not a scratch/tmp path or the repo root. Videos play inline there; pair them with
  a `review.md` and a still `.png` for context (RULES.md §3; `develop/README.md`).
- `--size WxH` — window size (default `1400x900`)
- `--open <file>` — **GoatCAD only.** KiCad file(s) to open on launch, like an OS
  double-click (repeatable). See the fixture note below. GoatHerd has no `--open`;
  it discovers the repo's worktrees itself.
- `--fps <n>` — capture + playback rate (default `12`). Page screenshots
  realistically sustain ~10–15/s at 1400×900; the encode uses the same rate so
  playback runs at real speed.
- `--format mp4|gif` — H.264 (default) or a two-pass palette gif.
- `--dpr <n>` — device pixel ratio (`--force-device-scale-factor`).
- `--wait <ms>` — settle delay after load/resize before the driver and capture
  start (default `1000`; use more when opening a board so the first render
  finishes).
- `--timeout <ms>` — whole-run deadline, launch to encoded file, build not counted
  (default `300000`). Past it the harness names the stage it was stuck in, kills
  the app and exits `124` — a driver waiting on something that never comes cannot
  hold the caller. Raise it for a long demo rather than working around it.
- `--no-build` — reuse the existing `out/`. Only when you're sure it's fresh; a
  stale build silently records the previous UI.

## Default test fixture (GoatCAD): copy a sample project first

For any demo where a standard finished KiCad project will do, use `bitclock`
(the real `canary` board and its sub-sheets) from a clone of
`goat-hill/goatcad-sample-projects` — `$GOATCAD_SAMPLES`, by default
`~/code/goatcad-sample-projects`; clone it there if it is missing.
**Copy it to a temp dir before opening it** — the app can write to the project
(saves, `.lck`, `.history`), and the clone is git-tracked.

```bash
cp -r "${GOATCAD_SAMPLES:-$HOME/code/goatcad-sample-projects}/bitclock" /tmp/rec-fixture
./electron/bin/record --script d.mjs --open /tmp/rec-fixture/canary.kicad_pro --out demo.mp4
```

Opening the `.kicad_pro` opens the folder as a project with no tab, which keeps
the recording off the GPU board canvas (see the Xvfb caveat).

Complex or specific demos (a feature that needs particular file contents, e.g.
text with known search hits) are the exception — build a purpose-made fixture
for those, still copied to a temp dir so no save touches git.

## Writing the driver

### GoatHerd

GoatHerd is all DOM — no board canvas, no fixtures, no `__goatcad` bridge. The
harness launches the app pointed at this repo, so the real worktrees render. Drive
plain selectors and dwell ~1s per state:

```js
export default async ({ page }) => {
  await page.locator('.menu-trigger').click()               // title-bar View menu
  await page.locator('.menu-dropdown').waitFor({ state: 'visible' })
  await page.waitForTimeout(1200)
  await page.locator('.worktree-list li', { hasText: 'master' }).click()
  await page.waitForTimeout(1200)
}
```

Useful selectors: `.worktree-list li` (sidebar rows), `.worktree-actions button`
(Claude/Terminal/… actions), `.menu-trigger` → `.menu-dropdown` (View menu),
`.tab`/`.pane` (splits). Clicking an action button **spawns a real pty** in the
worktree — fine for a demo, cleaned up on close, but avoid it if you only need a
static-looking UI.

### GoatCAD

`page` is a normal Playwright page. Reach non-KiCad files (`.md`, `.txt`) via
Quick Open — `--open` only accepts KiCad extensions:

```js
await page.keyboard.press('Control+KeyP')          // Quick Open
await page.locator('.quick-open-input').type('design-notes', { delay: 55 })
await page.keyboard.press('Enter')
await page.locator('.te-textarea').waitFor({ state: 'visible' })
```

Dwell on each state (`page.waitForTimeout(~1100)`) so it reads at the capture
rate, and inject a visible cursor if clicks matter (`page.mouse` moves a real
pointer that never renders into a screenshot). A complete worked example — dirty
tabs plus the find widget, with a soft on-screen cursor — lived at
`scratchpad/demo-driver.mjs` when this skill was written; copy its shape.

## Properties you can rely on

- **No side effects:** `GOATCAD_USER_DATA_DIR` points userData at a throwaway
  temp dir, so real config/session/recents are untouched and the single-instance
  lock never collides with a running GoatCAD. The temp userData and frame dir
  are removed in a `finally`.
- **No open debug ports:** Playwright drives Electron over
  `--remote-debugging-pipe`.
- **A blank/black video means the launch or driver failed** — extract a frame
  (`ffmpeg -i demo.mp4 -vf "select=eq(n\,30)" -vsync 0 f.png`) and look before
  trusting it.

## Xvfb and the GPU-batched board canvas

Xvfb virtualizes the *display*, not the GPU: Chromium's GPU process still reaches
`/dev/dri`, so on a workstation with a GPU the board canvas renders with **real
hardware GL**. Verified — a headless recording of `canary.kicad_pcb` reported
`ANGLE (AMD Radeon 780M, radeonsi)` / `WebGL 2.0` and rendered every layer
correctly, not a blank frame. On a GPU-less box (CI without `/dev/dri`) Electron
falls back to SwiftShader software GL — slower, but it still renders. Either way,
extract a frame and look before trusting a board recording.

Two real caveats for board recordings (not rendering — those work):

- **Frame rate drops on heavy boards.** `page.screenshot()` reads back the whole
  GPU framebuffer each grab; on a dense board that costs ~300ms, so effective
  capture falls to ~3fps regardless of `--fps`. Playback looks fast/choppy. Hold
  each state longer and expect a slideshow, not smooth motion, for board demos.
- **PCB elements are WebGL, not DOM — no per-element selector.** You cannot
  `page.locator()` a trace, pad, or footprint. Interact via *coordinate* pointer
  events on `.canvas-host-container`; the app hit-tests whatever geometry is under
  the point. A `page.mouse.click()` selects (read it back via the properties
  panel's `.highlight-section`); a click+drag moves the hit item (its Pos X/Y
  updates and the tab goes dirty).
- **Use the `window.__goatcad` bridge to locate elements — don't pixel-hunt.**
  The harnesses launch with `GOATCAD_TEST_HOOKS=1`, which attaches an automation
  bridge (`src/renderer/src/lib/testHooks.ts`; inert without the flag). The active
  editor registers a provider. From a driver:
  ```js
  await page.waitForFunction(() => window.__goatcad?.ready())
  const fps  = await page.evaluate(() => window.__goatcad.listElements('footprint'))
  const eink = await page.evaluate(() => window.__goatcad.getElement({ ref: 'EINK1' }))
  //   -> { ref, value, uuid, layer, world:{x,y}, screenRect, screenCenter }
  const px = await page.evaluate(() => window.__goatcad.worldToScreen(58.5, 52.5))
  await page.mouse.click(px.x, px.y)   // board coords -> pixels, no calibration
  ```
  `worldToScreen(x,y)` takes board (KiCad) coords and returns client pixels — for
  a board-space drag delta, subtract two projected points (it's affine).
- **Locating is not selecting (occlusion).** The bridge tells you *where* an
  element is, but a click there still obeys hit priority
  (`vias > tracks > graphics > zones > footprints`; footprints tie by bbox,
  later-defined wins). So a large footprint's `screenCenter` may sit under a
  track, and a small footprint fully inside a big one's bbox (the Bitclock logo
  under the E-Ink display) is unclickable. Pick a board point that resolves to
  your target, or wait for the bridge's `select()`-by-ref slice (not yet built) to
  bypass hit-testing entirely.

## Not a test — a demo artifact

A video isn't a fast way to *test* a branch: it's build + launch + drive +
encode, and there's nothing to assert on. The **driver script** is the reusable
part — the same Playwright hook can `expect(...)` visibility, text, and counts.
For a tight test loop use `./bin/pre-cm-checks` (format, lint, typecheck, tests) plus a
`./bin/screenshot` at key states; reserve `record` for when *motion* is the
point (walking find matches, a dirty dot persisting across a tab switch) or for a
GoatHerd handoff artifact.

## The web/ site

`./web/bin/record` records a page of the marketing site (goatcad.com) in motion —
a docs scroll, a nav hover, the hero animation. It is a web page, not an Electron
app: it builds the site, serves `dist/` through Astro's preview server, and drives
**headless system Chrome** with Playwright. No fixtures, no `__goatcad` bridge, no
xvfb (headless Chrome renders offscreen); everything above about boards and KiCad
files is Electron-only and does not apply.

```bash
# Scroll the docs and follow a sidebar link (driver below), as a gif
./web/bin/record --path /docs/installation --script demo.mjs --out demo.gif --format gif --size 1200x800

# The landing page with its hero motion, at the default mp4
./web/bin/record --path / --script demo.mjs --out demo.mp4 --fps 15
```

### Options (web only)

Same as the other harnesses for `--out` / `--size` / `--dpr` / `--fps` /
`--format` / `--wait` / `--visible`, plus:

- `--path <route>` — page to record, e.g. `/docs` (default `/`).
- `--url <url>` — record an arbitrary running URL instead; skips build+serve.
- `--script <file.mjs>` — **required** driver:
  `export default async ({ browser, context, page }) => { … }`.
- `--no-build` — reuse the existing `dist/` (skip `astro build`); only when fresh.
- Chrome comes from the system install (`channel: 'chrome'`, no browser
  download); `--chrome /path` or `$PLAYWRIGHT_CHROME` overrides it.

Unlike `web/bin/screenshot`, recording does **not** force reduced motion — motion
is the point, so the hero animation and any CSS transitions play.

### Writing the driver

`page` is a normal Playwright page against plain DOM — the same shape as the
GoatHerd drivers. Dwell ~1s per state so frames land at the capture rate:

```js
export default async ({ page }) => {
  // Smooth-scroll the article
  for (let y = 0; y <= 1400; y += 60) {
    await page.evaluate((v) => window.scrollTo(0, v), y)
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(500)
  // Follow a sidebar link
  await page.locator('.sidebar a', { hasText: 'Getting started' }).click()
  await page.waitForTimeout(1200)
}
```

Useful selectors: nav links (`.nav a`), the docs sidebar (`.sidebar a`, current
page is `a.current`), the on-this-page rail (`.toc a`), and any content heading by
text. As with the app harnesses, `page.mouse` moves a pointer that never renders
into a frame — inject a visible cursor element if a click needs to read on screen.

**A blank/black video means the launch or driver failed** — extract a frame
(`ffmpeg -i demo.mp4 -vf "select=eq(n\,20)" -vsync 0 f.png`) and look before
trusting it.
