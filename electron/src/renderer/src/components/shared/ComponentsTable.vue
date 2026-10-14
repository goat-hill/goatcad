<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import {
  BOM_FIELD_DNP,
  BOM_FIELD_EXCLUDE_FROM_BOARD,
  BOM_FIELD_EXCLUDE_FROM_BOM,
  type BomFieldSetting,
  type BomSettings
} from '../../lib/kicad/project'
import {
  buildRows,
  flagKeyForField,
  SHEET_FIELD,
  type ComponentRecord,
  type FlagKey,
  type TableRow
} from '../../lib/componentsTable'

const { t } = useI18n()

// A Map, since field names are user text and an object would answer
// `constructor` from its prototype.
const BUILTIN_FIELD_KEYS: ReadonlyMap<string, string> = new Map([
  ['Reference', 'reference'],
  [SHEET_FIELD, 'sheet'],
  ['Value', 'value'],
  [BOM_FIELD_DNP, 'dnp'],
  [BOM_FIELD_EXCLUDE_FROM_BOM, 'excludeFromBom'],
  [BOM_FIELD_EXCLUDE_FROM_BOARD, 'excludeFromBoard'],
  ['Footprint', 'footprint'],
  ['Datasheet', 'datasheet']
])

/** Builtin fields show a translated label; custom user-defined fields keep their own name. */
const fieldLabel = (field: BomFieldSetting): string => {
  const key = BUILTIN_FIELD_KEYS.get(field.name)
  return key ? t(`shared.componentsTable.fields.${key}`) : field.label
}

const props = defineProps<{
  records: ComponentRecord[]
  settings: BomSettings
  selectedIds: string[]
  readOnly?: boolean
  /**
   * When set, only rows whose every record id is in this set are editable
   * (the rest live on other sheets — select to navigate there and edit). When
   * omitted, all rows are editable, subject to readOnly.
   */
  editableIds?: ReadonlySet<string>
}>()

const emit = defineEmits<{
  (event: 'update:settings', settings: BomSettings): void
  (event: 'select', ids: string[]): void
  (event: 'edit-field', ids: string[], field: string, value: string): void
  (event: 'edit-flag', ids: string[], flag: FlagKey, value: boolean): void
  /** The Footprint cell's Browse: choose a footprint for these parts. */
  (event: 'browse-footprint', ids: string[]): void
}>()

const scrollBody = ref<HTMLElement | null>(null)
const columnsWrap = ref<HTMLElement | null>(null)
const editInput = ref<HTMLInputElement | null>(null)
// Template refs inside v-for collect into arrays; a function ref keeps the
// single live editor input addressable.
const setEditInputRef = (el: unknown): void => {
  editInput.value = el instanceof HTMLInputElement ? el : null
}
const columnsOpen = ref(false)
const expandedKeys = ref<ReadonlySet<string>>(new Set())
const editing = ref<{ rowKey: string; field: string } | null>(null)
const editValue = ref('')
let suppressScroll = false

const visibleFields = computed(() => props.settings.fields_ordered.filter((field) => field.show))
const rows = computed(() => buildRows(props.records, props.settings, expandedKeys.value))

interface DisplayRow {
  row: TableRow
  child: boolean
}

const displayRows = computed<DisplayRow[]>(() =>
  rows.value.flatMap((row) => {
    const items: DisplayRow[] = [{ row, child: false }]
    if (row.children) items.push(...row.children.map((child) => ({ row: child, child: true })))
    return items
  })
)

const selectedIdSet = computed(() => new Set(props.selectedIds))
const isRowSelected = (row: TableRow): boolean => row.ids.some((id) => selectedIdSet.value.has(id))

const selectRow = (row: TableRow): void => {
  suppressScroll = true
  emit('select', row.ids)
}

watch(
  () => props.selectedIds,
  async () => {
    if (suppressScroll) {
      suppressScroll = false
      return
    }
    await nextTick()
    scrollBody.value?.querySelector('tr.row-selected')?.scrollIntoView({ block: 'nearest' })
  }
)

