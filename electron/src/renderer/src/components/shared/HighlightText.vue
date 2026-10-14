<script setup lang="ts">
import { computed } from 'vue'
import { highlightText } from '../../utils/componentSearch'

/** Renders `text` with the substrings matching `query` (whitespace-tokenized) highlighted. */
const props = defineProps<{ text: string; query: string }>()
const segments = computed(() => highlightText(props.text, props.query))
</script>

<template>
  <span
    ><span v-for="(s, i) in segments" :key="i" :class="{ hl: s.isMatch }">{{ s.text }}</span></span
  >
</template>

<style scoped>
.hl {
  color: var(--vscode-accent, #cca250);
  font-weight: 700;
}
</style>
