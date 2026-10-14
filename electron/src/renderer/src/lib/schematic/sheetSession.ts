/**
 * One open schematic, for everyone who reads or writes it.
 *
 * `EditorArea` mounts one editor, for the tab in front, and rebuilds it on
 * every switch, so the parsed sheet cannot live there: an agent would see a
 * different document from the user's, and whichever copy answered last would
 * decide what a revision meant. The session is that one copy, per document
 * (`lib/document/documentStore.ts`): it parses the tab's text, runs every
 * command through one path — text in, text out, sibling sheets included — and
 * records into the file's own history, so undo is waiting whoever made the
 * edit. The mounted editor is a view over it, and the agent's door
 * (`sheetAgent.ts`) is built on the same context.
 */
import type { SchematicSvg } from '../engine/schematicSvg'
import type { SheetSource } from '../componentsTable'
import type { CommandHistory, HistoryEntry, SelectionItem } from '../history'
import { instancesOf, type AnnotateRequest, type AnnotateSource } from './annotate'
import type { AnnotationPlan } from './annotate'
import {
  buildConnectivity,
  type ProjectNaming,
  type SchematicConnectivity,
  type SheetConnectivityInput
} from './connectivity'
import type { Nm } from '../kicad/coordinates'
import {
  resolveHierarchy,
  sheetStructureKey,
  type HierarchyFs,
  type SchematicHierarchy
} from './hierarchy'
import { inPageOrder } from './sheetPages'
import { KICAD_SUBPART, type SubpartSettings } from './symbolUnits'
import { allChecks, libraryBoundChecks, sortChecks, type CheckResult, type PinMap } from './checks'
import { checkWorker } from './worker/checkWorkerHost'
import type { CheckInstance } from './worker/protocol'
import type { ErcContext } from './ercContext'
import { basenameOf, dirnameOf, samePath, separatorOf } from '../kicad/paths'
import {
  extractConnectionGrid,
  extractSubpartSettings,
  extractNetclassNames,
  extractDesignSettings,
  netClassForNet,
  defaultNetClass,
  DEFAULT_NET_CLASSES,
  type NetClass,
  extractTextVariables,
  extractBusAliases,
  extractPinMap,
  extractRuleSeverities
} from '../kicad/project'
import { KICAD10_PIN_MAP } from '../kicad/projectDefaults'
import { applySeverities, type SeverityMap } from '../ruleSeverity'
import { ercRuleOf } from './ercCatalog'
import { applyExclusions, extractExclusions, type KicadExclusion } from '../kicadExclusions'
import { CONNECTION_GRID } from './schematicAgent'
import {
  parseKicadSchematic,
  referenceForSheetPath,
  serializeKicadSchematic,
  setSymbolInstanceReference,
  type KicadSchematic
} from '../kicad/schematic'
import {
  cleanupChanged,
  cleanupSchematic,
  connectionShape,
  type CleanupReport
} from './wireCleanup'
import type { AgentCapture, WorldBox } from './schematicAgent'
import {
  createSheetAgent,
  type PlaceableSymbol,
  type SheetAgent,
  type SheetAgentContext
} from './sheetAgent'
import type { DocumentHandle } from '../document/documentStore'
import {
  applyDocumentEdits,
  applySymbolEdits,
  type DocumentEdit,
  type SymbolEdit
} from './symbolEdits'
import type { SymbolSources } from '../symbol/symbolSources'
import { tk, type MessageKey } from '../messageKey'

/** One file's text before and after a command; `loaded` is the disk text of a
 *  sheet no tab held, so the tab store can call it that sheet's baseline. */
export interface SheetEdit {
  path: string
  before: string
  after: string
  loaded?: string
}

