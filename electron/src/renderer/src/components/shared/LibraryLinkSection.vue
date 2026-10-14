<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { LibrarySyncStatus } from '../../lib/librarySync'
import Icon from './Icon.vue'
import PartTrail from './PartTrail.vue'

/**
 * The library section under the properties of a placed part — a symbol on a
 * sheet, a footprint on a board (docs/libraries-workstream.md §5): how
 * the part stands against its library copy, and the four actions on that
 * link, so none of them needs the part's properties dialog.
 */
const props = defineProps<{
  kind: 'symbol' | 'footprint'
  status: LibrarySyncStatus
  readOnly?: boolean
  /** Edit (this design's own copy) is not built yet; the button says so in place. */
  canEdit?: boolean
  /** The library part the selection shares, as the chooser names it; absent when it names several. */
  part?: { library: string; name: string; scope?: string } | null
}>()

const emit = defineEmits<{
  (e: 'update'): void
  (e: 'change'): void
  (e: 'edit'): void
  (e: 'edit-library'): void
}>()

const { t } = useI18n()

const key = (name: string): string =>
  `shared.libraryLink.${name}${props.kind === 'symbol' ? 'Symbol' : 'Footprint'}`
</script>

<template>
  <section class="library-link">
    <h3 class="eyebrow">{{ t('shared.libraryLink.title') }}</h3>
    <p class="status" :class="status.tone">
      <Icon v-if="status.tone === 'ok'" name="status-ok" class="mark" />
      <Icon v-else-if="status.tone === 'warn'" name="status-warning" class="mark" />
      <span v-else class="dot" aria-hidden="true"></span>
      <span class="label">{{ status.label }}</span>
    </p>
    <PartTrail
      v-if="part"
      class="source"
      :scope="part.scope"
      :library="part.library"
      :name="part.name"
    />
    <div class="buttons">
      <button
        class="btn-outline btn-md btn-panel"
        type="button"
        :disabled="readOnly || !status.inLibrary"
        :title="t('shared.libraryLink.updateHint')"
        @click="emit('update')"
      >
        <Icon name="refresh" />
        {{ t('shared.libraryLink.update') }}
      </button>
      <button
        class="btn-outline btn-md btn-panel"
        type="button"
        :disabled="readOnly"
        :title="t(key('changeHint'))"
        @click="emit('change')"
      >
        <Icon name="swap" />
        {{ t(key('change')) }}
      </button>
      <button
        class="btn-outline btn-md btn-panel"
        type="button"
        :disabled="readOnly || !canEdit"
        :title="t(key('editHint'))"
        @click="emit('edit')"
      >
        <Icon name="pencil" />
        {{ t(key('edit')) }}
      </button>
      <button
        class="btn-outline btn-md btn-panel"
        type="button"
        :disabled="!status.loneInLibrary"
        :title="t(key('editLibraryHint'))"
        @click="emit('edit-library')"
      >
        <Icon name="libraries" />
        {{ t(key('editLibrary')) }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.library-link {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 10px 12px;
}

/* Section eyebrow, as the property groups' titles. */
.eyebrow {
  margin: 0;
  padding-top: 2px;
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin: 0 3px;
  border-radius: 50%;
  background-color: var(--vscode-text-muted);
}

.mark {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
}

.status.ok .mark {
  color: var(--vscode-success);
}

.status.warn .mark {
  color: var(--vscode-warning);
}

.status.warn .label {
  color: var(--vscode-warning);
}

.source {
  margin-left: 22px;
}

/* One action a row (`btn-panel`). */
.buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}
</style>
