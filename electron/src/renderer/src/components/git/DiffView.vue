<script setup lang="ts">
/**
 * A diff tab (`goatcad://diff/<side>/<path>`): one changed file, working tree
 * against the index or index against HEAD. Text is git's own unified diff,
 * drawn side by side or inline; a schematic, board or symbol library also
 * gets a visual diff, which is where it opens, since its text diff is mostly
 * UUIDs and coordinates.
 *
 * What the file's status is (untracked, renamed, still changed at all) comes
 * from the window's live git status rather than the tab, so a restored or
 * cross-window tab reads the same as a fresh one, and the diff re-reads as
 * status moves (a save, a stage, a refocus).
 */
import { computed, defineAsyncComponent, inject, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import type { GitFileStatus } from '../../../../preload/gitTypes'
import { GIT_KEY } from '../../lib/git/gitOps'
import { parseDiffTab } from '../../lib/tabs'
import {
  diffLineCount,
  MAX_RENDERED_DIFF_LINES,
  parseUnifiedDiff,
  splitRows,
  type DiffHunk,
  type ParsedDiff
} from '../../lib/git/unifiedDiff'
import { delayedVisible } from '../../lib/delayedVisible'
import {
  diffLayout,
  diffView,
  type DiffVersion,
  setDiffLayout,
  setDiffView,
  visualDiffKind
} from '../../lib/git/diffPreferences'

import type { VisualDiffModel } from './VisualDiffView.vue'
import { readDiffVersions } from '../../lib/git/diffSources'
import { hunksWithin, symbolLineRange } from '../../lib/git/symbolText'
import { symbolDiffUnitCount } from '../../lib/git/symbolLibraryDiff'
import { parseKicadBoard } from '../../lib/kicad/board'
import { parseKicadSchematic } from '../../lib/kicad/schematic'
import { parseKicadSymbolLibrary } from '../../lib/kicad/symbolLibrary'
import { symbolUnitName, unitLetter } from '../../lib/symbol/symbolEdit'

const VisualDiffView = defineAsyncComponent(() => import('./VisualDiffView.vue'))

const { t } = useI18n()

const props = defineProps<{
  tabPath: string
}>()

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()

const git = inject(GIT_KEY)
if (!git) throw new Error('DiffView needs the window GitOps (GIT_KEY)')

const target = computed(() => parseDiffTab(props.tabPath))
const side = computed(() => target.value?.side ?? 'working')
/** The one symbol this tab diffs, out of a `.kicad_sym`; undefined for a whole file. */
const symbol = computed(() => target.value?.symbol)

/** This file's status entry for this side, or null once it has no change there. */
const entry = computed((): GitFileStatus | null => {
  const status = git.status.value
  const tab = target.value
  if (status?.state !== 'ok' || !tab) return null
  const file = status.files.find((f) => f.path === tab.filePath)
  if (!file) return null
  if (tab.side === 'staged') return !file.conflicted && file.index !== null ? file : null
  return file.conflicted || file.untracked || file.worktree !== null ? file : null
})

const relPath = computed(() => entry.value?.relPath ?? target.value?.filePath ?? '')
const deleted = computed(() =>
  side.value === 'staged' ? entry.value?.index === 'D' : entry.value?.worktree === 'D'
)

// ---- Loading ---------------------------------------------------------------

const diff = ref<ParsedDiff | null>(null)
/** Both versions' text, read when a view needs more than git's diff (a picture, a symbol's lines). */
const sources = shallowRef<{ before: string | null; after: string | null } | null>(null)
/** Bumped when the versions are re-read, so the visual diff rebuilds. */
const sourcesRevision = ref(0)
const loadError = ref<string | null>(null)
const loading = ref(false)
const showLoading = delayedVisible(() => loading.value && diff.value === null)
let generation = 0

/**
 * Keyed on what changes the diff's inputs: the file's status letters. The
 * content itself can change with the letters standing still (a second save),
 * so a status refresh — a new object — reloads too; git diff is cheap.
 */
const load = async (): Promise<void> => {
  const projectPath = git.projectPath.value
  const tab = target.value
  const file = entry.value
  if (!projectPath || !tab) return
  const mine = ++generation
  if (!file) {
    diff.value = null
    sources.value = null
    loadError.value = null
    return
  }
  loading.value = true
  try {
    // A symbol tab needs them for its text too, conflict markers and all.
    const needsSources = visualKind.value !== null
    const read = needsSources
      ? readDiffVersions({
          cwd: projectPath,
          filePath: tab.filePath,
          side: tab.side,
          untracked: tab.side === 'working' && file.untracked,
          deleted: deleted.value
        })
      : Promise.resolve(null)
    const res = await window.api.gitDiff(projectPath, {
      path: tab.filePath,
      side: tab.side,
      untracked: tab.side === 'working' && file.untracked,
      conflicted: file.conflicted,
      ...(tab.side === 'staged' && file.renamedFrom ? { renamedFrom: file.renamedFrom } : {})
    })
    const versions = await read
    if (mine !== generation) return
    if (res.success) {
      diff.value = parseUnifiedDiff(res.diff ?? '')
      sources.value = versions
      sourcesRevision.value++
      loadError.value = null
    } else {
      loadError.value = res.error ?? ''
    }
  } catch (err) {
    if (mine === generation) loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (mine === generation) loading.value = false
  }
}

// ---- View ------------------------------------------------------------------

const visualKind = computed(() => visualDiffKind(relPath.value, symbol.value))
// A conflicted file holds conflict markers, which no parser reads: text only.
const canVisual = computed(() => visualKind.value !== null && !entry.value?.conflicted)
const showVisual = computed(() => canVisual.value && diffView.value === 'visual' && !!entry.value)

/**
 * Which sheet the visual diff shows: Diff (both overlaid) by default, or one
 * version alone. A new file has no Before and a deleted one no After, so the
 * toggle disables the missing side.
 */
const version = ref<DiffVersion>('diff')
const hasBefore = computed(() => {
  const file = entry.value
  if (!file) return false
  return side.value === 'staged' ? file.index !== 'A' : !file.untracked && file.index !== 'A'
})
watch([hasBefore, deleted], ([before, gone]) => {
  if ((version.value === 'before' && !before) || (version.value === 'after' && gone)) {
    version.value = 'diff'
  }
})

/** Both versions parsed as their kind, for the visual diff. */
const parsed = computed(
  ():
    | { kind: 'schematic' | 'board'; model: VisualDiffModel }
    | {
        kind: 'symbol'
        before: ReturnType<typeof parseKicadSymbolLibrary> | null
        after: ReturnType<typeof parseKicadSymbolLibrary> | null
      }
    | null => {
    const text = sources.value
    if (!text || !visualKind.value) return null
    try {
      if (visualKind.value === 'board') {
        return {
          kind: 'board',
          model: {
            kind: 'board',
            before: text.before === null ? null : parseKicadBoard(text.before),
            after: text.after === null ? null : parseKicadBoard(text.after)
          }
        }
      }
      if (visualKind.value === 'schematic') {
        return {
          kind: 'schematic',
          model: {
            kind: 'schematic',
            before: text.before === null ? null : parseKicadSchematic(text.before),
            after: text.after === null ? null : parseKicadSchematic(text.after)
          }
        }
      }
      return {
        kind: 'symbol',
        before: text.before === null ? null : parseKicadSymbolLibrary(text.before),
        after: text.after === null ? null : parseKicadSymbolLibrary(text.after)
      }
    } catch {
      return null
    }
  }
)

// ---- Units (a symbol diff shows one unit at a time) -------------------------

const unit = ref(1)
const unitOptions = computed((): { unit: number; label: string }[] => {
  const p = parsed.value
  const name = symbol.value
  if (p?.kind !== 'symbol' || name === undefined) return []
  const count = symbolDiffUnitCount(p.before, p.after, name)
  const node = (p.after ?? p.before)?.symbols.get(name)?._node
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const named = node ? symbolUnitName(node, n) : null
    return {
      unit: n,
      label: named
        ? t('symbolEditor.units.namedOption', { letter: unitLetter(n), name: named })
        : t('symbolEditor.units.option', { letter: unitLetter(n) })
    }
  })
})
watch(unitOptions, (options) => {
  if (unit.value > Math.max(1, options.length)) unit.value = 1
})

