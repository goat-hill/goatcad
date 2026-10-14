<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from './Icon.vue'
import { renderMarkdown, workspaceMediaUrl } from '../workspace'

const props = defineProps<{ worktree: string }>()

const entries = ref<WorkspaceEntry[]>([])
const selected = ref<WorkspaceEntry | null>(null)
const loading = ref(false)
// Rendered HTML for the selected markdown, or raw text for a text file.
const text = ref('')

const WORKSPACE_ICONS: Record<WorkspaceKind, string> = {
  image: '▦',
  video: '▶',
  markdown: '¶',
  text: '¶',
  html: '❮❯',
  other: '•'
}

function iconFor(kind: WorkspaceKind): string {
  return WORKSPACE_ICONS[kind]
}

function mediaUrl(entry: WorkspaceEntry): string {
  return workspaceMediaUrl(entry.path)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

async function select(entry: WorkspaceEntry): Promise<void> {
  selected.value = entry
  text.value = ''
  if (entry.kind === 'markdown' || entry.kind === 'text') {
    const url = workspaceMediaUrl(entry.path)
    try {
      const raw = await fetch(url).then((r) => r.text())
      text.value = entry.kind === 'markdown' ? renderMarkdown(raw, url) : raw
    } catch {
      text.value = ''
    }
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    entries.value = await window.api.listWorkspace(props.worktree)
  } catch {
    entries.value = []
  } finally {
    loading.value = false
  }
  const stillThere = selected.value && entries.value.find((e) => e.path === selected.value?.path)
  if (stillThere) void select(stillThere)
  else if (entries.value[0]) void select(entries.value[0])
  else selected.value = null
}

watch(() => props.worktree, load, { immediate: true })

// A .goatherd/ path resolved to a media URL isn't openable by the OS, so hand
// shell.openPath the real absolute path for files GoatHerd can't preview inline.
function openExternally(entry: WorkspaceEntry): void {
  void window.api.openPath(entry.path)
}

// Intercept clicks on links inside rendered markdown: web links go to the
// browser, local (media-scheme) links open in their default app.
function onDocClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement)?.closest('a')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:/i.test(href)) void window.api.openExternal(href)
  else if (href.startsWith('goatherd-media://')) {
    try {
      void window.api.openPath(decodeURIComponent(new URL(href).pathname))
    } catch {
      // ignore malformed hrefs
    }
  }
}
</script>

<template>
  <div class="workspace-view">
    <header class="workspace-view-head">
      <span class="ws-dir">.goatherd/</span>
      <button class="ws-refresh" title="Rescan .goatherd/" @click="load">
        <Icon name="refresh" />
      </button>
    </header>

    <div v-if="!loading && !entries.length" class="workspace-empty">
      <p class="ws-empty-title">No demos yet</p>
      <p class="ws-empty-hint">
        Drop screenshots, recordings, or a <code>.md</code>/<code>.html</code> writeup into
        <code>.goatherd/</code> in this worktree and they show up here.
      </p>
    </div>

    <div v-else class="workspace-body">
      <ul class="workspace-list">
        <li
          v-for="entry in entries"
          :key="entry.path"
          :class="{ active: entry.path === selected?.path }"
          @click="select(entry)"
        >
          <img v-if="entry.kind === 'image'" class="ws-thumb" :src="mediaUrl(entry)" alt="" />
          <span v-else class="ws-thumb ws-thumb-icon">{{ iconFor(entry.kind) }}</span>
          <span class="ws-meta">
            <span class="ws-name">{{ entry.relPath }}</span>
            <span class="ws-sub">{{ formatBytes(entry.size) }}</span>
          </span>
        </li>
      </ul>

      <div class="workspace-preview">
        <template v-if="selected">
          <img
            v-if="selected.kind === 'image'"
            class="ws-media"
            :src="mediaUrl(selected)"
            :alt="selected.name"
          />
          <video
            v-else-if="selected.kind === 'video'"
            class="ws-media"
            :src="mediaUrl(selected)"
            controls
            autoplay
            muted
            loop
          ></video>
          <iframe
            v-else-if="selected.kind === 'html'"
            class="ws-frame"
            :src="mediaUrl(selected)"
            sandbox="allow-same-origin"
          ></iframe>
          <!-- renderMarkdown escapes all source HTML before building this
               string, so no author markup (or script) reaches the DOM. -->
          <!-- eslint-disable vue/no-v-html -->
          <div
            v-else-if="selected.kind === 'markdown'"
            class="ws-doc"
            @click="onDocClick"
            v-html="text"
          ></div>
          <!-- eslint-enable vue/no-v-html -->
          <pre v-else-if="selected.kind === 'text'" class="ws-text">{{ text }}</pre>
          <div v-else class="ws-other">
            <p>{{ selected.name }}</p>
            <button @click="openExternally(selected)">Open externally</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-view {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.workspace-view-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.workspace-view-head .ws-dir {
  font-family: monospace;
  font-size: 11px;
  color: var(--dim);
}

.workspace-view-head .ws-refresh {
  margin-left: auto;
  background: transparent;
  border: none;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  border-radius: 3px;
}

.workspace-view-head .ws-refresh:hover {
  background: var(--hover);
  color: var(--accent);
}

.workspace-view-head .ws-refresh svg {
  width: 11px;
  height: 11px;
}

.workspace-view .workspace-body {
  flex: 1;
  min-height: 0;
}
</style>
