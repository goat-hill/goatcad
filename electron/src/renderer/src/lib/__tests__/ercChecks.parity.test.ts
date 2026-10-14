/**
 * Schematic checks against KiCad's own ERC, on real projects. Not in the
 * default suite and never on CI: it needs KiCad installed (`kicadParity.ts`).
 * Run it with `./bin/test-parity`.
 *
 * The corpus is the repo's sample projects plus whatever `PARITY_SCHEMATICS`
 * names: a colon-separated list of root `.kicad_sch` files and directories
 * searched for projects (a `.kicad_pro` beside its root sheet) — `demos` and
 * `qa` (`qa/data/eeschema/`) in the pinned KiCad checkout (`kicadSource`),
 * read in place, never copied.
 * Each project runs at its own rule severities and exclusions, with the symbol
 * libraries KiCad would see: the project's table, then the global one.
 *
 * Findings are compared per KiCad violation key, as sets of the items named —
 * a pin as `U1.3`, a symbol as `U1`, anything else by uuid. Not per sheet:
 * KiCad files its library and wire-end reports under the root sheet whatever
 * sheet the item is on, and a reference already names its instance.
 * Rules KiCad reports once per pair or per chosen pin are compared per net
 * (`BY_NET`), and rules it reports once per item are split per item
 * (`PER_ITEM`), since which pair or pin a report picks is KiCad's own.
 *
 * `PARITY_REPORT=<file>` keeps the full comparison; `PARITY_CACHE=<dir>` keeps KiCad's reports.
 */
import { describe, expect, test } from 'vitest'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { resolveHierarchy, type HierarchyFs } from '../schematic/hierarchy'
import {
  parseKicadSchematic,
  placedPinUuid,
  referenceForSheetPath,
  sheetPinUuid,
  type KicadLibSymbol,
  type KicadSchematic
} from '../kicad/schematic'
import {
  findChild,
  findChildren,
  getToken,
  parseSExpr,
  serializeSExpr,
  type SExprList
} from '../kicad/sexpr'
import { migrateToCurrent, moveLegacyInstances } from '../kicad/migrate'
import { namespaceSymbolLibrary, type KicadSymbolLibrary } from '../kicad/symbolLibrary'
import {
  extractConnectionGrid,
  extractNetclassNames,
  extractBusAliases,
  extractTextVariables,
  extractPinMap,
  extractRuleSeverities
} from '../kicad/project'
import { KICAD10_PIN_MAP } from '../kicad/projectDefaults'
import { buildConnectivity, type SheetConnectivityInput } from '../schematic/connectivity'
import {
  allChecks,
  ERC_KICAD_KEYS,
  flattenedLibSymbol,
  type CheckResult,
  type LibrarySymbolLookup
} from '../schematic/checks'
import { ercRuleOf } from '../schematic/ercCatalog'
import { applySeverities } from '../ruleSeverity'
import { activeFindings, applyExclusions, extractExclusions } from '../kicadExclusions'
import { CONNECTION_GRID } from '../schematic/schematicAgent'
import {
  KicadGaveUp,
  corpusPaths,
  requireKicadCli,
  kicadCliVersion,
  kicadConfigDir,
  kicadFootprintDir,
  kicadSymbolDir,
  runKicad
} from './kicadParity'
import type { ErcContext, LibraryState } from '../schematic/ercContext'
import { CANARY_DIR } from './canaryFixture'

const cli = requireKicadCli()

/**
 * The violations the engine raises; the rest of ERC is not compared. The
 * annotation rules are KiCad's ERC dialog's, which kicad-cli does not run.
 */
const GUI_ONLY = new Set([
  'unannotated',
  'duplicate_reference',
  'extra_units',
  'unit_value_mismatch'
])
const COMPARED = new Set(Object.values(ERC_KICAD_KEYS).filter((key) => !GUI_ONLY.has(key)))

/** Compared by the nets they flag and the pins named on each. */
const BY_NET = new Set(['pin_to_pin', 'pin_not_driven', 'power_pin_not_driven'])
/** Compared per item: KiCad reports each instance, we may group them. */
const PER_ITEM = new Set([
  // Reported on one instance of a reused sheet, whichever the checker meets first.
  'pin_not_connected',
  'lib_symbol_mismatch',
  'endpoint_off_grid',
  'lib_symbol_issues',
  'footprint_link_issues',
  'footprint_filter'
])
/** A symbol's off-grid pin: which of them KiCad names is its own order, so the symbol is the item. */
const pinSymbol = (key: string, name: string): string =>
  key === 'endpoint_off_grid' ? name.replace(/^([^.\s]+)\.[^.\s]+$/, '$1') : name
