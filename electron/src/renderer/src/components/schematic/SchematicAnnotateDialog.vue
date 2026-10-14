<script setup lang="ts">
import Modal from '../shared/Modal.vue'
import { computed, ref } from 'vue'
import { useModalKeys } from '../../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import type {
  AnnotateNumbering,
  AnnotateOrder,
  AnnotateRequest,
  AnnotateScope,
  AnnotationPlan
} from '../../lib/schematic/annotate'

/**
 * Annotate Schematic — KiCad's dialog of that name, in its vocabulary, trimmed
 * to the choices that change the result (`lib/schematic/annotate.ts`).
 *
 * A modal rather than a popover because it commits: the preview line says
 * how many designators the run will touch before the button is pressed, and
 * the run lands as one undo entry. The button is never disabled — a run that
 * changes nothing simply changes nothing; a greyed-out Annotate reads as "you
 * may not", which is never true. The preview line appears only when there is
 * something to say.
 *
 * Left out of KiCad's dialog on purpose: the "automatically annotate"
 * preference (placement already numbers, nothing ever sits as `R?`), the
 * annotation-messages log (the undo label and the preview line carry what it
 * would), and Clear Annotation (which turns every designator back into `R?`
 * — a state this app never produces and the agent surface cannot address).
 *
 * Every scope KiCad offers: the whole design lands as one undo entry across
 * every sheet it touches (`runCommand`'s sibling edits), the current sheet with
 * or without the sheets beneath it, or the selection.
 */
export type { AnnotateRequest, AnnotateScope }

const props = defineProps<{
  /** Symbols in the current selection; 0 disables the selection scope. */
  selectionCount: number
  /** What the run would do under these options — the preview, computed live. */
  plan: (request: AnnotateRequest) => AnnotationPlan
}>()

const emit = defineEmits<{
  (e: 'confirm', request: AnnotateRequest): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const scope = ref<AnnotateScope>('design')
const recurse = ref(true)
const order = ref<AnnotateOrder>('xy')
const numbering = ref<AnnotateNumbering>('sequential')
const start = ref(0)
const reset = ref(false)

const request = computed<AnnotateRequest>(() => ({
  scope: scope.value,
  recurse: recurse.value,
  order: order.value,
  numbering: numbering.value,
  start: Number.isFinite(start.value) ? start.value : 0,
  reset: reset.value
}))
const preview = computed(() => props.plan(request.value))

/** Typing in the start field is choosing that numbering, as in KiCad. */
const onStartInput = (event: Event): void => {
  const value = Number((event.target as HTMLInputElement).value)
  start.value = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  numbering.value = 'sequential'
}

/**
 * Escape abandons, Enter annotates (DESIGN.md §Modals). On `window`, because
 * this one opens with focus still on the toolbar button that opened it.
 */
useModalKeys({ confirm: () => emit('confirm', request.value) })
</script>

<template>
  <!-- Escape is handled on `window` above; the overlay only needs the click. -->
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">{{ t('schematicEditor.annotate.title') }}</h2>

      <div class="columns">
        <fieldset class="group">
          <legend class="eyebrow">{{ t('schematicEditor.annotate.scope') }}</legend>
          <label class="choice">
            <input v-model="scope" type="radio" value="design" />
            <span>{{ t('schematicEditor.annotate.scopeDesign') }}</span>
          </label>
          <label class="choice">
            <input v-model="scope" type="radio" value="sheet" />
            <span>{{ t('schematicEditor.annotate.scopeSheet') }}</span>
          </label>
          <label class="choice" :class="{ 'is-disabled': selectionCount === 0 }">
            <input
              v-model="scope"
              type="radio"
              value="selection"
              :disabled="selectionCount === 0"
            />
            <span>{{ t('schematicEditor.annotate.scopeSelection', selectionCount) }}</span>
          </label>
          <!-- Only "current sheet" has subsheets to recurse into or not: the
               whole design already includes them, a selection has none. -->
          <label class="choice recurse" :class="{ 'is-disabled': scope !== 'sheet' }">
            <input v-model="recurse" type="checkbox" :disabled="scope !== 'sheet'" />
            <span>{{ t('schematicEditor.annotate.recurse') }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend class="eyebrow">{{ t('schematicEditor.annotate.order') }}</legend>
          <label class="choice">
            <input v-model="order" type="radio" value="xy" />
            <span>{{ t('schematicEditor.annotate.orderXY') }}</span>
          </label>
          <label class="choice">
            <input v-model="order" type="radio" value="yx" />
            <span>{{ t('schematicEditor.annotate.orderYX') }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend class="eyebrow">{{ t('schematicEditor.annotate.options') }}</legend>
          <label class="choice">
            <input v-model="reset" type="radio" :value="false" />
            <span>{{ t('schematicEditor.annotate.optionsKeep') }}</span>
          </label>
          <label class="choice">
            <input v-model="reset" type="radio" :value="true" />
            <span>{{ t('schematicEditor.annotate.optionsReset') }}</span>
          </label>
        </fieldset>

        <fieldset class="group">
          <legend class="eyebrow">{{ t('schematicEditor.annotate.numbering') }}</legend>
          <label class="choice">
            <input v-model="numbering" type="radio" value="sequential" />
            <span>{{ t('schematicEditor.annotate.numberingAfter') }}</span>
            <input
              class="field-sm start"
              type="number"
              min="0"
              step="1"
              :value="start"
              :aria-label="t('schematicEditor.annotate.numberingAfter')"
              @input="onStartInput"
            />
          </label>
          <label class="choice">
            <input v-model="numbering" type="radio" value="sheet100" />
            <span>{{ t('schematicEditor.annotate.numberingSheet100') }}</span>
          </label>
          <label class="choice">
            <input v-model="numbering" type="radio" value="sheet1000" />
            <span>{{ t('schematicEditor.annotate.numberingSheet1000') }}</span>
          </label>
        </fieldset>
      </div>

      <p v-if="preview.changes.length" class="preview">
        {{
          t(
            'schematicEditor.annotate.preview',
            { changed: preview.changes.length, count: preview.considered },
            preview.considered
          )
        }}
      </p>

      <div class="actions">
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('schematicEditor.annotate.cancel') }}
        </button>
        <button class="btn-cta btn-md" type="button" @click="emit('confirm', request)">
          {{ t('schematicEditor.annotate.confirm') }}
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
  max-width: 640px;
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

/* KiCad's two-column layout: scope and options left, order and numbering right. */
.columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 24px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: none;
}

/* Section eyebrow per DESIGN.md §3. */
.eyebrow {
  padding: 0;
  margin-bottom: 2px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice input[type='radio'],
.choice input[type='checkbox'] {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.recurse {
  margin-top: 6px;
}

.choice.is-disabled {
  color: var(--vscode-text-muted);
  cursor: default;
}

/* The start number sits on the radio's own line, as in KiCad. */
.start {
  width: 64px;
  font-family: var(--font-mono);
}

/* Hint per DESIGN.md §3: caption size, muted. */
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
