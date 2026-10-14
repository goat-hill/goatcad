<script setup lang="ts">
import BrandMark from './BrandMark.vue'

/*
 * The branded rendering of the product name: mark + two-tone type, matching
 * the site's web/src/components/Wordmark.astro exactly — every place the app
 * writes "GoatCAD" as a brand (title bar, welcome hero, empty editor) goes
 * through this component so the treatments cannot drift apart again.
 *
 * Font size inherits from the parent; `size` picks the site's weight/tracking
 * pair (nav for chrome, hero for large surfaces).
 */
withDefaults(defineProps<{ size?: 'nav' | 'hero' }>(), { size: 'nav' })

// Must spell APP_NAME in src/main/appConfig.ts (and mirror WORDMARK_PARTS in
// web/src/brand.ts) — duplicated by necessity, main is not importable here.
const WORDMARK_PARTS = ['Goat', 'CAD'] as const
</script>

<template>
  <span class="brand-wordmark" :class="size">
    <span class="mark"><BrandMark /></span>
    <span class="name">
      <span class="goat">{{ WORDMARK_PARTS[0] }}</span
      ><span class="cad">{{ WORDMARK_PARTS[1] }}</span>
    </span>
  </span>
</template>

<style scoped>
.brand-wordmark {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  font-weight: 650;
  letter-spacing: -0.025em;
  color: var(--vscode-text-light);
  white-space: nowrap;
}

/* Slightly larger than the cap height so the mark reads as a peer of the
   name, not a bullet point in front of it. */
.mark {
  font-size: 1.15em;
  display: inline-flex;
}

.brand-wordmark.hero {
  font-weight: 700;
  letter-spacing: -0.04em;
}

/* The accent lands on "CAD" only — the half of the name that carries the
   engineering claim. "Goat" stays in plain text so the joke doesn't shout. */
.cad {
  color: var(--vscode-accent);
}
</style>
