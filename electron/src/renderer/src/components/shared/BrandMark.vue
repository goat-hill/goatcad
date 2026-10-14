<script setup lang="ts">
/*
 * The square brand mark: Hill 1, the site's two hills. A copper near hill
 * stands in front of a gray-green far hill, centered on the 64 grid. Both are
 * solid and take --vscode-mark-far / --vscode-mark-near, so the mark follows
 * the theme.
 * Transparent background, per docs/BRAND.md §3.
 *
 * Ported by copy from the site's web/src/components/art/BrandMark.astro
 * (BRAND.md §4 requires the port to be a copy, not a rewrite). The same
 * geometry also lives in web/public/brand-mark.svg, web/public/favicon.svg,
 * and the rasterized app icons (build/icon.png, resources/icon.png) — change
 * one, change all of them.
 *
 * Sized in em so the parent's font-size scales it; decorative wherever the
 * product name is written next to it, hence aria-hidden.
 */
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
    <path d="M4 49V35L18 23L26 29L38 15L60 33V49Z" fill="var(--vscode-mark-far)" />
    <path d="M4 49V41L18 31L26 37L34 31L46 23L60 39V49Z" fill="var(--vscode-mark-near)" />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex-shrink: 0;
}
</style>
