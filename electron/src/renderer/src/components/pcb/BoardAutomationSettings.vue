<script setup lang="ts">
/**
 * The findings drawer's settings for a board, behind its gear: how the zone
 * fill and the checks run after an edit (`lib/board/boardAutomation.ts`).
 * Its rows sit in `HealthViewSettings`' columns, beside every editor's.
 */
import { useI18n } from 'vue-i18n'
import {
  DRC_MODES,
  ZONE_FILL_MODES,
  type AutoMode,
  type BoardAutomation
} from '../../lib/board/boardAutomation'

defineProps<{
  automation: BoardAutomation
}>()

const emit = defineEmits<{
  (e: 'set', patch: Partial<BoardAutomation>): void
}>()

const { t } = useI18n()

const settings: Array<{
  key: keyof BoardAutomation
  label: () => string
  modes: readonly AutoMode[]
}> = [
  {
    key: 'zoneFill',
    label: () => t('designHealth.performance.autoZoneFill'),
    modes: ZONE_FILL_MODES
  },
  { key: 'drc', label: () => t('designHealth.performance.autoDrc'), modes: DRC_MODES }
]

const modeLabel = (mode: AutoMode): string =>
  mode === 'greedy'
    ? t('designHealth.performance.mode.greedy')
    : mode === 'full'
      ? t('designHealth.performance.mode.full')
      : t('designHealth.performance.mode.off')
</script>

<template>
  <div class="automation-settings">
    <div
      v-for="setting in settings"
      :key="setting.key"
      class="automation-setting"
      role="group"
      :aria-label="setting.label()"
    >
      <span class="setting-label">{{ setting.label() }}</span>
      <span class="segmented">
        <button
          v-for="mode in setting.modes"
          :key="mode"
          type="button"
          class="segmented-btn"
          :class="{ active: automation[setting.key] === mode }"
          :aria-pressed="automation[setting.key] === mode"
          @click="emit('set', { [setting.key]: mode })"
        >
          {{ modeLabel(mode) }}
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.automation-settings {
  display: contents;
}

/* Each setting's label and buttons sit in the shared columns. */
.automation-setting {
  display: contents;
}
</style>
