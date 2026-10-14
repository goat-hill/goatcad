<script setup lang="ts">
import {
  computed,
  markRaw,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  shallowReactive,
  shallowRef,
  watch
} from 'vue'
import Icon from './Icon.vue'
import { buildFileTree, flattenTree, type TreeRow } from '../fileTree'
import { parsePatch, type DiffHunk, type DiffLineType } from '../gitDiff'
import { highlightLine, languageFor, type Language, type Token } from '../syntax'

const props = defineProps<{
  worktree: string
  branch: string
  /** This view's tab id, so it can tell whether a focus signal is addressed to it. */
  tabId: string
  visible: boolean
  focusSignal?: { id: string; seq: number }
}>()

// Packed mode is git's own default context; whole-file mode asks for more
// context than any file has lines, so one patch parser serves both modes.
const PACKED_CONTEXT = 3
const WHOLE_FILE_CONTEXT = 1_000_000

// What opens on its own when a scope is selected: files expand in order until
// this many changed lines are accounted for, and the rest wait for a click.
// Selecting a big branch must not mount tens of thousands of rows at once.
const AUTO_EXPAND_LINES = 1500

// Ceiling on the rows one file mounts. The overflow is reported, never dropped
// silently — a truncated diff that looks complete is worse than no diff.
const MAX_RENDERED_LINES = 4000

// A diff goes stale the moment an agent commits, so returning to the tab
// re-reads it — but not on every flick between tabs.
const STALE_MS = 30_000

/** A diff row with its syntax tokens resolved, ready to mount. */
interface RenderLine {
  type: DiffLineType
  oldNo: number | null
  newNo: number | null
  text: string
  tokens: Token[]
}

interface RenderHunk {
  oldStart: number
  newStart: number
  heading: string
  lines: RenderLine[]
}

interface FileState {
  expanded: boolean
  whole: boolean
  loading: boolean
  loaded: boolean
  /** The raw patch these rows were built from; a re-read that matches it changes nothing. */
  patch: string
  hunks: RenderHunk[]
  binary: boolean
  /** Rows the render cap dropped, surfaced under the diff. */
  truncated: number
  error: string
}

/** One row of the scope rail: the working tree, the branch, or a commit. */
interface RailEntry {
  key: string
  scope: GitDiffScope
  title: string
  tip: string
  /** Plain sub-line; commit rows render a structured one from `commit` instead. */
  sub?: string
  commit?: GitCommit
}

const base = ref('master')
// shallowRef, not ref, and not as an optimization: a plain `ref` wraps its
// object in a reactive Proxy, and Electron's IPC serializes with structured
// clone, which throws DataCloneError on a Proxy. `scope` crosses the bridge on
// every request, so deep reactivity here breaks the view outright. These are
// only ever replaced wholesale, never mutated, so shallow is also correct.
const overview = shallowRef<GitDiffOverview | null>(null)
const scope = shallowRef<GitDiffScope>({ kind: 'branch' })
const listing = shallowRef<GitFileListing | null>(null)
const states = reactive<Record<string, FileState>>({})
const loading = ref(false)
/** An IPC or bridge failure, as opposed to a git failure main already reports. */
const failure = ref('')

// Per-rail-row file lists, fetched when a row is first expanded.
const railOpen = reactive<Record<string, boolean>>({})
const railLoading = reactive<Record<string, boolean>>({})
const railFiles = shallowReactive<Record<string, GitFileChange[]>>({})
// Collapsed tree folders, keyed by rail row and directory — the same folder can
// be open under one commit and shut under another.
const collapsedDirs = reactive<Record<string, boolean>>({})
const railWidth = ref(300)

const filesEl = ref<HTMLElement | null>(null)

// Bumped by every load; an in-flight fetch whose token is stale drops its result
// rather than writing it over a newer selection's.
let loadSeq = 0
let loadedAt = 0

const STATUS_LETTER: Record<GitFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: '?'
}

const files = computed(() => listing.value?.files ?? [])

const totals = computed(() => ({
  files: files.value.length,
  adds: files.value.reduce((sum, file) => sum + file.adds, 0),
  dels: files.value.reduce((sum, file) => sum + file.dels, 0)
}))

const commits = computed(() => overview.value?.commits ?? [])

const scopeLabel = computed(() => {
  const current = scope.value
  if (current.kind === 'working') return 'the working tree'
  if (current.kind === 'branch') return `all commits vs ${base.value}`
  const commit = commits.value.find((entry) => entry.sha === current.sha)
  return commit ? `${commit.shortSha} · ${commit.subject}` : 'commit'
})

/**
 * Structural compare, so a refresh that found nothing new writes nothing back.
 * Assigning an equal-but-new object still invalidates every computed and binding
 * downstream of it — which is what made an automatic reload flash the rail.
 * Deliberately serialize rather than compare named fields: a field added to one
 * of these types would silently drop out of a hand-written check, and the
 * failure mode there is a view that stops updating, which is worse than churn.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function scopeKey(target: GitDiffScope): string {
  return target.kind === 'commit' ? `commit:${target.sha}` : target.kind
}

function isActive(candidate: GitDiffScope): boolean {
  const current = scope.value
  if (current.kind === 'commit' && candidate.kind === 'commit') return current.sha === candidate.sha
  return current.kind === candidate.kind
}

function commitDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The commit being shown, when the scope is one — it heads the diff pane. */
const currentCommit = computed(() => {
  const current = scope.value
  if (current.kind !== 'commit') return null
  return commits.value.find((entry) => entry.sha === current.sha) ?? null
})

