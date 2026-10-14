<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  isSavedPresetId,
  matchingPresetId,
  savedPresetName,
  usableSavedPresets,
  type LayerPreset
} from '../../lib/board/layerPresets'
import {
  deleteLayerPreset,
  savedLayerPresets,
  saveLayerPreset
} from '../../lib/board/layerPresetStore'
import PropertyTable from './PropertyTable.vue'
import type { PropertyEditValue, PropertyField, PropertyGroup } from '../../lib/propertyTable'
import Icon from './Icon.vue'
import { kicadLayerColorsForTheme, themeColor, useAppTheme } from '../../lib/theme'

const { t } = useI18n()
const appTheme = useAppTheme()

export interface LayerDisplayItem {
  name: string
  /** Optional user-facing rename shown as tooltip (e.g. "F.Silkscreen") */
  title?: string
}

const props = defineProps<{
  /** Ordered layers to list */
  layers: LayerDisplayItem[]
  layerVisibility: Record<string, boolean>
  activeLayer: string
  /** Layers that can be made active; omit to allow all */
  activatable?: string[]
  presets: LayerPreset[]
  /** Suppress the built-in title (when hosted in a CollapsiblePanel that titles it). */
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-layer-visibility', layer: string): void
  (e: 'set-active-layer', layer: string): void
  (e: 'apply-layer-preset', visibility: Record<string, boolean>): void
}>()

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const saved = savedLayerPresets()

const allPresets = computed<LayerPreset[]>(() => [
  ...props.presets,
  ...usableSavedPresets(saved.value, props.layerVisibility)
])

const activePresetId = computed<string>(() =>
  matchingPresetId(allPresets.value, props.layerVisibility)
)

/** The name being typed, or null when the row is showing its dropdown. */
const pendingName = ref<string | null>(null)
/** What the name field holds now, for the confirm button to save. */
const typedName = ref('')
const presetRow = ref<HTMLElement | null>(null)
const tableRef = ref<InstanceType<typeof PropertyTable> | null>(null)

const beginSave = (): void => {
  // Seeded with the current preset's name, so saving over one is the default
  // gesture and renaming is a deliberate edit.
  pendingName.value = isSavedPresetId(activePresetId.value)
    ? savedPresetName(activePresetId.value)
    : ''
  typedName.value = pendingName.value
  void nextTick(() => tableRef.value?.focusField('preset'))
}

const commitName = (name: string): void => {
  pendingName.value = null
  if (name.trim()) saveLayerPreset(name, props.layerVisibility)
}

const removeActivePreset = (): void => {
  if (isSavedPresetId(activePresetId.value)) {
    deleteLayerPreset(savedPresetName(activePresetId.value))
  }
}

const isActivatable = (layer: string): boolean =>
  props.activatable === undefined || props.activatable.includes(layer)

const handleRowClick = (layer: string): void => {
  if (isActivatable(layer)) emit('set-active-layer', layer)
}

const getLayerColorHex = (layer: string): string => {
  return (
    kicadLayerColorsForTheme(appTheme.value)[layer] ??
    themeColor('--vscode-canvas-layer-unknown', '#ffffff')
  )
}

const getLayerSwatchOpacity = (layer: string): number => {
  if (layer === 'F.Mask' || layer === 'B.Mask') return 0.4
  if (layer === 'F.Paste' || layer === 'B.Paste') return 0.7
  return 1.0
}

// The preset control renders through the shared PropertyTable so it matches the
// Grid / Properties panels; the per-layer
// list below stays bespoke (eye toggle + color swatch + active-row selection
// don't map to a single-editor property row).
//
// Naming a preset borrows the same row rather than opening a dialog: the thing
// being named is the row you pressed, and a modal over a right-hand panel covers
// the board it describes. A name is saved by Enter or the confirm button only;
// leaving the row abandons it, as Escape does (RULES.md §6, a name prompt).
const groups = computed<PropertyGroup[]>(() => {
  const naming = pendingName.value !== null
  const fields: PropertyField[] = [
    {
      key: 'preset',
      label: t('shared.layersPanel.presetLabel'),
      editor: naming
        ? { kind: 'text', commitOnEnter: true }
        : {
            kind: 'select',
            options: [
              { value: '', label: t('shared.layersPanel.selectPreset') },
              ...allPresets.value.map((p) => ({ value: p.id, label: p.label }))
            ]
          },
      value: naming ? (pendingName.value ?? '') : activePresetId.value,
      actions: [
        {
          // While a name is being typed this button is the confirm.
          id: naming ? 'confirmPreset' : 'savePreset',
          label: t('shared.layersPanel.savePresetTitle'),
          icon: 'save'
        },
        {
          id: 'deletePreset',
          label: isSavedPresetId(activePresetId.value)
            ? t('shared.layersPanel.deletePresetTitle')
            : t('shared.layersPanel.deletePresetDisabledTitle'),
          icon: 'trash',
          // Only a saved preset can go: the built-in sets are generated from
          // this document's own layer table and there is nothing to remove.
          disabled: naming || !isSavedPresetId(activePresetId.value)
        }
      ]
    }
  ]
  return [{ type: 'layers', title: t('shared.layersPanel.title'), count: 1, fields }]
})

