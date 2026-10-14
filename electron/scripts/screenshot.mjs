/*
 * Screenshot harness: launches the real app via Playwright's Electron driver
 * and captures a PNG of the first window. Used by agents and (eventually) CI
 * to verify UI changes against the actual app, not just tests.
 *
 * Run through ../bin/screenshot, which sources nvm and prefers xvfb-run when
 * available so no window flashes on a real desktop.
 *
 * Safety properties (see the discussion that introduced this):
 * - Playwright launches Electron over --remote-debugging-pipe (inherited fds),
 *   so no debugging port is ever open for another process to attach to.
 * - GOATCAD_USER_DATA_DIR points userData at a throwaway temp directory, so
 *   runs never touch the real config/session/recents — and, because Electron's
 *   single-instance lock is keyed by userData, the harness never collides with
 *   a real running GoatCAD either.
 */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright-core'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'screenshot.png' },
    size: { type: 'string', default: '1400x900' },
    // KiCad file(s) to open on launch, exactly like an OS double-click:
    // they ride in as argv and go through parseFileArgs → groupOpenTargets.
    open: { type: 'string', multiple: true, default: [] },
    // Device pixel ratio (--force-device-scale-factor). The window stays
    // --size CSS pixels; the PNG comes out size×dpr — use 2 for crisp
    // marketing/retina captures.
    dpr: { type: 'string' },
    // Path to an ESM driver: `export default async ({ app, page }) => {}`,
    // run after launch and before capture, to steer the app to a state.
    script: { type: 'string' },
    // Settle time (ms) after load/resize before capturing.
    wait: { type: 'string', default: '1000' },
    // Show the app on the real desktop instead of capturing headless — handy for
    // watching/debugging. The bin/screenshot wrapper reads this too (it skips
    // xvfb-run), and here it disables the X11/Wayland pinning.
    // Whole-run deadline (ms), launch to result; the build is not counted. A
    // driver stuck waiting, or an app too wedged to answer, ends the run with
    // exit 124 instead of holding the caller until someone interrupts it.
    timeout: { type: 'string', default: '120000' },
    visible: { type: 'boolean', default: false },
    // Reuse the existing out/ instead of rebuilding. Rebuild is the default:
    // a stale out/ silently screenshots the *previous* version of the UI,
    // which defeats the point of verifying a change.
    'no-build': { type: 'boolean', default: false },
    // Persist userData in a caller-owned directory instead of a throwaway temp
    // one, so a run can *observe what a previous run saved* — the only way to
    // test persisted state (view toggles, recents, session restore) from a
    // harness that is otherwise deliberately amnesiac. Never point this at the
    // real config dir: the app it launches writes to it for real.
    'user-data-dir': { type: 'string' }
  }
})

const [width, height] = values.size.split('x').map(Number)
if (!Number.isFinite(width) || !Number.isFinite(height)) {
  console.error(`Invalid --size "${values.size}" — expected WIDTHxHEIGHT, e.g. 1400x900`)
  process.exit(1)
}

if (!values['no-build']) {
  const build = spawnSync('./node_modules/.bin/electron-vite', ['build'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const keepUserData = Boolean(values['user-data-dir'])
const userDataDir = keepUserData
  ? resolve(values['user-data-dir'])
  : mkdtempSync(join(tmpdir(), 'goatcad-screenshot-'))
if (keepUserData) mkdirSync(userDataDir, { recursive: true })

let electronApp
// The deadline every run is held to (--timeout). A wedged app has nothing left
// to shut down cleanly, so this is the one place a kill is the right exit.
let stage = 'launching the app'
const watchdog = setTimeout(() => {
  console.error(`screenshot: gave up after ${values.timeout} ms while ${stage}`)
  // Clean up only once the app is gone: one still dying writes its userData
  // back out from under the delete.
  const proc = electronApp?.process()
  new Promise((gone) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return gone()
    proc.once('exit', gone)
    proc.kill('SIGKILL')
  }).then(() => {
    if (!keepUserData) rmSync(userDataDir, { recursive: true, force: true })
    process.exit(124)
  })
}, Number(values.timeout))

try {
  // Chromium switches are safe alongside file args: parseFileArgs skips
  // anything starting with "-".
  const launchArgs = ['out/main/index.js']
  // Headless (the default): force the X11 Ozone backend. On a Wayland session
  // Electron would otherwise render on the real compositor and ignore the DISPLAY
  // xvfb-run hands us — the window then pops up on the actual desktop instead of
  // the virtual display. X11 always exists here (xvfb's :99, or XWayland's :0),
  // so we pin it and the harness captures whatever DISPLAY it's given. With
  // --visible we skip this so the app appears normally on the current session.
  if (!values.visible) launchArgs.push('--ozone-platform=x11')
  if (values.dpr) launchArgs.push(`--force-device-scale-factor=${values.dpr}`)
  launchArgs.push(...values.open.map((f) => resolve(f)))

  // Terminals spawned by an electron-vite dev process (GoatHerd's embedded
  // shells) leak ELECTRON_RENDERER_URL into children; main's dev branch would
  // then load that other app's dev server instead of the out/ renderer this
  // harness just built. Always screenshot the built renderer.
  // GOATCAD_TEST_HOOKS turns on the renderer's window.__goatcad automation
  // bridge (element locate / world->screen); inert without it.
  // GOATCAD_MCP_PORT=0 serves the agent API on an ephemeral port, so a run
  // beside a real GoatCAD (which holds 8788) still has one; the driver reads
  // it from window.api.mcpStatus(). A caller may pin one instead.
  const env = {
    ...process.env,
    GOATCAD_USER_DATA_DIR: userDataDir,
    GOATCAD_TEST_HOOKS: '1',
    GOATCAD_MCP_PORT: process.env.GOATCAD_MCP_PORT ?? '0'
  }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  if (!values.visible) {
    // Belt-and-suspenders with --ozone-platform=x11: strip the Wayland hints so
    // nothing steers Electron (or GTK dialogs) back onto the real compositor.
    delete env.WAYLAND_DISPLAY
    delete env.GDK_BACKEND
  }

  electronApp = await _electron.launch({
    args: launchArgs,
    env
  })

  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(size.width, size.height)
      win.center()
    },
    { width, height }
  )

  await page.waitForTimeout(Number(values.wait))

  if (values.script) {
    const driver = await import(pathToFileURL(resolve(values.script)))
    stage = 'running the driver'
    try {
      await driver.default({ app: electronApp, page })
    } catch (err) {
      // What the driver was looking at when it gave up is most of the diagnosis.
      const failed = values.out.replace(/\.png$/i, '') + '.failed.png'
      await page.screenshot({ path: failed, timeout: 5000 }).then(
        () => console.error(`Driver failed — the window as it stood: ${failed}`),
        () => {}
      )
      throw err
    }
  }

  stage = 'capturing'
  await page.screenshot({ path: values.out })
  console.log(`Saved ${values.out} (${width}x${height})`)
} finally {
  // Leave through app.exit(): a driver that dirtied a document would otherwise
  // meet the unsaved-changes prompt, which close() waits on forever. exit()
  // skips the windows' close handlers but still shuts Chromium down in order
  // (GPU and helper processes included). The kill is only for an app too hung
  // to honor it — a run must end either way.
  stage = 'closing the app'
  const proc = electronApp?.process()
  if (electronApp && proc) {
    const exited = new Promise((done) => proc.once('exit', done))
    // The evaluate's reply dies with the process it just ended.
    electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10000))])
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  }
  clearTimeout(watchdog)
  if (!keepUserData) rmSync(userDataDir, { recursive: true, force: true })
}
