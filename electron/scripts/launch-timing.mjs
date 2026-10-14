/*
 * Launch timing: start the built app a few times and report when each launch
 * milestone landed, in ms since the main process started. Run it by hand to
 * catch a startup regression; it is not a CI gate (timings vary per machine).
 *
 * The milestones are the `launch:*` performance marks in main/index.ts,
 * renderer/src/main.ts and App.vue, plus Chromium's first contentful paint.
 * Main's performance clock starts with the process and the renderer's with its
 * navigation; both carry an epoch timeOrigin, which puts them on one axis.
 *
 * Run through ../bin/launch-timing, which prefers xvfb-run. Under xvfb the GPU
 * is software, so compare runs with each other, not with a real desktop
 * (--visible measures that). Playwright's driver adds a little to each launch.
 * The first launch after a build pays for a cold disk cache and is discarded.
 *
 * --record runs the one standard method (fresh build, fresh profile, no files,
 * RECORD_RUNS launches) and appends the medians to perf/launch-history.html.
 * Headless and --visible (real GPU and compositor) are separate series, and
 * rows compare only within one machine and one series.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright-core'

const { values } = parseArgs({
  options: {
    runs: { type: 'string' },
    // KiCad file(s) to open on launch, as an OS double-click would.
    open: { type: 'string', multiple: true, default: [] },
    'no-build': { type: 'boolean', default: false },
    visible: { type: 'boolean', default: false },
    // Per-launch deadline (ms).
    timeout: { type: 'string', default: '60000' },
    record: { type: 'boolean', default: false },
    // The row's label in the history; the branch name when omitted.
    label: { type: 'string' }
  }
})

const RECORD_RUNS = 10
const HISTORY = 'perf/launch-history.html'
// The history page's data: one JSON block the page renders, and the one thing this script edits.
const DATA_BLOCK =
  /(<script type="application\/json" id="launch-data">\s*)([\s\S]*?)(\s*<\/script>)/

if (values.record) {
  const nonstandard = [
    values.runs !== undefined && '--runs',
    values.open.length > 0 && '--open',
    values['no-build'] && '--no-build'
  ].filter(Boolean)
  if (nonstandard.length > 0) {
    console.error(
      `launch-timing: --record runs the standard method; drop ${nonstandard.join(', ')}`
    )
    process.exit(1)
  }
}

// Never out/: a build empties it, which would break a dev app running from it.
const OUT_DIR = 'node_modules/.cache/launch-timing'

if (!values['no-build']) {
  const build = spawnSync('./node_modules/.bin/electron-vite', ['build', '--outDir', OUT_DIR], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const MILESTONES = [
  ['main', 'launch:main-evaluated', 'main module evaluated'],
  ['main', 'launch:app-ready', 'app ready'],
  ['renderer', 'navigation', 'renderer navigation start'],
  ['renderer', 'launch:renderer-evaluated', 'renderer bundle evaluated'],
  ['renderer', 'launch:mounted', 'app mounted'],
  ['main', 'launch:window-shown', 'window shown'],
  ['renderer', 'launch:session-ready', 'session ready'],
  ['renderer', 'first-contentful-paint', 'first contentful paint']
]

const html = readFileSync(join(OUT_DIR, 'renderer/index.html'), 'utf8')
const entry = html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)?.[1]
const entryKb = entry ? Math.round(statSync(join(OUT_DIR, 'renderer', entry)).size / 1024) : null

async function launchOnce() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'goatcad-launch-timing-'))
  const args = [join(OUT_DIR, 'main/index.js')]
  if (!values.visible) args.push('--ozone-platform=x11')
  args.push(...values.open.map((f) => resolve(f)))
  // Same isolation as scripts/screenshot.mjs: a throwaway userData (so the run
  // is a first launch and never touches the real config), the built renderer
  // rather than a leaked dev-server URL, and an ephemeral MCP port.
  const env = { ...process.env, GOATCAD_USER_DATA_DIR: userDataDir, GOATCAD_MCP_PORT: '0' }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  if (!values.visible) {
    delete env.WAYLAND_DISPLAY
    delete env.GDK_BACKEND
  }

  const spawnedAt = Date.now()
  const app = await _electron.launch({ args, env, timeout: Number(values.timeout) })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(
      () =>
        performance.getEntriesByName('launch:session-ready').length > 0 &&
        performance.getEntriesByName('first-contentful-paint').length > 0,
      null,
      { timeout: Number(values.timeout) }
    )
    // ready-to-show can trail the renderer's paint by a frame.
    await page.waitForTimeout(200)
    const marks = (entries) => Object.fromEntries(entries.map((e) => [e.name, e.startTime]))
    const main = await app.evaluate(() => ({
      origin: performance.timeOrigin,
      entries: performance
        .getEntriesByType('mark')
        .map((e) => ({ name: e.name, startTime: e.startTime }))
    }))
    const renderer = await page.evaluate(() => ({
      origin: performance.timeOrigin,
      entries: [
        ...performance.getEntriesByType('mark'),
        ...performance.getEntriesByType('paint')
      ].map((e) => ({ name: e.name, startTime: e.startTime }))
    }))
    const mainMarks = marks(main.entries)
    const rendererMarks = { navigation: 0, ...marks(renderer.entries) }
    const shift = renderer.origin - main.origin
    const row = { 'process spawn → main start': main.origin - spawnedAt }
    for (const [side, name, label] of MILESTONES) {
      const t = side === 'main' ? mainMarks[name] : rendererMarks[name]
      row[label] = t === undefined ? NaN : side === 'main' ? t : t + shift
    }
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

const runs = values.record ? RECORD_RUNS : Math.max(1, Number(values.runs ?? 5))
await launchOnce()
process.stderr.write('warm-up launch done\n')
const rows = []
for (let i = 0; i < runs; i++) {
  rows.push(await launchOnce())
  process.stderr.write(`run ${i + 1}/${runs}\n`)
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const fmt = (ms) => (Number.isNaN(ms) ? '—' : Math.round(ms).toString()).padStart(7)
const labelWidth = Math.max(...Object.keys(rows[0]).map((k) => k.length))
console.log(`\n${'ms since main process start'.padEnd(labelWidth)}  median     min     max`)
for (const label of Object.keys(rows[0])) {
  const xs = rows.map((r) => r[label])
  console.log(
    `${label.padEnd(labelWidth)}  ${fmt(median(xs))} ${fmt(Math.min(...xs))} ${fmt(Math.max(...xs))}`
  )
}
if (entry) console.log(`\nrenderer entry chunk: ${entry} (${entryKb} KB)`)
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
    console.error(`launch-timing: no launch-data block in ${HISTORY}`)
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

  const milestones = Object.fromEntries(
    Object.keys(rows[0]).map((label) => [label, Math.round(median(rows.map((r) => r[label])))])
  )
  const paints = rows.map((r) => r['first contentful paint'])
  data.runs.push({
    date: new Date().toLocaleDateString('en-CA'),
    label: values.label ?? git('rev-parse', '--abbrev-ref', 'HEAD'),
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    commit: git('rev-parse', '--short', 'HEAD') + (dirty ? '*' : ''),
    machine: machineId,
    display: values.visible ? 'desktop' : 'headless',
    runs,
    milestones,
    firstPaintRange: [Math.round(Math.min(...paints)), Math.round(Math.max(...paints))],
    entryKb
  })
  const json = JSON.stringify(data, null, 2)
  writeFileSync(
    HISTORY,
    page.replace(DATA_BLOCK, (_, open, _old, close) => open + json + close)
  )
  console.log(`recorded in ${HISTORY} as ${machineId}`)
}
