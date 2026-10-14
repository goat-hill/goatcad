<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ComponentTypeIcon from './shared/ComponentTypeIcon.vue'
import PartTrail from './shared/PartTrail.vue'
import type { IndexRecord } from '../lib/libraryIndex'

/**
 * The row above a part's preview — its kind, then what is shown: the trail
 * (scope › library › name) when there is one record, a dropdown naming each
 * when there is a choice. One head for the Component view's panes and the
 * library chooser's, so a part reads the same wherever it is previewed.
 */
const props = withDefaults(
  defineProps<{
    type: 'symbol' | 'footprint' | 'model'
    records: IndexRecord[]
    /** The shown record's index; -1 for none, when `noneLabel` offers it. */
    selected: number
    /** Offer "none" as the first choice (a generic part's footprint). */
    noneLabel?: string
    /** The records are shown together, not chosen between: name the first and count the rest. */
    together?: boolean
    /** An Open button, for the full editor tab. */
    openable?: boolean
    /** Said when there is nothing to show. */
    emptyLabel?: string
  }>(),
  { noneLabel: '', together: false, openable: false, emptyLabel: '' }
)
const emit = defineEmits<{
  (e: 'update:selected', v: number): void
  (e: 'open', record: IndexRecord): void
}>()
const { t } = useI18n()

const current = computed<IndexRecord | null>(() =>
  props.selected < 0 ? null : (props.records[props.selected] ?? props.records[0] ?? null)
)
const choosing = computed(
  () => !props.together && props.records.length + (props.noneLabel ? 1 : 0) > 1
)
const typeLabel = computed(() =>
  props.type === 'symbol'
    ? t('componentView.kind.symbol')
    : props.type === 'footprint'
      ? t('componentView.kind.footprint')
      : t('componentView.kind.model')
)
</script>

<template>
  <div class="slot-head">
    <span class="type-tag" :class="type">
      <span class="tag-icon"><ComponentTypeIcon :type="type" /></span>
      {{ typeLabel }}
    </span>
    <select
      v-if="choosing"
      class="picker"
      :value="current ? records.indexOf(current) : -1"
      @change="emit('update:selected', +($event.target as HTMLSelectElement).value)"
    >
      <option v-if="noneLabel" :value="-1">{{ noneLabel }}</option>
      <option v-for="(r, i) in records" :key="r.id" :value="i">
        {{ t('componentView.choice', { name: r.name, library: r.library }) }}
      </option>
    </select>
    <PartTrail
      v-else-if="current"
      class="crumb"
      :scope="current.scope"
      :library="current.library"
      :name="current.name"
    >
      <span v-if="together && records.length > 1" class="more">{{
        t('componentView.more', { n: records.length - 1 })
      }}</span>
    </PartTrail>
    <span v-else class="crumb none">{{ emptyLabel || t('componentView.noneAssociated') }}</span>
    <button
      v-if="openable && current"
      class="open-btn"
      :title="t('componentView.openTitle')"
      @click="emit('open', current)"
    >
      {{ t('componentView.open') }}
    </button>
  </div>
</template>

<style scoped>
.slot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  /* Fixed height so panes with a picker align with those without one. */
  height: 34px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--vscode-border, #24302b);
  background: var(--vscode-bg-sidebar, #1a221f);
  flex: none;
}

.type-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* A fixed box and a unit line, as the keyword pills: the caption centers on the tag's own
     height, not on the taller line of the head's text. */
  height: 20px;
  box-sizing: border-box;
  padding: 0 5px 0 4px;
  line-height: 1;
  font-size: var(--text-caption);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 3px;
}

/* Color is inherited from .type-tag.<type> via currentColor. */
.tag-icon {
  flex: none;
  width: 11px;
  height: 11px;
  display: inline-flex;
}

.type-tag.symbol {
  color: var(--vscode-kind-symbol);
}
.type-tag.footprint {
  color: var(--vscode-kind-footprint);
}
.type-tag.model {
  color: var(--vscode-kind-model);
}

.crumb {
  flex: 1;
}

.crumb.none {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-body-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  color: var(--vscode-text-muted, #56655d);
}

.more {
  margin-left: 6px;
}

/* A choice takes the trail's place, the name inside it. */
.picker {
  flex: 1;
  min-width: 0;
  height: 24px;
  box-sizing: border-box;
  background: var(--vscode-input-bg);
  color: var(--vscode-text-light, #f0f0f2);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  font-size: var(--text-body-sm);
  padding: 0 4px;
  outline: none;
}

.picker:focus {
  border-color: var(--vscode-input-focus);
}

.open-btn {
  flex: none;
  height: 20px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  background: var(--vscode-input-bg);
  color: var(--vscode-text, #d8e0dc);
  font-size: var(--text-body-sm);
  font-weight: 600;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.open-btn:hover {
  border-color: var(--vscode-accent, #cca250);
  color: var(--vscode-accent, #cca250);
}
</style>
