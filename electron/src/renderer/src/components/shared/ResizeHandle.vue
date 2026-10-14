<script setup lang="ts">
/**
 * The one draggable resize grip used across the app — sidebar width, panel
 * width, and the stacked collapsible panels — so every resizer looks and behaves
 * the same (4px strip, accent on hover, one transition). It positions itself on
 * an edge of its (position: relative) parent and emits a normalized **grow**
 * delta: positive always means "the thing this handle resizes should get bigger",
 * regardless of which edge it sits on.
 */
import { computed, onBeforeUnmount } from 'vue'

const props = defineProps<{
  /** Which edge of the parent the grip sits on. Determines axis + drag sign. */
  edge: 'top' | 'bottom' | 'left' | 'right'
}>()

const emit = defineEmits<{
  (e: 'resize-start'): void
  /** Cumulative px the parent should grow since this drag began (can be negative). */
  (e: 'resize', grow: number): void
  (e: 'resize-end'): void
}>()

const axis = computed<'x' | 'y'>(() =>
  props.edge === 'left' || props.edge === 'right' ? 'x' : 'y'
)

let origin = 0
const onMove = (e: MouseEvent): void => {
  const cur = axis.value === 'x' ? e.clientX : e.clientY
  let grow = cur - origin
  // Dragging a top/left edge outward means the pointer moves in the negative
  // direction, so flip the sign to keep "positive = grow".
  if (props.edge === 'top' || props.edge === 'left') grow = -grow
  emit('resize', grow)
}
const onUp = (): void => {
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  emit('resize-end')
}
const onDown = (e: MouseEvent): void => {
  e.preventDefault()
  origin = axis.value === 'x' ? e.clientX : e.clientY
  emit('resize-start')
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
})
</script>

<template>
  <div class="resize-handle" :class="[edge, axis]" @mousedown="onDown"></div>
</template>

<style scoped>
.resize-handle {
  position: absolute;
  z-index: 100;
  background-color: transparent;
  transition: background-color 0.07s;
}

.resize-handle.x {
  top: 0;
  width: 4px;
  height: 100%;
  cursor: col-resize;
}

.resize-handle.y {
  left: 0;
  width: 100%;
  height: 4px;
  cursor: row-resize;
}

.resize-handle.top {
  top: 0;
}
.resize-handle.bottom {
  bottom: 0;
}
.resize-handle.left {
  left: 0;
}
.resize-handle.right {
  right: 0;
}

.resize-handle:hover,
.resize-handle:active {
  background-color: var(--vscode-accent, #cca250);
}
</style>
