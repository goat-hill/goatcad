<script setup lang="ts">
import Modal from '../shared/Modal.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalKeys } from '../../lib/modalKeys'
import Icon from '../shared/Icon.vue'
import { CLEANUP_OPTION_KEYS, type CleanupKind } from '../../lib/board/trackCleanup'
import { cleanupChoice, type CleanupRequest, type CleanupRow } from '../../lib/board/cleanupDialog'

/**
 * Clean up tracks and vias — KiCad's Cleanup Tracks & Vias: the passes of
 * `lib/board/trackCleanup.ts` with KiCad's options and defaults, narrowed by
 * the selection, a net or a layer, and their changes listed before anything is
 * written, re-read as the choices change. One apply, one undo step. The
 * passes and the refill are kept for the session; the filters start fresh.
 */
const props = defineProps<{
  nets: ReadonlyArray<{ number: number; name: string }>
  /** The board's copper layers, front to back. */
  layers: readonly string[]
  /** Tracks and vias selected: what "Selected items only" reaches; none disables it. */
  selected: number
  /** Open with "Selected items only" on. */
  selectionOnly?: boolean
  preview: (request: CleanupRequest) => Promise<CleanupRow[]>
  apply: (request: CleanupRequest) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

const selectionOnly = ref(!!props.selectionOnly && props.selected > 0)
const net = ref<number | null>(null)
const layer = ref<string | null>(null)

const request = computed((): CleanupRequest => ({
  options: { ...cleanupChoice.options },
  refill: cleanupChoice.refill,
  selectionOnly: selectionOnly.value,
  net: net.value,
  layer: layer.value
}))

const optionLabel = computed((): Record<(typeof CLEANUP_OPTION_KEYS)[number], string> => ({
  shorts: t('pcbEditor.cleanup.options.shorts'),
  redundantVias: t('pcbEditor.cleanup.options.redundantVias'),
  danglingVias: t('pcbEditor.cleanup.options.danglingVias'),
  mergeTracks: t('pcbEditor.cleanup.options.mergeTracks'),
  danglingTracks: t('pcbEditor.cleanup.options.danglingTracks'),
  tracksInPads: t('pcbEditor.cleanup.options.tracksInPads')
}))

const kindLabel = (kind: CleanupKind): string => {
  switch (kind) {
    case 'shorting-track':
      return t('pcbEditor.cleanup.change.shortingTrack')
    case 'shorting-via':
      return t('pcbEditor.cleanup.change.shortingVia')
    case 'redundant-via':
      return t('pcbEditor.cleanup.change.redundantVia')
    case 'duplicate-track':
      return t('pcbEditor.cleanup.change.duplicateTrack')
    case 'zero-length-track':
      return t('pcbEditor.cleanup.change.zeroLengthTrack')
    case 'track-in-pad':
      return t('pcbEditor.cleanup.change.trackInPad')
    case 'dangling-track':
      return t('pcbEditor.cleanup.change.danglingTrack')
    case 'dangling-via':
      return t('pcbEditor.cleanup.change.danglingVia')
    case 'merge-tracks':
      return t('pcbEditor.cleanup.change.mergeTracks')
  }
}

const rows = ref<CleanupRow[] | null>(null)
const loading = ref(false)
const applying = ref(false)
const failure = ref<string | null>(null)

/**
 * The dialog's size, taken once its first list is in and held while the
 * choices change: a list that resized round its rows would move the
 * checkboxes from under the pointer (as Update PCB holds its own).
 */
const dialogRef = ref<HTMLElement | null>(null)
const held = ref<{ width: number; height: number } | null>(null)

let asked = 0
const load = async (): Promise<void> => {
  const token = ++asked
  loading.value = true
  failure.value = null
  try {
    const answer = await props.preview(request.value)
    if (token !== asked) return
    rows.value = answer
  } catch (error) {
    if (token !== asked) return
    rows.value = null
    failure.value = error instanceof Error ? error.message : String(error)
  }
  loading.value = false
  if (!held.value) {
    await nextTick()
    const element = dialogRef.value
    if (element) held.value = { width: element.offsetWidth, height: element.offsetHeight }
  }
}
watch(request, () => void load(), { immediate: true, deep: true })

const count = computed(() => rows.value?.length ?? 0)

const confirm = async (): Promise<void> => {
  if (!count.value || loading.value || applying.value) return
  applying.value = true
  try {
    await props.apply(request.value)
    emit('close')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    applying.value = false
  }
}

// Enter applies (DESIGN.md §Modals); Escape is the dialog's own (shared/Modal.vue).
useModalKeys({ confirm: () => void confirm() })
</script>

<template>
  <Modal @dismiss="emit('close')">
    <div
      ref="dialogRef"
      class="dialog"
      :style="held ? { width: `${held.width}px`, minHeight: `${held.height}px` } : undefined"
    >
      <h2 class="dialog-title">
        <Icon name="tool-cleanup" class="title-icon" />
        {{ t('pcbEditor.cleanup.title') }}
      </h2>

      <div class="columns">
        <fieldset class="group">
          <legend class="eyebrow">{{ t('pcbEditor.cleanup.actions') }}</legend>
          <label class="choice">
            <input v-model="cleanupChoice.refill" type="checkbox" />
            <span>{{ t('pcbEditor.cleanup.refill') }}</span>
          </label>
          <label v-for="key in CLEANUP_OPTION_KEYS" :key="key" class="choice">
            <input v-model="cleanupChoice.options[key]" type="checkbox" />
            <span>{{ optionLabel[key] }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend class="eyebrow">{{ t('pcbEditor.cleanup.filter') }}</legend>
          <label class="choice" :class="{ disabled: selected === 0 }">
            <input v-model="selectionOnly" type="checkbox" :disabled="selected === 0" />
            <span>{{ t('pcbEditor.cleanup.selectionOnly', { count: selected }, selected) }}</span>
          </label>
          <label class="field">
            <span>{{ t('pcbEditor.cleanup.net') }}</span>
            <select v-model="net" class="field-sm mono">
              <option :value="null">{{ t('pcbEditor.cleanup.allNets') }}</option>
              <option v-for="option in nets" :key="option.number" :value="option.number">
                {{ option.name }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('pcbEditor.cleanup.layer') }}</span>
            <select v-model="layer" class="field-sm mono">
              <option :value="null">{{ t('pcbEditor.cleanup.allLayers') }}</option>
              <option v-for="name in layers" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </fieldset>
      </div>

      <div class="changes">
        <p v-if="failure" class="error">{{ failure }}</p>
        <p v-else-if="loading && !rows" class="hint">{{ t('pcbEditor.cleanup.loading') }}</p>
        <p v-else-if="rows && !rows.length" class="hint">{{ t('pcbEditor.cleanup.clean') }}</p>
        <!-- A read table (DESIGN.md §Tables, §The data surface). -->
        <table v-else-if="rows" class="table" :class="{ stale: loading }">
          <thead>
            <tr>
              <th>{{ t('pcbEditor.cleanup.columns.change') }}</th>
              <th>{{ t('pcbEditor.cleanup.columns.net') }}</th>
              <th>{{ t('pcbEditor.cleanup.columns.layer') }}</th>
              <th class="num">{{ t('pcbEditor.cleanup.columns.at') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td class="change" :class="row.kind === 'merge-tracks' ? 'is-edited' : 'is-removed'">
                {{ kindLabel(row.kind) }}
              </td>
              <td class="mono key">{{ row.net }}</td>
              <td class="mono">{{ row.layer }}</td>
              <td class="mono num">{{ row.at }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="actions">
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          class="btn-cta btn-md"
          type="button"
          :disabled="!count || loading || applying"
          @click="confirm"
        >
          {{ t('pcbEditor.cleanup.confirm', { count }, count) }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: max-content;
  min-width: min(640px, 90vw);
  max-width: min(1200px, 92vw);
  max-height: 80vh;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

/* Only the list gives way to a short window. */
.dialog > * {
  flex-shrink: 0;
}

/* The command's glyph before its name (DESIGN.md §Modals). */
.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

.title-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: var(--vscode-text-light);
}

/* What it does beside what it reaches, as KiCad's dialog sets them. */
.columns {
  display: flex;
  gap: 24px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.group > legend {
  margin-bottom: 8px;
  padding: 0;
}

/* Section eyebrow per DESIGN.md §Section eyebrows. */
.eyebrow {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice.disabled {
  opacity: 0.5;
  cursor: default;
}

.choice input[type='checkbox'] {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.field {
  display: grid;
  grid-template-columns: 48px minmax(160px, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
}

/* The list scrolls on the data surface; the choices and buttons stay put. */
.changes {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  background-color: var(--vscode-data-bg);
}

.changes > .hint,
.changes > .error {
  padding: 12px;
}

/* DESIGN.md §Tables: caption headers, ruled rows, body-sm inside a larger surface. */
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-body-sm);
}

/* A list being re-read for new choices. */
.table.stale {
  opacity: 0.5;
}

.table th {
  position: sticky;
  top: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-border);
  background-color: var(--vscode-bg-sidebar);
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
}

.table td {
  padding: 4px 12px;
  border-bottom: 1px solid var(--vscode-border);
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.table tr:last-child td {
  border-bottom: none;
}

.table td.key {
  color: var(--vscode-data-fg);
}

.mono {
  font-family: var(--font-mono);
}

/* Numbers right (DESIGN.md §Sheets). */
.table .num {
  text-align: right;
}

/* The Change cell in the hues Update PCB's use: removed, or edited. */
.change.is-removed {
  color: var(--vscode-error);
}

.change.is-edited {
  color: var(--vscode-warning);
}

.hint {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.error {
  margin: 0;
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (prefers-reduced-motion: no-preference) {
  .table {
    transition: opacity 70ms;
  }
}
</style>
