/*
 * KiCad comparison: the same board, the same operations, in GoatCAD and in
 * KiCad, each through the route a user or an agent would take. A manual
 * benchmark, not a CI gate; GoatCAD's own detail is board-timing's and
 * launch-timing's.
 *
 * Per run, each app is launched on a fresh copy of the board (KiCad's Jetson
 * AGX Thor demo by default; --board names another) and timed through:
 *   - launch: process start to window shown, and to the agent API answering
 *     with the board's footprints;
 *   - GPU memory once settled (Linux amdgpu/i915 fdinfo; n/a on macOS);
 *   - pan and zoom: the same gesture shapes, frames timed while they run;
 *   - the agent API, warm, from Python: GoatCAD's generated client against
 *     kipy (kicad-python), the official KiCad client. Each op's first call is
 *     kept apart from its repeats, since it may pay for a load;
 *   - DRC, ERC and fab exports: KiCad's API has none, so an agent runs
 *     kicad-cli, a fresh process that loads the board each time. GoatCAD's
 *     row is its API call on the open board, and "cold DRC" times GoatCAD
 *     from launch to its first check of the board, as kicad-cli is timed from
 *     its process start.
 *
 * Visible desktops only: both apps draw on the real GPU, as users run them.
 * Frames: GoatCAD's are requestAnimationFrame intervals in the window, with
 * input through CDP; KiCad's are its own per-redraw trace (KICAD_TRACE=
 * KICAD_GAL_PROFILE), with input as window events (X11, see
 * kicad-compare/kicad_x11.py) or HID events (macOS, kicad_mac.js).
 *
 * KiCad runs on a copy of the user's KiCad 10 settings with the API server
 * on and the OpenGL canvas; GoatCAD on a fresh profile. Run through
 * ../bin/kicad-compare, which checks the prerequisites. --out writes every
 * number as JSON.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { parseArgs } from 'node:util'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { _electron } from 'playwright-core'

const MAC = platform() === 'darwin'
const DEFAULT_BOARD = join(
  process.env.KICAD_SOURCE ?? join(homedir(), 'code/kicad'),
  'demos/jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb'
)
const KICAD_APP = process.env.KICAD_APP ?? '/Applications/KiCad/KiCad.app'

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    reps: { type: 'string', default: '5' },
    board: { type: 'string' },
    // A small footprint both apps move in the edit timing.
    ref: { type: 'string', default: 'R1' },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string' }
  }
})

const runs = Math.max(1, Number(values.runs))
const reps = Math.max(1, Number(values.reps))
const board = resolve(values.board ?? DEFAULT_BOARD)
const OPEN_TIMEOUT_S = 180
const SCRIPTS = resolve('scripts/kicad-compare')
const VENV_PYTHON = resolve('node_modules/.cache/kicad-compare/venv/bin/python')
const APP_DIR = 'node_modules/.cache/kicad-compare/app'

const pcbnew = MAC
  ? join(KICAD_APP, 'Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew')
  : 'pcbnew'
const kicadCli = MAC ? join(KICAD_APP, 'Contents/MacOS/kicad-cli') : 'kicad-cli'
const kicadSettings = MAC
  ? join(homedir(), 'Library/Preferences/kicad/10.0')
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'kicad/10.0')

const log = (message) => process.stderr.write(`${message}\n`)
const fail = (message) => {
  log(`kicad-compare: ${message}`)
  process.exit(1)
}
if (!existsSync(board)) fail(`no board at ${board} (set KICAD_SOURCE or pass --board)`)
if (!existsSync(kicadSettings)) fail(`no KiCad 10 settings at ${kicadSettings}; run KiCad 10 once`)
const kicadVersion = spawnSync(kicadCli, ['version'], { encoding: 'utf8' }).stdout?.trim()
if (!kicadVersion?.startsWith('10.'))
  fail(`kicad-cli is not KiCad 10 (${kicadVersion ?? 'not found'})`)
const schematic = board.replace(/\.kicad_pcb$/, '.kicad_sch')

if (!values['no-build']) {
  const build = spawnSync('./node_modules/.bin/electron-vite', ['build', '--outDir', APP_DIR], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

/** A fresh copy of the board's folder; the apps save into it. Short: socket paths live under it. */
function boardCopy() {
  const dir = mkdtempSync('/tmp/kcmp-')
  cpSync(dirname(board), join(dir, 'design'), { recursive: true })
  return { dir, board: join(dir, 'design', basename(board)) }
}

