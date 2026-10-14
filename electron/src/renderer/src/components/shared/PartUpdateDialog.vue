<script lang="ts">
import {
  loadPartUpdatePreferences,
  partUpdateChoices,
  rememberPartUpdateChoices
} from '../../lib/partUpdatePreferences'

// Read with the editors that open the sheet, so its first opening has them.
void loadPartUpdatePreferences()
</script>

<script setup lang="ts">
import Modal from './Modal.vue'
import { computed, onUnmounted, ref } from 'vue'
import { useModalKeys } from '../../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import type {
  PartUpdateMode,
  PartUpdateRequest,
  PartUpdateRow,
  PartUpdateScope
} from '../../lib/partUpdate'
import Icon from './Icon.vue'

/**
 * Update from library and Change, as one sheet for symbols and footprints
 * (`lib/partUpdate.ts`, docs/libraries-workstream.md §5) — KiCad's
 * Update Symbols / Change Symbols and their footprint pair. The button that
 * opened it chose the verb; the two differ only in their defaults and whether
 * a part is chosen. Below, which parts (KiCad's scopes), what the library
 * resets, and each part's outcome before anything is written.
 */
export interface PartUpdateOption {
  key: string
  label: string
}

const props = defineProps<{
  kind: 'symbol' | 'footprint'
  mode: PartUpdateMode
  /** The part a change swaps to; for an update, the selection's own, shown and fixed. */
  libId: string
  /** Parts in the selection; 0 disables the selection scope. */
  selectionCount: number
  /** What the matching scopes start from: the lone selected part's. */
  seeds: { reference: string; value: string; libId: string }
  options: PartUpdateOption[]
  defaults: Record<PartUpdateMode, Record<string, boolean>>
  /** Symbols: the fields the run may touch, ticked to begin with but for `fieldsOff`. */
  fieldNames?: string[]
  /** Fields listed but unticked to begin with (Reference and Value, as KiCad has them). */
  fieldsOff?: string[]
  preview: (request: PartUpdateRequest) => PartUpdateRow[]
  /** Hidden while the library chooser stands over it, keeping what was set. */
  paused?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:libId', libId: string): void
  (e: 'confirm', request: PartUpdateRequest): void
  /** Browse: the library chooser, for the part a change swaps to. */
  (e: 'choose'): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const noun = (key: string): string =>
  t(`shared.partUpdate.${key}${props.kind === 'symbol' ? 'Symbol' : 'Footprint'}`)

const scope = ref<PartUpdateScope>(
  props.selectionCount > 0 ? 'selection' : props.mode === 'change' ? 'libId' : 'all'
)
const patterns = ref<Record<'reference' | 'value' | 'libId', string>>({ ...props.seeds })
// The ticks it was last left with for this kind and verb, over KiCad's defaults.
const remembered = partUpdateChoices(props.kind, props.mode)
const known = new Set(props.options.map((option) => option.key))
const checked = ref<Record<string, boolean>>({
  ...props.defaults[props.mode],
  ...Object.fromEntries(Object.entries(remembered?.options ?? {}).filter(([key]) => known.has(key)))
})
const fieldsOff = props.fieldsOff ?? []
const fields = ref<Set<string>>(
  new Set(
    (props.fieldNames ?? []).filter(
      (name) => !fieldsOff.includes(name) || !!remembered?.fieldsOn.includes(name)
    )
  )
)
onUnmounted(() =>
  rememberPartUpdateChoices(props.kind, props.mode, {
    options: { ...checked.value },
    fieldsOn: [...fields.value].filter((name) => fieldsOff.includes(name))
  })
)

/**
 * Under Update the part field starts as the selection's own and means "each
 * part's own" until it is edited or browsed: only then does every part in
 * scope take it, so an untouched Update over the whole design never makes
 * every part one part.
 */
const startingLibId = props.libId
const touched = computed(() => props.mode === 'change' || props.libId !== startingLibId)

const request = computed<PartUpdateRequest>(() => ({
  mode: props.mode,
  libId: touched.value ? props.libId.trim() : '',
  scope: scope.value,
  pattern:
    scope.value === 'reference' || scope.value === 'value' || scope.value === 'libId'
      ? patterns.value[scope.value]
      : '',
  options: { ...checked.value },
  fields: [...fields.value]
}))
const rows = computed(() => props.preview(request.value))
const runnable = computed(() => rows.value.filter((row) => !row.loading && !row.notFound))
const loading = computed(() => rows.value.some((row) => row.loading))
const canRun = computed(
  () =>
    !loading.value &&
    runnable.value.length > 0 &&
    (props.mode === 'update' || !!request.value.libId)
)

const scopes = computed((): Array<{ id: PartUpdateScope; label: string; pattern?: boolean }> => [
  {
    id: 'selection',
    label:
      props.kind === 'symbol'
        ? t('shared.partUpdate.scopeSelectionSymbol', { count: props.selectionCount })
        : t('shared.partUpdate.scopeSelectionFootprint', { count: props.selectionCount })
  },
  { id: 'reference', label: t('shared.partUpdate.scopeReference'), pattern: true },
  { id: 'value', label: t('shared.partUpdate.scopeValue'), pattern: true },
  { id: 'libId', label: t('shared.partUpdate.scopeLibId'), pattern: true },
  ...(props.mode === 'update' ? [{ id: 'all' as const, label: noun('scopeAll') }] : [])
])

const setOption = (key: string, event: Event): void => {
  checked.value = { ...checked.value, [key]: (event.target as HTMLInputElement).checked }
}
const setAllOptions = (value: boolean): void => {
  checked.value = Object.fromEntries(props.options.map((option) => [option.key, value]))
}
const setField = (name: string, event: Event): void => {
  const next = new Set(fields.value)
  if ((event.target as HTMLInputElement).checked) next.add(name)
  else next.delete(name)
  fields.value = next
}
const setAllFields = (value: boolean): void => {
  fields.value = new Set(value ? (props.fieldNames ?? []) : [])
}

const confirm = (): void => {
  if (canRun.value) emit('confirm', request.value)
}

/** Enter runs it (DESIGN.md §Modals); not while the chooser it opened is up. */
useModalKeys({ confirm, active: () => !props.paused })
</script>

<template>
  <Modal :hidden="paused" @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">
        <Icon :name="mode === 'change' ? 'swap' : 'refresh'" class="title-icon" />
        {{ mode === 'change' ? noun('changeTitle') : noun('updateTitle') }}
      </h2>

      <label class="part">
        <span class="eyebrow">
          {{ mode === 'change' ? noun('newPart') : noun('fromPart') }}
        </span>
        <span class="part-row">
          <input
            class="field-md mono part-input"
            :value="libId"
            :placeholder="
              mode === 'update' ? t('shared.partUpdate.eachOwn') : noun('newPartPlaceholder')
            "
            @input="emit('update:libId', ($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="confirm"
          />
          <button class="btn-outline btn-md" type="button" @click="emit('choose')">
            <Icon name="libraries" />
            {{ t('shared.partUpdate.browse') }}
          </button>
        </span>
        <span v-if="mode === 'update'" class="hint">
          {{ touched ? noun('updateToHint') : noun('updateHint') }}
        </span>
      </label>

      <div class="columns">
        <fieldset class="group">
          <legend class="eyebrow">{{ noun('scope') }}</legend>
          <div v-for="item in scopes" :key="item.id" class="scope">
            <label
              class="choice"
              :class="{ 'is-disabled': item.id === 'selection' && selectionCount === 0 }"
            >
              <input
                v-model="scope"
                type="radio"
                :value="item.id"
                :disabled="item.id === 'selection' && selectionCount === 0"
              />
              <span>{{ item.label }}</span>
            </label>
            <input
              v-if="
                item.pattern &&
                (item.id === 'reference' || item.id === 'value' || item.id === 'libId')
              "
              v-model="patterns[item.id]"
              class="field-sm pattern"
              :class="{ mono: item.id !== 'value' }"
              :disabled="scope !== item.id"
              @focus="scope = item.id"
            />
          </div>
          <span class="hint">{{ t('shared.partUpdate.wildcards') }}</span>
        </fieldset>

        <fieldset class="group">
          <legend class="eyebrow">{{ t('shared.partUpdate.reset') }}</legend>
          <label v-for="option in options" :key="option.key" class="choice">
            <input
              type="checkbox"
              :checked="checked[option.key]"
              @change="setOption(option.key, $event)"
            />
            <span>{{ option.label }}</span>
          </label>
          <span class="all-none">
            <button class="btn-subtle btn-sm" type="button" @click="setAllOptions(true)">
              {{ t('shared.partUpdate.all') }}
            </button>
            <button class="btn-subtle btn-sm" type="button" @click="setAllOptions(false)">
              {{ t('shared.partUpdate.none') }}
            </button>
          </span>

          <template v-if="fieldNames?.length">
            <span class="eyebrow sub">{{ t('shared.partUpdate.fields') }}</span>
            <div class="field-list">
              <label v-for="name in fieldNames" :key="name" class="choice">
                <input
                  type="checkbox"
                  :checked="fields.has(name)"
                  @change="setField(name, $event)"
                />
                <span class="mono">{{ name }}</span>
              </label>
            </div>
            <span class="all-none">
              <button class="btn-subtle btn-sm" type="button" @click="setAllFields(true)">
                {{ t('shared.partUpdate.all') }}
              </button>
              <button class="btn-subtle btn-sm" type="button" @click="setAllFields(false)">
                {{ t('shared.partUpdate.none') }}
              </button>
            </span>
          </template>
        </fieldset>
      </div>

      <div class="outcome">
        <span class="eyebrow">{{ noun('outcome') }} · {{ runnable.length }}</span>
        <ul v-if="rows.length" class="rows">
          <li v-for="row in rows" :key="row.reference + row.from" class="row">
            <span class="ref">{{ row.reference }}</span>
            <span v-if="row.loading" class="detail">{{ t('shared.partUpdate.loading') }}</span>
            <span v-else-if="row.notFound" class="detail warn">
              {{ t('shared.partUpdate.notFound', { libId: row.to }) }}
            </span>
            <template v-else>
              <span v-if="row.from !== row.to" class="detail mono">
                {{ row.from }}
                <Icon name="chevron-right" class="arrow" />
                {{ row.to }}
              </span>
              <span v-else class="detail">
                {{ row.matches ? t('shared.partUpdate.matches') : t('shared.partUpdate.differs') }}
              </span>
              <span v-for="note in row.notes ?? []" :key="note" class="detail">{{ note }}</span>
              <span v-for="warning in row.warnings ?? []" :key="warning" class="detail warn">
                {{ warning }}
              </span>
            </template>
          </li>
        </ul>
        <p v-else class="hint rows empty">{{ noun('nothing') }}</p>
      </div>

      <div class="actions">
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('shared.partUpdate.cancel') }}
        </button>
        <button class="btn-cta btn-md" type="button" :disabled="!canRun" @click="confirm">
          {{
            mode === 'change'
              ? t('shared.partUpdate.confirmChange')
              : t('shared.partUpdate.confirmUpdate')
          }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 90%;
  max-width: 760px;
  max-height: 90vh;
  padding: 24px;
  overflow-y: auto;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

.title-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: var(--vscode-text-light);
}

