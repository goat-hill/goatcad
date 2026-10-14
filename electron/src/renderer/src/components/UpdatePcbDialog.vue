<script setup lang="ts">
import Modal from './shared/Modal.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalKeys } from '../lib/modalKeys'
import Icon from './shared/Icon.vue'
import type { BoardAgentError, SyncPreview } from '../lib/board/boardAgent'
import { scopePlan, type SyncSkipReason } from '../lib/board/boardSync'
import {
  syncPreviewRows,
  syncWouldChange,
  type SyncPreviewRow,
  type SyncRowChange,
  type UpdatePcbOptions
} from '../lib/board/syncPreview'
import { displayFilePath } from '../lib/displayPath'

/**
 * Update PCB from Schematic — KiCad's dialog of that name: the dry run of the
 * board sync (`lib/board/boardSync.ts`) listed before anything is written, then
 * one apply. The apply goes through the same path as the agent's `board.sync`,
 * so on a board with an open tab it is one step on that editor's undo list.
 *
 * It lists, as a table, the footprints the update adds, finds no symbol for,
 * and updates: reference, value, footprint, and what changes. Bookkeeping it
 * also rewrites (sheet names, links, pin types) is applied, not listed. Of
 * KiCad's options it offers the three a board
 * kept in sync uses — replace footprints, delete footprints with no symbols,
 * update fields — and toggling one re-reads the plan, as KiCad re-runs its
 * dry run. Matching is by the symbol link, re-linked by reference only for a
 * footprint with none; groups, design blocks, locks and removing extra fields
 * are not offered. Like KiCad, it refuses a schematic with unannotated parts.
 */
const props = defineProps<{
  /** The project's boards, absolute paths; the first is chosen when there are several. */
  boards: string[]
  /** The board to open on (the Properties panel's own); else the first. */
  initialBoard?: string | null
  /** The project folder, so a file inside it is named from there. */
  projectDir?: string | null
  /** The root schematic the update reads, named beside the board. */
  schematic?: string | null
  preview: (board: string) => Promise<SyncPreview | BoardAgentError>
  /** Apply to one board; answers the refusal, or null when it landed. */
  apply: (board: string, options: UpdatePcbOptions) => Promise<BoardAgentError | null>
}>()