/** Compared by the first item: the label, or the name the netlist uses. */
const FIRST_ITEM = new Set([
  'label_multiple_wires',
  // A KiCad finding holds two items; ours names every wire at the junction.
  'four_way_junction',
  'net_not_bus_member',
  'missing_unit',
  'missing_power_pin',
  'missing_input_pin',
  'missing_bidi_pin'
])
/** Compared by the flag: which pin KiCad names beside it is its own pick. */
const FLAG = new Set(['no_connect_connected', 'no_connect_dangling'])
/** Compared by the wired piece: KiCad names up to four of its wires, in its own order. */
const PIECE = new Set(['wire_dangling'])
/**
 * Compared by sheet and name: of several hierarchical labels with one name,
 * which one KiCad reports is its own pick.
 */
const BY_NAME = new Set(['hier_label_mismatch'])
/** Compared by net and sheet: KiCad folds a sheet's same-named pieces before it asks. */
const NET_ON_SHEET = new Set(['multiple_net_names'])

/**
 * Where the comparison is known to differ, and why. An entry that stops
 * differing fails the run, so the list cannot go stale.
 */
const KNOWN: Record<string, { key: string | string[]; why: string }> = {
  'CM5_MINIMA_3.kicad_sch': {
    key: 'no_connect_connected',
    why: "KiCad folds a sheet's same-named pieces and checks only the last no-connect the fold took in; we check each (kicad-parity.md deviations)"
  },
  'issue21798.kicad_sch': {
    key: 'net_not_bus_member',
    why: 'Two copies of one bus-entry layout, the second off the connection grid: KiCad reports the first pair and not the second, with nothing in the drawing to tell them apart; we report both'
  },
  'issue25406.kicad_sch': {
    key: ['net_not_bus_member', 'multiple_net_names'],
    why: "KiCad 10.0.7's bus renaming across sheets names members /Input/DIRECT.DIRECT.NEUTRAL and /Input/DIRECT.INPUT.EARTH, then finds them on no bus, and names /Input's EARTH pair by DIRECT.EARTH; we keep the members' own names (kicad-parity.md deviations)"
  }
}

const findProjects = (path: string): string[] => {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return path.endsWith('.kicad_sch') ? [path] : []
  const out: string[] = []
  for (const entry of readdirSync(path)) {
    if (entry.startsWith('.')) continue
    const full = join(path, entry)
    if (statSync(full).isDirectory()) out.push(...findProjects(full))
    else if (entry.endsWith('.kicad_pro')) {
      const root = full.replace(/\.kicad_pro$/, '.kicad_sch')
      if (existsSync(root)) out.push(root)
    }
  }
  return out
}

const corpus = [
  ...findProjects(CANARY_DIR),
  ...corpusPaths(process.env.PARITY_SCHEMATICS, 'qa/data/eeschema').flatMap(findProjects)
]