/** Everything after the subject line, which the heading already prints. */
const commitBody = computed(() => {
  const message = currentCommit.value?.message ?? ''
  const firstBreak = message.indexOf('\n')
  return firstBreak === -1 ? '' : message.slice(firstBreak + 1).trim()
})

function commitFullDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function commitTitle(commit: GitCommit): string {
  const date = new Date(commit.date)
  const when = Number.isNaN(date.getTime()) ? commit.date : date.toLocaleString()
  return `${commit.sha}\n${commit.author} · ${when}\n\n${commit.subject}`
}

function railEntry(target: GitDiffScope, rest: Omit<RailEntry, 'key' | 'scope'>): RailEntry {
  return { key: scopeKey(target), scope: target, ...rest }
}

const railEntries = computed<RailEntry[]>(() => {
  const entries: RailEntry[] = []
  const workingCount = overview.value?.workingCount ?? 0
  if (workingCount) {
    entries.push(
      railEntry(
        { kind: 'working' },
        {
          title: 'Working tree',
          sub: `${workingCount} uncommitted`,
          tip: 'Staged, unstaged, and untracked changes'
        }
      )
    )
  }
  const count = commits.value.length
  entries.push(
    railEntry(
      { kind: 'branch' },
      {
        title: 'All commits',
        sub: `${count} ${count === 1 ? 'commit' : 'commits'} over ${base.value}`,
        tip: `Every commit this branch adds over ${base.value}`
      }
    )
  )
  for (const commit of commits.value) {
    entries.push(
      railEntry(
        { kind: 'commit', sha: commit.sha },
        { title: commit.subject, tip: commitTitle(commit), commit }
      )
    )
  }
  return entries
})

// The tail of a path is what identifies a file, so the directory is the part
// allowed to ellipsize away when the row runs out of room.
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut + 1)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// ---- loading ----

/** Slice a file's hunks down to the render cap, keeping whole rows. */
function capHunks(hunks: DiffHunk[], lineCount: number): { hunks: DiffHunk[]; truncated: number } {
  if (lineCount <= MAX_RENDERED_LINES) return { hunks, truncated: 0 }
  const capped: DiffHunk[] = []
  let left = MAX_RENDERED_LINES
  for (const hunk of hunks) {
    if (left <= 0) break
    capped.push(hunk.lines.length <= left ? hunk : { ...hunk, lines: hunk.lines.slice(0, left) })
    left -= hunk.lines.length
  }
  return { hunks: capped, truncated: lineCount - MAX_RENDERED_LINES }
}

function renderHunks(hunks: DiffHunk[], language: Language): RenderHunk[] {
  return hunks.map((hunk) => {
    // Packed hunks are not contiguous, so block-comment state starts fresh at
    // each one rather than carrying a stale "inside a comment" across the gap.
    let block = false
    const lines = hunk.lines.map((line) => {
      if (line.type === 'meta') return { ...line, tokens: [] }
      const result = highlightLine(line.text, language, block)
      block = result.inBlockComment
      return { ...line, tokens: result.tokens }
    })
    return { oldStart: hunk.oldStart, newStart: hunk.newStart, heading: hunk.heading, lines }
  })
}

async function loadPatch(file: GitFileChange, seq: number): Promise<void> {
  const state = states[file.path]
  if (!state) return
  state.loading = true
  state.error = ''
  let result: GitPatchResult
  try {
    result = await window.api.gitPatch({
      worktree: props.worktree,
      base: base.value,
      scope: scope.value,
      path: file.path,
      oldPath: file.oldPath,
      untracked: file.status === 'untracked',
      context: state.whole ? WHOLE_FILE_CONTEXT : PACKED_CONTEXT
    })
  } catch (err) {
    if (seq !== loadSeq) return
    state.loading = false
    state.loaded = true
    state.error = String(err)
    return
  }
  if (seq !== loadSeq) return
  // Byte-identical to what is already on screen: rebuilding the rows would
  // re-patch every line of every open file on each refresh, for no change.
  if (state.loaded && !result.error && result.patch === state.patch) {
    state.loading = false
    return
  }
  const parsed = parsePatch(result.patch)
  const capped = capHunks(parsed.hunks, parsed.lineCount)
  state.loading = false
  state.loaded = true
  state.patch = result.patch
  state.error = result.error ?? ''
  // markRaw: the rows are replaced wholesale, never mutated, and a whole-file
  // diff would otherwise cost one reactive Proxy per line and per token.
  state.hunks = markRaw(renderHunks(capped.hunks, languageFor(file.path)))
  state.truncated = capped.truncated
  state.binary = parsed.binary
}

/**
 * `refresh` re-reads the *same* scope in place: a file already on screen keeps
 * its state and its rendered rows, and only has them replaced once the new
 * patch arrives. Nothing folds up or blanks out, which is what makes an
 * automatic reload — on window focus, on returning to the tab — bearable to
 * work under. A scope change passes false and starts clean, so the auto-expand
 * budget gets to decide afresh.
 */
