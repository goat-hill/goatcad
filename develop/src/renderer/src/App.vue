<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import BrandMark from './components/BrandMark.vue'
import GitDiffView from './components/GitDiffView.vue'
import Icon from './components/Icon.vue'
import TerminalPane from './components/TerminalPane.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { HOTKEY_HINTS, matchHotkey, matchTerminalClipboard } from './hotkeys'
import { runClipboardCommand } from './terminalClipboard'
import { DEFAULT_FONT_SIZE, fontSize, zoomIn, zoomOut, zoomReset } from './terminalFont'

// A tab is a terminal session (a pty) or one of the read-only views, which own
// no process and so are skipped everywhere a tab is treated as a session.
const VIEW_KINDS = ['workspace', 'diff'] as const
type ViewKind = (typeof VIEW_KINDS)[number]
type TabKind = PtyKind | ViewKind

function isView(tab: Tab): boolean {
  return (VIEW_KINDS as readonly string[]).includes(tab.kind)
}

interface Tab {
  id: string
  kind: TabKind
  worktree: string
  port?: number
  exitCode?: number
}

// An editor group / split: an ordered strip of tabs with one active. Groups sit
// side by side (or stacked) in `groups` order, left/top to right/bottom.
interface Group {
  id: string
  tabIds: string[]
  activeTabId: string
}

const KINDS: { kind: TabKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'shell', label: 'Terminal' },
  { kind: 'app', label: 'GoatCAD' },
  { kind: 'web', label: 'Web' },
  { kind: 'goatherd', label: 'GoatHerd' },
  { kind: 'setup', label: 'npm install' },
  { kind: 'workspace', label: 'Workspace' },
  { kind: 'diff', label: 'Git Diff' }
]

const worktrees = ref<Worktree[]>([])
const tabs = ref<Tab[]>([])
const groups = ref<Group[]>([])
const activeGroupId = ref('')
// Sidebar selection: drives the action row and highlight only — it never touches
// the splits (opening a session or focusing a tab is what changes those).
const selectedPath = ref('')
const splitDirection = ref<'row' | 'column'>('row')
const groupSizes = reactive<Record<string, number>>({})
const terminalsContainer = ref<HTMLDivElement | null>(null)
const statuses = reactive<Record<string, ClaudeStatusEvent>>({})
const newBranch = ref('')
const busy = ref(false)
const error = ref('')
const instanceBranch = ref('')
const quota = ref<QuotaStatus | null>(null)
// Outcome of the most recent fetch attempt, kept separate from the last good data.
const quotaSync = ref<{ at: number; error?: string } | null>(null)
// Ticks so "Xm ago" stays current between quota polls.
const now = ref(Date.now())
const sessionProcesses = reactive<Record<string, string>>({})

let groupCounter = 0
const newGroupId = (): string => `group-${++groupCounter}`

function tabById(id: string): Tab | undefined {
  return tabs.value.find((t) => t.id === id)
}
function groupOfTab(id: string): Group | undefined {
  return groups.value.find((g) => g.tabIds.includes(id))
}
function groupTabs(group: Group): Tab[] {
  return group.tabIds.map((id) => tabById(id)).filter((t): t is Tab => !!t)
}
const activeGroup = computed(() => groups.value.find((g) => g.id === activeGroupId.value))

// All tabs flattened in split order, so mod+1…9 numbering is sequential across
// every split rather than per-group.
const orderedTabs = computed<Tab[]>(() =>
  groups.value.flatMap((g) => g.tabIds.map((id) => tabById(id)).filter((t): t is Tab => !!t))
)
const tabNumbers = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  orderedTabs.value.forEach((t, i) => (map[t.id] = i))
  return map
})

async function updateSessionProcesses(): Promise<void> {
  for (const tab of tabs.value) {
    if (isView(tab)) continue
    if (tab.exitCode === undefined) {
      try {
        const proc = await window.api.getPtyProcess(tab.id)
        if (proc) sessionProcesses[tab.id] = proc
        else delete sessionProcesses[tab.id]
      } catch {
        delete sessionProcesses[tab.id]
      }
    } else {
      delete sessionProcesses[tab.id]
    }
  }
}

const selected = computed(() => worktrees.value.find((wt) => wt.path === selectedPath.value))
// Master is the stable instance; only dev instances need calling out in the title bar.
const titleBranch = computed(() =>
  instanceBranch.value && instanceBranch.value !== 'master' ? instanceBranch.value : ''
)

function runningSession(worktree: string, kind: PtyKind): Tab | undefined {
  return tabs.value.find(
    (t) => t.worktree === worktree && t.kind === kind && t.exitCode === undefined
  )
}

function statusFor(worktree: Worktree): ClaudeStatus | 'none' {
  const claude = runningSession(worktree.path, 'claude')
  if (!claude) return 'none'
  // A session that has not reported yet is at its prompt (SessionStart says so
  // within a moment); "working" was a guess that read as always-on.
  return statuses[worktree.path]?.status ?? 'idle'
}

