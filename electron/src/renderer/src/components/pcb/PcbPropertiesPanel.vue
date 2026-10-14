<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { KicadBoard } from '../../lib/kicad/board'
import { boardLayerListing } from '../../lib/board/layerListing'
import { panelPinned, setPanelPinned } from '../../lib/panelLayout'
import { GridSettings } from '../../lib/engine/ViewportEngine'
import LayersPanel from '../shared/LayersPanel.vue'
import PropertyTable from '../shared/PropertyTable.vue'
import CollapsiblePanel from '../shared/CollapsiblePanel.vue'
import Icon from '../shared/Icon.vue'
import FormatNotice from '../shared/FormatNotice.vue'
import type { PropertyEditValue, PropertyGroup } from '../../lib/propertyTable'
import type { SyncDrift } from '../../lib/board/syncDrift'

const { t } = useI18n()

const props = defineProps<{
  board: KicadBoard | null
  /** Selection-driven property groups (built by PcbEditor). When nothing is
      selected these are the board-level group (thickness / paper). */
  propertyGroups: PropertyGroup[]
  gridSettings: GridSettings
  layerVisibility: Record<string, boolean>
  activeLayer: string
  readOnly?: boolean
  /** Show the board-level actions, Manufacture and Board Setup (nothing selected, on a saved board). */
  canManufacture?: boolean
  /** The board's drift from the schematic, for Update from schematic; null until it is known. */
  syncDrift?: SyncDrift | null
  /** The board's file, at the document level (nothing selected), for its KiCad-version note. */
  formatFilePath?: string | null
  /**
   * Only to read (the visual diff): the table in review (`PropertyTable`), and
   * the Layers panel always here, since the diff has no canvas control to unpin
   * it to.
   */
  review?: boolean
}>()

const emit = defineEmits<{
  (e: 'edit', groupType: string, key: string, value: PropertyEditValue): void
  /** A row's button (a size row's reset to the rules): the group type, the action and the row's key. */
  (e: 'action', groupType: string, actionId: string, fieldKey?: string): void
  (e: 'update-grid', settings: Partial<GridSettings>): void
  (e: 'toggle-layer-visibility', layer: string): void
  (e: 'apply-layer-preset', visibility: Record<string, boolean>): void
  (e: 'set-active-layer', layer: string): void
  /** Enter Manufacture mode for this board. */
  (e: 'manufacture'): void
  /** Open this board's Board Setup tab. */
  (e: 'setup'): void
  /** Open Update PCB from Schematic for this board. */
  (e: 'update-from-schematic'): void
}>()

/**
 * Update from schematic's status: the footprints an update would add, that
 * are not in the schematic, and that it would edit, each shown only when
 * there are any; or why it cannot run.
 */
const drift = computed(() => {
  const state = props.syncDrift
  const counts =
    state?.state === 'checked'
      ? [
          {
            tone: 'is-added',
            count: state.added,
            label: t('shared.propertiesPanel.syncAdded', state.added)
          },
          {
            tone: 'is-removed',
            count: state.removed,
            label: t('shared.propertiesPanel.syncRemoved', state.removed)
          },
          {
            tone: 'is-edited',
            count: state.edited,
            label: t('shared.propertiesPanel.syncEdited', state.edited)
          }
        ].filter((entry) => entry.count > 0)
      : []
  return {
    counts,
    unannotated: state?.state === 'unannotated',
    disabled: state?.state === 'none',
    title:
      state?.state === 'none'
        ? t('shared.propertiesPanel.syncNoSchematic')
        : counts.map((entry) => entry.label).join(', ') || undefined
  }
})
const driftShown = computed(() => drift.value.counts.length > 0 || drift.value.unannotated)

const listing = computed(() =>
  boardLayerListing(props.board, (key) => t(`shared.layerPresets.${key}`))
)
const layersPinned = panelPinned('pcb', 'layers')
</script>

<template>
  <div class="properties-panel-content">
    <CollapsiblePanel :title="t('shared.propertiesPanel.title')" flex>
      <FormatNotice :file-path="formatFilePath" />
      <PropertyTable
        :groups="propertyGroups"
        :distance-unit="gridSettings.unit"
        :read-only="readOnly"
        :review="review"
        @edit="(groupType, key, value) => emit('edit', groupType, key, value)"
        @action="
          (groupType, actionId, _groupId, fieldKey) => emit('action', groupType, actionId, fieldKey)
        "
      />
      <!-- Actions on the selection as a whole, under its properties (a footprint's library link). -->
      <slot name="selection-actions" />
      <!-- The board's own pages, in the order the work goes: take the schematic, set up, then make. -->
      <div v-if="canManufacture" class="page-buttons">
        <button
          class="btn-outline btn-md btn-panel"
          :disabled="drift.disabled"
          :title="drift.title"
          @click="emit('update-from-schematic')"
        >
          <Icon name="refresh" />
          {{ t('shared.propertiesPanel.updateFromSchematic') }}
          <span v-if="driftShown" class="drift">
            <span v-if="drift.unannotated" class="status-badge is-error">
              {{ t('shared.propertiesPanel.syncUnannotated') }}
            </span>
            <span
              v-for="entry in drift.counts"
              :key="entry.tone"
              class="status-badge drift-count"
              :class="entry.tone"
            >
              {{ entry.count }}
            </span>
          </span>
        </button>
        <button class="btn-outline btn-md btn-panel" @click="emit('setup')">
          <Icon name="settings" />
          {{ t('shared.propertiesPanel.boardSetup') }}
        </button>
        <button class="btn-outline btn-md btn-panel" @click="emit('manufacture')">
          <Icon name="manufacture" />
          {{ t('shared.propertiesPanel.manufacture') }}
        </button>
      </div>
    </CollapsiblePanel>

    <CollapsiblePanel
      v-if="layersPinned || review"
      id="pcb.layers"
      :title="t('shared.layersPanel.title')"
      :initial-height="240"
      :unpinnable="!review"
      @unpin="setPanelPinned('pcb', 'layers', false)"
    >
      <LayersPanel
        hide-header
        :layers="listing.layers"
        :layer-visibility="layerVisibility"
        :active-layer="activeLayer"
        :activatable="listing.activatable"
        :presets="listing.presets"
        @toggle-layer-visibility="(l) => emit('toggle-layer-visibility', l)"
        @set-active-layer="(l) => emit('set-active-layer', l)"
        @apply-layer-preset="(v) => emit('apply-layer-preset', v)"
      />
    </CollapsiblePanel>

    <!-- The corner's panels, pinned here (RailPinnedPanels). -->
    <slot />
  </div>
</template>

<style scoped>
.properties-panel-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  color: var(--vscode-text, #c5d3cd);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
}

/* Layout only — the look is `btn-panel` (DESIGN.md §3), the library section's
   too. Inset from the panel edges like the project switcher; the schematic's
   Schematic setup and Components pair is its twin. */
.page-buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 10px;
}

/* The counts at the button's far end, in the add / remove / edit hues. */
.drift {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.drift-count {
  justify-content: center;
  min-width: 20px;
  font-variant-numeric: tabular-nums;
}

.drift-count.is-added {
  background: var(--vscode-success-subtle);
  color: var(--vscode-success);
}

.drift-count.is-removed {
  background: var(--vscode-error-subtle);
  color: var(--vscode-error);
}

.drift-count.is-edited {
  background: var(--vscode-warning-subtle);
  color: var(--vscode-warning);
}
</style>