async function loadFiles(refresh = false): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  if (!refresh) for (const key of Object.keys(states)) delete states[key]
  try {
    const result = await window.api.gitFiles({
      worktree: props.worktree,
      base: base.value,
      scope: scope.value
    })
    if (seq !== loadSeq) return
    failure.value = ''
    if (!same(listing.value, result)) listing.value = result
    const present = new Set(result.files.map((file) => file.path))
    for (const path of Object.keys(states)) {
      if (!present.has(path)) delete states[path]
    }
    // On a refresh the budget only governs files that just appeared; the ones
    // already listed keep whatever the reader chose for them.
    let budget = AUTO_EXPAND_LINES
    for (const file of result.files) {
      const existing = states[file.path]
      if (existing) {
        existing.binary = file.binary
        continue
      }
      const expanded = budget > 0 && !file.binary
      if (expanded) budget -= file.adds + file.dels
      states[file.path] = {
        expanded,
        whole: false,
        loading: false,
        loaded: false,
        patch: '',
        hunks: [],
        binary: file.binary,
        truncated: 0,
        error: ''
      }
    }
    // Sequentially, so selecting a scope never fires a hundred gits at once. On
    // a refresh every open file re-reads, since its contents are the point.
    for (const file of result.files) {
      if (seq !== loadSeq) return
      const state = states[file.path]
      if (state?.expanded && (!state.loaded || refresh)) await loadPatch(file, seq)
    }
  } catch (err) {
    // Without this the view renders an empty diff and blames the branch, which
    // is indistinguishable from "nothing changed" — the failure has to be said.
    if (seq !== loadSeq) return
    listing.value = null
    failure.value = String(err)
    return
  } finally {
    if (seq === loadSeq) loading.value = false
  }
  loadedAt = Date.now()
}

async function reload(resetScope: boolean): Promise<void> {
  if (resetScope) {
    scope.value = { kind: 'branch' }
    // Only a change of base or worktree invalidates the rail outright; a plain
    // refresh re-reads the open rows below instead of emptying them.
    for (const key of Object.keys(railFiles)) delete railFiles[key]
    for (const key of Object.keys(railOpen)) delete railOpen[key]
  }
  try {
    const next = await window.api.gitOverview(props.worktree, base.value)
    // Same commits, same rail: leaving the object alone is what keeps the commit
    // list from re-rendering on every foreground.
    if (!same(overview.value, next)) overview.value = next
    failure.value = ''
  } catch (err) {
    overview.value = null
    failure.value = String(err)
    return
  }
  const current = scope.value
  if (current.kind === 'commit' && !commits.value.some((entry) => entry.sha === current.sha)) {
    scope.value = { kind: 'branch' }
  } else if (resetScope && !commits.value.length && overview.value?.workingCount) {
    // A branch with nothing of its own still has something to show if it is dirty.
    scope.value = { kind: 'working' }
  }
  await loadFiles(!resetScope)
  // Rail rows the reader left open re-read too — their lists are as stale as the
  // diff was, and they are what the current-file mark rides on.
  for (const entry of railEntries.value) {
    if (railOpen[entry.key]) await fetchRailFiles(entry)
  }
}

function selectScope(next: GitDiffScope): void {
  if (isActive(next)) return
  scope.value = next
  void loadFiles()
}

// ---- the rail's per-scope file lists ----

function dirKey(entry: RailEntry, path: string): string {
  return `${entry.key}|${path}`
}

/** The visible rows of every expanded rail row's tree, rebuilt only when a dep moves. */
const railRows = computed<Record<string, TreeRow[]>>(() => {
  const rows: Record<string, TreeRow[]> = {}
  for (const entry of railEntries.value) {
    const listed = railOpen[entry.key] ? railFiles[entry.key] : undefined
    if (!listed) continue
    rows[entry.key] = flattenTree(
      buildFileTree(listed),
      (path) => collapsedDirs[dirKey(entry, path)] === true
    )
  }
  return rows
})

function onRowClick(entry: RailEntry, row: TreeRow): void {
  if (row.kind === 'dir') {
    const key = dirKey(entry, row.path)
    collapsedDirs[key] = !collapsedDirs[key]
    return
  }
  void jumpToFile(entry, row.path)
}

async function fetchRailFiles(entry: RailEntry): Promise<void> {
  railLoading[entry.key] = true
  try {
    const result = await window.api.gitFiles({
      worktree: props.worktree,
      base: base.value,
      scope: entry.scope
    })
    if (!same(railFiles[entry.key], result.files)) railFiles[entry.key] = result.files
  } catch (err) {
    railFiles[entry.key] = []
    failure.value = String(err)
  } finally {
    railLoading[entry.key] = false
  }
}

async function openRail(entry: RailEntry): Promise<void> {
  railOpen[entry.key] = true
  if (!railFiles[entry.key]) await fetchRailFiles(entry)
}

/** The caret: the only control that shuts a grouping again. */
async function toggleRail(entry: RailEntry): Promise<void> {
  if (railOpen[entry.key]) railOpen[entry.key] = false
  else await openRail(entry)
}

/**
 * Anywhere on the row. On the row you are already reading it toggles, so a
 * grouping folds away without aiming for the caret; on any other row it selects
 * and opens, since collapsing a row in the act of switching to it would hide
 * exactly what the click asked for.
 */
async function onRailRowClick(entry: RailEntry): Promise<void> {
  if (isActive(entry.scope)) {
    await toggleRail(entry)
    return
  }
  selectScope(entry.scope)
  if (!railOpen[entry.key]) await openRail(entry)
}