const nodeFs: HierarchyFs = {
  readFile: async (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  listSchematics: async (dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.kicad_sch'))
      .map((name) => join(dir, name))
}

// ---- Symbol libraries as KiCad resolves them -----------------------------

const field = (node: SExprList, key: string): string | null => {
  const child = findChild(node, key)
  const atom = child?.children[1]
  return atom && atom.type === 'atom' ? atom.value : null
}

interface TableRow {
  uri: string
  disabled: boolean
  /** In a format KiCad reads and we do not (Legacy, Eagle, …): what it holds is unknown. */
  foreign: boolean
}

/** Nickname -> row, from a `sym-lib-table` or `fp-lib-table` and the tables it nests. */
const readTable = (
  path: string,
  token: string,
  vars: Record<string, string>,
  into: Map<string, TableRow>,
  depth = 0
): void => {
  if (depth > 4 || !existsSync(path)) return
  const parsed = parseSExpr(readFileSync(path, 'utf8'))
  if (parsed.type !== 'list' || getToken(parsed) !== token) return
  for (const row of findChildren(parsed, 'lib')) {
    const name = field(row, 'name')
    // KiCad reads `$(VAR)` as `${VAR}`, and an older version's `${KICAD6_FOOTPRINT_DIR}` as its own.
    const uri = field(row, 'uri')?.replace(
      /\$[{(](\w+)[})]/g,
      (all, key: string) => vars[key] ?? vars[key.replace(/^KICAD\d+_/, 'KICAD_')] ?? all
    )
    if (!name || !uri) continue
    if (field(row, 'type') === 'Table') readTable(uri, token, vars, into, depth + 1)
    else if (!into.has(name)) {
      const type = field(row, 'type') ?? 'KiCad'
      into.set(name, {
        uri,
        disabled: !!findChild(row, 'disabled'),
        foreign: type !== 'KiCad'
      })
    }
  }
}

/** The project's libraries as kicad-cli sees them: its own tables, then the global ones. */
const projectLibraries = (
  projectDir: string
): { lookup: LibrarySymbolLookup; context: ErcContext } => {
  const vars: Record<string, string> = { KIPRJMOD: projectDir }
  const symbolDir = kicadSymbolDir(cli)
  if (symbolDir) vars.KICAD10_SYMBOL_DIR = vars.KICAD_SYMBOL_DIR = symbolDir
  const footprintDir = kicadFootprintDir(cli)
  if (footprintDir) vars.KICAD10_FOOTPRINT_DIR = vars.KICAD_FOOTPRINT_DIR = footprintDir
  const config = kicadConfigDir()
  const symbols = new Map<string, TableRow>()
  readTable(join(projectDir, 'sym-lib-table'), 'sym_lib_table', vars, symbols)
  if (config) readTable(join(config, 'sym-lib-table'), 'sym_lib_table', vars, symbols)
  const footprints = new Map<string, TableRow>()
  readTable(join(projectDir, 'fp-lib-table'), 'fp_lib_table', vars, footprints)
  if (config) readTable(join(config, 'fp-lib-table'), 'fp_lib_table', vars, footprints)
  const state = (row: TableRow | undefined): LibraryState =>
    !row ? 'missing' : row.disabled ? 'disabled' : existsSync(row.uri) ? 'ok' : 'unreadable'
  const libraries = new Map<string, KicadSymbolLibrary | null>()
  /** The library a row names, parsed; null when it is not there or not a library. */
  const libraryOf = (nickname: string): KicadSymbolLibrary | null => {
    if (!libraries.has(nickname)) {
      const row = symbols.get(nickname)
      let library: KicadSymbolLibrary | null = null
      try {
        if (row && state(row) === 'ok') {
          library = namespaceSymbolLibrary(readFileSync(row.uri, 'utf8'), nickname)
        }
      } catch {
        library = null
      }
      libraries.set(nickname, library)
    }
    return libraries.get(nickname) ?? null
  }
  const lookup = (libId: string): KicadLibSymbol | undefined => {
    const library = libraryOf(libId.slice(0, libId.indexOf(':')))
    const definition = library?.doc.libSymbols.get(libId)
    return definition
      ? flattenedLibSymbol(definition, (name) => library!.doc.libSymbols.get(name))
      : undefined
  }
  return {
    lookup,
    context: {
      symbolLibrary: (nickname) => {
        const found = state(symbols.get(nickname))
        if (found !== 'ok') return found
        if (symbols.get(nickname)?.foreign) return undefined
        return libraryOf(nickname) ? 'ok' : 'unreadable'
      },
      footprintLibrary: (nickname) =>
        footprints.get(nickname)?.foreign ? undefined : state(footprints.get(nickname)),
      hasFootprint: (nickname, name) =>
        existsSync(join(footprints.get(nickname)!.uri, `${name}.kicad_mod`))
    }
  }
}

// ---- The comparison ------------------------------------------------------

interface Violation {
  type: string
  severity: string
  items: Array<{ uuid: string; description: string }>
}

interface Report {
  sheets: Array<{ path: string; uuid_path: string; violations: Violation[] }>
}

interface Comparison {
  project: string
  key: string
  ours: string[]
  kicad: string[]
}

/** The findings as the app shows them: the project's severities and exclusions. */
const ourFindings = (
  rootFile: string,
  inputs: SheetConnectivityInput[],
  graph: ReturnType<typeof buildConnectivity>
): CheckResult[] => {
  const projectFile = rootFile.replace(/\.kicad_sch$/, '.kicad_pro')
  const projectText = existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : ''
  const grid = (projectText && extractConnectionGrid(projectText)) || CONNECTION_GRID
  const severities = (projectText && extractRuleSeverities(projectText, 'erc')) || {}
  const exclusions = projectText ? extractExclusions(projectText, 'erc') : []
  const pinMap = (projectText && extractPinMap(projectText)) || KICAD10_PIN_MAP
  const { lookup, context } = projectLibraries(dirname(rootFile))
  const netclasses = projectText ? extractNetclassNames(projectText) : null
  const results = allChecks(graph, inputs, lookup, grid, pinMap, {
    ...context,
    netclasses: netclasses ?? [],
    textVariables: (projectText && extractTextVariables(projectText)) || {}
  })
  return activeFindings(
    applyExclusions(applySeverities(results, ercRuleOf, severities), exclusions, ercRuleOf)
  )
}

/**
 * The design's sheets as the app reads them: an older file is migrated on load
 * (formatUpgrade.ts), a pre-KiCad-7 root's instance data moved into its sheets.
 */
const migratedSheets = async (rootFile: string): Promise<Map<string, string>> => {
  const files = (await resolveHierarchy(nodeFs, rootFile)).files.filter((file) => existsSync(file))
  const roots = new Map<string, SExprList>()
  for (const file of files) {
    const ast = parseSExpr(readFileSync(file, 'utf8'))
    if (ast.type === 'list') roots.set(resolve(file), ast)
  }
  const root = roots.get(resolve(rootFile))
  if (root) {
    const pathOf = new Map([...roots].map(([path, ast]) => [ast, path]))
    moveLegacyInstances(root, basename(rootFile, '.kicad_sch'), (sheetFile, parent) =>
      roots.get(resolve(dirname(pathOf.get(parent) ?? rootFile), sheetFile))
    )
  }
  const texts = new Map<string, string>()
  for (const [path, ast] of roots) {
    migrateToCurrent(ast)
    texts.set(path, serializeSExpr(ast))
  }
  return texts
}

const compare = async (rootFile: string): Promise<Comparison[]> => {
  const texts = await migratedSheets(rootFile)
  const hierarchy = await resolveHierarchy(
    { ...nodeFs, readFile: async (path) => texts.get(resolve(path)) ?? nodeFs.readFile(path) },
    rootFile
  )
  const parsed = new Map<string, KicadSchematic>()
  for (const file of hierarchy.files) {
    const text = texts.get(resolve(file))
    if (text) parsed.set(file, parseKicadSchematic(text))
  }
  const inputs: SheetConnectivityInput[] = hierarchy.instances
    .filter((instance) => parsed.has(instance.filePath))
    .map((instance) => ({
      sheetPath: instance.sheetPath,
      namePath: instance.namePath,
      sheetName: instance.sheetName,
      ...(instance.page ? { page: instance.page } : {}),
      schematic: parsed.get(instance.filePath)!
    }))
  const projectFile = rootFile.replace(/\.kicad_sch$/, '.kicad_pro')
  const projectText = existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : ''
  const graph = buildConnectivity(inputs, {
    busAliases: (projectText && extractBusAliases(projectText)) || {},
    textVariables: (projectText && extractTextVariables(projectText)) || {}
  })
  const ours = ourFindings(rootFile, inputs, graph)

  // What a finding names an item by, per sheet instance: `U1.3`, `U1`, else its uuid.
  const labels = new Map<string, Map<string, string>>()
  const anywhere = new Map<string, string>()
  /** Ids two items of one sheet share (a copied symbol's pins): KiCad gives all
   *  but one a new id on load, so they are named by what they are instead. */
  const shared = new Set<string>()
  for (const { sheetPath, schematic } of inputs) {
    const sheetLabels = new Map<string, string>()
    const name = (uuid: string, text: string): void => {
      const before = sheetLabels.get(uuid)
      if (before !== undefined && before !== text) shared.add(uuid)
      sheetLabels.set(uuid, text)
    }
    for (const symbol of schematic.symbols) {
      const reference = referenceForSheetPath(symbol, sheetPath) ?? '?'
      if (symbol.uuid) name(symbol.uuid, reference)
      for (const pin of findChildren(symbol._node, 'pin')) {
        const number = pin.children[1]
        if (number?.type !== 'atom') continue
        const uuid = placedPinUuid(symbol, number.value)
        if (uuid) name(uuid, `${reference}.${number.value}`)
      }
    }
    labels.set(sheetPath, sheetLabels)
    for (const [uuid, text] of sheetLabels) if (!anywhere.has(uuid)) anywhere.set(uuid, text)
  }
  // A pin's net by `U1.3`: a reused sheet's instances share their pins' uuids.
  const netOf = new Map<string, string>()
  for (const net of graph.nets) {
    for (const entry of net.pins) netOf.set(`${entry.reference}.${entry.pin.number}`, net.name)
  }
  // An item's wired piece, by the lowest uuid in it, and its net.
  const pieceOfItem = new Map<string, string>()
  const netOfItem = new Map<string, string>()
  for (const piece of graph.pieces) {
    const ids = [
      ...piece.wires.flatMap((entry) => entry.wire.uuid ?? []),
      ...piece.labels.flatMap((label) => label.uuid ?? []),
      ...piece.pins.flatMap((entry) => placedPinUuid(entry.symbol, entry.pin.number) ?? []),
      ...piece.sheetPins.flatMap((entry) => sheetPinUuid(entry.pin) ?? [])
    ].sort()
    for (const id of ids) if (!pieceOfItem.has(id)) pieceOfItem.set(id, ids[0])
    if (piece.net) for (const id of ids) netOfItem.set(`${piece.sheetPath}|${id}`, piece.net.name)
  }
  const label = (sheetPath: string, uuid: string): string =>
    labels.get(sheetPath)?.get(uuid) ?? anywhere.get(uuid) ?? uuid

  /** One or more identities for a report naming `ids` (as `U1.3` where a pin) on `sheetPath`. */
  /**
   * `pins` names each item as KiCad describes it (`U1.3`, `U1`), for an id we
   * do not know: KiCad makes up ids for items a file gives none.
   */
  const identities = (
    key: string,
    sheetPath: string,
    ids: string[],
    pins: Array<string | undefined> = []
  ): string[] => {
    const named = (id: string, index: number): string =>
      (shared.has(id) ? pins[index] : undefined) ??
      labels.get(sheetPath)?.get(id) ??
      anywhere.get(id) ??
      pins[index] ??
      id
    // KiCad reports these once per file, so every instance of a reused sheet is one item.
    if (PER_ITEM.has(key)) {
      return ids.map((id, index) =>
        pinSymbol(
          key,
          (shared.has(id) ? pins[index] : undefined) ?? anywhere.get(id) ?? pins[index] ?? id
        )
      )
    }
    if (FIRST_ITEM.has(key)) return ids.length ? [named(ids[0], 0)] : []
    if (NET_ON_SHEET.has(key)) {
      const net = ids.map((id) => netOfItem.get(`${sheetPath}|${id}`)).find(Boolean)
      return [`${sheetPath} net ${net ?? ids[0]}`]
    }
    if (PIECE.has(key)) {
      // The first item we know: KiCad makes up ids for items a file gives none.
      const known = ids.find((id) => pieceOfItem.has(id))
      return ids.length ? [`piece ${known ? pieceOfItem.get(known) : ids[0]}`] : []
    }
    if (BY_NET.has(key)) {
      const nets = ids.map((id, index) => netOf.get(pins[index] ?? label(sheetPath, id)) ?? '?')
      return [`net ${[...new Set(nets)].sort().join(', ')}`]
    }
    return [ids.map(named).sort().join(' | ')]
  }

  const report = await kicadReport(rootFile, hierarchy.files)

  /** The items compared: a no-connect rule is held to its flag alone. */
  const kept = (violation: Violation): Violation['items'] =>
    violation.items.filter(
      (item) => !FLAG.has(violation.type) || !item.description.startsWith('Symbol ')
    )
  const kicadByKey = new Map<string, Set<string>>()
  for (const sheet of report.sheets) {
    for (const violation of sheet.violations) {
      if (!COMPARED.has(violation.type) || violation.severity === 'exclusion') continue
      const set = kicadByKey.get(violation.type) ?? new Set()
      if (BY_NAME.has(violation.type)) {
        const name = /'(.*)'/.exec(violation.items[0]?.description ?? '')?.[1] ?? ''
        set.add(`${sheet.uuid_path} ${name}`)
        kicadByKey.set(violation.type, set)
        continue
      }
      for (const identity of identities(
        violation.type,
        sheet.uuid_path,
        kept(violation).map((item) => item.uuid),
        kept(violation).map((item) => {
          const pin = /^Symbol (\S+) (?:Hidden )?[Pp]in (\S+)/.exec(item.description)
          if (pin) return `${pin[1]}.${pin[2]}`
          return /^Symbol (\S+) \[/.exec(item.description)?.[1]
        })
      ))
        set.add(identity)
      kicadByKey.set(violation.type, set)
    }
  }
  const oursByKey = new Map<string, Set<string>>()
  for (const finding of ours) {
    const key = ERC_KICAD_KEYS[finding.code]
    if (!key || !COMPARED.has(key)) continue
    const set = oursByKey.get(key) ?? new Set()
    if (BY_NAME.has(key)) {
      set.add(`${finding.sheetPath} ${finding.subject}`)
      oursByKey.set(key, set)
      continue
    }
    // Our net findings name their pins as `U1.3` already.
    const ids = BY_NET.has(key) ? finding.items : (finding.kicadIds ?? [])
    for (const identity of identities(
      key,
      finding.sheetPath ?? '',
      ids,
      BY_NET.has(key)
        ? ids
        : ids.length === finding.items.length && ids.some((id) => shared.has(id))
          ? finding.items
          : []
    ))
      set.add(identity)
    oursByKey.set(key, set)
  }
  return [...new Set([...kicadByKey.keys(), ...oursByKey.keys()])].map((key) => ({
    project: rootFile,
    key,
    ours: [...(oursByKey.get(key) ?? [])].sort(),
    kicad: [...(kicadByKey.get(key) ?? [])].sort()
  }))
}

/**
 * A file from before KiCad 6's release opens read-only in GoatCAD, and KiCad
 * gives its uuid-less items fresh ids on every load, so nothing it reports can
 * be matched.
 */
const predatesKicad6 = (file: string): boolean => {
  const version = /\(version (\d+)\)/.exec(readFileSync(file, 'utf8').slice(0, 200))
  return !version || Number(version[1]) < 20211014
}

/**
 * KiCad's report for a project. `PARITY_CACHE=<dir>` keeps each one keyed by
 * the project's files, so a rerun while iterating on the engine is quick.
 */
const kicadReport = async (rootFile: string, files: string[]): Promise<Report> => {
  const hash = createHash('sha1').update(kicadCliVersion(cli))
  const project = rootFile.replace(/\.kicad_sch$/, '.kicad_pro')
  for (const file of [...files, project, join(dirname(rootFile), 'sym-lib-table')]) {
    if (existsSync(file)) hash.update(file).update(readFileSync(file))
  }
  const cache = process.env.PARITY_CACHE
  const cached = cache ? join(cache, `${hash.digest('hex')}.json`) : null
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as Report
  const work = mkdtempSync(join(tmpdir(), 'goatcad-erc-parity-'))
  const reportFile = join(work, 'erc.json')
  await runKicad(cli, [
    'sch',
    'erc',
    '--format',
    'json',
    '--severity-all',
    '-o',
    reportFile,
    rootFile
  ])
  const text = readFileSync(reportFile, 'utf8')
  // /tmp is often RAM; a run over a corpus must not leave a report per project there.
  rmSync(work, { recursive: true, force: true })
  if (cache && cached) {
    mkdirSync(cache, { recursive: true })
    writeFileSync(cached, text)
  }
  return JSON.parse(text) as Report
}

describe('schematic checks against KiCad ERC', () => {
  for (const rootFile of corpus) {
    test.skipIf(predatesKicad6(rootFile))(basename(rootFile), { timeout: 600_000 }, async (ctx) => {
      let comparisons: Comparison[]
      try {
        comparisons = await compare(rootFile)
      } catch (error) {
        if (error instanceof KicadGaveUp) return ctx.skip(error.message)
        throw error
      }
      if (process.env.PARITY_REPORT) {
        writeFileSync(process.env.PARITY_REPORT, JSON.stringify(comparisons, null, 2) + '\n', {
          flag: 'a'
        })
      }
      const differences = comparisons.flatMap(({ key, ours, kicad }) => [
        ...kicad
          .filter((item) => !ours.includes(item))
          .map((item) => `${key}: KiCad reports ${item}; we do not`),
        ...ours
          .filter((item) => !kicad.includes(item))
          .map((item) => `${key}: we report ${item}; KiCad does not`)
      ])
      const known = KNOWN[basename(rootFile)]
      if (known) {
        const keys = Array.isArray(known.key) ? known.key : [known.key]
        const expected = differences.filter((line) =>
          keys.some((key) => line.startsWith(`${key}: `))
        )
        expect(expected, known.why).not.toEqual([])
        expect(differences.filter((line) => !expected.includes(line))).toEqual([])
      } else {
        expect(differences).toEqual([])
      }
    })
  }
})