const onEdit = (_groupType: string, key: string, value: PropertyEditValue): void => {
  if (key === 'preset') {
    if (pendingName.value !== null) {
      commitName(String(value))
      return
    }
    const preset = allPresets.value.find((p) => p.id === value)
    if (preset) emit('apply-layer-preset', preset.visibility)
  }
}

// Only the name field leaving abandons it: the Save button it replaced also
// loses focus as it goes, and that is not the user clicking away.
const onPresetFocusOut = (e: FocusEvent): void => {
  if (pendingName.value === null || !(e.target instanceof HTMLInputElement)) return
  const next = e.relatedTarget
  if (!(next instanceof Node) || !presetRow.value?.contains(next)) pendingName.value = null
}

/** The row's buttons keep the focus in the name field, so pressing one is not leaving it. */
const onPresetMouseDown = (e: MouseEvent): void => {
  if (pendingName.value !== null && (e.target as Element).closest('button')) e.preventDefault()
}

const onAction = (_groupType: string, actionId: string): void => {
  if (actionId === 'savePreset') beginSave()
  else if (actionId === 'confirmPreset') commitName(typedName.value)
  else if (actionId === 'deletePreset') removeActivePreset()
}
</script>

<template>
  <div class="panel-section layers-control-section">
    <h3 v-if="!hideHeader">{{ t('shared.layersPanel.title') }}</h3>

    <!-- Preset control via the shared table. Focus leaving the row abandons a
         name being typed; moving to its own confirm button does not. -->
    <div
      ref="presetRow"
      @input="typedName = ($event.target as HTMLInputElement).value"
      @focusout="onPresetFocusOut"
      @mousedown="onPresetMouseDown"
    >
      <PropertyTable
        ref="tableRef"
        :groups="groups"
        hide-group-titles
        @edit="onEdit"
        @action="onAction"
        @escape="pendingName = null"
      />
    </div>

    <!-- Column-major: fills down the first column, then the second, so the
         list still reads in layer-table order. -->
    <div
      class="layers-grid"
      :style="{ gridTemplateRows: `repeat(${Math.ceil(layers.length / 2)}, auto)` }"
    >
      <div
        v-for="(layer, i) in layers"
        :key="layer.name"
        class="layer-row"
        :class="{
          'first-column': i < Math.ceil(layers.length / 2),
          'is-active-layer': layer.name === activeLayer,
          'not-activatable': !isActivatable(layer.name)
        }"
        :title="layer.title"
        @click="handleRowClick(layer.name)"
      >
        <!-- Active Layer Caret Indicator -->
        <div class="active-layer-indicator-wrapper">
          <span
            v-if="layer.name === activeLayer"
            class="active-caret"
            :title="t('shared.layersPanel.activeLayerTitle')"
          >
            <Icon name="active-marker" />
          </span>
          <span v-else class="inactive-caret-placeholder"></span>
        </div>

        <!-- Visibility Eye Toggle -->
        <button
          class="layer-visibility-eye"
          :class="{ 'is-visible': layerVisibility[layer.name] }"
          :title="t('shared.layersPanel.toggleVisibilityTitle')"
          @click.stop="emit('toggle-layer-visibility', layer.name)"
        >
          <Icon v-if="layerVisibility[layer.name]" name="eye" class="eye-icon" />
          <Icon v-else name="eye-off" class="eye-icon is-hidden" />
        </button>

        <!-- Color Indicator & Layer Name Label -->
        <div class="layer-checkbox">
          <span class="layer-color-indicator">
            <span
              class="layer-color-fill"
              :style="{
                backgroundColor: getLayerColorHex(layer.name),
                opacity: getLayerSwatchOpacity(layer.name)
              }"
            ></span>
          </span>
          <span class="layer-name-lbl">{{ layer.name }}</span>
        </div>
      </div>
      <!-- Fills the odd cell so the second column's lines run to the bottom. -->
      <div v-if="layers.length % 2 === 1" class="layer-row layer-row-filler"></div>
    </div>
  </div>