export interface SheetSessionDeps {
  filePath: string
  name: string
  /** The sheet's document: its live text, undo history and revision. */
  document: DocumentHandle
  /** Land new text for this file, and for any sibling a command rewrote. */
  commit(edits: SheetEdit[]): void
  /** The live document of another open sheet, or null when no tab holds it. */
  openSheet(path: string): KicadSchematic | null
  /** Reads for the sheet tree — the live-first fs, so unsaved siblings count. */
  fs: HierarchyFs
  libraries: SymbolSources
  /** The wire grid step, in sheet nanometers. */
  gridStep(): Nm
  label(key: MessageKey, count?: number): string
  createFile(path: string, content: string): Promise<{ success: boolean; error?: string }>
  fileCreated(path: string): void
  /** Bumped when any open sheet changes behind this one. */
  siblingsVersion(): number
  /** How to draw a document, when something can; absent means render answers
   *  that nothing can draw it. */
  capture?(
    document: KicadSchematic,
    box: WorldBox | null,
    maxPixels: number
  ): Promise<AgentCapture | null>
  /** The same document written as SVG (`schematicSvg.ts`). */
  captureSvg?(
    document: KicadSchematic,
    box: WorldBox | null,
    background: boolean
  ): Promise<SchematicSvg | null>
  /** A library footprint's pad numbers, for the warnings a Footprint write carries. */
  footprintPads?(libId: string): Promise<string[] | null>
  footprintModelStatus?(libIds: string[]): Promise<Record<string, string>>
  /** Which libraries the project reaches, for ERC's library rules; absent or
   *  undefined while not known, and those rules stay quiet. */
  ercLibraries?(): ErcContext | undefined
  /** Resolves once `ercLibraries` has answered, whatever it answered. */
  ercLibrariesReady?(): Promise<void>
  /** Nothing may be written back (a KiCad newer than we write, or older than we open). */
  readOnly?(): boolean
}

/** What a command carries from the view, so undo can put the selection back. */
export interface CommandSelection {
  before: SelectionItem[]
  /** Read after the edit, with the tidy's report: a view drops a selection the
   *  tidy renumbered before the entry records it. */
  after(report: CleanupReport | null): SelectionItem[]
}

export interface SheetSession {
  /** The agent's door to this sheet (`sheetAgent.ts`). */
  agent: SheetAgent
  /** Re-resolve the sheet tree, after a schematic file changed on disk. */
  reloadHierarchy(): Promise<void>
  /** Catch up with the tab's text, if something else wrote it. */
  sync(): void
  /** The parsed sheet as it is now, or null when its text does not parse. */
  document(): KicadSchematic | null
  /** Why the text does not parse, or null. */
  parseError(): string | null
  /** Bumped on every change to the parsed sheet: a view's redraw key. */
  modelRevision(): number
  /** Called after every change to the parsed sheet; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** One undoable step over this sheet and any sibling it rewrites. */
  runCommand(
    label: string,
    mutate: () => void | SheetEdit[],
    options?: { cleanup?: boolean; selection?: CommandSelection }
  ): CleanupReport | null
  /** Edits to placed symbols here and on siblings, as one command. */
  applySymbolEdits(label: string, edits: SymbolEdit[]): void
  /** Edits to whole sheet files, this one and its siblings, as one command. */
  applyDocumentEdits(
    label: string,
    edits: DocumentEdit[],
    options?: { cleanup?: boolean; selection?: CommandSelection }
  ): void
  applyAnnotationPlan(plan: AnnotationPlan): void
  /** Replace an empty sheet with a blank document, as one committed step. */
  initializeBlank(content: string): void
  /** Step back or forward; the entry says what the view should re-select. */
  undo(): HistoryEntry | null
  redo(): HistoryEntry | null
  /** Where the history stands, for `rollback`. */
  mark(): number
  /** Take back every command since `mark`, nothing left to redo: an abandoned gesture. */
  rollback(mark: number): void
  canUndo(): boolean
  canRedo(): boolean
  /** Reads the view shares with the agent, all over the one parsed sheet. */
  sheetPath(): string
  instancePaths(): string[]
  instanceProjectName(): string
  sheetSources(): SheetSource[]
  hierarchy(): SchematicHierarchy | null
  connectivity(): SchematicConnectivity | null
  /** A net's class from the project's classes, patterns and the schematic's assignments. */
  netClassOf(net: string): NetClass
  /** The project's Default class: what a wire on no net is drawn with. */
  defaultNetClass(): NetClass
  /** Every check over the design, as `schematic.check` runs them; memoized per edit. */
  checks(): CheckResult[]
  /**
   * The same checks for a view: those that read the sheets alone run in the
   * check worker, so an edit does not wait on them. Null when a newer request
   * of this session's replaced this one; memoized per edit.
   */
  backgroundChecks(): Promise<CheckResult[] | null>
  /** The library state the checks read besides the sheets: a view's reactive key for them. */
  checkSources(): readonly unknown[]
  existingReferences(): string[]
  availableSymbols(): PlaceableSymbol[]
  annotationScope(request: AnnotateRequest): AnnotateSource[]
  /**
   * Resolves once the sheet tree, the library tiers and the libraries ERC
   * reads have been read: from then on the checks answer for the whole design.
   */
  ready(): Promise<void>
}

