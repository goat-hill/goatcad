/**
 * Format migration against KiCad's own upgrade (format-migration-workstream.md).
 * Not in the default suite and never on CI: it needs KiCad installed
 * (`kicadParity.ts`) and takes minutes on a corpus. Run it with
 * `./bin/test-parity`.
 *
 * The bar is equivalence: `kicad-cli <kind> upgrade --force` of our migration
 * and of the original produce the same file, uuids masked and top-level items
 * unordered (`canonical`) — KiCad reads the same design from both.
 *
 * The corpus is every file we open (KiCad 6 on) that is older than the current
 * format, under the repo's sample projects plus whatever `PARITY_MIGRATION`
 * names: a colon-separated list of files and directories (KiCad's `qa/data/`
 * and `demos/` are the ones worth pointing it at). `PARITY_MIGRATION_FORMATS`
 * narrows it to a comma-separated list of formats. A format in `HELD` must pass
 * on every file; the rest are reported, not asserted, while their migrators
 * are written.
 * `PARITY_REPORT=<file>` keeps the full comparison.
 */
import { describe, expect, test } from 'vitest'
import { execFile } from 'child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, relative, resolve } from 'path'
import { promisify } from 'util'
import { parseSExpr, serializeSExpr, type SExprList } from '../kicad/sexpr'
import {
  CURRENT_FORMAT_VERSION,
  MIN_FORMAT_VERSION,
  formatVersion,
  legacyPowerValuesFromPins,
  migrateToCurrent,
  moveLegacyInstances,
  type KicadFormat
} from '../kicad/migrate'
import { requireKicadCli } from './kicadParity'
import { CANARY_DIR } from './canaryFixture'

const run = promisify(execFile)
const cli = requireKicadCli()

const EXTENSIONS: Record<string, { format: KicadFormat; command: string }> = {
  '.kicad_sch': { format: 'kicad_sch', command: 'sch' },
  '.kicad_pcb': { format: 'kicad_pcb', command: 'pcb' },
  '.kicad_sym': { format: 'kicad_symbol_lib', command: 'sym' },
  '.kicad_mod': { format: 'footprint', command: 'fp' }
}

/** Formats whose migrator is done: every file must pass. */
const HELD = new Set<KicadFormat>(['footprint', 'kicad_symbol_lib', 'kicad_sch', 'kicad_pcb'])

/**
 * Corpus directories not run, and why (corpus-relative prefixes). Not a pass:
 * each is open work in format-migration-workstream.md.
 */
const SKIPPED: Record<string, string> = {
  'eeschema/issue23020/':
    'a KiCad stress-test hierarchy (18 sheets, 9 MB) that takes kicad-cli past 8 GB',
  'jetson-agx-thor-baseboard/': 'an 85 MB board and a 12 MB hierarchy',
  'vme-wren/': 'a 70 MB board and a 21 MB hierarchy',
  'pcbnew/vme-wren.kicad_pcb': 'a 29 MB board',
  'pcbnew/plugins/allegro/boards/VCU118_REV2-0/': 'a 48 MB board'
}

/**
 * Held-format files known to differ, and why, keyed by corpus-relative path.
 * An entry that stops differing fails the run, so the list cannot go stale.
 */
const KNOWN: Record<string, string> = {
  'royalblue54L_feather/lib/footprints/RoyalBlue54L-Feather-Connector_FFC-FPC.pretty/CONN-SMD_5P-P0.50_HCTL_HC-FPC-05-09-5RLTAG.kicad_mod':
    'malformed: a stray ")" closes the footprint at line 187, and KiCad reads only the first expression'
}

const extensionOf = (path: string): string | undefined =>
  Object.keys(EXTENSIONS).find((ext) => path.endsWith(ext))

const filesUnder = (path: string): string[] => {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return extensionOf(path) ? [path] : []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .flatMap((entry) => filesUnder(join(path, entry.name)))
    .sort()
}

