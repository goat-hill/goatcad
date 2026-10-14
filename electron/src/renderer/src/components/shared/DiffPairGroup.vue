<script setup lang="ts">
/**
 * A differential pair among a list of nets (DESIGN.md, Differential pairs):
 * its two halves, positive first, in one rimmed group behind the pair glyph.
 * The halves are the slot, so each list keeps its own net styling; a row
 * holding the group centers it (its baseline is the glyph's foot).
 */
import Icon from './Icon.vue'
</script>

<template>
  <span class="diff-pair">
    <Icon name="tool-route-pair" class="diff-pair-glyph" />
    <slot />
  </span>
</template>

<style scoped>
/* As tall as a net class tag: the glyph and an even 3px above and below it. */
.diff-pair {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  white-space: nowrap;
}

/* Each half trimmed to cap height and baseline, so its letters sit centered in
   the rim rather than high in their line box (main.css, .kbd). A half whose text
   is not its own (an inline-flex chip) trims an inner span instead. */
.diff-pair > :slotted(*) {
  text-box: trim-both cap alphabetic;
}

.diff-pair-glyph {
  width: 12px;
  height: 12px;
  color: var(--vscode-text-muted);
}
</style>