/**
 * The text each sibling sheet was read from, for the check worker; a sheet
 * parsed elsewhere (another tab's) is serialized once, when first asked.
 */
const sheetTexts = new WeakMap<KicadSchematic, string>()
const textOf = (sheet: KicadSchematic): string => {
  let text = sheetTexts.get(sheet)
  if (text === undefined) {
    text = serializeKicadSchematic(sheet)
    sheetTexts.set(sheet, text)
  }
  return text
}

const tryParse = (text: string): KicadSchematic | null => {
  try {
    return parseKicadSchematic(text)
  } catch {
    return null
  }
}

/** Why `text` does not parse, or null when it does. Empty text has no document
 *  and no fault: a blank sheet is offered instead. */
const parseErrorOf = (text: string): string | null => {
  if (!text.trim()) return 'empty'
  try {
    parseKicadSchematic(text)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const createSheetSession = (deps: SheetSessionDeps): SheetSession => {
  const { filePath } = deps
  /** The buffer as last read from or written to the tab store. */
  let known = deps.document.text()
  /** The document's own serialization — ahead of `known` inside a batch. */
  let docText = known
  let doc = tryParse(known)
  let parseError: string | null = parseErrorOf(known)
  let revision = 0
  const listeners = new Set<() => void>()
  /** Every path that changes the parsed sheet ends here, so a view redraws once. */
  const changed = (): void => {
    revision += 1
    for (const listener of listeners) listener()
  }
  let history: CommandHistory = deps.document.openHistory(known)
  let inBatch = false

  let tree: SchematicHierarchy | null = null
  let diskSheets = new Map<string, KicadSchematic>()
  /** The project's connection grid; KiCad's default until the project is read. */
  let connectionGrid: Nm = CONNECTION_GRID
  let pinMap: PinMap = KICAD10_PIN_MAP
  let netclasses: string[] | null = null
  /** The project's classes and how nets are put in them, for drawing wires by class. */
  let classSettings: Pick<
    NonNullable<ReturnType<typeof extractDesignSettings>>,
    'classes' | 'patterns' | 'assignments'
  > | null = null
  /** How a unit is written after its reference (`symbolUnits.ts`). */
  let subpart: SubpartSettings = KICAD_SUBPART
  let textVariables: Record<string, string> | null = null
  /** The project file's part in naming nets; replaced whole when it is reread. */
  let projectNaming: ProjectNaming = {}
  /** The project's ERC severities; none (KiCad's defaults) until it is read. */
  let ercSeverities: SeverityMap = {}
  /** The findings a KiCad user excluded (`erc.erc_exclusions`). */
  let ercExclusions: KicadExclusion[] = []

  const reloadHierarchy = async (): Promise<void> => {
    let resolved: SchematicHierarchy
    try {
      resolved = await resolveHierarchy(deps.fs, filePath)
    } catch {
      return
    }
    const sheets = new Map<string, KicadSchematic>()
    for (const file of resolved.files) {
      if (samePath(file, filePath)) continue
      const text = await deps.fs.readFile(file)
      if (!text) continue
      const parsed = tryParse(text)
      if (parsed) {
        sheets.set(file, parsed)
        sheetTexts.set(parsed, text)
      }
    }
    // KiCad names the project after its root sheet.
    const root = resolved.rootFilePath
    const projectText = await deps.fs.readFile(
      `${dirnameOf(root)}${separatorOf(root)}${basenameOf(root).replace(/\.kicad_sch$/i, '')}.kicad_pro`
    )
    tree = resolved
    diskSheets = sheets
    connectionGrid = (projectText && extractConnectionGrid(projectText)) || CONNECTION_GRID
    pinMap = (projectText && extractPinMap(projectText)) || KICAD10_PIN_MAP
    netclasses = projectText ? extractNetclassNames(projectText) : null
    classSettings = projectText ? extractDesignSettings(projectText) : null
    subpart = (projectText && extractSubpartSettings(projectText)) || KICAD_SUBPART
    textVariables = projectText ? extractTextVariables(projectText) : null
    const busAliases = projectText ? extractBusAliases(projectText) : null
    projectNaming = {
      ...(busAliases ? { busAliases } : {}),
      ...(textVariables ? { textVariables } : {})
    }
    ercSeverities = (projectText && extractRuleSeverities(projectText, 'erc')) || {}
    ercExclusions = projectText ? extractExclusions(projectText, 'erc') : []
    // The design around the sheet arrived: what was read before it covered this sheet alone.
    changed()
  }
  let hierarchyReady = reloadHierarchy()

  /** The tree this sheet's text gave; a commit that moves it re-resolves the tree. */
  let structure = sheetStructureKey(known)
  /** The same for each sibling a command rewrote: a subsheet's page or name
   *  lives in its parent's file, so an edit made here can move the tree there. */
  const siblingStructure = new Map<string, string>()
  const commit = (edits: SheetEdit[]): void => {
    deps.commit(edits)
    let moved = false
    for (const edit of edits) {
      if (samePath(edit.path, filePath)) continue
      const key = edit.path.replace(/[\\/]+/g, '/').toLowerCase()
      const next = sheetStructureKey(edit.after)
      // An undo's edit carries the restored text on both sides, so the last
      // text seen is what it moved from.
      if (next !== (siblingStructure.get(key) ?? sheetStructureKey(edit.before))) moved = true
      siblingStructure.set(key, next)
    }
    const next = sheetStructureKey(docText)
    if (next === structure && !moved) return
    structure = next
    hierarchyReady = reloadHierarchy()
  }

  /** The buffer may have been rewritten behind this session — a rename's
   *  forwarding, a sibling's annotate, the editor while the tab was in front —
   *  so every request starts from it. A batch owns the document until it
   *  commits or rolls back. */
  const sync = (): void => {
    if (inBatch) return
    const text = deps.document.text()
    if (text === known) return
    known = text
    docText = text
    doc = tryParse(text)
    parseError = parseErrorOf(text)
    history = deps.document.openHistory(text)
    changed()
  }

  const sibling = (path: string): KicadSchematic | undefined =>
    deps.openSheet(path) ?? diskSheets.get(path)

  const sheetPath = (): string => {
    const match = tree?.instances.find((instance) => samePath(instance.filePath, filePath))
    return match?.sheetPath ?? `/${doc?.uuid ?? ''}`
  }

  const instancePaths = (): string[] => {
    const paths = tree
      ? tree.instances
          .filter((instance) => samePath(instance.filePath, filePath))
          .map((instance) => instance.sheetPath)
      : []
    return paths.length ? paths : [sheetPath()]
  }

  const sheetSources = (): SheetSource[] => {
    if (!doc) return []
    const fallback: SheetSource[] = [
      { schematic: doc, sheetPath: `/${doc.uuid ?? ''}`, sheetName: '', filePath }
    ]
    if (!tree || tree.instances.length === 0) return fallback
    const single = tree.instances.length <= 1
    const sources: SheetSource[] = []
    for (const instance of tree.instances) {
      const sheet = samePath(instance.filePath, filePath) ? doc : sibling(instance.filePath)
      if (!sheet) continue
      sources.push({
        schematic: sheet,
        sheetPath: instance.sheetPath,
        sheetName: single ? '' : instance.namePath,
        filePath: instance.filePath
      })
    }
    return sources.length ? sources : fallback
  }

  const connectivityInputs = (): SheetConnectivityInput[] => {
    if (!doc) return []
    const inputs: SheetConnectivityInput[] = []
    for (const instance of tree?.instances ?? []) {
      const sheet = samePath(instance.filePath, filePath) ? doc : sibling(instance.filePath)
      if (!sheet) continue
      inputs.push({
        sheetPath: instance.sheetPath,
        namePath: instance.namePath,
        sheetName: instance.sheetName,
        ...(instance.page ? { page: instance.page } : {}),
        schematic: sheet
      })
    }
    if (!inputs.length)
      inputs.push({ sheetPath: `/${doc.uuid ?? ''}`, namePath: '/', schematic: doc })
    return inputs
  }

  // Rebuilt per edit, as the editor's is; memoized so one request's reads —
  // the delta before and after a write — do not build it twice for nothing.
  let graphMemo: {
    key: string
    naming: ProjectNaming
    graph: SchematicConnectivity | null
  } | null = null
  const connectivity = (): SchematicConnectivity | null => {
    const key = `${revision}:${deps.siblingsVersion()}`
    if (graphMemo?.key === key && graphMemo.naming === projectNaming) return graphMemo.graph
    const inputs = connectivityInputs()
    let graph: SchematicConnectivity | null
    try {
      graph = inputs.length ? buildConnectivity(inputs, projectNaming) : null
    } catch {
      graph = null
    }
    graphMemo = { key, naming: projectNaming, graph }
    return graph
  }

  // Keyed on what the checks read: the graph (memoized per edit above) and the
  // library tiers, whose refs are replaced when a library loads — which is also
  // what lets a view that calls this track them.
  let checksMemo: {
    graph: SchematicConnectivity
    table: unknown
    standard: unknown
    grid: Nm
    pinMap: PinMap
    netclasses: string[] | null
    textVariables: Record<string, string> | null
    ercLibraries: ErcContext | undefined
    severities: SeverityMap
    exclusions: KicadExclusion[]
    results: CheckResult[]
  } | null = null
  const checks = (): CheckResult[] => {
    const graph = connectivity()
    const table = deps.libraries.tableSymbols.value
    const standard = deps.libraries.standardSymbols.value
    if (!graph) return []
    if (
      checksMemo?.graph === graph &&
      checksMemo.table === table &&
      checksMemo.standard === standard &&
      checksMemo.grid === connectionGrid &&
      checksMemo.pinMap === pinMap &&
      checksMemo.netclasses === netclasses &&
      checksMemo.textVariables === textVariables &&
      checksMemo.ercLibraries === deps.ercLibraries?.() &&
      checksMemo.severities === ercSeverities &&
      checksMemo.exclusions === ercExclusions
    )
      return checksMemo.results
    const results = applyExclusions(
      applySeverities(
        allChecks(graph, connectivityInputs(), deps.libraries.lookup, connectionGrid, pinMap, {
          ...deps.ercLibraries?.(),
          ...(netclasses ? { netclasses } : {}),
          ...(textVariables ? { textVariables } : {})
        }),
        ercRuleOf,
        ercSeverities
      ),
      ercExclusions,
      ercRuleOf
    )
    checksMemo = {
      graph,
      table,
      standard,
      grid: connectionGrid,
      pinMap,
      netclasses,
      textVariables,
      ercLibraries: deps.ercLibraries?.(),
      severities: ercSeverities,
      exclusions: ercExclusions,
      results
    }
    return results
  }

  const checkSources = (): readonly unknown[] => [
    deps.libraries.tableSymbols.value,
    deps.libraries.standardSymbols.value,
    deps.ercLibraries?.()
  ]

  /** The design's instances as the check worker reads them, and each file's text now. */
  const workerInputs = (): { instances: CheckInstance[]; texts: Map<string, string> } => {
    const instances: CheckInstance[] = []
    const texts = new Map<string, string>()
    for (const instance of tree?.instances ?? []) {
      const here = samePath(instance.filePath, filePath)
      const other = here ? undefined : sibling(instance.filePath)
      if (!here && !other) continue
      texts.set(instance.filePath, other ? textOf(other) : docText)
      instances.push({
        file: instance.filePath,
        sheetPath: instance.sheetPath,
        namePath: instance.namePath,
        sheetName: instance.sheetName,
        ...(instance.page ? { page: instance.page } : {})
      })
    }
    if (!instances.length) {
      texts.set(filePath, docText)
      instances.push({ file: filePath, sheetPath: `/${doc?.uuid ?? ''}`, namePath: '/' })
    }
    return { instances, texts }
  }

  let backgroundMemo: { key: readonly unknown[]; answer: Promise<CheckResult[] | null> } | null =
    null
  const backgroundChecks = (): Promise<CheckResult[] | null> => {
    if (!doc) return Promise.resolve([])
    // The rest of what the checks read moves only with the tree, which bumps the revision.
    const key = [revision, deps.siblingsVersion(), ...checkSources()]
    if (backgroundMemo?.key.every((part, i) => part === key[i])) return backgroundMemo.answer
    const { instances, texts } = workerInputs()
    const context = {
      ...deps.ercLibraries?.(),
      ...(netclasses ? { netclasses } : {}),
      ...(textVariables ? { textVariables } : {})
    }
    // The library rules read the page's libraries, so they run here; they are quick.
    const local = libraryBoundChecks(connectivityInputs(), deps.libraries.lookup, context)
    const severities = ercSeverities
    const exclusions = ercExclusions
    const memo: NonNullable<typeof backgroundMemo> = {
      key,
      answer: checkWorker()
        .run(
          filePath,
          {
            instances,
            naming: projectNaming,
            grid: connectionGrid,
            pinMap,
            ...(netclasses ? { netclasses } : {}),
            ...(textVariables ? { textVariables } : {})
          },
          texts
        )
        .then((found) => {
          if (!found) {
            if (backgroundMemo === memo) backgroundMemo = null
            return null
          }
          return applyExclusions(
            applySeverities(sortChecks([...found, ...local]), ercRuleOf, severities),
            exclusions,
            ercRuleOf
          )
        })
    }
    backgroundMemo = memo
    return memo.answer
  }

  const existingReferences = (): string[] => {
    const references: string[] = []
    for (const source of sheetSources()) {
      for (const symbol of source.schematic.symbols) {
        const reference = referenceForSheetPath(symbol, source.sheetPath)
        if (reference) references.push(reference)
      }
    }
    return references
  }

  /** Whatever placed symbols already use, else the root sheet's stem — which is
   *  the project's name by KiCad's convention. KiCad tolerates either. */
  const instanceProjectName = (): string => {
    for (const source of sheetSources()) {
      for (const symbol of source.schematic.symbols) {
        const project = symbol.instances[0]?.project
        if (project) return project
      }
    }
    const root = tree?.rootFilePath ?? filePath
    return basenameOf(root).replace(/\.kicad_sch$/i, '')
  }

  /** Embedded definitions first — the sheets are authoritative for what they
   *  carry — then the library tiers. */
  const availableSymbols = (): PlaceableSymbol[] => {
    const result = new Map<string, PlaceableSymbol>()
    const collect = (sheet: KicadSchematic | null | undefined): void => {
      if (!sheet) return
      for (const name of sheet.libSymbols.keys()) {
        if (!result.has(name)) result.set(name, { libId: name, sheet })
      }
    }
    collect(doc)
    for (const file of tree?.files ?? []) {
      if (!samePath(file, filePath)) collect(sibling(file))
    }
    for (const entry of [
      ...deps.libraries.tableSymbols.value,
      ...deps.libraries.standardSymbols.value
    ]) {
      if (!result.has(entry.libId)) result.set(entry.libId, entry)
    }
    return [...result.values()]
  }

  /**
   * One undoable step, this file through its AST and any sibling as text in,
   * text out. Inside a batch the document advances and nothing is recorded;
   * the batch records once from its own snapshot.
   */
  const runEdit = (
    label: string,
    mutate: () => void | SheetEdit[],
    options: { cleanup?: boolean; selection?: CommandSelection } = {}
  ): CleanupReport | null => {
    if (!doc) return null
    const before = docText
    // Read before the edit, so the tidy can tell where the edit touched.
    const shape = options.cleanup ? connectionShape(doc) : undefined
    const siblings = (mutate() ?? []).filter((edit) => edit.before !== edit.after)
    let after = doc ? serializeKicadSchematic(doc) : before
    let report: CleanupReport | null = null
    if (options.cleanup) {
      const tidy = parseKicadSchematic(after)
      report = cleanupSchematic(tidy, shape)
      if (cleanupChanged(report)) after = serializeKicadSchematic(tidy)
    }
    if (after === before && !siblings.length) return report
    if (after !== before) {
      docText = after
      doc = parseKicadSchematic(after)
      parseError = null
      changed()
    }
    if (inBatch) return report
    history.push({
      label,
      before,
      after,
      selectionBefore: options.selection?.before ?? [],
      selectionAfter: options.selection?.after(report) ?? [],
      ...(siblings.length
        ? { files: siblings.map(({ path, before, after }) => ({ path, before, after })) }
        : {})
    })
    known = after
    deps.document.commitText(after)
    commit([...(after !== before ? [{ path: filePath, before, after }] : []), ...siblings])
    return report
  }

  const applySymbolEditsCommand = (label: string, edits: SymbolEdit[]): void => {
    if (!edits.length) return
    runEdit(label, () => {
      const target = doc
      if (!target) return
      return applySymbolEdits(edits, {
        filePath,
        document: target,
        sibling,
        isOpen: (path) => deps.openSheet(path) !== null
      })
    })
  }

  const applyDocumentEditsCommand = (
    label: string,
    edits: DocumentEdit[],
    options: { cleanup?: boolean; selection?: CommandSelection } = {}
  ): void => {
    if (!edits.length) return
    runEdit(
      label,
      () => {
        const target = doc
        if (!target) return
        return applyDocumentEdits(edits, {
          filePath,
          document: target,
          sibling,
          isOpen: (path) => deps.openSheet(path) !== null
        })
      },
      options
    )
  }

  const applyAnnotationPlan = (plan: AnnotationPlan): void =>
    applySymbolEditsCommand(
      deps.label(tk('commandLabels.annotate'), plan.changes.length),
      plan.changes.map((change) => ({
        filePath: change.filePath,
        symbolIndex: change.symbolIndex,
        apply: (symbol) => setSymbolInstanceReference(symbol, change.sheetPath, change.to)
      }))
    )

  /** Group ops into one undo step. Rollback re-parses this file's snapshot
   *  only, so an op inside a batch must not edit sibling sheets. */
  const batch = async <T>(
    label: string,
    body: () => Promise<{ result: T; keep: boolean }>
  ): Promise<{ result: T; changed: boolean }> => {
    const snapshot = docText
    inBatch = true
    let outcome: { result: T; keep: boolean }
    try {
      outcome = await body()
    } finally {
      inBatch = false
    }
    const after = docText
    const didChange = after !== snapshot
    if (!outcome.keep || !didChange) {
      if (didChange) {
        docText = snapshot
        doc = parseKicadSchematic(snapshot)
        changed()
      }
      return { result: outcome.result, changed: didChange }
    }
    history.push({ label, before: snapshot, after, selectionBefore: [], selectionAfter: [] })
    known = after
    deps.document.commitText(after)
    commit([{ path: filePath, before: snapshot, after }])
    return { result: outcome.result, changed: didChange }
  }

  /** Land text this session did not derive from a command: an undo, a redo, or
   *  the blank sheet offered for an empty file. Siblings ride along. */
  const land = (text: string, siblings: SheetEdit[] = []): void => {
    const before = docText
    docText = text
    known = text
    doc = tryParse(text)
    parseError = parseErrorOf(text)
    deps.document.commitText(text)
    commit([...(text !== before ? [{ path: filePath, before, after: text }] : []), ...siblings])
    changed()
  }

  const stepHistory = (
    entry: HistoryEntry | null,
    side: 'before' | 'after'
  ): HistoryEntry | null => {
    if (!entry) return null
    land(
      entry[side],
      (entry.files ?? []).map((file) => ({
        path: file.path,
        before: file.before,
        after: file[side]
      }))
    )
    return entry
  }

  const context: SheetAgentContext = {
    filePath: () => filePath,
    name: () => deps.name,
    readOnly: () => deps.readOnly?.() ?? false,
    document: () => doc,
    setDocument: (next) => {
      doc = next
    },
    revision: () => deps.document.revision(),
    undo: () => stepHistory(history.undo(), 'before'),
    redo: () => stepHistory(history.redo(), 'after'),
    undoLabel: () => history.undoLabel,
    redoLabel: () => history.redoLabel,
    sheetPath,
    instancePaths,
    instanceProjectName,
    sheetSources,
    hierarchy: () => tree,
    connectivity,
    connectivityInputs,
    existingReferences,
    availableSymbols,
    ensureStandardLibrary: (libId) => deps.libraries.ensureStandardLibrary(libId),
    librarySymbolLookup: (libId) => deps.libraries.lookup(libId),
    connectionGrid: () => connectionGrid,
    pinMap: () => pinMap,
    netclasses: () => netclasses,
    subpart: () => subpart,
    textVariables: () => textVariables,
    ercLibraries: () => deps.ercLibraries?.(),
    ercSeverities: () => ercSeverities,
    ercExclusions: () => ercExclusions,
    gridStep: deps.gridStep,
    label: deps.label,
    runCommand: (label, mutate, options) => runEdit(label, mutate, options),
    batch,
    applyAnnotationPlan,
    applySymbolEdits: applySymbolEditsCommand,
    applyDocumentEdits: applyDocumentEditsCommand,
    // Numbered page by page, as KiCad walks its page-sorted hierarchy.
    annotationScope: (request: AnnotateRequest) => {
      const sources = sheetSources()
      if (request.scope === 'design') return inPageOrder(sources)
      return inPageOrder(
        instancesOf(sources, [filePath], request.scope === 'sheet' && request.recurse, samePath),
        sources
      )
    },
    createFile: deps.createFile,
    fileCreated: deps.fileCreated,
    reloadHierarchy: () => {
      hierarchyReady = reloadHierarchy()
      return hierarchyReady
    },
    capture: async (box, maxPixels) =>
      doc && deps.capture ? deps.capture(doc, box, maxPixels) : null,
    captureSvg: async (box, background) =>
      doc && deps.captureSvg ? deps.captureSvg(doc, box, background) : null,
    ready: async () => {
      await Promise.all([hierarchyReady, deps.libraries.ready(), deps.ercLibrariesReady?.()])
    },
    settle: async () => {},
    ...(deps.footprintPads ? { footprintPads: deps.footprintPads } : {}),
    ...(deps.footprintModelStatus ? { footprintModelStatus: deps.footprintModelStatus } : {})
  }

  const inner = createSheetAgent(context)
  const scope = context.annotationScope
  // Every entry point catches up with the buffer before it runs, including any added later.
  const agent = {} as SheetAgent
  const entries = agent as Record<keyof SheetAgent, unknown>
  for (const key of Object.keys(inner) as Array<keyof SheetAgent>) {
    const method = inner[key] as (...args: never[]) => unknown
    entries[key] = (...args: never[]): unknown => {
      sync()
      return method(...args)
    }
  }
  return {
    agent,
    reloadHierarchy: context.reloadHierarchy,
    sync,
    document: () => doc,
    parseError: () => parseError,
    modelRevision: () => revision,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    runCommand: (label, mutate, options) => {
      sync()
      return runEdit(label, mutate, options)
    },
    applySymbolEdits: (label, edits) => {
      sync()
      applySymbolEditsCommand(label, edits)
    },
    applyDocumentEdits: (label, edits, options) => {
      sync()
      applyDocumentEditsCommand(label, edits, options)
    },
    applyAnnotationPlan: (plan) => {
      sync()
      applyAnnotationPlan(plan)
    },
    initializeBlank: (content) => land(content),
    undo: () => stepHistory(history.undo(), 'before'),
    redo: () => stepHistory(history.redo(), 'after'),
    canUndo: () => history.canUndo,
    mark: () => history.mark(),
    rollback: (mark) => void stepHistory(history.rollback(mark), 'before'),
    canRedo: () => history.canRedo,
    sheetPath,
    instancePaths,
    instanceProjectName,
    sheetSources,
    hierarchy: () => tree,
    connectivity,
    netClassOf: (net: string): NetClass =>
      netClassForNet(
        net,
        classSettings?.classes ?? DEFAULT_NET_CLASSES,
        classSettings?.patterns ?? [],
        classSettings?.assignments ?? []
      ),
    defaultNetClass: (): NetClass => defaultNetClass(classSettings?.classes ?? DEFAULT_NET_CLASSES),
    checks,
    backgroundChecks,
    checkSources,
    existingReferences,
    availableSymbols,
    annotationScope: scope,
    ready: () => context.ready()
  }
}