// ---- which file the diff pane is showing, mirrored back onto the rail ----

const currentPath = ref('')
let spyFrame = 0

/**
 * The last card whose top has passed the pane's top edge is the one being read.
 * Cards are in DOM order, so the scan stops at the first that hasn't — cheap
 * enough per frame that this needs no observer, and unlike IntersectionObserver
 * it needs no re-registration when a card expands or collapses.
 */
function updateCurrentFile(): void {
  const root = filesEl.value
  if (!root) return
  const top = root.getBoundingClientRect().top
  let current = ''
  for (const card of root.querySelectorAll<HTMLElement>('[data-path]')) {
    if (card.getBoundingClientRect().top - top > 8) break
    current = card.dataset.path ?? ''
  }
  currentPath.value = current || files.value[0]?.path || ''
}

/** preventScroll: focusing must never move the pane out from under a jump. */
function focusDiff(): void {
  filesEl.value?.focus({ preventScroll: true })
}

function onFilesScroll(): void {
  if (spyFrame) return
  spyFrame = requestAnimationFrame(() => {
    spyFrame = 0
    updateCurrentFile()
  })
}

// ---- rail width (drag the divider) ----

let railStartX = 0
let railStartWidth = 0

function onRailResize(event: MouseEvent): void {
  railWidth.value = Math.min(720, Math.max(180, railStartWidth + event.clientX - railStartX))
}

function stopRailResize(): void {
  window.removeEventListener('mousemove', onRailResize)
  window.removeEventListener('mouseup', stopRailResize)
}

function startRailResize(event: MouseEvent): void {
  event.preventDefault()
  railStartX = event.clientX
  railStartWidth = railWidth.value
  window.addEventListener('mousemove', onRailResize)
  window.addEventListener('mouseup', stopRailResize)
}

onUnmounted(() => {
  if (spyFrame) cancelAnimationFrame(spyFrame)
  stopRailResize()
})

/** Select the rail row's scope if needed, open that file, and scroll it into view. */
async function jumpToFile(entry: RailEntry, path: string): Promise<void> {
  if (!isActive(entry.scope)) {
    scope.value = entry.scope
    await loadFiles()
  }
  const state = states[path]
  if (state && !state.expanded) {
    state.expanded = true
    const file = files.value.find((candidate) => candidate.path === path)
    if (file && !state.loaded) await loadPatch(file, loadSeq)
  }
  await nextTick()
  // Picking a file in the rail hands the keyboard to the diff, so Page Up/Down
  // and the arrows carry on from where the jump landed.
  focusDiff()
  const card = filesEl.value?.querySelector(`[data-path="${CSS.escape(path)}"]`)
  // Instant, not smooth: across a large diff the animation is a long wait to
  // watch, and it drags the rail's current-file mark over every file it passes.
  card?.scrollIntoView({ block: 'start', behavior: 'auto' })
  currentPath.value = path
}

// ---- per-file controls ----

function toggleFile(file: GitFileChange): void {
  const state = states[file.path]
  if (!state) return
  state.expanded = !state.expanded
  if (state.expanded && !state.loaded) void loadPatch(file, loadSeq)
}

/** The packed/whole-file switch is per file: one file is often the only one you want whole. */
function toggleWhole(file: GitFileChange): void {
  const state = states[file.path]
  if (!state) return
  state.whole = !state.whole
  state.loaded = false
  state.expanded = true
  void loadPatch(file, loadSeq)
}

async function setAllExpanded(expanded: boolean): Promise<void> {
  const seq = loadSeq
  for (const file of files.value) {
    const state = states[file.path]
    if (!state) continue
    state.expanded = expanded && !file.binary
    if (state.expanded && !state.loaded) await loadPatch(file, seq)
    if (seq !== loadSeq) return
  }
}

// ---- base branch picker ----

/** The repo's branches, with the current base kept present even if it isn't one (a tag, a sha). */
const baseOptions = computed(() => {
  const branches = overview.value?.branches ?? []
  return branches.includes(base.value) ? branches : [base.value, ...branches]
})

function onBaseChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value
  if (next === base.value) return
  base.value = next
  void reload(true)
}

watch(
  () => props.worktree,
  () => {
    base.value = 'master'
    void reload(true)
  },
  { immediate: true }
)

watch(
  () => props.visible,
  (visible) => {
    if (visible && Date.now() - loadedAt > STALE_MS) void reload(false)
  }
)

// A fresh listing means the rail should mark the first file without waiting for
// the user to scroll.
watch(files, () => void nextTick(updateCurrentFile))

// The same signal App.vue uses to hand a terminal the keyboard (mod+1…9, a tab
// click, cycling splits) — the diff pane is what takes it for this kind of tab,
// so Page Up/Down and the arrows act on the diff rather than on whatever
// terminal happened to hold focus last.
watch(
  () => props.focusSignal,
  (signal) => {
    // Next frame: the pane may be un-hidden in this same flush.
    if (signal?.id === props.tabId) requestAnimationFrame(() => focusDiff())
  }
)

// Opening the tab fires its focus signal before this component exists, so the
// watcher above never sees that first one — a fresh tab claims the keyboard here.
onMounted(() => {
  if (props.visible) requestAnimationFrame(() => focusDiff())
})

