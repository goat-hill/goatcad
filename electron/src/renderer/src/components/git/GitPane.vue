<script setup lang="ts">
/**
 * The sidebar's Git pane: branch and remote, the commit box, and the changed
 * files grouped Merge / Staged / Changes. Every action runs through the
 * window's shared `GitOps` (lib/git/gitOps.ts), which is also what App's git
 * hotkeys drive — so a Push from the keyboard reports here.
 *
 * A row opens its diff (a preview tab; double-click pins it). The list is one
 * roving tab stop: arrows move, Enter opens, Space stages or unstages, Delete
 * discards.
 */
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import FileIcon from '../shared/FileIcon.vue'
import ContextMenu from '../shared/ContextMenu.vue'
import type { MenuNode } from '../../lib/menu'
import type { GitDiffSide, GitFileStatus } from '../../../../preload/gitTypes'
import { conflictedFiles, GIT_KEY, stagedFiles, unstagedFiles } from '../../lib/git/gitOps'
import { readDiffVersions } from '../../lib/git/diffSources'
import { diffSymbolLibraries, type SymbolChange } from '../../lib/git/symbolLibraryDiff'
import { parseKicadSymbolLibrary } from '../../lib/kicad/symbolLibrary'
import { gitRemoteErrorKey } from '../../lib/git/gitCopy'
import type { GitDecorClass } from '../../lib/gitDecorations'
import { diffTabPath } from '../../lib/tabs'
import { hotkeyLabel, matchesHotkey, toolTitle } from '../../lib/hotkeys'
import { delayedVisible } from '../../lib/delayedVisible'

const { t } = useI18n()

const props = defineProps<{
  activeTabPath: string | null
}>()

const emit = defineEmits<{
  (e: 'open-folder'): void
  (e: 'open-branch-picker'): void
  (
    e: 'open-diff',
    side: GitDiffSide,
    file: GitFileStatus,
    options: { preview: boolean; symbol?: string }
  ): void
  (e: 'open-file', file: GitFileStatus): void
}>()

const git = inject(GIT_KEY)
if (!git) throw new Error('GitPane needs the window GitOps (GIT_KEY)')
const { status, projectPath, busy, remote, error, lastRemoteSuccess } = git

type SectionId = 'merge' | 'staged' | 'changes'

interface Row {
  /** Unique across sections: the same file can be staged and changed at once. */
  key: string
  section: SectionId
  file: GitFileStatus
  name: string
  dir: string
  letter: string
  cls: GitDecorClass
}

const letterClass = (letter: string): GitDecorClass =>
  letter === '!'
    ? 'git-conflict'
    : letter === 'D'
      ? 'git-deleted'
      : letter === 'A' || letter === 'U'
        ? 'git-added'
        : 'git-modified'

const rowFor = (section: SectionId, file: GitFileStatus, code: string): Row => {
  const letter = code === 'C' ? 'R' : code // copies read as renames, VS Code-style
  const slash = file.relPath.lastIndexOf('/')
  return {
    key: `${section}:${file.path}`,
    section,
    file,
    name: slash >= 0 ? file.relPath.slice(slash + 1) : file.relPath,
    dir: slash >= 0 ? file.relPath.slice(0, slash) : '',
    letter,
    cls: letterClass(letter)
  }
}

const sections = computed((): { id: SectionId; title: string; rows: Row[] }[] => {
  if (status.value?.state !== 'ok') return []
  const files = status.value.files
  const all: { id: SectionId; title: string; rows: Row[] }[] = [
    {
      id: 'merge',
      title: t('git.pane.mergeChanges'),
      rows: conflictedFiles(files).map((f) => rowFor('merge', f, '!'))
    },
    {
      id: 'staged',
      title: t('git.pane.stagedChanges'),
      rows: stagedFiles(files).map((f) => rowFor('staged', f, f.index ?? 'M'))
    },
    {
      id: 'changes',
      title: t('git.pane.changes'),
      rows: unstagedFiles(files).map((f) =>
        rowFor('changes', f, f.untracked ? 'U' : (f.worktree ?? 'M'))
      )
    }
  ]
  return all.filter((s) => s.rows.length > 0)
})

