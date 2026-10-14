/**
 * Smoke-test a packaged build: launch the real binary with a fresh profile and
 * check that the renderer came up whole — the preload bridge is there, the
 * Welcome tab mounted, and nothing errored. This is the check that a dev run
 * cannot make: fuses, the asar and the packaged preload only exist
 * here (docs/RELEASES.md §9).
 *
 * Driven over Chromium's remote-debugging port rather than Playwright's own
 * Electron launcher, because the enableNodeCliInspectArguments fuse blocks the
 * --inspect flag that launcher relies on. Console errors from before the
 * connection would be lost, so the page is reloaded once attached.
 *
 * Invoked by bin/verify-packaged, which starts the app; this script only
 * connects, judges, and exits 1 on any failure.
 */
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9333' },
    screenshot: { type: 'string' },
    timeout: { type: 'string', default: '30000' }
  }
})
const endpoint = `http://127.0.0.1:${values.port}`
const deadline = Date.now() + Number(values.timeout)

// The app takes a few seconds to open its debugging port.
let browser = null
while (!browser) {
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 })
  } catch (err) {
    if (Date.now() > deadline) {
      console.error(`verify-packaged: no debugging endpoint at ${endpoint}: ${err.message}`)
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

const failures = []
try {
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('the app opened no window')

  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().split('\n')[0]}`)
  })
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message.split('\n')[0]}`))

  await page.reload()
  const welcome = await page
    .waitForFunction(
      () => typeof window.api === 'object' && !!document.querySelector('[class*="welcome"]'),
      null,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false)

  const state = await page.evaluate(() => ({
    api: typeof window.api === 'object' ? Object.keys(window.api).length : 0,
    title: document.title,
    welcome: !!document.querySelector('[class*="welcome"]')
  }))

  if (state.api === 0) failures.push('window.api is missing — the preload did not load')
  if (!welcome || !state.welcome) failures.push('the Welcome tab did not mount')
  for (const e of errors) failures.push(e)

  console.log(
    `bridge: ${state.api} entries · title: "${state.title}" · welcome: ${state.welcome} · renderer errors: ${errors.length}`
  )
  if (values.screenshot) {
    await page.screenshot({ path: values.screenshot })
    console.log(`saved ${values.screenshot}`)
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err))
} finally {
  await browser.close().catch(() => {})
}

if (failures.length) {
  console.error('verify-packaged: FAILED')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('verify-packaged: OK')