// Coming back to the app is the moment the diff is most likely to be stale: the
// reason you left was usually to let an agent work. This is main's window focus,
// not the page's — the page's own focus events track the focused element, which
// doesn't move when the window goes to the background (see App.vue).
const stopWindowFocus = window.api.onWindowFocus((focused) => {
  if (focused && props.visible) void reload(false)
})

onUnmounted(stopWindowFocus)
</script>

<template>
  <div class="git-diff">
    <header class="gd-head">
      <span class="gd-branch" :title="worktree">{{ branch }}</span>
      <span class="gd-vs">vs</span>
      <select class="gd-base" title="Base branch to compare against" @change="onBaseChange">
        <option v-for="name in baseOptions" :key="name" :value="name" :selected="name === base">
          {{ name }}
        </option>
      </select>
      <button class="gd-icon-btn" title="Re-read the diff" @click="reload(false)">
        <Icon name="refresh" />
      </button>
    </header>

    <p v-if="failure" class="gd-error">{{ failure }}</p>
    <p v-else-if="overview?.error" class="gd-error">{{ overview.error }}</p>
    <p v-else-if="listing?.error" class="gd-error">{{ listing.error }}</p>

    <div class="gd-body">
      <ul class="gd-rail" :style="{ width: `${railWidth}px` }">
        <template v-for="(entry, index) in railEntries" :key="entry.key">
          <li v-if="entry.commit && !railEntries[index - 1]?.commit" class="gd-rail-divider"></li>
          <li class="gd-rail-item" :class="{ active: isActive(entry.scope) }">
            <div class="gd-rail-row" :title="entry.tip" @click="onRailRowClick(entry)">
              <button
                class="gd-rail-toggle"
                :title="railOpen[entry.key] ? 'Hide the file list' : 'List the files this touches'"
                @click.stop="toggleRail(entry)"
              >
                <Icon name="chevron" :class="{ open: railOpen[entry.key] }" />
              </button>
              <span class="gd-rail-text">
                <span class="gd-rail-title">{{ entry.title }}</span>
                <span class="gd-rail-sub">
                  <template v-if="entry.commit">
                    <span class="gd-sha">{{ entry.commit.shortSha }}</span>
                    <span>{{ commitDate(entry.commit.date) }}</span>
                    <span v-if="entry.commit.adds" class="gd-add">+{{ entry.commit.adds }}</span>
                    <span v-if="entry.commit.dels" class="gd-del">−{{ entry.commit.dels }}</span>
                    <span v-if="entry.commit.parents.length > 1" class="gd-merge">merge</span>
                  </template>
                  <template v-else>{{ entry.sub }}</template>
                </span>
              </span>
            </div>
            <ul v-if="railOpen[entry.key]" class="gd-rail-files">
              <!-- Only before there is a list: a re-read keeps the tree on
                   screen rather than blanking it to a spinner every refresh. -->
              <li v-if="railLoading[entry.key] && !railFiles[entry.key]" class="gd-rail-files-note">
                Reading…
              </li>
              <li v-else-if="!railFiles[entry.key]?.length" class="gd-rail-files-note">No files</li>
              <li
                v-for="row in railRows[entry.key] ?? []"
                v-else
                :key="`${row.kind}:${row.path}`"
                :class="{
                  dir: row.kind === 'dir',
                  current: row.kind === 'file' && isActive(entry.scope) && row.path === currentPath
                }"
                :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
                :title="row.path"
                @click="onRowClick(entry, row)"
              >
                <template v-if="row.kind === 'dir'">
                  <Icon
                    name="chevron"
                    class="gd-tree-caret"
                    :class="{ open: !collapsedDirs[dirKey(entry, row.path)] }"
                  />
                  <span class="gd-tree-dir">{{ row.name }}</span>
                </template>
                <template v-else>
                  <span class="gd-status" :class="row.file.status">
                    {{ STATUS_LETTER[row.file.status] }}
                  </span>
                  <span class="gd-rail-file-path">{{ row.name }}</span>
                </template>
              </li>
            </ul>
          </li>
        </template>
      </ul>

      <div
        class="gd-rail-resizer"
        title="Drag to resize"
        @mousedown="startRailResize"
        @dblclick="railWidth = 300"
      ></div>

      <div class="gd-pane">
        <div class="gd-toolbar">
          <span class="gd-count">
            {{ totals.files }} {{ totals.files === 1 ? 'file' : 'files' }}
          </span>
          <span v-if="totals.adds" class="gd-add">+{{ totals.adds }}</span>
          <span v-if="totals.dels" class="gd-del">−{{ totals.dels }}</span>
          <span class="gd-spacer"></span>
          <!-- "Show/Hide", not "Expand/Collapse": these open and close the file
               cards, while a card's own Expand button switches that file to its
               whole contents. Two different things, so two different words. -->
          <button class="gd-text-btn" title="Open every file's diff" @click="setAllExpanded(true)">
            Show all
          </button>
          <button
            class="gd-text-btn"
            title="Close every file's diff"
            @click="setAllExpanded(false)"
          >
            Hide all
          </button>
        </div>

        <!-- tabindex makes the scroll region itself focusable, which is what
             lets Page Up/Down and the arrows scroll it. -->
        <div
          ref="filesEl"
          class="gd-files"
          tabindex="0"
          aria-label="Diff"
          @scroll.passive="onFilesScroll"
        >
          <article v-if="currentCommit" class="gd-commit">
            <h2 class="gd-commit-subject">{{ currentCommit.subject }}</h2>
            <p class="gd-commit-meta">
              <span class="gd-sha" :title="currentCommit.sha">{{ currentCommit.shortSha }}</span>
              <span>{{ currentCommit.author }}</span>
              <span>{{ commitFullDate(currentCommit.date) }}</span>
              <span v-if="currentCommit.parents.length > 1" class="gd-merge">merge</span>
            </p>
            <pre v-if="commitBody" class="gd-commit-body">{{ commitBody }}</pre>
          </article>

          <div v-if="!files.length && !loading && !failure" class="gd-empty">
            <template v-if="scope.kind === 'branch' && !commits.length">
              <p v-if="branch === base">
                <strong>{{ branch }}</strong> is the base — there is nothing to compare it against.
                Pick another base above, or select a workstream in the sidebar.
              </p>
              <p v-else>
                <strong>{{ branch }}</strong> has no commits over <strong>{{ base }}</strong> yet.
              </p>
            </template>
            <p v-else>No file changes in {{ scopeLabel }}.</p>
            <button
              v-if="overview?.workingCount && scope.kind !== 'working'"
              class="gd-empty-action"
              @click="selectScope({ kind: 'working' })"
            >
              Review {{ overview.workingCount }} uncommitted
              {{ overview.workingCount === 1 ? 'file' : 'files' }}
            </button>
          </div>

          <section v-for="file in files" :key="file.path" class="gd-file" :data-path="file.path">
            <header class="gd-file-head" @click="toggleFile(file)">
              <Icon
                name="chevron"
                class="gd-chevron"
                :class="{ open: states[file.path]?.expanded }"
              />
              <span class="gd-status" :class="file.status" :title="file.status">
                {{ STATUS_LETTER[file.status] }}
              </span>
              <span
                class="gd-path"
                :title="file.oldPath ? `${file.oldPath} → ${file.path}` : file.path"
              >
                <span v-if="file.oldPath" class="gd-oldpath">{{ file.oldPath }} →</span>
                <span class="gd-dir">{{ dirOf(file.path) }}</span>
                <span class="gd-name">{{ nameOf(file.path) }}</span>
              </span>
              <span v-if="file.binary" class="gd-binary">Binary</span>
              <template v-else>
                <span v-if="file.adds" class="gd-add">+{{ file.adds }}</span>
                <span v-if="file.dels" class="gd-del">−{{ file.dels }}</span>
                <button
                  class="gd-file-btn"
                  :class="{ on: states[file.path]?.whole }"
                  :title="
                    states[file.path]?.whole
                      ? 'Back to just the changed hunks and their context'
                      : 'Show every line of this file, not only the changed hunks'
                  "
                  @click.stop="toggleWhole(file)"
                >
                  {{ states[file.path]?.whole ? 'Collapse' : 'Expand' }}
                </button>
              </template>
            </header>

            <div v-if="states[file.path]?.expanded" class="gd-file-body">
              <!-- Only before there is anything to show: a re-read keeps the
                   rows it already has until the new ones replace them. -->
              <p v-if="states[file.path]?.loading && !states[file.path]?.loaded" class="gd-note">
                Reading diff…
              </p>
              <p v-else-if="states[file.path]?.error" class="gd-note error">
                {{ states[file.path]?.error }}
              </p>
              <p v-else-if="states[file.path]?.binary" class="gd-note">
                Binary file — no textual diff.
              </p>
              <p v-else-if="!states[file.path]?.hunks.length" class="gd-note">
                No textual change (mode or metadata only).
              </p>
              <template v-else>
                <div v-for="(hunk, hi) in states[file.path]?.hunks" :key="hi" class="gd-hunk">
                  <div class="gd-hunk-head">
                    <span class="gd-hunk-range">
                      @@ -{{ hunk.oldStart }} +{{ hunk.newStart }} @@
                    </span>
                    <span v-if="hunk.heading" class="gd-hunk-scope">{{ hunk.heading }}</span>
                  </div>
                  <div
                    v-for="(line, li) in hunk.lines"
                    :key="li"
                    class="gd-line"
                    :class="line.type"
                  >
                    <span class="gd-no">{{ line.oldNo ?? '' }}</span>
                    <span class="gd-no">{{ line.newNo ?? '' }}</span>
                    <span class="gd-sign">{{
                      line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '
                    }}</span>
                    <span class="gd-code"
                      ><template v-for="(token, ti) in line.tokens" :key="ti"
                        ><span v-if="token.type !== 'plain'" :class="`tok-${token.type}`">{{
                          token.text
                        }}</span
                        ><template v-else>{{ token.text }}</template></template
                      ></span
                    >
                  </div>
                </div>
                <p v-if="states[file.path]?.truncated" class="gd-note">
                  Showing the first {{ MAX_RENDERED_LINES }} lines —
                  {{ states[file.path]?.truncated }} more are past the render cap.
                </p>
              </template>
            </div>
          </section>

          <p v-if="listing?.untrackedTruncated" class="gd-note">
            Untracked listing capped — {{ listing.untrackedTruncated }} more files are not shown.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-diff {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  --add: var(--status-working);
  --del: var(--danger);
  /* Row tint strength. Measured against the syntax palette in main.css — raising
     it without re-measuring pushes comments and the gutter below AA. */
  --tint: 20%;
}