const collapsed = ref<Partial<Record<SectionId, boolean>>>({})
const toggleSection = (id: SectionId): void => {
  collapsed.value[id] = !collapsed.value[id]
}

// ---- Symbols of a changed library ------------------------------------------
// A `.kicad_sym` row expands to the symbols that changed in it, each opening
// its own diff. View-only: staging and discarding stay with the file.

const isLibraryRow = (row: Row): boolean =>
  row.name.toLowerCase().endsWith('.kicad_sym') && !row.file.conflicted

type SymbolList =
  { state: 'loading' } | { state: 'error' } | { state: 'ok'; changes: SymbolChange[] }

const expanded = ref<Record<string, boolean>>({})
const symbolLists = ref<Record<string, SymbolList>>({})

const loadSymbols = async (row: Row): Promise<void> => {
  const cwd = projectPath.value
  if (!cwd) return
  if (!symbolLists.value[row.key]) symbolLists.value[row.key] = { state: 'loading' }
  try {
    const { before, after } = await readDiffVersions({
      cwd,
      filePath: row.file.path,
      side: sideOf(row),
      untracked: row.section === 'changes' && row.file.untracked,
      deleted: row.letter === 'D'
    })
    const changes = diffSymbolLibraries(
      before === null ? null : parseKicadSymbolLibrary(before),
      after === null ? null : parseKicadSymbolLibrary(after)
    )
    symbolLists.value[row.key] = { state: 'ok', changes }
  } catch {
    symbolLists.value[row.key] = { state: 'error' }
  }
}

const toggleExpanded = (row: Row): void => {
  const open = !expanded.value[row.key]
  expanded.value[row.key] = open
  if (open) void loadSymbols(row)
}

// Status moved (a save, a stage): an open library re-reads what changed in it.
watch(status, () => {
  const rows = sections.value.flatMap((s) => s.rows)
  for (const key of Object.keys(expanded.value)) {
    if (!expanded.value[key]) continue
    const row = rows.find((r) => r.key === key)
    if (row) void loadSymbols(row)
    else delete expanded.value[key]
  }
})

/** A library row's changed symbols, once read. */
const changesOf = (row: Row): SymbolChange[] => {
  const list = symbolLists.value[row.key]
  return list?.state === 'ok' ? list.changes : []
}

const symbolLetter = (change: SymbolChange): string =>
  change.kind === 'added' ? 'A' : change.kind === 'removed' ? 'D' : 'M'

/** One entry of the roving list: a file, or a symbol under an open library. */
interface NavItem {
  key: string
  row: Row
  symbol?: string
}

const symbolKey = (row: Row, name: string): string => `${row.key}#${name}`

const visibleItems = computed((): NavItem[] =>
  sections.value.flatMap((s) =>
    collapsed.value[s.id]
      ? []
      : s.rows.flatMap((row): NavItem[] => {
          const children = expanded.value[row.key]
            ? changesOf(row).map((c) => ({ key: symbolKey(row, c.name), row, symbol: c.name }))
            : []
          return [{ key: row.key, row }, ...children]
        })
  )
)

// ---- Actions ---------------------------------------------------------------

const sideOf = (row: Row): GitDiffSide => (row.section === 'staged' ? 'staged' : 'working')

const openDiff = (row: Row, preview: boolean, symbol?: string): void => {
  emit('open-diff', sideOf(row), row.file, {
    preview,
    ...(symbol !== undefined ? { symbol } : {})
  })
}

const isActiveRow = (row: Row, symbol?: string): boolean =>
  props.activeTabPath === diffTabPath(sideOf(row), row.file.path, symbol)

const stageRows = (rows: Row[]): void => {
  void git.stage(rows.map((r) => r.file.path))
}