const toggleExpanded = (key: string): void => {
  const next = new Set(expandedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedKeys.value = next
}

const toggleSort = (name: string): void => {
  const settings = props.settings
  emit(
    'update:settings',
    settings.sort_field === name
      ? { ...settings, sort_asc: !settings.sort_asc }
      : { ...settings, sort_field: name, sort_asc: true }
  )
}

const onFilterInput = (event: Event): void => {
  emit('update:settings', {
    ...props.settings,
    filter_string: (event.target as HTMLInputElement).value
  })
}

const toggleGroupSymbols = (event: Event): void => {
  emit('update:settings', {
    ...props.settings,
    group_symbols: (event.target as HTMLInputElement).checked
  })
}

const setFieldOption = (name: string, patch: Partial<BomFieldSetting>): void => {
  emit('update:settings', {
    ...props.settings,
    fields_ordered: props.settings.fields_ordered.map((field) =>
      field.name === name ? { ...field, ...patch } : field
    )
  })
}

const checked = (event: Event): boolean => (event.target as HTMLInputElement).checked

const closeColumnsOnOutsideClick = (event: MouseEvent): void => {
  if (columnsWrap.value && !columnsWrap.value.contains(event.target as Node)) {
    columnsOpen.value = false
  }
}
watch(columnsOpen, (open) => {
  if (open) document.addEventListener('mousedown', closeColumnsOnOutsideClick)
  else document.removeEventListener('mousedown', closeColumnsOnOutsideClick)
})
onUnmounted(() => document.removeEventListener('mousedown', closeColumnsOnOutsideClick))

/** A row is editable only if every underlying record lives on the active sheet. */
const isRowEditable = (row: TableRow): boolean =>
  !props.editableIds || row.ids.every((id) => props.editableIds!.has(id))

const isEditableCell = (row: TableRow, fieldName: string): boolean => {
  if (props.readOnly || flagKeyForField(fieldName) || fieldName === SHEET_FIELD) return false
  if (!isRowEditable(row)) return false
  return !(fieldName === 'Reference' && row.isGroup)
}

const isEditing = (row: TableRow, fieldName: string): boolean =>
  editing.value?.rowKey === row.key && editing.value.field === fieldName

const beginEdit = (row: TableRow, fieldName: string): void => {
  if (!isEditableCell(row, fieldName)) return
  editing.value = { rowKey: row.key, field: fieldName }
  editValue.value = row.values[fieldName] ?? ''
  void nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

const commitEdit = (row: TableRow): void => {
  if (!editing.value) return
  const field = editing.value.field
  const previous = row.values[field]
  editing.value = null
  if (editValue.value === (previous ?? '')) return
  emit('edit-field', row.ids, field, editValue.value)
}

const cancelEdit = (): void => {
  editing.value = null
}

const browseFootprint = (row: TableRow): void => {
  editing.value = null
  emit('browse-footprint', row.ids)
}

const onFlagChange = (row: TableRow, flag: FlagKey, event: Event): void => {
  emit('edit-flag', row.ids, flag, checked(event))
}
</script>

<template>
  <div class="components-table">
    <div class="table-controls">
      <input
        class="table-input filter-input"
        type="text"
        :placeholder="t('shared.componentsTable.filterPlaceholder')"
        :value="settings.filter_string"
        @input="onFilterInput"
      />
      <label class="control-check">
        <input type="checkbox" :checked="settings.group_symbols" @change="toggleGroupSymbols" />
        {{ t('shared.componentsTable.groupSymbols') }}
      </label>
      <div ref="columnsWrap" class="columns-wrap">
        <button
          class="columns-btn"
          :class="{ active: columnsOpen }"
          @click="columnsOpen = !columnsOpen"
        >
          {{ t('shared.componentsTable.columns') }}
          <Icon name="chevron-down" />
        </button>
        <div v-if="columnsOpen" class="columns-popover">
          <div class="columns-row columns-head">
            <span>{{ t('shared.componentsTable.columnsFieldHeader') }}</span>
            <span>{{ t('shared.componentsTable.columnsShowHeader') }}</span>
            <span>{{ t('shared.componentsTable.columnsGroupHeader') }}</span>
          </div>
          <div v-for="field in settings.fields_ordered" :key="field.name" class="columns-row">
            <span class="columns-label">{{ fieldLabel(field) }}</span>
            <input
              type="checkbox"
              :checked="field.show"
              @change="setFieldOption(field.name, { show: checked($event) })"
            />
            <input
              type="checkbox"
              :checked="field.group_by"
              @change="setFieldOption(field.name, { group_by: checked($event) })"
            />
          </div>
        </div>
      </div>
      <div class="controls-spacer"></div>
      <span class="record-count">
        {{ t('shared.componentsTable.recordCount', { count: records.length }) }}
      </span>
    </div>

    <div ref="scrollBody" class="table-scroll">
      <table class="sheet components-grid">
        <thead>
          <tr>
            <th
              v-for="field in visibleFields"
              :key="field.name"
              :class="{ 'flag-col': !!flagKeyForField(field.name) }"
              @click="toggleSort(field.name)"
            >
              {{ fieldLabel(field) }}
              <Icon
                v-if="settings.sort_field === field.name"
                :name="settings.sort_asc ? 'arrow-up' : 'arrow-down'"
                class="sort-indicator"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in displayRows"
            :key="item.row.key"
            :class="{
              'row-selected': isRowSelected(item.row),
              'row-child': item.child,
              'row-group': item.row.isGroup,
              'row-foreign': editableIds && !isRowEditable(item.row)
            }"
            :title="
              editableIds && !isRowEditable(item.row)
                ? t('shared.componentsTable.rowForeignTitle')
                : undefined
            "
            @click="selectRow(item.row)"
          >
            <td
              v-for="field in visibleFields"
              :key="field.name"
              :class="{ 'flag-col': !!flagKeyForField(field.name) }"
              @click="beginEdit(item.row, field.name)"
            >
              <template v-if="field.name === 'Reference'">
                <span class="reference-cell" :class="{ 'child-indent': item.child }">
                  <button
                    v-if="item.row.isGroup"
                    class="expand-caret"
                    :title="
                      item.row.children
                        ? t('shared.componentsTable.collapseGroup')
                        : t('shared.componentsTable.expandGroup')
                    "
                    @click.stop="toggleExpanded(item.row.key)"
                  >
                    <Icon
                      name="chevron-right"
                      class="disclosure"
                      :class="{ open: item.row.children }"
                    />
                  </button>
                  <input
                    v-if="isEditing(item.row, field.name)"
                    :ref="setEditInputRef"
                    v-model="editValue"
                    class="table-input cell-input"
                    @keydown.enter.prevent="commitEdit(item.row)"
                    @keydown.esc.stop="cancelEdit"
                    @blur="commitEdit(item.row)"
                    @click.stop
                  />
                  <template v-else>
                    <span class="reference-label">{{ item.row.referenceLabel }}</span>
                    <span v-if="item.row.isGroup" class="group-count">{{ item.row.count }}</span>
                  </template>
                </span>
              </template>
              <template v-else-if="flagKeyForField(field.name)">
                <input
                  type="checkbox"
                  :disabled="readOnly || !isRowEditable(item.row)"
                  :checked="item.row.flags[flagKeyForField(field.name)!] === true"
                  :indeterminate="item.row.flags[flagKeyForField(field.name)!] === null"
                  @click.stop
                  @change="onFlagChange(item.row, flagKeyForField(field.name)!, $event)"
                />
              </template>
              <template v-else>
                <span
                  v-if="isEditing(item.row, field.name) && field.name === 'Footprint'"
                  class="cell-with-action"
                >
                  <input
                    :ref="setEditInputRef"
                    v-model="editValue"
                    class="table-input cell-input"
                    @keydown.enter.prevent="commitEdit(item.row)"
                    @keydown.esc.stop="cancelEdit"
                    @blur="commitEdit(item.row)"
                    @click.stop
                  />
                  <!-- mousedown.prevent: the input keeps focus, so its blur cannot commit first. -->
                  <button
                    class="btn-outline btn-cell"
                    :title="t('shared.properties.browseFootprint')"
                    :aria-label="t('shared.properties.browseFootprint')"
                    @mousedown.prevent
                    @click.stop="browseFootprint(item.row)"
                  >
                    <Icon name="libraries" />
                  </button>
                </span>
                <input
                  v-else-if="isEditing(item.row, field.name)"
                  :ref="setEditInputRef"
                  v-model="editValue"
                  class="table-input cell-input"
                  @keydown.enter.prevent="commitEdit(item.row)"
                  @keydown.esc.stop="cancelEdit"
                  @blur="commitEdit(item.row)"
                  @click.stop
                />
                <span v-else-if="item.row.values[field.name] === null" class="mixed-value">
                  {{ t('shared.componentsTable.mixedValue') }}
                </span>
                <span v-else class="cell-value">{{ item.row.values[field.name] }}</span>
              </template>
            </td>
          </tr>
          <tr v-if="!displayRows.length">
            <td class="empty-state" :colspan="visibleFields.length">
              {{
                records.length
                  ? t('shared.componentsTable.noComponentsFiltered')
                  : t('shared.componentsTable.noComponentsAtAll')
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.components-table {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background-color: var(--vscode-bg-sidebar, #1a221f);
}

.table-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

.table-input {
  background-color: var(--vscode-input-bg);
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-light, #fff);
  font-size: var(--text-body);
  font-family: var(--font-mono, monospace);
  padding: 2px 6px;
  border-radius: 3px;
  outline: none;
}

.table-input:focus {
  border-color: var(--vscode-accent, #cca250);
}

.filter-input {
  width: 180px;
}

.control-check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.columns-wrap {
  position: relative;
}

.columns-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-muted, #748780);
  padding: 3px 8px;
  font-size: var(--text-body-sm);
  border-radius: 3px;
  cursor: pointer;
}

.columns-btn svg {
  width: 12px;
  height: 12px;
}

.columns-btn:hover,
.columns-btn.active {
  color: var(--vscode-accent, #cca250);
  border-color: var(--vscode-accent, #cca250);
}

.columns-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 220px;
  max-height: 260px;
  overflow-y: auto;
  padding: 6px 8px;
  background: var(--vscode-overlay-strong);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
}

.columns-row {
  display: grid;
  grid-template-columns: 1fr 34px 40px;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  font-size: var(--text-body-sm);
  color: var(--vscode-text, #c5d3cd);
}

.columns-head {
  color: var(--vscode-text-muted, #748780);
  border-bottom: 1px solid var(--vscode-border, #24302b);
  padding-bottom: 4px;
  margin-bottom: 3px;
}

.columns-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.controls-spacer {
  flex: 1;
}

.record-count {
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-caption);
  white-space: nowrap;
}

.table-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.components-grid {
  width: 100%;
  border-collapse: collapse;
  /* The table is the tab: body text at the default size (DESIGN.md §Tables). */
  font-size: var(--text-body);
}

.components-grid th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0 8px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  color: var(--vscode-text-muted, #748780);
  background-color: var(--vscode-bg-sidebar, #1a221f);
}

.components-grid th:hover {
  color: var(--vscode-accent, #cca250);
}

.components-grid td {
  padding: 0 8px;
  vertical-align: middle;
  font-family: var(--font-mono, monospace);
  color: var(--vscode-text, #c5d3cd);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flag-col {
  width: 1%;
  text-align: center;
}

.components-grid td.flag-col {
  text-align: center;
}

.components-grid tbody tr {
  cursor: default;
}

.components-grid tbody tr:hover {
  background-color: var(--vscode-overlay-control);
}

.components-grid tbody tr.row-selected {
  background-color: var(--vscode-accent-subtle-strong);
}

.row-group .reference-label {
  color: var(--vscode-text-light, #ffffff);
}

/* Rows sourced from another sheet: readable but visibly "linked", not local. */
.row-foreign .cell-value,
.row-foreign .reference-label {
  color: var(--vscode-text-muted, #748780);
}

.reference-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.child-indent {
  padding-left: 22px;
}

.expand-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  width: 14px;
  padding: 0;
  cursor: pointer;
}

.expand-caret:hover .disclosure {
  color: var(--vscode-accent, #cca250);
}

.group-count {
  padding: 0 5px;
  border-radius: 7px;
  background-color: var(--vscode-bg-active, #32473f);
  color: var(--vscode-accent, #cca250);
  font-size: var(--text-caption);
}

.mixed-value {
  color: var(--vscode-text-muted, #748780);
  font-style: italic;
}

/* The cell being edited, as a sheet's is: flat, ringed inside its gridline. */
.cell-input {
  width: 100%;
  min-width: 60px;
  height: 26px;
  border: none;
  border-radius: 0;
  outline: 1px solid var(--vscode-accent, #cca250);
  outline-offset: 0;
}

.empty-state {
  padding: 14px 10px;
  text-align: center;
  color: var(--vscode-text-muted, #748780);
}

.cell-with-action {
  display: flex;
  align-items: stretch;
}

.cell-with-action .cell-input {
  flex: 1;
  min-width: 0;
}
</style>
