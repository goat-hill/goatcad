<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './shared/Icon.vue'

/**
 * Read-only tab for files GoatCAD declines to open (unknown/binary types —
 * see lib/fileTypes.ts). Shows minimal stats and says plainly that the file
 * won't be opened, instead of dumping bytes into the text editor.
 */

const { t, locale } = useI18n()

const props = defineProps<{
  filePath: string
  name: string
}>()

const size = ref<number | null>(null)
const modifiedMs = ref<number | null>(null)
const statError = ref<string | null>(null)

const extension = computed(() => {
  const dot = props.name.lastIndexOf('.')
  return dot < 0 ? '' : props.name.slice(dot + 1).toUpperCase()
})

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const next of units) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

const sizeText = computed(() => (size.value === null ? '' : formatBytes(size.value)))
const modifiedText = computed(() =>
  modifiedMs.value === null
    ? ''
    : new Date(modifiedMs.value).toLocaleString(locale.value, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
)

onMounted(async () => {
  try {
    const res = await window.api.statFile(props.filePath)
    if (!res.success) throw new Error(res.error || 'stat failed')
    size.value = res.size ?? null
    modifiedMs.value = res.modifiedMs ?? null
  } catch (err: unknown) {
    console.error('Failed to stat file:', err)
    statError.value = err instanceof Error ? err.message : String(err)
  }
})
</script>

<template>
  <div class="file-info-viewer">
    <div class="file-info-card">
      <div class="file-glyph">
        <Icon name="file-doc" />
        <span v-if="extension" class="ext-badge">{{ extension }}</span>
      </div>

      <div class="file-name">{{ name }}</div>
      <div class="not-opened">{{ t('fileInfoViewer.notOpened') }}</div>

      <div v-if="!statError" class="stats">
        <div v-if="sizeText" class="stat-row">
          <span class="stat-label">{{ t('fileInfoViewer.size') }}</span>
          <span class="stat-value">{{ sizeText }}</span>
        </div>
        <div v-if="modifiedText" class="stat-row">
          <span class="stat-label">{{ t('fileInfoViewer.modified') }}</span>
          <span class="stat-value">{{ modifiedText }}</span>
        </div>
      </div>
      <div v-else class="stat-error">{{ statError }}</div>
    </div>
  </div>
</template>

<style scoped>
.file-info-viewer {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-bg, #151c19);
}

.file-info-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 420px;
  padding: 32px 40px;
  text-align: center;
}

.file-glyph {
  position: relative;
  width: 64px;
  height: 64px;
  margin-bottom: 10px;
  color: var(--vscode-border, #24302b);
}

.file-glyph svg {
  width: 100%;
  height: 100%;
}

.ext-badge {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--vscode-sidebar, #1a221f);
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-muted, #748780);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-caption);
  letter-spacing: 0.5px;
}

.file-name {
  color: var(--vscode-text-light, #ffffff);
  font-size: 14px;
  font-weight: 600;
  word-break: break-all;
}

.not-opened {
  color: var(--vscode-text-muted, #748780);
  font-size: 12px;
  margin-bottom: 12px;
}

.stats {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  font-size: 12px;
}

.stat-label {
  color: var(--vscode-text-muted, #748780);
}

.stat-value {
  color: var(--vscode-text, #c9d4cf);
  font-family: var(--font-mono, monospace);
}

.stat-error {
  color: var(--vscode-text-muted, #748780);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  max-width: 360px;
}
</style>