const unstageRows = (rows: Row[]): void => {
  void git.unstage(rows.map((r) => r.file.path))
}

const discardRows = (rows: Row[]): void => {
  if (rows.length === 0) return
  const text =
    rows.length === 1
      ? rows[0].file.untracked
        ? t('git.pane.confirmDeleteUntracked', { name: rows[0].name })
        : t('git.pane.confirmDiscard', { name: rows[0].name })
      : t('git.pane.confirmDiscardAll', { count: rows.length }, rows.length)
  if (!window.confirm(text)) return
  void git.discard(rows.map((r) => ({ path: r.file.path, untracked: r.file.untracked })))
}

/** Space on a row: the row's primary action, the same one its `+`/`−` button runs. */
const toggleStage = (row: Row): void => {
  if (row.section === 'staged') unstageRows([row])
  else stageRows([row])
}

// ---- Commit box ------------------------------------------------------------

const message = ref('')
const messageEl = ref<HTMLTextAreaElement | null>(null)

/** Nothing staged means Commit takes everything — say so on the button. */
const commitsAll = computed(() => !git.hasStaged.value && git.hasChanges.value)
const canCommit = computed(
  () => message.value.trim().length > 0 && git.hasChanges.value && !busy.value
)

const commit = async (): Promise<void> => {
  if (!canCommit.value) return
  if (await git.commit(message.value)) message.value = ''
}

const onMessageKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'git.commit')) {
    e.preventDefault()
    void commit()
  }
}

watch(
  [git.commitFocusPending, messageEl],
  async ([pending, el]) => {
    if (!pending) return
    await nextTick()
    if (!el) {
      // No commit box to focus (not a repo, no git): the request is spent.
      if (status.value?.state !== 'ok') git.commitFocusPending.value = false
      return
    }
    el.focus()
    git.commitFocusPending.value = false
  },
  { immediate: true }
)

// ---- Remote ----------------------------------------------------------------

const hasUpstream = computed(() => status.value?.ahead !== undefined)
const ahead = computed(() => status.value?.ahead ?? 0)
const behind = computed(() => status.value?.behind ?? 0)
const remoteVisible = delayedVisible(() => remote.value !== null)

const dismissError = (): void => {
  error.value = null
}

const errorText = computed((): string | null => {
  const err = error.value
  if (!err) return null
  if (err.conflicts) return t('git.error.conflictsBeforeCommit')
  const key = gitRemoteErrorKey(err)
  return key ? t(key) : err.message
})

// ---- Row menu --------------------------------------------------------------

const rowMenu = ref<{ x: number; y: number; row: Row } | null>(null)

const openRowMenu = (e: MouseEvent, row: Row): void => {
  rowMenu.value = { x: e.clientX, y: e.clientY, row }
}

const rowMenuItems = computed((): MenuNode[] => {
  const row = rowMenu.value?.row
  if (!row) return []
  const gone = row.letter === 'D'
  const items: MenuNode[] = []
  if (!gone) items.push({ id: 'open-file', label: t('git.pane.openFile') })
  if (!gone) items.push({ id: 'reveal', label: t('sidebar.fileMenu.reveal') })
  if (items.length > 0) items.push({ divider: true })
  items.push({
    id: 'ignore',
    label: [{ text: `${t('git.pane.addTo')} ` }, { text: '.gitignore', code: true }],
    // A pattern stops git from noticing a new file; one it already tracks stays tracked.
    ...(row.file.untracked ? {} : { disabled: true, disabledReason: t('git.pane.ignoreTracked') })
  })
  return items
})

const onRowMenuSelect = (id: string): void => {
  const row = rowMenu.value?.row
  rowMenu.value = null
  if (!row) return
  if (id === 'open-file') emit('open-file', row.file)
  else if (id === 'reveal') void window.api.revealPath(row.file.path)
  else if (id === 'ignore') void git.ignore(row.file.path)
}

