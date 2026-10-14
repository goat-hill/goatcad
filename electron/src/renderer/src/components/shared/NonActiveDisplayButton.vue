<script setup lang="ts">
// Canvas-toolbar toggle that cycles how non-active layers draw: show → dim →
// hide. Shared by every layered 2D view (board, footprint, Gerber) so the
// control looks and reads the same wherever it lives; it sits in the view's
// floating toolbar rather than the Layers panel, beside the other display
// toggles (KiCad's left-toolbar idiom).
import { useI18n } from 'vue-i18n'
import { nextNonActiveDisplay, type NonActiveLayerDisplay } from '../../lib/board/layerPresets'
import { toolTitle, type HotkeyActionId } from '../../lib/hotkeys'
import Icon from './Icon.vue'

const { t } = useI18n()

const props = defineProps<{
  mode: NonActiveLayerDisplay
  /** The view's key for the same cycle (KiCad's high-contrast H), shown in the tooltip. */
  action?: HotkeyActionId
}>()
const emit = defineEmits<{ (e: 'update:mode', mode: NonActiveLayerDisplay): void }>()
</script>

<template>
  <button
    class="floating-btn tool-btn toggle-btn"
    :class="{ active: props.mode !== 'show' }"
    :title="
      toolTitle(
        t('shared.insertSearch.ops.inactiveLayers', {
          mode: t(`shared.nonActiveDisplay.modes.${props.mode}`)
        }),
        props.action
      )
    "
    @click="emit('update:mode', nextNonActiveDisplay(props.mode))"
  >
    <Icon name="view-dim" />
  </button>
</template>
