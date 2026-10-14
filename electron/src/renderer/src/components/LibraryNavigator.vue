<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { componentTabPath } from '../lib/tabs'
import { isTypingTarget } from '../lib/hotkeys'
import { matchComponent } from '../utils/componentSearch'
import {
  loadIndex,
  indexRecords,
  recordMatches,
  warmIndex,
  type IndexRecord,
  type IndexScope,
  type SymbolRecord,
  type FootprintRecord,
  type ModelRecord
} from '../lib/libraryIndex'
import { collectCapped, newBudget, NAV_RESULT_CAP } from '../lib/libraryNavSearch'
import { compareNames } from '../lib/nameOrder'
import { uniqueNickname, type LibraryTableKind } from '../lib/kicad/libraryTableWrite'
import ContextMenu from './shared/ContextMenu.vue'
import Icon from './shared/Icon.vue'
import type { LabelSegment, MenuNode } from '../lib/menu'
import Hl from './shared/HighlightText.vue'
import LibraryLeafIndicators from './LibraryLeafIndicators.vue'

/**
 * Libraries navigator — the body of the sidebar 'Libraries' panel (see
 * docs/libraries-workstream.md). The whole tree is
 * index-driven: Symbols > System > library > symbols, Footprints > System >
 * category > footprints, 3D Models > System > package > files — all from the
 * prebuilt index, so browsing needs no lazy parse and filtering shows matches
 * *in the same hierarchy*, auto-expanded (no separate results view). User-added
 * ("global"-scope) libraries render the same way from the index, as top-level
 * rows carrying a remove ✕. Filtering runs on a debounced query. Selecting an
 * item opens a Component tab.
 *
 * Shared libraries only: this panel must never parse the project's boards. A
 * "board-embedded parts" group once parsed every .kicad_pcb on project open —
 * gigabytes of transient heap on a dense board.
 */

interface FpRow {
  nickname: string
  path: string
  readOnly?: boolean
}
interface SymRow {
  nickname: string
  path: string
  source?: 'standard'
}
interface FileItem {
  name: string
  path: string
  isDirectory: boolean
}

const { t } = useI18n()
const props = defineProps<{
  /** Needed for project-scope library adds; null when no project is open. */
  projectPath: string | null
}>()
const emit = defineEmits<{
  (e: 'open-file', node: FileItem, options?: { preview?: boolean }): void
  /** Project-tier Add; App owns the picker and the copy-or-reference choice. */
  (e: 'add-project-library', kind: LibraryTableKind): void
}>()

// --- filter (debounced so a 40k-record scan never blocks typing) ---
const filter = ref('')
const query = ref('')
let debounce: ReturnType<typeof setTimeout> | null = null
watch(filter, (v) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => (query.value = v), 150)
})
const active = computed(() => query.value.trim().length > 0)
const nameMatches = (name: string): boolean => matchComponent(query.value, { name })

// --- index (System scope) ---
// shallowRef, not ref: the index is tens of thousands of records, read-only, and
// only ever replaced wholesale. A deep reactive proxy over it would cost ~100ms
// of proxying on each panel mount as the grouping computeds scan every record.
const records = shallowRef<IndexRecord[]>([])
const indexReady = ref(false)
const indexing = ref<{ done: number; total: number } | null>(null)

function group<T extends IndexRecord>(type: T['type'], scope: IndexScope): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of records.value) {
    if (r.type !== type || r.scope !== scope) continue
    const arr = m.get(r.library) ?? []
    arr.push(r as T)
    m.set(r.library, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => compareNames(a.name, b.name))
  return m
}
const symbolGroups = computed(() => group<SymbolRecord>('symbol', 'system'))
const footprintGroups = computed(() => group<FootprintRecord>('footprint', 'system'))
const modelGroups = computed(() => group<ModelRecord>('model', 'system'))

const symbolLibNames = computed(() => [...symbolGroups.value.keys()].sort(compareNames))
const footprintCatNames = computed(() => [...footprintGroups.value.keys()].sort(compareNames))
const modelPkgNames = computed(() => [...modelGroups.value.keys()].sort(compareNames))

// Leaves come from the capped active-search result (`activeMatches`, defined
// once the user-library sources it needs are declared) while a query is active,
// else from the full grouped index. Routing every leaf read through the one
// cached result keeps the O(N) match work to a single pass — instead of
// re-filtering each container on every render — and bounds how many leaves the
// tree can materialize (see lib/libraryNavSearch.ts).
const symbolsIn = (lib: string): SymbolRecord[] =>
  active.value ? (activeMatches.value?.symLibs.get(lib) ?? []) : (symbolGroups.value.get(lib) ?? [])
const footprintsIn = (cat: string): FootprintRecord[] =>
  active.value
    ? (activeMatches.value?.fpCats.get(cat) ?? [])
    : (footprintGroups.value.get(cat) ?? [])