// ---- Keyboard: one roving tab stop over the visible rows --------------------

const focusKey = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)

const tabStopKey = computed((): string | null => {
  const items = visibleItems.value
  if (items.length === 0) return null
  return items.some((item) => item.key === focusKey.value) ? focusKey.value : items[0].key
})

const focusRow = async (key: string): Promise<void> => {
  focusKey.value = key
  await nextTick()
  listEl.value?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)?.focus()
}

const onItemKeydown = (e: KeyboardEvent, item: NavItem): void => {
  const items = visibleItems.value
  const i = items.findIndex((it) => it.key === item.key)
  const { row, symbol } = item
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) void focusRow(next.key)
  } else if (e.key === 'ArrowRight' && symbol === undefined && isLibraryRow(row)) {
    e.preventDefault()
    if (!expanded.value[row.key]) toggleExpanded(row)
  } else if (e.key === 'ArrowLeft' && (symbol !== undefined || expanded.value[row.key])) {
    e.preventDefault()
    // From a symbol, step out to its library; on an open library, close it.
    if (symbol !== undefined) void focusRow(row.key)
    else toggleExpanded(row)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    openDiff(row, false, symbol)
  } else if (symbol !== undefined) {
    // A symbol is view-only: git acts on its file.
  } else if (e.key === ' ') {
    e.preventDefault()
    toggleStage(row)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && row.section === 'changes') {
    e.preventDefault()
    discardRows([row])
  }
}
</script>

