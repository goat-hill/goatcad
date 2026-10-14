<script setup lang="ts">
/**
 * The standard right-bar detail editor: a schema-driven label + editor table.
 *
 * A host editor builds PropertyGroup[] from its selection (one group per KiCad
 * AST primitive type) and hands it here; this component renders a labelled row
 * per field and emits `edit(groupType, key, value)` back. It knows nothing about
 * the AST, units, or the selection — the host resolves those and maps the edit
 * to its command layer. This is the shared surface every editor's detail panel
 * is meant to adopt (see ARCHITECTURE "Property rows"); labels resolve from the
 * central `shared.properties.*` registry, overridable per field.
 *
 * The value cells themselves are PropertyValueEditor, shared with non-table
 * surfaces (Board Setup). This component owns the table: sections, labels, row
 * navigation, and the cell *skin* that makes an input read as a spreadsheet cell.
 *
 * Keyboard model: clicking a row focuses + selects its value so typing replaces
 * it; Enter commits (text/number) or opens the dropdown (select); ↑/↓ move
 * between property rows (roving tabindex), taking over native number-stepping.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import PropertyRow from './PropertyRow.vue'
import RuleSource from './RuleSource.vue'
import PropertyValueEditor from './PropertyValueEditor.vue'
import {
  nextRowIndex,
  type DistanceUnit,
  type PropertyAction,
  type PropertyEditValue,
  type PropertyField,
  type PropertyGroup
} from '../../lib/propertyTable'

const { t } = useI18n()

const props = defineProps<{
  groups: PropertyGroup[]
  readOnly?: boolean
  /** Unit the host's grid is in; distance cells format/parse against it. */
  distanceUnit?: DistanceUnit
  /** Drop the per-group section header — for a single-group table whose owning
      CollapsiblePanel already titles it (e.g. the Grid panel). */
  hideGroupTitles?: boolean
  /**
   * Only to read (the visual diff): values as plain text, no row or header
   * buttons, and a row the diff marks (`PropertyField.change`) tinted, a changed
   * one shown as its old value over its new.
   */
  review?: boolean
}>()

const unit = computed<DistanceUnit>(() => props.distanceUnit ?? 'mm')

const emit = defineEmits<{
  /**
   * `groupId` is set only for schemas that repeat a group type (alternate pin
   * functions), where the type alone cannot say which entry was edited. Handlers
   * that don't repeat groups can ignore it.
   */
  (e: 'edit', groupType: string, key: string, value: PropertyEditValue, groupId?: string): void
  /**
   * A section-header OR row button was pressed. `groupId` distinguishes repeated
   * groups of one type (which alternate's × was clicked); `fieldKey` is set only
   * for a row action, and says which row — a header action has no row to name.
   */
  (e: 'action', groupType: string, actionId: string, groupId?: string, fieldKey?: string): void
  /** Escape left a field — the host hands the keyboard back to its canvas. */
  (e: 'escape'): void
}>()

/** A row's buttons as this table shows them: a read-only file keeps only those that change nothing. */
const rowActions = (field: PropertyField): PropertyAction[] | undefined => {
  if (props.review) return undefined
  if (!props.readOnly) return field.actions
  const safe = field.actions?.filter((action) => action.readOnlySafe)
  return safe?.length ? safe : undefined
}

// Flatten groups into rows with a global index so ↑/↓ can rove across sections.
const renderGroups = computed(() => {
  let idx = 0
  return props.groups.map((group) => ({
    ...group,
    rows: group.fields.map((field, i) => ({
      field,
      // A subheading opens where a row's section differs from the row above's.
      heading:
        field.section && field.section !== group.fields[i - 1]?.section ? field.section : null,
      actions: rowActions(field),
      groupType: group.type,
      groupId: group.id,
      rowIndex: idx++
    }))
  }))
})
const totalRows = computed(() => renderGroups.value.reduce((n, g) => n + g.rows.length, 0))

const activeRow = ref(0)
// One PropertyValueEditor instance per row; focus/activate are exposed methods.
type EditorInstance = InstanceType<typeof PropertyValueEditor>
const rowEls = ref<(EditorInstance | null)[]>([])
const setRowRef =
  (index: number) =>
  (el: unknown): void => {
    rowEls.value[index] = (el as EditorInstance) ?? null
  }

// Keep the cursor valid when the schema shrinks (selection change).
watch(totalRows, (n) => {
  if (activeRow.value >= n) activeRow.value = Math.max(0, n - 1)
})