const modelsIn = (pkg: string): ModelRecord[] =>
  active.value ? (activeMatches.value?.pkgs.get(pkg) ?? []) : (modelGroups.value.get(pkg) ?? [])

// A container shows when its name matches or it has matching children.
const visSymbolLibs = computed(() =>
  active.value
    ? symbolLibNames.value.filter((n) => nameMatches(n) || symbolsIn(n).length)
    : symbolLibNames.value
)
const visFootprintCats = computed(() =>
  active.value
    ? footprintCatNames.value.filter((n) => nameMatches(n) || footprintsIn(n).length)
    : footprintCatNames.value
)
const visModelPkgs = computed(() =>
  active.value
    ? modelPkgNames.value.filter((n) => nameMatches(n) || modelsIn(n).length)
    : modelPkgNames.value
)

const hasStandard = computed(
  () => symbolLibNames.value.length > 0 || footprintCatNames.value.length > 0
)

// --- expansion (auto-open every container while a query is active) ---
const showSystemSymbols = ref(false)
const showSystemFootprints = ref(false)
const showSystem3d = ref(false)
const expandedSymLib = ref(new Set<string>())
const expandedFpCat = ref(new Set<string>())
const expandedPkg = ref(new Set<string>())
const toggle = (set: { value: Set<string> }, key: string): void => {
  const next = new Set(set.value)
  next.has(key) ? next.delete(key) : next.add(key)
  set.value = next
}
// Template refs auto-unwrap, so expose per-set wrappers (they close over the ref).
const toggleSymLib = (key: string): void => toggle(expandedSymLib, key)
const toggleFpCat = (key: string): void => toggle(expandedFpCat, key)
const togglePkg = (key: string): void => toggle(expandedPkg, key)
const symLibOpen = (n: string): boolean => active.value || expandedSymLib.value.has(n)
const fpCatOpen = (n: string): boolean => active.value || expandedFpCat.value.has(n)
const pkgOpen = (n: string): boolean => active.value || expandedPkg.value.has(n)

// --- selection + opening Component tabs ---
// Mirrors the explorer's VS Code tab semantics (FileTreeNode / App.openFile):
// single click opens a preview (italic, replaced by the next preview), double
// click pins it. `selectedKey` drives the highlight and arrow-key navigation.
//
// A record's lib_id (`r.id`) is NOT unique across the tree: a symbol and a
// footprint can carry the same `Nickname:Name`, and a system library can share
// an id with a user (global) one. Keying the highlight on `r.id` alone lit up
// every such collision at once. `leafKey` qualifies the id with the record's
// scope and type, so exactly one leaf — the one clicked — is ever selected.
const leafKey = (r: IndexRecord): string => `${r.scope}|${r.type}|${r.id}`
const selectedKey = ref<string | null>(null)

// VS Code list semantics: the selection has two appearances — "active pane" while
// the navigator holds focus, "inactive pane" once focus moves elsewhere (the
// opened Component tab, an editor). The selection itself never moves on blur, and
// exactly one row is ever selected, so nothing is left highlighted behind you.
const listFocused = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const onFocusIn = (): void => {
  listFocused.value = true
}
// Moving focus between rows *inside* the navigator keeps the pane active; only
// focus leaving it entirely (or being dropped) demotes the selection.
const onFocusOut = (e: FocusEvent): void => {
  const next = e.relatedTarget as Node | null
  if (next && rootEl.value?.contains(next)) return
  listFocused.value = false
}

const leafClass = (r: IndexRecord): Record<string, boolean> => {
  const selected = selectedKey.value === leafKey(r)
  return { selected, 'selected-active': selected && listFocused.value }
}

const nodeFor = (r: IndexRecord): FileItem => {
  if (r.type === 'symbol')
    return { name: r.name, path: componentTabPath('symbol', r.library, r.name), isDirectory: false }
  if (r.type === 'footprint')
    return {
      name: r.name,
      path: componentTabPath('footprint', r.library, r.name, r.file),
      isDirectory: false
    }
  return { name: r.name, path: componentTabPath('model', r.file), isDirectory: false }
}

const openRecord = (r: IndexRecord, preview: boolean): void => {
  selectedKey.value = leafKey(r)
  emit('open-file', nodeFor(r), { preview })
}

// Clicking a row makes the navigator the active pane. Chromium focuses a <button>
// on click anyway, but doing it explicitly keeps the active/inactive state
// deterministic across platforms (and seeds roving focus for the arrow keys).
const selectLeaf = (r: IndexRecord, e: MouseEvent): void => {
  ;(e.currentTarget as HTMLElement | null)?.focus()
  openRecord(r, true)
}

// --- user ("global"-scope) libraries: rendered from the index like System ---
// The table rows (nickname/path) drive the top-level node + remove ✕; the
// children come straight from the global-scope index records.
const userSymbolLibs = ref<SymRow[]>([])
const userFootprintLibs = ref<FpRow[]>([])
const expandedUserSym = ref(new Set<string>())
const expandedUserFp = ref(new Set<string>())
const busy = ref(false)
const progress = ref('')
const errorMsg = ref('')