const model = computed((): VisualDiffModel | null => {
  const p = parsed.value
  if (!p) return null
  if (p.kind !== 'symbol') return p.model
  return symbol.value === undefined
    ? null
    : { kind: 'symbol', before: p.before, after: p.after, symbol: symbol.value, unit: unit.value }
})

// ---- Text ------------------------------------------------------------------

/** git's diff — for a symbol tab, trimmed to that symbol's lines in each version. */
const shownDiff = computed((): ParsedDiff | null => {
  const whole = diff.value
  const name = symbol.value
  if (!whole || name === undefined) return whole
  const text = sources.value
  if (!text) return null
  const hunks = hunksWithin(
    whole.hunks,
    symbolLineRange(text.before, name),
    symbolLineRange(text.after, name)
  )
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added++
      else if (line.kind === 'del') removed++
    }
  }
  return { binary: whole.binary, hunks, added, removed }
})

watch([() => props.tabPath, git.status], () => void load(), { immediate: true })

const lineCount = computed(() => (shownDiff.value ? diffLineCount(shownDiff.value) : 0))
const truncated = computed(() => lineCount.value > MAX_RENDERED_DIFF_LINES)

/** The hunks to draw, cut at the render cap (whole hunks, then a partial one). */
const drawnHunks = computed((): DiffHunk[] => {
  if (!shownDiff.value) return []
  if (!truncated.value) return shownDiff.value.hunks
  const out: DiffHunk[] = []
  let budget = MAX_RENDERED_DIFF_LINES
  for (const hunk of shownDiff.value.hunks) {
    if (budget <= 1) break
    const lines = hunk.lines.slice(0, budget - 1)
    out.push(lines.length === hunk.lines.length ? hunk : { ...hunk, lines })
    budget -= lines.length + 1
  }
  return out
})