.gd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 12px;
}

.gd-branch {
  color: var(--text);
  font-weight: 600;
}

.gd-vs {
  color: var(--dim);
  font-size: 11px;
}

/* The popup itself is drawn by the OS; `color-scheme: dark` on :root is what
   keeps it from opening as a white sheet over a dark app. */
.gd-base {
  max-width: 220px;
  background: var(--sidebar);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px 2px 6px;
  color: var(--text);
  font-family: monospace;
  font-size: 11px;
}

.gd-base:hover {
  border-color: var(--accent);
}

.gd-base:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.gd-icon-btn {
  margin-left: auto;
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  border-radius: 3px;
}

.gd-icon-btn:hover {
  background: var(--hover);
  color: var(--accent);
}

.gd-icon-btn svg {
  width: 12px;
  height: 12px;
}

.gd-error {
  padding: 6px 12px;
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.gd-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ---- scope rail ---- */

/* Width is set inline by the drag handle; this is only the floor and the
   no-shrink, so a long path widens the rail instead of squeezing it. */
.gd-rail {
  list-style: none;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 6px;
}

.gd-rail-resizer {
  flex-shrink: 0;
  width: 5px;
  margin-right: -2px;
  cursor: col-resize;
  background: var(--border);
  background-clip: content-box;
  border-inline: 2px solid transparent;
  z-index: 2;
}

.gd-rail-resizer:hover {
  background: var(--accent);
  background-clip: content-box;
}

.gd-rail-item {
  border-radius: 5px;
}

.gd-rail-item.active {
  background: var(--hover);
  outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
}

.gd-rail-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px 6px 2px;
  border-radius: 5px;
  cursor: pointer;
}

