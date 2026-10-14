/**
 * Where the parity suites find KiCad: `KICAD_CLI`, else the standard install
 * for the platform, else `kicad-cli` on PATH. The suites compare the engines
 * against it (kicad-parity.md); without it they report skipped.
 */
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'

const INSTALLED: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
  win32: 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe'
}

const onPath = (): string | null => {
  try {
    execFileSync('kicad-cli', ['version'], { stdio: 'ignore' })
    return 'kicad-cli'
  } catch {
    return null
  }
}

/**
 * The kicad-cli release the suites' known differences are recorded against.
 * Another release's DRC, ERC and fills differ in ways that are not ours, so
 * a run on one stops before it compares anything — unless
 * `PARITY_ANY_KICAD_VERSION=1` says the drift is intended.
 */
export const KICAD_CLI_VERSION = '10.0.7'

export const kicadCli = (): string | null => {
  const configured = process.env.KICAD_CLI
  const cli = configured
    ? existsSync(configured)
      ? configured
      : null
    : (() => {
        const installed = INSTALLED[process.platform]
        return installed && existsSync(installed) ? installed : onPath()
      })()
  if (cli && process.env.PARITY_ANY_KICAD_VERSION !== '1') {
    const version = kicadCliVersion(cli)
    if (version !== KICAD_CLI_VERSION && !version.startsWith(`${KICAD_CLI_VERSION}-`))
      throw new Error(
        `kicad-cli at ${cli} is ${version}, not ${KICAD_CLI_VERSION}: its results would differ ` +
          'for reasons that are not ours. Install KiCad ' +
          `${KICAD_CLI_VERSION}, point KICAD_CLI at it, or set PARITY_ANY_KICAD_VERSION=1 to run anyway.`
      )
  }
  return cli
}

/**
 * The KiCad source checkout the corpora are read from, in place — its
 * `demos/` and `qa/data/` — and the one commit the suites' known differences
 * are recorded against. `KICAD_SOURCE` names the checkout; `~/code/kicad` is
 * only the fallback. Nothing of it is copied into the repo (RULES.md §7).
 */
export const KICAD_SOURCE_COMMIT = '69cafb907ebc09e7722a2a464b1d466fc2e3608d'

let checkedSource: string | null | undefined

/**
 * The checkout, or null when there is none. A checkout at another commit
 * fails the run — its fixtures are not the ones the known differences name —
 * unless `PARITY_ANY_KICAD_SOURCE=1` says the drift is intended.
 */
export const kicadSource = (): string | null => {
  if (checkedSource !== undefined) return checkedSource
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const source = process.env.KICAD_SOURCE ?? join(home, 'code', 'kicad')
  if (!existsSync(join(source, 'demos'))) return (checkedSource = null)
  let head = ''
  try {
    head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // Not a git checkout: the commit cannot be checked, so it cannot be trusted.
  }
  if (head !== KICAD_SOURCE_COMMIT && process.env.PARITY_ANY_KICAD_SOURCE !== '1') {
    throw new Error(
      `The KiCad checkout at ${source} is at ${head || 'no commit'}, not ${KICAD_SOURCE_COMMIT}. ` +
        `Check it out (git -C ${source} checkout ${KICAD_SOURCE_COMMIT}), or set ` +
        'PARITY_ANY_KICAD_SOURCE=1 to run against it anyway.'
    )
  }
  return (checkedSource = source)
}

/**
 * The paths a corpus variable names (`PARITY_BOARDS`, `PARITY_SCHEMATICS`):
 * colon-separated, each `demos`, `qa` (the suite's own QA directory), a path
 * relative to the KiCad checkout, or an absolute path.
 */
export const corpusPaths = (value: string | undefined, qaDir: string): string[] =>
  (value ?? '')
    .split(':')
    .filter(Boolean)
    .map((entry) => {
      if (isAbsolute(entry)) return entry
      const source = kicadSource()
      if (!source) throw new Error(`${entry} names the KiCad checkout; set KICAD_SOURCE`)
      return join(source, entry === 'qa' ? qaDir : entry)
    })

let cliVersion: string | undefined

/** `kicad-cli version`, which a cached report is keyed by: another KiCad reports otherwise. */
/**
 * kicad-cli, or an error saying how to provide it. A parity run without KiCad
 * compared nothing, so it fails rather than reporting skipped.
 */
export const requireKicadCli = (): string => {
  const cli = kicadCli()
  if (!cli) {
    throw new Error(
      `kicad-cli not found: the parity suites need KiCad ${KICAD_CLI_VERSION} installed, or KICAD_CLI pointing at it.`
    )
  }
  return cli
}

export const kicadCliVersion = (cli: string): string =>
  (cliVersion ??= execFileSync(cli, ['version'], { encoding: 'utf8' }).trim())

