/*
 * Board timing: open one complex board in the built app and time what a user
 * feels on it — open, pan, zoom, hover, select, and moving a footprint — with
 * the renderer's heap after open and after the edit. A manual check, not a CI
 * gate (timings vary per machine); see docs/performance-workstream.md.
 *
 * The board is KiCad's Jetson AGX Thor demo, read from the KiCad checkout
 * (KICAD_SOURCE, ~/code/kicad by default); --board names another.
 *
 * "Settled" is the renderer main thread under 10% busy for SETTLE_MS, from
 * Chromium's cumulative TaskDuration. The refill and the checks run in the
 * board worker, past that: "checked" is when the first check of the board as
 * it then was answered, read from the measures the worker's host records, and
 * the run logs the slowest zones and phases of that refill and check. Times
 * are ms since the main process started, or from the gesture for the operations.
 *
 * Run through ../bin/board-timing, which prefers xvfb-run. Headless, llvmpipe
 * draws the frames, so frame times there say nothing about a real GPU — read
 * CPU time and heap there, frame rate from --visible. Driven at the window's
 * default size: resizing it under CDP profiling stalls the load on Wayland.
 *
 * --record runs the standard method (fresh build, fresh profile, the default
 * board, RECORD_RUNS runs) and appends the medians to perf/board-history.html.
 * --profile writes a .cpuprofile per operation to --out for digging.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, homedir, platform, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { _electron } from 'playwright-core'

const DEFAULT_BOARD = join(
  process.env.KICAD_SOURCE ?? join(homedir(), 'code/kicad'),
  'demos/jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb'
)

const { values } = parseArgs({
  options: {
    runs: { type: 'string' },
    board: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    visible: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    // The row's label in the history; the branch name when omitted.
    label: { type: 'string' },
    profile: { type: 'boolean', default: false },
    out: { type: 'string', default: 'board-timing-out' }
  }
})

const RECORD_RUNS = 1
const HISTORY = 'perf/board-history.html'
const DATA_BLOCK = /(<script type="application\/json" id="board-data">\s*)([\s\S]*?)(\s*<\/script>)/
const SETTLE_MS = 2000
// Human-scale caps: a board that has not shown or settled by then is a regression to look at, not to wait out.
const SHOW_TIMEOUT_MS = 30000
const SETTLE_TIMEOUT_MS = 45000
// The board worker's refill and check run off the main thread, past where it settles.
const CHECK_TIMEOUT_MS = 120000

if (values.record) {
  const nonstandard = [
    values.runs !== undefined && '--runs',
    values.board !== undefined && '--board',
    values['no-build'] && '--no-build',
    values.profile && '--profile'
  ].filter(Boolean)
  if (nonstandard.length > 0) {
    console.error(`board-timing: --record runs the standard method; drop ${nonstandard.join(', ')}`)
    process.exit(1)
  }
}

const board = resolve(values.board ?? DEFAULT_BOARD)
if (!existsSync(board)) {
  console.error(`board-timing: no board at ${board} (set KICAD_SOURCE or pass --board)`)
  process.exit(1)
}
// The design is known by the board file's git blob hash, which names its content in any
// checkout. A row is only recorded against a folder with no local edits to tracked files.
const inDesign = (...args) =>
  spawnSync('git', ['-C', dirname(board), ...args], { encoding: 'utf8' })
const designSha = inDesign('hash-object', board).stdout.trim().slice(0, 10) || null
const designEdits = inDesign(
  'status',
  '--porcelain',
  '--untracked-files=no',
  '--',
  '.'
).stdout.trim()
if (values.record && designEdits) {
  console.error(`board-timing: the design has local edits; restore them to record:\n${designEdits}`)
  process.exit(1)
}

// Never out/: a build empties it, which would break a dev app running from it.
const OUT_DIR = 'node_modules/.cache/board-timing'
if (!values['no-build']) {
  const build = spawnSync('./node_modules/.bin/electron-vite', ['build', '--outDir', OUT_DIR], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
if (values.profile) mkdirSync(values.out, { recursive: true })

const log = (message) => process.stderr.write(`${message}\n`)

async function runOnce(run) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'goatcad-board-timing-'))
  const args = [join(OUT_DIR, 'main/index.js')]
  if (!values.visible) args.push('--ozone-platform=x11')
  args.push(board)
  // Same isolation as launch-timing, plus the harness's test hooks (window.__goatcad).
  const env = {
    ...process.env,
    GOATCAD_USER_DATA_DIR: userDataDir,
    GOATCAD_MCP_PORT: '0',
    GOATCAD_TEST_HOOKS: '1'
  }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  if (!values.visible) {
    delete env.WAYLAND_DISPLAY
    delete env.GDK_BACKEND
  }

  const app = await _electron.launch({ args, env, timeout: SHOW_TIMEOUT_MS })
  try {
    const page = await app.firstWindow()
    // The app's own errors, so a broken worker or a failed check is seen, not timed.
    page.on('console', (m) => {
      if (m.type() === 'error') log(`run ${run}: console error: ${m.text().slice(0, 300)}`)
    })
    page.on('pageerror', (e) => log(`run ${run}: page error: ${String(e).slice(0, 300)}`))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await page.evaluate(() => {
      window.__timing = { long: [] }
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__timing.long.push([e.startTime, e.duration])
      }).observe({ type: 'longtask', buffered: true })
    })
    const now = () => page.evaluate(() => performance.now())
    const shift =
      (await page.evaluate(() => performance.timeOrigin)) -
      (await app.evaluate(() => performance.timeOrigin))

    const taskSeconds = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')
        .value
    /** Renderer time at which the main thread went quiet, or null past the cap. */
    const settled = async () => {
      const start = Date.now()
      let calmSince = null
      let calmAt = null
      let lastTask = await taskSeconds()
      let lastWall = Date.now()
      for (;;) {
        await new Promise((done) => setTimeout(done, 250))
        const task = await taskSeconds()
        const wall = Date.now()
        const busy = ((task - lastTask) * 1000) / (wall - lastWall)
        lastTask = task
        lastWall = wall
        if (busy < 0.1) {
          if (calmSince === null) {
            calmSince = wall
            calmAt = (await now()) - 250
          }
          if (wall - calmSince >= SETTLE_MS) return calmAt
        } else calmSince = null
        if (wall - start > SETTLE_TIMEOUT_MS) return null
      }
    }
    /**
     * The board worker's jobs since renderer time `t`, from the measures its host records
     * (boardWorkerHost.ts): the first check that answered for the board as it then was, and
     * the refill before it, each logged with its slowest steps; null past the cap.
     */
    const checkedSince = async (t, label) => {
      const start = Date.now()
      for (;;) {
        const jobs = await page.evaluate(
          (t) =>
            performance
              .getEntriesByType('measure')
              .filter((e) => e.name.startsWith('board:') && e.startTime >= t)
              .map((e) => ({
                name: e.name,
                start: e.startTime,
                ms: e.duration,
                superseded: e.detail?.superseded ?? false
              })),
          t
        )
        const isJob = (e) => !e.name.includes(' · ')
        const check = jobs.find(
          (e) => isJob(e) && e.name.startsWith('board:check') && !e.superseded
        )
        if (check) {
          const refill = jobs
            .filter((e) => isJob(e) && e.name.startsWith('board:refill'))
            .filter((e) => e.start + e.ms <= check.start)
            .at(-1)
          const stepsOf = (job) =>
            jobs
              .filter((e) => e.name.startsWith(`${job.name} · `))
              .filter((e) => e.start >= job.start && e.start + e.ms <= job.start + job.ms + 1)
          const top = (job) =>
            stepsOf(job)
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 8)
              .map((e) => `${e.name.split(' · ')[1]} ${Math.round(e.ms)}`)
              .join(', ')
          const firstJob = refill ?? check
          log(`${label}: ${Math.round(firstJob.start - t)} ms before the first job`)
          if (refill) {
            log(`  ${refill.name} ${Math.round(refill.ms)} ms: ${top(refill)}`)
            log(`  ${Math.round(check.start - refill.start - refill.ms)} ms between`)
          }
          log(`  ${check.name} ${Math.round(check.ms)} ms: ${top(check)}`)
          return { end: check.start + check.ms, check: check.ms, refill: refill?.ms ?? 0 }
        }
        if (Date.now() - start > CHECK_TIMEOUT_MS) return null
        await new Promise((done) => setTimeout(done, 250))
      }
    }
    const longestSince = (t) =>
      page.evaluate(
        (t) => Math.max(0, ...window.__timing.long.filter(([s]) => s >= t).map(([, d]) => d)),
        t
      )
    const heapMb = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      return Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20)
    }
    /** Each board worker's heap, through the main process's debugger on the window. */
    const workerHeapMb = () =>
      app.evaluate(async ({ BrowserWindow }) => {
        const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger
        if (!dbg.isAttached()) dbg.attach('1.3')
        const { targetInfos } = await dbg.sendCommand('Target.getTargets')
        let total = 0
        for (const target of targetInfos) {
          if (target.type !== 'worker' || !target.url.includes('boardWorker')) continue
          const { sessionId } = await dbg.sendCommand('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true
          })
          await dbg.sendCommand('HeapProfiler.collectGarbage', {}, sessionId)
          total += (await dbg.sendCommand('Runtime.getHeapUsage', {}, sessionId)).usedSize
          await dbg.sendCommand('Target.detachFromTarget', { sessionId })
        }
        return Math.round(total / 2 ** 20)
      })
    /** The renderer process's resident memory: the page and its workers, heaps and all. */
    const rendererMb = async () => {
      const pid = await page.evaluate(() => window.api?.processId?.() ?? null).catch(() => null)
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, kb: m.memory.workingSetSize }))
      )
      const tab = metrics.find((m) => (pid ? m.pid === pid : m.type === 'Tab'))
      return tab ? Math.round(tab.kb / 1024) : NaN
    }
    const profiled = async (name, fn) => {
      log(`run ${run}: ${name}`)
      if (!values.profile) return fn()
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
      const result = await fn()
      const { profile } = await cdp.send('Profiler.stop')
      writeFileSync(join(values.out, `run${run}-${name}.cpuprofile`), JSON.stringify(profile))
      return result
    }
    /** Frame intervals while `fn` runs: p95 and worst, ms. */
    const framed = async (fn) => {
      await page.evaluate(() => {
        const frames = (window.__timing.frames = [])
        let last = performance.now()
        window.__timing.framing = true
        const tick = (t) => {
          frames.push(t - last)
          last = t
          if (window.__timing.framing) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await fn()
      return page.evaluate(() => {
        window.__timing.framing = false
        const f = window.__timing.frames.slice(1).sort((a, b) => a - b)
        const at = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))] ?? NaN
        return { p95: at(0.95), max: at(1) }
      })
    }
    const nextFrame = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

    const row = {}
    await profiled('open', async () => {
      await page.waitForFunction(
        () => performance.getEntriesByName('board:shown').length > 0,
        null,
        { timeout: SHOW_TIMEOUT_MS, polling: 100 }
      )
      const quiet = await settled()
      const mark = (name) =>
        page.evaluate((name) => performance.getEntriesByName(name)[0]?.startTime ?? NaN, name)
      row['board parsed'] = (await mark('board:parsed')) + shift
      row['board shown'] = (await mark('board:shown')) + shift
      row['open settled'] = quiet === null ? NaN : quiet + shift
      const checked = await checkedSince(0, 'open')
      row['open checked'] = checked ? checked.end + shift : NaN
      row['open refill'] = checked?.refill ?? NaN
      row['open check'] = checked?.check ?? NaN
    })
    row['heap after open'] = await heapMb()
    row['worker heap after open'] = await workerHeapMb()
    row['renderer after open'] = await rendererMb()

    const box = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll('canvas')].sort(
        (a, b) => b.width * b.height - a.width * a.height
      )[0]
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2

    const pan = await profiled('pan', () =>
      framed(async () => {
        await page.mouse.move(cx, cy)
        await page.mouse.down({ button: 'middle' })
        for (let i = 0; i < 60; i++) {
          await page.mouse.move(cx + Math.sin(i / 10) * 300, cy + Math.cos(i / 10) * 200)
          await page.waitForTimeout(16)
        }
        await page.mouse.up({ button: 'middle' })
      })
    )
    row['pan p95'] = pan.p95
    await settled()
    const zoom = await profiled('zoom', () =>
      framed(async () => {
        await page.mouse.move(cx, cy)
        for (const dy of [-100, 100]) {
          for (let i = 0; i < 15; i++) {
            await page.mouse.wheel(0, dy)
            await page.waitForTimeout(30)
          }
        }
      })
    )
    row['zoom p95'] = zoom.p95
    await settled()
    const hover = await profiled('hover', () =>
      framed(async () => {
        for (let i = 0; i < 80; i++) {
          await page.mouse.move(
            box.x + 100 + ((i * 17) % (box.w - 200)),
            box.y + 100 + ((i * 29) % (box.h - 200))
          )
          await page.waitForTimeout(16)
        }
      })
    )
    row['hover p95'] = hover.p95
    await settled()

    // The largest footprint on screen: on Jetson, the SoM connector.
    const target = await page.evaluate(() => {
      const all = window.__goatcad.listElements('footprint').filter((e) => e.screenRect)
      all.sort(
        (a, b) =>
          b.screenRect.width * b.screenRect.height - a.screenRect.width * a.screenRect.height
      )
      return all[0]
    })
    const { x, y } = target.screenCenter
    const pads = await page.evaluate(() =>
      window.__goatcad
        .listElements('pad')
        .filter((p) => p.screenCenter && p.value && !p.value.startsWith('unconnected-'))
    )
    // Through the DOM: a narrow window's toolbar folds the button away (data-toolbar-hidden).
    const armRouter = () =>
      page.evaluate(() => {
        const button = document.querySelector('[data-tool-op="route"]')
        if (button && !button.classList.contains('active')) button.click()
      })
    const undoTitle = () =>
      page.evaluate(() => document.querySelector('[data-tool-op="undo"]')?.title ?? '')

    // Route into the connector's pad field and give up (Esc): each cursor move to the frame
    // that shows it. In the default mode the head stops where the field closes; the moves
    // past that are what a user pushing into it feels.
    const fieldPads = pads.filter((p) => p.ref.startsWith(`${target.ref}.`))
    const fieldPad = fieldPads[Math.floor(fieldPads.length / 2)]
    const route = await profiled('route', async () => {
      await armRouter()
      await page.mouse.click(fieldPad.screenCenter.x, fieldPad.screenCenter.y)
      const latencies = []
      for (let i = 1; i <= 60; i++) {
        const started = performance.now()
        await page.mouse.move(fieldPad.screenCenter.x + i * 4, fieldPad.screenCenter.y + i * 2.5)
        await nextFrame()
        latencies.push(performance.now() - started)
      }
      await page.keyboard.press('Escape')
      latencies.sort((a, b) => a - b)
      return { p95: latencies[Math.floor(latencies.length * 0.95)], max: latencies.at(-1) }
    })
    row['route move p95'] = route.p95
    row['route move worst'] = route.max
    await settled()

    // Lay a short track off a small part's pad and end the route: the refill and checks a
    // finished trace sets off. In the default mode the head stops at what it meets, so a stub
    // is tried off the passives nearest the view's center, each way in turn, and the first that
    // lays a track (the Undo label changes) is the one timed.
    const stubPads = pads
      .filter((p) => /^[RC]\d/.test(p.ref))
      .sort(
        (a, b) =>
          Math.hypot(a.screenCenter.x - cx, a.screenCenter.y - cy) -
          Math.hypot(b.screenCenter.x - cx, b.screenCenter.y - cy)
      )
      .slice(0, 8)
    const STUB_PX = 12
    let laid = null
    await profiled('route-commit', async () => {
      for (const pad of stubPads) {
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1]
        ]) {
          await armRouter()
          const undoBefore = await undoTitle()
          const end = { x: pad.screenCenter.x + dx * STUB_PX, y: pad.screenCenter.y + dy * STUB_PX }
          await page.mouse.click(pad.screenCenter.x, pad.screenCenter.y)
          await page.mouse.move(end.x, end.y, { steps: 4 })
          await nextFrame()
          const committed = await now()
          await page.mouse.click(end.x, end.y)
          await page.keyboard.press('Escape')
          await nextFrame()
          if ((await undoTitle()) === undoBefore) continue
          laid = pad.ref
          const quiet = await settled()
          row['route commit → settled'] = quiet === null ? NaN : quiet - committed
          row['worst task after commit'] = await longestSince(committed)
          const checked = await checkedSince(committed, 'route commit')
          row['route commit → checked'] = checked ? checked.end - committed : NaN
          return
        }
      }
    })
    if (!laid) {
      log(`run ${run}: no stub could be laid; the commit timings are of nothing`)
      row['route commit → settled'] = NaN
      row['worst task after commit'] = NaN
      row['route commit → checked'] = NaN
    }
    await page.keyboard.press('Escape')

    row['select'] = await profiled('select', async () => {
      const started = Date.now()
      await page.mouse.click(x, y)
      await nextFrame()
      return Date.now() - started
    })
    await settled()

    await profiled('move', async () => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(x + i * 3, y + i * 2)
        await page.waitForTimeout(16)
      }
      const dropped = await now()
      await page.mouse.up()
      const quiet = await settled()
      row['drop → settled'] = quiet === null ? NaN : quiet - dropped
      row['worst task after drop'] = await longestSince(dropped)
      const checked = await checkedSince(dropped, 'drop')
      row['drop → checked'] = checked ? checked.end - dropped : NaN
    })
    const moved = await page.evaluate((ref) => window.__goatcad.getElement({ ref }), target.ref)
    // World coordinates are KiCad's nanometers.
    if (Math.hypot(moved.world.x - target.world.x, moved.world.y - target.world.y) < 1e5)
      log(`run ${run}: ${target.ref} did not move; the edit timings are of nothing`)
    row['heap after edit'] = await heapMb()
    row['worker heap after edit'] = await workerHeapMb()
    row['renderer after edit'] = await rendererMb()
    return row
  } finally {
    const proc = app.process()
    const exited = new Promise((done) => proc.once('exit', done))
    app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10000))])
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