const roots = [
  CANARY_DIR,
  ...(process.env.PARITY_MIGRATION ?? '')
    .split(':')
    .filter(Boolean)
    .map((entry) => resolve(entry.replace(/^~/, process.env.HOME ?? '')))
]

interface Candidate {
  path: string
  /** Corpus-relative, for reports and `KNOWN`. */
  name: string
  format: KicadFormat
  command: string
  version: number
}

/** The root token and `(version …)` from a file's head — a corpus holds boards too big to parse at once. */
const HEADER = /^\s*\(\s*([a-z_]+)[^(]*\(\s*version\s+(\d+)\s*\)/

const headOf = (path: string): string => {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0))
  } finally {
    closeSync(fd)
  }
}

/** `PARITY_MIGRATION_FORMATS=footprint,kicad_sym`-style narrowing; every format by default. */
const formats = new Set(
  (
    process.env.PARITY_MIGRATION_FORMATS ??
    Object.values(EXTENSIONS)
      .map((e) => e.format)
      .join(',')
  )
    .split(',')
    .filter(Boolean)
)

/** Every file we open that is older than the format we write. */
const candidates: Candidate[] = roots.flatMap((root) =>
  filesUnder(root).flatMap((path): Candidate[] => {
    const { format, command } = EXTENSIONS[extensionOf(path)!]
    const match = HEADER.exec(headOf(path))
    if (!match || match[1] !== format || !formats.has(format)) return []
    const version = Number(match[2])
    if (version < MIN_FORMAT_VERSION[format] || version >= CURRENT_FORMAT_VERSION[format]) return []
    const name = relative(root, path)
    if (Object.keys(SKIPPED).some((prefix) => name.startsWith(prefix))) return []
    return [{ path, name, format, command, version }]
  })
)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * KiCad's upgrade with uuids masked and top-level items sorted. KiCad orders
 * items by uuid and invents one for an item that has none, so their order
 * changes from run to run; it carries no meaning in either format.
 */