/** KiCad's symbol library: `KICAD10_SYMBOL_DIR`, as KiCad names it, else the install's. */
export const kicadSymbolDir = (cli: string): string | null => {
  const configured = process.env.KICAD10_SYMBOL_DIR
  if (configured) return existsSync(configured) ? configured : null
  const candidates = [
    join(dirname(cli), '..', 'SharedSupport', 'symbols'),
    join(dirname(cli), '..', 'share', 'kicad', 'symbols'),
    '/usr/share/kicad/symbols'
  ]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

/** KiCad's own settings directory, where the global library tables live. */
export const kicadConfigDir = (): string | null => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates = [
    process.env.KICAD_CONFIG_HOME,
    join(home, '.config', 'kicad', '10.0'),
    join(home, 'Library', 'Preferences', 'kicad', '10.0'),
    join(process.env.APPDATA ?? '', 'kicad', '10.0')
  ]
  return candidates.find((dir): dir is string => !!dir && existsSync(dir)) ?? null
}

/** KiCad's footprint library: `KICAD10_FOOTPRINT_DIR`, as KiCad names it, else the install's. */
export const kicadFootprintDir = (cli: string): string | null => {
  const configured = process.env.KICAD10_FOOTPRINT_DIR
  if (configured) return existsSync(configured) ? configured : null
  const candidates = [
    join(dirname(cli), '..', 'SharedSupport', 'footprints'),
    join(dirname(cli), '..', 'share', 'kicad', 'footprints'),
    '/usr/share/kicad/footprints'
  ]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

/** KiCad itself gave up on a file: out of memory or out of time. */
export class KicadGaveUp extends Error {}

/** Why `KicadGaveUp` names a file kicad-cli cannot load at all, as against one past its caps. */
export const KICAD_COULD_NOT_LOAD = 'kicad-cli could not load the file'

/**
 * Run `work` unless KiCad already gave up on the same input: with
 * `PARITY_CACHE`, a give-up is kept beside the cached results
 * (`<key>.gaveup-<memory cap>`) and thrown again at once under the same cap, so a rerun does not spend another minute and
 * another memory kill on a board KiCad cannot take.
 */
export const rememberGiveUp = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const cache = process.env.PARITY_CACHE
  // Named by the memory cap it was made under: a higher cap tries again.
  const cap = process.env.PARITY_KICAD_MEMORY ?? '3G'
  const marker = cache ? join(cache, `${key}.gaveup-${cap}`) : null
  if (marker && existsSync(marker)) throw new KicadGaveUp(readFileSync(marker, 'utf8'))
  try {
    return await work()
  } catch (error) {
    if (error instanceof KicadGaveUp && cache && marker) {
      mkdirSync(cache, { recursive: true })
      writeFileSync(marker, error.message)
    }
    throw error
  }
}

/** Whether each run can get its own systemd scope. Probed by making one:
 *  `is-system-running` reads "degraded" after any failed unit, a killed run included. */
const scoped = ((): boolean => {
  if (process.platform !== 'linux') return false
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * Run kicad-cli bounded. KiCad's QA corpus holds files KiCad itself cannot
 * check in reasonable memory (issue23020 passes 4 GB in seconds), so each run
 * gets its own cap, PARITY_KICAD_MEMORY (default 3G, systemd only), and
 * PARITY_KICAD_TIMEOUT seconds (default 180); past either it is killed and
 * `KicadGaveUp` names why, so the caller can skip that file — as it does a
 * file KiCad cannot load at all. Its scope is a sibling of the suite's, not
 * inside it, so it takes its own CPU cap too, PARITY_KICAD_CPU_QUOTA (default
 * 400%): KiCad 10's DRC runs its providers on every core.
 */
export const runKicad = async (cli: string, args: string[]): Promise<void> => {
  const [command, argv] = scoped
    ? [
        'systemd-run',
        [
          '--user',
          '--scope',
          '--quiet',
          '-p',
          `MemoryMax=${process.env.PARITY_KICAD_MEMORY ?? '3G'}`,
          '-p',
          'MemorySwapMax=0',
          '-p',
          `CPUQuota=${process.env.PARITY_KICAD_CPU_QUOTA ?? '400%'}`,
          'nice',
          '-n',
          '10',
          cli,
          ...args
        ]
      ]
    : [cli, args]
  const seconds = Number(process.env.PARITY_KICAD_TIMEOUT ?? 180)
  try {
    await promisify(execFile)(command, argv, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: seconds * 1000,
      killSignal: 'SIGKILL'
    })
  } catch (error) {
    const failure = error as {
      killed?: boolean
      signal?: string | null
      code?: number | string
      stdout?: string
      stderr?: string
    }
    if (failure.killed) throw new KicadGaveUp(`kicad-cli ran past ${seconds}s`)
    // Not loadable at all, or saved by a newer KiCad than this one.
    const output = `${failure.stdout}${failure.stderr}`
    if (/Failed to load (schematic|board)|unable to open this file/.test(output)) {
      throw new KicadGaveUp(KICAD_COULD_NOT_LOAD)
    }
    if (failure.signal === 'SIGKILL' || failure.code === 137 || failure.code === 143) {
      throw new KicadGaveUp('kicad-cli ran out of its memory cap')
    }
    throw error
  }
}
