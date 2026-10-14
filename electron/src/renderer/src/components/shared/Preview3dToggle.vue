<script setup lang="ts">
/**
 * The 3D preview's switch, alone in the canvas's top-right slot
 * (`.canvas-top-right`) of the board and footprint editors, in the canvas and
 * in the preview alike. It is one control, not a palette, so its frame is the
 * button: the top bar's chrome and height, so the two line up along the top,
 * with no chip inside it. Lit while the preview shows (DESIGN.md §Canvas tool
 * palettes, an on toggle). The wrapper is a `.canvas-floating-toolbar` for the
 * chrome and the instant tooltip (`installToolbarTips`).
 */
import Icon from './Icon.vue'

defineProps<{
  /** The 3D preview is showing. */
  on: boolean
  title: string
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div class="canvas-floating-toolbar preview3d-toggle">
    <button
      type="button"
      class="preview3d-btn"
      :class="{ on }"
      :aria-pressed="on"
      :title="title"
      @click.stop="emit('toggle')"
    >
      <Icon name="tool-3d" />
    </button>
  </div>
</template>

<style scoped>
/* The frame without its inset: the button fills it. */
.preview3d-toggle {
  padding: 0;
}

/* The top bar's outer height (a 32px chip, its 3px inset each side), less the
   frame's 1px border each side. */
.preview3d-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--vscode-text-muted, #748780);
  cursor: pointer;
  transition:
    background-color 70ms ease-out,
    color 70ms ease-out;
}

/* A palette glyph, at its grid's own size. */
.preview3d-btn :deep(svg) {
  width: 20px;
  height: 20px;
}

.preview3d-btn:hover {
  background-color: var(--vscode-overlay-control-hover);
  color: var(--vscode-text-light, #ffffff);
}

.preview3d-btn.on {
  background-color: var(--vscode-bg-active, #32473f);
  color: var(--vscode-text-light, #ffffff);
}
</style>