const loadTables = async (): Promise<void> => {
  try {
    const [syms, fps] = await Promise.all([
      window.api.getSymbolLibraries(),
      window.api.getLibraries()
    ])
    userSymbolLibs.value = (syms.libraries as SymRow[])
      .filter((l) => l.source !== 'standard')
      .sort((a, b) => compareNames(a.nickname, b.nickname))
    userFootprintLibs.value = (fps.libraries as FpRow[])
      .filter((l) => !l.readOnly)
      .sort((a, b) => compareNames(a.nickname, b.nickname))
  } catch (err) {
    console.error('Failed to load user libraries', err)
  }
}

const globalSyms = computed(() =>
  records.value.filter((r): r is SymbolRecord => r.type === 'symbol' && r.scope === 'global')
)
const globalFps = computed(() =>
  records.value.filter((r): r is FootprintRecord => r.type === 'footprint' && r.scope === 'global')
)

/** Is `file` at or beneath `dir` (a user footprint library's added folder)? A
 *  footprint's index `library` is the `.pretty` basename, so rows map to records
 *  by path containment, not nickname. */
const under = (file: string, dir: string): boolean => {
  const f = file.replace(/\\/g, '/')
  const d = dir.replace(/\\/g, '/').replace(/\/$/, '')
  return f === d || f.startsWith(`${d}/`)
}

const userSymbolsOf = (row: SymRow): SymbolRecord[] =>
  active.value
    ? (activeMatches.value?.userSyms.get(row.nickname) ?? [])
    : globalSyms.value.filter((r) => r.library === row.nickname)
const userFootprintsOf = (row: FpRow): FootprintRecord[] =>
  active.value
    ? (activeMatches.value?.userFps.get(row.nickname) ?? [])
    : globalFps.value.filter((r) => under(r.file, row.path))

// Single cached pass while a query is active: matches grouped by container in
// render order, capped per primitive type so the tree can never mount an
// unbounded number of leaves (a broad query like "C" matches ~the whole index,
// which would freeze the UI thread uncapped). `capped` drives the "refine your
// search" note. See lib/libraryNavSearch.ts and RULES.md §8.
interface ActiveMatches {
  symLibs: Map<string, SymbolRecord[]>
  userSyms: Map<string, SymbolRecord[]>
  fpCats: Map<string, FootprintRecord[]>
  userFps: Map<string, FootprintRecord[]>
  pkgs: Map<string, ModelRecord[]>
  capped: boolean
}
const activeMatches = computed<ActiveMatches | null>(() => {
  if (!active.value) return null
  const q = query.value
  const m = (r: IndexRecord): boolean => recordMatches(q, r)

  // Symbols: system libraries then user libraries, sharing one budget.
  const symBudget = newBudget()
  const symLibs = collectCapped<SymbolRecord>(
    symBudget,
    symbolLibNames.value,
    (lib) => symbolGroups.value.get(lib) ?? [],
    m
  )
  const userSyms = collectCapped<SymbolRecord>(
    symBudget,
    userSymbolLibs.value.map((row) => row.nickname),
    (nick) => globalSyms.value.filter((r) => r.library === nick),
    m
  )

  // Footprints: system categories then user libraries (matched by path), one budget.
  const fpBudget = newBudget()
  const fpCats = collectCapped<FootprintRecord>(
    fpBudget,
    footprintCatNames.value,
    (cat) => footprintGroups.value.get(cat) ?? [],
    m
  )
  const fpRowByNick = new Map(userFootprintLibs.value.map((row) => [row.nickname, row]))
  const userFps = collectCapped<FootprintRecord>(
    fpBudget,
    userFootprintLibs.value.map((row) => row.nickname),
    (nick) => {
      const row = fpRowByNick.get(nick)
      return row ? globalFps.value.filter((r) => under(r.file, row.path)) : []
    },
    m
  )

  // 3D models: system packages, own budget.
  const modelBudget = newBudget()
  const pkgs = collectCapped<ModelRecord>(
    modelBudget,
    modelPkgNames.value,
    (pkg) => modelGroups.value.get(pkg) ?? [],
    m
  )

  return {
    symLibs,
    userSyms,
    fpCats,
    userFps,
    pkgs,
    capped: symBudget.capped || fpBudget.capped || modelBudget.capped
  }
})