const labelFor = (field: PropertyField): string =>
  field.label ?? (field.labelKey ? t(`shared.properties.${field.labelKey}`) : field.key)

const isDisabled = (field: PropertyField): boolean =>
  !!props.review || !!props.readOnly || !!field.readonly

/** The tint of a row the diff marks: what it is now, or what it was. */
const changeClass = (field: PropertyField): string | undefined =>
  field.change === 'removed' ? 'diff-was' : field.change ? 'diff-now' : undefined

const focusRow = (index: number): void => {
  activeRow.value = index
  nextTick(() => rowEls.value[index]?.focus())
}

/**
 * Put the keyboard in one field, by key. For a host that swaps a row's editor in
 * response to its own button — the row is new to the DOM, and nothing the user
 * did focused it.
 */
const focusField = (key: string): void => {
  const rows = renderGroups.value.flatMap((group) => group.rows)
  const index = rows.findIndex((row) => row.field.key === key)
  if (index >= 0) focusRow(index)
}

defineExpose({ focusField })

// Clicking the label cell mirrors clicking the value: focus + select for inputs,
// toggle for checkboxes, so the whole row is one hit target.
const onLabelClick = (field: PropertyField, index: number): void => {
  if (isDisabled(field)) return
  activeRow.value = index
  nextTick(() => rowEls.value[index]?.activate())
}
</script>

<template>
  <div class="property-table">
    <div v-for="group in renderGroups" :key="group.id ?? group.type" class="property-group">
      <div v-if="!hideGroupTitles" class="section-title-bar">
        <span class="section-title">{{ group.title }}</span>
        <span v-if="group.count > 1" class="group-count">{{ group.count }}</span>
        <span v-if="group.change" class="group-change" :class="group.change">
          {{ t(`shared.propertyChanges.${group.change}`) }}
        </span>
        <button
          v-for="action in review ? [] : group.actions"
          :key="action.id"
          type="button"
          class="group-action btn-outline"
          :class="action.text ? 'btn-sm' : 'btn-icon-sm'"
          :title="action.label"
          :aria-label="action.label"
          :disabled="readOnly"
          @click="emit('action', group.type, action.id, group.id)"
        >
          <template v-if="action.text">{{ action.text }}</template>
          <Icon v-else-if="action.icon" :name="action.icon" />
        </button>
      </div>
      <p v-if="group.rows.length === 0" class="group-empty">
        {{ t('shared.properties.noEditable') }}
      </p>
      <table v-else class="kicad-property-table">
        <tbody>
          <template v-for="row in group.rows" :key="row.field.key">
            <tr v-if="row.heading" class="section-row">
              <td colspan="2">{{ t(`shared.propertySections.${row.heading}`) }}</td>
            </tr>
            <PropertyRow
              v-if="row.field.was"
              class="diff-was"
              :label="labelFor(row.field)"
              readonly
            >
              <PropertyValueEditor :field="row.field.was" :distance-unit="unit" plain />
            </PropertyRow>
            <PropertyRow
              :class="[changeClass(row.field), { warned: !!row.field.warning }]"
              :label="labelFor(row.field)"
              :active="row.rowIndex === activeRow"
              :readonly="isDisabled(row.field)"
              :actions="row.actions"
              @label-click="onLabelClick(row.field, row.rowIndex)"
              @action="
                (actionId) => emit('action', row.groupType, actionId, row.groupId, row.field.key)
              "
            >
              <PropertyValueEditor
                :ref="setRowRef(row.rowIndex)"
                :field="row.field"
                :distance-unit="unit"
                :disabled="isDisabled(row.field)"
                :plain="review || !!row.field.readonly"
                :tabindex="row.rowIndex === activeRow ? 0 : -1"
                @commit="(value) => emit('edit', row.groupType, row.field.key, value, row.groupId)"
                @focus="activeRow = row.rowIndex"
                @navigate="(dir) => focusRow(nextRowIndex(row.rowIndex, dir, totalRows))"
                @escape="emit('escape')"
              />
            </PropertyRow>
            <tr v-if="row.field.warning" class="field-warning">
              <td colspan="2">
                <Icon name="status-warning" class="field-warning-icon" />{{ row.field.warning }}
                <RuleSource
                  v-if="row.field.warningSource"
                  :source="row.field.warningSource"
                  class="field-warning-source"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* .kicad-property-table, .dense-input, .dense-select come from propertyPanel.css */

.property-group {
  margin-bottom: 12px;
}

