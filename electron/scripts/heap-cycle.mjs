/**
 * A `bin/screenshot --script` driver that closes and reopens one board and
 * prints the renderer's JS heap after each: flat after the second open is
 * healthy, a step every cycle is a leak (RULES.md §11). Files passed to
 * `--open` before the board stay open throughout, so a board can be cycled
 * beside its schematics.
 *
 *   HEAP_FILE=board.kicad_pcb ./bin/screenshot --open path/to/*.kicad_sch \
 *     --open path/to/board.kicad_pcb --script scripts/heap-cycle.mjs --timeout 600000
 *
 * HEAP_FILE is the name the file explorer shows, which the reopen double-clicks.
 * HEAP_CYCLES (default 4) sets how many. Each line reads the heap as found
 * (`live`), then garbage collected (`js`): a gap that a collection closes is
 * collection lag, a `js` that climbs is held memory. HEAP_SNAPSHOT=<path>
 * writes a heap snapshot after the last close, for `scripts/heap-retainers.mjs`.
 * Unsaved prompts are answered Don't Save.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { createWriteStream, readFileSync } from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const name = process.env.HEAP_FILE
const cycles = Number(process.env.HEAP_CYCLES ?? 4)
const snapshot = process.env.HEAP_SNAPSHOT
const MB = 1048576

export default async ({ app, page }) => {
  if (!name) throw new Error('heap-cycle: set HEAP_FILE to the file name the explorer shows')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const pid = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
  )
  const rss = () =>
    Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024)
  const used = async () => Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / MB)
  const collect = async () => {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
  }
  const limit = await page.evaluate(() => performance.memory?.jsHeapSizeLimit ?? 0)
  console.log(`HEAP limit ${Math.round(limit / MB)}MB`)
  const report = async (label) => {
    const live = await used()
    await collect()
    const tabs = await page.locator('.tab-item').count()
    console.log(
      `HEAP ${label.padEnd(9)} live=${live}MB js=${await used()}MB rss=${rss()}MB` +
        ` tabs=${tabs} workers=${page.workers().length}`
    )
  }

  // Settled: the renderer main thread under 10% busy for 2 s, as bin/board-timing reads it.
  const taskSeconds = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value
  const settled = async () => {
    const start = Date.now()
    let calmSince = null
    let lastTask = await taskSeconds()
    let lastWall = Date.now()
    while (Date.now() - start < 30000) {
      await sleep(250)
      const task = await taskSeconds()
      const wall = Date.now()
      const busy = ((task - lastTask) * 1000) / (wall - lastWall)
      lastTask = task
      lastWall = wall
      if (busy >= 0.1) calmSince = null
      else if (calmSince === null) calmSince = wall
      else if (wall - calmSince >= 2000) return
    }
    console.log('HEAP (never settled; reading anyway)')
  }
  const shown = () => page.evaluate(() => performance.getEntriesByName('board:shown').length)
  const opened = async (before) => {
    console.log('HEAP … waiting for the board to show')
    await page.waitForFunction(
      (n) => performance.getEntriesByName('board:shown').length > n,
      before,
      {
        timeout: 90000,
        polling: 250
      }
    )
    await settled()
  }
  const tab = () =>
    page.locator('.tab-item', { has: page.locator('.tab-title', { hasText: name }) })
  const close = async () => {
    console.log('HEAP … closing')
    await tab().first().click()
    await page.keyboard.press('Control+w')
    await tab().first().waitFor({ state: 'detached', timeout: 15000 })
    await settled()
  }

  // The last file opened may not be the one in front; a board draws only when shown.
  await tab().first().waitFor({ timeout: 30000 })
  await tab().first().click()
  await opened(0)
  await report('open 1')
  for (let i = 1; i <= cycles; i++) {
    await close()
    await report(`closed ${i}`)
    const before = await shown()
    await page.locator(`.tree-node-label[title="${name}"]`).first().dblclick()
    await opened(before)
    await report(`open ${i + 1}`)
  }
  if (!snapshot) return
  await close()
  await collect()
  const out = createWriteStream(snapshot)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => out.write(chunk))
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await new Promise((resolve) => out.end(resolve))
  console.log(`HEAP snapshot ${snapshot}`)
}
