<script setup lang="ts">
import Modal from '../shared/Modal.vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalKeys } from '../../lib/modalKeys'
import Icon from '../shared/Icon.vue'
import type { TeardropAction, TeardropDialogRequest } from '../../lib/board/teardrop/edit'

/**
 * Edit teardrops — KiCad's Edit ▸ Edit Teardrops: which pads and vias, how
 * narrowed, and what to do to them, with the count it reaches before anything
 * is written. One apply, one undo step, every teardrop rebuilt. The shapes'
 * defaults are Board Setup's (Teardrops); this dialog does not open it.
 */

const props = defineProps<{
  nets: ReadonlyArray<{ number: number; name: string }>
  classes: readonly string[]
  /** The board's copper layers, front to back. */
  layers: readonly string[]
  /** Pads and vias selected: what "Selected items only" reaches; none disables it. */
  selected: number
  selectionOnly?: boolean
  /** The targets the project saved last. */
  targets: TeardropDialogRequest['targets']
  roundOnly: boolean
  /** How many pads and vias a request reaches. */
  count: (request: TeardropDialogRequest) => number
  apply: (request: TeardropDialogRequest) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'close'): void }>()
const { t } = useI18n()

const action = ref<TeardropAction>('add')
const targets = ref({ ...props.targets })
const selectionOnly = ref(!!props.selectionOnly && props.selected > 0)
const net = ref<number | null>(null)
const netClass = ref<string | null>(null)
const layer = ref<string | null>(null)
const roundOnly = ref(props.roundOnly)
const existingOnly = ref(false)

// Set's values, blank to keep each item's own; percents and millimeters as typed.
const bestLength = ref('')
const maxLength = ref('')
const bestWidth = ref('')
const maxWidth = ref('')
const trackLimit = ref('')
type Keep = 'keep' | 'yes' | 'no'
const curved = ref<Keep>('keep')
const twoSegments = ref<Keep>('keep')
const preferZone = ref<Keep>('keep')

const number = (text: string): number | undefined => {
  const v = Number(text.trim())
  return text.trim() === '' || !Number.isFinite(v) || v < 0 ? undefined : v
}
const flag = (k: Keep): boolean | undefined => (k === 'keep' ? undefined : k === 'yes')

const request = computed((): TeardropDialogRequest => {
  const pct = (text: string): number | undefined => {
    const v = number(text)
    return v === undefined ? undefined : v / 100
  }
  const len = (text: string): number | undefined => {
    const v = number(text)
    return v === undefined ? undefined : Math.round(v * 1e6)
  }
  const values: TeardropDialogRequest['values'] = {}
  const set = <K extends keyof TeardropDialogRequest['values']>(
    key: K,
    value: TeardropDialogRequest['values'][K] | undefined
  ): void => {
    if (value !== undefined) values[key] = value
  }
  set('bestLengthRatio', pct(bestLength.value))
  set('maxLength', len(maxLength.value))
  set('bestWidthRatio', pct(bestWidth.value))
  set('maxWidth', len(maxWidth.value))
  set('filterRatio', pct(trackLimit.value))
  set('curvedEdges', flag(curved.value))
  set('allowTwoSegments', flag(twoSegments.value))
  set('preferZoneConnections', flag(preferZone.value))
  return {
    action: action.value,
    targets: { ...targets.value },
    selectionOnly: selectionOnly.value,
    net: net.value,
    netClass: netClass.value,
    layer: layer.value,
    roundOnly: roundOnly.value,
    existingOnly: existingOnly.value,
    values
  }
})

// Track to track has no values of its own here, as in KiCad: set takes the pads and vias.
watch(
  () => targets.value.trackToTrack,
  (on) => {
    if (on && action.value === 'set') action.value = 'add'
  }
)

const count = computed(() => props.count(request.value))
const filtered = computed(() => action.value !== 'removeAll')
const ready = computed(
  () => count.value > 0 || targets.value.trackToTrack || action.value === 'removeAll'
)

