<script setup lang="ts">
/**
 * The floating status pills every viewport carries, in either bottom corner.
 *
 * One component rather than four: the readouts had drifted into two layouts (two
 * editors bottom-left at 10px with a blur, two bottom-right at 11px without)
 * showing the same class of information.
 *
 * The two corners carry different KINDS of thing, which is why `side` is a
 * caller's choice rather than derived: bottom right is persistent state (where
 * the cursor is, what the filter is set to), bottom left is transient coaching
 * for the armed tool. A hint that appeared beside the coordinates would push
 * them around every time a tool was armed.
 *
 * **One pill per item, not one pill of items.** Separate surfaces read as
 * separate facts — X is not Y — where a divider inside a single pill asks the
 * eye to parse a run of digits into fields.
 *
 * The coordinate format lives HERE rather than in each viewport, so all four
 * spell a position identically; a caller supplies the two numbers already in its
 * own file orientation and says nothing about how they are drawn.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { coordinateField } from '../../lib/viewportSelection'
import { keyCapLabel, type KeyCap } from '../../lib/keyCap'
import KeyCapKbd from './KeyCapKbd.vue'

export interface StatusItem {
  /** Stable key; also what a test hook would address the item by. */
  id: string
  /** Label or prose, in the UI font. */
  text: string
  /** The numeric half, set in mono so digits line up under each other. */
  value?: string
  /** Accent color, for a state worth noticing (a hovered net, a drag that joins nets); never for coaching. */
  accent?: boolean
  /** Where the value came from, muted after it. */
  note?: string
  /** The value is out of bounds (a width outside its rule): warning color. */
  warn?: boolean
  /** The longer story on hover; a pill with one takes the pointer. */
  title?: string
  /** Keys taught after the text, each as keycaps and what it does. */
  keys?: Array<{ caps: KeyCap[]; text: string }>
}

export interface StatusCoords {
  /** Millimeters, in the caller's FILE orientation — this does not flip axes. */
  x: number
  y: number
  unit: 'mm' | 'mil' | 'in'
  /** Grid spacing while snap is on; omitted when it is off (see coordinateField). */
  spacing?: number
}

const { t } = useI18n()

const props = withDefaults(
  defineProps<{ items?: StatusItem[]; coords?: StatusCoords | null; side?: 'left' | 'right' }>(),
  { items: () => [], coords: null, side: 'right' }
)

/**
 * X and Y as two pills — separate surfaces read as separate facts, where a
 * divider inside one pill asks the eye to parse a run of digits into fields.
 *
 * Neither carries the UNIT: the grid pill beside them already states it, and
 * saying it twice in one corner is noise. That also keeps these two the same
 * width, which is what stops them resizing as digits change.
 */
const coordItems = computed<StatusItem[]>(() => {
  const c = props.coords
  if (!c) return []
  const at = (mm: number): string => coordinateField(mm, c.unit, c.spacing)
  return [
    { id: 'x', text: t('shared.viewportStatus.axisX'), value: at(c.x) },
    { id: 'y', text: t('shared.viewportStatus.axisY'), value: at(c.y) }
  ]
})

const pills = computed<StatusItem[]>(() => [...coordItems.value, ...props.items])
</script>

<template>
  <div v-if="pills.length || $slots.default" class="viewport-status-corner" :class="side">
    <div
      v-for="pill in pills"
      :key="pill.id"
      class="viewport-pill"
      :class="{ accent: pill.accent, warn: pill.warn, explained: !!pill.title }"
      :title="pill.title"
    >
      <span v-if="pill.text">{{ pill.text }}</span>
      <span v-if="pill.value" class="viewport-pill-value">{{ pill.value }}</span>
      <span v-if="pill.note" class="viewport-pill-note">{{ pill.note }}</span>
      <span v-for="key in pill.keys ?? []" :key="key.text" class="viewport-pill-key">
        <KeyCapKbd v-for="cap in key.caps" :key="keyCapLabel(cap)" :cap="cap" />
        {{ key.text }}
      </span>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.viewport-status-corner {
  position: absolute;
  bottom: 12px;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Text is inert; a control in the slot re-enables its own. */
  pointer-events: none;
}

.viewport-status-corner.right {
  right: 12px;
}

.viewport-status-corner.left {
  left: 12px;
}

.viewport-pill.accent {
  color: var(--vscode-accent, #cca250);
}

.viewport-pill.warn .viewport-pill-value {
  color: var(--vscode-warning);
}

.viewport-pill.explained {
  pointer-events: auto;
}

.viewport-pill-key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 10px;
  color: var(--vscode-text);
}

.viewport-pill-note {
  margin-left: 6px;
  color: var(--vscode-text-muted);
}
</style>