function tabLabel(tab: Tab): string {
  const label = KINDS.find((k) => k.kind === tab.kind)?.label ?? tab.kind
  if (isView(tab)) return label
  let base = tab.exitCode === undefined ? label : `${label} (exited)`
  if (tab.kind === 'shell') {
    const worktreeShells = tabs.value.filter(
      (t) => t.worktree === tab.worktree && t.kind === 'shell'
    )
    if (worktreeShells.length > 1) {
      const idx = worktreeShells.indexOf(tab)
      if (idx !== -1)
        base = tab.exitCode === undefined ? `${label} ${idx + 1}` : `${label} ${idx + 1} (exited)`
    }
    if (tab.exitCode === undefined) {
      const proc = sessionProcesses[tab.id]
      if (proc) return `${base} [${proc}]`
    }
  }
  return base
}

function branchFor(path: string): string {
  return worktrees.value.find((wt) => wt.path === path)?.branch ?? path
}

// What a workstream is called in the UI: its given name, or the branch it runs on.
function displayName(worktree: Worktree): string {
  return worktree.name || worktree.branch
}

function displayNameFor(path: string): string {
  const worktree = worktrees.value.find((wt) => wt.path === path)
  return worktree ? displayName(worktree) : path
}

// Tabs show the workstream's name; the branch behind it only surfaces in the tooltip.
function tabTitle(tab: Tab): string {
  const name = displayNameFor(tab.worktree)
  const branch = branchFor(tab.worktree)
  const who = name === branch ? name : `${name} (${branch})`
  return `${who} / ${tabLabel(tab)}`
}

async function refresh(): Promise<void> {
  worktrees.value = await window.api.listWorktrees()
  const first = worktrees.value[0]
  if (first && !worktrees.value.some((wt) => wt.path === selectedPath.value)) {
    selectedPath.value = first.path
  }
}

// ---- groups & tabs ----

function ensureActiveGroup(): Group {
  // Prefer the active split, fall back to any existing one, only then create the
  // first — so a stale activeGroupId never spawns a stray empty split.
  let group = activeGroup.value ?? groups.value[groups.value.length - 1]
  if (!group) {
    group = { id: newGroupId(), tabIds: [], activeTabId: '' }
    groups.value.push(group)
  }
  activeGroupId.value = group.id
  return group
}

// New tabs open in the active split, VS Code style. `background: true` adds the
// tab without activating it, so booting a dev server doesn't yank focus away
// from whatever is in the foreground (typically a Claude session). It only
// applies when the split already has a tab — an empty split has to show
// something, so the new tab becomes active there regardless.
function addTab(tab: Tab, opts: { background?: boolean } = {}): void {
  tabs.value.push(tab)
  const group = ensureActiveGroup()
  group.tabIds.push(tab.id)
  if (opts.background && group.tabIds.length > 1) {
    void nextTick(() => revealTab(tab.id))
    return
  }
  group.activeTabId = tab.id
  activeGroupId.value = group.id
  focusPane(tab.id)
}

function focusTab(id: string): void {
  const group = groupOfTab(id)
  if (!group) return
  group.activeTabId = id
  activeGroupId.value = group.id
  const tab = tabById(id)
  if (tab) selectedPath.value = tab.worktree
  focusPane(id)
  void nextTick(() => revealTab(id))
}

function onTabClick(tab: Tab): void {
  focusTab(tab.id)
}

// Focusing a split (clicking into its terminal, cycling to it) makes the sidebar
// follow — its highlight and action row match the tab you're working in.
function onGroupFocus(group: Group): void {
  activeGroupId.value = group.id
  const tab = tabById(group.activeTabId)
  if (tab) selectedPath.value = tab.worktree
}

function removeGroup(id: string): void {
  const idx = groups.value.findIndex((g) => g.id === id)
  if (idx === -1) return
  groups.value.splice(idx, 1)
  delete groupSizes[id]
  if (activeGroupId.value === id) {
    const next = groups.value[Math.min(idx, groups.value.length - 1)]
    activeGroupId.value = next?.id ?? ''
    if (next) focusPane(next.activeTabId)
  }
}

function removeTab(id: string): void {
  const group = groupOfTab(id)
  tabs.value = tabs.value.filter((t) => t.id !== id)
  delete sessionProcesses[id]
  if (!group) return
  const pos = group.tabIds.indexOf(id)
  group.tabIds.splice(pos, 1)
  if (group.tabIds.length === 0) {
    // Closing the last tab in a split closes the split.
    removeGroup(group.id)
  } else if (group.activeTabId === id) {
    group.activeTabId = group.tabIds[Math.min(pos, group.tabIds.length - 1)]
    if (activeGroupId.value === group.id) focusPane(group.activeTabId)
  }
}

async function closeTab(tab: Tab): Promise<void> {
  if (tab.kind === 'shell' && tab.exitCode === undefined) {
    const proc = sessionProcesses[tab.id]
    if (
      proc &&
      !window.confirm(`Session is running "${proc}". Are you sure you want to close it?`)
    ) {
      return
    }
  }
  if (!isView(tab)) await window.api.disposePty(tab.id)
  removeTab(tab.id)
}

// Split: move the active tab into a new group to the right (needs a second tab
// to leave behind — splitting a lone tab would just recreate the same split).
function splitGroup(group: Group): void {
  const id = group.activeTabId
  if (!id || group.tabIds.length < 2) return
  const idx = groups.value.indexOf(group)
  const newGroup: Group = { id: newGroupId(), tabIds: [], activeTabId: '' }
  groups.value.splice(idx + 1, 0, newGroup)
  moveTab(id, newGroup)
}