.gd-rail-item:not(.active) .gd-rail-row:hover {
  background: var(--hover);
}

.gd-rail-toggle {
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 0;
  width: 16px;
  height: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  border-radius: 3px;
}

.gd-rail-toggle:hover {
  color: var(--accent);
}

.gd-rail-toggle svg {
  width: 10px;
  height: 10px;
  transition: transform 120ms ease;
}

.gd-rail-toggle svg.open {
  transform: rotate(90deg);
}

.gd-rail-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.gd-rail-divider {
  height: 1px;
  margin: 6px 8px;
  background: var(--border);
}

.gd-rail-title {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-rail-sub {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.gd-rail-files {
  list-style: none;
  padding: 2px 4px 8px;
}

/* padding-left is set inline from the row's tree depth. */
.gd-rail-files li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.gd-tree-caret {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  color: var(--dim);
  transition: transform 120ms ease;
}

.gd-tree-caret.open {
  transform: rotate(90deg);
}

.gd-tree-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-family: monospace;
}

/* The row this list sits under is itself --hover when selected, so a plain
   --hover here would vanish exactly where it is most used. The accent tint
   reads on both. */
.gd-rail-files li:hover {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}

/* The file currently under the top of the diff pane — a quieter mark than
   hover, since it moves on its own as you scroll rather than tracking a click. */
.gd-rail-files li.current {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}

.gd-rail-files li:hover .gd-rail-file-path,
.gd-rail-files li.current .gd-rail-file-path {
  color: var(--text);
}

.gd-rail-files-note {
  color: var(--dim);
  cursor: default;
}

.gd-rail-files-note:hover {
  background: transparent;
}

/* A leaf carries only its own name now that the tree shows the folders, so this
   ellipsizes at the end like ordinary text; the row's title has the full path. */
.gd-rail-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dim);
  font-family: monospace;
}

.gd-sha {
  font-family: monospace;
  color: var(--accent);
}

.gd-merge {
  color: var(--status-waiting);
}

.gd-add {
  color: var(--add);
  font-variant-numeric: tabular-nums;
}

.gd-del {
  color: var(--del);
  font-variant-numeric: tabular-nums;
}

/* ---- diff pane ---- */

.gd-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 11px;
  color: var(--dim);
}

.gd-spacer {
  flex: 1;
}

.gd-text-btn {
  background: transparent;
  border: none;
  color: var(--dim);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.gd-text-btn:hover {
  background: var(--hover);
  color: var(--text);
}

.gd-text-btn.on {
  color: var(--accent);
}

/* The per-file whole-contents switch. Bordered rather than bare, because it sits
   inside a row that is itself a click target — the frame is what says this bit
   does something of its own. */
.gd-file-btn {
  flex-shrink: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--dim);
  padding: 2px 9px;
  font-size: 11px;
}

.gd-file-btn:hover {
  background: var(--hover);
  border-color: var(--accent);
  color: var(--text);
}

.gd-file-btn.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}

/* Scroll-past-end. Not decoration: it lets the *last* file's header reach the
   top of the pane, which is what makes both the jump-to-file scroll land where
   it says and the rail's current-file mark reachable for every file. */
.gd-files {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 50vh;
}

/* Focused by a click or a tab switch, the pane shouldn't draw a ring; reached by
   keyboard it should, since otherwise there is nothing to say where the keys go. */
.gd-files:focus {
  outline: none;
}

.gd-files:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: -1px;
}

/* The commit's own message, above its files. Scrolls with them rather than
   pinning: it is context for the read, not a control. */
.gd-commit {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--sidebar);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.gd-commit-subject {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
}

.gd-commit-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--dim);
}

/* pre, so the wrapping and blank lines the author chose survive; user-select
   because a trailer or an issue number is worth copying out. */