.section-title-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  /* Table runs full-bleed; the title keeps a small inset so it isn't at the edge. */
  padding: 6px 10px 4px;
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* Header buttons sit at the far end so the section reads title-first. The
   overrides undo the eyebrow's uppercase/letter-spacing, which the label would
   otherwise inherit. */
.group-action {
  margin-left: auto;
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.group-action + .group-action {
  margin-left: 0;
}

.group-count {
  padding: 0 5px;
  border-radius: 7px;
  background-color: var(--vscode-bg-active);
  font-size: var(--text-caption);
}

/*
 * Spreadsheet look, full-bleed: no side box — just a rule at the top and under
 * every row (the last row's rule is the table's bottom line). The LEFT (label)
 * column matches the panel background so it reads as a non-editable header; the
 * RIGHT (value) column carries a field background so it clearly reads as
 * editable. A focused cell gets a selected-cell ring; the active row gets a left
 * accent so ↑/↓ row navigation is discoverable. Scoped to PropertyTable (the
 * value inputs are parent-scope slot content; the <tr>/<td> come from the child
 * PropertyRow, so they need :deep) — the bespoke footprint/PCB panels that share
 * PropertyRow keep their own look.
 */
.kicad-property-table {
  border-top: 1px solid var(--vscode-border, #24302b);
}

.kicad-property-table :deep(tr) {
  border-bottom: 1px solid var(--vscode-border, #24302b);
  box-shadow: inset 2px 0 0 transparent;
}

/* Row highlight paints on the <tr>, behind both cells. The value cell's field
   background is TRANSLUCENT (below) so this shows through it — the whole row
   lights as one unit rather than just the label half. */
.kicad-property-table :deep(tr:hover) {
  background-color: var(--vscode-bg-hover, rgba(255, 255, 255, 0.05));
}

/* A color row is clickable across both cells (the label cell mirrors the value,
   `onLabelClick`), so its swatch brightens from anywhere on the row rather than
   only from the 22px it occupies. Its existing border carries the state — a ring
   ADDED on hover reads as a second box rather than a highlight, which is exactly
   why the checkbox gets nothing here: the row's own hover already says the row
   is live, and a native checkbox is too small to take a ring without looking
   boxed in. */
.kicad-property-table :deep(tr:hover .color-swatch:not(:disabled)) {
  border-color: var(--vscode-text-muted, #748780);
}

/* The active row highlights as a unit too — but only while the table actually
   has focus, so the default row (index 0) isn't "selected" when the pane idles. */
.property-table:focus-within .kicad-property-table :deep(tr.active) {
  background-color: var(--vscode-bg-active, rgba(204, 162, 80, 0.1));
  box-shadow: inset 2px 0 0 var(--vscode-accent, #cca250);
}

/* Label cell = non-editable header: blends into the panel background, with the
   column grid line on its right. Clicking it acts on the row's value cell. */
.kicad-property-table :deep(.label-col) {
  padding: 0 10px;
  background: transparent;
  border-right: 1px solid var(--vscode-border, #24302b);
  vertical-align: middle;
  font-size: var(--text-body-sm);
  cursor: pointer;
}

/* Value cell = the editable field. A translucent inset shade reads as a field at
   rest yet lets the row-level hover/active highlight show through it. */
.kicad-property-table :deep(.value-col) {
  padding: 0;
  vertical-align: middle;
  background-color: var(--vscode-property-value-bg);
}

/* Read-only values blend into the panel background (no field shade) so they read
   as non-editable, like the label column. */
.kicad-property-table :deep(.value-col.readonly) {
  background-color: transparent;
}

/* The input IS the cell — strip its box; the cell background shows through.
   :deep because the controls now live inside PropertyValueEditor: this is the
   table's *skin* for a shared editor, not something the editor owns itself. */
.kicad-property-table :deep(.dense-input),
.kicad-property-table :deep(.dense-select) {
  height: 24px;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0 8px;
}

/* Room for the caret, which the cell padding above would otherwise run text under. */
.kicad-property-table :deep(.select-with-caret .dense-select) {
  padding-right: 24px;
}

.kicad-property-table :deep(.dense-input:focus),
.kicad-property-table :deep(.dense-select:focus) {
  /* Selected-cell ring, inset so it hugs the cell rather than floating. */
  box-shadow: inset 0 0 0 1.5px var(--vscode-accent, #cca250);
  background-color: var(--vscode-bg-active, rgba(204, 162, 80, 0.06));
}

/* A cell button (row action, color clear) is a column of the row, not a box in
   it: the row's grid lines are its top and bottom and the panel edge its right,
   so it draws only the line that divides it from what it follows. Its own top
   and bottom would sit against the row's and double them. The hover ring is
   inset for the same reason, like a focused input's. */
.kicad-property-table :deep(.btn-cell) {
  border-width: 0 0 0 1px;
}

.kicad-property-table :deep(.btn-cell:hover:not(:disabled)) {
  box-shadow: inset 0 0 0 1px var(--vscode-accent);
}

/* The visual diff's marks, the text diff's tints: what a row is now, what it was. */
.kicad-property-table tr.diff-now,
.kicad-property-table tr.diff-now:hover {
  background-color: var(--vscode-success-subtle);
}

.kicad-property-table tr.diff-was,
.kicad-property-table tr.diff-was:hover {
  background-color: var(--vscode-error-subtle);
}

.kicad-property-table tr.diff-was :deep(.plain-text) {
  text-decoration: line-through;
  color: var(--vscode-text-muted);
}

.group-change {
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.group-change.added {
  color: var(--vscode-success);
}

.group-change.removed {
  color: var(--vscode-error);
}

/* A subheading inside a group — KiCad's property groups ("Text", "Overrides").
   The section-eyebrow style (DESIGN.md), on the panel ground rather than a
   cell, so it takes no hover or active highlight. */
.kicad-property-table tr.section-row,
.kicad-property-table tr.section-row:hover {
  background-color: transparent;
}

.section-row td {
  padding: 8px 10px 3px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* A group with no rows (nothing editable for what is selected) says so, rather
   than drawing an empty table under its title. */
.group-empty {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
}

/* A note under its row: allowed, but worth a look. The row and its note read as
   one block: one tint, one warning bar down their left edge, no rule between
   them. The note is plain text, not a cell, so it takes no hover or active
   highlight. */
.kicad-property-table :deep(tr.warned),
.kicad-property-table tr.field-warning,
.kicad-property-table tr.field-warning:hover {
  background-color: var(--vscode-warning-subtle);
  box-shadow: inset 2px 0 0 var(--vscode-warning);
}

.kicad-property-table :deep(tr.warned) {
  border-bottom: none;
}

.field-warning td {
  padding: 0 10px 4px;
  color: var(--vscode-warning);
  font-size: var(--text-caption);
}

.field-warning-source {
  margin-left: 4px;
}

.field-warning-icon {
  width: 12px;
  height: 12px;
  margin-right: 4px;
  vertical-align: -2px;
}

/* Block, not the inline default: an inline checkbox sits on the cell's text
   baseline and rides low in a 24px row. */
.kicad-property-table :deep(.cell-checkbox) {
  display: block;
  margin: 0 8px;
  accent-color: var(--vscode-accent);
}

/*
 * The `segmented` editor fills its value cell the way a text input does: no
 * pill border, padding or margin of its own, so the row stays at 24px like
 * every other. The container is the one roving-tabindex focus target; buttons
 * carry tabindex -1 and don't steal focus (mousedown prevented), so ↑/↓ still
 * move rows and Enter/←/→ cycle options. Segments share the cell by their
 * labels' widths and keep to one line — a wrapped label is what grew the row.
 */
.kicad-property-table :deep(.segmented) {
  display: flex;
  width: 100%;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}

/* Selected-cell ring, inset like a focused input's. */
.kicad-property-table :deep(.segmented:focus) {
  box-shadow: inset 0 0 0 1.5px var(--vscode-accent, #cca250);
}

/* Same text size as the other field values; only the chrome around it went. */
.kicad-property-table :deep(.segmented .dense-toggle-btn) {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 6px;
  border-radius: 0;
  font-size: var(--text-body-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kicad-property-table :deep(.segmented .dense-toggle-btn + .dense-toggle-btn) {
  border-left: 1px solid var(--vscode-border, #24302b);
}

/* The row's own hover says the row is live; this says which segment a click
   picks. Text only — a tint would stack on the row's, and a ring reads as a
   second box (see the color swatch above). The selected one is already chosen. */
.kicad-property-table :deep(.segmented .dense-toggle-btn:hover:not(.active, :disabled)) {
  color: var(--vscode-text);
}

/* The table's selected look (the active layer row's), not a solid copper
   block: a whole 24px segment filled solid outweighs everything around it. */
.kicad-property-table :deep(.segmented .dense-toggle-btn.active) {
  background-color: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent, #cca250);
}
</style>
