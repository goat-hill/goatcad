<script setup lang="ts">
import { ref, computed, shallowRef, watch, provide, onUnmounted } from 'vue'
import {
  projectIndexRecords,
  projectIndexLibraries,
  type IndexRecord,
  type ProjectLibraryRef
} from '../lib/libraryIndex'
import { useI18n } from 'vue-i18n'
import FileTreeNode from './FileTreeNode.vue'
import {
  findFileNode,
  flattenVisibleRows,
  horizontalMove,
  moveSelection,
  type TreeSelection
} from '../lib/fileTreeNav'
import LibraryNavigator from './LibraryNavigator.vue'
import ContextMenu from './shared/ContextMenu.vue'
import {
  explorerHeight as panelExplorerHeight,
  setExplorerHeight,
  setSidebarWidth,
  sidebarWidth as panelSidebarWidth
} from '../lib/panelLayout'
import FileIcon from './shared/FileIcon.vue'
import Icon from './shared/Icon.vue'
import { agentPreference } from '../lib/agentPreference'
import { toolTitle } from '../lib/hotkeys'
import {
  buildFileTreeMenu,
  siblingNames,
  validateFileName,
  RENAME_SESSION_KEY,
  SYMBOL_RENAME_SESSION_KEY,
  type NameError,
  type FileMenuScope
} from '../lib/fileMenu'
import { buildCommandMenu, type CommandId } from '../lib/commands'
import type { NewFileKind } from '../lib/project/scaffold'
import type { MenuNode, LabelSegment } from '../lib/menu'
import type { LibraryTableKind } from '../lib/kicad/libraryTableWrite'
import { rootSheetUuid, type ProjectCandidate } from '../lib/project/projectDetect'
import { collectBoards } from '../lib/project/projectMembers'
import { compareNames } from '../lib/nameOrder'
import type { GitDiffSide, GitFileStatus, GitStatusResult } from '../../../preload/gitTypes'
import GitStatusFooter from './git/GitStatusFooter.vue'
import type { TerminalKind } from '../../../preload/terminalTypes'
import {
  buildTreeDecorations,
  EMPTY_GIT_DECORATIONS,
  GIT_DECORATIONS_KEY
} from '../lib/gitDecorations'
import GitPane from './git/GitPane.vue'

const { t } = useI18n()
const agent = agentPreference()
import {
  browserHierarchyFs,
  resolveForest,
  sheetStructureKey,
  type HierarchyFs,
  type SchematicHierarchy,
  type SheetInstance
} from '../lib/schematic/hierarchy'
import { documentStore } from '../lib/document/documentStore'

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

interface LibraryConfig {
  nickname: string
  path: string
  type: 'local' | 'remote'
  readOnly?: boolean
}

const props = defineProps<{
  projectPath: string | null
  projectName: string
  files: FileItem[]
  activeTabPath: string | null
  activeSidebarTab: 'explorer' | 'git' | 'parts'
  /** VS Code-style: false collapses the drawer down to the activity bar. */
  drawerVisible: boolean
  libraries: LibraryConfig[]
  loadingFilePath: string | null
  gitStatus: GitStatusResult | null
  /**
   * A just-created file to open the inline name editor on. `New ▸` creates with
   * a default name and immediately offers a rename, so naming stays one gesture
   * without a separate pending-row mechanism.
   */
  renameRequestPath?: string | null
  /**
   * The design whose libraries, hierarchy, and settings apply. Null means the
   * window has a folder but no project, so edits are isolated
   * (docs/projects.md).
   */
  activeProject: ProjectCandidate | null
  /** Every project found in the workspace; >1 makes the indicator a switcher. */
  projectCandidates: ProjectCandidate[]
  /** Bumped by App when the project-scope index finishes (re)loading. */
  projectIndexGeneration: number
  /** Bumps on every committed project file operation; see App's `projectRevision`. */
  projectRevision: number
  /** Live editor-buffer content for an open file (else null); see App's `readOpenBuffer`. */
  readOpenBuffer: (path: string) => string | null
  /** Symbols held by each open `.kicad_sym` buffer, keyed by path. Both symbol
   *  lists resolve through this first — a rename this tree offered has to show
   *  its result, and it reaches the buffer a save before disk. */
  openLibrarySymbols: Record<string, string[]>
  /** Restored panel sizes from the window session; undefined uses the defaults. */
}>()

const emit = defineEmits<{
  (e: 'update:activeSidebarTab', tab: 'explorer' | 'git' | 'parts'): void
  /** Open the Settings editor tab (`goatcad://settings`). */
  /** Optional category to land on, e.g. the Part Search panel's setup card
   *  sending the user straight to the distributor keys rather than Appearance. */
  (e: 'open-settings', category?: string): void
  /** Share app feedback (FeedbackDialog.vue). */
  (e: 'share-feedback'): void
  /** Part Search is a tab, not a drawer — see the activity-bar comment. */
  (e: 'open-parts'): void
  /** Open a terminal. `shell` is always a new tab; the agents are one per window. */
  (e: 'new-terminal', kind: TerminalKind): void
  (e: 'update:drawerVisible', visible: boolean): void
  (e: 'open-file', node: FileItem, options?: { preview?: boolean }): void
  (e: 'open-folder'): void
  /** The no-project state's exit; App owns the scaffold flow. */
  (e: 'new-project'): void
  (e: 'refresh-directory'): void
  (e: 'open-branch-picker'): void
  /** A Git pane row: the file's diff, as a preview tab unless pinned. */
  (
    e: 'open-diff',
    side: GitDiffSide,
    file: GitFileStatus,
    options: { preview: boolean; symbol?: string }
  ): void
  (e: 'create-file', name: string): void
  (e: 'file-action', action: CommandId, node: FileItem): void
  (e: 'rename-file', node: FileItem, newName: string): void
  (e: 'create-typed-file', kind: NewFileKind, directory: string): void
  /** New Symbol/Footprint Library: create the file/dir named `name`, then register it. */
  (e: 'new-library', kind: LibraryTableKind, name: string): void
  /** Add Symbol/Footprint Library: register an existing one (App picks the file/dir). */
  (e: 'add-library', kind: LibraryTableKind): void
  /** User picked the window's active project; `path` is a `.kicad_pro`. */
  (e: 'select-project', path: string): void
  /** Open a `.kicad_sym` in the symbol editor, revealing the named symbol. */
  (e: 'open-library-symbol', path: string, symbol: string, options?: { preview?: boolean }): void
  /** Add a new symbol to the `.kicad_sym` at `path` (opens its editor). */
  (e: 'new-symbol', path: string): void
  /** Rename `symbol` → `newName` in the `.kicad_sym` at `path`. */
  (e: 'rename-symbol', path: string, symbol: string, newName: string): void
  /** Delete `symbol` from the `.kicad_sym` at `path` (opens its editor). */
  (e: 'delete-symbol', path: string, symbol: string): void
  /** A drag finished; App persists these into the window session. */
}>()

// ---- Active project switcher ----------------------------------------------
// Only reachable when the workspace holds more than one project; with a single
// one the indicator is a static label, since there is nothing to switch to.

const projectMenuPosition = ref<{ x: number; y: number; anchor: HTMLElement } | null>(null)

/** Menu id for the create escape hatch; a `.kicad_pro` path can never collide. */
const CREATE_PROJECT_ID = 'new-project'

const projectMenuItems = computed<MenuNode[]>(() => [
  ...props.projectCandidates.map((c) => ({
    id: c.path,
    // The directory disambiguates same-named projects in different folders.
    label: c.depth === 0 ? c.fileName : `${c.fileName}  ·  ${c.dir.split(/[/\\]/).pop() ?? ''}`,
    checked: c.path === props.activeProject?.path
  })),
  // Creating is rare next to picking one of the projects already here, so it
  // rides in the switcher rather than competing with it for space.
  { divider: true },
  { id: CREATE_PROJECT_ID, label: t('sidebar.project.createProject') }
])