.gd-commit-body {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
  font-family: monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--code-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.gd-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
  padding: 40px 24px;
  text-align: center;
}

.gd-empty p {
  max-width: 420px;
}

.gd-empty strong {
  color: var(--text);
  font-weight: 600;
}

.gd-empty-action {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--accent);
  padding: 4px 12px;
  font-size: 12px;
}

.gd-empty-action:hover {
  background: var(--hover);
  border-color: var(--accent);
}

.gd-file {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 10px;
  overflow: hidden;
  /* So a jumped-to card lands below the sticky toolbar, not under it. */
  scroll-margin-top: 6px;
}

.gd-file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--sidebar);
  cursor: pointer;
  font-size: 12px;
}

.gd-file-head:hover {
  background: var(--hover);
}

.gd-chevron {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  color: var(--dim);
  transition: transform 120ms ease;
}

.gd-chevron.open {
  transform: rotate(90deg);
}

.gd-status {
  width: 14px;
  text-align: center;
  flex-shrink: 0;
  font-family: monospace;
  font-size: 11px;
  color: var(--dim);
}

.gd-status.added,
.gd-status.untracked {
  color: var(--add);
}

.gd-status.deleted {
  color: var(--del);
}

.gd-status.renamed,
.gd-status.copied {
  color: var(--accent);
}

.gd-path {
  flex: 1;
  min-width: 0;
  display: flex;
  font-family: monospace;
  white-space: nowrap;
  color: var(--text);
}

/* The directory is the part that gives way; the file name always stays legible. */
.gd-oldpath,
.gd-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dim);
}

.gd-oldpath {
  flex-shrink: 2;
  padding-right: 5px;
}

.gd-name {
  flex-shrink: 0;
}

.gd-binary {
  color: var(--dim);
  font-size: 11px;
}

.gd-file-body {
  background: var(--code-bg);
  overflow-x: auto;
  border-top: 1px solid var(--border);
}

.gd-note {
  padding: 8px 12px;
  color: var(--code-gutter);
  font-size: 11px;
}

.gd-note.error {
  color: var(--danger);
}

.gd-hunk-head {
  display: flex;
  gap: 10px;
  padding: 3px 10px;
  background: var(--sidebar);
  border-top: 1px solid var(--border);
  font-family: monospace;
  font-size: 11px;
  color: var(--code-gutter);
  position: sticky;
  left: 0;
}

.gd-hunk:first-child .gd-hunk-head {
  border-top: none;
}

.gd-hunk-scope {
  color: var(--accent);
  opacity: 0.7;
}

/* max-content keeps the row box as wide as its longest line, so a tinted
   add/del row stays tinted across the whole horizontal scroll rather than
   stopping at the viewport edge. */
.gd-line {
  display: flex;
  min-width: max-content;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  color: var(--code-text);
}

.gd-line.add {
  background: color-mix(in srgb, var(--add) var(--tint), transparent);
}

.gd-line.del {
  background: color-mix(in srgb, var(--del) var(--tint), transparent);
}

.gd-line.meta {
  color: var(--syntax-comment);
  font-style: italic;
}

/* The gutters stay put while the code scrolls under them, so they need opaque
   backgrounds that match what the row's own tint composites to. */
.gd-no {
  flex-shrink: 0;
  width: 48px;
  padding-right: 8px;
  text-align: right;
  color: var(--code-gutter);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  user-select: none;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--code-bg);
}

.gd-no + .gd-no {
  left: 48px;
}

.gd-line.add .gd-no {
  background: color-mix(in srgb, var(--add) var(--tint), var(--code-bg));
}

.gd-line.del .gd-no {
  background: color-mix(in srgb, var(--del) var(--tint), var(--code-bg));
}

/* A full-strength edge on the sticky gutter. A whole-row tint has to stay faint
   to keep the code on it readable, so the unambiguous "this row changed" cue is
   this bar — and it rides the sticky column, staying visible when the code is
   scrolled sideways. */
.gd-line.add > .gd-no:first-child {
  box-shadow: inset 2px 0 0 var(--add);
}

.gd-line.del > .gd-no:first-child {
  box-shadow: inset 2px 0 0 var(--del);
}

.gd-sign {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  user-select: none;
  color: var(--code-gutter);
}

/* Lifted toward the code text rather than left at full --add/--del: those are
   chosen to read on the app background, and on their own tinted row the delete
   red lands at 4.37:1 — just under AA for a 12px glyph. */
.gd-line.add .gd-sign {
  color: color-mix(in srgb, var(--add) 80%, var(--code-text));
  font-weight: 700;
}

.gd-line.del .gd-sign {
  color: color-mix(in srgb, var(--del) 80%, var(--code-text));
  font-weight: 700;
}

.gd-code {
  padding-right: 16px;
  user-select: text;
  tab-size: 2;
}

.tok-comment {
  color: var(--syntax-comment);
  font-style: italic;
}

.tok-string {
  color: var(--syntax-string);
}

.tok-keyword {
  color: var(--syntax-keyword);
}

.tok-number {
  color: var(--syntax-number);
}

.tok-type {
  color: var(--syntax-type);
}

@media (prefers-reduced-motion: reduce) {
  .gd-chevron,
  .gd-tree-caret,
  .gd-rail-toggle svg {
    transition: none;
  }
}
</style>
