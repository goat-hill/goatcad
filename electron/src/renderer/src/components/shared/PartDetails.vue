<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'

/**
 * What a part is, read beside its previews — the library chooser's details
 * and the Component view's alike: its id, description, keywords (a pill each),
 * where it comes from and its datasheet. Rows only one surface has (the
 * chooser's pin check) go in the default slot, after the source.
 */
const props = defineProps<{
  id: string
  description?: string
  /** KiCad's keywords: space-separated. */
  keywords?: string
  /** Where it comes from, already worded ("Standard", "Project"). */
  source?: string
  /** A web address, opened in the browser. */
  datasheet?: string | null
}>()
const { t } = useI18n()

const keywordList = computed(() => (props.keywords ?? '').split(/\s+/).filter(Boolean))

const openDatasheet = (): void => {
  // The window's open handler hands every new window to the system browser.
  if (props.datasheet) window.open(props.datasheet, '_blank', 'noopener')
}
</script>

<template>
  <div class="part-details">
    <dl class="details">
      <dt>{{ t('shared.libraryChooser.details.name') }}</dt>
      <dd class="mono">{{ id }}</dd>
      <template v-if="description">
        <dt>{{ t('shared.libraryChooser.details.description') }}</dt>
        <dd>{{ description }}</dd>
      </template>
      <template v-if="keywordList.length">
        <dt>{{ t('shared.libraryChooser.details.keywords') }}</dt>
        <dd class="keywords">
          <span v-for="keyword in keywordList" :key="keyword" class="keyword">{{ keyword }}</span>
        </dd>
      </template>
      <template v-if="source">
        <dt>{{ t('shared.libraryChooser.details.source') }}</dt>
        <dd>{{ source }}</dd>
      </template>
      <slot />
      <template v-if="datasheet">
        <dt>{{ t('shared.libraryChooser.details.datasheet') }}</dt>
        <dd>
          <button class="btn-subtle btn-sm link" @click="openDatasheet">
            {{ t('shared.libraryChooser.openDatasheet') }}
            <Icon name="open-external" />
          </button>
        </dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
/* The data surface (`--vscode-data-bg`), values in the data foreground and labels muted — the
   property table's split. */
.part-details {
  height: 100%;
  overflow-y: auto;
  padding: 12px 16px;
  background: var(--vscode-data-bg);
}

.details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  margin: 0;
}

.details :deep(dt) {
  color: var(--vscode-text-muted);
}

.details :deep(dd) {
  display: flex;
  flex-direction: column;
  margin: 0;
  color: var(--vscode-data-fg);
  overflow-wrap: anywhere;
}

.details .mono {
  font-family: var(--font-mono);
}

/* One pill a keyword, wrapping as a run of tags does. */
.details dd.keywords {
  flex-flow: row wrap;
  gap: 4px;
}

.keyword {
  /* A fixed box and a unit line, so the caption sits in the middle of the pill rather than
     on the surrounding text's taller line. */
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  line-height: 1;
  border-radius: 999px;
  background: var(--vscode-overlay-control-hover);
  color: var(--vscode-data-fg);
  font-size: var(--text-caption);
  white-space: nowrap;
}

.link {
  align-self: flex-start;
  padding-left: 0;
}
</style>
