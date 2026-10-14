<script setup lang="ts">
// Zoom to fit, the first chip on every view rail — 2D editors, 3D views and
// the viewers alike — so the camera's way home sits in the same place on
// every canvas. Its tooltip names both keys: Home, and Ctrl/Cmd+0 for the
// keyboards that reach Home only through Fn.
import { useI18n } from 'vue-i18n'
import { toolTitle } from '../../lib/hotkeys'
import { FIT_VIEW_OP_ID } from '../../lib/toolSearch'
import Icon from './Icon.vue'

const { t } = useI18n()

const emit = defineEmits<{ (e: 'fit'): void }>()
</script>

<template>
  <button
    :data-tool-op="FIT_VIEW_OP_ID"
    class="floating-btn tool-btn"
    :title="toolTitle(t('shared.insertSearch.ops.fitView'), 'editor.fitView', true)"
    @click.stop="emit('fit')"
  >
    <Icon name="tool-fit" />
  </button>
</template>