const splitHunks = computed(() => drawnHunks.value.map((hunk) => ({ hunk, rows: splitRows(hunk) })))

const hunkLabel = (hunk: DiffHunk): string =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.section}`

// ---- Actions ---------------------------------------------------------------

const toggleStage = (): void => {
  const file = entry.value
  if (!file) return
  void (side.value === 'staged' ? git.unstage([file.path]) : git.stage([file.path]))
}
</script>

<template>
  <div class="diff-view">
    <header class="diff-toolbar">
      <div class="diff-title">
        <span class="diff-path" :title="relPath">{{ relPath }}</span>
        <span v-if="symbol !== undefined" class="diff-symbol">{{ symbol }}</span>
        <span class="diff-side">{{
          side === 'staged' ? t('git.diff.sideStaged') : t('git.diff.sideWorking')
        }}</span>
        <template v-if="shownDiff && !shownDiff.binary && entry">
          <span class="diff-stat git-added">{{
            t('git.diff.added', { count: shownDiff.added })
          }}</span>
          <span class="diff-stat git-deleted">{{
            t('git.diff.removed', { count: shownDiff.removed })
          }}</span>
        </template>
      </div>
      <div class="diff-actions">
        <div v-if="canVisual" class="segmented" role="group">
          <button
            class="segmented-btn"
            :class="{ active: diffView === 'visual' }"
            @click="setDiffView('visual')"
          >
            {{ t('git.diff.visual') }}
          </button>
          <button
            class="segmented-btn"
            :class="{ active: diffView === 'text' }"
            @click="setDiffView('text')"
          >
            {{ t('git.diff.text') }}
          </button>
        </div>
        <div v-if="showVisual" class="segmented" role="group">
          <button
            class="segmented-btn"
            :class="{ active: version === 'diff' }"
            @click="version = 'diff'"
          >
            {{ t('git.visual.diff') }}
          </button>
          <button
            class="segmented-btn"
            :class="{ active: version === 'before' }"
            :disabled="!hasBefore"
            @click="version = 'before'"
          >
            {{ t('git.visual.before') }}
          </button>
          <button
            class="segmented-btn"
            :class="{ active: version === 'after' }"
            :disabled="deleted"
            @click="version = 'after'"
          >
            {{ t('git.visual.after') }}
          </button>
        </div>
        <select
          v-if="showVisual && unitOptions.length > 1"
          v-model.number="unit"
          class="field-sm"
          :title="t('git.diff.unitTitle')"
        >
          <option v-for="option in unitOptions" :key="option.unit" :value="option.unit">
            {{ option.label }}
          </option>
        </select>
        <div v-if="!showVisual" class="segmented" role="group">
          <button
            class="segmented-btn"
            :class="{ active: diffLayout === 'split' }"
            @click="setDiffLayout('split')"
          >
            {{ t('git.diff.split') }}
          </button>
          <button
            class="segmented-btn"
            :class="{ active: diffLayout === 'unified' }"
            @click="setDiffLayout('unified')"
          >
            {{ t('git.diff.unified') }}
          </button>
        </div>
        <button
          v-if="entry && !entry.conflicted"
          class="btn-outline btn-sm"
          :disabled="git.busy.value"
          @click="toggleStage"
        >
          <Icon :name="side === 'staged' ? 'minus' : 'plus'" />
          {{ side === 'staged' ? t('git.diff.unstage') : t('git.diff.stage') }}
        </button>
        <button
          v-if="!deleted && target"
          class="btn-outline btn-sm"
          @click="emit('open-file', target.filePath)"
        >
          <Icon name="file-doc" />
          {{ t('git.diff.openFile') }}
        </button>
      </div>
    </header>

    <div v-if="!entry" class="diff-message">{{ t('git.diff.notChanged') }}</div>
    <div v-else-if="loadError !== null" class="diff-message">
      {{ t('git.diff.error', { error: loadError }) }}
    </div>

    <VisualDiffView
      v-else-if="showVisual && model"
      :model="model"
      :version="version"
      :revision="sourcesRevision"
      :file-path="relPath"
    />
    <div v-else-if="showVisual && !loading" class="diff-message">
      {{ t('git.diff.unreadable') }}
    </div>

    <div v-else-if="showLoading" class="diff-message">{{ t('git.diff.loading') }}</div>
    <template v-else-if="shownDiff">
      <div v-if="shownDiff.binary" class="diff-message">{{ t('git.diff.binary') }}</div>
      <div v-else-if="shownDiff.hunks.length === 0" class="diff-message">
        {{ t('git.diff.noDifferences') }}
      </div>
      <div v-else class="diff-body">
        <p v-if="truncated" class="diff-truncated">
          {{ t('git.diff.truncated', { count: MAX_RENDERED_DIFF_LINES }) }}
        </p>

        <!-- Side by side: old on the left, new on the right, one grid row per pair. -->
        <div v-if="diffLayout === 'split'" class="diff-grid diff-split">
          <template v-for="(block, h) in splitHunks" :key="h">
            <div class="diff-hunk">{{ hunkLabel(block.hunk) }}</div>
            <template v-for="(row, r) in block.rows" :key="`${h}:${r}`">
              <span class="diff-no" :class="row.left?.kind">{{ row.left?.oldNo }}</span>
              <span class="diff-text left" :class="row.left ? row.left.kind : 'filler'">{{
                row.left?.text
              }}</span>
              <span class="diff-no" :class="row.right?.kind">{{ row.right?.newNo }}</span>
              <span class="diff-text" :class="row.right ? row.right.kind : 'filler'">{{
                row.right?.text
              }}</span>
            </template>
          </template>
        </div>

        <!-- Inline: both line numbers, then the line, marked by kind. -->
        <div v-else class="diff-grid diff-unified">
          <template v-for="(hunk, h) in drawnHunks" :key="h">
            <div class="diff-hunk">{{ hunkLabel(hunk) }}</div>
            <template v-for="(line, l) in hunk.lines" :key="`${h}:${l}`">
              <span class="diff-no" :class="line.kind">{{ line.oldNo }}</span>
              <span class="diff-no" :class="line.kind">{{ line.newNo }}</span>
              <span class="diff-text" :class="line.kind">{{ line.text }}</span>
            </template>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--vscode-bg-editor);
}

.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--vscode-border);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.diff-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.diff-path {
  font-family: var(--font-mono);
  font-size: var(--text-body);
  color: var(--vscode-text-light);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-symbol {
  font-family: var(--font-mono);
  font-size: var(--text-body);
  color: var(--vscode-text-light);
  white-space: nowrap;
}

.diff-side {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.diff-stat {
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
}

.diff-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.diff-message {
  padding: 24px;
  text-align: center;
  color: var(--vscode-text-muted);
  font-size: var(--text-body);
}

.diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.diff-truncated {
  margin: 0;
  padding: 8px 16px;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
  border-bottom: 1px solid var(--vscode-border);
}

.diff-grid {
  display: grid;
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
  line-height: 1.5;
}

.diff-split {
  grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
}

.diff-unified {
  grid-template-columns: auto auto minmax(0, 1fr);
}

.diff-hunk {
  grid-column: 1 / -1;
  padding: 4px 16px;
  color: var(--vscode-text-muted);
  background: var(--vscode-bg-sidebar);
  border-top: 1px solid var(--vscode-border);
  border-bottom: 1px solid var(--vscode-border);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-no {
  min-width: 48px;
  padding: 0 8px;
  text-align: right;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  line-height: calc(var(--text-body-sm) * 1.5);
  user-select: none;
}

/* Wrapped, not scrolled: a side-by-side pane that scrolls sideways loses its partner. */
.diff-text {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vscode-text);
}

.diff-split .diff-text.left {
  border-right: 1px solid var(--vscode-border);
}

.add {
  background: var(--vscode-success-subtle);
}

.del {
  background: var(--vscode-error-subtle);
}

.diff-text.filler {
  background: var(--vscode-bg-sidebar);
}
</style>
