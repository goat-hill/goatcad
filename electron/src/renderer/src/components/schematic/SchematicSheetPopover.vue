<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { validateFileName } from '../../lib/fileMenu'

/**
 * In-place naming for a freshly drawn child sheet: a sheet name then a file
 * name whose `.kicad_sch` suffix is fixed. Anchored at the drawn
 * rectangle so it reads as editing the sheet itself. Tab advances name → file,
 * Enter commits (only when the file name is valid and free), Escape cancels the
 * whole operation. Collision/reserved-name checks reuse the explorer's
 * `validateFileName` against the sibling file list.
 */
const props = defineProps<{
  /** Container-relative pixel position to anchor at (the rectangle corner). */
  screen: { x: number; y: number }
  /** Default stem for both fields (a unique `sheet`, `sheet-1`, …). */
  defaultStem: string
  /** Existing sibling file names in the target directory, for collision checks. */
  siblings: string[]
}>()

const emit = defineEmits<{
  (event: 'commit', name: string, fileStem: string): void
  (event: 'cancel'): void
}>()

const { t } = useI18n()

const name = ref(props.defaultStem)
const fileStem = ref(props.defaultStem)
const nameInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const fileName = computed(() => `${fileStem.value.trim()}.kicad_sch`)
const nameError = computed(() => validateFileName(fileName.value, props.siblings))
const canCommit = computed(() => name.value.trim().length > 0 && nameError.value === null)

const commit = (): void => {
  if (canCommit.value) emit('commit', name.value.trim(), fileStem.value.trim())
}

const focusFile = (): void => {
  void nextTick(() => fileInput.value?.focus())
}

onMounted(() => {
  nameInput.value?.focus()
  nameInput.value?.select()
})
</script>

<template>
  <div
    class="sheet-popover"
    :style="{ left: `${screen.x}px`, top: `${screen.y}px` }"
    @mousedown.stop
    @keydown.stop
  >
    <label class="field-label">{{ t('schematicEditor.sheetPopover.nameLabel') }}</label>
    <input
      ref="nameInput"
      v-model="name"
      class="popover-input"
      spellcheck="false"
      :placeholder="t('schematicEditor.sheetPopover.namePlaceholder')"
      @keydown.enter.prevent="focusFile"
      @keydown.tab.prevent="focusFile"
      @keydown.esc.prevent="emit('cancel')"
    />
    <label class="field-label">{{ t('schematicEditor.sheetPopover.fileLabel') }}</label>
    <div class="file-row" :class="{ invalid: nameError }">
      <input
        ref="fileInput"
        v-model="fileStem"
        class="popover-input file-input"
        spellcheck="false"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="emit('cancel')"
      />
      <span class="suffix">.kicad_sch</span>
    </div>
    <p v-if="nameError" class="error">{{ t('schematicEditor.sheetPopover.invalidName') }}</p>
  </div>
</template>

<style scoped>
.sheet-popover {
  position: absolute;
  z-index: 14;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px;
  background: var(--vscode-overlay-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
}

.field-label {
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.popover-input {
  min-width: 180px;
  padding: 4px 7px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  background: var(--vscode-input-bg);
  color: var(--vscode-text, #d8e0dc);
  font: var(--text-body-sm) var(--font-mono);
  outline: none;
}

.popover-input:focus {
  border-color: var(--vscode-accent, #cca250);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.file-input {
  min-width: 120px;
  flex: 1;
}

.file-row.invalid .file-input {
  border-color: var(--vscode-error, #d9534f);
}

.suffix {
  color: var(--vscode-text-muted, #748780);
  font: 11px var(--font-mono);
}

.error {
  margin: 1px 0 0;
  color: var(--vscode-error, #d9534f);
  font-size: var(--text-body-sm);
  max-width: 220px;
}
</style>