const onProjectMenuSelect = (id: string): void => {
  if (id === CREATE_PROJECT_ID) emit('new-project')
  else emit('select-project', id)
}

/** The switcher opens its menu, and a second press shuts it (ContextMenu `anchor`). */
const openProjectMenu = (event: MouseEvent): void => {
  if (projectMenuPosition.value) {
    projectMenuPosition.value = null
    return
  }
  const anchor = event.currentTarget as HTMLElement
  const rect = anchor.getBoundingClientRect()
  projectMenuPosition.value = { x: rect.left, y: rect.bottom + 2, anchor }
}

// ---- Explicit project membership ------------------------------------------

/**
 * The active project's root sheet uuid, from its `sheets[[uuid, name]]` entry.
 * This is the one authoritative schematic↔project link KiCad records: in
 * `demos/ecc83` the two variants' project files name `28f865a0…` and
 * `e63e39d7…`, matching each `.kicad_sch`'s own uuid exactly.
 */
const projectRootUuid = ref<string | null>(null)

watch(
  () => props.activeProject?.path,
  async (path) => {
    if (!path) {
      projectRootUuid.value = null
      return
    }
    try {
      const res = await window.api.readFile(path)
      projectRootUuid.value = res.success ? rootSheetUuid(JSON.parse(res.content ?? '{}')) : null
    } catch {
      projectRootUuid.value = null
    }
  },
  { immediate: true }
)

/**
 * The one sheet tree belonging to the active project — the tree whose root
 * carries the project's root uuid. Everything reachable from it is a member;
 * a sibling project's tree in the same folder is not.
 */
const projectTree = computed((): SchematicHierarchy | null => {
  const uuid = projectRootUuid.value
  if (!uuid) return null
  return (
    sheetTrees.value.find(
      (tree) => tree.instances[0]?.sheetPath.toLowerCase() === `/${uuid.toLowerCase()}`
    ) ?? null
  )
})

/**
 * The project's board, by filename stem.
 *
 * Unlike schematics there is *no* declared link: `.kicad_pro` carries board
 * design settings but never a board filename, and `boards` is empty outside
 * multi-board projects. Stem matching is the rule KiCad's own project manager
 * uses, so agreeing with it is agreeing with the format's owner. No match
 * shows nothing rather than guessing — the File Explorer is the fallback.
 */
const projectBoards = computed(() => {
  const project = props.activeProject
  if (!project) return []
  const stem = project.name.toLowerCase()
  return collectBoards(props.files, project.dir).filter(
    (b) => b.name.slice(0, b.name.lastIndexOf('.')).toLowerCase() === stem
  )
})

// Every group open by default: the pane's job is to show the project, and a
// collapsed group hides that it has contents at all.
const projectGroupOpen = ref<Record<string, boolean>>({
  boards: true,
  schematics: true,
  footprintLibraries: true,
  symbolLibraries: true
})
const toggleProjectGroup = (key: string): void => {
  projectGroupOpen.value = {
    ...projectGroupOpen.value,
    [key]: !projectGroupOpen.value[key]
  }
}

// ---- Project group `+`: New (every group) / Add (library groups only) ------
// Each group maps to one kind, so New needs no submenu. File groups create
// straight away (create-then-rename); library groups open a New/Add flyout
// whose labels name the artifact — `.kicad_sym` / `.pretty` — so the picker is
// never a guess (§4.2, §4.5). Add exists only for libraries: schematics and
// boards are members by structure (root uuid / stem), with no table to add to.
const projectDir = computed<string | null>(() => props.activeProject?.dir ?? null)

const libAddMenu = ref<{
  kind: LibraryTableKind
  x: number
  y: number
  anchor: HTMLElement
} | null>(null)

/**
 * New / Add for one library group, rendered from the registry so these two rows
 * cannot drift from the same commands in the File menu or the explorer's
 * right-click (§4.6). New keeps its own label here — it is the one row whose
 * text is group-specific rather than a registry entry.
 */
const libAddMenuItems = computed<MenuNode[]>(() => {
  const isSymbol = (libAddMenu.value?.kind ?? 'symbol') === 'symbol'
  const ext = isSymbol ? t('libraryBrowser.add.symbolExt') : t('libraryBrowser.add.footprintExt')
  // The extension renders as `<code>`: shorter and clearer than prose, and it
  // teaches what will be created (BRAND.md "In-app UI copy").
  const newLabel: LabelSegment[] = [
    {
      text: `${
        isSymbol
          ? t('libraryBrowser.add.newSymbolLibrary')
          : t('libraryBrowser.add.newFootprintLibrary')
      } `
    },
    { text: ext, code: true },
    { text: '…' }
  ]
  return [
    { id: isSymbol ? 'new:symbol-library' : 'new:footprint-library', label: newLabel },
    ...buildCommandMenu(
      [isSymbol ? 'library:add-symbol' : 'library:add-footprint'],
      { projectPath: props.activeProject?.path ?? null },
      t
    )
  ]
})

// Name-first inline prompt for New Library (see the emit doc): the file isn't
// written until commit, and the nickname is the name typed here.
const newLibrary = ref<{ kind: LibraryTableKind; name: string; error: string } | null>(null)

const onGroupAdd = (group: string, event: MouseEvent): void => {
  const dir = projectDir.value
  if (group === 'schematics') {
    if (dir) emit('create-typed-file', 'schematic', dir)
  } else if (group === 'boards') {
    if (dir) emit('create-typed-file', 'board', dir)
  } else {
    const kind: LibraryTableKind = group === 'symbolLibraries' ? 'symbol' : 'footprint'
    const anchor = event.currentTarget as HTMLElement
    if (libAddMenu.value?.anchor === anchor) {
      libAddMenu.value = null
      return
    }
    const rect = anchor.getBoundingClientRect()
    libAddMenu.value = { kind, x: rect.right, y: rect.bottom + 2, anchor }
  }
}

const onLibAddSelect = (id: string): void => {
  const kind = libAddMenu.value?.kind ?? 'symbol'
  libAddMenu.value = null
  if (id === 'library:add-symbol' || id === 'library:add-footprint') emit('add-library', kind)
  else newLibrary.value = { kind, name: '', error: '' }
}

const existingLibNames = (kind: LibraryTableKind): string[] =>
  (kind === 'symbol' ? symbolLibraries.value : footprintLibraries.value).map((l) =>
    l.name.toLowerCase()
  )

