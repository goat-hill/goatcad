<script setup lang="ts">
/**
 * A net class's name, set apart from the words around it (DESIGN.md, Net class
 * tags): a rounded tag in the UI font, filled with a tint of the class's KiCad
 * PCB color where it has one and outlined in that color, neutral where it has
 * none. "Default" in a tag reads as a name.
 */
import { computed } from 'vue'
import type { Rgba } from '../../lib/kicad/color'

/** The color as KiCad's RGBA, or already a CSS color (a select option's swatch). */
const props = defineProps<{ name: string; color?: Rgba | string | null }>()

const tint = computed(() => {
  const c = props.color
  if (!c) return undefined
  const css = typeof c === 'string' ? c : `rgb(${c.r}, ${c.g}, ${c.b})`
  return { '--class-color': css }
})
</script>

<template>
  <span class="netclass-tag" :class="{ colored: !!tint }" :style="tint">{{ props.name }}</span>
</template>

<style scoped>
.netclass-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background-color: var(--vscode-overlay-control);
  /* The theme's strongest text: white on dark, near-black on light, so it reads on a tint. */
  color: var(--vscode-text-light);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
  line-height: 18px;
  white-space: nowrap;
}

/* The class's color as the fill, faint enough that the theme's strongest text
   reads on any hue, and stronger as the rim, so two classes still tell apart. */
.netclass-tag.colored {
  border-color: color-mix(in srgb, var(--class-color) 70%, transparent);
  background-color: color-mix(in srgb, var(--class-color) 28%, transparent);
}
</style>
