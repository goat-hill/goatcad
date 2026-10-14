<script setup lang="ts">
import { computed } from 'vue'
import ResizeHandle from './ResizeHandle.vue'

/**
 * The rule between two panes, and on it the app's one resize handle
 * (`ResizeHandle`), unseen until the pointer finds it — as every resizable
 * panel. `grows` names the pane a positive drag enlarges: the one before the
 * rule (left of it, above it) or the one after.
 */
const props = defineProps<{
  axis: 'x' | 'y'
  grows: 'before' | 'after'
}>()
const emit = defineEmits<{
  (e: 'resize-start'): void
  (e: 'resize', grow: number): void
}>()

// The handle sits on the grown pane's edge: a pane before the rule is grown from its far edge.
const edge = computed(() =>
  props.axis === 'x'
    ? props.grows === 'before'
      ? 'right'
      : 'left'
    : props.grows === 'before'
      ? 'bottom'
      : 'top'
)
</script>

<template>
  <div class="pane-split" :class="axis">
    <ResizeHandle
      :edge="edge"
      @resize-start="emit('resize-start')"
      @resize="(g) => emit('resize', g)"
    />
  </div>
</template>

<style scoped>
.pane-split {
  position: relative;
  flex-shrink: 0;
  background: var(--vscode-border);
}

.pane-split.x {
  width: 1px;
}

.pane-split.y {
  height: 1px;
}

/* Centered on the rule rather than inside a pane's edge. */
.pane-split > .resize-handle {
  inset: auto;
}

.pane-split.x > .resize-handle {
  top: 0;
  left: -2px;
}

.pane-split.y > .resize-handle {
  top: -2px;
  left: 0;
}
</style>
