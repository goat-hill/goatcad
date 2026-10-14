<script setup lang="ts">
import Modal from '../shared/Modal.vue'
import { computed, ref } from 'vue'
import { useModalKeys } from '../../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import { useFocusAddedRow } from '../../lib/useFocusAddedRow'
import { isMandatoryField, isPanelField } from '../../lib/symbol/symbolEdit'
import type { SchematicProperty } from '../../lib/kicad/schematic'

/**
 * The symbol's fields as a LIST — which ones exist, what they are called, in
 * what order, and whether they are drawn.
 *
 * This is the structural half of field editing, deliberately split from the
 * styling half (alignment, weight, color, position), which lives on a canvas
 * selection like every other item's styling in this editor. The split is what
 * keeps the right bar at one row per field instead of thirteen, and it is why
 * this dialog holds Name / Value / Show and nothing else: the moment a size or
 * an alignment column appears here, the split has collapsed and this has become
 * the full grid it exists to avoid.
 *
 * KiCad's own Symbol Properties gives the same list the same four operations
 * (`m_bpAdd` / `m_bpMoveUp` / `m_bpMoveDown` / `m_bpDelete`) and pins the five
 * mandatory fields to the head — `isMandatoryField` is that rule.
 *
 * Edits apply immediately rather than on a confirm, because each one is already
 * an undoable command in the editor's history; a second layer of OK/Cancel
 * would mean a change could be undone two different ways.
 */
const props = defineProps<{
  properties: SchematicProperty[]
  readOnly?: boolean
}>()

const emit = defineEmits<{
  (e: 'add'): void
  (e: 'remove', key: string): void
  (e: 'rename', key: string, newKey: string): void
  (e: 'set-value', key: string, value: string): void
  (e: 'set-visible', key: string, visible: boolean): void
  (e: 'move', key: string, delta: 1 | -1): void
  (e: 'close'): void
}>()

const { t } = useI18n()

/** Only what the panel lists: `ki_*` machinery keys have their own homes. */
const rows = computed(() => props.properties.filter((p) => isPanelField(p.key)))

const table = ref<HTMLElement | null>(null)
const addedRow = useFocusAddedRow(table, () => rows.value.map((p) => p.key))

/**
 * Rename on `change` — blur or Enter, never per keystroke, which would rename
 * to every prefix as it is typed. `renameSymbolProperty` refuses an empty or
 * duplicate key by writing nothing, so the input simply snaps back to the key
 * it still has.
 */
const onRename = (key: string, event: Event): void => {
  const next = (event.target as HTMLInputElement).value.trim()
  if (next && next !== key) emit('rename', key, next)
}

/**
 * Trimmed for the same reason the panel's field rows are (`EditorDescriptor.trim`):
 * a field value is an identifier a BOM or a library lookup matches, so a stray
 * space is a typo. Applied here too because this dialog writes the value
 * through a plain input rather than through `PropertyValueEditor`.
 */
const onValue = (key: string, event: Event): void => {
  emit('set-value', key, (event.target as HTMLInputElement).value.trim())
}

/**
 * Escape and Enter both close it (DESIGN.md §Modals): its edits land as they
 * are made, so Done is its call to action. On `window`, because it opens with
 * focus still on the button that opened it; a cell being edited keeps Enter.
 */
useModalKeys({ confirm: () => emit('close') })

const canMove = (key: string, delta: 1 | -1): boolean => {
  if (props.readOnly || isMandatoryField(key)) return false
  const list = rows.value
  const index = list.findIndex((p) => p.key === key)
  const neighbour = list[index + delta]
  return index >= 0 && !!neighbour && !isMandatoryField(neighbour.key)
}
</script>