const canonical = (text: string, drop: readonly string[] = []): string => {
  const masked = text.replace(UUID, 'U').split('\n')
  const items: string[] = []
  const head: string[] = []
  const tail: string[] = []
  for (const line of masked) {
    if (/^\t\(/.test(line)) items.push(line)
    else if (!line.startsWith('\t') && items.length) tail.push(line)
    else if (items.length) items[items.length - 1] += `\n${line}`
    else head.push(line)
  }
  const kept = items.filter((item) => !drop.some((token) => item.startsWith(`\t(${token}`)))
  return [...head, ...kept.sort(), ...tail].join('\n')
}

/**
 * Before 20221110 the root's `sheet_instances` is legacy data to KiCad, which
 * `sch upgrade` then drops; the root's page is left to the netlist.
 */
const LEGACY_INSTANCES_BEFORE = 20221110

/**
 * Before this KiCad fixes a schematic up on open — moving the root's instance
 * data into the hierarchy (before 20221110), and power symbols' values from
 * their pins — and `sch upgrade` saves without those fixups. So each part is
 * judged where KiCad gets it right: the fixups by the netlist of the untouched
 * original (only such files need one, which is as well, since exporting one for
 * a large modern hierarchy takes gigabytes), the rest at file level against
 * KiCad's upgrade of the original with the fixups applied.
 */
const OPEN_FIXUPS_BEFORE = 20230221

/** A schematic's sub-sheets, as the paths its sheets name (`Sheetfile`, KiCad 6's `Sheet file`). */
const sheetFilesOf = (text: string): string[] =>
  [...text.matchAll(/\(property\s+"Sheet ?[Ff]ile"\s+"([^"]+)"/g)].map((match) => match[1])

/**
 * The candidate copied into a fresh directory, migrated or not, with what
 * KiCad needs beside it: a footprint in a `.pretty` (its name is its file's),
 * a schematic with its sub-sheets and project. The caller removes `dir`: a
 * corpus stages thousands, and `/tmp` is often memory.
 */
/**
 * What `stage` does to the copy: nothing, only the fixups KiCad runs on open
 * (at the file's own version), or the whole migration.
 */
type StageMode = 'original' | 'fixedUp' | 'migrated'

const stage = (candidate: Candidate, mode: StageMode): { dir: string; file: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'goatcad-migrate-'))
  const staged: string[] = []
  const place = (source: string, target: string): void => {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    staged.push(target)
  }
  const file =
    candidate.command === 'fp'
      ? join(dir, 'lib.pretty', basename(candidate.path))
      : join(dir, basename(candidate.path))
  place(candidate.path, file)
  if (candidate.command === 'sch') {
    const project = candidate.path.replace(/\.kicad_sch$/, '.kicad_pro')
    if (existsSync(project)) copyFileSync(project, file.replace(/\.kicad_sch$/, '.kicad_pro'))
    const seen = new Set([candidate.path])
    const queue = [candidate.path]
    while (queue.length) {
      const sheet = queue.pop()!
      for (const name of sheetFilesOf(readFileSync(sheet, 'utf8'))) {
        const source = resolve(dirname(sheet), name)
        if (seen.has(source) || !existsSync(source)) continue
        seen.add(source)
        queue.push(source)
        place(source, join(dir, relative(dirname(candidate.path), source)))
      }
    }
  }
  if (mode !== 'original') {
    // As the app will: the whole hierarchy at once, the candidate as its root.
    const roots = new Map(
      staged.map((path) => [path, parseSExpr(readFileSync(path, 'utf8')) as SExprList])
    )
    const pathOf = new Map([...roots].map(([path, root]) => [root, path]))
    if (candidate.command === 'sch') {
      moveLegacyInstances(roots.get(file)!, basename(file, '.kicad_sch'), (name, parent) =>
        roots.get(resolve(dirname(pathOf.get(parent)!), name))
      )
    }
    for (const [path, root] of roots) {
      if (mode === 'fixedUp' && (formatVersion(root) ?? 0) < OPEN_FIXUPS_BEFORE)
        legacyPowerValuesFromPins(root)
      if (mode === 'migrated') migrateToCurrent(root)
      writeFileSync(path, `${serializeSExpr(root)}\n`)
    }
  }
  return { dir, file }
}

/** KiCad's upgrade of a staged file, canonical; null where KiCad cannot read it. */
const kicadUpgrade = async (
  file: string,
  command: string,
  drop: readonly string[] = []
): Promise<string | null> => {
  try {
    await run(cli, [command, 'upgrade', '--force', command === 'fp' ? dirname(file) : file], {
      timeout: 120_000
    })
    return canonical(readFileSync(file, 'utf8'), drop)
  } catch {
    return null
  }
}

/**
 * A staged schematic's netlist, where the file-level comparison is blind:
 * `sch upgrade` saves what the raw reader loaded, skipping the fixups KiCad
 * runs on open (older instance data, legacy power symbols), which the netlist
 * export runs. Where and when it was made is masked.
 */
const kicadNetlist = async (file: string): Promise<string | null> => {
  const out = `${file}.net`
  try {
    await run(cli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, file], {
      timeout: 120_000
    })
    return readFileSync(out, 'utf8')
      .replace(UUID, 'U')
      .replace(/goatcad-migrate-\w+/g, 'goatcad-migrate')
      .replace(/^\s*\((source|date|tool) .*$/gm, '')
  } catch {
    return null
  }
}

/** Where two texts first part, with a line either side. */
const firstDifference = (ours: string, theirs: string): string => {
  const a = ours.split('\n')
  const b = theirs.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const around = (lines: string[]): string =>
    lines
      .slice(Math.max(0, i - 1), i + 2)
      .map((line) => line.trim())
      .join(' ⏎ ')
  return `line ${i + 1}: ours ${around(a)} | KiCad's ${around(b)}`
}

