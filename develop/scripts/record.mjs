/*
 * GoatHerd video harness: the develop/ sibling of electron/scripts/record.mjs and
 * the moving-picture sibling of this dir's screenshot.mjs. Launches the real
 * GoatHerd app via Playwright's Electron driver, runs a --script driver that
 * steers a demo, records the window by grabbing page-level frames on a timer,
 * then encodes them to mp4/gif with ffmpeg.
 *
 * Run through ../bin/record, which sources nvm and prefers xvfb-run when
 * available so nothing flashes on a real desktop.
 *
 * Why page.screenshot frames instead of an OS screen grab (ffmpeg x11grab):
 * capturing at the page level yields exactly the window content at the exact
 * resolution — no desktop background, no OS cursor, identical whether the app
 * runs on a real display or a headless Xvfb.
 *
 * Safety properties are inherited verbatim from screenshot.mjs: a throwaway
 * --user-data-dir (real state untouched), GOATHERD_HOOK_PORT=0 (no collision
 * with a running GoatHerd), and --remote-debugging-pipe (no open debug port).
 */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright-core'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'demo.mp4' },
    size: { type: 'string', default: '1400x900' },
    dpr: { type: 'string' },
    // Path to an ESM driver: `export default async ({ app, page }) => {}`,
    // run while the recorder captures frames. Required — a video of a static
    // idle window is not worth encoding.
    script: { type: 'string' },
    // Capture rate. Page-level screenshots realistically sustain ~10-15/s at
    // 1400x900; the encode uses this same rate so playback runs at real speed.
    fps: { type: 'string', default: '12' },
    // mp4 (H.264, default) or gif (palette two-pass).
    format: { type: 'string', default: 'mp4' },
    // Settle time (ms) after load/resize before the driver (and capture) start.
    wait: { type: 'string', default: '1000' },
    // Show the app on the real desktop instead of recording headless — handy for
    // watching/debugging. The bin/record wrapper reads this too (it skips
    // xvfb-run), and here it disables the X11/Wayland pinning.
    // Whole-run deadline (ms), launch to result; the build is not counted. A
    // driver stuck waiting, or an app too wedged to answer, ends the run with
    // exit 124 instead of holding the caller until someone interrupts it.
    timeout: { type: 'string', default: '300000' },
    visible: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false }
  }
})

const [width, height] = values.size.split('x').map(Number)
if (!Number.isFinite(width) || !Number.isFinite(height)) {
  console.error(`Invalid --size "${values.size}" — expected WIDTHxHEIGHT, e.g. 1400x900`)
  process.exit(1)
}
const fps = Number(values.fps)
if (!Number.isFinite(fps) || fps <= 0) {
  console.error(`Invalid --fps "${values.fps}"`)
  process.exit(1)
}
if (!values.script) {
  console.error('--script is required: a video needs a driver to steer the app.')
  process.exit(1)
}
if (values.format !== 'mp4' && values.format !== 'gif') {
  console.error(`Invalid --format "${values.format}" — expected mp4 or gif`)
  process.exit(1)
}
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg not found on PATH — install it to encode the recording.')
  process.exit(1)
}

if (!values['no-build']) {
  const build = spawnSync('./node_modules/.bin/electron-vite', ['build'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'goatherd-record-'))
const frameDir = mkdtempSync(join(tmpdir(), 'goatherd-frames-'))
const frameInterval = 1000 / fps

let electronApp
// The deadline every run is held to (--timeout). A wedged app has nothing left
// to shut down cleanly, so this is the one place a kill is the right exit.
let stage = 'launching the app'
const watchdog = setTimeout(() => {
  console.error(`record: gave up after ${values.timeout} ms while ${stage}`)
  // Clean up only once the app is gone: one still dying writes its userData
  // back out from under the delete.
  const proc = electronApp?.process()
  new Promise((gone) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return gone()
    proc.once('exit', gone)
    proc.kill('SIGKILL')
  }).then(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(frameDir, { recursive: true, force: true })
    process.exit(124)
  })
}, Number(values.timeout))

try {
  const launchArgs = ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  if (!values.visible) launchArgs.push('--ozone-platform=x11')
  if (values.dpr) launchArgs.push(`--force-device-scale-factor=${values.dpr}`)

  const env = { ...process.env, GOATHERD_HOOK_PORT: '0' }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  if (!values.visible) {
    delete env.WAYLAND_DISPLAY
    delete env.GDK_BACKEND
  }

  electronApp = await _electron.launch({ args: launchArgs, env })

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

  // Concurrent capture loop: grab frames on a timer while the driver runs.
  // Playwright multiplexes calls over one pipe, so screenshots interleave safely
  // with the driver's clicks/typing; a transient grab error is skipped, not fatal.
  let recording = true
  let frameCount = 0
  const captureLoop = (async () => {
    while (recording) {
      const started = Date.now()
      try {
        await page.screenshot({
          path: join(frameDir, `f${String(frameCount).padStart(6, '0')}.png`)
        })
        frameCount++
      } catch {
        /* window busy this tick — skip the frame */
      }
      const elapsed = Date.now() - started
      if (elapsed < frameInterval) await page.waitForTimeout(frameInterval - elapsed)
    }
  })()

  try {
    const driver = await import(pathToFileURL(resolve(values.script)))
    stage = 'running the driver'
    await driver.default({ app: electronApp, page })
  } finally {
    recording = false
    await captureLoop
  }

  if (frameCount === 0) {
    console.error('No frames captured — the driver may have failed immediately.')
    process.exit(1)
  }

  const input = join(frameDir, 'f%06d.png')
  // H.264 needs even dimensions; scale filter trims a stray odd pixel.
  const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  if (values.format === 'mp4') {
    run('ffmpeg', [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      input,
      '-vf',
      `${evenScale},format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
      values.out
    ])
  } else {
    const palette = join(frameDir, 'palette.png')
    run('ffmpeg', [
      '-y',
      '-i',
      input,
      '-vf',
      `fps=${fps},${evenScale}:flags=lanczos,palettegen`,
      palette
    ])
    run('ffmpeg', [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      input,
      '-i',
      palette,
      '-lavfi',
      `fps=${fps},${evenScale}:flags=lanczos [x]; [x][1:v] paletteuse`,
      values.out
    ])
  }
  console.log(`Saved ${values.out} — ${frameCount} frames @ ${fps}fps (${width}x${height})`)
} finally {
  // GoatHerd has no close prompt to wait on, and close() is what lets it dispose
  // its ptys — but a hung app must not hold the run, so it gets a moment, then
  // the kill.
  stage = 'closing the app'
  const proc = electronApp?.process()
  await Promise.race([electronApp?.close(), new Promise((done) => setTimeout(done, 10000))])
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  clearTimeout(watchdog)
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(frameDir, { recursive: true, force: true })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations
function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`${cmd} exited ${res.status}`)
    process.exit(res.status ?? 1)
  }
}
