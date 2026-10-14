/*
 * Video harness for the marketing site (web/) — the moving-picture sibling of
 * this directory's screenshot.mjs, and the web counterpart of the Electron apps'
 * scripts/record.mjs. Builds the site, serves dist/ through Astro's preview
 * server, drives system Chrome with Playwright while a --script steers the page,
 * grabs page-level frames on a timer, and encodes them to mp4/gif with ffmpeg.
 *
 * Run through ../bin/record, which sources nvm. Headless by default (no xvfb
 * needed — Playwright's headless Chrome renders offscreen); --visible opens a
 * real window to watch the driver.
 *
 * Frames come from page.screenshot(), not an OS screen grab, so the output is
 * exactly the page content at the exact resolution — no desktop, no OS cursor,
 * identical headless or headed. A driver that wants a visible pointer injects its
 * own (page.mouse never renders into a screenshot). The ffmpeg encode below is
 * the same as the Electron harness's, kept in step deliberately.
 */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, preview } from 'astro'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'demo.mp4' },
    size: { type: 'string', default: '1400x900' },
    // Route to record, e.g. /docs. Ignored when --url is given.
    path: { type: 'string', default: '/' },
    // Record an arbitrary already-running URL instead; skips build+serve.
    url: { type: 'string' },
    dpr: { type: 'string', default: '1' },
    // Required ESM driver: `export default async ({ browser, context, page }) => {}`,
    // run while the recorder captures frames. A video of an idle page is not
    // worth encoding.
    script: { type: 'string' },
    // Capture + playback rate. Page screenshots realistically sustain ~10-15/s;
    // the encode uses this same rate so playback runs at real speed.
    fps: { type: 'string', default: '12' },
    // mp4 (H.264, default) or gif (palette two-pass).
    format: { type: 'string', default: 'mp4' },
    // Settle time (ms) after load before the driver and capture start.
    wait: { type: 'string', default: '500' },
    chrome: { type: 'string' },
    // Whole-run deadline (ms), Chrome launch to result; the site build is not counted. A
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
const dpr = Number(values.dpr)
if (!Number.isFinite(dpr) || dpr <= 0) {
  console.error(`Invalid --dpr "${values.dpr}"`)
  process.exit(1)
}
const fps = Number(values.fps)
if (!Number.isFinite(fps) || fps <= 0) {
  console.error(`Invalid --fps "${values.fps}"`)
  process.exit(1)
}
if (!values.script) {
  console.error('--script is required: a video needs a driver to steer the page.')
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

const frameDir = mkdtempSync(join(tmpdir(), 'goatcad-web-frames-'))
const frameInterval = 1000 / fps

let server
let browser
// The deadline a run is held to once the site is built and served (--timeout).
// Playwright takes its Chrome down with this process, so exiting is enough.
let stage = 'launching Chrome'
let watchdog = null
const armWatchdog = () => {
  watchdog = setTimeout(() => {
    console.error(`record: gave up after ${values.timeout} ms while ${stage}`)
    rmSync(frameDir, { recursive: true, force: true })
    process.exit(124)
  }, Number(values.timeout))
}

try {
  let target = values.url
  if (!target) {
    if (!values['no-build']) await build({ logLevel: 'info' })
    server = await preview({ logLevel: 'silent', server: { port: 0 } })
    const path = values.path.startsWith('/') ? values.path : `/${values.path}`
    target = `http://localhost:${server.port}${path}`
  }

  armWatchdog()
  browser = await launchChrome(values)
  stage = 'loading the page'
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr
    // No reducedMotion override here: motion is the whole point of a recording.
  })
  const page = await context.newPage()

  await page.goto(target, { waitUntil: 'networkidle' })
  await page.waitForTimeout(Number(values.wait))

  // Concurrent capture loop: grab frames on a timer while the driver runs.
  // Playwright serializes calls over one connection, so screenshots interleave
  // safely with the driver's clicks/typing; a transient grab error (mid
  // navigation) is skipped rather than fatal.
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
        /* page busy this tick — skip the frame */
      }
      const elapsed = Date.now() - started
      if (elapsed < frameInterval) await page.waitForTimeout(frameInterval - elapsed)
    }
  })()

  try {
    const driver = await import(pathToFileURL(resolve(values.script)))
    stage = 'running the driver'
    await driver.default({ browser, context, page })
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
  console.log(
    `Saved ${values.out} — ${frameCount} frames @ ${fps}fps (${width}x${height}) — ${target}`
  )
} finally {
  stage = 'closing Chrome'
  await browser?.close()
  clearTimeout(watchdog)
  await server?.stop()
  rmSync(frameDir, { recursive: true, force: true })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain JS dev script
async function launchChrome({ chrome, visible }) {
  const opts = { headless: !visible }
  const exe = chrome ?? process.env.PLAYWRIGHT_CHROME
  if (exe) opts.executablePath = exe
  else opts.channel = 'chrome'
  try {
    return await chromium.launch(opts)
  } catch (err) {
    console.error(
      'Could not launch Chrome. This harness drives the system Google Chrome ' +
        '(no browser is bundled). Install Chrome, or pass --chrome /path/to/chromium.\n' +
        String(err)
    )
    process.exit(1)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain JS dev script
function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`${cmd} exited ${res.status}`)
    process.exit(res.status ?? 1)
  }
}
