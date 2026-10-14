<script setup lang="ts">
import { computed } from 'vue'
import ComponentSymbolViewer from './ComponentSymbolViewer.vue'
import ComponentFootprintViewer from './ComponentFootprintViewer.vue'
import ModelViewer from './ModelViewer.vue'
import ComponentSlotHead from './ComponentSlotHead.vue'
import type { IndexRecord } from '../lib/libraryIndex'

/**
 * One pane of the Component view: its head (`ComponentSlotHead` — the trail,
 * or a dropdown when the association is many-to-one) and the real read-only
 * renderer for the selected record (symbol/footprint/3D). Empty → "none
 * associated".
 */
const props = defineProps<{
  type: 'symbol' | 'footprint' | 'model'
  records: IndexRecord[]
  selected: number
  primary?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:selected', v: number): void
  (e: 'open', record: IndexRecord): void
}>()
const current = computed<IndexRecord | null>(
  () => props.records[props.selected] ?? props.records[0] ?? null
)
</script>

<template>
  <div class="slot" :class="{ primary }">
    <ComponentSlotHead
      :type="type"
      :records="records"
      :selected="selected"
      openable
      @update:selected="(v) => emit('update:selected', v)"
      @open="(r) => emit('open', r)"
    />
    <div class="slot-body">
      <ComponentSymbolViewer
        v-if="current && type === 'symbol'"
        :file="current.file"
        :library="current.library"
        :symbol="current.name"
      />
      <ComponentFootprintViewer v-else-if="current && type === 'footprint'" :file="current.file" />
      <ModelViewer
        v-else-if="current && type === 'model'"
        :file-path="current.file"
        :name="current.name"
        initial-view="top"
      />
      <div v-else class="empty">—</div>
    </div>
  </div>
</template>

<style scoped>
.slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.slot-body {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--vscode-bg-viewport);
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--vscode-text-muted, #56655d);
  font-size: 20px;
}
</style>