/* Section eyebrow per DESIGN.md §Section eyebrows. */
.eyebrow {
  padding: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.eyebrow.sub {
  margin-top: 10px;
}

.part {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.part-row {
  display: flex;
  gap: 8px;
}

.part-input {
  flex: 1;
  min-width: 0;
}

.mono {
  font-family: var(--font-mono);
}

.columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 32px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.group legend {
  margin-bottom: 4px;
}

.scope {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice input {
  flex-shrink: 0;
  margin: 0;
  accent-color: var(--vscode-accent);
}

.choice.is-disabled {
  color: var(--vscode-text-muted);
  cursor: default;
}

/* The pattern sits under its radio, indented to the label. */
.pattern {
  margin-left: 21px;
}

.pattern:disabled {
  opacity: 0.5;
}

.field-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
}

.all-none {
  display: flex;
  gap: 4px;
}

.rows.empty {
  padding-top: 8px;
}

/* Hint per DESIGN.md §Hints & captions. */
.hint {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.outcome {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* A fixed height, so a scope that picks more or fewer parts never resizes the sheet. */
.rows {
  height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border-top: 1px solid var(--vscode-border);
  list-style: none;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--vscode-border);
  font-size: var(--text-body-sm);
}

.ref {
  min-width: 52px;
  color: var(--vscode-text-light);
  font-family: var(--font-mono);
}

.detail {
  color: var(--vscode-text-muted);
}

.detail.mono {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.detail.warn {
  color: var(--vscode-warning);
}

.arrow {
  width: 12px;
  height: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