/** Run a helper to its end; its stdout is one JSON object. */
function helper(command, args, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`${basename(args[1] ?? command)} exited ${code}`))
      else done(JSON.parse(out.trim().split('\n').at(-1)))
    })
  })
}
const windowTool = (args) =>
  MAC
    ? helper('osascript', ['-l', 'JavaScript', join(SCRIPTS, 'kicad_mac.js'), ...args])
    : helper('python3', ['-I', join(SCRIPTS, 'kicad_x11.py'), ...args])

/** GPU memory a process tree's driver clients hold, MB, from DRM fdinfo; null where there is none. */
function gpuMb(pids) {
  if (MAC) return null
  const seen = new Set()
  let kib = 0
  for (const pid of pids) {
    const read = (fn) => {
      try {
        return fn()
      } catch {
        return null
      }
    }
    for (const fd of read(() => readdirSync(`/proc/${pid}/fdinfo`)) ?? []) {
      const info = read(() => readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))
      if (info === null) continue
      // One DRM client is open under several fds; count it once.
      const client = info.match(/^drm-client-id:\s+(\d+)/m)?.[1]
      if (!client || seen.has(client)) continue
      seen.add(client)
      for (const m of info.matchAll(/^drm-(?:memory|resident)-(?:vram|gtt|system):\s+(\d+)/gm))
        kib += Number(m[1])
    }
  }
  return seen.size ? Math.round(kib / 1024) : null
}

/** Free dedicated video memory on an amdgpu, MB, or null. */
function freeVramMb() {
  if (MAC) return null
  try {
    for (const card of readdirSync('/sys/class/drm')) {
      const dev = `/sys/class/drm/${card}/device`
      if (!existsSync(`${dev}/mem_info_vram_total`)) continue
      const total = Number(readFileSync(`${dev}/mem_info_vram_total`, 'utf8'))
      const used = Number(readFileSync(`${dev}/mem_info_vram_used`, 'utf8'))
      return Math.round((total - used) / 2 ** 20)
    }
  } catch {
    // No such counters on this driver.
  }
  return null
}

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN
}
/** Frames over a gesture: rate over its span and the p95 gap between them. */
function frameStats(times, start, end) {
  const inside = times.filter((t) => t >= start && t <= end + 250)
  // No frame at all means the input never reached the canvas, not a frozen app.
  if (inside.length === 0) return { fps: NaN, p95: NaN }
  const gaps = inside.slice(1).map((t, i) => t - inside[i])
  return {
    fps: inside.length / ((end - start) / 1000),
    p95: quantile(gaps, 0.95)
  }
}

/** An API stage that fails is reported and left blank, so the rest of the run still lands. */
const apiFailed = (error) => {
  log(`API stage failed: ${error.message}`)
  return {}
}

