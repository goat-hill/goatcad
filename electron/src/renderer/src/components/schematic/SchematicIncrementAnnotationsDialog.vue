<script setup lang="ts">
import Modal from '../shared/Modal.vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useModalKeys } from '../../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import type { AnnotationPlan } from '../../lib/schematic/annotate'

/**
 * KiCad's Increment Annotations From… (`planIncrementAnnotations`): every
 * designator with the start's prefix, numbered at or above it, moves up by
 * the increment — on the sheet on screen or on all of them. The preview line
 * says how many before the button commits the run as one undo step.
 */
export interface IncrementRequest {
  first: string
  increment: number
  allSheets: boolean
}

const props = defineProps<{
  /** The start field's first value: the lone selected symbol's designator. */
  initial: string
  plan: (request: IncrementRequest) => AnnotationPlan
}>()

const emit = defineEmits<{
  (e: 'confirm', request: IncrementRequest): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const first = ref(props.initial)
const increment = ref(1)
const allSheets = ref(false)
const firstInput = ref<HTMLInputElement | null>(null)

const request = computed<IncrementRequest>(() => ({
  first: first.value,
  increment: increment.value,
  allSheets: allSheets.value
}))
const preview = computed(() => props.plan(request.value))

/** KiCad's spinner runs 1 to 64. */
const onIncrementInput = (event: Event): void => {
  const value = Math.floor(Number((event.target as HTMLInputElement).value))
  increment.value = Number.isFinite(value) ? Math.min(64, Math.max(1, value)) : 1
}

const confirm = (): void => {
  if (preview.value.changes.length) emit('confirm', request.value)
  else emit('close')
}

// Enter applies (DESIGN.md §Modals); the fields confirm on Enter themselves.
useModalKeys({ confirm })
onMounted(() => void nextTick(() => firstInput.value?.select()))
</script>

<template>
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">{{ t('schematicEditor.incrementAnnotations.title') }}</h2>

      <div class="fields">
        <label class="field-label" for="increment-first">
          {{ t('schematicEditor.incrementAnnotations.first') }}
        </label>
        <input
          id="increment-first"
          ref="firstInput"
          v-model="first"
          class="field-md"
          type="text"
          spellcheck="false"
          @keydown.enter.prevent="confirm"
        />
        <label class="field-label" for="increment-by">
          {{ t('schematicEditor.incrementAnnotations.increment') }}
        </label>
        <input
          id="increment-by"
          class="field-md step"
          type="number"
          min="1"
          max="64"
          step="1"
          :value="increment"
          @input="onIncrementInput"
          @keydown.enter.prevent="confirm"
        />
      </div>

      <fieldset class="group">
        <label class="choice">
          <input v-model="allSheets" type="radio" :value="false" />
          <span>{{ t('schematicEditor.incrementAnnotations.currentSheet') }}</span>
        </label>
        <label class="choice">
          <input v-model="allSheets" type="radio" :value="true" />
          <span>{{ t('schematicEditor.incrementAnnotations.allSheets') }}</span>
        </label>
      </fieldset>

      <p v-if="preview.changes.length" class="preview">
        {{ t('schematicEditor.incrementAnnotations.preview', preview.changes.length) }}
      </p>

      <div class="actions">
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('schematicEditor.incrementAnnotations.cancel') }}
        </button>
        <button class="btn-cta btn-md" type="button" @click="confirm">
          {{ t('schematicEditor.incrementAnnotations.confirm') }}
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
  width: 90%;
  max-width: 420px;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

.dialog-title {
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

/* Label beside field, KiCad's two-column form. */
.fields {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px 12px;
}

.field-label {
  color: var(--vscode-text);
  font-size: var(--text-body);
}

.step {
  width: 80px;
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

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice input[type='radio'] {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.preview {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