const runs = values.record ? RECORD_RUNS : Math.max(1, Number(values.runs ?? 1))
const rows = []
for (let i = 1; i <= runs; i++) {
  rows.push(await runOnce(i))
  log(`run ${i}/${runs}`)
}

const median = (xs) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
  if (s.length === 0) return NaN
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const UNITS = {
  'heap after open': 'MB',
  'heap after edit': 'MB',
  'renderer after open': 'MB',
  'worker heap after open': 'MB',
  'worker heap after edit': 'MB',
  'renderer after edit': 'MB'
}
const fmt = (v) => (Number.isNaN(v) ? '—' : Math.round(v).toString()).padStart(7)
const labelWidth = Math.max(...Object.keys(rows[0]).map((k) => k.length))
console.log(
  `\n${basename(board)}${''.padEnd(Math.max(0, labelWidth - basename(board).length))}  median     min     max`
)
for (const label of Object.keys(rows[0])) {
  const xs = rows.map((r) => r[label])
  const ok = xs.filter((v) => !Number.isNaN(v))
  const [lo, hi] = ok.length ? [Math.min(...ok), Math.max(...ok)] : [NaN, NaN]
  console.log(
    `${label.padEnd(labelWidth)}  ${fmt(median(xs))} ${fmt(lo)} ${fmt(hi)}  ${UNITS[label] ?? 'ms'}`
  )
}
console.log(`${runs} run(s), ${values.visible ? 'visible desktop' : 'headless'}, fresh profile`)