const emit = defineEmits<{
  (e: 'applied', board: string): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const board = ref(props.initialBoard ?? props.boards[0] ?? '')
// KiCad's defaults: replace and update fields on, delete off.
const options = ref<UpdatePcbOptions>({ prune: false, replaceFootprints: true, updateFields: true })
const loading = ref(false)
const applying = ref(false)
const result = ref<SyncPreview | BoardAgentError | null>(null)

/**
 * The dialog's size, taken once its list is in and held while the options are
 * toggled: a toggle changes the rows, and a sheet that resized round them
 * would move the checkboxes from under the pointer. A new board's list takes
 * its own measure.
 */
const dialogRef = ref<HTMLElement | null>(null)
const held = ref<{ width: number; height: number } | null>(null)
const hold = async (): Promise<void> => {
  held.value = null
  await nextTick()
  const element = dialogRef.value
  if (element) held.value = { width: element.offsetWidth, height: element.offsetHeight }
}

const load = async (): Promise<void> => {
  loading.value = true
  const target = board.value
  const answer = await props.preview(target)
  // A slow plan for a board no longer chosen must not overwrite the current one.
  if (target !== board.value) return
  result.value = answer
  loading.value = false
  await hold()
}
watch(board, () => void load(), { immediate: true })

const shownPath = (path: string): string =>
  displayFilePath(path, props.projectDir, window.api.homeDir)

const plan = computed(() =>
  result.value && 'plan' in result.value ? scopePlan(result.value.plan, options.value) : null
)
const error = computed(() => (result.value && 'error' in result.value ? result.value : null))
const rows = computed(() => (plan.value ? syncPreviewRows(plan.value) : null))
const changes = computed(() =>
  plan.value ? syncWouldChange(plan.value, options.value.prune) : false
)

const choices = computed(() => [
  { key: 'replaceFootprints' as const, label: t('app.updatePcb.replace') },
  { key: 'prune' as const, label: t('app.updatePcb.prune') },
  { key: 'updateFields' as const, label: t('app.updatePcb.fields') }
])

const errorText = computed((): string => {
  const failure = error.value
  if (!failure) return ''
  if (failure.error === 'no-board') return t('app.updatePcb.errors.noBoard')
  if (failure.error === 'no-schematic') return t('app.updatePcb.errors.noSchematic')
  if (failure.error === 'not-annotated')
    return t('app.updatePcb.errors.notAnnotated', {
      references: (failure.candidates ?? []).join(', ')
    })
  return failure.detail ? `${failure.error}: ${failure.detail}` : failure.error
})

const changeLabel = (change: SyncRowChange): string => {
  switch (change) {
    case 'reference':
      return t('app.updatePcb.change.reference')
    case 'value':
      return t('app.updatePcb.change.value')
    case 'footprint':
      return t('app.updatePcb.change.footprint')
    case 'nets':
      return t('app.updatePcb.change.nets')
    case 'fields':
      return t('app.updatePcb.change.fields')
    case 'attributes':
      return t('app.updatePcb.change.attributes')
  }
}

/** A row's Change cell: what the update does to the footprint, in its kind's hue. */
const changeText = (row: SyncPreviewRow): string => {
  if (row.problem) return skipLabel(row.problem, row.libId)
  if (row.kind === 'add') return t('app.updatePcb.change.added')
  if (row.kind === 'remove')
    return options.value.prune ? t('app.updatePcb.change.deleted') : t('app.updatePcb.change.kept')
  const text = row.changes.map(changeLabel).join(', ')
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}
const changeTone = (row: SyncPreviewRow): string => {
  if (row.problem) return 'is-warn'
  if (row.kind === 'add') return 'is-added'
  if (row.kind === 'remove') return options.value.prune ? 'is-removed' : 'is-kept'
  return 'is-edited'
}

const skipLabel = (reason: SyncSkipReason, libId: string): string => {
  if (reason === 'no-footprint') return t('app.updatePcb.skip.noFootprint')
  if (reason === 'footprint-not-found') return t('app.updatePcb.skip.footprintNotFound', { libId })
  return t('app.updatePcb.skip.noUuid')
}

const confirm = async (): Promise<void> => {
  if (!changes.value || loading.value || applying.value) return
  applying.value = true
  const failure = await props.apply(board.value, { ...options.value })
  applying.value = false
  if (failure) {
    result.value = failure
    return
  }
  emit('applied', board.value)
}

// Enter updates (DESIGN.md §Modals); Escape is the dialog's own (shared/Modal.vue).
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
        <Icon name="refresh" class="title-icon" />
        {{ t('app.updatePcb.title') }}
      </h2>

      <!-- What the update reads and what it writes, from the project folder. -->
      <p class="files">
        <span v-if="schematic" class="file">{{ shownPath(schematic) }}</span>
        <Icon v-if="schematic" name="chevron-right" class="arrow" />
        <select
          v-if="boards.length > 1"
          v-model="board"
          class="field-sm board-select"
          :aria-label="t('app.updatePcb.board')"
        >
          <option v-for="path in boards" :key="path" :value="path">{{ shownPath(path) }}</option>
        </select>
        <span v-else-if="board" class="file">{{ shownPath(board) }}</span>
      </p>

      <fieldset class="group">
        <legend class="eyebrow">{{ t('app.updatePcb.options') }}</legend>
        <label v-for="choice in choices" :key="choice.key" class="choice">
          <input v-model="options[choice.key]" type="checkbox" />
          <span>{{ choice.label }}</span>
        </label>
      </fieldset>

      <div class="changes">
        <p v-if="loading" class="hint">{{ t('app.updatePcb.loading') }}</p>
        <p v-else-if="error" class="error">{{ errorText }}</p>
        <p v-else-if="rows && !rows.length" class="hint">{{ t('app.updatePcb.upToDate') }}</p>
        <!-- A read table (DESIGN.md §Tables, §The data surface). -->
        <table v-else-if="rows" class="table">
          <thead>
            <tr>
              <th>{{ t('app.updatePcb.columns.reference') }}</th>
              <th>{{ t('app.updatePcb.columns.value') }}</th>
              <th>{{ t('app.updatePcb.columns.footprint') }}</th>
              <th>{{ t('app.updatePcb.columns.change') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="`${row.kind}:${row.reference}`">
              <td class="mono key">
                <template v-if="row.referenceFrom !== undefined">
                  {{ row.referenceFrom }}
                  <Icon name="chevron-right" class="arrow" />
                </template>
                {{ row.reference }}
              </td>
              <td :class="{ changed: row.valueFrom !== undefined }">
                <template v-if="row.valueFrom !== undefined">
                  {{ row.valueFrom }}
                  <Icon name="chevron-right" class="arrow" />
                </template>
                {{ row.value }}
              </td>
              <td class="mono" :class="{ changed: row.libIdFrom !== undefined }">
                <template v-if="row.libIdFrom !== undefined">
                  {{ row.libIdFrom }}
                  <Icon name="chevron-right" class="arrow" />
                </template>
                {{ row.libId }}
              </td>
              <td class="change" :class="changeTone(row)">{{ changeText(row) }}</td>
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
          :disabled="!changes || loading || applying"
          @click="confirm"
        >
          {{ t('app.updatePcb.confirm') }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
/* As wide as the table needs, so no reference or footprint is cut short;
   past the window's room the table scrolls sideways instead. */
.dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: max-content;
  min-width: min(560px, 90vw);
  max-width: min(1200px, 92vw);
  max-height: 80vh;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

/* Only the list gives way to a short window: the title, path, options and
   buttons keep their height, where shrinking clipped a line in half. */
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

/* Schematic › board, from the project folder. */
.files {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 0;
  color: var(--vscode-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}

.file {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-select {
  min-width: 0;
  font-family: var(--font-mono);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: none;
}

.group > legend {
  margin-bottom: 6px;
  padding: 0;
}

/* Section eyebrow per DESIGN.md §3. */
.eyebrow {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* The table scrolls on the data surface; the options and buttons stay put,
   and a list shortened by a toggle leaves its room empty below. */
.changes {
  flex: 1 1 auto;
  min-height: 48px;
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

/* The key column and what the update changes read at full strength. */
.table td.key,
.table td.changed {
  color: var(--vscode-data-fg);
}

.mono {
  font-family: var(--font-mono);
}

/* The Change cell in the add / remove / update hues the board's button counts use. */
.change.is-added {
  color: var(--vscode-success);
}

.change.is-removed {
  color: var(--vscode-error);
}

.change.is-edited,
.change.is-warn {
  color: var(--vscode-warning);
}

.change.is-kept {
  color: var(--vscode-text-muted);
}

/* An inline glyph the size of the text it sits in: an Icon's svg has none of its own. */
.arrow {
  width: 1em;
  height: 1em;
  vertical-align: middle;
  color: var(--vscode-text-muted);
}

/* Hint per DESIGN.md §3. */
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

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice input[type='checkbox'] {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