// The one mutation for drag-between-splits and split creation.
function moveTab(id: string, targetGroup: Group, beforeTabId?: string): void {
  const source = groupOfTab(id)
  if (!source) return
  const wasActive = source.activeTabId === id
  const pos = source.tabIds.indexOf(id)
  source.tabIds.splice(pos, 1)

  let insertAt = targetGroup.tabIds.length
  if (beforeTabId) {
    const bi = targetGroup.tabIds.indexOf(beforeTabId)
    if (bi !== -1) insertAt = bi
  }
  targetGroup.tabIds.splice(insertAt, 0, id)
  targetGroup.activeTabId = id
  activeGroupId.value = targetGroup.id

  if (source !== targetGroup) {
    if (source.tabIds.length === 0) removeGroup(source.id)
    else if (wasActive) source.activeTabId = source.tabIds[Math.min(pos, source.tabIds.length - 1)]
  }
  focusPane(id)
  void nextTick(() => revealTab(id))
}

// ---- sessions ----

// Dev servers you start and leave running: they open in the background rather
// than stealing the foreground from an active Claude/terminal session.
const BACKGROUND_KINDS: PtyKind[] = ['app', 'web', 'goatherd']

async function startSession(kind: PtyKind): Promise<void> {
  const worktree = selected.value
  if (!worktree) return
  // One instance per worktree for everything except plain terminals.
  if (kind !== 'shell') {
    const existing = runningSession(worktree.path, kind)
    if (existing) {
      focusTab(existing.id)
      return
    }
  }
  error.value = ''
  try {
    const result = await window.api.startPty({
      worktree: worktree.path,
      branch: worktree.branch,
      kind
    })
    addTab(
      { id: result.id, kind, worktree: worktree.path, port: result.port },
      { background: BACKGROUND_KINDS.includes(kind) }
    )
  } catch (err) {
    error.value = String(err)
  }
}

// The read-only views open as a tab (one per worktree); reopening just focuses it.
function openView(kind: ViewKind): void {
  const worktree = selected.value
  if (!worktree) return
  const id = `${kind}:${worktree.path}`
  if (tabById(id)) {
    focusTab(id)
    return
  }
  addTab({ id, kind, worktree: worktree.path })
}

// Sidebar selection changes nothing in the splits — only what the action row acts on.
function openWorktree(worktree: Worktree): void {
  selectedPath.value = worktree.path
}

// ---- renaming a workstream (double-click its sidebar row) ----

// Master is the repo itself, not a workstream, so it keeps its branch name.
const renamingPath = ref('')
const renameDraft = ref('')

function startRename(worktree: Worktree): void {
  if (worktree.isMain) return
  renamingPath.value = worktree.path
  renameDraft.value = displayName(worktree)
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rename-input')
    input?.focus()
    input?.select()
  })
}

function cancelRename(): void {
  renamingPath.value = ''
}

// Blur commits too, so clicking away saves rather than silently discarding; the
// early return is what makes Escape-then-blur a cancel.
async function commitRename(): Promise<void> {
  const path = renamingPath.value
  if (!path) return
  renamingPath.value = ''
  const worktree = worktrees.value.find((wt) => wt.path === path)
  const name = renameDraft.value.trim()
  // An emptied field clears the name; typing the branch back does the same.
  const next = name === worktree?.branch ? '' : name
  if (!worktree || (worktree.name ?? '') === next) return
  try {
    await window.api.renameWorktree(path, next)
    await refresh()
  } catch (err) {
    error.value = String(err)
  }
}

// ---- drag & drop between splits ----

