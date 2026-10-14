<script setup lang="ts">
/**
 * The 3D board view's switches: the physical layers, then the classes of
 * component model, then one reset for all of them.
 *
 * Rows are a two-column grid of identical checkboxes, like
 * `SelectionFilterPanel`: the label *is* the content, so a second column
 * halves the height at no cost to legibility.
 *
 * Like that panel, this reads and writes the shared store directly rather than
 * emitting up. The options are app-global with no owning editor, so a round
 * trip through the viewport would add plumbing and no control.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import {
  board3dViewState,
  isDefaultBoard3DView,
  resetBoard3DView,
  setBoard3DView,
  type Board3DViewState
} from '../../lib/board3dView'

const { t } = useI18n()

/**
 * `footprint` is the footprint editor's 3D pane: the same switches without the
 * assembly-class filters — there is exactly one part, and hiding it by its
 * `(attr …)` would read as the preview being broken.
 */
const props = defineProps<{ subject: 'board' | 'footprint' }>()

const state = board3dViewState()
const isDefault = computed(() => isDefaultBoard3DView(state.value))

const LAYER_KEYS = [
  'boardBody',
  'copper',
  'solderMask',
  'solderPaste',
  'silkscreen',
  'holes',
  'drawings',
  'axes',
  'gauge'
] as const satisfies readonly (keyof Board3DViewState)[]

/** Qualified by the master switch above them, so they indent and disable with it. */
const MODEL_KEYS = [
  'modelsThroughHole',
  'modelsSmd',
  'modelsUnspecified',
  'modelsDnp',
  'modelsNotInPosFiles'
] as const satisfies readonly (keyof Board3DViewState)[]

const set = (key: keyof Board3DViewState, event: Event): void =>
  setBoard3DView({ [key]: (event.target as HTMLInputElement).checked })
</script>

<template>
  <div class="board3d-options">
    <div class="options-grid">
      <label v-for="key in LAYER_KEYS" :key="key" class="option-row">
        <input type="checkbox" :checked="state[key]" @change="set(key, $event)" />
        <span>{{ t(`pcbEditor.viewport3d.options.${key}`) }}</span>
      </label>
    </div>

    <label class="option-row option-group">
      <input type="checkbox" :checked="state.models" @change="set('models', $event)" />
      <span>{{ t('pcbEditor.viewport3d.options.models') }}</span>
    </label>
    <div v-if="props.subject === 'board'" class="options-grid">
      <label
        v-for="key in MODEL_KEYS"
        :key="key"
        class="option-row option-child"
        :class="{ disabled: !state.models }"
      >
        <input
          type="checkbox"
          :checked="state[key]"
          :disabled="!state.models"
          @change="set(key, $event)"
        />
        <span>{{ t(`pcbEditor.viewport3d.options.${key}`) }}</span>
      </label>
    </div>

    <div class="options-actions">
      <button
        type="button"
        class="btn-outline btn-md btn-panel"
        :disabled="isDefault"
        @click="resetBoard3DView()"
      >
        <Icon name="discard" />
        {{ t('pcbEditor.viewport3d.options.reset') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.board3d-options {
  padding: 6px 10px 8px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
}

/* Fills row-wise, so an odd count leaves the gap at the end rather than
   mid-list. Collapses to one column when the rail is dragged narrow. */
.options-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  column-gap: 10px;
}

/* A long label wraps rather than clipping; the box stays on its first line. */
.option-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  /* DESIGN.md's 24px target floor: the label wraps the input, so the whole
     row toggles. */
  min-height: 24px;
  padding: 3px 0;
  line-height: 18px;
  cursor: pointer;
  user-select: none;
}

.option-row:hover {
  color: var(--vscode-accent);
}

.option-row.disabled {
  opacity: 0.4;
  cursor: default;
}

.option-row.disabled:hover {
  color: inherit;
}

.option-child {
  padding-left: 14px;
}

.option-row input {
  flex: none;
  /* Centered on the 18px first line. */
  margin: 2.5px 0 0;
  accent-color: var(--vscode-accent);
}

.option-row span {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The model switches, set off from the layers above them. */
.option-group {
  margin-top: 8px;
}

/* Layout only — the look is `btn-panel` (DESIGN.md §3). */
.options-actions {
  margin: 12px 0 4px;
}
</style>