async function runGoatcad(run) {
  const { dir, board: file } = boardCopy()
  const userDataDir = join(dir, 'profile')
  const env = { ...process.env, GOATCAD_USER_DATA_DIR: userDataDir, GOATCAD_MCP_PORT: '0' }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  const pyEnv = { ...process.env, GOATCAD_CONFIG_DIR: userDataDir }
  const row = {}

  log(`run ${run}: GoatCAD`)
  const t0 = Date.now()
  const app = await _electron.launch({
    args: [join(APP_DIR, 'main/index.js'), file],
    env,
    timeout: OPEN_TIMEOUT_S * 1000
  })
  try {
    const ready = helper(
      'python3',
      ['-I', join(SCRIPTS, 'goatcad_api.py'), 'ready', file, String(OPEN_TIMEOUT_S)],
      pyEnv
    )
    const page = await app.firstWindow()
    const mainOrigin = await app.evaluate(() => performance.timeOrigin)
    // Main marks it at ready-to-show, after Playwright hands over the window.
    let shown = null
    for (let waited = 0; shown === null && waited < OPEN_TIMEOUT_S * 1000; waited += 50) {
      shown = await app.evaluate(
        () => performance.getEntriesByName('launch:window-shown')[0]?.startTime ?? null
      )
      if (shown === null) await new Promise((done) => setTimeout(done, 50))
    }
    row['window shown'] = shown === null ? NaN : mainOrigin + shown - t0
    row['board ready (API answers)'] = ((await ready).ready ?? NaN) - t0

    // Cold DRC: GoatCAD refills every zone on open, then checks; KiCad keeps the file's
    // fills and checks nothing until asked. The board worker's measures time both jobs.
    const pageOrigin = await page.evaluate(() => performance.timeOrigin)
    const jobs = await page
      .waitForFunction(
        () => {
          const all = performance
            .getEntriesByType('measure')
            .filter((e) => e.name.startsWith('board:') && !e.name.includes(' · '))
          const check = all.find((e) => e.name.startsWith('board:check') && !e.detail?.superseded)
          if (!check) return null
          const refill = all
            .filter((e) => e.name.startsWith('board:refill'))
            .filter((e) => e.startTime + e.duration <= check.startTime)
            .at(-1)
          return {
            end: check.startTime + check.duration,
            check: check.duration,
            refill: refill?.duration ?? null
          }
        },
        null,
        { timeout: OPEN_TIMEOUT_S * 1000, polling: 100 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null)
    row['open → first DRC done'] = jobs === null ? NaN : pageOrigin + jobs.end - t0
    row['open refill'] = jobs?.refill ?? NaN
    row['open check'] = jobs?.check ?? NaN

    await page.waitForTimeout(2000)
    const pids = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid))
    row['GPU memory after open (MB)'] = gpuMb(pids) ?? NaN

    const box = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll('canvas')].sort(
        (a, b) => b.width * b.height - a.width * a.height
      )[0]
      const r = canvas.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    const framed = async (gesture) => {
      await page.evaluate(() => {
        const frames = (window.__frames = [])
        window.__framing = true
        const tick = () => {
          frames.push(performance.timeOrigin + performance.now())
          if (window.__framing) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const start = Date.now()
      await gesture()
      const end = Date.now()
      await page.waitForTimeout(300)
      const times = await page.evaluate(() => {
        window.__framing = false
        return window.__frames
      })
      return frameStats(times, start, end)
    }
    const pan = await framed(async () => {
      await page.mouse.move(box.x, box.y)
      await page.mouse.down({ button: 'middle' })
      for (let i = 0; i < 60; i++) {
        await page.mouse.move(box.x + Math.sin(i / 10) * 300, box.y + Math.cos(i / 10) * 200)
        await page.waitForTimeout(16)
      }
      await page.mouse.up({ button: 'middle' })
    })
    await page.waitForTimeout(1000)
    const zoom = await framed(async () => {
      await page.mouse.move(box.x, box.y)
      for (const dy of [-100, 100]) {
        for (let i = 0; i < 15; i++) {
          await page.mouse.wheel(0, dy)
          await page.waitForTimeout(30)
        }
      }
    })
    Object.assign(row, {
      'pan fps': pan.fps,
      'pan p95 frame (ms)': pan.p95,
      'zoom fps': zoom.fps,
      'zoom p95 frame (ms)': zoom.p95
    })

    log(`run ${run}: GoatCAD API`)
    const outDir = join(dir, 'exports')
    mkdirSync(outDir)
    row.api = await helper(
      'python3',
      ['-I', join(SCRIPTS, 'goatcad_api.py'), 'ops', file, String(reps), values.ref, outDir],
      pyEnv
    ).catch(apiFailed)
    return row
  } finally {
    const proc = app.process()
    const exited = new Promise((done) => proc.once('exit', done))
    app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10000))])
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/** KiCad's settings, copied, with the API server on and the OpenGL canvas. */
function kicadConfig(dir) {
  const home = join(dir, 'kicad-config')
  cpSync(kicadSettings, join(home, '10.0'), { recursive: true })
  const common = join(home, '10.0', 'kicad_common.json')
  const settings = JSON.parse(readFileSync(common, 'utf8'))
  settings.api = { ...settings.api, enable_server: true }
  settings.graphics = { ...settings.graphics, canvas_type: 1 }
  writeFileSync(common, JSON.stringify(settings, null, 2))
  return home
}

