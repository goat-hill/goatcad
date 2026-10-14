<script setup lang="ts">
/**
 * One license in Settings ▸ About: name, version and SPDX id on a row that
 * opens to a link to the source and the license text. A row with a `link`
 * opens nothing; it links out (Chromium, whose notices are too big to carry).
 */
import { ref } from 'vue'
import Icon from '../shared/Icon.vue'
import type { LicenseEntry } from '../../lib/licenses'

defineProps<{ entry: LicenseEntry }>()

const open = ref(false)
</script>

<template>
  <a v-if="entry.link" class="license-row" :href="entry.link" target="_blank" rel="noreferrer">
    <Icon name="open-external" class="license-link" />
    <span class="license-name">{{ entry.name }}</span>
    <code v-if="entry.version" class="license-version">{{ entry.version }}</code>
    <code v-if="entry.license" class="license-id">{{ entry.license }}</code>
  </a>
  <template v-else>
    <button class="license-row" type="button" :aria-expanded="open" @click="open = !open">
      <Icon name="chevron-right" class="disclosure" :class="{ open }" />
      <span class="license-name">{{ entry.name }}</span>
      <code v-if="entry.version" class="license-version">{{ entry.version }}</code>
      <code v-if="entry.license" class="license-id">{{ entry.license }}</code>
    </button>
    <div v-if="open" class="license-detail">
      <a v-if="entry.source" :href="entry.source" target="_blank" rel="noreferrer">
        {{ entry.source }}
      </a>
      <pre class="license-text">{{ entry.text }}</pre>
    </div>
  </template>
</template>

<style scoped>
.license-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vscode-text);
  font: inherit;
  font-size: var(--text-body-sm);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.license-row:hover {
  background: var(--vscode-bg-hover);
}

.license-link {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--vscode-text-muted);
}

.license-name {
  color: var(--vscode-text-light);
}

.license-version,
.license-id {
  font-family: var(--font-mono);
  color: var(--vscode-text-muted);
}

.license-id {
  margin-left: auto;
}

.license-detail {
  margin: 4px 0 12px 28px;
  font-size: var(--text-body-sm);
}

.license-detail a {
  color: var(--vscode-accent);
}

.license-text {
  max-height: 280px;
  margin: 8px 0 0;
  padding: 8px 12px;
  overflow: auto;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  background: var(--vscode-data-bg);
  color: var(--vscode-data-fg);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.45;
  white-space: pre-wrap;
}
</style>
