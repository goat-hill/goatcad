/*
 * Screenshot harness for the marketing site (web/) — the web sibling of the
 * Electron apps' scripts/screenshot.mjs. Same job (capture a PNG to verify a
 * visual change against the real thing), different machinery: there is no
 * Electron window here, just a static Astro build served to a real browser.
 *
 * Flow: build the site → serve dist/ through Astro's own preview server (so
 * routing, trailing slashes and 404s match production) → drive system Chrome
 * with Playwright → capture the page. Run through ../bin/screenshot, which
 * sources nvm.
 *
 * Why Playwright + system Chrome (channel: 'chrome'): playwright-core is already
 * the repo's driver (electron/, develop/) and ships no browser binary, so the
 * harness reuses the Google Chrome installed on the machine — no multi-hundred-MB
 * browser download in web/'s install, and CI (which only builds web/) stays fast.
 * Pass --chrome / $PLAYWRIGHT_CHROME to point at a specific binary.
 *
 * Headless by default, so unlike the Electron harness there is no xvfb dance and
 * nothing flashes on screen; --visible opens a real Chrome window to watch a
 * driver run.
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, preview } from 'astro'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'screenshot.png' },
    // Browser viewport (CSS pixels). The PNG is size×dpr.
    size: { type: 'string', default: '1400x900' },
    // Route on the local site to capture, e.g. /docs/installation. Ignored when
    // --url is given.
    path: { type: 'string', default: '/' },
    // Capture an arbitrary already-running URL instead (e.g. the live site or a
    // running dev server). Skips the build+serve entirely.
    url: { type: 'string' },
    // Device pixel ratio (deviceScaleFactor); use 2 for crisp retina/marketing
    // captures — the PNG comes out size×2.
    dpr: { type: 'string', default: '1' },
    // Settle time (ms) after load before capture. Pages are static, so the
    // default is short; raise it if a --script animation needs to land.
    wait: { type: 'string', default: '300' },
    // Capture the whole scrollable page rather than just the viewport.
    'full-page': { type: 'boolean', default: false },
    // ESM driver run after load, before capture: `export default async
    // ({ browser, context, page }) => {}` — same page-driving shape as the
    // GoatHerd DOM drivers.
    script: { type: 'string' },
    // OS color preference to emulate: dark (default) or light. Pages that opt
    // into light/dark (docs) follow it; the landing page is pinned dark.
    'color-scheme': { type: 'string', default: 'dark' },
    // Explicit Chrome/Chromium binary; overrides the system-Chrome channel.
    chrome: { type: 'string' },
    // Show a real Chrome window instead of headless — handy for watching a driver.
    // Whole-run deadline (ms), Chrome launch to result; the site build is not counted. A
    // driver stuck waiting, or an app too wedged to answer, ends the run with
    // exit 124 instead of holding the caller until someone interrupts it.
    timeout: { type: 'string', default: '120000' },
    visible: { type: 'boolean', default: false },
    // Reuse the existing dist/ instead of rebuilding. Rebuild is the default so a
    // stale dist/ never silently screenshots the previous version of the page.
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

let server
let browser
// The deadline a run is held to once the site is built and served (--timeout).
// Playwright takes its Chrome down with this process, so exiting is enough.
let stage = 'launching Chrome'
let watchdog = null
const armWatchdog = () => {
  watchdog = setTimeout(() => {
    console.error(`screenshot: gave up after ${values.timeout} ms while ${stage}`)
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
    deviceScaleFactor: dpr,
    // Deterministic captures: hold animations (e.g. the hero motif) at their end
    // state rather than catching a random frame. A --script can still drive time.
    reducedMotion: 'reduce',
    colorScheme: values['color-scheme']
  })
  const page = await context.newPage()

  await page.goto(target, { waitUntil: 'networkidle' })
  await page.waitForTimeout(Number(values.wait))

  if (values.script) {
    const driver = await import(pathToFileURL(resolve(values.script)))
    stage = 'running the driver'
    await driver.default({ browser, context, page })
  }

  await page.screenshot({ path: values.out, fullPage: values['full-page'] })
  console.log(`Saved ${values.out} (${width}x${height}${dpr !== 1 ? ` @${dpr}x` : ''}) — ${target}`)
} finally {
  stage = 'closing Chrome'
  await browser?.close()
  clearTimeout(watchdog)
  await server?.stop()
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