async function runKicad(run) {
  const { dir, board: file } = boardCopy()
  const tmp = join(dir, 't')
  mkdirSync(tmp)
  // macOS puts the socket in /tmp/kicad whatever TMPDIR says; a second KiCad takes api-<pid>.sock.
  const macShared = MAC && existsSync('/tmp/kicad/api.sock')
  const env = {
    ...process.env,
    KICAD_CONFIG_HOME: kicadConfig(dir),
    TMPDIR: tmp,
    KICAD_TRACE: 'KICAD_GAL_PROFILE',
    // GTK reads the X11 driver's window events only as core events.
    GDK_CORE_DEVICE_EVENTS: '1'
  }
  const row = {}
  const freeVram = freeVramMb()
  if (freeVram !== null) {
    row['free VRAM before (MB)'] = freeVram
    if (freeVram < 2048)
      log(`run ${run}: only ${freeVram} MB of video memory free; KiCad may fall back to software`)
  }

  log(`run ${run}: KiCad`)
  const frames = []
  const t0 = Date.now()
  const proc = spawn(pcbnew, [file], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let pending = ''
  proc.stderr.on('data', (chunk) => {
    const at = Date.now()
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()
    for (const line of lines) if (line.includes('View timing:')) frames.push(at)
  })
  try {
    const pid = String(proc.pid)
    const socket = MAC
      ? `/tmp/kicad/${macShared ? `api-${pid}` : 'api'}.sock`
      : join(tmp, 'kicad', 'api.sock')
    const shown = windowTool(['window', pid, 'PCB Editor', String(OPEN_TIMEOUT_S)])
    const fallback = windowTool(['fallback', pid, String(OPEN_TIMEOUT_S)])
    const ready = await helper(VENV_PYTHON, [
      '-I',
      join(SCRIPTS, 'kicad_api.py'),
      'ready',
      socket,
      String(OPEN_TIMEOUT_S)
    ])
    row['window shown'] = ((await shown).shown ?? NaN) - t0
    row['board ready (API answers)'] = (ready.ready ?? NaN) - t0
    // The notice comes during the load; past the board answering it is not coming.
    const fell = await Promise.race([
      fallback,
      new Promise((done) => setTimeout(() => done({ fallback: false }), 3000))
    ])
    row['software fallback'] = fell.fallback

    await new Promise((done) => setTimeout(done, 2000))
    row['GPU memory after open (MB)'] = gpuMb([proc.pid]) ?? NaN
    for (const kind of ['pan', 'zoom']) {
      const span = await windowTool(['gesture', pid, kind]).catch((error) => {
        log(`KiCad ${kind} gesture failed: ${error.message}`)
        return { start: NaN, end: NaN }
      })
      await new Promise((done) => setTimeout(done, 300))
      const stats = frameStats(frames, span.start, span.end)
      if (Number.isNaN(stats.fps))
        log(`run ${run}: KiCad drew no frame during the ${kind}; its input did not land`)
      row[`${kind} fps`] = stats.fps
      row[`${kind} p95 frame (ms)`] = stats.p95
      await new Promise((done) => setTimeout(done, 1000))
    }

    log(`run ${run}: KiCad API`)
    row.api = await helper(VENV_PYTHON, [
      '-I',
      join(SCRIPTS, 'kicad_api.py'),
      'ops',
      socket,
      String(reps),
      values.ref
    ]).catch(apiFailed)
    return row
  } finally {
    const exited = new Promise((done) => proc.once('exit', done))
    proc.kill('SIGTERM')
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10000))])
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/** kicad-cli, a fresh process per call as an agent runs it, on a fresh copy of the design. */
function runKicadCli(run) {
  log(`run ${run}: kicad-cli`)
  const { dir, board: file } = boardCopy()
  const sch = join(dirname(file), basename(schematic))
  const out = (name) => join(dir, name)
  const commands = {
    drc: ['pcb', 'drc', '--format', 'json', '-o', out('drc.json'), file],
    // As GoatCAD opens a board: every zone refilled, then checked.
    'refill + drc': [
      'pcb',
      'drc',
      '--refill-zones',
      '--format',
      'json',
      '-o',
      out('drc-refilled.json'),
      file
    ],
    erc: ['sch', 'erc', '--format', 'json', '-o', out('erc.json'), sch],
    gerbers: ['pcb', 'export', 'gerbers', '-o', `${out('gerbers')}/`, file],
    drill: ['pcb', 'export', 'drill', '-o', `${out('drill')}/`, file],
    positions: ['pcb', 'export', 'pos', '-o', out('pos.txt'), file]
  }
  const row = {}
  try {
    for (const [op, args] of Object.entries(commands)) {
      if (op === 'erc' && !existsSync(sch)) continue
      const times = []
      for (let i = 0; i < Math.max(1, Math.ceil(reps / 3)); i++) {
        const start = performance.now()
        const result = spawnSync(kicadCli, args, { stdio: 'ignore' })
        times.push(performance.now() - start)
        // DRC and ERC exit nonzero only on a broken input; violations are a 0.
        if (result.status !== 0) log(`kicad-cli ${op} exited ${result.status}`)
      }
      row[op] = quantile(times, 0.5)
    }
    return row
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const results = []
for (let run = 1; run <= runs; run++) {
  results.push({
    goatcad: await runGoatcad(run),
    kicad: await runKicad(run),
    kicadCli: runKicadCli(run)
  })
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (s.length === 0) return NaN
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const across = (pick) => median(results.map(pick))

const rows = []
const add = (section, label, goatcad, kicad, route) =>
  rows.push({ section, label, goatcad, kicad, route })
for (const label of ['window shown', 'board ready (API answers)']) {
  add(
    'launch with the board (ms)',
    label,
    across((r) => r.goatcad[label]),
    across((r) => r.kicad[label]),
    'GUI'
  )
}
add(
  'launch with the board (ms)',
  'cold refill + DRC: start → report',
  across((r) => r.goatcad['open → first DRC done']),
  across((r) => r.kicadCli['refill + drc']),
  'kicad-cli drc --refill-zones'
)
add(
  'launch with the board (ms)',
  'GoatCAD refill on open',
  across((r) => r.goatcad['open refill']),
  NaN,
  "none: keeps the file's fills"
)
add(
  'launch with the board (ms)',
  'GoatCAD DRC on open',
  across((r) => r.goatcad['open check']),
  NaN,
  'none until asked'
)
add(
  'GPU',
  'memory after open (MB)',
  across((r) => r.goatcad['GPU memory after open (MB)']),
  across((r) => r.kicad['GPU memory after open (MB)']),
  'GUI'
)
for (const label of ['pan fps', 'pan p95 frame (ms)', 'zoom fps', 'zoom p95 frame (ms)']) {
  add(
    'view',
    label,
    across((r) => r.goatcad[label]),
    across((r) => r.kicad[label]),
    'GUI'
  )
}
const API_OPS = [
  'round trip',
  'list footprints',
  'list tracks',
  'move footprint',
  'refill zones',
  'save'
]
for (const op of API_OPS) {
  add(
    'agent API (ms)',
    `${op}, warm`,
    across((r) => r.goatcad.api[op]?.median),
    across((r) => r.kicad.api[op]?.median),
    'kipy'
  )
  add(
    'agent API (ms)',
    `${op}, first call`,
    across((r) => r.goatcad.api[op]?.first),
    across((r) => r.kicad.api[op]?.first),
    'kipy'
  )
}
for (const op of ['drc', 'erc', 'gerbers', 'drill', 'positions']) {
  add(
    'checks and exports (ms)',
    `${op}, warm`,
    across((r) => r.goatcad.api[op]?.median),
    across((r) => r.kicadCli[op]),
    'kicad-cli'
  )
  add(
    'checks and exports (ms)',
    `${op}, first call`,
    across((r) => r.goatcad.api[op]?.first),
    across((r) => r.kicadCli[op]),
    'kicad-cli'
  )
}

const fmt = (v) =>
  typeof v !== 'number' || Number.isNaN(v)
    ? '—'
    : v >= 100
      ? Math.round(v).toString()
      : v.toFixed(1)
/** Who is ahead and by how much; memory and times are better low, frame rates high. */
const lead = (r) => {
  const { goatcad: g, kicad: k } = r
  if (![g, k].every((v) => typeof v === 'number' && !Number.isNaN(v) && v > 0)) return ''
  const goatcadAhead = r.label.includes('fps') ? g > k : g < k
  const factor = Math.max(g, k) / Math.min(g, k)
  return `${goatcadAhead ? 'GoatCAD' : 'KiCad'} ${factor.toFixed(1)}×`
}
const width = Math.max(...rows.map((r) => r.label.length))
let section = ''
console.log(
  `\n${basename(board)} · ${results.length} run(s), ${reps} rep(s) · KiCad ${kicadVersion}`
)
for (const r of rows) {
  if (r.section !== section) {
    section = r.section
    console.log(
      `\n${section}${''.padEnd(width + 2 - section.length)}  GoatCAD     KiCad  KiCad via                    ahead`
    )
  }
  console.log(
    `  ${r.label.padEnd(width)}  ${fmt(r.goatcad).padStart(7)} ${fmt(r.kicad).padStart(9)}  ${r.route.padEnd(28)} ${lead(r)}`
  )
}
for (const [app, pick] of [
  ['GoatCAD', (r) => r.goatcad.api],
  ['KiCad', (r) => r.kicad.api]
]) {
  for (const [op, v] of Object.entries(pick(results[0]) ?? {}))
    if (v?.error) console.log(`\n${app} ${op} failed: ${v.error}`)
}
const saves = results.map((r) => r.goatcad.api['saves before export']).filter((n) => n > 0)
if (saves.length)
  console.log(`\nGoatCAD needed ${saves.join(', ')} more save(s) before an export took the board.`)
const fellBack = results.filter((r) => r.kicad['software fallback']).length
if (fellBack)
  console.log(
    `\nKiCad fell back to software rendering in ${fellBack} run(s): too little free video memory.`
  )
console.log(
  '\nWarm checks: GoatCAD answers on the open board (its DRC runs incrementally from open), ' +
    'KiCad has no API for them, so each is a kicad-cli process loading the design.'
)

if (values.out) {
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        commit: git('rev-parse', '--short', 'HEAD'),
        machine: {
          cpu: cpus()[0]?.model.replace(/\s+/g, ' ').trim(),
          cores: cpus().length,
          memoryGb: Math.round(totalmem() / 2 ** 30),
          os: `${platform()} ${release()} ${arch()}`
        },
        kicad: kicadVersion,
        board: basename(board),
        runs: results.length,
        reps,
        rows,
        results
      },
      null,
      2
    )
  )
  console.log(`wrote ${values.out}`)
}
