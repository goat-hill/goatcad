<script setup lang="ts">
/** One keycap (DESIGN.md §Hotkeys), with the step mark of a key that steps a setting. */
import Icon from './Icon.vue'
import { keyCapLabel, type KeyCap } from '../../lib/keyCap'

defineProps<{ cap: KeyCap }>()
</script>

<template>
  <kbd class="kbd"
    ><span>{{ keyCapLabel(cap) }}</span
    ><Icon
      v-if="typeof cap !== 'string'"
      class="kbd-step"
      :name="cap.step === 'up' ? 'step-up' : 'step-down'"
  /></kbd>
</template>

<style scoped>
/* Drawn at exactly 8px, its grid, a hair off the number and quieter than it. */
.kbd-step {
  width: 8px;
  height: 8px;
  margin-left: 2px;
  opacity: 0.7;
}
</style>
