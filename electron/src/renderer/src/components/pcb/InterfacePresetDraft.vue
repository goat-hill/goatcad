<script setup lang="ts">
/**
 * Set up a net class for an interface (lib/board/interfacePresets.ts), as a
 * draft on Board Setup's Net classes. Its plan is laid over the page's tables
 * (lib/board/presetDraft.ts): the class row, its tuning profile and its
 * custom rules show as added or edited rows where they will live, and this
 * panel holds only the choices that make them. The class is one of the
 * project's and its nets are the ones Assignments gives it: nothing is looked
 * for. Apply writes; Discard drops it.
 */
import { computed } from 'vue'
import { Translation, useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import NetClassTag from '../shared/NetClassTag.vue'
import DiffPairGroup from '../shared/DiffPairGroup.vue'
import PropertyValueEditor from '../shared/PropertyValueEditor.vue'
import { INTERFACE_PRESETS } from '../../lib/board/interfacePresetData'
import type { PresetFailure, PresetPlan, PresetRequest } from '../../lib/board/interfacePresets'
import type { PendingState, PresetInputs } from '../../lib/board/presetDraft'
import type { CustomRuleRow } from '../../lib/board/customRuleRows'
import type { NetClass } from '../../lib/kicad/project'
import type { PropertyEditValue, PropertyField, SelectOption } from '../../lib/propertyTable'

const props = defineProps<{
  request: PresetRequest
  result: { ok: true; plan: PresetPlan } | PresetFailure
  /** The project's classes as the class picker offers them (tags), Default aside. */
  classOptions: readonly SelectOption[]
  /** The board's copper top to bottom, each with its color. */
  copperLayers: ReadonlyArray<{ name: string; color: string }>
  applying?: boolean
  /** What the solve reads beyond the choices here, shown read only with where each comes from. */
  inputs: PresetInputs
  /** Whether Apply adds the class's tuning profile or changes it; none where it stays as it is. */
  profilePending?: PendingState
  /** The class as the project has it; absent when the draft adds it. */
  classBefore?: NetClass
  /** The custom rules Apply writes, each marked added or changed (none: as the file has it). */
  rules: ReadonlyArray<CustomRuleRow & { pending?: PendingState }>
}>()

const emit = defineEmits<{
  (e: 'update', request: PresetRequest): void
  (e: 'apply'): void
  (e: 'discard'): void
  (e: 'open-source', url: string): void
}>()

const { t } = useI18n()
const tr = (key: string, values?: Record<string, unknown>): string =>
  values ? t(`boardSetup.interfacePreset.${key}`, values) : t(`boardSetup.interfacePreset.${key}`)

const plan = computed(() => (props.result.ok ? props.result.plan : null))
const failure = computed(() => (props.result.ok ? null : props.result))
const preset = computed(() => INTERFACE_PRESETS.find((p) => p.id === props.request.preset))
const mode = computed(() =>
  preset.value?.modes.find((m) => m.id === (props.request.mode ?? preset.value?.defaultMode))
)

const update = (change: Partial<PresetRequest>): void => {
  const next: PresetRequest = { ...props.request, ...change }
  for (const key of ['gap', 'width', 'layers'] as const)
    if (next[key] === undefined) delete next[key]
  emit('update', next)
}

// --- Interface and mode -------------------------------------------------------

const presetField = computed<PropertyField>(() => ({
  key: 'preset',
  label: tr('interface'),
  editor: {
    kind: 'select',
    options: INTERFACE_PRESETS.map((p) => ({ value: p.id, label: p.name }))
  },
  value: props.request.preset
}))
const modeField = computed<PropertyField>(() => ({
  key: 'mode',
  label: tr('mode'),
  editor: {
    kind: 'select',
    options: (preset.value?.modes ?? []).map((m) => ({
      value: m.id,
      label: t(`boardSetup.interfacePreset.modes.${props.request.preset}.${m.id}`)
    }))
  },
  value: mode.value?.id ?? ''
}))
const onPreset = (value: PropertyEditValue): void => {
  const next = INTERFACE_PRESETS.find((p) => p.id === value)
  if (!next) return
  // A new interface starts from its own mode.
  update({
    preset: next.id,
    mode: next.defaultMode,
    gap: undefined,
    width: undefined,
    layers: undefined
  })
}

// --- The class: one of the project's; its nets are the ones Assignments gives it ----

const classField = computed<PropertyField>(() => ({
  key: 'netClass',
  label: tr('netClass'),
  editor: { kind: 'select', tags: true, options: [...props.classOptions] },
  value: props.request.netClass
}))
const onClass = (value: PropertyEditValue): void => {
  if (typeof value === 'string') update({ netClass: value })
}
/** The matched nets no pair holds: a single-ended preset's all. */
const unpairedNets = computed(() => {
  const report = plan.value?.report
  if (!report) return []
  const paired = new Set(report.pairs.flat())
  return report.nets.filter((net) => !paired.has(net))
})
/** The class has no nets yet: set up all the same; assigning them is Assignments' job. */
const noNets = computed(() => plan.value?.report.nets.length === 0)

// --- The gap, among the choices; and the layers --------------------------------

/** The mode holds an impedance: no stackup, gap or layers to choose where it does not. */
const controlled = computed(() => !mode.value?.uncontrolled)
const hasGap = computed(
  () =>
    controlled.value &&
    (preset.value?.type === 'differential' || preset.value?.model === 'coplanar')
)
/** The gap and the first layer's width, mm, as solved; as typed while the draft cannot solve them. */
const gapValue = computed(() => (plan.value ? plan.value.report.gap : (props.request.gap ?? null)))
const widthValue = computed(
  () => plan.value?.report.layers[0]?.width ?? props.request.width ?? null
)
/** Board Setup's length field: the unit inside it, mil typed or mm, leaving applies and Escape abandons. */
const lengthField = (key: 'gap' | 'width', value: number | null): PropertyField => ({
  key,
  label: tr(`columns.${key}`),
  editor: { kind: 'distance', step: 0.01, min: 0, optional: true },
  value
})
const firstLayer = computed(() => plan.value?.report.layers[0]?.layer ?? ticked.value[0] ?? '')
/** A typed gap solves the width, a typed width the gap: the one typed is held, the other cleared. */
const onLinked = (field: 'gap' | 'width', value: PropertyEditValue): void => {
  if (typeof value !== 'number' || !(value > 0)) return
  update(field === 'gap' ? { gap: value, width: undefined } : { width: value, gap: undefined })
}
const layerChoices = computed(() =>
  preset.value?.model === 'coplanar'
    ? props.copperLayers.filter((l) => l.name === 'F.Cu' || l.name === 'B.Cu')
    : props.copperLayers
)
// The plan's layers; before there is one, the default it would take: the outer copper.
const ticked = computed(
  () =>
    props.request.layers ??
    plan.value?.report.layers.map((l) => l.layer) ??
    layerChoices.value.map((l) => l.name).filter((l) => l === 'F.Cu' || l === 'B.Cu')
)
const toggleLayer = (layer: string, on: boolean): void => {
  const next = on ? [...ticked.value, layer] : ticked.value.filter((l) => l !== layer)
  // Kept in the stack's order; none ticked is not a choice.
  if (next.length)
    update({ layers: layerChoices.value.map((l) => l.name).filter((l) => next.includes(l)) })
}
const swatchOf = (layer: string): string =>
  props.copperLayers.find((l) => l.name === layer)?.color ?? 'transparent'

const fmt = (value: number, digits = 3): string =>
  `${Math.round(value * 10 ** digits) / 10 ** digits}`

/** The class's fields a preset sets, each shown where Apply changes it. */
const CLASS_FIELDS = [
  'trackWidth',
  'diffPairWidth',
  'diffPairGap',
  'clearance',
  'tuningProfile'
] as const
const classAfter = computed(() =>
  plan.value?.classes.find((c) => c.name === props.request.netClass)
)
const classUpdates = computed(() => {
  const after = classAfter.value
  if (!after) return []
  const show = (c: NetClass | undefined, key: (typeof CLASS_FIELDS)[number]): string => {
    const value = c?.[key]
    return typeof value === 'number' ? `${fmt(value)} mm` : value || '–'
  }
  return CLASS_FIELDS.flatMap((key) => {
    const before = show(props.classBefore, key)
    const next = show(after, key)
    return before === next
      ? []
      : [{ key, label: t(`boardSetup.netClassColumns.${key}`), value: next }]
  })
})

/** The target's own source, beside it. */
const targetSource = computed(() => {
  const m = mode.value
  return m && preset.value
    ? preset.value.sources[m.tolerance?.source ?? m.impedance.source]
    : undefined
})
</script>

<template>
  <section class="preset-draft" :aria-label="tr('title')">
    <header class="draft-head">
      <h3 class="draft-title">
        <Icon name="tool-route-pair" class="draft-icon" />
        {{ tr('title') }}
      </h3>
      <span class="draft-actions">
        <button class="btn-outline btn-sm" type="button" @click="emit('discard')">
          {{ tr('discard') }}
        </button>
        <button
          class="btn-cta btn-sm"
          type="button"
          :disabled="!plan || applying"
          @click="emit('apply')"
        >
          {{ tr('apply') }}
        </button>
      </span>
    </header>

    <div class="draft-grid">
      <!-- Each row: its choice, then what it brings with it, read only. -->
      <span class="draft-label top">{{ tr('interface') }}</span>
      <span class="draft-row column">
        <span class="draft-row">
          <span class="draft-select">
            <PropertyValueEditor :field="presetField" @commit="onPreset" />
          </span>
          <span v-if="(preset?.modes.length ?? 0) > 1" class="draft-select">
            <PropertyValueEditor :field="modeField" @commit="(v) => update({ mode: String(v) })" />
          </span>
        </span>
        <span v-if="mode" class="detail">
          {{ tr('target') }}
          <span class="mono value">
            {{ mode.impedance.value }} Ω<template v-if="mode.tolerance">
              ±{{ mode.tolerance.value }}%</template
            >
            {{ preset?.type === 'differential' ? tr('differential') : '' }}
          </span>
          <span v-if="!controlled">{{ tr('uncontrolled') }}</span>
          <a
            v-if="targetSource"
            href="#"
            class="source"
            @click.prevent="emit('open-source', targetSource.url)"
          >
            {{ targetSource.title }} · {{ targetSource.where }}
          </a>
        </span>
        <span v-if="mode?.frequencyHz" class="detail">
          {{ tr('frequency') }}
          <span class="mono value">{{ fmt(mode.frequencyHz / 1e9, 2) }} GHz</span>
        </span>
      </span>

      <span class="draft-label top">{{ tr('netClass') }}</span>
      <span class="draft-row column">
        <span class="draft-select">
          <PropertyValueEditor :field="classField" @commit="onClass" />
        </span>
        <span v-if="noNets" class="detail">{{
          tr('assignNets', { netClass: request.netClass })
        }}</span>
        <span v-else-if="plan" class="detail centered">
          {{
            t(
              'boardSetup.interfacePreset.matched',
              { count: plan.report.nets.length, pairs: plan.report.pairs.length },
              plan.report.nets.length
            )
          }}
          <span class="matched mono key">
            <DiffPairGroup v-for="pair in plan.report.pairs" :key="pair[0]">
              <span v-for="net in pair" :key="net">{{ net }}</span>
            </DiffPairGroup>
            <span v-for="net in unpairedNets" :key="net">{{ net }}</span>
          </span>
        </span>
        <span v-if="hasGap" class="detail">
          {{ tr('defaultClearance') }}
          <span class="mono value">{{ fmt(inputs.defaultClearance) }} mm</span>
        </span>
      </span>

      <template v-if="controlled">
        <span class="draft-label">{{ tr('layers') }}</span>
        <span class="draft-row">
          <label v-for="layer in layerChoices" :key="layer.name" class="layer-choice mono">
            <input
              :id="`preset-layer-${layer.name}`"
              type="checkbox"
              :checked="ticked.includes(layer.name)"
              @change="toggleLayer(layer.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="swatch" :style="{ backgroundColor: layer.color }"></span>
            {{ layer.name }}
          </label>
        </span>

        <span class="draft-label top">{{ tr('stackup') }}</span>
        <span class="draft-row column">
          <span class="mono detail value">{{
            tr('stackupSummary', {
              count: inputs.copperLayers,
              thickness: fmt(inputs.boardThickness, 2)
            })
          }}</span>
          <span v-for="row in inputs.layers" :key="row.layer" class="mono detail input-layer">
            <span class="swatch" :style="{ backgroundColor: swatchOf(row.layer) }"></span>
            {{ row.layer }} ({{ tr('reference') }} {{ row.references }}) · h {{ row.heights }} mm ·
            εr {{ fmt(row.epsilonR, 2) }} · Cu {{ fmt(row.copperMm, 4) }} mm
          </span>
        </span>

        <span class="draft-label">{{ tr('constraints') }}</span>
        <span class="draft-row mono detail value">{{
          tr('fabLimitsValues', {
            track: inputs.minTrackWidth > 0 ? `${fmt(inputs.minTrackWidth)} mm` : tr('notSet'),
            clearance: inputs.minClearance > 0 ? `${fmt(inputs.minClearance)} mm` : tr('notSet')
          })
        }}</span>
      </template>

      <template v-if="hasGap">
        <span class="draft-label top">
          {{ preset?.model === 'coplanar' ? tr('groundGap') : tr('pairGap') }}
        </span>
        <span class="draft-row column">
          <!-- Linked: either one typed, the other is solved for the target. -->
          <span class="linked">
            <label class="linked-field">
              <span class="swatch" :style="{ backgroundColor: swatchOf(firstLayer) }"></span>
              <span class="mono hint">{{ firstLayer }}</span>
              <span class="hint">{{ tr('columns.width') }}</span>
              <span class="linked-input">
                <PropertyValueEditor
                  :field="lengthField('width', widthValue)"
                  @commit="(v) => onLinked('width', v)"
                />
              </span>
            </label>
            <span class="link-glyph" :title="tr('linked')"><Icon name="link" /></span>
            <label class="linked-field">
              <span class="hint">{{ tr('columns.gap') }}</span>
              <span class="linked-input">
                <PropertyValueEditor
                  :field="lengthField('gap', gapValue)"
                  @commit="(v) => onLinked('gap', v)"
                />
              </span>
            </label>
            <span class="mono value">{{ mode?.impedance.value }} Ω</span>
          </span>
          <span class="detail">
            {{ plan ? tr(`gapSource.${plan.report.gapSource}`) : '' }}
            <button
              v-if="request.gap !== undefined || request.width !== undefined"
              class="btn-subtle btn-sm"
              type="button"
              @click="update({ gap: undefined, width: undefined })"
            >
              {{ tr('derivedGap') }}
            </button>
          </span>
        </span>
      </template>
    </div>

    <p v-if="failure" class="error">
      {{ tr(`errors.${failure.code}`) }}
      <span v-if="failure.candidates?.length" class="mono">{{
        failure.candidates.join(', ')
      }}</span>
    </p>
    <!-- What Apply writes, last and set apart: the class's changed fields, then its custom rules. -->
    <div v-else-if="plan" class="draft-outputs">
      <Translation keypath="boardSetup.interfacePreset.classUpdates" tag="span" class="draft-label">
        <template #netClass>
          <NetClassTag :name="request.netClass" :color="classAfter?.pcbColor" />
        </template>
      </Translation>
      <!-- The class's changed fields as Net classes' columns, one row as Apply leaves it. -->
      <div v-if="classUpdates.length" class="rules-wrap">
        <table class="sheet">
          <thead>
            <tr>
              <th v-for="cell in classUpdates" :key="cell.key">{{ cell.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr :class="`pending-${classBefore ? 'edited' : 'added'}`">
              <td v-for="cell in classUpdates" :key="cell.key" class="sheet-text mono num">
                {{ cell.value }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint">{{ tr('classUnchanged') }}</p>
      <!-- The class's tuning profile, in the Tuning profiles page's columns: a row per layer. -->
      <template v-if="plan.report.controlled">
        <Translation
          keypath="boardSetup.interfacePreset.profileUpdates"
          tag="span"
          class="draft-label"
        >
          <template #profile>
            <span class="mono value">{{ plan.profileName }}</span>
          </template>
        </Translation>
        <div class="rules-wrap">
          <table class="sheet">
            <thead>
              <tr>
                <th>{{ t('boardSetup.tuningProfiles.columns.layer') }}</th>
                <th>{{ t('boardSetup.tuningProfiles.columns.width') }}</th>
                <th v-if="preset?.type === 'differential'">
                  {{ t('boardSetup.tuningProfiles.columns.gap') }}
                </th>
                <th>{{ t('boardSetup.tuningProfiles.columns.delay') }}</th>
                <th>{{ t('boardSetup.tuningProfiles.readout') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in plan.report.layers"
                :key="row.layer"
                :class="profilePending && `pending-${profilePending}`"
              >
                <td class="sheet-text mono">
                  <span class="swatch" :style="{ backgroundColor: swatchOf(row.layer) }"></span>
                  {{ row.layer }}
                </td>
                <td class="sheet-text mono num">{{ fmt(row.width) }} mm</td>
                <td v-if="preset?.type === 'differential'" class="sheet-text mono num">
                  {{ fmt(row.gap ?? 0) }} mm
                </td>
                <td class="sheet-text mono num">{{ fmt(row.delay, 2) }} ps/mm</td>
                <td class="sheet-text mono num">{{ fmt(row.ohms, 1) }} Ω</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <template v-if="rules.length">
        <span class="draft-label">{{ tr('customRules') }}</span>
        <!-- Custom rules' own table, as that section draws it. -->
        <div class="rules-wrap">
          <table class="sheet">
            <thead>
              <tr>
                <th>{{ t('boardSetup.customRules.columns.rule') }}</th>
                <th>{{ t('boardSetup.customRules.columns.appliesTo') }}</th>
                <th>{{ t('boardSetup.customRules.columns.constraint') }}</th>
                <th>{{ t('boardSetup.customRules.columns.limit') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rules"
                :key="row.key"
                :class="row.pending && `pending-${row.pending}`"
                :title="row.pending ? t(`boardSetup.pending.${row.pending}`) : undefined"
              >
                <td class="sheet-text">{{ row.rule }}</td>
                <td class="sheet-text mono">{{ row.appliesTo || '–' }}</td>
                <td class="sheet-text mono">{{ row.constraint }}</td>
                <td class="sheet-text mono num">{{ row.limit }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* The draft opens where its button was, below the assignments: the data surface,
   the pending rows' hue on its rim only, so its text reads as any table's. */
.preset-draft {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
  padding: 14px 16px;
  border: 1px solid var(--vscode-success);
  border-radius: 6px;
  background-color: var(--vscode-data-bg);
}

.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

.draft-icon {
  width: 18px;
  height: 18px;
}

.draft-actions {
  display: flex;
  gap: 8px;
}

.draft-grid {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 10px 12px;
  font-size: var(--text-body);
}

.draft-label {
  color: var(--vscode-text-muted);
}

.draft-label.top {
  align-self: start;
  padding-top: 4px;
}

.draft-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  min-width: 0;
}

.draft-row.column {
  flex-direction: column;
  align-items: stretch;
}

.draft-select {
  width: 200px;
}

.source {
  color: var(--vscode-accent);
  font-size: var(--text-body-sm);
}

.linked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.linked-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.linked-input {
  width: 110px;
}

.link-glyph {
  display: inline-flex;
  color: var(--vscode-text-muted);
}

.link-glyph svg {
  width: 14px;
  height: 14px;
}

/* What Apply writes, set apart from the choices above by a rule. */
.draft-outputs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--vscode-border);
}

/* What a row brings with it: under its choice, smaller and read only; its
   parts (a label, a value, a source) wrap apart rather than run together. */
.detail {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  min-width: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.detail .value,
.draft-row.value {
  color: var(--vscode-text);
}

.input-layer {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-text-muted);
}

.layer-choice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-body-sm);
}

.layer-choice input {
  margin: 0;
  accent-color: var(--vscode-accent);
}

/* A layer's color beside its name (DESIGN.md, Layer swatches). */
.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  vertical-align: baseline;
}

.mono {
  font-family: var(--font-mono);
}

.key {
  color: var(--vscode-data-fg);
}

.detail.centered {
  align-items: center;
}

.matched {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}

.hint {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.rules-wrap {
  overflow-x: auto;
}

.error {
  margin: 0;
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}
</style>