<template>
  <div class="git-pane">
    <div class="sidebar-header">
      <span>{{ t('git.pane.title') }}</span>
      <div v-if="projectPath" class="sidebar-header-actions">
        <button
          class="btn-subtle btn-icon-sm"
          :title="t('git.pane.refresh')"
          @click="git.refresh()"
        >
          <Icon name="refresh" />
        </button>
      </div>
    </div>

    <div v-if="!projectPath" class="sidebar-empty-state">
      <p>{{ t('sidebar.fileExplorer.emptyState') }}</p>
      <button class="btn-outline btn-md" @click="emit('open-folder')">
        {{ t('sidebar.fileExplorer.openFolder') }}
      </button>
    </div>

    <template v-else-if="status && status.state === 'ok'">
      <!-- Where you are and how far from the remote. -->
      <div class="git-branch-bar">
        <button
          class="btn-subtle btn-sm git-branch-btn"
          :title="t('git.pane.switchBranch')"
          @click="emit('open-branch-picker')"
        >
          <Icon name="git-branch" />
          <span class="git-branch-name">{{ status.branch ?? t('git.pane.noBranch') }}</span>
        </button>
        <div class="git-remote-actions">
          <button
            class="btn-outline btn-sm"
            :disabled="busy || !hasUpstream"
            :title="
              hasUpstream
                ? `${t('git.pane.pull')} (${hotkeyLabel('git.pull')})`
                : t('git.pane.noUpstream')
            "
            @click="git.pull()"
          >
            <Icon name="arrow-down" />
            <span class="git-count">{{ behind }}</span>
          </button>
          <button
            class="btn-outline btn-sm"
            :disabled="busy"
            :title="
              hasUpstream
                ? `${t('git.pane.push')} (${hotkeyLabel('git.push')})`
                : t('git.pane.publish')
            "
            @click="git.push()"
          >
            <Icon name="arrow-up" />
            <span class="git-count">{{ hasUpstream ? ahead : t('git.pane.publishShort') }}</span>
          </button>
        </div>
      </div>

      <div class="git-commit-box">
        <textarea
          ref="messageEl"
          v-model="message"
          class="field-sm git-commit-input"
          rows="3"
          spellcheck="true"
          :placeholder="t('git.pane.commitPlaceholder')"
          @keydown="onMessageKeydown"
        ></textarea>
        <button
          class="btn-cta btn-md"
          :disabled="!canCommit"
          :title="
            toolTitle(commitsAll ? t('git.pane.commitAllHint') : t('git.pane.commit'), 'git.commit')
          "
          @click="commit()"
        >
          {{ commitsAll ? t('git.pane.commitAll') : t('git.pane.commit') }}
        </button>
      </div>

      <div
        v-if="remoteVisible || lastRemoteSuccess || errorText"
        class="git-feedback"
        :class="{ 'is-error': !!errorText && !remoteVisible }"
      >
        <span v-if="remoteVisible" class="status-badge is-pending">{{
          remote === 'push' ? t('git.pane.pushing') : t('git.pane.pulling')
        }}</span>
        <template v-else-if="errorText">
          <span class="git-feedback-text" :title="error?.message">{{ errorText }}</span>
          <button class="btn-subtle btn-icon-sm" :title="t('common.close')" @click="dismissError">
            <Icon name="close-sm" />
          </button>
        </template>
        <span v-else-if="lastRemoteSuccess" class="status-badge is-ok">{{
          lastRemoteSuccess === 'push' ? t('git.pane.pushed') : t('git.pane.pulled')
        }}</span>
      </div>

      <div ref="listEl" class="git-lists">
        <p v-if="sections.length === 0" class="git-empty">{{ t('git.pane.noChanges') }}</p>

        <section v-for="section in sections" :key="section.id" class="git-section">
          <div class="git-section-header" @click="toggleSection(section.id)">
            <Icon
              name="chevron-right"
              class="disclosure"
              :class="{ open: !collapsed[section.id] }"
            />
            <span class="git-section-title">{{ section.title }}</span>
            <span class="git-section-count">{{ section.rows.length }}</span>
            <div class="git-section-actions" @click.stop>
              <button
                v-if="section.id === 'changes'"
                class="btn-subtle btn-icon-sm"
                :disabled="busy"
                :title="t('git.pane.discardAll')"
                @click="discardRows(section.rows)"
              >
                <Icon name="discard" />
              </button>
              <button
                v-if="section.id !== 'staged'"
                class="btn-subtle btn-icon-sm"
                :disabled="busy"
                :title="`${t('git.pane.stageAll')} (${hotkeyLabel('git.stageAll')})`"
                @click="stageRows(section.rows)"
              >
                <Icon name="plus" />
              </button>
              <button
                v-else
                class="btn-subtle btn-icon-sm"
                :disabled="busy"
                :title="t('git.pane.unstageAll')"
                @click="unstageRows(section.rows)"
              >
                <Icon name="minus" />
              </button>
            </div>
          </div>

          <div v-show="!collapsed[section.id]" role="list">
            <template v-for="row in section.rows" :key="row.key">
              <div
                role="listitem"
                class="git-row"
                :class="{ active: isActiveRow(row) }"
                :data-row-key="row.key"
                :tabindex="row.key === tabStopKey ? 0 : -1"
                :title="row.file.relPath"
                @click="openDiff(row, true)"
                @dblclick="openDiff(row, false)"
                @contextmenu.prevent="openRowMenu($event, row)"
                @focus="focusKey = row.key"
                @keydown="onItemKeydown($event, { key: row.key, row })"
              >
                <!-- A library has no glyph: its caret says it opens (DESIGN.md §Icons). -->
                <button
                  v-if="isLibraryRow(row)"
                  class="btn-subtle btn-icon-sm git-row-caret"
                  tabindex="-1"
                  :title="expanded[row.key] ? t('git.pane.hideSymbols') : t('git.pane.showSymbols')"
                  @click.stop="toggleExpanded(row)"
                  @dblclick.stop
                >
                  <Icon
                    name="chevron-right"
                    class="disclosure"
                    :class="{ open: expanded[row.key] }"
                  />
                </button>
                <FileIcon v-else :name="row.name" class="git-row-icon" />
                <span class="git-row-name" :class="{ 'is-deleted': row.letter === 'D' }">{{
                  row.name
                }}</span>
                <span class="git-row-dir">{{ row.dir }}</span>
                <div class="git-row-actions" @click.stop @dblclick.stop>
                  <button
                    v-if="row.letter !== 'D'"
                    class="btn-subtle btn-icon-sm"
                    :title="t('git.pane.openFile')"
                    @click="emit('open-file', row.file)"
                  >
                    <Icon name="file-doc" />
                  </button>
                  <button
                    v-if="row.section === 'changes'"
                    class="btn-subtle btn-icon-sm"
                    :disabled="busy"
                    :title="t('git.pane.discard')"
                    @click="discardRows([row])"
                  >
                    <Icon name="discard" />
                  </button>
                  <button
                    v-if="row.section !== 'staged'"
                    class="btn-subtle btn-icon-sm"
                    :disabled="busy"
                    :title="
                      row.section === 'merge' ? t('git.pane.markResolved') : t('git.pane.stage')
                    "
                    @click="stageRows([row])"
                  >
                    <Icon name="plus" />
                  </button>
                  <button
                    v-else
                    class="btn-subtle btn-icon-sm"
                    :disabled="busy"
                    :title="t('git.pane.unstage')"
                    @click="unstageRows([row])"
                  >
                    <Icon name="minus" />
                  </button>
                </div>
                <span class="git-row-letter" :class="row.cls">{{ row.letter }}</span>
              </div>
              <template v-if="expanded[row.key]">
                <p
                  v-if="symbolLists[row.key]?.state === 'loading'"
                  class="git-row git-symbol-row git-symbol-note"
                >
                  {{ t('git.pane.loadingSymbols') }}
                </p>
                <p
                  v-else-if="symbolLists[row.key]?.state === 'error'"
                  class="git-row git-symbol-row git-symbol-note"
                >
                  {{ t('git.pane.symbolsUnreadable') }}
                </p>
                <template v-else-if="symbolLists[row.key]?.state === 'ok'">
                  <div
                    v-for="change in changesOf(row)"
                    :key="change.name"
                    role="listitem"
                    class="git-row git-symbol-row"
                    :class="{ active: isActiveRow(row, change.name) }"
                    :data-row-key="symbolKey(row, change.name)"
                    :tabindex="symbolKey(row, change.name) === tabStopKey ? 0 : -1"
                    :title="change.name"
                    @click="openDiff(row, true, change.name)"
                    @dblclick="openDiff(row, false, change.name)"
                    @focus="focusKey = symbolKey(row, change.name)"
                    @keydown="
                      onItemKeydown($event, {
                        key: symbolKey(row, change.name),
                        row,
                        symbol: change.name
                      })
                    "
                  >
                    <FileIcon kind="symbol" class="git-row-icon" />
                    <span
                      class="git-row-name"
                      :class="{ 'is-deleted': change.kind === 'removed' }"
                      >{{ change.name }}</span
                    >
                    <span class="git-row-dir"></span>
                    <span
                      class="git-row-letter"
                      :class="
                        change.kind === 'added'
                          ? 'git-added'
                          : change.kind === 'removed'
                            ? 'git-deleted'
                            : 'git-modified'
                      "
                      >{{ symbolLetter(change) }}</span
                    >
                  </div>
                  <p
                    v-if="changesOf(row).length === 0"
                    class="git-row git-symbol-row git-symbol-note"
                  >
                    {{ t('git.pane.noSymbolChanges') }}
                  </p>
                </template>
              </template>
            </template>
          </div>
        </section>
      </div>
    </template>

    <div v-else-if="status && status.state === 'not-a-repo'" class="sidebar-empty-state">
      <p>{{ t('git.pane.notARepo') }}</p>
      <button
        class="btn-outline btn-md"
        :disabled="busy"
        :title="t('git.pane.initRepoHint')"
        @click="git.init()"
      >
        {{ t('git.pane.initRepo') }}
      </button>
      <p v-if="errorText" class="git-empty">{{ errorText }}</p>
    </div>
    <p v-else-if="status && status.state === 'no-git'" class="git-empty">
      {{ t('git.pane.gitNotInstalled') }}
    </p>
    <div v-else-if="status && status.state === 'error'" class="git-empty">
      <p>{{ t('git.pane.statusError') }}</p>
      <p>{{ status.errorMessage }}</p>
    </div>
    <ContextMenu
      v-if="rowMenu"
      :items="rowMenuItems"
      :x="rowMenu.x"
      :y="rowMenu.y"
      @select="onRowMenuSelect"
      @close="rowMenu = null"
    />
  </div>
