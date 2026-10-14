<script setup lang="ts">
/**
 * Who set a limit, as the rules name it (`WarningSource`): a net class as its
 * tag (DESIGN.md, Net class tags), a custom rule's name in mono, anything else
 * as text. Where a warning or the Limits section says what a value came from.
 */
import type { WarningSource } from '../../lib/propertyTable'
import NetClassTag from './NetClassTag.vue'

defineProps<{ source: WarningSource }>()
</script>

<template>
  <NetClassTag
    v-if="source.kind === 'netClass'"
    :name="source.name"
    :color="source.color ?? null"
  />
  <code v-else-if="source.kind === 'rule'" class="rule-name">{{ source.name }}</code>
  <span v-else>{{ source.text }}</span>
</template>

<style scoped>
.rule-name {
  font-family: var(--font-mono, monospace);
  font-size: inherit;
  color: inherit;
}
</style>
