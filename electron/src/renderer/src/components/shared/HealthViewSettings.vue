<script setup lang="ts">
/**
 * The findings drawer's settings, behind its gear, in every editor: whether
 * the canvas marks every finding, errors only, or none (`lib/designHealthView.ts`). An editor with
 * settings of its own puts their rows in the slot, which shares the columns.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { tk, type MessageKey } from '../../lib/messageKey'
import { designHealthViewState, setDesignHealthView } from '../../lib/designHealthView'

const { t } = useI18n()
const view = designHealthViewState()

type MarkerMode = 'all' | 'errors' | 'off'
const MARKER_OPTIONS: Array<{ mode: MarkerMode; label: MessageKey }> = [
  { mode: 'all', label: tk('designHealth.drawer.markersAll') },
  { mode: 'errors', label: tk('designHealth.drawer.markersErrors') },
  { mode: 'off', label: tk('designHealth.drawer.markersOff') }
]
const mode = computed<MarkerMode>(() =>
  !view.value.showMarkers ? 'off' : view.value.errorsOnly ? 'errors' : 'all'
)
const choose = (next: MarkerMode): void =>
  setDesignHealthView({ showMarkers: next !== 'off', errorsOnly: next === 'errors' })
</script>

<template>
  <div class="health-settings">
    <slot />
    <div class="health-setting" role="group" :aria-label="t('designHealth.drawer.markers')">
      <span class="setting-label">{{ t('designHealth.drawer.markers') }}</span>
      <span class="segmented">
        <button
          v-for="option in MARKER_OPTIONS"
          :key="option.mode"
          type="button"
          class="segmented-btn"
          :class="{ active: mode === option.mode }"
          :aria-pressed="mode === option.mode"
          @click="choose(option.mode)"
        >
          {{ t(option.label) }}
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.health-settings {
  display: grid;
  grid-template-columns: max-content max-content;
  align-items: center;
  /* Each control as wide as its own options, not the widest row's. */
  justify-items: start;
  gap: 8px 12px;
  padding: 8px 12px;
}

/* Each setting's label and buttons sit in the shared columns. */
.health-setting {
  display: contents;
}
</style>
