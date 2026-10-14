<script setup lang="ts">
import Icon from './Icon.vue'
</script>

<template>
  <!-- Isometric cube outline, sized for the floating-toolbar tool chips.
       Used by the PCB and footprint editors' 3D-view toggle buttons. Geometry
       lives in the icon registry (lib/icons.ts, `cube`). -->
  <Icon name="cube" class="cube-icon" />
</template>

<style scoped>
.cube-icon {
  width: 15px;
  height: 15px;
}
</style>