const toggleUserSym = (nickname: string): void => toggle(expandedUserSym, nickname)
const toggleUserFp = (nickname: string): void => toggle(expandedUserFp, nickname)
const userSymOpen = (n: string): boolean => active.value || expandedUserSym.value.has(n)
const userFpOpen = (n: string): boolean => active.value || expandedUserFp.value.has(n)
// Under an active filter, show a user row only if it or a child matches.
const visUserSymRows = computed(() =>
  active.value
    ? userSymbolLibs.value.filter((row) => nameMatches(row.nickname) || userSymbolsOf(row).length)
    : userSymbolLibs.value
)
const visUserFpRows = computed(() =>
  active.value
    ? userFootprintLibs.value.filter(
        (row) => nameMatches(row.nickname) || userFootprintsOf(row).length
      )
    : userFootprintLibs.value
)

// --- add library -----------------------------------------------------------
// Scope is the *first* choice, because it is the one with consequences: a
// project-tier entry travels with the design (written `${KIPRJMOD}`-relative
// where possible), a global one is this machine only. The leaf labels name the
// artifact to look for — a symbol library is a `.kicad_sym` file, a footprint
// library is a `.pretty` directory — so the picker is never a guess
// (docs/projects.md §7.5).

const addMenu = ref<{
  kind: LibraryTableKind
  x: number
  y: number
  anchor: HTMLElement
} | null>(null)

const addMenuItems = computed<MenuNode[]>(() => {
  // "Add symbol library `.kicad_sym` to project…" — the extension renders as
  // code, which is both shorter and clearer than describing the file type in
  // prose (BRAND.md "In-app UI copy").
  const isSymbol = (addMenu.value?.kind ?? 'symbol') === 'symbol'
  const verb = isSymbol
    ? t('libraryBrowser.add.addSymbolLibrary')
    : t('libraryBrowser.add.addFootprintLibrary')
  const ext = isSymbol ? t('libraryBrowser.add.symbolExt') : t('libraryBrowser.add.footprintExt')
  const label = (scope: string): LabelSegment[] => [
    { text: `${verb} ` },
    { text: ext, code: true },
    { text: ` ${scope}` }
  ]
  return [
    {
      id: 'project',
      label: label(t('libraryBrowser.add.toProject')),
      disabled: !props.projectPath,
      disabledReason: props.projectPath ? undefined : t('libraryBrowser.add.needsProject')
    },
    { id: 'global', label: label(t('libraryBrowser.add.toAllProjects')) }
  ]
})

/** An add button opens its menu, and a second press shuts it (ContextMenu `anchor`). */
const openAddMenu = (kind: LibraryTableKind, event: MouseEvent): void => {
  const anchor = event.currentTarget as HTMLElement
  if (addMenu.value?.anchor === anchor) {
    addMenu.value = null
    return
  }
  const rect = anchor.getBoundingClientRect()
  addMenu.value = { kind, x: rect.left, y: rect.bottom + 2, anchor }
}

/** Register one library machine-wide (the `userData` JSON tables). */
const addToGlobalTable = async (kind: LibraryTableKind, libraryPath: string): Promise<void> => {
  const base = (libraryPath.split(/[/\\]/).pop() || 'library').replace(/\.(kicad_sym|pretty)$/i, '')
  if (kind === 'symbol') {
    const all = await window.api.getSymbolLibraries()
    const rows = all.libraries as SymRow[]
    const nickname = uniqueNickname(
      base,
      rows.map((l) => l.nickname)
    )
    await window.api.saveSymbolLibraries({
      libraries: [...rows, { nickname, path: libraryPath }].map((l) => ({
        ...l,
        type: 'local' as const
      }))
    })
  } else {
    const all = await window.api.getLibraries()
    const rows = all.libraries as FpRow[]
    const nickname = uniqueNickname(
      base,
      rows.map((l) => l.nickname)
    )
    await window.api.saveLibraries({
      libraries: [...rows, { nickname, path: libraryPath }].map((l) => ({
        ...l,
        type: 'local' as const
      }))
    })
  }
}

