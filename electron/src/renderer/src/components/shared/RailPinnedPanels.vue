<script setup lang="ts">
/**
 * The viewport-corner panels an editor's user has pinned into its right bar,
 * below Properties and Layers, in `PINNABLE_PANELS` order. Each is the panel
 * its pill opens (`ViewportPopover`), in a `CollapsiblePanel` whose header
 * unpins it back to the corner; its pin, height and fold persist under
 * `pinnedPanelId` (`panelLayout.ts`), as every rail section's do.
 */
import { useI18n } from 'vue-i18n'
import CollapsiblePanel from './CollapsiblePanel.vue'
import GridSettingsPanel from './GridSettingsPanel.vue'
import SelectionFilterPanel from './SelectionFilterPanel.vue'
import FindingsDrawer from './FindingsDrawer.vue'
import {
  panelPinned,
  pinnedPanelId,
  setPanelPinned,
  type PanelLayoutEditor,
  type PinnablePanel
} from '../../lib/panelLayout'
import type { GridSettings } from '../../lib/engine/ViewportEngine'
import type { HealthFinding } from '../../lib/designHealth'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    editor: PanelLayoutEditor
    gridSettings: GridSettings
    /** The editor's findings; omitted where it has no checker. */
    findings?: HealthFinding[] | null
    /** The checks have not finished a first run. */
    pending?: boolean
    /** A check is running. */
    checking?: boolean
    /** A finding to select in the list, as a click on its canvas marker asks. */
    reveal?: { key: string; seq: number } | null
    rerunnable?: boolean
    /** A quick fix for every finding of a rule, its label by rule code. */
    groupFixes?: Readonly<Record<string, string>>
  }>(),
  { findings: null, pending: false, checking: false, rerunnable: false, groupFixes: undefined }
)

const emit = defineEmits<{
  (e: 'update-grid', settings: Partial<GridSettings>): void
  /** Show a finding: `zoom` (a double click) frames it close, else it is centered. */
  (e: 'locate', finding: HealthFinding, zoom: boolean): void
  (e: 'fix', finding: HealthFinding): void
  (e: 'fix-group', code: string): void
  (e: 'rerun'): void
}>()

const pinned = {
  filter: panelPinned(props.editor, 'filter'),
  grid: panelPinned(props.editor, 'grid'),
  health: panelPinned(props.editor, 'health')
}

const id = (panel: PinnablePanel): string => pinnedPanelId(props.editor, panel)
const unpin = (panel: PinnablePanel): void => setPanelPinned(props.editor, panel, false)
</script>

<template>
  <CollapsiblePanel
    v-if="pinned.filter.value"
    :id="id('filter')"
    :title="t('shared.selectionFilterPanel.title')"
    :initial-height="190"
    unpinnable
    @unpin="unpin('filter')"
  >
    <SelectionFilterPanel :editor="props.editor" />
  </CollapsiblePanel>

  <CollapsiblePanel
    v-if="pinned.grid.value"
    :id="id('grid')"
    :title="t('shared.gridSettingsPanel.title')"
    :initial-height="150"
    unpinnable
    @unpin="unpin('grid')"
  >
    <GridSettingsPanel
      hide-header
      :grid-settings="props.gridSettings"
      @update-grid="(g) => emit('update-grid', g)"
    />
  </CollapsiblePanel>

  <CollapsiblePanel
    v-if="props.findings && pinned.health.value"
    :id="id('health')"
    :title="t('designHealth.drawer.title')"
    :initial-height="240"
    unpinnable
    @unpin="unpin('health')"
  >
    <FindingsDrawer
      embedded
      :findings="props.findings"
      :height="0"
      :pending="props.pending"
      :checking="props.checking"
      :rerunnable="props.rerunnable"
      :reveal="props.reveal"
      :group-fixes="props.groupFixes"
      @locate="(f, zoom) => emit('locate', f, zoom)"
      @fix="(f) => emit('fix', f)"
      @fix-group="(code) => emit('fix-group', code)"
      @rerun="emit('rerun')"
    >
      <template v-if="$slots.settings" #settings><slot name="settings" /></template>
    </FindingsDrawer>
  </CollapsiblePanel>
</template>
