<script setup lang="ts">
import Modal from './shared/Modal.vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { delayedVisible } from '../lib/delayedVisible'
import type { SampleCatalog, SampleError, SampleOpenResult } from '../../../preload/sampleTypes'

/**
 * Open sample project: the catalog is fetched when this dialog opens, never
 * before, so opening it is the user's consent to reach GitHub. The chosen
 * sample is downloaded into temp by main (sampleProjects.ts), so there is no
 * folder to pick.
 */
const emit = defineEmits<{
  (event: 'opened', result: Extract<SampleOpenResult, { ok: true }>): void
  (event: 'cancel'): void
}>()

const { t, locale } = useI18n()

const catalog = ref<SampleCatalog | null>(null)
const error = ref<SampleError | null>(null)
const loading = ref(false)
const downloading = ref(false)
const selected = ref<string | null>(null)

const showLoading = delayedVisible(() => loading.value)

const load = async (): Promise<void> => {
  loading.value = true
  error.value = null
  try {
    const result = await window.api.listSamples()
    if (result.ok) {
      catalog.value = result.catalog
      selected.value = result.catalog.samples[0]?.dir ?? null
    } else {
      error.value = result.error
    }
  } finally {
    loading.value = false
  }
}

const open = async (): Promise<void> => {
  if (!selected.value || downloading.value) return
  downloading.value = true
  error.value = null
  try {
    const result = await window.api.openSample(selected.value)
    if (result.ok) emit('opened', result)
    else error.value = result.error
  } finally {
    downloading.value = false
  }
}

const errorText = computed(() => {
  switch (error.value) {
    case 'offline':
      return t('welcome.samples.errors.offline')
    case 'rateLimited':
      return t('welcome.samples.errors.rateLimited')
    default:
      return t('welcome.samples.errors.unavailable')
  }
})

const sizeText = (bytes: number): string =>
  t('welcome.samples.size', {
    size: (bytes / 1_000_000).toLocaleString(locale.value, { maximumFractionDigits: 1 })
  })

// Escape abandons (DESIGN.md §Modals); each sample is its own action, so Enter has none.
onMounted(() => void load())
</script>

<template>
  <Modal @dismiss="emit('cancel')">
    <div class="dialog">
      <h2 class="dialog-title">{{ t('welcome.samples.title') }}</h2>
      <p class="dialog-source">github.com/goat-hill/goatcad-sample-projects</p>

      <div v-if="showLoading" class="dialog-status">
        <span class="item-spinner" />{{ t('welcome.samples.loading') }}
      </div>

      <template v-else-if="catalog">
        <p v-if="catalog.samples.length === 0" class="dialog-status">
          {{ t('welcome.samples.empty') }}
        </p>
        <div v-else class="sample-list" role="radiogroup">
          <label
            v-for="sample in catalog.samples"
            :key="sample.dir"
            class="sample"
            :class="{ selected: selected === sample.dir }"
            @dblclick="open"
          >
            <input v-model="selected" type="radio" :value="sample.dir" :disabled="downloading" />
            <span class="sample-text">
              <span class="sample-head">
                <span class="sample-name">{{ sample.dir }}</span>
                <span class="sample-size">{{ sizeText(sample.bytes) }}</span>
              </span>
              <span v-if="sample.description" class="sample-desc">{{ sample.description }}</span>
            </span>
          </label>
        </div>
      </template>

      <p v-if="error" class="dialog-error">{{ errorText }}</p>

      <div class="dialog-actions">
        <button class="btn-outline btn-md" @click="emit('cancel')">
          {{ t('welcome.samples.cancel') }}
        </button>
        <button v-if="error && !catalog" class="btn-cta btn-md" :disabled="loading" @click="load">
          {{ t('welcome.samples.retry') }}
        </button>
        <button v-else class="btn-cta btn-md" :disabled="!selected || downloading" @click="open">
          {{ downloading ? t('welcome.samples.downloading') : t('welcome.samples.open') }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  width: 90%;
  max-width: 480px;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

.dialog-title {
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

.dialog-source {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--vscode-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-status {
  display: flex;
  align-items: center;
  margin: 18px 0 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body);
}

.sample-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  margin-top: 18px;
  overflow-y: auto;
}

.sample {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  cursor: pointer;
}

.sample:hover {
  background-color: var(--vscode-bg-hover);
}

.sample.selected {
  border-color: var(--vscode-accent-border);
}

.sample input {
  margin: 2px 0 0;
  accent-color: var(--vscode-accent);
}

.sample-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sample-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.sample-name {
  color: var(--vscode-text-light);
  font-size: var(--text-body);
  font-weight: 600;
}

.sample-size {
  flex: none;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.sample-desc {
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  line-height: 1.4;
}

.dialog-error {
  margin: 12px 0 0;
  color: var(--vscode-error, #d9534f);
  font-size: var(--text-body-sm);
}

.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 22px;
}
</style>