const onAddMenuSelect = async (scope: string): Promise<void> => {
  const kind = addMenu.value?.kind ?? 'symbol'
  // Project scope runs through App, which owns the picker, the copy-or-reference
  // dialog, and the one registration path (lib/libraryRegistration.ts) — the
  // Project view's own Add reaches the same code. Only the global tier, which
  // has no project to copy into and no dialog, is handled here.
  if (scope === 'project') {
    emit('add-project-library', kind)
    return
  }
  errorMsg.value = ''
  busy.value = true
  try {
    // A symbol library is one file, a footprint library is one directory. The
    // group that was clicked already tells us which, so we pick the dialog
    // rather than asking (docs/projects.md §7.5).
    const picked =
      kind === 'symbol'
        ? await window.api.pickSymbolLibraryFile(t('libraryBrowser.add.symbolFileTitle'))
        : await window.api.pickDirectory(t('libraryBrowser.add.footprintFolderTitle'))
    if (!picked) return
    await addToGlobalTable(kind, picked)
    await loadTables()
    await refreshIndex(true)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

// --- management ---
const removeUserSymbol = async (nickname: string): Promise<void> => {
  const all = await window.api.getSymbolLibraries()
  await window.api.saveSymbolLibraries({
    libraries: (all.libraries as SymRow[])
      .filter((l) => l.nickname !== nickname)
      .map((l) => ({ ...l, type: 'local' as const }))
  })
  await loadTables()
}
const removeUserFootprint = async (nickname: string): Promise<void> => {
  const all = await window.api.getLibraries()
  await window.api.saveLibraries({
    libraries: (all.libraries as FpRow[])
      .filter((l) => l.nickname !== nickname)
      .map((l) => ({ ...l, type: 'local' as const }))
  })
  await loadTables()
}
const download = async (): Promise<void> => {
  errorMsg.value = ''
  busy.value = true
  progress.value = ''
  const cleanup = window.api.onDownloadProgress((msg) => (progress.value = msg))
  try {
    const res = await window.api.downloadOfficialLibrary(['symbols', 'footprints'])
    if (!res.success) errorMsg.value = res.error || ''
    await loadTables()
  } finally {
    cleanup()
    progress.value = ''
    busy.value = false
  }
}

// --- keyboard navigation ---
// The flat list of currently-visible leaves, in the same order they render, so
// Arrow Up/Down move the selection exactly as the eye would.
const visibleLeaves = computed<IndexRecord[]>(() => {
  const out: IndexRecord[] = []
  if (symbolLibNames.value.length && (showSystemSymbols.value || active.value)) {
    for (const lib of visSymbolLibs.value) if (symLibOpen(lib)) out.push(...symbolsIn(lib))
  }
  for (const row of visUserSymRows.value)
    if (userSymOpen(row.nickname)) out.push(...userSymbolsOf(row))
  if (footprintCatNames.value.length && (showSystemFootprints.value || active.value)) {
    for (const cat of visFootprintCats.value) if (fpCatOpen(cat)) out.push(...footprintsIn(cat))
  }
  for (const row of visUserFpRows.value)
    if (userFpOpen(row.nickname)) out.push(...userFootprintsOf(row))
  if (modelPkgNames.value.length && (showSystem3d.value || active.value)) {
    for (const pkg of visModelPkgs.value) if (pkgOpen(pkg)) out.push(...modelsIn(pkg))
  }
  return out
})

const scrollEl = ref<HTMLElement | null>(null)

// Move DOM focus along with the selection (roving focus). Without this the
// originally-clicked row keeps focus, and its focus ring reads as a second
// highlight while the selection has already moved on.
const revealLeaf = (r: IndexRecord): void => {
  void nextTick(() => {
    const el = scrollEl.value?.querySelector<HTMLElement>(
      `[data-leaf-id="${CSS.escape(leafKey(r))}"]`
    )
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ block: 'nearest' })
  })
}

const onKeydown = (e: KeyboardEvent): void => {
  if (isTypingTarget()) return // leave the keys to the search field when it has focus
  if (e.key === 'Enter') {
    const r = visibleLeaves.value.find((x) => leafKey(x) === selectedKey.value)
    if (!r) return
    e.preventDefault()
    // VS Code: Enter pins the preview tab and hands the pane over to the editor,
    // so the selection stays put but drops to its inactive appearance.
    openRecord(r, false)
    ;(document.activeElement as HTMLElement | null)?.blur()
    listFocused.value = false
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const leaves = visibleLeaves.value
  if (!leaves.length) return
  e.preventDefault()
  const idx = leaves.findIndex((r) => leafKey(r) === selectedKey.value)
  const step = e.key === 'ArrowDown' ? 1 : -1
  const next = idx === -1 ? (step === 1 ? 0 : leaves.length - 1) : idx + step
  if (next < 0 || next >= leaves.length) return
  const r = leaves[next]
  // Arrow navigation always previews; App.openFile reuses the current preview
  // slot, or spawns a fresh preview if the last item was pinned ("opened").
  openRecord(r, true)
  revealLeaf(r)
}

// --- lifecycle ---
const refreshIndex = async (force = false): Promise<void> => {
  await loadIndex(force).catch(() => {})
  records.value = indexRecords()
  indexReady.value = true
  // Build the reverse/lookup maps now, while idle, so the first component the
  // user opens doesn't pay that O(N) build synchronously mid-click.
  const warm = (): void => warmIndex()
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm)
  else setTimeout(warm, 0)
}
// Manual re-index escape hatch (change detection covers the common cases).
const rebuildIndex = (): void => {
  indexing.value = { done: 0, total: 0 }
  void window.api.rebuildLibraryIndex()
}
let stopProgress: (() => void) | null = null
onMounted(async () => {
  await loadTables()
  await refreshIndex()
  stopProgress = window.api.onIndexProgress((p) => {
    if (p.complete) {
      indexing.value = null
      void refreshIndex(true)
    } else {
      indexing.value = { done: p.done, total: p.total }
    }
  })
})
onUnmounted(() => {
  stopProgress?.()
  if (debounce) clearTimeout(debounce)
})
</script>