const submitNewLibrary = (): void => {
  const nl = newLibrary.value
  if (!nl) return
  const name = nl.name.trim()
  if (
    !name ||
    /[\\/:*?"<>|]/.test(name) ||
    existingLibNames(nl.kind).includes(name.toLowerCase())
  ) {
    nl.error = t('sidebar.project.newLibraryError')
    return
  }
  emit('new-library', nl.kind, name)
  newLibrary.value = null
}

// ---- Project libraries ----------------------------------------------------
// Sourced from the *index* (project scope), not from `.kicad_sym` files lying
// in the folder: a project's libraries are the ones its `sym-lib-table` and
// `fp-lib-table` register, which may live anywhere on disk. Membership by
// directory would both miss those and invent unregistered ones.

const projectRecords = shallowRef<IndexRecord[]>([])
// Registered libraries (empty ones too) so a just-created library shows even
// before it holds a part — records alone would omit it.
const projectLibs = shallowRef<ProjectLibraryRef[]>([])

const refreshProjectRecords = (): void => {
  projectRecords.value = props.activeProject ? projectIndexRecords() : []
  projectLibs.value = props.activeProject ? projectIndexLibraries() : []
}

// App owns the workspace lifecycle and therefore the project index load; it
// bumps `projectIndexGeneration` when the load settles, which is what makes
// this reactive (the index module's own counter is a plain number).
watch(
  () => [props.activeProject?.path, props.projectIndexGeneration] as const,
  refreshProjectRecords,
  {
    immediate: true
  }
)

/** A row under a library group. Not an `IndexRecord`: a symbol living only in an
 *  open buffer has no record, and a row needs no more than this to draw itself. */
interface LibraryItem {
  /** `Nickname:Name`, as the index ids records; the row's key. */
  id: string
  name: string
  file: string
  type: 'symbol' | 'footprint'
}

interface LibraryGroup {
  name: string
  /** Backing file of the first record — a `.kicad_sym`, or one `.kicad_mod`. */
  file: string
  /**
   * The library itself as its table registers it: the `.kicad_sym` file, or the
   * `.pretty` **directory**. A footprint library's `file` is one footprint
   * inside it, which is neither what the row should name nor what a New
   * Footprint or a Delete can act on.
   */
  libraryPath: string
  items: LibraryItem[]
}

/** Path → open-buffer symbol names, keyed the way paths are compared elsewhere. */
const bufferedSymbolNames = computed(() => {
  const byPath = new Map<string, string[]>()
  for (const [path, names] of Object.entries(props.openLibrarySymbols)) {
    byPath.set(normalizePath(path), names)
  }
  return byPath
})

/**
 * Is this record backed by an actual library file?
 *
 * Project-scope records come from two sources: libraries the project's tables
 * register, and the symbol definitions *embedded* in each schematic's
 * `lib_symbols` block. Both are `scope: 'project'` and nothing on the record
 * distinguishes them, so the backing file does: an embedded copy points at the
 * `.kicad_sch` that cached it.
 *
 * Embedded definitions are not libraries — they're a self-containment cache for
 * a document already listed under Schematics — so they don't belong in a
 * library group, where they'd appear as libraries named after their nickname
 * and backed by a schematic.
 */
const isLibraryBacked = (r: IndexRecord): boolean => {
  const file = r.file.toLowerCase()
  return r.type === 'symbol' ? file.endsWith('.kicad_sym') : file.endsWith('.kicad_mod')
}

const byLibrary = (type: 'symbol' | 'footprint'): LibraryGroup[] => {
  const map = new Map<string, LibraryItem[]>()
  // Deduped by lib_id: a project's records carry both its table-registered
  // libraries and the symbols embedded in its documents, so the same part
  // legitimately arrives twice. `unionRecords` does this for search; the raw
  // per-scope accessor does not.
  const seen = new Set<string>()
  for (const r of projectRecords.value) {
    if (r.type !== type) continue
    if (!isLibraryBacked(r)) continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const arr = map.get(r.library) ?? []
    arr.push({ id: r.id, name: r.name, file: r.file, type })
    map.set(r.library, arr)
  }
  // Registered libraries with no parts yet (a just-created one, or an emptied
  // one) produce no records, so seed them here as empty groups — otherwise the
  // Project view would say "None" right after New/Add succeeded.
  for (const lib of projectLibs.value) {
    if (lib.type === type && !map.has(lib.name)) map.set(lib.name, [])
  }
  const fileFor = new Map(
    projectLibs.value.filter((l) => l.type === type).map((l) => [l.name, l.file])
  )
  return [...map.entries()]
    .map(([name, items]) => {
      // Every record in a library shares its backing file; the first is enough.
      // An empty library has no record, so fall back to its registered path.
      const file = items[0]?.file ?? fileFor.get(name) ?? ''
      // Open in an editor: that buffer, not the index, says what it holds.
      const buffered = type === 'symbol' ? bufferedSymbolNames.value.get(normalizePath(file)) : null
      const rows =
        buffered?.map((symbol) => ({ id: `${name}:${symbol}`, name: symbol, file, type })) ?? items
      return {
        name,
        file,
        libraryPath: fileFor.get(name) ?? file,
        items: [...rows].sort((a, b) => compareNames(a.name, b.name))
      }
    })
    .sort((a, b) => compareNames(a.name, b.name))
}

const symbolLibraries = computed(() => byLibrary('symbol'))
const footprintLibraries = computed(() => byLibrary('footprint'))

// A library opens by default only when its contents fit on a reasonable
// scroll; past that the expansion buries every group below it.
const AUTO_EXPAND_LIMIT = 100
const collapsedLibraries = ref<Record<string, boolean>>({})
const libraryOpen = (key: string, count: number): boolean =>
  collapsedLibraries.value[key] ?? count < AUTO_EXPAND_LIMIT
const toggleLibrary = (key: string, count: number): void => {
  collapsedLibraries.value = {
    ...collapsedLibraries.value,
    [key]: !libraryOpen(key, count)
  }
}

/**
 * Opens a library entry in its editor. From the project viewer you are looking
 * at your own design's parts, so editing is the expected next step rather than
 * the read-only Component tab.
 *
 * The two routes differ because the formats do: a `.kicad_sym` holds many
 * symbols, so opening one needs a reveal-by-name; a `.kicad_mod` *is* one
 * footprint, so opening its file is already the whole answer.
 */
const openRecord = (r: LibraryItem): void => {
  if (r.type === 'symbol') {
    emit('open-library-symbol', r.file, r.name)
    return
  }
  emit('open-file', { name: baseName(r.file), path: r.file, isDirectory: false }, { preview: true })
}

// ---- File explorer context menu -------------------------------------------

const fileMenuTarget = ref<FileItem | null>(null)
const fileMenuPosition = ref({ x: 0, y: 0 })
const fileMenuScope = ref<FileMenuScope>('explorer')

const fileMenuItems = computed(() =>
  fileMenuTarget.value
    ? buildFileTreeMenu(
        fileMenuTarget.value,
        t,
        { projectPath: props.activeProject?.path ?? null },
        fileMenuScope.value
      )
    : []
)

const openFileMenu = (
  node: FileItem,
  event: MouseEvent,
  scope: FileMenuScope = 'explorer'
): void => {
  fileMenuTarget.value = node
  fileMenuScope.value = scope
  fileMenuPosition.value = { x: event.clientX, y: event.clientY }
}

/**
 * The Project view's rows are design items backed by files — a sheet, a
 * library, one footprint — so they take the same menu the explorer gives a
 * file, in its project scope (`lib/fileMenu.ts`). Synthesized rather than
 * looked up in the tree: a library registered from outside the project folder
 * has no row there to find.
 */
const openProjectRowMenu = (path: string, isDirectory: boolean, event: MouseEvent): void =>
  openFileMenu({ name: baseName(path), path, isDirectory }, event, 'project')

const onFileMenuSelect = (action: string): void => {
  const node = fileMenuTarget.value
  if (!node) return
  const id = action as CommandId
  // Rename is the tree's own inline-edit primitive rather than an App action:
  // the row becomes an input here, and only the commit crosses the boundary.
  if (id === 'file:rename') {
    startRename(node)
    return
  }
  if (id === 'new:symbol') {
    emit('new-symbol', node.path)
    return
  }
  if (
    id === 'new:symbol-library' ||
    id === 'new:board' ||
    id === 'new:schematic' ||
    id === 'new:footprint'
  ) {
    // A file's New targets the folder holding it; a folder's targets itself.
    const directory = node.isDirectory
      ? node.path
      : node.path.slice(0, Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\')))
    emit('create-typed-file', id.slice('new:'.length) as NewFileKind, directory)
    return
  }
  emit('file-action', id, node)
}

// ---- Symbol-library right-click (New Symbol on a library; Rename/Delete on a
// symbol leaf) — the File Explorer and Project pane both route here.
const symbolMenu = ref<{ file: string; symbol?: string; x: number; y: number } | null>(null)
const symbolMenuItems = computed<MenuNode[]>(() => {
  const m = symbolMenu.value
  if (!m) return []
  return m.symbol
    ? [
        { id: 'rename-symbol', label: t('sidebar.fileMenu.rename') },
        { id: 'delete-symbol', label: t('sidebar.fileMenu.delete') }
      ]
    : [{ id: 'new-symbol', label: t('sidebar.fileMenu.newSymbol') }]
})
const openSymbolMenu = (file: string, symbol: string | undefined, event: MouseEvent): void => {
  symbolMenu.value = { file, symbol, x: event.clientX, y: event.clientY }
}
const onSymbolMenuSelect = (id: string): void => {
  const m = symbolMenu.value
  if (m) {
    if (id === 'new-symbol') emit('new-symbol', m.file)
    // Rename runs through the tree's inline-rename primitive; commit emits.
    else if (id === 'rename-symbol' && m.symbol) startSymbolRename(m.file, m.symbol)
    else if (id === 'delete-symbol' && m.symbol) emit('delete-symbol', m.file, m.symbol)
  }
  symbolMenu.value = null
}

// ---- Inline rename --------------------------------------------------------

const renamingNode = ref<FileItem | null>(null)
const renameDraft = ref('')

/**
 * Names beside a library leaf that the file tree may not know. A `.pretty` the
 * explorer never expanded has no children loaded, so a rename there would be
 * validated against nothing; the index knows what the library holds either way.
 */
const librarySiblingNames = (path: string): string[] => {
  for (const lib of [...footprintLibraries.value, ...symbolLibraries.value]) {
    if (lib.items.some((item) => item.file === path)) {
      return lib.items.filter((item) => item.file !== path).map((item) => baseName(item.file))
    }
  }
  return []
}

const renameError = computed((): NameError | null => {
  const node = renamingNode.value
  if (!node) return null
  const siblings = [
    ...new Set([...siblingNames(props.files, node.path), ...librarySiblingNames(node.path)])
  ]
  return validateFileName(renameDraft.value, siblings, node.name)
})

const startRename = (node: FileItem): void => {
  renamingNode.value = node
  renameDraft.value = node.name
}

const cancelRename = (): void => {
  renamingNode.value = null
}

const commitRename = (): void => {
  const node = renamingNode.value
  if (!node) return
  // An invalid name keeps the editor open rather than discarding the edit;
  // the red border already says why.
  if (renameError.value) return
  const name = renameDraft.value.trim()
  renamingNode.value = null
  if (name !== node.name) emit('rename-file', node, name)
}

/** Find a node by path anywhere in the loaded tree. */
const findNode = (nodes: FileItem[], path: string): FileItem | null => {
  for (const node of nodes) {
    if (node.path === path) return node
    const found = node.children ? findNode(node.children, path) : null
    if (found) return found
  }
  return null
}

// The created file only becomes renameable once the refreshed tree contains it,
// so this watches the tree rather than the request itself.
watch(
  () => [props.renameRequestPath, props.files] as const,
  ([path]) => {
    if (!path || renamingNode.value?.path === path) return
    const node = findNode(props.files, path)
    if (node) startRename(node)
  }
)

provide(RENAME_SESSION_KEY, {
  path: computed(() => renamingNode.value?.path ?? null),
  error: computed(() => renameError.value),
  onInput: (value: string) => {
    renameDraft.value = value
  },
  commit: commitRename,
  cancel: cancelRename
})

// ---- Inline rename for a symbol leaf (parallel to the file rename above) ----

const renamingSymbol = ref<{ file: string; symbol: string } | null>(null)
const symbolRenameDraft = ref('')

const symbolRenameInvalid = computed((): boolean => {
  const target = renamingSymbol.value
  if (!target) return false
  const name = symbolRenameDraft.value.trim()
  if (!name) return true
  // Clash with another symbol in the same library (its own name is fine). The
  // buffer answers first, and for a rename started in the Project pane it is
  // the only answer — the Explorer may never have expanded that library.
  const siblings =
    bufferedSymbolNames.value.get(normalizePath(target.file)) ??
    symbolChildren.value[target.file] ??
    []
  return name !== target.symbol && siblings.includes(name)
})

// Focus + select an inline-rename input the moment it renders.
const vFocus = {
  mounted: (el: HTMLInputElement): void => {
    el.focus()
    el.select()
  }
}

const startSymbolRename = (file: string, symbol: string): void => {
  renamingSymbol.value = { file, symbol }
  symbolRenameDraft.value = symbol
}
const cancelSymbolRename = (): void => {
  renamingSymbol.value = null
}
const commitSymbolRename = (): void => {
  const target = renamingSymbol.value
  if (!target || symbolRenameInvalid.value) return
  const name = symbolRenameDraft.value.trim()
  renamingSymbol.value = null
  if (name !== target.symbol) emit('rename-symbol', target.file, target.symbol, name)
}

provide(SYMBOL_RENAME_SESSION_KEY, {
  key: computed(() =>
    renamingSymbol.value ? `${renamingSymbol.value.file}#${renamingSymbol.value.symbol}` : null
  ),
  draft: computed(() => symbolRenameDraft.value),
  invalid: computed(() => symbolRenameInvalid.value),
  onInput: (value: string) => {
    symbolRenameDraft.value = value
  },
  commit: commitSymbolRename,
  cancel: cancelSymbolRename
})

// ---- Git pane -------------------------------------------------------------

// File-explorer decorations (row colors + status letters). Provided rather
// than threaded as a prop because FileTreeNode is recursive: injection reaches
// every depth without touching the recursion sites.
provide(
  GIT_DECORATIONS_KEY,
  computed(() =>
    props.gitStatus?.state === 'ok' && props.projectPath
      ? buildTreeDecorations(props.projectPath, props.gitStatus.files)
      : EMPTY_GIT_DECORATIONS
  )
)

const openChangedFile = (file: GitFileStatus): void => {
  const name = file.path.split(/[\\/]/).pop() ?? file.path
  emit('open-file', { name, path: file.path, isDirectory: false })
}

// Activity-bar badge: total changed files (any section).
const gitChangeCount = computed((): number =>
  props.gitStatus?.state === 'ok' ? props.gitStatus.files.length : 0
)
const gitChangeBadge = computed((): string =>
  props.gitStatus?.truncated ? '999+' : String(gitChangeCount.value)
)

const expandedPaths = ref<Record<string, boolean>>({})
const showNewFilePrompt = ref(false)
const newFileName = ref('')

// Scanning files recursively
const scanFiles = (nodes: FileItem[], ext: string, list: FileItem[] = []): FileItem[] => {
  for (const n of nodes) {
    if (n.isDirectory && n.children) {
      scanFiles(n.children, ext, list)
    } else if (n.name.toLowerCase().endsWith(ext)) {
      list.push(n)
    }
  }
  return list
}

const isExplorerExpanded = ref(true)
/**
 * Both sidebar sizes come from the shared, persisted layout store rather than
 * from props threaded through App: they are preferences every window agrees on,
 * not per-window session state (`panelLayout.ts`). Writes are committed on drag
 * END — one config write per drag, not one per pixel.
 */
const sidebarWidth = panelSidebarWidth()
const isResizingSidebar = ref(false)

const startSidebarResize = (e: MouseEvent): void => {
  e.preventDefault()
  isResizingSidebar.value = true
  document.addEventListener('mousemove', handleSidebarResize)
  document.addEventListener('mouseup', stopSidebarResize)
}

const handleSidebarResize = (e: MouseEvent): void => {
  if (!isResizingSidebar.value) return
  setSidebarWidth(e.clientX)
}

const stopSidebarResize = (): void => {
  isResizingSidebar.value = false
  document.removeEventListener('mousemove', handleSidebarResize)
  document.removeEventListener('mouseup', stopSidebarResize)
  setSidebarWidth(sidebarWidth.value, true)
}

// Each stacked explorer section keeps a resizable fixed height; the last
// expanded section (Schematics) fills the remainder. One generic drag handler
// resizes whichever section owns the grabbed divider.
const workspaceHeight = panelExplorerHeight()
const resizingSectionId = ref<string | null>(null)

const startSectionResize = (e: MouseEvent, sectionId: string): void => {
  e.preventDefault()
  resizingSectionId.value = sectionId
  document.addEventListener('mousemove', handleSectionResize)
  document.addEventListener('mouseup', stopSectionResize)
}

/**
 * Writes the store rather than the element's inline style, which the section's
 * own `:style` binding then renders. The old version poked `el.style.height`
 * during the drag and read it back with `parseInt` on release — a round trip
 * through the DOM that only worked because one section is resizable, and that
 * silently did nothing for any other id.
 */
const handleSectionResize = (e: MouseEvent): void => {
  const id = resizingSectionId.value
  const el = id ? document.getElementById(id) : null
  const sidebarEl = document.querySelector('.sidebar-drawer')
  if (!el || !sidebarEl) return
  const top = el.getBoundingClientRect().top
  const maxHeight = sidebarEl.getBoundingClientRect().bottom - top - 80
  setExplorerHeight(Math.min(maxHeight, e.clientY - top))
}

const stopSectionResize = (): void => {
  resizingSectionId.value = null
  document.removeEventListener('mousemove', handleSectionResize)
  document.removeEventListener('mouseup', stopSectionResize)
  setExplorerHeight(workspaceHeight.value, true)
}

watch(
  () => props.projectPath,
  (): void => {
    expandedPaths.value = {}
    if (props.projectPath) {
      expandedPaths.value[props.projectPath] = true
    }
  },
  { immediate: true }
)

// Symbol names per expanded `.kicad_sym`, filled lazily on first expand so the
// eager Sidebar bundle never statically pulls the S-expr parser.
const symbolChildren = ref<Record<string, string[]>>({})

const loadSymbolChildren = async (path: string): Promise<void> => {
  // "Loading" — the placeholder row — on first load only; a re-read keeps the
  // names on screen rather than blinking the list away.
  if (!(path in symbolChildren.value)) symbolChildren.value[path] = []
  try {
    const res = await window.api.readFile(path)
    const content = res.success ? (res.content ?? '') : ''
    const { parseKicadSymbolLibrary } = await import('../lib/kicad/symbolLibrary')
    symbolChildren.value[path] = parseKicadSymbolLibrary(content).names
  } catch {
    symbolChildren.value[path] = []
  }
}

/** What each expanded `.kicad_sym` row lists: the file's symbols, except that an
 *  open editor's buffer wins — the rule the sheet hierarchy follows too.
 *
 *  Sorted by name, as KiCad's own symbol tree is (`lib/nameOrder.ts`), not left
 *  in the order the file happens to hold: a `.kicad_sym` is written parents
 *  first, and a symbol added here is appended, so file order is neither
 *  alphabetical nor stable as the library grows. Sorting HERE rather than at
 *  each source is what keeps the read-from-disk list and an open editor's
 *  buffer in one order. */
const libraryChildren = computed(() => {
  const merged: Record<string, string[]> = { ...symbolChildren.value }
  for (const path of Object.keys(merged)) {
    const buffered = bufferedSymbolNames.value.get(normalizePath(path))
    if (buffered) merged[path] = buffered
  }
  for (const path of Object.keys(merged)) merged[path] = [...merged[path]].sort(compareNames)
  return merged
})

// A commit — this window's save or another's — invalidates what was read from
// disk. Expanded rows re-read, collapsed ones forget, so the cost is one read
// per library on screen.
watch(
  () => props.projectRevision,
  () => {
    for (const path of Object.keys(symbolChildren.value)) {
      if (expandedPaths.value[path]) void loadSymbolChildren(path)
      else delete symbolChildren.value[path]
    }
  }
)

const toggleFolder = (path: string): void => {
  setFolderExpanded(path, !expandedPaths.value[path])
}

const setFolderExpanded = (path: string, expanded: boolean): void => {
  expandedPaths.value[path] = expanded
  if (expanded && path.endsWith('.kicad_sym') && !(path in symbolChildren.value)) {
    void loadSymbolChildren(path)
  }
}

// ---- File Explorer selection + pane focus ---------------------------------
// The Explorer owns its selection: opening a tab from anywhere else (Quick
// Open, a tab click, cross-probing) must not move it. `explorerFocused` is the
// active/inactive pane state — the selection stays visible when focus leaves,
// just muted, so you can see where you were without it competing for attention.
const explorerPane = ref<HTMLElement | null>(null)
const explorerSelection = ref<TreeSelection | null>(null)
const explorerFocused = ref(false)

const onExplorerFocusOut = (e: FocusEvent): void => {
  const next = e.relatedTarget as Node | null
  if (!next || !explorerPane.value?.contains(next)) explorerFocused.value = false
}

/**
 * Clicking a row focuses the pane so the keyboard follows the mouse — but never
 * steal focus from an inline rename input living inside the same tree.
 */
const onExplorerMouseDown = (e: MouseEvent): void => {
  if ((e.target as HTMLElement | null)?.closest('input')) return
  explorerFocused.value = true
  if (!explorerPane.value?.contains(document.activeElement)) explorerPane.value?.focus()
}

/** Fully opening hands the pane over to the editor, per the preview/pin split. */
const releaseExplorerFocus = (): void => {
  explorerFocused.value = false
  ;(document.activeElement as HTMLElement | null)?.blur?.()
}

const visibleRows = computed(() =>
  flattenVisibleRows(props.files, expandedPaths.value, libraryChildren.value)
)

/** Enter (and double-click) fully open: pin the tab and give up pane focus. */
const openSelection = (): void => {
  const selection = explorerSelection.value
  if (!selection) return
  if (selection.symbol) {
    emit('open-library-symbol', selection.path, selection.symbol)
    releaseExplorerFocus()
    return
  }
  const row = visibleRows.value.find((r) => r.path === selection.path && !r.symbol)
  // A folder or library has nothing to open — Enter expands it, like Right.
  if (row?.expandable) {
    setFolderExpanded(selection.path, !row.expanded)
    return
  }
  const node = findFileNode(props.files, selection.path)
  if (node) {
    emit('open-file', node)
    releaseExplorerFocus()
  }
}

const onExplorerKeydown = (e: KeyboardEvent): void => {
  // Inline rename owns the keyboard while it is open.
  if ((e.target as HTMLElement | null)?.closest('input')) return
  const rows = visibleRows.value
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    explorerSelection.value = moveSelection(
      rows,
      explorerSelection.value,
      e.key === 'ArrowDown' ? 1 : -1
    )
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const move = horizontalMove(
      rows,
      explorerSelection.value,
      e.key === 'ArrowRight' ? 'right' : 'left'
    )
    if (move.kind === 'expand') setFolderExpanded(move.path, true)
    else if (move.kind === 'collapse') setFolderExpanded(move.path, false)
    else if (move.kind === 'select') explorerSelection.value = move.selection
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    openSelection()
  }
}

// ---- Schematics section --------------------------------------------------
// Mirrors the comprehensive components view: resolves every root hierarchy in
// the project (a workspace can hold several boards, hence several roots) and
// renders it as an indented sheet tree so sub-sheets read as children. The
// tree does not collapse: a caret on a parent sheet made the row read as a
// folder to open rather than a sheet to open.
const isHierarchyExpanded = ref(true)
const sheetTrees = ref<SchematicHierarchy[]>([])

const schematicFiles = computed((): FileItem[] => scanFiles(props.files, '.kicad_sch'))

// The Schematics group renders the project's sheet tree whenever we could
// identify it — including a single-sheet design, which is simply a one-row
// tree. There is no flat-list fallback: without a matched tree we cannot say
// which schematics belong to this project, and guessing is what put a sibling
// variant's sheets in this pane.
const hierarchyVisible = computed((): boolean => projectTree.value !== null)

// Only the active project's tree. Previously every root in the workspace was
// flattened in, which is why a sibling variant's sheets appeared. Instances
// are pre-order, so each child follows its parent, and siblings are in page
// order, as KiCad's hierarchy navigator lists them.
const hierarchyRows = computed((): SheetInstance[] => projectTree.value?.instances ?? [])

const normalizePath = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()

const baseName = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

// Resolves from disk, except that an open file's live editor buffer wins — so a
// just-added child sheet (its `(sheet)` link still unsaved in the parent buffer)
// is part of the hierarchy immediately, not only after a save (§5.3: the open
// buffer is its file's authoritative version). Re-derivation is still gated on
// the coarse `projectRevision`, so this never re-runs per keystroke.
const hierarchyFs: HierarchyFs = {
  async readFile(path) {
    const buffered = props.readOpenBuffer(path)
    return buffered !== null ? buffered : browserHierarchyFs.readFile(path)
  },
  listSchematics: (dir) => browserHierarchyFs.listSchematics(dir)
}

// Loads overlap (an edit lands mid-read); only the latest may paint.
let sheetLoad = 0
const loadSheetHierarchy = async (): Promise<void> => {
  const load = ++sheetLoad
  const paths = schematicFiles.value.map((file) => file.path)
  if (!paths.length) {
    sheetTrees.value = []
    return
  }
  let trees: SchematicHierarchy[]
  try {
    trees = await resolveForest(hierarchyFs, paths)
  } catch {
    trees = []
  }
  if (load === sheetLoad) sheetTrees.value = trees
}

// An edit that moves the tree — a page renumbered, a sheet added, renamed or
// removed, or its undo — lands in an open buffer long before a save, so the
// tree re-resolves as the buffer's sheet structure changes, not on every edit.
const bufferStructure = new Map<string, string>()
const stopBufferWatch = documentStore.subscribe((document) => {
  if (document.kind !== 'schematic' || document.state() !== 'loaded') return
  const seen = bufferStructure.get(document.path) ?? sheetStructureKey(document.baseline())
  const next = sheetStructureKey(document.storedText())
  bufferStructure.set(document.path, next)
  if (next !== seen) void loadSheetHierarchy()
})
onUnmounted(stopBufferWatch)

// The hierarchy re-derives from disk, so it must observe *content* commits (a
// saved parent gaining a `(sheet)` reference), not just changes to the file
// *set*. `projectRevision` is the project-change signal every commit bumps;
// the path join still fires it on structural changes (open, create, delete).
watch(
  () => [schematicFiles.value.map((file) => file.path).join('|'), props.projectRevision] as const,
  () => {
    void loadSheetHierarchy()
  },
  { immediate: true }
)

const isSheetActive = (filePath: string): boolean =>
  !!props.activeTabPath && normalizePath(filePath) === normalizePath(props.activeTabPath)

const openSheet = (instance: SheetInstance): void => {
  emit('open-file', {
    name: baseName(instance.filePath),
    path: instance.filePath,
    isDirectory: false
  })
}

// Clicking the active tab's icon collapses/expands the drawer (VS Code
// behavior); clicking any other icon switches to it and ensures it's shown.
const toggleSidebarTab = (tab: 'explorer' | 'git' | 'parts'): void => {
  if (tab === props.activeSidebarTab && props.drawerVisible) {
    emit('update:drawerVisible', false)
    return
  }
  emit('update:activeSidebarTab', tab)
  if (!props.drawerVisible) emit('update:drawerVisible', true)
}

const handleCreateFileSubmit = (): void => {
  const name = newFileName.value.trim()
  if (name) {
    emit('create-file', name)
    newFileName.value = ''
    showNewFilePrompt.value = false
  }
}
</script>

<template>
  <aside
    id="app-sidebar-container"
    class="sidebar-container"
    :style="{
      width: (drawerVisible ? sidebarWidth : 48) + 'px',
      display: 'flex',
      height: '100%',
      overflow: 'hidden'
    }"
  >
    <!-- Far Left: Activity Bar -->
    <div class="activity-bar">
      <div class="activity-bar-items">
        <button
          class="activity-btn"
          :class="{ active: drawerVisible && activeSidebarTab === 'explorer' }"
          :title="toolTitle(t('sidebar.activityBar.explorer'), 'app.showExplorer')"
          @click="toggleSidebarTab('explorer')"
        >
          <!-- Explorer SVG -->
          <Icon name="explorer" />
        </button>

        <button
          class="activity-btn"
          :class="{ active: drawerVisible && activeSidebarTab === 'git' }"
          :title="toolTitle(t('sidebar.activityBar.git'), 'git.focusCommit')"
          @click="toggleSidebarTab('git')"
        >
          <!-- Git branch SVG -->
          <Icon name="git-branch" />
          <span v-if="gitChangeCount > 0" class="activity-badge">{{ gitChangeBadge }}</span>
        </button>

        <button
          class="activity-btn"
          :class="{ active: drawerVisible && activeSidebarTab === 'parts' }"
          :title="toolTitle(t('sidebar.activityBar.partManager'), 'app.showLibraries')"
          @click="toggleSidebarTab('parts')"
        >
          <!-- IC chip SVG -->
          <Icon name="libraries" />
        </button>

        <!-- Opens a tab rather than a drawer, like the Settings gear below: a
             result row carries a photo, an MPN, a description and one price and
             stock line per distributor, which a ~250px pane cannot hold. -->
        <button
          class="activity-btn"
          :title="toolTitle(t('sidebar.activityBar.partSearch'), 'app.openPartSearch')"
          @click="emit('open-parts')"
        >
          <Icon name="part-search" />
        </button>

        <!-- Opens a *new* shell every click, the way a terminal emulator's
             new-tab button does — not focus-if-open like Settings and Part
             Search, which are single surfaces. Several at once is the normal way
             to use this, so the button that makes them should not have to be
             told twice. -->
        <button
          class="activity-btn"
          :title="toolTitle(t('terminal.title'), 'app.newTerminal')"
          @click="emit('new-terminal', 'shell')"
        >
          <Icon name="terminal" />
        </button>

        <!-- The agent CLI, one tab per window: a session is a conversation, and
             a second tab of it is not a second conversation. Which CLI is a
             setting (Settings ▸ AI Integrations), so the bar spends one button
             on the agent the user actually runs. It resumes this folder's last
             conversation when there is one, since `claude --continue` is the
             thing you actually meant. -->
        <button
          class="activity-btn"
          :title="toolTitle(t(`settings.agent.${agent}`), 'app.openAgent')"
          @click="emit('new-terminal', agent)"
        >
          <Icon name="agent" />
        </button>
      </div>

      <div class="activity-bar-items bottom">
        <button
          class="activity-btn"
          :title="t('sidebar.activityBar.feedback')"
          @click="emit('share-feedback')"
        >
          <Icon name="feedback" />
        </button>
        <button
          class="activity-btn"
          :title="toolTitle(t('sidebar.activityBar.settings'), 'app.openSettings')"
          @click="emit('open-settings')"
        >
          <!-- Settings SVG -->
          <Icon name="settings" />
        </button>
      </div>
    </div>

    <!-- Active Drawer Panel -->
    <div v-show="drawerVisible" class="sidebar-drawer">
      <!-- 1. FILE EXPLORER (stacked accordions: Workspace and Schematics) -->
      <template v-if="activeSidebarTab === 'explorer'">
        <!-- Accordion 1: File Explorer -->
        <div
          id="sidebar-workspace-section"
          class="sidebar-section"
          :class="{ collapsed: !isExplorerExpanded }"
          :style="
            isExplorerExpanded && projectPath && isHierarchyExpanded
              ? { height: workspaceHeight + 'px', flex: 'none' }
              : {}
          "
        >
          <div class="sidebar-section-header" @click="isExplorerExpanded = !isExplorerExpanded">
            <Icon name="chevron-right" class="chevron" :class="{ expanded: isExplorerExpanded }" />
            <span class="section-title">{{ t('sidebar.fileExplorer.title') }}</span>
            <div
              v-if="projectPath && isExplorerExpanded"
              class="sidebar-header-actions"
              @click.stop
            >
              <button
                class="sidebar-action-btn"
                :title="t('sidebar.fileExplorer.newFile')"
                @click="showNewFilePrompt = !showNewFilePrompt"
              >
                <Icon name="plus" />
              </button>
              <button
                class="sidebar-action-btn"
                :title="t('sidebar.fileExplorer.refreshExplorer')"
                @click="emit('refresh-directory')"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>

          <div
            v-show="isExplorerExpanded"
            ref="explorerPane"
            class="sidebar-section-content"
            tabindex="0"
            @focusin="explorerFocused = true"
            @focusout="onExplorerFocusOut"
            @mousedown="onExplorerMouseDown"
            @keydown="onExplorerKeydown"
          >
            <!-- Create File Inline Prompt -->
            <div v-if="showNewFilePrompt" class="new-file-prompt">
              <input
                ref="newFileInput"
                v-model="newFileName"
                class="new-file-input"
                :placeholder="t('sidebar.fileExplorer.newFilePlaceholder')"
                autofocus
                @keydown.enter="handleCreateFileSubmit"
                @keydown.escape="showNewFilePrompt = false"
              />
            </div>

            <!-- No folder opened: the window can be project-less (welcome tab, or
                 a window whose project was closed), so offer a way out. -->
            <div v-if="!projectPath" class="sidebar-empty-state">
              <p>{{ t('sidebar.fileExplorer.emptyState') }}</p>
              <button class="sidebar-open-folder-btn" @click="emit('open-folder')">
                {{ t('sidebar.fileExplorer.openFolder') }}
              </button>
            </div>

            <div
              v-else-if="files.length === 0"
              style="
                padding: 15px;
                text-align: center;
                color: var(--vscode-text-muted);
                font-size: var(--text-body-sm);
              "
            >
              {{ t('sidebar.fileExplorer.emptyWorkspace') }}
            </div>

            <!-- Root folder tree -->
            <FileTreeNode
              v-for="node in files"
              :key="node.path"
              :node="node"
              :depth="0"
              :active-tab-path="activeTabPath"
              :selection="explorerSelection"
              selection-mode
              :pane-active="explorerFocused"
              :expanded-paths="expandedPaths"
              :symbol-children="libraryChildren"
              @open-file="(n, o) => emit('open-file', n, o)"
              @toggle-folder="toggleFolder"
              @context-menu="openFileMenu"
              @open-library-symbol="(p, sym, o) => emit('open-library-symbol', p, sym, o)"
              @symbol-context-menu="(p, sym, e) => openSymbolMenu(p, sym, e)"
              @select="(sel) => (explorerSelection = sel)"
            />
          </div>
        </div>

        <div
          v-if="isExplorerExpanded && projectPath && isHierarchyExpanded"
          class="sidebar-resizer-h"
          @mousedown="startSectionResize($event, 'sidebar-workspace-section')"
        ></div>

        <!-- Accordion 2: Project. The window's semantic scope — which design
             owns these edits — and its members grouped by kind. Distinct from
             FILE EXPLORER above, which is the workspace folder and carries no
             design meaning (docs/projects.md §1-3). -->
        <div
          v-if="projectPath"
          class="sidebar-section"
          :class="{ collapsed: !isHierarchyExpanded }"
        >
          <div class="sidebar-section-header" @click="isHierarchyExpanded = !isHierarchyExpanded">
            <Icon name="chevron-right" class="chevron" :class="{ expanded: isHierarchyExpanded }" />
            <span class="section-title">{{ t('sidebar.project.title') }}</span>
          </div>

          <div v-show="isHierarchyExpanded" class="sidebar-section-content">
            <!-- Identity: which design is active, or that none is. With several
                 to choose from, picking beats creating almost every time — so
                 the switcher is the affordance and Create rides inside it. The
                 full cost of no-project is the row's tooltip, per
                 docs/projects.md §2. -->
            <button
              v-if="projectCandidates.length > 1"
              class="project-id"
              :class="{ none: !activeProject, open: projectMenuPosition !== null }"
              :title="activeProject ? t('sidebar.project.switch') : t('sidebar.project.isolated')"
              @click="openProjectMenu"
            >
              <Icon
                :name="activeProject ? 'project' : 'status-warning'"
                class="project-mark"
                aria-hidden="true"
              />
              <span class="project-name">{{
                activeProject ? activeProject.fileName : t('sidebar.project.selectPrompt')
              }}</span>
              <Icon name="chevron-down-sm" class="project-caret" />
            </button>
            <div
              v-else
              class="project-id"
              :class="{ none: !activeProject }"
              :title="activeProject ? undefined : t('sidebar.project.isolated')"
            >
              <Icon
                :name="activeProject ? 'project' : 'status-warning'"
                class="project-mark"
                aria-hidden="true"
              />
              <span class="project-name">{{
                activeProject ? activeProject.fileName : t('sidebar.project.none')
              }}</span>
            </div>

            <!-- Nothing here to pick, so creating is the only exit — and a mode
                 a user can't leave from where they see it is worse than no mode
                 at all. -->
            <button
              v-if="!activeProject && projectCandidates.length === 0"
              class="project-create"
              @click="emit('new-project')"
            >
              <Icon name="new-project" class="project-create-icon" />
              <span class="project-create-label">{{ t('sidebar.project.createProject') }}</span>
            </button>
            <p v-if="!activeProject" class="project-why">
              {{ t('sidebar.project.why') }}
            </p>

            <template v-if="activeProject">
              <div class="project-group-row">
                <button
                  class="project-group"
                  :class="{ open: projectGroupOpen.boards }"
                  @click="toggleProjectGroup('boards')"
                >
                  <Icon name="chevron-right" class="disclosure" aria-hidden="true" />
                  {{ t('sidebar.project.boards') }}
                </button>
                <button
                  class="sidebar-action-btn project-group-add"
                  :title="t('sidebar.project.newBoardTitle')"
                  @click.stop="onGroupAdd('boards', $event)"
                >
                  <Icon name="plus" />
                </button>
              </div>
              <template v-if="projectGroupOpen.boards">
                <FileTreeNode
                  v-for="m in projectBoards"
                  :key="m.path"
                  :node="{ name: m.name, path: m.path, isDirectory: false }"
                  :depth="1"
                  :active-tab-path="activeTabPath"
                  :expanded-paths="expandedPaths"
                  hide-extension
                  @open-file="(n, o) => emit('open-file', n, o)"
                  @toggle-folder="toggleFolder"
                  @context-menu="(n, e) => openFileMenu(n, e, 'project')"
                />
              </template>

              <!-- Schematics: the project's sheet tree, identified by matching
                   its root uuid. Rows use the File Explorer's classes so
                   heights, icons, and highlights match. -->
              <div class="project-group-row">
                <button
                  class="project-group"
                  :class="{ open: projectGroupOpen.schematics }"
                  @click="toggleProjectGroup('schematics')"
                >
                  <Icon name="chevron-right" class="disclosure" aria-hidden="true" />
                  {{ t('sidebar.project.schematics') }}
                </button>
                <button
                  class="sidebar-action-btn project-group-add"
                  :title="t('sidebar.project.newSchematicTitle')"
                  @click.stop="onGroupAdd('schematics', $event)"
                >
                  <Icon name="plus" />
                </button>
              </div>
              <template v-if="projectGroupOpen.schematics">
                <template v-if="hierarchyVisible">
                  <div
                    v-for="sheet in hierarchyRows"
                    :key="sheet.sheetPath"
                    class="tree-node"
                    :class="{ active: isSheetActive(sheet.filePath) }"
                    :style="{ '--depth': sheet.depth + 1 }"
                    :title="
                      t('sidebar.schematics.sheetTitle', {
                        namePath: sheet.namePath,
                        fileName: baseName(sheet.filePath)
                      })
                    "
                    @click="openSheet(sheet)"
                    @contextmenu.prevent.stop="openProjectRowMenu(sheet.filePath, false, $event)"
                  >
                    <FileIcon :name="baseName(sheet.filePath)" />
                    <span class="tree-node-label">{{ sheet.sheetName }}</span>
                  </div>
                </template>
              </template>

              <!-- Libraries come from the project's tables via the index, so a
                   library registered from outside the folder still appears.
                   Without a project there are no tables to read, so the groups
                   are omitted rather than shown permanently empty. -->
              <template v-if="activeProject">
                <div class="project-group-row">
                  <button
                    class="project-group"
                    :class="{ open: projectGroupOpen.footprintLibraries }"
                    @click="toggleProjectGroup('footprintLibraries')"
                  >
                    <Icon name="chevron-right" class="disclosure" aria-hidden="true" />
                    {{ t('sidebar.project.footprintLibraries') }}
                  </button>
                  <button
                    class="sidebar-action-btn project-group-add"
                    :title="t('sidebar.project.footprintLibraryActions')"
                    :class="{ open: libAddMenu?.kind === 'footprint' }"
                    @click.stop="onGroupAdd('footprintLibraries', $event)"
                  >
                    <Icon name="plus" />
                  </button>
                </div>
                <div
                  v-if="newLibrary && newLibrary.kind === 'footprint'"
                  class="new-file-prompt project-new-library"
                >
                  <input
                    v-model="newLibrary.name"
                    class="new-file-input"
                    :placeholder="t('sidebar.project.newLibraryPlaceholder')"
                    autofocus
                    @keydown.enter="submitNewLibrary"
                    @keydown.escape="newLibrary = null"
                  />
                  <span class="new-library-ext">{{ t('libraryBrowser.add.footprintExt') }}</span>
                </div>
                <template v-if="projectGroupOpen.footprintLibraries">
                  <template v-for="lib in footprintLibraries" :key="lib.name">
                    <button
                      class="tree-node lib-node"
                      :title="lib.libraryPath"
                      @click="toggleLibrary('fp:' + lib.name, lib.items.length)"
                      @contextmenu.prevent.stop="openProjectRowMenu(lib.libraryPath, true, $event)"
                    >
                      <span
                        class="tree-node-arrow"
                        :class="{ expanded: libraryOpen('fp:' + lib.name, lib.items.length) }"
                      >
                        <Icon name="chevron-right" />
                      </span>
                      <span class="tree-node-label">{{ lib.name }}</span>
                    </button>
                    <div
                      v-for="r in libraryOpen('fp:' + lib.name, lib.items.length) ? lib.items : []"
                      :key="r.id"
                      class="tree-node lib-leaf"
                      @click="openRecord(r)"
                      @contextmenu.prevent.stop="openProjectRowMenu(r.file, false, $event)"
                    >
                      <FileIcon kind="footprint" />
                      <input
                        v-if="renamingNode?.path === r.file"
                        v-focus
                        class="tree-node-rename"
                        :class="{ invalid: renameError }"
                        :value="renameDraft"
                        @click.stop
                        @input="renameDraft = ($event.target as HTMLInputElement).value"
                        @keydown.enter.stop.prevent="commitRename"
                        @keydown.escape.stop.prevent="cancelRename"
                        @blur="cancelRename"
                      />
                      <span v-else class="tree-node-label">{{ r.name }}</span>
                    </div>
                  </template>
                </template>

                <div class="project-group-row">
                  <button
                    class="project-group"
                    :class="{ open: projectGroupOpen.symbolLibraries }"
                    @click="toggleProjectGroup('symbolLibraries')"
                  >
                    <Icon name="chevron-right" class="disclosure" aria-hidden="true" />
                    {{ t('sidebar.project.symbolLibraries') }}
                  </button>
                  <button
                    class="sidebar-action-btn project-group-add"
                    :title="t('sidebar.project.symbolLibraryActions')"
                    :class="{ open: libAddMenu?.kind === 'symbol' }"
                    @click.stop="onGroupAdd('symbolLibraries', $event)"
                  >
                    <Icon name="plus" />
                  </button>
                </div>
                <div
                  v-if="newLibrary && newLibrary.kind === 'symbol'"
                  class="new-file-prompt project-new-library"
                >
                  <input
                    v-model="newLibrary.name"
                    class="new-file-input"
                    :placeholder="t('sidebar.project.newLibraryPlaceholder')"
                    autofocus
                    @keydown.enter="submitNewLibrary"
                    @keydown.escape="newLibrary = null"
                  />
                  <span class="new-library-ext">{{ t('libraryBrowser.add.symbolExt') }}</span>
                </div>
                <template v-if="projectGroupOpen.symbolLibraries">
                  <template v-for="lib in symbolLibraries" :key="lib.name">
                    <button
                      class="tree-node lib-node"
                      :title="lib.libraryPath"
                      @click="toggleLibrary('sym:' + lib.name, lib.items.length)"
                      @contextmenu.prevent.stop="openProjectRowMenu(lib.libraryPath, false, $event)"
                    >
                      <span
                        class="tree-node-arrow"
                        :class="{ expanded: libraryOpen('sym:' + lib.name, lib.items.length) }"
                      >
                        <Icon name="chevron-right" />
                      </span>
                      <span class="tree-node-label">{{ lib.name }}</span>
                    </button>
                    <div
                      v-for="r in libraryOpen('sym:' + lib.name, lib.items.length) ? lib.items : []"
                      :key="r.id"
                      class="tree-node lib-leaf"
                      @click="openRecord(r)"
                      @contextmenu.prevent.stop="openSymbolMenu(lib.file, r.name, $event)"
                    >
                      <FileIcon kind="symbol" />
                      <input
                        v-if="
                          renamingSymbol?.file === lib.file && renamingSymbol?.symbol === r.name
                        "
                        v-focus
                        class="tree-node-rename"
                        :class="{ invalid: symbolRenameInvalid }"
                        :value="symbolRenameDraft"
                        @click.stop
                        @input="symbolRenameDraft = ($event.target as HTMLInputElement).value"
                        @keydown.enter.stop.prevent="commitSymbolRename"
                        @keydown.escape.stop.prevent="cancelSymbolRename"
                        @blur="cancelSymbolRename"
                      />
                      <span v-else class="tree-node-label">{{ r.name }}</span>
                    </div>
                  </template>
                </template>
              </template>
            </template>
          </div>
        </div>
      </template>

      <!-- 2. GIT -->
      <GitPane
        v-else-if="activeSidebarTab === 'git'"
        :active-tab-path="activeTabPath"
        @open-folder="emit('open-folder')"
        @open-branch-picker="emit('open-branch-picker')"
        @open-diff="(side, file, options) => emit('open-diff', side, file, options)"
        @open-file="openChangedFile"
      />

      <!-- 3. LIBRARIES -->
      <template v-else-if="activeSidebarTab === 'parts'">
        <div class="sidebar-header">
          <span>{{ t('sidebar.partManager.title') }}</span>
        </div>
        <!-- The active project's directory, not the workspace root: a project
             library table is only read by KiCad when it sits beside the
             `.kicad_pro`, so writing one into a folder with no project would
             produce a file nothing ever loads. -->
        <LibraryNavigator
          :project-path="activeProject?.dir ?? null"
          @open-file="(n, o) => emit('open-file', n, o)"
          @add-project-library="(kind) => emit('add-library', kind)"
        />
      </template>

      <!-- The repo's branch and remote state, pinned under the explorer. -->
      <GitStatusFooter
        v-if="activeSidebarTab === 'explorer'"
        :git-status="gitStatus"
        @open-branch-picker="emit('open-branch-picker')"
        @open-git-pane="emit('update:activeSidebarTab', 'git')"
      />
    </div>
    <div v-if="drawerVisible" class="sidebar-resizer-v" @mousedown="startSidebarResize"></div>

    <ContextMenu
      v-if="fileMenuTarget"
      :items="fileMenuItems"
      :x="fileMenuPosition.x"
      :y="fileMenuPosition.y"
      @select="onFileMenuSelect"
      @close="fileMenuTarget = null"
    />

    <ContextMenu
      v-if="projectMenuPosition"
      :items="projectMenuItems"
      :x="projectMenuPosition.x"
      :y="projectMenuPosition.y"
      :anchor="projectMenuPosition.anchor"
      @select="onProjectMenuSelect"
      @close="projectMenuPosition = null"
    />

    <ContextMenu
      v-if="libAddMenu"
      :items="libAddMenuItems"
      :x="libAddMenu.x"
      :y="libAddMenu.y"
      :anchor="libAddMenu.anchor"
      @select="onLibAddSelect"
      @close="libAddMenu = null"
    />

    <ContextMenu
      v-if="symbolMenu"
      :items="symbolMenuItems"
      :x="symbolMenu.x"
      :y="symbolMenu.y"
      @select="onSymbolMenuSelect"
      @close="symbolMenu = null"
    />
  </aside>
</template>
