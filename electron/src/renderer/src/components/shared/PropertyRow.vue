<script setup lang="ts">
/**
 * One row of a `.kicad-property-table`: a label cell and a value cell.
 *
 * Presentation only — it deliberately knows nothing about what it's describing.
 * A PCB footprint instance and a library footprint definition are different
 * entities that happen to share primitives like Pos X; this component asserts
 * only that "a labelled field renders like this", which is what lets the PCB
 * and footprint panels share it without pretending their domains match.
 */
import type { PropertyAction } from '../../lib/propertyTable'
import Icon from './Icon.vue'

defineProps<{
  label: string
  /**
   * Buttons at the right end of the value cell. Inside the cell, not a column of
   * their own: rows carry different counts (Footprint two, Datasheet one), and a
   * shared column would leave a gap between a one-button row's value and its button.
   */
  actions?: PropertyAction[]
  /** Plain, non-editable value: applies the readonly text color. */
  readonly?: boolean
  /** Truncate overlong values (library ids, paths) rather than wrap. */
  ellipsis?: boolean
  /** Native tooltip, normally paired with `ellipsis` to reveal the full text. */
  title?: string
  /** The roving-cursor row: highlighted so ↑/↓ row navigation is discoverable. */
  active?: boolean
}>()

// Tapping the label acts like tapping the value cell (host focuses/toggles it).
const emit = defineEmits<{
  (e: 'label-click'): void
  (e: 'action', actionId: string): void
}>()
</script>

<template>
  <tr :class="{ active }">
    <td class="label-col" @click="emit('label-click')">{{ label }}</td>
    <td class="value-col" :class="{ readonly, ellipsis }" :title="title">
      <div v-if="actions?.length" class="value-with-actions">
        <div class="value-slot" :class="{ ellipsis }"><slot /></div>
        <button
          v-for="action in actions"
          :key="action.id"
          type="button"
          class="btn-outline btn-cell"
          :title="action.label"
          :aria-label="action.label"
          :disabled="action.disabled"
          @click="emit('action', action.id)"
        >
          <Icon v-if="action.icon" :name="action.icon" />
          <template v-else>{{ action.text }}</template>
        </button>
      </div>
      <slot v-else />
    </td>
  </tr>
</template>

<style scoped>
/* Rows mix a 20px input, a 24px cell button and a bare checkbox; baseline
   alignment lands all three at different heights. */
.label-col,
.value-col {
  vertical-align: middle;
}

.label-col {
  width: 80px;
  color: var(--vscode-text-muted, #748780);
  font-weight: 500;
  white-space: nowrap;
}

.value-col {
  padding: 2px 0;
  font-size: var(--text-body-sm);
}

.value-col.readonly {
  color: var(--vscode-text, #c5d3cd);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
}

/* The value takes what the buttons leave; the buttons ARE the cell's right end
   (`btn-cell`), flush against the value and against each other. */
.value-with-actions {
  display: flex;
  align-items: center;
}

.value-slot {
  flex: 1;
  min-width: 0;
}

.value-with-actions .btn-cell {
  flex-shrink: 0;
}

.value-col.ellipsis,
.value-slot.ellipsis {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
