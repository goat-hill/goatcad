<script setup lang="ts">
/**
 * Settings ▸ About ▸ License — GoatCAD's own license, a row that opens to the
 * GPL's full text, as each third-party row opens to its own.
 */
import { onMounted, shallowRef } from 'vue'
import LicenseRow from './LicenseRow.vue'
import { loadLicenses, type LicenseEntry } from '../../lib/licenses'

const gpl = shallowRef<LicenseEntry | null>(null)
onMounted(async () => {
  gpl.value = {
    // The license's own title, shown as it is in every language.
    name: 'GNU General Public License v3.0',
    version: null,
    license: 'GPL-3.0-or-later',
    source: 'https://www.gnu.org/licenses/gpl-3.0.html',
    text: (await loadLicenses()).gpl,
    featured: true
  }
})
</script>

<template>
  <LicenseRow v-if="gpl" :entry="gpl" />
</template>