const applying = ref(false)
const failure = ref<string | null>(null)
const confirm = async (): Promise<void> => {
  if (!ready.value || applying.value) return
  applying.value = true
  try {
    await props.apply(request.value)
    emit('close')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    applying.value = false
  }
}

const confirmLabel = computed((): string => {
  const n = count.value
  if (action.value === 'removeAll') return t('pcbEditor.teardrops.confirm.removeAll')
  if (action.value === 'set') return t('pcbEditor.teardrops.confirm.set', { count: n }, n)
  if (action.value === 'remove') return t('pcbEditor.teardrops.confirm.remove', { count: n }, n)
  return t('pcbEditor.teardrops.confirm.add', { count: n }, n)
})

const ACTIONS: TeardropAction[] = ['add', 'set', 'remove', 'removeAll']
const actionLabel = (a: TeardropAction): string => {
  switch (a) {
    case 'add':
      return t('pcbEditor.teardrops.actions.add')
    case 'set':
      return t('pcbEditor.teardrops.actions.set')
    case 'remove':
      return t('pcbEditor.teardrops.actions.remove')
    case 'removeAll':
      return t('pcbEditor.teardrops.actions.removeAll')
  }
}

// Enter applies (DESIGN.md §Modals); Escape is the dialog's own (shared/Modal.vue).
useModalKeys({ confirm: () => void confirm() })
</script>