type Outcome =
  | { kind: 'equivalent' }
  | { kind: 'differs'; where: string }
  | { kind: 'unreadable'; by: 'original' | 'migration' }

const compare = async (candidate: Candidate): Promise<Outcome> => {
  const fixedUp = candidate.command === 'sch' && candidate.version < OPEN_FIXUPS_BEFORE
  const staged: string[] = []
  const stageFor = (mode: StageMode): string => {
    const { dir, file } = stage(candidate, mode)
    staged.push(dir)
    return file
  }
  try {
    const original = stageFor('original')
    const migrated = stageFor('migrated')
    // The netlist first: the upgrade rewrites the staged file.
    let netlistDiffers: string | null = null
    if (candidate.command === 'sch' && candidate.version < OPEN_FIXUPS_BEFORE) {
      const theirs = await kicadNetlist(original)
      const ours = await kicadNetlist(migrated)
      if (theirs !== null && ours === null) return { kind: 'unreadable', by: 'migration' }
      if (theirs !== null && ours !== theirs) netlistDiffers = firstDifference(ours!, theirs)
    }
    const drop =
      candidate.command === 'sch' && candidate.version < LEGACY_INSTANCES_BEFORE
        ? ['sheet_instances']
        : []
    const reference = await kicadUpgrade(
      fixedUp ? stageFor('fixedUp') : original,
      candidate.command,
      drop
    )
    if (reference === null) return { kind: 'unreadable', by: 'original' }
    const ours = await kicadUpgrade(migrated, candidate.command, drop)
    if (ours === null) return { kind: 'unreadable', by: 'migration' }
    if (ours !== reference) return { kind: 'differs', where: firstDifference(ours, reference) }
    if (netlistDiffers) return { kind: 'differs', where: `netlist ${netlistDiffers}` }
    return { kind: 'equivalent' }
  } finally {
    for (const dir of staged) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `kicad-cli` is a process each, and a large board or hierarchy costs gigabytes:
 * `PARITY_JOBS` at once (default 1).
 */
const inPool = async <T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await work(items[i])
      }
    })
  )
  return results
}

describe('format migration matches KiCad’s upgrade', () => {
  const outcomes = new Map<Candidate, Promise<Outcome>>()
  const all = inPool(candidates, Number(process.env.PARITY_JOBS ?? 1), (candidate) =>
    compare(candidate)
  ).then((results) => {
    const report = candidates.map((candidate, i) => ({
      file: candidate.name,
      format: candidate.format,
      ...results[i]
    }))
    if (process.env.PARITY_REPORT) {
      writeFileSync(process.env.PARITY_REPORT, JSON.stringify(report, null, 2))
    }
    return results
  })
  candidates.forEach((candidate, i) =>
    outcomes.set(
      candidate,
      all.then((results) => results[i])
    )
  )

  const held = candidates.filter((candidate) => HELD.has(candidate.format))
  test.each(held.map((candidate) => [candidate.name, candidate] as const))(
    '%s',
    async (_name, candidate) => {
      const outcome = await outcomes.get(candidate)!
      if (outcome.kind === 'unreadable' && outcome.by === 'original') return
      const known = KNOWN[candidate.name]
      if (known) {
        expect(outcome.kind, `${candidate.name} is listed as differing (${known})`).not.toBe(
          'equivalent'
        )
        return
      }
      expect(outcome.kind === 'differs' ? outcome.where : outcome.kind).toBe('equivalent')
    },
    600_000
  )

  test('pending formats (reported, not asserted)', async () => {
    const results = await all
    const tally = new Map<KicadFormat, Record<Outcome['kind'], number>>()
    candidates.forEach((candidate, i) => {
      if (HELD.has(candidate.format)) return
      const counts = tally.get(candidate.format) ?? { equivalent: 0, differs: 0, unreadable: 0 }
      counts[results[i].kind] += 1
      tally.set(candidate.format, counts)
    })
    for (const [format, counts] of tally) console.info(`${format}:`, counts)
  }, 600_000)
})
