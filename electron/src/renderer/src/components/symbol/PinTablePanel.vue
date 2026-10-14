<script setup lang="ts">
/**
 * The symbol's pins as a grid — the surface for *entering and verifying* a
 * 48-pin part, which is the expensive half of authoring one.
 *
 * **It lives in the right bar, not in a modal**, which is the reverse of what
 * KiCad does. The modal was assumed because a
 * grid was assumed to need width; holding the table to the three columns that
 * are a pin's IDENTITY (number, name, electrical type — see `pinTable.ts` for
 * the split) makes it fit the bar, and the bar keeps the canvas visible, which
 * a modal over it cannot.
 *
 * **A row IS the selection**, and it is the panel being permanent that makes
 * that safe. An earlier pass kept a table-local pick list and a per-row "select
 * on canvas" button, because the table appeared only when nothing was selected
 * — so a row click that selected would have swapped the table away mid-typing.
 * A permanent, collapsible panel has no such state to lose: clicking a row
 * selects the pin, the canvas highlights it, and the properties panel ABOVE
 * switches to describing it. One selection, three surfaces agreeing, and no
 * button needed to bridge them.
 *
 * The `+`/trash pair sits in the footer rather than per row: three typing
 * columns is what the bar holds, and a per-row button would cost the Name
 * column its width. KiCad puts them in the same place.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import { useFocusAddedRow } from '../../lib/useFocusAddedRow'
import {
  addressCsvKey,
  DEFAULT_PIN_SORT,
  duplicateAddresses,
  sortPinTableRows,
  type PinTableRow,
  type PinTableSort,
  type PinTableSortKey
} from '../../lib/schematic/pinTable'
import { ELECTRICAL_TYPES } from '../../lib/symbol/symbolPropertySchema'

const props = defineProps<{
  rows: PinTableRow[]
  /** `addressCsvKey`s of the pins the EDITOR has selected — the table renders
      this rather than holding a second idea of what is selected. */
  selectedKeys: string[]
  /** Gate the writes exactly where the canvas tools are gated (derived symbols,
      an alternate body style) — one predicate, not a second opinion. */
  readOnly?: boolean
  /** Show the Unit column: only a symbol with gates has an answer worth space. */
  multiUnit?: boolean
}>()

const emit = defineEmits<{
  (e: 'edit', key: 'number' | 'name' | 'electricalType', row: PinTableRow, value: string): void
  (e: 'add'): void
  (e: 'remove', rows: PinTableRow[]): void
  /** The whole new selection, already resolved against the click's modifiers.
      `anchor` is the row actually clicked — the host needs it to decide which
      unit to switch to. */
  (e: 'select', rows: PinTableRow[], anchor: PinTableRow): void
  (e: 'import'): void
  (e: 'export'): void
}>()

const { t } = useI18n()

const typeLabel = (value: string): string => t(`symbolEditor.pinTypes.${value}`)
const typeOptions = computed(() =>
  ELECTRICAL_TYPES.map((value) => ({ value, label: typeLabel(value) }))
)

/**
 * Width of the Type column, from the longest label there actually is.
 *
 * `table-layout: fixed` is what stops a long pin name from stealing the type
 * column's width — but it also means no column sizes itself, so a hardcoded
 * width clips the moment a label is longer than whoever picked the number
 * assumed ("Open collector" did exactly that at 100px, while Name sat on spare
 * room). Measuring in `ch` is exact here rather than approximate, because
 * `.dense-select` renders in the monospace stack, and it follows the LOCALE:
 * German's longer type names widen the column instead of being cut off.
 * The added pixels are the cell padding plus the dropdown arrow.
 */
const typeColumnWidth = computed(() => {
  const longest = Math.max(...ELECTRICAL_TYPES.map((value) => typeLabel(value).length))
  return `calc(${longest}ch + 28px)`
})

const duplicates = computed(() => duplicateAddresses(props.rows))
const isDuplicate = (row: PinTableRow): boolean => duplicates.value.has(addressCsvKey(row.address))

/**
 * Sort state is the TABLE's, not the document's: it changes what you are
 * looking at and never what is stored, so it is not an undoable edit and has no
 * business in the symbol.
 */
const sort = ref<PinTableSort>({ ...DEFAULT_PIN_SORT })
const sorted = computed(() => sortPinTableRows(props.rows, sort.value, typeLabel))

const pinTable = ref<HTMLElement | null>(null)
const addedRow = useFocusAddedRow(pinTable, () => props.rows.map((r) => addressCsvKey(r.address)))

/**
 * A new column starts ascending; the same column again flips it. There is no
 * third "back to document order" state — the file's order is not something a
 * reader of this grid is looking for, and a three-state header is a control
 * people click twice to find out what it does.
 */