<template>
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">
        <Icon name="tool-teardrop" class="title-icon" />
        {{ t('pcbEditor.teardrops.title') }}
      </h2>

      <div class="segmented" role="radiogroup" :aria-label="t('pcbEditor.teardrops.actionGroup')">
        <button
          v-for="a in ACTIONS"
          :key="a"
          type="button"
          class="segmented-btn"
          :class="{ active: action === a }"
          :disabled="a === 'set' && targets.trackToTrack"
          role="radio"
          :aria-checked="action === a"
          @click="action = a"
        >
          {{ actionLabel(a) }}
        </button>
      </div>

      <div class="columns">
        <fieldset class="group" :disabled="!filtered">
          <legend class="eyebrow">{{ t('pcbEditor.teardrops.targets') }}</legend>
          <label class="choice">
            <input v-model="targets.vias" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.target.vias') }}</span>
          </label>
          <label class="choice">
            <input v-model="targets.pthPads" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.target.pthPads') }}</span>
          </label>
          <label class="choice">
            <input v-model="targets.smdPads" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.target.smdPads') }}</span>
          </label>
          <label class="choice">
            <input v-model="targets.trackToTrack" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.target.trackToTrack') }}</span>
          </label>
        </fieldset>

        <fieldset class="group" :disabled="!filtered">
          <legend class="eyebrow">{{ t('pcbEditor.teardrops.filter') }}</legend>
          <label class="choice" :class="{ disabled: selected === 0 }">
            <input v-model="selectionOnly" type="checkbox" :disabled="selected === 0" />
            <span>{{ t('pcbEditor.teardrops.selectionOnly', { count: selected }, selected) }}</span>
          </label>
          <label class="choice">
            <input v-model="roundOnly" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.roundOnly') }}</span>
          </label>
          <label class="choice">
            <input v-model="existingOnly" type="checkbox" />
            <span>{{ t('pcbEditor.teardrops.existingOnly') }}</span>
          </label>
          <label class="field">
            <span>{{ t('pcbEditor.teardrops.net') }}</span>
            <select v-model="net" class="field-sm mono">
              <option :value="null">{{ t('pcbEditor.teardrops.allNets') }}</option>
              <option v-for="option in nets" :key="option.number" :value="option.number">
                {{ option.name }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('pcbEditor.teardrops.netClass') }}</span>
            <select v-model="netClass" class="field-sm mono">
              <option :value="null">{{ t('pcbEditor.teardrops.allClasses') }}</option>
              <option v-for="name in classes" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('pcbEditor.teardrops.layer') }}</span>
            <select v-model="layer" class="field-sm mono">
              <option :value="null">{{ t('pcbEditor.teardrops.allLayers') }}</option>
              <option v-for="name in layers" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </fieldset>

        <fieldset v-if="action === 'set'" class="group">
          <legend class="eyebrow">{{ t('pcbEditor.teardrops.values') }}</legend>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropBestLength') }}</span>
            <input
              v-model="bestLength"
              class="field-sm mono"
              inputmode="decimal"
              :placeholder="t('pcbEditor.teardrops.keep')"
            />
            <span class="unit">%</span>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropMaxLength') }}</span>
            <input
              v-model="maxLength"
              class="field-sm mono"
              inputmode="decimal"
              :placeholder="t('pcbEditor.teardrops.keep')"
            />
            <span class="unit">mm</span>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropBestWidth') }}</span>
            <input
              v-model="bestWidth"
              class="field-sm mono"
              inputmode="decimal"
              :placeholder="t('pcbEditor.teardrops.keep')"
            />
            <span class="unit">%</span>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropMaxWidth') }}</span>
            <input
              v-model="maxWidth"
              class="field-sm mono"
              inputmode="decimal"
              :placeholder="t('pcbEditor.teardrops.keep')"
            />
            <span class="unit">mm</span>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropMaxTrackWidth') }}</span>
            <input
              v-model="trackLimit"
              class="field-sm mono"
              inputmode="decimal"
              :placeholder="t('pcbEditor.teardrops.keep')"
            />
            <span class="unit">%</span>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropCurved') }}</span>
            <select v-model="curved" class="field-sm">
              <option value="keep">{{ t('pcbEditor.teardrops.keep') }}</option>
              <option value="yes">{{ t('pcbEditor.teardrops.yes') }}</option>
              <option value="no">{{ t('pcbEditor.teardrops.no') }}</option>
            </select>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropTwoSegments') }}</span>
            <select v-model="twoSegments" class="field-sm">
              <option value="keep">{{ t('pcbEditor.teardrops.keep') }}</option>
              <option value="yes">{{ t('pcbEditor.teardrops.yes') }}</option>
              <option value="no">{{ t('pcbEditor.teardrops.no') }}</option>
            </select>
          </label>
          <label class="field wide">
            <span>{{ t('shared.properties.teardropPreferZone') }}</span>
            <select v-model="preferZone" class="field-sm">
              <option value="keep">{{ t('pcbEditor.teardrops.keep') }}</option>
              <option value="yes">{{ t('pcbEditor.teardrops.yes') }}</option>
              <option value="no">{{ t('pcbEditor.teardrops.no') }}</option>
            </select>
          </label>
        </fieldset>
      </div>

      <p class="hint">{{ t('pcbEditor.teardrops.defaultsHint') }}</p>
      <p v-if="failure" class="error">{{ failure }}</p>

      <div class="actions">
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          class="btn-cta btn-md"
          type="button"
          :disabled="!ready || applying"
          @click="confirm"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: max-content;
  min-width: min(560px, 90vw);
  max-width: min(1000px, 92vw);
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

/* The command's glyph before its name (DESIGN.md §Modals). */
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

.segmented {
  align-self: flex-start;
}

/* Who it reaches beside what it writes, as KiCad's dialog sets them. */
.columns {
  display: flex;
  gap: 24px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.group:disabled {
  opacity: 0.5;
}

.group > legend {
  margin-bottom: 8px;
  padding: 0;
}

/* Section eyebrow per DESIGN.md §Section eyebrows. */
.eyebrow {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.choice.disabled {
  opacity: 0.5;
  cursor: default;
}

.choice input[type='checkbox'] {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.field {
  display: grid;
  grid-template-columns: 64px minmax(160px, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
}

.field.wide {
  grid-template-columns: 160px 96px 24px;
}

.unit {
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.mono {
  font-family: var(--font-mono);
}

.hint {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.error {
  margin: 0;
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