if (values.record) {
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim()
  // `*`: what was measured differs from the commit. Only what goes into the app counts.
  const dirty = git(
    'status',
    '--porcelain',
    '--',
    'src',
    'resources',
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json'
  )
  const page = readFileSync(HISTORY, 'utf8')
  const block = page.match(DATA_BLOCK)
  if (!block) {
    console.error(`board-timing: no board-data block in ${HISTORY}`)
    process.exit(1)
  }
  const data = JSON.parse(block[2])
  const machine = {
    cpu: cpus()[0]?.model.replace(/\s+/g, ' ').trim() ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${arch()}`
  }
  const same = (m) => ['cpu', 'cores', 'memoryGb', 'os'].every((k) => m[k] === machine[k])
  let machineId = data.machines.find(same)?.id
  if (!machineId) {
    machineId = `m${data.machines.length + 1}`
    data.machines.push({ id: machineId, ...machine })
  }
  data.runs.push({
    date: new Date().toLocaleDateString('en-CA'),
    label: values.label ?? git('rev-parse', '--abbrev-ref', 'HEAD'),
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    commit: git('rev-parse', '--short', 'HEAD') + (dirty ? '*' : ''),
    machine: machineId,
    display: values.visible ? 'desktop' : 'headless',
    design: basename(board, '.kicad_pcb'),
    designSha,
    runs,
    metrics: Object.fromEntries(
      Object.keys(rows[0]).map((label) => [
        label,
        Math.round(median(rows.map((r) => r[label])) * 10) / 10
      ])
    )
  })
  writeFileSync(
    HISTORY,
    page.replace(DATA_BLOCK, (_, open, _old, close) => open + JSON.stringify(data, null, 2) + close)
  )
  console.log(`recorded in ${HISTORY} as ${machineId}`)
}