<template>
  <!-- Escape is handled on `window` above; the overlay only needs the click. -->
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">{{ t('symbolEditor.fieldsDialog.title') }}</h2>

      <!--
        The shared sheet (`sheet` + `dense-input` + `btn-cell`, DESIGN.md
        §Sheets), not `PropertyTable`: that renders a static label, one editor
        and one action per row, and a field row needs an editable name, a
        value, a checkbox and three ops.
      -->
      <table ref="table" class="sheet fields-table">
        <thead>
          <tr>
            <th class="name-col">{{ t('symbolEditor.fieldsDialog.name') }}</th>
            <th class="value-col">{{ t('symbolEditor.fieldsDialog.value') }}</th>
            <th class="show-col sheet-check">{{ t('symbolEditor.fieldsDialog.show') }}</th>
            <th class="ops-col sheet-actions">
              <button
                type="button"
                class="btn-outline btn-icon-sm"
                :disabled="readOnly"
                :title="t('symbolEditor.fieldsDialog.add')"
                :aria-label="t('symbolEditor.fieldsDialog.add')"
                @click="(addedRow.expect(), emit('add'))"
              >
                <Icon name="plus" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="property in rows" :key="property.key" :data-row="property.key">
            <td class="name-col">
              <!-- Mandatory names are not editable, so they are a label rather
                   than a disabled input: a greyed box invites a click that will
                   never work. -->
              <span v-if="isMandatoryField(property.key)" class="name-fixed sheet-text">
                {{ property.key }}
              </span>
              <input
                v-else
                class="dense-input"
                type="text"
                :value="property.key"
                :disabled="readOnly"
                :aria-label="t('symbolEditor.fieldsDialog.rename')"
                @change="onRename(property.key, $event)"
              />
            </td>
            <td class="value-col">
              <input
                class="dense-input"
                type="text"
                :value="property.value"
                :disabled="readOnly"
                :aria-label="t('symbolEditor.fieldsDialog.value')"
                @change="onValue(property.key, $event)"
              />
            </td>
            <td class="show-col sheet-check">
              <input
                class="cell-checkbox"
                type="checkbox"
                :checked="!property.hidden"
                :disabled="readOnly"
                :aria-label="t('symbolEditor.fieldsDialog.show')"
                @change="
                  emit('set-visible', property.key, ($event.target as HTMLInputElement).checked)
                "
              />
            </td>
            <td class="ops-col sheet-actions">
              <button
                type="button"
                class="btn-outline btn-cell"
                :disabled="!canMove(property.key, -1)"
                :title="t('symbolEditor.fieldsDialog.moveUp')"
                :aria-label="t('symbolEditor.fieldsDialog.moveUp')"
                @click="emit('move', property.key, -1)"
              >
                <Icon name="arrow-up" />
              </button>
              <button
                type="button"
                class="btn-outline btn-cell"
                :disabled="!canMove(property.key, 1)"
                :title="t('symbolEditor.fieldsDialog.moveDown')"
                :aria-label="t('symbolEditor.fieldsDialog.moveDown')"
                @click="emit('move', property.key, 1)"
              >
                <Icon name="arrow-down" />
              </button>
              <button
                type="button"
                class="btn-outline btn-cell"
                :disabled="readOnly || isMandatoryField(property.key)"
                :title="
                  isMandatoryField(property.key)
                    ? t('symbolEditor.fieldsDialog.mandatory')
                    : t('symbolEditor.fieldsDialog.remove')
                "
                :aria-label="t('symbolEditor.fieldsDialog.remove')"
                @click="emit('remove', property.key)"
              >
                <Icon name="close-sm" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="dialog-actions">
        <span class="spacer"></span>
        <button class="btn-cta btn-md" @click="emit('close')">
          {{ t('symbolEditor.fieldsDialog.done') }}
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
  max-width: 560px;
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

.fields-table {
  margin-top: 16px;
}

/* The grid and its cells are the shared sheet (main.css, DESIGN.md §Sheets). */
.fields-table {
  width: 100%;
}

.name-col {
  width: 30%;
}

.value-col {
  width: 46%;
}

.show-col {
  width: 48px;
}

/* Butted together, so three cells read as one strip. */
.ops-col {
  width: 72px;
  line-height: 0;
  white-space: nowrap;
}

.ops-col .btn-cell + .btn-cell {
  margin-left: -1px;
}

.ops-col .btn-cell:hover:not(:disabled) {
  position: relative;
  z-index: 1;
}

.name-fixed {
  display: block;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

/* `cell-checkbox` is styled by PropertyTable's scoped rules, so restate it. */
.show-col .cell-checkbox {
  display: block;
  margin: 0 auto;
  accent-color: var(--vscode-accent);
}

.dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
}

.spacer {
  flex: 1;
}
</style>
