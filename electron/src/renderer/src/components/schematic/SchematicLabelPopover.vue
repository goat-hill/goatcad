<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DirectiveLabelShape } from '../../lib/kicad/schematic'

/**
 * In-place editor that appears where a label/text placement clicked. One
 * popover serves the four label kinds (switchable before commit, Tab
 * cycles), free text, a text box's text and a sheet pin's name; net names
 * autocomplete for the net labels, the child's unplaced labels for a pin.
 */

export type PopoverKind =
  | 'label'
  | 'global_label'
  | 'hierarchical_label'
  | 'directive_label'
  | 'text'
  | 'text_box'
  | 'sheet_pin'

const props = defineProps<{
  kind: PopoverKind
  /** Container-relative pixel position of the placement click. */
  screen: { x: number; y: number }
  /** Names offered as autocomplete: nets for a label, labels for a sheet pin. */
  netNames: string[]
  /** What the field starts with (a sheet pin's imported name). */
  initialText?: string
  /** A directive label's flag, kept from the last one placed. */
  directiveShape?: DirectiveLabelShape
}>()

const emit = defineEmits<{
  (event: 'commit', text: string, kind: PopoverKind, shape: DirectiveLabelShape): void
  (event: 'cancel'): void
}>()

const { t } = useI18n()

const LABEL_KINDS: { kind: PopoverKind; labelKey: string }[] = [
  { kind: 'label', labelKey: 'label' },
  { kind: 'global_label', labelKey: 'globalLabel' },
  { kind: 'hierarchical_label', labelKey: 'hierarchicalLabel' },
  { kind: 'directive_label', labelKey: 'directiveLabel' }
]

/** KiCad's four flags, in its dialog's order. */
const DIRECTIVE_SHAPES: DirectiveLabelShape[] = ['dot', 'round', 'diamond', 'rectangle']

const currentKind = ref<PopoverKind>(props.kind)
const shape = ref<DirectiveLabelShape>(props.directiveShape ?? 'round')
const text = ref(props.initialText ?? '')
const input = ref<HTMLInputElement | null>(null)

const isText = computed(() => props.kind === 'text' || props.kind === 'text_box')
const isLabel = computed(() => LABEL_KINDS.some((entry) => entry.kind === props.kind))

const placeholder = computed(() =>
  isText.value
    ? t('schematicEditor.labelPopover.textPlaceholder')
    : props.kind === 'sheet_pin'
      ? t('schematicEditor.labelPopover.pinPlaceholder')
      : currentKind.value === 'directive_label'
        ? t('schematicEditor.labelPopover.netClassPlaceholder')
        : t('schematicEditor.labelPopover.netPlaceholder')
)

const commit = (): void => {
  if (text.value.trim()) emit('commit', text.value, currentKind.value, shape.value)
  else emit('cancel')
}

const cycleKind = (): void => {
  if (!isLabel.value) return
  const index = LABEL_KINDS.findIndex((entry) => entry.kind === currentKind.value)
  currentKind.value = LABEL_KINDS[(index + 1) % LABEL_KINDS.length].kind
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div
    class="label-popover"
    :style="{ left: `${screen.x}px`, top: `${screen.y}px` }"
    @mousedown.stop
    @keydown.stop
  >
    <div v-if="isLabel" class="kind-row">
      <button
        v-for="entry in LABEL_KINDS"
        :key="entry.kind"
        class="kind-btn"
        :class="{ active: currentKind === entry.kind }"
        :title="t(`schematicEditor.labelKinds.${entry.labelKey}`)"
        @click="currentKind = entry.kind"
      >
        {{ t(`schematicEditor.labelPopover.kinds.${entry.labelKey}`) }}
      </button>
    </div>
    <div v-if="isLabel && currentKind === 'directive_label'" class="kind-row">
      <button
        v-for="entry in DIRECTIVE_SHAPES"
        :key="entry"
        class="kind-btn"
        :class="{ active: shape === entry }"
        @click="shape = entry"
      >
        {{ t(`schematicEditor.directiveShapes.${entry}`) }}
      </button>
    </div>
    <input
      ref="input"
      v-model="text"
      class="popover-input"
      :placeholder="placeholder"
      :list="isText ? undefined : 'schematic-net-suggestions'"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="emit('cancel')"
      @keydown.tab.prevent="cycleKind"
    />
    <datalist v-if="!isText" id="schematic-net-suggestions">
      <option v-for="name in netNames" :key="name" :value="name"></option>
    </datalist>
  </div>
</template>

<style scoped>
.label-popover {
  position: absolute;
  z-index: 14;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  background: var(--vscode-overlay-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
}

.kind-row {
  display: flex;
  gap: 2px;
}

.kind-btn {
  flex: 1;
  padding: 3px 7px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.kind-btn:hover {
  color: var(--vscode-text-light, #ffffff);
  background-color: var(--vscode-overlay-control);
}

.kind-btn.active {
  background-color: var(--vscode-bg-active, #32473f);
  color: var(--vscode-accent, #cca250);
}

.popover-input {
  min-width: 190px;
  padding: 5px 7px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  background: var(--vscode-input-bg);
  color: var(--vscode-text, #d8e0dc);
  font: var(--text-body-sm) var(--font-mono);
  outline: none;
}

.popover-input:focus {
  border-color: var(--vscode-accent, #cca250);
}
</style>