</template>

<style scoped>
/* The PropertyTable and the layer grid are full-bleed (like every other property
   panel), so the section itself carries no padding — only the header is inset. */
.panel-section {
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

.panel-section h3 {
  padding: 12px 14px 0;
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-accent, #cca250);
  margin-bottom: 10px;
  font-weight: 700;
}

/* The controls table sits directly on top of the layer list — drop the table's
   trailing group gap so the two read as one continuous stack. */
.panel-section :deep(.property-group) {
  margin-bottom: 0;
}

.layers-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-flow: column;
  /* No top border: the preset table's last row already draws that line. */
  overflow: hidden;
}

/* The whole row is a target (it makes the layer active), so it takes the
   dense 24px floor (DESIGN.md), level with the preset row above. */
.layer-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 0 6px 0 4px;
  background-color: var(--vscode-bg-sidebar);
  /* Real borders, not a 1px gap over a colored grid: the two 1fr columns split
     the rail on fractional pixels, where a gap paints 0, 1 or 2 device pixels
     wide but a border always snaps to one. */
  border-bottom: 1px solid var(--vscode-border, #24302b);
  cursor: pointer;
  user-select: none;
}

.layer-row.first-column {
  border-right: 1px solid var(--vscode-border, #24302b);
}

.layer-row:hover {
  background-color: var(--vscode-overlay-control);
}

.layer-row.is-active-layer {
  background-color: var(--vscode-accent-subtle-strong);
}

.layer-row.not-activatable,
.layer-row-filler {
  cursor: default;
}

.layer-row-filler:hover {
  background-color: var(--vscode-bg-sidebar);
}

.active-layer-indicator-wrapper {
  width: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.active-caret {
  display: flex;
  color: var(--vscode-accent, #cca250);
}

.active-caret svg {
  width: 12px;
  height: 12px;
}

.inactive-caret-placeholder {
  width: 12px;
}

/* A 24px target around a small glyph: the most-clicked control in the panel. */
.layer-visibility-eye {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  color: var(--vscode-text-muted, #748780);
  width: 24px;
  height: 24px;
  border-radius: 3px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

@media (prefers-reduced-motion: no-preference) {
  .layer-row {
    transition: background-color 0.15s;
  }

  .layer-visibility-eye {
    transition:
      color 0.15s,
      background-color 0.15s;
  }
}

.layer-visibility-eye:hover {
  background-color: var(--vscode-overlay-control-hover);
  color: var(--vscode-text-light, #ffffff);
}

.layer-visibility-eye.is-visible {
  color: var(--vscode-text-light, #ffffff);
}

.layer-visibility-eye .eye-icon {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2.5;
  fill: none;
}

.layer-visibility-eye .eye-icon.is-hidden {
  opacity: 0.4;
  color: var(--vscode-text-muted, #748780);
}

.layer-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: inherit;
  flex-grow: 1;
  min-width: 0;
}

.layer-color-indicator {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid var(--vscode-border);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  background-color: var(--vscode-bg-viewport);
  /* 2x2 grid transparency checkerboard background */
  background-image:
    linear-gradient(45deg, var(--vscode-border) 25%, transparent 25%),
    linear-gradient(-45deg, var(--vscode-border) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--vscode-border) 75%),
    linear-gradient(-45deg, transparent 75%, var(--vscode-border) 75%);
  background-size: 6px 6px;
  background-position:
    0 0,
    0 3px,
    3px -3px,
    -3px 0px;
}

.layer-color-fill {
  display: block;
  width: 100%;
  height: 100%;
}

.layer-name-lbl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-body-sm);
  font-family: var(--font-mono, monospace);
  color: var(--vscode-text-light, #ffffff);
}
</style>