const sortBy = (key: PinTableSortKey): void => {
  sort.value =
    sort.value.key === key
      ? { key, direction: sort.value.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' }
}

const selected = computed(() => new Set(props.selectedKeys))
const isSelected = (row: PinTableRow): boolean => selected.value.has(addressCsvKey(row.address))
const selectedRows = computed(() => props.rows.filter(isSelected))

/** Shift-click anchor, as an index into the SORTED list — a range is what you
 *  can see, so it follows the visual order rather than the document's. */
const anchor = ref<number | null>(null)

// The anchor indexes a list that re-sorts and re-lengths underneath it.
watch(sorted, () => {
  if (anchor.value !== null && anchor.value >= sorted.value.length) anchor.value = null
})

const onRowClick = (index: number, event: MouseEvent): void => {
  const list = sorted.value
  const row = list[index]
  if (event.shiftKey && anchor.value !== null) {
    const [from, to] = [anchor.value, index].sort((a, b) => a - b)
    const range = list.slice(from, to + 1)
    // Ctrl+Shift extends the existing selection; plain Shift replaces it.
    emit(
      'select',
      event.ctrlKey || event.metaKey ? [...new Set([...selectedRows.value, ...range])] : range,
      row
    )
    return
  }
  if (event.ctrlKey || event.metaKey) {
    const next = isSelected(row)
      ? selectedRows.value.filter((r) => r !== row)
      : [...selectedRows.value, row]
    emit('select', next, row)
    anchor.value = index
    return
  }
  emit('select', [row], row)
  anchor.value = index
}

const onRemove = (): void => {
  if (selectedRows.value.length) emit('remove', selectedRows.value)
}

/**
 * Commit on `change` — blur or Enter — never per keystroke. A per-keystroke
 * write would push one undo entry per character, and on the number column would
 * flag every prefix as a duplicate and re-sort the grid as it was typed.
 */
const onInput = (key: 'number' | 'name', row: PinTableRow, event: Event): void => {
  const value = (event.target as HTMLInputElement).value.trim()
  if (value !== row[key]) emit('edit', key, row, value)
}

const onType = (row: PinTableRow, event: Event): void => {
  const value = (event.target as HTMLSelectElement).value
  if (value !== row.electricalType) emit('edit', 'electricalType', row, value)
}

/**
 * Keep the selected row on screen — whether the selection came from the canvas
 * (click a pin on the drawing and its row must be visible, or on a 48-row list
 * the two surfaces visibly disagree) or from the `+` button, whose new pin
 * lands wherever the current sort puts it, off screen more often than not.
 *
 * `flush: 'post'` because the add case changes the ROWS as well as the
 * selection: the default `pre` flush would query a `<tbody>` that has not
 * re-rendered yet and index into the previous list. `block: 'nearest'` so a row
 * already in view is left alone and this never fights a hand scroll.
 */
const scroller = ref<HTMLElement | null>(null)
watch(
  () => props.selectedKeys,
  (keys) => {
    if (!keys.length || !scroller.value) return
    const index = sorted.value.findIndex((row) => addressCsvKey(row.address) === keys[0])
    if (index < 0) return
    scroller.value.querySelectorAll('tbody tr')[index]?.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' }
)
</script>

<template>
  <div class="pin-table">
    <div ref="scroller" class="pin-scroll">
      <table ref="pinTable" class="sheet pin-grid">
        <thead>
          <tr>
            <!-- The header IS the sort control: no separate widget for an
                 ordering the column already names. -->
            <th class="num-col">
              <button type="button" class="sort-btn" @click="sortBy('number')">
                {{ t('symbolEditor.pinTable.number') }}
                <Icon
                  v-if="sort.key === 'number'"
                  :name="sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'"
                  class="sort-indicator"
                />
              </button>
            </th>
            <th class="name-col">
              <button type="button" class="sort-btn" @click="sortBy('name')">
                {{ t('symbolEditor.pinTable.name') }}
                <Icon
                  v-if="sort.key === 'name'"
                  :name="sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'"
                  class="sort-indicator"
                />
              </button>
            </th>
            <th class="type-col" :style="{ width: typeColumnWidth }">
              <button type="button" class="sort-btn" @click="sortBy('electricalType')">
                {{ t('symbolEditor.pinTable.type') }}
                <Icon
                  v-if="sort.key === 'electricalType'"
                  :name="sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'"
                  class="sort-indicator"
                />
              </button>
            </th>
            <th v-if="multiUnit" class="unit-col unit-head">
              {{ t('symbolEditor.pinTable.unit') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in sorted"
            :key="addressCsvKey(row.address)"
            :data-row="addressCsvKey(row.address)"
            :class="{ selected: isSelected(row) }"
            @click="onRowClick(index, $event)"
          >
            <td class="num-col">
              <input
                class="dense-input"
                :class="{ bad: isDuplicate(row) }"
                type="text"
                :value="row.number"
                :disabled="readOnly"
                :title="isDuplicate(row) ? t('symbolEditor.pinTable.duplicateHint') : undefined"
                :aria-label="t('symbolEditor.pinTable.number')"
                @change="onInput('number', row, $event)"
              />
            </td>
            <td class="name-col">
              <input
                class="dense-input"
                type="text"
                :value="row.name"
                :disabled="readOnly"
                :aria-label="t('symbolEditor.pinTable.name')"
                @change="onInput('name', row, $event)"
              />
            </td>
            <td class="type-col">
              <select
                class="dense-select"
                :value="row.electricalType"
                :disabled="readOnly"
                :aria-label="t('symbolEditor.pinTable.type')"
                @change="onType(row, $event)"
              >
                <option v-for="option in typeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </td>
            <!-- Read-only: which gate holds a pin is a question of WHICH
                 sub-symbol node owns it (`movePartToUnit`), and the selected
                 pin's "common to all units" row is where that already lives. -->
            <td v-if="multiUnit" class="unit-col">
              <span class="unit-value">{{ row.unit === 0 ? '—' : row.unit }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="!rows.length" class="pin-empty">{{ t('symbolEditor.pinTable.empty') }}</p>
    </div>

    <div class="pin-actions">
      <button
        type="button"
        class="btn-outline btn-cell"
        :disabled="readOnly"
        :title="t('symbolEditor.pinTable.add')"
        :aria-label="t('symbolEditor.pinTable.add')"
        @click="(addedRow.expect(), emit('add'))"
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        class="btn-outline btn-cell"
        :disabled="readOnly || !selectedRows.length"
        :title="
          selectedRows.length
            ? t('symbolEditor.pinTable.removeN', selectedRows.length)
            : t('symbolEditor.pinTable.removeHint')
        "
        :aria-label="t('symbolEditor.pinTable.remove')"
        @click="onRemove"
      >
        <Icon name="trash" />
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn-outline btn-sm" :disabled="readOnly" @click="emit('import')">
        {{ t('symbolEditor.pinTable.import') }}
      </button>
      <button
        type="button"
        class="btn-outline btn-sm"
        :disabled="!rows.length"
        @click="emit('export')"
      >
        {{ t('symbolEditor.pinTable.export') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* `height` rather than `flex`, because the host is CollapsiblePanel's
   `.panel-body` (a plain overflow:auto block, not a flex container): the grid
   scrolls inside `.pin-scroll` so the action row stays put. */
.pin-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pin-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* The grid and its cells are the shared sheet (main.css, DESIGN.md §Sheets). */
.pin-grid {
  width: 100%;
  /* Fixed, so a long pin name cannot steal the type column's width — the
     columns are sized by what they hold, not by the widest cell. */
  table-layout: fixed;
}

/* The header sticks while the pins scroll; its button is the whole cell. */
.pin-grid thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0;
}

/* Header cells per DESIGN.md §Tables: caption-size, uppercase, muted — carried
   by the button here, since the whole header is the click target. */
.sort-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--vscode-text-muted);
  font-family: inherit;
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
  cursor: pointer;
}

.sort-btn:hover {
  color: var(--vscode-text-light);
}

/* The one header that is not a sort button, so it restates the type. */
.pin-grid thead th.unit-head {
  padding: 0 4px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* The theme's inactive-list selection: the row agrees with the canvas about
   what is selected, and the canvas is where that is being shown. */
.pin-grid tbody tr.selected {
  background: var(--vscode-bg-selection-inactive);
}

.num-col {
  width: 46px;
}

/* The Name column takes whatever the sized columns leave, so it is the one
   that absorbs a resize of the bar. */
.name-col {
  width: auto;
}

.unit-col {
  width: 26px;
  text-align: center;
}

.unit-value {
  color: var(--vscode-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
}

/* A duplicated number is marked on the CELL (the sheet's `.bad`), which is
   the only place that can say WHICH row is wrong. */

.pin-empty {
  margin: 12px 8px;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  text-align: center;
}

.pin-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--vscode-border);
}

/* Butted together, so the pair reads as one strip (the fields dialog's ops). */
.pin-actions .btn-cell + .btn-cell {
  margin-left: -7px;
}

.spacer {
  flex: 1;
}
</style>