</template>

<style scoped>
.git-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* Branch + remote. The branch is a button because it opens the switcher; the
   pull/push pair carries its counts, which is the whole ahead/behind readout. */
.git-branch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 4px;
  border-bottom: 1px solid var(--vscode-border);
}

.git-branch-btn {
  min-width: 0;
  flex: 1;
  justify-content: flex-start;
  color: var(--vscode-text);
}

.git-branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-remote-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.git-remote-actions .btn-sm {
  gap: 4px;
}

.git-count {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}

.git-commit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 8px;
  border-bottom: 1px solid var(--vscode-border);
}

.git-commit-input {
  resize: vertical;
  min-height: 48px;
  line-height: 1.5;
}

.git-feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  min-height: 32px;
  border-bottom: 1px solid var(--vscode-border);
}

.git-feedback.is-error {
  background: var(--vscode-error-subtle);
}

.git-feedback-text {
  flex: 1;
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
  word-break: break-word;
}

.git-lists {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 8px;
}

.git-empty {
  margin: 0;
  padding: 16px;
  text-align: center;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  word-break: break-word;
}

/* Section eyebrow (DESIGN.md §Section eyebrows) on a 28px row, so the 24px
   header actions sit inside it. */
.git-section-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 4px;
  cursor: pointer;
  user-select: none;
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.git-section-header:hover {
  color: var(--vscode-text);
}

