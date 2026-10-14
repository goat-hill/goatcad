<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { pathInProject } from '../lib/displayPath'
import { useI18n } from 'vue-i18n'
import { fuzzyMatch } from '../lib/fuzzyMatch'
import { isOpenableFile } from '../lib/fileTypes'
import { isWelcomeTab, type Tab } from '../lib/tabs'

const { t } = useI18n()

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

const props = defineProps<{
  files: FileItem[]
  openTabs: Tab[]
  projectPath: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-file', node: { name: string; path: string }): void
}>()

interface Candidate {
  name: string
  path: string
  /** Project-relative display path with `/` separators. */
  relPath: string
}

const toRelPath = (path: string): string =>
  pathInProject(path, props.projectPath) ?? path.replace(/\\/g, '/').replace(/^\/+/, '')

// The project listing flattened to openable files. Files without an editor,
// viewer, or text route are dimmed in the explorer and skipped here outright —
// jumping to a file you can't read isn't a jump anywhere.
const allFiles = computed<Candidate[]>(() => {
  const out: Candidate[] = []
  const walk = (items: FileItem[]): void => {
    for (const item of items) {
      if (item.isDirectory) {
        if (item.children) walk(item.children)
      } else if (isOpenableFile(item.name)) {
        out.push({ name: item.name, path: item.path, relPath: toRelPath(item.path) })
      }
    }
  }
  walk(props.files)
  return out
})

const query = ref('')
const MAX_RESULTS = 50

interface ResultRow {
  candidate: Candidate
  /** Matched character indices into relPath (empty for the no-query listing). */
  indices: number[]
}

const results = computed<ResultRow[]>(() => {
  const q = query.value.trim()
  if (q === '') {
    // VS Code shows editor history here; ours is the open tabs (files only —
    // welcome and library-view tabs have no on-disk file), then the rest of
    // the project alphabetically.
    const rows: ResultRow[] = []
    const seen = new Set<string>()
    for (const tab of props.openTabs) {
      if (isWelcomeTab(tab.path) || tab.path.includes('://')) continue
      seen.add(tab.path)
      rows.push({
        candidate: { name: tab.name, path: tab.path, relPath: toRelPath(tab.path) },
        indices: []
      })
    }
    const rest = allFiles.value
      .filter((c) => !seen.has(c.path))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
    return [...rows, ...rest.map((candidate) => ({ candidate, indices: [] }))].slice(0, MAX_RESULTS)
  }
  const scored: { row: ResultRow; score: number }[] = []
  for (const candidate of allFiles.value) {
    const m = fuzzyMatch(q, candidate.relPath)
    if (m) scored.push({ row: { candidate, indices: m.indices }, score: m.score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.row.candidate.relPath.length - b.row.candidate.relPath.length ||
      a.row.candidate.relPath.localeCompare(b.row.candidate.relPath)
  )
  return scored.slice(0, MAX_RESULTS).map((s) => s.row)
})

const selectedIndex = ref(0)

watch(results, () => {
  selectedIndex.value = 0
})

const listEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  inputEl.value?.focus()
})

watch(selectedIndex, () => {
  void nextTick(() => {
    listEl.value?.querySelector('.quick-open-row.selected')?.scrollIntoView({ block: 'nearest' })
  })
})

const openRow = (row: ResultRow): void => {
  emit('open-file', { name: row.candidate.name, path: row.candidate.path })
}

const handleKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const count = results.value.length
    if (count === 0) return
    const delta = e.key === 'ArrowDown' ? 1 : -1
    selectedIndex.value = (selectedIndex.value + delta + count) % count
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const row = results.value[selectedIndex.value]
    if (row) openRow(row)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

// Split a row's text into plain/highlighted runs. `indices` address relPath;
// `start` is where this text begins within it (the basename is rendered
// separately from its directory).
interface Segment {
  text: string
  hit: boolean
}

const toSegments = (text: string, start: number, indices: number[]): Segment[] => {
  const hits = new Set(indices)
  const segments: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(start + i)
    const last = segments[segments.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else segments.push({ text: text[i], hit })
  }
  return segments
}

const rowDir = (row: ResultRow): string => {
  const rel = row.candidate.relPath
  return rel.slice(0, Math.max(0, rel.length - row.candidate.name.length - 1))
}

const nameSegments = (row: ResultRow): Segment[] =>
  toSegments(
    row.candidate.name,
    row.candidate.relPath.length - row.candidate.name.length,
    row.indices
  )

const dirSegments = (row: ResultRow): Segment[] => toSegments(rowDir(row), 0, row.indices)
</script>

<template>
  <div class="quick-open-overlay" @mousedown.self="emit('close')">
    <div class="quick-open-panel">
      <input
        ref="inputEl"
        v-model="query"
        class="quick-open-input"
        :placeholder="t('app.quickOpen.placeholder')"
        spellcheck="false"
        @keydown="handleKeydown"
      />
      <div ref="listEl" class="quick-open-list">
        <div
          v-for="(row, idx) in results"
          :key="row.candidate.path"
          class="quick-open-row"
          :class="{ selected: idx === selectedIndex }"
          @click="openRow(row)"
          @mousemove="selectedIndex = idx"
        >
          <span class="row-name">
            <template v-for="(seg, i) in nameSegments(row)" :key="i">
              <span v-if="seg.hit" class="hit">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <span v-if="rowDir(row)" class="row-dir">
            <template v-for="(seg, i) in dirSegments(row)" :key="i">
              <span v-if="seg.hit" class="hit">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </div>
        <div v-if="results.length === 0" class="quick-open-empty">
          {{ t('app.quickOpen.noResults') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-open-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.quick-open-panel {
  margin-top: 44px;
  width: min(560px, calc(100vw - 80px));
  background-color: var(--vscode-bg-sidebar);
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px var(--vscode-shadow-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.quick-open-input {
  margin: 8px;
  padding: 5px 8px;
  background-color: var(--vscode-bg-editor);
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  color: var(--vscode-text);
  font-size: 13px;
  outline: none;
}

.quick-open-input:focus {
  border-color: var(--vscode-accent);
}

.quick-open-list {
  max-height: 45vh;
  overflow-y: auto;
  padding-bottom: 4px;
}

.quick-open-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 12px;
  font-size: 13px;
  color: var(--vscode-text);
  cursor: pointer;
  white-space: nowrap;
}

.quick-open-row.selected {
  background-color: var(--vscode-bg-active);
}

.row-name {
  flex-shrink: 0;
}

.row-dir {
  font-size: 11px;
  color: var(--vscode-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.hit {
  color: var(--vscode-accent);
  font-weight: 600;
}

.quick-open-empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-text-muted);
}
</style>
