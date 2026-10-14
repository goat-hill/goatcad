<script setup lang="ts">
/**
 * Settings ▸ About — the notices THIRD_PARTY_NOTICES.txt carries, as a list:
 * the major components by name, the rest folded under one row, each group in
 * alphabetical order. A row opens to its license text and a link to its source.
 *
 * Chromium is the one row the list cannot carry: it is compiled into
 * Electron's binary, its notices (LICENSES.chromium.html, beside the app) run
 * to 20 MB, and only the running app knows its version. So it is added here,
 * as a link to the LICENSE tagged with that version.
 *
 * The file stays the complete notice a build owes. Names, versions, SPDX ids
 * and license texts are data, shown as they are in every language.
 */
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import LicenseRow from './LicenseRow.vue'
import { loadLicenses, type LicenseEntry } from '../../lib/licenses'

const { t } = useI18n()

const entries = shallowRef<LicenseEntry[]>([])
onMounted(async () => {
  entries.value = (await loadLicenses()).components
})

const chromiumVersion = window.electron.process.versions.chrome
const chromium: LicenseEntry[] = chromiumVersion
  ? [
      {
        name: 'Chromium',
        version: chromiumVersion,
        license: 'BSD-3-Clause',
        source: null,
        text: '',
        featured: true,
        link: `https://chromium.googlesource.com/chromium/src/+/refs/tags/${chromiumVersion}/LICENSE`
      }
    ]
  : []

/** By name, case-blind, an npm scope ignored: `@xterm/xterm` sorts as xterm. */
const sortKey = (entry: LicenseEntry): string => entry.name.replace(/^@[^/]+\//, '').toLowerCase()
const sorted = (list: LicenseEntry[]): LicenseEntry[] =>
  [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

const featured = computed(() =>
  sorted([...entries.value.filter((entry) => entry.featured), ...chromium])
)
const supporting = computed(() => sorted(entries.value.filter((entry) => !entry.featured)))
const showSupporting = ref(false)

const keyOf = (entry: LicenseEntry): string => `${entry.name}@${entry.version ?? ''}`
</script>

<template>
  <div v-if="entries.length" class="licenses">
    <LicenseRow v-for="entry in featured" :key="keyOf(entry)" :entry="entry" />
    <button
      class="supporting-row"
      type="button"
      :aria-expanded="showSupporting"
      @click="showSupporting = !showSupporting"
    >
      <Icon name="chevron-right" class="disclosure" :class="{ open: showSupporting }" />
      {{ t('settings.about.supporting', { count: supporting.length }, supporting.length) }}
    </button>
    <div v-if="showSupporting" class="supporting">
      <LicenseRow v-for="entry in supporting" :key="keyOf(entry)" :entry="entry" />
    </div>
  </div>
</template>

<style scoped>
.licenses,
.supporting {
  display: flex;
  flex-direction: column;
}

.supporting {
  margin-left: 24px;
}

/* LicenseRow's row, holding a count instead of a name. */
.supporting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vscode-text-muted);
  font: inherit;
  font-size: var(--text-body-sm);
  text-align: left;
  cursor: pointer;
}

.supporting-row:hover {
  background: var(--vscode-bg-hover);
}
</style>
