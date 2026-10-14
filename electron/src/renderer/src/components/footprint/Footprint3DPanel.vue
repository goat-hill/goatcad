<script setup lang="ts">
/**
 * The right rail while a footprint is in 3D — the same switches the board's 3D
 * view gets, minus the assembly-class filters (there is one part) and plus the
 * model toggle they would otherwise live under.
 *
 * It reads the same shared store as the board view rather than a second set: a
 * preference like "show silkscreen" is about how 3D is drawn, not about which
 * document is open, and two independent copies would only mean discovering the
 * switch twice.
 */
import { useI18n } from 'vue-i18n'
import CollapsiblePanel from '../shared/CollapsiblePanel.vue'
import Pcb3DOptionsPanel from '../pcb/Pcb3DOptionsPanel.vue'

const { t } = useI18n()
</script>

<template>
  <div class="footprint3d-panel">
    <CollapsiblePanel
      id="footprint3d.layers"
      :title="t('pcbEditor.viewport3d.options.layersGroup')"
      flex
    >
      <Pcb3DOptionsPanel subject="footprint" />
    </CollapsiblePanel>
  </div>
</template>

<style scoped>
.footprint3d-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  color: var(--vscode-text);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
}
</style>