.git-section-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-section-count {
  font-family: var(--font-mono);
  flex: 1;
}

.git-section-actions,
.git-row-actions {
  display: flex;
  flex-shrink: 0;
}

/* Hover actions appear on hover or keyboard focus; the header's stay put. */
.git-row-actions {
  display: none;
}

.git-row:hover .git-row-actions,
.git-row:focus-within .git-row-actions,
.git-row:focus .git-row-actions {
  display: flex;
}

.git-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 8px 0 24px;
  cursor: pointer;
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
  border-left: 2px solid transparent;
}

.git-row:hover {
  background: var(--vscode-bg-hover);
}

.git-row:focus-visible {
  outline: 1px solid var(--vscode-input-focus);
  outline-offset: -1px;
}

/* The row whose diff is the active tab, as .tree-node.active marks an open file. */
.git-row.active {
  background: var(--vscode-bg-hover);
  color: var(--vscode-text-light);
  border-left-color: var(--vscode-accent);
}

.git-row-icon {
  flex-shrink: 0;
}

/* The library caret sits in the glyph's 16px column; the 24px target overhangs it evenly. */
.git-row-caret {
  margin: 0 -4px;
  flex-shrink: 0;
}

.git-row-caret > .disclosure {
  width: 16px;
  height: 16px;
}

/* A symbol row sits one step in, under its library's name. */
.git-symbol-row {
  padding-left: 48px;
}

.git-symbol-note {
  margin: 0;
  cursor: default;
  color: var(--vscode-text-muted);
}

.git-symbol-note:hover {
  background: none;
}

.git-row-name {
  white-space: nowrap;
  flex-shrink: 0;
}

.git-row-name.is-deleted {
  text-decoration: line-through;
  color: var(--vscode-text-muted);
}

.git-row-dir {
  flex: 1;
  min-width: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-row-letter {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: 600;
}
</style>