function onDragStart(event: DragEvent, id: string): void {
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', id)
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onDropOnTab(event: DragEvent, group: Group, beforeTabId: string): void {
  const id = event.dataTransfer?.getData('text/plain')
  if (!id || id === beforeTabId) return
  moveTab(id, group, beforeTabId)
}

function onDropOnGroup(event: DragEvent, group: Group): void {
  const id = event.dataTransfer?.getData('text/plain')
  if (!id) return
  moveTab(id, group)
}

// ---- split resizing ----

let activeResizerIndex = -1
let startX = 0
let startY = 0
let initialSizes: number[] = []

function groupFlex(group: Group): Record<string, string> {
  const pct = groupSizes[group.id] ?? 100 / groups.value.length
  return { flex: `0 0 ${pct}%` }
}

// A split's focus ring takes the workstream color of whatever it's showing, so
// the cue says which split has focus and which workstream is in it at once.
function groupColor(group: Group): string {
  const active = group.activeTabId ? tabById(group.activeTabId) : undefined
  return getWorktreeColor(active?.worktree ?? '')
}

function startResize(event: MouseEvent, groupId: string): void {
  event.preventDefault()
  const idx = groups.value.findIndex((g) => g.id === groupId)
  if (idx <= 0) return
  activeResizerIndex = idx - 1
  startX = event.clientX
  startY = event.clientY

  const container = terminalsContainer.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  const totalSize = splitDirection.value === 'row' ? rect.width : rect.height

  initialSizes = groups.value.map((g) => {
    const pane = container.querySelector(`.pane[data-group-id="${g.id}"]`)
    if (!pane) return 0
    const pRect = pane.getBoundingClientRect()
    const size = splitDirection.value === 'row' ? pRect.width : pRect.height
    return (size / totalSize) * 100
  })

  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', stopResize)
}

function onResize(event: MouseEvent): void {
  if (activeResizerIndex === -1) return
  const container = terminalsContainer.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  const totalSize = splitDirection.value === 'row' ? rect.width : rect.height
  const delta = splitDirection.value === 'row' ? event.clientX - startX : event.clientY - startY
  const deltaPercent = (delta / totalSize) * 100

  const leftIdx = activeResizerIndex
  const rightIdx = activeResizerIndex + 1
  const leftSize = initialSizes[leftIdx] + deltaPercent
  const rightSize = initialSizes[rightIdx] - deltaPercent
  if (leftSize > 10 && rightSize > 10) {
    const left = groups.value[leftIdx]
    const right = groups.value[rightIdx]
    if (left && right) {
      groupSizes[left.id] = leftSize
      groupSizes[right.id] = rightSize
    }
  }
}

function stopResize(): void {
  activeResizerIndex = -1
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', stopResize)
}

// ---- tab strip helpers ----

// Overflowing tab strips scroll horizontally on a vertical wheel.
function onTabWheel(event: WheelEvent): void {
  const el = event.currentTarget as HTMLElement
  if (event.deltaY !== 0) el.scrollLeft += event.deltaY
}

function revealTab(id: string): void {
  const el = terminalsContainer.value?.querySelector(`.tab[data-tab-id="${id}"]`)
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

const WORKSTREAM_COLORS = [
  '#cca250', // Gold (default accent)
  '#e06c75', // Soft Red
  '#98c379', // Soft Green
  '#61afef', // Soft Blue
  '#d19a66', // Orange
  '#c678dd', // Purple
  '#56b6c2', // Cyan
  '#e5c07b', // Yellow
  '#ff80ab', // Pink
  '#b388ff' // Light Purple
]

// Assign colors by the worktree's position in the sidebar list rather than by
// hashing its path: hashing collides freely (two workstreams can share a color
// even with only a handful open), whereas indexing gives every workstream a
// distinct color until the list exceeds WORKSTREAM_COLORS.length, then wraps.
// The first worktree lands on the gold default accent (index 0).
function getWorktreeColor(worktreePath: string): string {
  if (!worktreePath) return WORKSTREAM_COLORS[0]
  const index = worktrees.value.findIndex((wt) => wt.path === worktreePath)
  if (index === -1) return WORKSTREAM_COLORS[0]
  return WORKSTREAM_COLORS[index % WORKSTREAM_COLORS.length]
}

// Bumping the signal tells the matching TerminalPane to grab keyboard focus.
const focusSignal = ref<{ id: string; seq: number }>({ id: '', seq: 0 })

function focusPane(id: string): void {
  focusSignal.value = { id, seq: focusSignal.value.seq + 1 }
}

// mod+` cycles focus across the visible splits.
function cyclePanes(): void {
  if (!groups.value.length) return
  const idx = groups.value.findIndex((g) => g.id === activeGroupId.value)
  const next = groups.value[(idx + 1) % groups.value.length]
  activeGroupId.value = next.id
  const tab = tabById(next.activeTabId)
  if (tab) selectedPath.value = tab.worktree
  focusPane(next.activeTabId)
}

const newBranchInput = ref<HTMLInputElement>()

// ---- workstream finder (mod+shift+F palette) ----

const finderOpen = ref(false)
const finderQuery = ref('')
const finderIndex = ref(0)
const finderInput = ref<HTMLInputElement>()

// 0 = prefix, 1 = substring, 2 = subsequence ("ghu" hits "goatherd-updates"), -1 = no match.
function fuzzyRank(branch: string, query: string): number {
  const b = branch.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0
  if (b.startsWith(q)) return 0
  if (b.includes(q)) return 1
  let matched = 0
  for (const ch of b) if (ch === q[matched]) matched++
  return matched >= q.length ? 2 : -1
}

// A renamed workstream stays findable by either its name or its branch.
function bestRank(worktree: Worktree, query: string): number {
  const ranks = [fuzzyRank(displayName(worktree), query), fuzzyRank(worktree.branch, query)].filter(
    (rank) => rank >= 0
  )
  return ranks.length ? Math.min(...ranks) : -1
}

const finderMatches = computed(() =>
  worktrees.value
    .map((wt) => ({ wt, rank: bestRank(wt, finderQuery.value) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.wt)
)

watch(finderQuery, () => {
  finderIndex.value = 0
})

function openFinder(): void {
  finderOpen.value = true
  finderQuery.value = ''
  finderIndex.value = 0
  void nextTick(() => finderInput.value?.focus())
}

function pickWorktree(worktree: Worktree): void {
  finderOpen.value = false
  openWorktree(worktree)
}

function onFinderKey(event: KeyboardEvent): void {
  const count = finderMatches.value.length
  if (event.key === 'Escape') {
    finderOpen.value = false
  } else if (event.key === 'ArrowDown' && count) {
    event.preventDefault()
    finderIndex.value = (finderIndex.value + 1) % count
  } else if (event.key === 'ArrowUp' && count) {
    event.preventDefault()
    finderIndex.value = (finderIndex.value + count - 1) % count
  } else if (event.key === 'Enter') {
    const worktree = finderMatches.value[finderIndex.value]
    if (worktree) pickWorktree(worktree)
  }
}

function onHotkey(event: KeyboardEvent): void {
  // Clipboard first, and at the window rather than inside xterm: the same chords
  // serve the app's own text fields, and stopping the event here is what keeps
  // Ctrl+Shift+V from also reaching Chromium's paste-as-plain-text and pasting
  // twice. It never overlaps the app hotkeys below (hotkeys.ts).
  const clipboard = matchTerminalClipboard(event, isMac)
  if (clipboard) {
    event.preventDefault()
    event.stopPropagation()
    void runClipboardCommand(clipboard)
    return
  }
  const match = matchHotkey(event)
  if (!match) return
  event.preventDefault()
  event.stopPropagation()
  switch (match.id) {
    case 'tab': {
      const index = match.index ?? -1
      const list = orderedTabs.value
      const target = index === 8 ? list[list.length - 1] : list[index]
      if (target) focusTab(target.id)
      break
    }
    case 'findWorktree':
      openFinder()
      break
    case 'claude':
      void startSession('claude')
      break
    case 'split':
      if (activeGroup.value) splitGroup(activeGroup.value)
      break
    case 'cyclePanes':
      cyclePanes()
      break
    case 'appDev':
      void startSession('app')
      break
    case 'webDev':
      void startSession('web')
      break
    case 'terminal':
      void startSession('shell')
      break
    case 'vscode':
      openInVSCode()
      break
    case 'workspace':
      openView('workspace')
      break
    case 'gitDiff':
      openView('diff')
      break
    case 'newBranch':
      newBranchInput.value?.focus()
      break
    case 'closeTab': {
      const tab = activeGroup.value ? tabById(activeGroup.value.activeTabId) : undefined
      if (tab) void closeTab(tab)
      break
    }
    case 'toggleSplit':
      splitDirection.value = splitDirection.value === 'row' ? 'column' : 'row'
      break
  }
}

async function addWorktree(): Promise<void> {
  const branch = newBranch.value.trim()
  if (!branch || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const path = await window.api.addWorktree(branch)
    newBranch.value = ''
    await refresh()
    selectedPath.value = path
    // A fresh worktree has no node_modules; start the install right away.
    await startSession('setup')
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = false
  }
}

async function removeSelectedWorktree(): Promise<void> {
  const worktree = selected.value
  if (!worktree || worktree.isMain) return
  if (!window.confirm(`Remove worktree ${worktree.branch}?\n${worktree.path}`)) return
  error.value = ''
  for (const tab of tabs.value.filter((t) => t.worktree === worktree.path)) {
    await closeTab(tab)
  }
  try {
    await window.api.removeWorktree(worktree.path)
    await refresh()
  } catch (err) {
    error.value = String(err)
  }
}

function openWebPreview(tab: Tab): void {
  if (tab.port) void window.api.openExternal(`http://127.0.0.1:${tab.port}/`)
}

function openInVSCode(): void {
  if (selected.value) void window.api.openInVSCode(selected.value.path)
}

// ---- View menu (discoverable zoom controls) ----

/**
 * macOS draws the menu in the system bar and the window controls as traffic
 * lights, both outside this component's reach — so on darwin the title bar
 * keeps only the brand and the branch chip, and the View menu is rendered
 * natively by main (`main/appMenu.ts`).
 */
const isMac = window.api.platform === 'darwin'

/**
 * Whether this window is the active one, so the title bar can back off when it
 * is not — the cue the OS gives a framed window, which a frameless one has to
 * draw itself. Seeded from the document because main's first `focus` fires
 * before the renderer subscribes; every change after that comes over IPC (a
 * terminal keeps the page's own focus while the window goes to the background).
 */
const windowFocused = ref(document.hasFocus())

const viewMenuOpen = ref(false)

function toggleViewMenu(): void {
  viewMenuOpen.value = !viewMenuOpen.value
}

/** The footer readout, shared by the in-window menu and its native counterpart. */
const zoomLabel = computed(() =>
  fontSize.value === DEFAULT_FONT_SIZE
    ? `${fontSize.value}px`
    : `${fontSize.value}px · default ${DEFAULT_FONT_SIZE}px`
)

// The native menu is built from a static template, so the readout only changes
// when we hand main a new one.
if (isMac) {
  watch(zoomLabel, (label) => window.api.setZoomLabel(label), { immediate: true })
}
// The menu deliberately stays open after a zoom click so the size can be nudged
// repeatedly; the imported zoom fns are called straight from the template.

// window is not reachable from template expressions; wrap the controls.
const minimizeWindow = (): void => window.api.minimizeWindow()
const maximizeWindow = (): void => window.api.maximizeWindow()
const closeWindow = (): void => window.api.closeWindow()

function quotaLabel(w: QuotaWindow): string {
  if (w.kind === 'session') return '5h'
  if (w.kind === 'weekly_all') return 'Week'
  return w.model ?? w.kind
}

function quotaTitle(w: QuotaWindow): string {
  const resets = w.resetsAt
    ? new Date(w.resetsAt).toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit'
      })
    : '?'
  return `${quotaLabel(w)}: ${w.percent}% used · resets ${resets}`
}

// Compact time-to-reset, ticking off the shared `now` ref: 42m / 3h / 5d.
function quotaResetText(w: QuotaWindow): string {
  if (!w.resetsAt) return ''
  const ms = new Date(w.resetsAt).getTime() - now.value
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function quotaClass(w: QuotaWindow): string {
  if (w.percent >= 90 || w.severity === 'critical') return 'danger'
  if (w.percent >= 75 || w.severity !== 'normal') return 'warn'
  return ''
}

// A failed fetch (expired token, endpoint hiccup) keeps the last good reading
// visible; the sync indicator carries the failure.
function applyQuota(status: QuotaStatus): void {
  quotaSync.value = { at: status.fetchedAt, error: status.error }
  if (!status.error) quota.value = status
}

// Mount-time calls are cache-friendly; only an explicit click forces a fetch.
async function refreshQuota(force = false): Promise<void> {
  applyQuota(await window.api.getQuota(force))
}

const quotaSyncText = computed(() => {
  const sync = quotaSync.value
  if (!sync) return ''
  if (sync.error) return 'sync failed'
  const mins = Math.floor((now.value - sync.at) / 60_000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`
})

const quotaSyncTitle = computed(() => {
  const sync = quotaSync.value
  if (!sync) return ''
  return sync.error
    ? `last sync failed — ${sync.error} · click to retry`
    : `checked ${new Date(sync.at).toLocaleTimeString()} · click to refresh`
})

onMounted(() => {
  void refresh()
  void window.api.info().then((info) => {
    instanceBranch.value = info.instanceBranch
  })
  window.api.onClaudeStatus((event) => {
    // Longest path prefix wins so the main checkout doesn't swallow worktree events.
    const match = worktrees.value
      .filter((wt) => event.cwd === wt.path || event.cwd.startsWith(wt.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (match) statuses[match.path] = event
  })
  window.api.onPtyExit((id, exitCode) => {
    const tab = tabById(id)
    if (tab) tab.exitCode = exitCode
  })
  window.api.onPtyPort((id, port) => {
    const tab = tabById(id)
    if (tab) tab.port = port
  })
  window.api.onQuota(applyQuota)
  window.api.onWindowFocus((focused) => {
    windowFocused.value = focused
  })
  // macOS Edit menu; the key chords reach runClipboardCommand through onHotkey.
  window.api.onClipboardCommand((action) => void runClipboardCommand(action))
  // Zoom keys are intercepted in main (they're browser page-zoom combos); it tells
  // us the intent and we apply it to the shared terminal font size.
  window.api.onZoom((action) => {
    if (action === 'in') zoomIn()
    else if (action === 'out') zoomOut()
    else zoomReset()
  })
  void refreshQuota()
  const timeInterval = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  const procInterval = setInterval(updateSessionProcesses, 2000)

  const onFocus = (): void => {
    void refresh()
    void refreshQuota()
  }
  window.addEventListener('focus', onFocus)

  // Capture phase so hotkeys win over the focused terminal's key handling.
  window.addEventListener('keydown', onHotkey, true)

  onUnmounted(() => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onHotkey, true)
    clearInterval(timeInterval)
    clearInterval(procInterval)
  })
})
</script>

<template>
  <div class="app">
    <header class="titlebar" :class="{ mac: isMac, inactive: !windowFocused }">
      <!-- Branding is the Windows/Linux title bar's job: it is the only identity
           surface those platforms give the app. macOS already names it in the
           menu bar and the Dock, so the bar there carries the branch chip alone. -->
      <span v-if="!isMac" class="titlebar-brand">
        <span class="mark">🐐</span>
        <span class="name">Goat<span class="herd">Herd</span></span>
      </span>
      <span
        v-if="titleBranch"
        class="titlebar-branch"
        :title="`this GoatHerd instance runs from the ${titleBranch} checkout`"
      >
        {{ titleBranch }}
      </span>
      <div v-if="!isMac" class="titlebar-menu">
        <button
          class="menu-trigger"
          :class="{ open: viewMenuOpen }"
          title="View menu"
          @click="toggleViewMenu"
        >
          View
        </button>
        <template v-if="viewMenuOpen">
          <div class="menu-backdrop" @click="viewMenuOpen = false"></div>
          <div class="menu-dropdown">
            <div class="menu-heading">Terminal zoom</div>
            <button class="menu-item" @click="zoomIn">
              <span>Zoom In</span>
              <span class="menu-hint">{{ HOTKEY_HINTS.zoomIn }}</span>
            </button>
            <button class="menu-item" @click="zoomOut">
              <span>Zoom Out</span>
              <span class="menu-hint">{{ HOTKEY_HINTS.zoomOut }}</span>
            </button>
            <button class="menu-item" @click="zoomReset">
              <span>Reset Zoom</span>
              <span class="menu-hint">{{ HOTKEY_HINTS.zoomReset }}</span>
            </button>
            <div class="menu-footer">{{ zoomLabel }}</div>
          </div>
        </template>
      </div>
      <!-- macOS has native traffic lights instead -->
      <div v-if="!isMac" class="titlebar-controls">
        <button class="control-btn" title="Minimize" @click="minimizeWindow">
          <Icon name="window-minimize" />
        </button>
        <button class="control-btn" title="Maximize" @click="maximizeWindow">
          <Icon name="window-maximize" />
        </button>
        <button class="control-btn close" title="Close" @click="closeWindow">
          <Icon name="window-close" />
        </button>
      </div>
    </header>

    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-section-header">
          <span>Workstreams</span>
          <button class="refresh-btn" title="Refresh worktree list" @click.stop="refresh">
            <Icon name="refresh" />
          </button>
        </div>
        <ul class="worktree-list">
          <li
            v-for="wt in worktrees"
            :key="wt.path"
            :class="{ active: wt.path === selectedPath }"
            :style="{ '--workstream-color': getWorktreeColor(wt.path) }"
            :title="wt.isMain ? 'select workstream' : 'select workstream — double-click to rename'"
            @click="openWorktree(wt)"
          >
            <div class="worktree-row" @dblclick="startRename(wt)">
              <span class="dot" :class="statusFor(wt)"></span>
              <input
                v-if="renamingPath === wt.path"
                v-model="renameDraft"
                class="rename-input"
                title="display name only — the branch is unchanged"
                @click.stop
                @keydown.enter.prevent="commitRename"
                @keydown.esc.prevent="cancelRename"
                @blur="commitRename"
              />
              <span v-else class="branch">
                <span class="branch-name">{{ displayName(wt) }}</span>
                <span v-if="wt.name" class="branch-sub">{{ wt.branch }}</span>
              </span>
              <span v-if="runningSession(wt.path, 'app')" class="badge">app</span>
              <span v-if="runningSession(wt.path, 'web')" class="badge">web</span>
              <div class="worktree-status-right">
                <span
                  v-if="wt.commitsAhead"
                  class="commit-count"
                  :title="`${wt.commitsAhead} commits ahead of master`"
                  >+{{ wt.commitsAhead }}</span
                >
                <Icon
                  v-if="wt.hasUncommitted"
                  name="dirty"
                  class="dirty-icon"
                  title="uncommitted changes"
                />
              </div>
            </div>
            <div v-if="wt.path === selectedPath" class="worktree-actions" @click.stop>
              <button title="Claude (Ctrl+Shift+L)" @click="startSession('claude')">
                <Icon name="claude" class="icon claude-icon" />
                <span>Claude</span>
              </button>
              <button title="Terminal (Ctrl+Shift+T)" @click="startSession('shell')">
                <Icon name="terminal" class="icon" />
                <span>Terminal</span>
              </button>
              <button title="GoatCAD app dev server (Ctrl+Shift+A)" @click="startSession('app')">
                <BrandMark mono class="icon" />
                <span>GoatCAD</span>
              </button>
              <button title="site dev server (Ctrl+Shift+W)" @click="startSession('web')">
                <Icon name="globe" class="icon" />
                <span>Web</span>
              </button>
              <button title="dev instance of GoatHerd itself" @click="startSession('goatherd')">
                <span class="icon goat-icon" aria-hidden="true">🐐</span>
                <span>GoatHerd</span>
              </button>
              <button title="open in VSCode (Ctrl+Shift+O)" @click="openInVSCode">
                <Icon name="code" class="icon" />
                <span>VSCode</span>
              </button>
              <!-- No count badge: the workstream row above already carries the
                   commits-ahead number, and repeating it here reads as a second,
                   different figure. -->
              <button
                :title="`Review this branch against master (${HOTKEY_HINTS.gitDiff})`"
                @click="openView('diff')"
              >
                <Icon name="diff" class="icon" />
                <span>Git Diff</span>
              </button>
              <button
                :title="`demos & screenshots in .goatherd/ (${HOTKEY_HINTS.workspace})`"
                @click="openView('workspace')"
              >
                <Icon name="image" class="icon" />
                <span>Workspace</span>
                <span v-if="wt.workspaceCount" class="ws-count">{{ wt.workspaceCount }}</span>
              </button>
              <button
                v-if="!wt.isMain"
                class="danger"
                title="Remove worktree"
                @click="removeSelectedWorktree"
              >
                <Icon name="trash" class="icon" />
                <span>Remove</span>
              </button>
            </div>
          </li>
        </ul>
        <form class="add-worktree" @submit.prevent="addWorktree">
          <input
            ref="newBranchInput"
            v-model="newBranch"
            placeholder="new branch…"
            :title="`new branch (${HOTKEY_HINTS.newBranch})`"
            :disabled="busy"
          />
          <button type="submit" :disabled="busy || !newBranch.trim()">+</button>
        </form>
        <div v-if="quotaSync" class="quota" :title="quotaSyncTitle" @click="refreshQuota(true)">
          <div class="quota-head">
            <Icon name="claude" class="claude-mark" />
            <span>Claude usage</span>
            <button
              class="quota-refresh-btn"
              title="Refresh usage"
              @click.stop="refreshQuota(true)"
            >
              <Icon name="refresh" />
            </button>
            <span class="quota-sync" :class="{ error: quotaSync.error }">
              {{ quotaSyncText }}
            </span>
          </div>
          <div
            v-for="w in quota?.windows ?? []"
            :key="w.kind + (w.model ?? '')"
            class="quota-row"
            :title="quotaTitle(w)"
          >
            <span class="quota-label">{{ quotaLabel(w) }}</span>
            <span class="quota-bar">
              <span
                class="quota-fill"
                :class="quotaClass(w)"
                :style="{ width: Math.min(w.percent, 100) + '%' }"
              ></span>
            </span>
            <span class="quota-pct">{{ w.percent }}%</span>
            <span class="quota-reset">⟳ {{ quotaResetText(w) }}</span>
          </div>
        </div>
      </aside>

      <main v-if="selected" class="content">
        <p v-if="error" class="error">{{ error }}</p>

        <div ref="terminalsContainer" class="terminals" :class="splitDirection">
          <div v-if="!groups.length" class="pane-empty-state">
            <div class="welcome-box">
              <h2>{{ displayName(selected) }}</h2>
              <p v-if="selected.name" class="path">{{ selected.branch }}</p>
              <p class="path">{{ selected.path }}</p>
              <p class="hint">Start a session from the sidebar to begin</p>
            </div>
          </div>

          <template v-for="(group, gi) in groups" :key="group.id">
            <div
              class="pane"
              :data-group-id="group.id"
              :class="{ 'active-group': group.id === activeGroupId }"
              :style="{ ...groupFlex(group), '--group-color': groupColor(group) }"
              @focusin="onGroupFocus(group)"
              @dragover.prevent
              @drop="onDropOnGroup($event, group)"
            >
              <div
                v-if="gi > 0"
                class="pane-resizer-edge"
                :class="splitDirection"
                @mousedown="startResize($event, group.id)"
              ></div>

              <div class="pane-tabbar">
                <div class="pane-tabs" @wheel.passive="onTabWheel">
                  <button
                    v-for="tab in groupTabs(group)"
                    :key="tab.id"
                    class="tab"
                    :class="{
                      active: tab.id === group.activeTabId,
                      dead: tab.exitCode !== undefined
                    }"
                    :style="{ '--workstream-color': getWorktreeColor(tab.worktree) }"
                    :data-tab-id="tab.id"
                    :title="tabTitle(tab)"
                    draggable="true"
                    @click="onTabClick(tab)"
                    @dragstart="onDragStart($event, tab.id)"
                    @dragover.prevent
                    @drop.stop="onDropOnTab($event, group, tab.id)"
                    @mousedown.middle.prevent="closeTab(tab)"
                  >
                    <span v-if="tabNumbers[tab.id] < 9" class="tab-num">{{
                      tabNumbers[tab.id] + 1
                    }}</span>
                    <span class="tab-branch">{{ displayNameFor(tab.worktree) }}</span>
                    <span class="tab-divider">/</span>
                    <span class="tab-label">{{ tabLabel(tab) }}</span>
                    <span
                      v-if="tab.kind === 'web' && tab.port && tab.exitCode === undefined"
                      class="port-link"
                      @click.stop="openWebPreview(tab)"
                    >
                      :{{ tab.port }}
                    </span>
                    <span class="close" title="Close" @click.stop="closeTab(tab)">×</span>
                  </button>
                </div>
                <div class="pane-tabbar-actions">
                  <button
                    v-if="group.tabIds.length > 1"
                    class="split-btn"
                    :title="`Split active tab into a new group (${HOTKEY_HINTS.split})`"
                    @click="splitGroup(group)"
                  >
                    <Icon name="split" />
                  </button>
                </div>
              </div>

              <div class="pane-body">
                <template v-for="tab in groupTabs(group)" :key="tab.id">
                  <WorkspaceView
                    v-if="tab.kind === 'workspace'"
                    v-show="group.activeTabId === tab.id"
                    :worktree="tab.worktree"
                  />
                  <GitDiffView
                    v-else-if="tab.kind === 'diff'"
                    v-show="group.activeTabId === tab.id"
                    :worktree="tab.worktree"
                    :branch="branchFor(tab.worktree)"
                    :tab-id="tab.id"
                    :visible="group.activeTabId === tab.id"
                    :focus-signal="focusSignal"
                  />
                  <TerminalPane
                    v-else
                    v-show="group.activeTabId === tab.id"
                    :session-id="tab.id"
                    :visible="group.activeTabId === tab.id"
                    :focus-signal="focusSignal"
                  />
                </template>
              </div>
            </div>
          </template>
        </div>
      </main>
      <main v-else class="content empty">No worktrees found</main>
    </div>

    <div v-if="finderOpen" class="finder-overlay" @click.self="finderOpen = false">
      <div class="finder">
        <input
          ref="finderInput"
          v-model="finderQuery"
          placeholder="jump to workstream…"
          @keydown="onFinderKey"
        />
        <ul>
          <li
            v-for="(wt, i) in finderMatches"
            :key="wt.path"
            :class="{ active: i === finderIndex }"
            @click="pickWorktree(wt)"
            @mousemove="finderIndex = i"
          >
            <span class="dot" :class="statusFor(wt)"></span>
            <span class="branch">{{ displayName(wt) }}</span>
            <span v-if="wt.name" class="finder-branch">{{ wt.branch }}</span>
            <span v-if="worktrees.indexOf(wt) < 9" class="key-hint">
              {{ worktrees.indexOf(wt) + 1 }}
            </span>
          </li>
          <li v-if="!finderMatches.length" class="none">no matching workstream</li>
        </ul>
      </div>
    </div>
  </div>
</template>
