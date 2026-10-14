<script setup lang="ts">
import Modal from './shared/Modal.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { plannedUri, type AddLibraryMode, type AddLibraryPlan } from '../lib/libraryRegistration'

/**
 * Copy-or-reference, asked once per Add Library at project scope
 * (docs/projects.md §7.5 decision 2). Copy is preselected:
 * it is what makes the design self-contained, and it is the answer someone
 * adding a downloaded part file almost always wants.
 *
 * The URI line is the whole explanation — it shows the exact string the
 * `sym-lib-table` / `fp-lib-table` row will carry, so the difference between
 * the two options is visible rather than described.
 */
const props = defineProps<{
  plan: AddLibraryPlan
  /** The active project's directory — what `${KIPRJMOD}` resolves to. */
  projectDir: string
}>()

const emit = defineEmits<{
  (event: 'confirm', mode: AddLibraryMode): void
  (event: 'cancel'): void
}>()

const { t } = useI18n()

const mode = ref<AddLibraryMode>('copy')

const uri = computed(() => plannedUri(props.plan, mode.value, props.projectDir))
</script>

<template>
  <Modal @dismiss="emit('cancel')">
    <div class="dialog">
      <h2 class="dialog-title">{{ t('addLibrary.title', { name: plan.sourceName }) }}</h2>
      <p class="dialog-path">{{ plan.source }}</p>

      <div class="choice-list">
        <label class="choice">
          <input v-model="mode" type="radio" value="copy" />
          <span class="choice-name">{{ t('addLibrary.copy') }}</span>
        </label>
        <label class="choice">
          <input v-model="mode" type="radio" value="reference" />
          <span class="choice-name">{{ t('addLibrary.reference') }}</span>
        </label>
      </div>

      <p class="uri-label">{{ t('addLibrary.uriLabel') }}</p>
      <p class="uri-value">{{ uri }}</p>

      <div class="dialog-actions">
        <button class="dialog-btn" @click="emit('cancel')">{{ t('addLibrary.cancel') }}</button>
        <button class="dialog-btn primary" @click="emit('confirm', mode)">
          {{ t('addLibrary.add') }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  width: 90%;
  max-width: 440px;
  padding: 22px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

.dialog-title {
  margin: 0;
  color: var(--vscode-text-light);
  font-size: 16px;
  font-weight: 700;
}

.dialog-path {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--vscode-text-muted);
  font: 11px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.choice-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 18px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
}

.choice:hover {
  background: var(--vscode-overlay-control);
}

.choice-name {
  color: var(--vscode-text);
  font-size: 12px;
}

.uri-label {
  margin: 16px 0 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  font-weight: 600;
}

.uri-value {
  margin: 4px 0 0;
  color: var(--vscode-text);
  font: 12px var(--font-mono);
  word-break: break-all;
}

.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 22px;
}

.dialog-btn {
  padding: 6px 14px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  background: none;
  color: var(--vscode-text);
  font-size: 12px;
  cursor: pointer;
}

.dialog-btn:hover:not(:disabled) {
  border-color: var(--vscode-accent);
  color: var(--vscode-accent);
}

.dialog-btn.primary {
  border-color: var(--vscode-accent);
  background: var(--vscode-accent);
  color: var(--vscode-on-accent);
  font-weight: 600;
}

.dialog-btn.primary:hover:not(:disabled) {
  filter: brightness(1.08);
  color: var(--vscode-on-accent);
}
</style>