<template>
  <div
    ref="rootEl"
    class="lib-nav"
    @keydown="onKeydown"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="nav-top">
      <input
        v-model="filter"
        class="nav-search"
        :placeholder="t('libraryBrowser.searchPlaceholder')"
      />
      <button
        class="rebuild-btn"
        :title="t('libraryBrowser.rebuildIndex')"
        :disabled="!!indexing"
        @click="rebuildIndex"
      >
        <Icon name="refresh" />
      </button>
    </div>
    <div ref="scrollEl" class="nav-scroll">
      <div v-if="indexing" class="indexing">
        {{ t('libraryBrowser.indexing', { done: indexing.done, total: indexing.total }) }}
      </div>
      <div v-if="activeMatches?.capped" class="results-capped">
        {{ t('libraryBrowser.resultsCapped', { n: NAV_RESULT_CAP }) }}
      </div>

      <!-- SYMBOLS -->
      <div class="group-head">
        <span class="group-title">{{ t('libraryBrowser.nav.symbols') }}</span>
        <button
          class="add-btn"
          :title="t('libraryBrowser.nav.addSymbol')"
          :disabled="busy"
          :class="{ open: addMenu?.kind === 'symbol' }"
          @click="openAddMenu('symbol', $event)"
        >
          {{ t('libraryBrowser.nav.addLibrary') }}
        </button>
      </div>
      <div v-if="symbolLibNames.length" class="subgroup">
        <button class="nav-sub" @click="showSystemSymbols = !showSystemSymbols">
          <Icon
            name="chevron-right"
            class="disclosure"
            :class="{ open: showSystemSymbols || active }"
          />
          {{ t('libraryBrowser.nav.system', { n: symbolLibNames.length }) }}
        </button>
        <div v-if="showSystemSymbols || active" class="nav-indent">
          <template v-for="lib in visSymbolLibs" :key="lib">
            <button class="row" @click="toggleSymLib(lib)">
              <Icon name="chevron-right" class="disclosure" :class="{ open: symLibOpen(lib) }" /><Hl
                :text="lib"
                :query="query"
              />
            </button>
            <div v-if="symLibOpen(lib)" class="nav-children">
              <button
                v-for="r in symbolsIn(lib)"
                :key="r.id"
                class="leaf"
                :class="leafClass(r)"
                :data-leaf-id="leafKey(r)"
                @click="selectLeaf(r, $event)"
                @dblclick="openRecord(r, false)"
              >
                <span class="leaf-name"><Hl :text="r.name" :query="query" /></span>
                <LibraryLeafIndicators :record="r" />
              </button>
            </div>
          </template>
        </div>
      </div>
      <template v-for="lib in visUserSymRows" :key="lib.nickname">
        <div class="row-flex">
          <button class="row grow" @click="toggleUserSym(lib.nickname)">
            <Icon
              name="chevron-right"
              class="disclosure"
              :class="{ open: userSymOpen(lib.nickname) }"
            /><Hl :text="lib.nickname" :query="query" />
          </button>
          <button
            class="remove-x"
            :title="t('libraryBrowser.nav.remove')"
            @click="removeUserSymbol(lib.nickname)"
          >
            <Icon name="close-sm" />
          </button>
        </div>
        <div v-if="userSymOpen(lib.nickname)" class="nav-children">
          <button
            v-for="r in userSymbolsOf(lib)"
            :key="r.id"
            class="leaf"
            :class="leafClass(r)"
            :data-leaf-id="leafKey(r)"
            @click="selectLeaf(r, $event)"
            @dblclick="openRecord(r, false)"
          >
            <span class="leaf-name"><Hl :text="r.name" :query="query" /></span>
            <LibraryLeafIndicators :record="r" />
          </button>
        </div>
      </template>

      <!-- FOOTPRINTS -->
      <div class="group-head">
        <span class="group-title">{{ t('libraryBrowser.nav.footprints') }}</span>
        <button
          class="add-btn"
          :title="t('libraryBrowser.nav.addFootprint')"
          :disabled="busy"
          :class="{ open: addMenu?.kind === 'footprint' }"
          @click="openAddMenu('footprint', $event)"
        >
          {{ t('libraryBrowser.nav.addLibrary') }}
        </button>
      </div>
      <div v-if="footprintCatNames.length" class="subgroup">
        <button class="nav-sub" @click="showSystemFootprints = !showSystemFootprints">
          <Icon
            name="chevron-right"
            class="disclosure"
            :class="{ open: showSystemFootprints || active }"
          />
          {{ t('libraryBrowser.nav.systemPlain') }}
        </button>
        <div v-if="showSystemFootprints || active" class="nav-indent">
          <template v-for="cat in visFootprintCats" :key="cat">
            <button class="row" @click="toggleFpCat(cat)">
              <Icon name="chevron-right" class="disclosure" :class="{ open: fpCatOpen(cat) }" /><Hl
                :text="cat"
                :query="query"
              />
            </button>
            <div v-if="fpCatOpen(cat)" class="nav-children">
              <button
                v-for="r in footprintsIn(cat)"
                :key="r.id"
                class="leaf"
                :class="leafClass(r)"
                :data-leaf-id="leafKey(r)"
                @click="selectLeaf(r, $event)"
                @dblclick="openRecord(r, false)"
              >
                <span class="leaf-name"><Hl :text="r.name" :query="query" /></span>
                <LibraryLeafIndicators :record="r" />
              </button>
            </div>
          </template>
        </div>
      </div>
      <template v-for="lib in visUserFpRows" :key="lib.nickname">
        <div class="row-flex">
          <button class="row grow" @click="toggleUserFp(lib.nickname)">
            <Icon
              name="chevron-right"
              class="disclosure"
              :class="{ open: userFpOpen(lib.nickname) }"
            /><Hl :text="lib.nickname" :query="query" />
          </button>
          <button
            class="remove-x"
            :title="t('libraryBrowser.nav.remove')"
            @click="removeUserFootprint(lib.nickname)"
          >
            <Icon name="close-sm" />
          </button>
        </div>
        <div v-if="userFpOpen(lib.nickname)" class="nav-children">
          <button
            v-for="r in userFootprintsOf(lib)"
            :key="r.id"
            class="leaf"
            :class="leafClass(r)"
            :data-leaf-id="leafKey(r)"
            @click="selectLeaf(r, $event)"
            @dblclick="openRecord(r, false)"
          >
            <span class="leaf-name"><Hl :text="r.name" :query="query" /></span>
            <LibraryLeafIndicators :record="r" />
          </button>
        </div>
      </template>

      <!-- 3D MODELS -->
      <div class="group-head">
        <span class="group-title">{{ t('libraryBrowser.nav.models3d') }}</span>
        <!-- No add button: 3D models are not a library tier. A footprint links
             its model inline and the search paths are env vars, so there is
             nothing here to add to — an explanation, not a dead control. -->
        <span
          class="group-note"
          role="note"
          :aria-label="t('libraryBrowser.nav.models3dManaged')"
          :title="t('libraryBrowser.nav.models3dManaged')"
        >
          <Icon name="info" />
        </span>
      </div>
      <div v-if="modelPkgNames.length" class="subgroup">
        <button class="nav-sub" @click="showSystem3d = !showSystem3d">
          <Icon name="chevron-right" class="disclosure" :class="{ open: showSystem3d || active }" />
          {{ t('libraryBrowser.nav.system', { n: modelPkgNames.length }) }}
        </button>
        <div v-if="showSystem3d || active" class="nav-indent">
          <template v-for="pkg in visModelPkgs" :key="pkg">
            <button class="row" @click="togglePkg(pkg)">
              <Icon name="chevron-right" class="disclosure" :class="{ open: pkgOpen(pkg) }" /><Hl
                :text="pkg"
                :query="query"
              />
            </button>
            <div v-if="pkgOpen(pkg)" class="nav-children">
              <button
                v-for="r in modelsIn(pkg)"
                :key="r.id"
                class="leaf"
                :class="leafClass(r)"
                :data-leaf-id="leafKey(r)"
                @click="selectLeaf(r, $event)"
                @dblclick="openRecord(r, false)"
              >
                <span class="leaf-name"><Hl :text="r.name" :query="query" /></span>
                <LibraryLeafIndicators :record="r" />
              </button>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="nav-note">{{ t('libraryBrowser.nav.models3dNote') }}</div>

      <!-- Download prompt — only when no standard libraries exist (and not mid-build) -->
      <div v-if="indexReady && !indexing && !hasStandard" class="download-bubble">
        <button class="download-btn" :disabled="busy" @click="download">
          {{ busy && progress ? t('libraryBrowser.downloading') : t('libraryBrowser.download') }}
        </button>
        <div v-if="progress" class="progress-note">{{ progress }}</div>
      </div>
      <div v-if="errorMsg" class="error-note">{{ errorMsg }}</div>
    </div>

    <ContextMenu
      v-if="addMenu"
      :items="addMenuItems"
      :x="addMenu.x"
      :y="addMenu.y"
      :anchor="addMenu.anchor"
      @select="onAddMenuSelect"
      @close="addMenu = null"
    />
  </div>
