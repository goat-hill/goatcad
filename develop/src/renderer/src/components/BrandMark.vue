<script setup lang="ts">
/*
 * The square GoatCAD brand mark: Hill 1, the two hills, on a transparent
 * background, per docs/BRAND.md §3.
 *
 * Ported by copy from electron/src/renderer/src/components/shared/BrandMark.vue
 * (BRAND.md §4 requires the port to be a copy, not a rewrite). The same geometry
 * lives in web/src/components/art/BrandMark.astro, web/public/brand-mark.svg,
 * web/public/favicon.svg, and the rasterized app icons — change one, change all.
 *
 * `mono` swaps the two brand colors for currentColor, with the far hill at
 * 35% opacity so the two hills still separate, for use in an icon row
 * where the mark is one glyph among many and must take the row's color. Colors
 * are bound rather than hardcoded so this stays a copy of the geometry.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ mono?: boolean }>(), { mono: false })

const near = computed(() => (props.mono ? 'currentColor' : '#cca250'))
const far = computed(() => (props.mono ? 'currentColor' : '#5a6661'))
const farOpacity = computed(() => (props.mono ? 0.35 : 1))
</script>

<template>
  <svg
    class="brand-mark"
    viewBox="0 0 64 64"
    width="1em"
    height="1em"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M4 49V35L18 23L26 29L38 15L60 33V49Z" :fill="far" :fill-opacity="farOpacity" />
    <path d="M4 49V41L18 31L26 37L34 31L46 23L60 39V49Z" :fill="near" />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex-shrink: 0;
}
</style>