</template>

<style scoped>
.lib-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.nav-top {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
}

.nav-search {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background: var(--vscode-input-bg);
  color: var(--vscode-text, #d8e0dc);
  font-size: var(--text-body-sm);
  outline: none;
}

.nav-search:focus {
  border-color: var(--vscode-accent, #cca250);
}

.rebuild-btn {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  background: none;
  color: var(--vscode-text-muted, #a9b6b0);
  cursor: pointer;
}

.rebuild-btn svg {
  width: 14px;
  height: 14px;
}

.rebuild-btn:hover:not(:disabled) {
  border-color: var(--vscode-accent, #cca250);
  color: var(--vscode-accent, #cca250);
}

.rebuild-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.nav-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 10px;
}

.indexing {
  margin: 8px 6px;
  padding: 6px 8px;
  font-size: var(--text-caption);
  color: var(--vscode-accent, #cca250);
  background: var(--vscode-accent-subtle-strong);
  border: 1px solid var(--vscode-accent-border);
  border-radius: 4px;
}

.results-capped {
  margin: 8px 6px;
  padding: 6px 8px;
  font-size: var(--text-caption);
  line-height: 1.4;
  color: var(--vscode-text-muted, #a9b6b0);
  background: var(--vscode-accent-subtle);
  border: 1px solid var(--vscode-accent-border);
  border-radius: 4px;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 6px 4px;
}

.group-title {
  font-size: var(--text-caption);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-text-muted, #858585);
}

/* Explanatory marker where a group has no add action (3D models). Muted and
   non-interactive so it reads as information, not a disabled button. */
.group-note {
  display: flex;
  color: var(--vscode-text-muted, #7d8c86);
  cursor: help;
  padding: 0 4px;
}

.group-note svg {
  width: 14px;
  height: 14px;
}

/* Labelled, not a bare "+": on a header reading "Symbols", a lone plus glyph
   says "new symbol" — which is not what this does. */
.add-btn {
  background: none;
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text, #d8e0dc);
  height: 18px;
  padding: 0 6px;
  line-height: 1;
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--text-body-sm);
  white-space: nowrap;
}

.add-btn:hover:not(:disabled),
.add-btn.open {
  border-color: var(--vscode-accent, #cca250);
  color: var(--vscode-accent, #cca250);
}

.add-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.subgroup {
  display: flex;
  flex-direction: column;
}

.nav-sub,
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--vscode-text, #d8e0dc);
  font-size: 11.5px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-sub {
  color: var(--vscode-text-muted, #a9b6b0);
  font-weight: 600;
}

.nav-sub:hover,
.row:hover {
  background: var(--vscode-bg-active, #32473f);
}

.nav-indent {
  padding-left: 12px;
}

.row-flex {
  display: flex;
  align-items: center;
}

.grow {
  flex: 1;
  min-width: 0;
}

.leaf {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--vscode-text-muted, #a9b6b0);
  font-size: var(--text-body-sm);
  padding: 3px 8px 3px 26px;
  border-radius: 4px;
  cursor: pointer;
}

/* The name takes the row; the availability markers hold a fixed slot at the end. */
.leaf-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Row states, deliberately ordered weakest → strongest so exactly one row ever
   reads as "the selection". Equal-specificity rules mean source order decides, so
   a selected row that also happens to be hovered still renders as selected.
   Roving focus keeps DOM focus on the selected row, so the selected-active style
   *is* the focus indicator — hence no separate outline. */
.leaf:hover {
  background: var(--vscode-bg-hover, #2b3b35);
  color: var(--vscode-accent, #cca250);
}

/* Selected while the navigator does NOT have focus (VS Code's inactive selection):
   still shows where you are without competing with whatever pane is focused. */
.leaf.selected {
  background: var(--vscode-bg-selection-inactive, #232f2a);
  color: var(--vscode-text, #c5d3cd);
}

/* Selected while the navigator has focus — the active pane. */
.leaf.selected-active {
  background: var(--vscode-bg-active, #32473f);
  color: var(--vscode-text-light, #f0f0f2);
  box-shadow: inset 2px 0 0 var(--vscode-accent, #cca250);
}

.leaf:focus,
.leaf:focus-visible {
  outline: none;
}

.nav-children {
  display: flex;
  flex-direction: column;
}

.remove-x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: none;
  border: none;
  color: var(--vscode-text-muted, #748780);
  cursor: pointer;
  padding: 0;
  flex: none;
}

.remove-x svg {
  width: 14px;
  height: 14px;
}

.remove-x:hover {
  color: var(--vscode-error);
}

.nav-note {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted, #858585);
  padding: 4px 6px;
  line-height: 1.5;
}

.download-bubble {
  margin: 12px 6px 4px;
  padding: 10px;
  border: 1px solid var(--vscode-accent-border);
  background: var(--vscode-accent-subtle);
  border-radius: 8px;
}

.download-btn {
  width: 100%;
  background: var(--vscode-accent, #cca250);
  border: none;
  color: var(--vscode-on-accent);
  font-size: 10.5px;
  font-weight: 600;
  padding: 7px;
  border-radius: 4px;
  cursor: pointer;
}

.download-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.progress-note {
  margin-top: 6px;
  font-size: var(--text-caption);
  color: var(--vscode-accent, #cca250);
}

.error-note {
  margin: 8px 6px;
  font-size: var(--text-caption);
  color: var(--vscode-error);
}
</style>
