<script setup lang="ts">
/**
 * Board Setup — the P0.4 view mode. Edited independently of the canvas, so it
 * takes the whole editor pane rather than the 280px right rail.
 *
 * Section nav, then whichever instrument the section calls for: explained cards
 * for the constraints, inline tables for the stackup layers and the net classes.
 *
 * Cards rather than a property table where the settings are infrequent and
 * jargon-heavy, so each gets room and a colored diagram. Tables where the rows
 * are peers you compare against each other — layers, classes — which is what
 * columns do and stacked cards do not. The tables are local to this view rather
 * than a shared component: a generic grid was tried and read worse than the
 * hand-tuned markup here, so the duplication is deliberate.
 *
 * Only the stackup has a preview pane, and it earns it: an edge-on cross-section
 * is a drawing no control on the left states, and no engine in the app draws
 * (0.035 mm copper is a sub-pixel hairline against a 1.6 mm board, so it is SVG
 * rather than the GL renderer).
 *
 * Voice: the audience are engineers. Nothing here explains electronics, and a
 * control that names itself is left to. Type never goes below the app's 11px
 * floor (RULES.md §6).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StackupPreview3D from './StackupPreview3D.vue'
import PropertyValueEditor from '../shared/PropertyValueEditor.vue'
import RuleSeverityTable from '../shared/RuleSeverityTable.vue'
import ExclusionList from '../shared/ExclusionList.vue'
import Icon from '../shared/Icon.vue'
import NetClassTag from '../shared/NetClassTag.vue'
import DiffPairGroup from '../shared/DiffPairGroup.vue'
import CurrentWidthCalculator from './CurrentWidthCalculator.vue'
import { useFocusAddedRow } from '../../lib/useFocusAddedRow'
import { NEW_RULE_TEXT } from '../../lib/board/customRuleRows'
import { ruleTextIn } from '../../lib/board/rules/druRules'
import { rememberedRef, takeRequest } from '../../lib/paneMemory'
import type { PropertyEditValue, PropertyField } from '../../lib/propertyTable'
import { isUserPresetId } from '../../lib/board/userSetupPresets'
import {
  NET_CLASS_COLUMNS,
  SCHEMATIC_CLASS_COLUMNS,
  STACKUP_COLUMNS,
  balanceRuns,
  settingRuns,
  type BoardSetting,
  type BoardSetupSection,
  type ExtraSizeField,
  type NetClassEditColumn,
  type SectionId,
  type StackupColumn,
  type StackupLayerRow
} from '../../lib/board/boardSetupSchema'
import {
  BOARD_SETUP_GLYPHS,
  GLYPH_PALETTE,
  TEARDROP_LEGENDS,
  TUNING_LEGENDS,
  type GlyphPart,
  type LegendLabel
} from '../../lib/boardSetupGlyphs'
import type { StackupSpec } from '../../lib/kicad/board'
import { DRC_CATALOG } from '../../lib/board/drcCatalog'
import type { RuleSeverity, SeverityMap } from '../../lib/ruleSeverity'
import type { KicadExclusion } from '../../lib/kicadExclusions'
import type { CheckResult } from '../../lib/schematic/checks'
import { groupNets, matchNets, netCoverage, splitNetName } from '../../lib/board/netClassCoverage'
import { DEFAULT_CLASS_NAME, type NetClassAssignment } from '../../lib/kicad/project'
import {
  PROFILE_LAYER_COLUMNS,
  type LayerReadout,
  type ProfileField,
  type ProfileLayerColumn
} from '../../lib/board/tuningProfiles'

const { t } = useI18n()

const props = defineProps<{
  sections: BoardSetupSection[]
  stackup: StackupSpec
  /** The board's stackup rows — the table's model and the diagram's. */
  layerRows: StackupLayerRow[]
  /** True when rules have nowhere to persist (a board with no project file). */
  rulesReadOnly?: boolean
  readOnly?: boolean
  /** Suffix for a profile edited away from its shipped values. */
  profileEdited?: boolean
  /** The project's DRC `rule_severities`. */
  severities: SeverityMap
  /** The board's current findings per KiCad key; null before the first run. */
  ruleCounts: ReadonlyMap<string, number> | null
  /** The project's KiCad exclusions, and the findings they are matched against. */
  exclusions: readonly KicadExclusion[]
  checkResults: readonly CheckResult[] | null
  /** A section to show, from elsewhere in the editor (the route's size list, S4); `seq` repeats a request. */
  showSection?: { id: SectionId; seq: number } | null
  /** The board's nets the assignments are written against (`assignableNets`). */
  netNames?: readonly string[]
  /** The schematic's per-net class assignments, which the page shows but does not edit. */
  netAssignments?: readonly NetClassAssignment[]
  /** The project's `.kicad_dru` text: what Custom rules edits a rule of. */
  customRulesText?: string
  /** Write a rule as typed in place of `name` (null: a new one); answers why not, empty when written. */
  saveCustomRule?: (name: string | null, text: string) => Promise<string[]>
  removeCustomRule?: (name: string) => Promise<void>
  /** One section inside another page (Schematic Setup's net classes): no title bar or section list. */
  embedded?: boolean
  /** The class columns this editor owns, as KiCad shows each its own: the board's sizes, or the schematic's styling. */
  classColumns?: 'board' | 'schematic'
  /** Where the section shown is remembered across remounts (`paneMemory.ts`); none forgets it. */
  memoryKey?: string
  /** The theme's layer display colors, by layer name. */
  layerColors?: Readonly<Record<string, string>>
}>()

const emit = defineEmits<{
  (e: 'edit', section: string, key: string, value: PropertyEditValue): void
  (e: 'edit-layer', index: number, column: StackupColumn, value: PropertyEditValue): void
  (e: 'add-dielectric', afterIndex: number): void
  (e: 'remove-layer', index: number): void
  (e: 'edit-net-class', index: number, column: NetClassEditColumn, value: PropertyEditValue): void
  (e: 'add-net-class'): void
  (e: 'import-class-colors'): void
  (e: 'remove-net-class', index: number): void
  (e: 'edit-pattern', index: number, field: 'pattern' | 'netClass', value: PropertyEditValue): void
  (e: 'add-pattern'): void
  (e: 'remove-pattern', index: number): void
  (
    e: 'edit-extra-size',
    kind: 'track' | 'via',
    index: number,
    field: ExtraSizeField,
    value: PropertyEditValue
  ): void
  (e: 'add-extra-size', kind: 'track' | 'via'): void
  (e: 'remove-extra-size', kind: 'track' | 'via', index: number): void
  /** Save the section's values as the user's own preset, by name. */
  (e: 'save-preset', section: SectionId, name: string): void
  /** Remove the picked preset; only the user's own are offered. */
  (e: 'remove-preset', section: SectionId): void
  (e: 'set-severity', key: string, severity: RuleSeverity): void
  (e: 'add-tuning-profile'): void
  (e: 'remove-tuning-profile', index: number): void
  (e: 'edit-tuning-profile', index: number, field: ProfileField, value: PropertyEditValue): void
  (e: 'add-profile-layer', index: number): void
  (e: 'remove-profile-layer', index: number, row: number): void
  (
    e: 'edit-profile-layer',
    index: number,
    row: number,
    column: ProfileLayerColumn,
    value: PropertyEditValue
  ): void
  (e: 'solve-profile-layer', index: number, row: number): void
  (e: 'solve-profile', index: number): void
  /** Start setting up a class for an interface; the draft shows on Net classes. */
  (e: 'start-interface-preset'): void
}>()

/** A single-ended profile has no pair gap: its column goes, as KiCad hides it. */
const profileColumns = (differential: boolean): readonly ProfileLayerColumn[] =>
  differential ? PROFILE_LAYER_COLUMNS : PROFILE_LAYER_COLUMNS.filter((c) => c !== 'gap')

/** A row's impedance as its geometry stands, to the tenth of an ohm. */
const readoutText = (readout: LayerReadout): string =>
  readout && 'ohms' in readout ? `${readout.ohms.toFixed(1)} Ω` : ''

/** The board's thickness is the sum of its layers, never a field. */
const totals = computed(() => {
  const sum = (kinds: string[]): number =>
    props.layerRows.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.mm, 0)
  const copper = sum(['copper'])
  const dielectric = sum(['dielectric'])
  return { copper, dielectric, total: copper + dielectric + sum(['mask']) }
})

/** The stackup's copper, top to bottom, as the width-from-current readout reads it. */
const copperForCurrent = computed(() =>
  props.layerRows
    .filter((r) => r.kind === 'copper')
    .map((r) => ({
      name: r.name,
      thicknessMm: r.mm,
      color: props.layerColors?.[r.name] ?? 'transparent'
    }))
)

/** A rule's title; a key KiCad 10 does not name (a legacy one) reads as itself. */
const drcRuleTitle = (key: string): string =>
  DRC_CATALOG.some((rule) => rule.key === key) ? t(`ruleChecks.drc.${key}`) : key

// Kept per board while the window lives, so returning to the tab lands where it was left.
const activeSection = rememberedRef<SectionId>(
  props.memoryKey,
  props.embedded ? (props.sections[0]?.id ?? 'stackup') : 'stackup'
)
/** The stackup's columns that hold numbers, right-aligned as a sheet's are. */
const NUMERIC_STACKUP: ReadonlySet<string> = new Set(['thickness', 'epsilonR', 'lossTangent'])

const section = computed(
  () => props.sections.find((s) => s.id === activeSection.value) ?? props.sections[0]
)

const headerSetting = computed(() => section.value?.settings.find((s) => s.isHeader) ?? null)
const rows = computed(() => (section.value?.settings ?? []).filter((s) => !s.isHeader))

/** The picked preset is the user's own, which alone can be removed. */
const isUserPreset = computed(() => isUserPresetId(String(headerSetting.value?.value ?? '')))

/**
 * Only the stackup has a preview. Its cross-section draws something no control
 * states; the other sections' cards and tables already are the thing, so a pane
 * beside them held either a blown-up copy of a glyph or a line of nothing.
 */
const showPreview = computed(() => activeSection.value === 'stackup')

/** A card plus its index in `rows` — the editor refs are keyed by that index. */
interface CardEntry {
  row: BoardSetting
  index: number
}

interface CardGroup {
  key: string
  /** Empty for a section with no groupings at all (stackup, routing). */
  label: string
  cards: CardEntry[]
}

/**
 * The rows as laid-out columns. Splitting whole categories and balancing them
 * is pure and lives in the schema (`settingRuns` / `balanceRuns`); this only
 * resolves the labels and pairs each card with its index.
 *
 * One column while a preview pane holds the other half of the width. Where two
 * come back, CSS still decides whether they sit side by side or wrap.
 */
const cardColumns = computed<CardGroup[][]>(() => {
  const runs = settingRuns(rows.value)
  const columns = showPreview.value ? [runs] : balanceRuns(runs)
  return columns.map((column) =>
    column.map((run) => ({
      key: run.group ?? String(run.indices[0]),
      label: run.group ? t(`boardSetup.groups.${run.group}`) : '',
      cards: run.indices.map<CardEntry>((index) => ({ row: rows.value[index], index }))
    }))
  )
})

/** Only the columns whose heading is an abbreviation nobody can guess. */
const HINTED_COLUMNS: StackupColumn[] = ['epsilonR', 'lossTangent']
const columnHint = (col: StackupColumn): string =>
  HINTED_COLUMNS.includes(col) ? t(`boardSetup.columns.${col}Hint`) : ''

// --- Custom rules: one rule at a time, as the file's own text -----------------

/** The rule being edited (null name: a new one), its text as typed, and why it was refused. */
const ruleEdit = ref<{ name: string | null; text: string; errors: string[] } | null>(null)
const ruleRows = computed(() => section.value?.customRules ?? [])
/** A rule's constraints are rows; its name and condition show on its first. */
const firstOfRule = (i: number): boolean =>
  i === 0 || ruleRows.value[i - 1]?.rule !== ruleRows.value[i]?.rule
const lastOfRule = (i: number): boolean => ruleRows.value[i + 1]?.rule !== ruleRows.value[i]?.rule
const startRuleEdit = (name: string | null): void => {
  ruleEdit.value = {
    name,
    text: name === null ? NEW_RULE_TEXT : (ruleTextIn(props.customRulesText, name) ?? ''),
    errors: []
  }
}
const saveRule = async (): Promise<void> => {
  const edit = ruleEdit.value
  if (!edit || !props.saveCustomRule) return
  const errors = await props.saveCustomRule(edit.name, edit.text)
  if (errors.length) edit.errors = errors
  else ruleEdit.value = null
}
const removeRule = (name: string): void => void props.removeCustomRule?.(name)

const glyph = (name?: string): GlyphPart[] => (name ? (BOARD_SETUP_GLYPHS[name] ?? []) : [])
/** A block's legend, under its group's heading (Length-tuning patterns, Teardrops). */
const LEGENDS: Record<string, { parts: GlyphPart[]; labels: LegendLabel[] }> = {
  ...TUNING_LEGENDS,
  ...TEARDROP_LEGENDS
}
const legendOf = (group: string): { parts: GlyphPart[]; labels: LegendLabel[] } | null =>
  LEGENDS[group] ?? null
/** The glyphs' material colors, as the CSS variables their roles read. */
const glyphPalette = Object.fromEntries(
  Object.entries(GLYPH_PALETTE).map(([role, color]) => [`--g-${role}`, color])
)

const cardEditors = ref<Array<InstanceType<typeof PropertyValueEditor> | null>>([])
const setCardEditorRef =
  (index: number) =>
  (el: unknown): void => {
    cardEditors.value[index] = (el as InstanceType<typeof PropertyValueEditor>) ?? null
  }

/**
 * A click anywhere on a card activates its value — the card IS the control:
 * a choice opens its list, a number takes focus ready to type over. A click
 * on the value itself is the value's own, so it is left alone.
 */
const onCardClick = (event: MouseEvent, index: number): void => {
  if ((event.target as HTMLElement).closest('.setting-value')) return
  nextTick(() => cardEditors.value[index]?.activate())
}

const selectSection = (id: SectionId): void => {
  activeSection.value = id
}

watch(
  () => props.showSection,
  (request) => {
    if (request && takeRequest(props.memoryKey, request.seq)) selectSection(request.id)
  },
  { immediate: true }
)

/** The name Save starts the field with, or null while the header shows its picker. */
const pendingName = ref<string | null>(null)
/** What the field holds now, so Save can wait for a name. */
const typedName = ref('')
const headerEditor = ref<InstanceType<typeof PropertyValueEditor> | null>(null)
watch(activeSection, () => (pendingName.value = null))

const headerField = computed<PropertyField>(() => {
  const setting = headerSetting.value!
  return pendingName.value !== null
    ? { key: setting.key, editor: { kind: 'text', commitOnEnter: true }, value: pendingName.value }
    : { key: setting.key, editor: setting.editor, value: setting.value }
})

/** Seeded with the picked preset's name when it is the user's: saving over it is the default. */
const beginSave = (): void => {
  const setting = headerSetting.value
  const value = String(setting?.value ?? '')
  // A saved preset's option reads as its name alone.
  const label = setting?.editor.options?.find((o) => o.value === value)?.label ?? ''
  pendingName.value = isUserPresetId(value) ? label : ''
  typedName.value = pendingName.value
  void nextTick(() => headerEditor.value?.focus())
}

const headerRow = ref<HTMLElement | null>(null)
// Only the name field leaving abandons it: the Save button it replaced also
// loses focus as it goes, and that is not the user clicking away.
const onHeaderFocusOut = (e: FocusEvent): void => {
  if (pendingName.value === null || !(e.target instanceof HTMLInputElement)) return
  const next = e.relatedTarget
  if (!(next instanceof Node) || !headerRow.value?.contains(next)) pendingName.value = null
}

/** Save and Cancel keep the focus in the name field, so pressing one is not leaving it. */
const onHeaderMouseDown = (e: MouseEvent): void => {
  if (pendingName.value !== null && (e.target as Element).closest('button')) e.preventDefault()
}

const confirmName = (): void => {
  const name = typedName.value.trim()
  pendingName.value = null
  if (name) emit('save-preset', activeSection.value, name)
}

/** Picking a preset reseeds the section — dispatched as its own kind. */
const onHeaderCommit = (value: PropertyEditValue): void => {
  const setting = headerSetting.value
  if (!setting) return
  // Enter in the name field: the same confirm as Save.
  if (pendingName.value !== null) {
    typedName.value = String(value)
    confirmName()
    return
  }
  // Constraints are keyed by configuration; stackup by catalog build.
  emit('edit', setting.key === 'profileId' ? 'profile' : 'stackup', setting.key, value)
}

// A section is read-only when its data has nowhere to go: stackup lives in the
// board and always saves; constraints and routing need a .kicad_pro.
const sectionDisabled = (id: SectionId): boolean =>
  !!props.readOnly || (!!props.rulesReadOnly && id !== 'stackup')

const stackupRow = ref<HTMLElement | null>(null)
const stackupTable = ref<HTMLElement | null>(null)
const stackupPreview = ref<HTMLElement | null>(null)
/** The drawing has wrapped under the table: centered there, rather than set beside it. */
const previewWrapped = ref(false)
/** How far in the wrapped drawing sits to center on the table, which may be narrower than the row. */
const wrappedInset = ref(0)
const measureWrap = (): void => {
  const table = stackupTable.value
  const preview = stackupPreview.value
  previewWrapped.value = !!table && !!preview && preview.offsetTop > table.offsetTop + 1
  wrappedInset.value =
    table && preview ? Math.max(0, (table.offsetWidth - preview.offsetWidth) / 2) : 0
}
let rowObserver: ResizeObserver | null = null
watch(stackupRow, (row) => {
  rowObserver?.disconnect()
  rowObserver = null
  if (!row) return
  rowObserver = new ResizeObserver(measureWrap)
  rowObserver.observe(row)
  if (stackupTable.value) rowObserver.observe(stackupTable.value)
  measureWrap()
})
onBeforeUnmount(() => rowObserver?.disconnect())

/** The stackup layer hovered in the table or the preview: each lights the other. */
const hoveredLayer = ref<number | null>(null)
/** What the preview names under itself: the hovered layer, and nothing otherwise. */
const previewCaption = computed(() => {
  const row = props.layerRows.find((r) => r.index === hoveredLayer.value)
  if (!row) return ''
  return row.mm > 0 ? `${row.label} · ${fmt(row.mm)}` : row.label
})

const fmt = (mm: number): string => `${Math.round(mm * 1e4) / 1e4} mm`

/** Every table's rows, keyed as their `data-row`s are: an added one takes focus. */
const setupRoot = ref<HTMLElement | null>(null)
const addedRow = useFocusAddedRow(setupRoot, () => {
  const s = section.value
  if (!s) return []
  return [
    ...(s.layers ?? []).map((r) => `layer:${r.index}`),
    ...(s.netClasses ?? []).map((r) => `class:${r.index}`),
    ...(s.netClassPatterns ?? []).map((r) => `pattern:${r.index}`),
    ...(s.extraTracks ?? []).map((r) => `track:${r.index}`),
    ...(s.tuningProfiles ?? []).flatMap((p) => [
      `profile:${p.index}`,
      ...p.layers.map((r) => `profile:${p.index}:${r.index}`)
    ]),
    ...(s.extraVias ?? []).map((r) => `via:${r.index}`)
  ]
})

// --- Assignments and the nets they reach ------------------------------------

const patternRows = computed(() => section.value?.netClassPatterns ?? [])
const coverage = computed(() =>
  section.value?.netClassPatterns
    ? netCoverage(props.netNames ?? [], patternRows.value, props.netAssignments ?? [])
    : null
)

/** Nets drawn at once — a bound on the DOM, not on reading: the list scrolls. */
const NET_CAP = 500

/** The row whose nets the list shows: a pattern's index, or Default's row. */
const selectedRow = ref<number | 'default' | null>(null)
/** The selected pattern's text as it is typed (settled, not per key). */
const patternDraft = ref<{ index: number; text: string } | null>(null)

let draftTimer: ReturnType<typeof setTimeout> | undefined
const SETTLE_MS = 120
onBeforeUnmount(() => clearTimeout(draftTimer))

const onPatternInput = (index: number, event: Event): void => {
  const text = (event.target as HTMLInputElement).value
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => (patternDraft.value = { index, text }), SETTLE_MS)
}
const onPatternBlur = (): void => {
  clearTimeout(draftTimer)
  patternDraft.value = null
}

const removePattern = (index: number): void => {
  selectedRow.value = null
  emit('remove-pattern', index)
}

/** The selected row's nets: the pattern as typed so far, or what no pattern takes. */
const selectedNets = computed<readonly string[]>(() => {
  const cov = coverage.value
  const row = selectedRow.value
  if (!cov || row === null) return []
  if (row === 'default') return cov.unassigned
  const pattern = patternRows.value[row]?.pattern
  if (pattern === undefined) return []
  const draft = patternDraft.value
  return draft?.index === row && draft.text !== pattern
    ? matchNets(draft.text, cov.nets)
    : cov.matches[row]
})

const netGroups = computed(() => groupNets(selectedNets.value, NET_CAP))

const netTitle = (net: string): string =>
  (coverage.value?.classesOf.get(net) ?? [DEFAULT_CLASS_NAME]).join(', ')

const countTitle = (index: number): string => {
  const row = coverage.value?.patterns[index]
  if (!row) return ''
  if (row.invalid) return t('boardSetup.patterns.invalid')
  if (!row.overlap) return ''
  return t('boardSetup.patterns.overlap', {
    count: row.overlap,
    classes: row.overlapClasses.join(', ')
  })
}
</script>

<template>
  <div ref="setupRoot" class="board-setup">
    <header v-if="!props.embedded" class="setup-title-bar">
      <h1 class="setup-title">{{ t('boardSetup.title') }}</h1>
    </header>

    <div class="setup-body">
      <!-- Section nav -->
      <nav v-if="!props.embedded" class="nav-list" role="tablist">
        <button
          v-for="s in props.sections"
          :key="s.id"
          class="nav-item"
          :class="{ active: s.id === activeSection }"
          role="tab"
          :aria-selected="s.id === activeSection"
          @click="selectSection(s.id)"
        >
          {{ s.title }}
        </button>
      </nav>

      <div class="setup-content">
        <!-- The section's governing choice: it seeds everything below, so it
             sits above a rule rather than being tinted like a callout. -->
        <div
          v-if="headerSetting"
          ref="headerRow"
          class="section-header"
          @focusout="onHeaderFocusOut"
          @mousedown="onHeaderMouseDown"
        >
          <span class="section-header-label">{{ headerSetting.label }}</span>
          <!-- Save names the preset in the picker's own place, as the Layers
               panel does: Enter or Save confirms; Cancel, Escape or leaving
               the row abandons (RULES.md §6, a name prompt). -->
          <span
            class="section-header-select"
            @input="typedName = ($event.target as HTMLInputElement).value"
          >
            <PropertyValueEditor
              ref="headerEditor"
              :field="headerField"
              :disabled="sectionDisabled(activeSection)"
              @commit="onHeaderCommit"
              @escape="pendingName = null"
            />
          </span>
          <!-- While naming, the pair is Save (confirm) and Cancel. -->
          <template v-if="pendingName !== null">
            <button
              key="confirm"
              class="btn-outline btn-sm header-action"
              type="button"
              :disabled="!typedName.trim()"
              @click="confirmName"
            >
              {{ t('boardSetup.actions.save') }}
            </button>
            <button
              key="cancel"
              class="btn-outline btn-sm header-action"
              type="button"
              @click="pendingName = null"
            >
              {{ t('boardSetup.actions.cancel') }}
            </button>
          </template>
          <!-- Outside naming they stay put and gray out rather than vanish: a
               control that disappears reads as a missing feature. -->
          <template v-else>
            <button
              key="save"
              class="btn-outline btn-sm header-action"
              type="button"
              :disabled="sectionDisabled(activeSection)"
              @click="beginSave"
            >
              {{ t('boardSetup.actions.save') }}
            </button>
            <button
              key="remove"
              class="btn-outline btn-sm header-action"
              type="button"
              :title="isUserPreset ? undefined : t('boardSetup.actions.removeOnlyYours')"
              :disabled="!isUserPreset || sectionDisabled(activeSection)"
              @click="emit('remove-preset', activeSection)"
            >
              {{ t('boardSetup.actions.remove') }}
            </button>
          </template>
        </div>

        <div class="section-panes">
          <!-- Setting cards. Without a preview pane beside them they take the
               full width, which buys a second column of whole categories. -->
          <div class="setup-list" :class="{ 'two-col': !showPreview }">
            <p v-if="props.rulesReadOnly && activeSection !== 'stackup'" class="setup-note">
              {{ t('boardSetup.noProject') }}
            </p>

            <!-- The project's custom rules, read only: a row per rule and constraint,
             an interface preset's rows marked while it is a draft. -->
            <template v-if="section?.customRules">
              <div class="net-class-heading">
                <h3 class="setting-group first">{{ t('boardSetup.sections.customRules') }}</h3>
                <button
                  class="btn-outline btn-sm"
                  type="button"
                  :disabled="sectionDisabled('customRules') || !!ruleEdit"
                  @click="startRuleEdit(null)"
                >
                  {{ t('boardSetup.customRules.add') }}
                </button>
              </div>
              <p v-for="error in section.customRuleErrors ?? []" :key="error" class="setup-note">
                {{ error }}
              </p>
              <p v-if="!section.customRules.length && !ruleEdit" class="setup-note">
                {{ t('boardSetup.customRules.empty') }}
              </p>
              <div v-if="section.customRules.length || ruleEdit" class="layer-table-wrap">
                <table class="layer-table sheet custom-rules-table">
                  <thead>
                    <tr>
                      <th>{{ t('boardSetup.customRules.columns.rule') }}</th>
                      <th>{{ t('boardSetup.customRules.columns.appliesTo') }}</th>
                      <th>{{ t('boardSetup.customRules.columns.constraint') }}</th>
                      <th>{{ t('boardSetup.customRules.columns.limit') }}</th>
                      <th class="col-actions sheet-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(row, i) in section.customRules" :key="row.key">
                      <tr
                        :class="row.pending && `pending-${row.pending}`"
                        :title="row.pending ? t(`boardSetup.pending.${row.pending}`) : undefined"
                      >
                        <td class="sheet-text">
                          <template v-if="firstOfRule(i)">{{ row.rule }}</template>
                        </td>
                        <td class="sheet-text mono">
                          <template v-if="firstOfRule(i)">{{ row.appliesTo || '–' }}</template>
                        </td>
                        <td class="sheet-text mono">{{ row.constraint }}</td>
                        <td class="sheet-text mono num">{{ row.limit }}</td>
                        <td class="col-actions sheet-actions">
                          <span
                            v-if="firstOfRule(i) && !sectionDisabled('customRules') && !row.pending"
                            class="row-actions"
                          >
                            <button
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.customRules.edit')"
                              :aria-label="t('boardSetup.customRules.edit')"
                              :disabled="!!ruleEdit"
                              @click.stop="startRuleEdit(row.rule)"
                            >
                              <Icon name="pencil" />
                            </button>
                            <button
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.customRules.remove')"
                              :aria-label="t('boardSetup.customRules.remove')"
                              :disabled="!!ruleEdit"
                              @click.stop="removeRule(row.rule)"
                            >
                              <Icon name="minus" />
                            </button>
                          </span>
                        </td>
                      </tr>
                      <tr v-if="ruleEdit && ruleEdit.name === row.rule && lastOfRule(i)">
                        <td colspan="5" class="rule-editor-cell">
                          <!-- The rule's own text, as the file holds it: KiCad's syntax. -->
                          <textarea
                            id="custom-rule-text"
                            v-model="ruleEdit.text"
                            class="field-sm mono rule-editor"
                            rows="6"
                            spellcheck="false"
                          ></textarea>
                          <p v-for="error in ruleEdit.errors" :key="error" class="rule-error">
                            {{ error === 'one-rule' ? t('boardSetup.customRules.oneRule') : error }}
                          </p>
                          <span class="rule-editor-actions">
                            <button
                              class="btn-outline btn-sm"
                              type="button"
                              @click="ruleEdit = null"
                            >
                              {{ t('common.cancel') }}
                            </button>
                            <button class="btn-cta btn-sm" type="button" @click="saveRule">
                              {{ t('boardSetup.customRules.save') }}
                            </button>
                          </span>
                        </td>
                      </tr>
                    </template>
                    <tr v-if="ruleEdit && ruleEdit.name === null">
                      <td colspan="5" class="rule-editor-cell">
                        <textarea
                          id="custom-rule-new"
                          v-model="ruleEdit.text"
                          class="field-sm mono rule-editor"
                          rows="6"
                          spellcheck="false"
                        ></textarea>
                        <p v-for="error in ruleEdit.errors" :key="error" class="rule-error">
                          {{ error === 'one-rule' ? t('boardSetup.customRules.oneRule') : error }}
                        </p>
                        <span class="rule-editor-actions">
                          <button class="btn-outline btn-sm" type="button" @click="ruleEdit = null">
                            {{ t('common.cancel') }}
                          </button>
                          <button class="btn-cta btn-sm" type="button" @click="saveRule">
                            {{ t('boardSetup.customRules.addSave') }}
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>

            <RuleSeverityTable
              v-if="section?.rules"
              :catalog="DRC_CATALOG"
              :group-label="(group) => t(`ruleChecks.drcGroups.${group}`)"
              :rule-title="drcRuleTitle"
              :severities="props.severities"
              :counts="props.ruleCounts"
              :disabled="sectionDisabled('rules')"
              @set="(key, severity) => emit('set-severity', key, severity)"
            />

            <ExclusionList
              v-if="section?.exclusions"
              :exclusions="props.exclusions"
              :rule-title="drcRuleTitle"
              :results="props.checkResults"
            />

            <div class="setup-columns">
              <div v-for="(column, ci) in cardColumns" :key="ci" class="setup-column">
                <template v-for="group in column" :key="group.key">
                  <h3 v-if="group.label" class="setting-group">{{ group.label }}</h3>
                  <svg
                    v-if="legendOf(group.key)"
                    class="setting-glyph tuning-legend"
                    viewBox="0 0 160 56"
                    :style="glyphPalette"
                    aria-hidden="true"
                  >
                    <path
                      v-for="(part, i) in legendOf(group.key)!.parts"
                      :key="i"
                      :d="part.d"
                      :class="[`role-${part.role}`, { filled: part.fill, wide: part.wide }]"
                    />
                    <text
                      v-for="label in legendOf(group.key)!.labels"
                      :key="label.text"
                      :x="label.x"
                      :y="label.y"
                      class="legend-label"
                    >
                      {{ label.text }}
                    </text>
                  </svg>
                  <div
                    v-for="card in group.cards"
                    :key="card.row.key"
                    class="setting-card"
                    role="button"
                    tabindex="-1"
                    @click="onCardClick($event, card.index)"
                  >
                    <svg
                      class="setting-glyph"
                      viewBox="0 0 32 32"
                      :style="glyphPalette"
                      aria-hidden="true"
                    >
                      <path
                        v-for="(part, i) in glyph(card.row.glyph)"
                        :key="i"
                        :d="part.d"
                        :class="[`role-${part.role}`, { filled: part.fill, wide: part.wide }]"
                        :style="part.weight ? { strokeWidth: part.weight } : undefined"
                      />
                    </svg>
                    <span class="setting-text">
                      <span class="setting-label">{{ card.row.label }}</span>
                      <span v-if="card.row.blurb" class="setting-blurb">{{ card.row.blurb }}</span>
                    </span>
                    <span class="setting-value">
                      <PropertyValueEditor
                        :ref="setCardEditorRef(card.index)"
                        :field="{
                          key: card.row.key,
                          editor: card.row.editor,
                          value: card.row.value
                        }"
                        :disabled="sectionDisabled(card.row.section)"
                        @commit="(v) => emit('edit', card.row.section, card.row.key, v)"
                      />
                    </span>
                  </div>
                </template>
              </div>
            </div>

            <!-- The layer table and its drawing share a row: the drawing centered
             on the table beside it, or under it once the pane is too narrow for
             both (`previewWrapped`). -->
            <div v-if="section?.layers" ref="stackupRow" class="stackup-row">
              <div ref="stackupTable" class="stackup-table">
                <!-- Layer table (stackup only). Inline editing, like KiCad/Altium: the
             layers ARE the model, so a preset seeds them and edits address one
             row — no separate detail pane. -->
                <div class="layer-table-wrap">
                  <table class="layer-table sheet">
                    <thead>
                      <tr>
                        <th class="col-layer">{{ t('boardSetup.columns.layer') }}</th>
                        <th v-for="col in STACKUP_COLUMNS" :key="col" :class="`col-${col}`">
                          {{ t(`boardSetup.columns.${col}`) }}
                          <span
                            v-if="columnHint(col)"
                            class="col-hint"
                            :title="columnHint(col)"
                            :aria-label="columnHint(col)"
                          >
                            <Icon name="info" />
                          </span>
                        </th>
                        <th class="col-actions sheet-actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="row in section.layers"
                        :key="row.index"
                        :data-row="`layer:${row.index}`"
                        :class="{ linked: hoveredLayer === row.index }"
                        :style="{
                          backgroundColor: `color-mix(in srgb, ${row.swatch} 14%, transparent)`
                        }"
                        @mouseenter="hoveredLayer = row.index"
                        @mouseleave="hoveredLayer = null"
                      >
                        <th class="col-layer" scope="row">
                          <span class="layer-name">
                            <span
                              class="layer-swatch"
                              :style="{ backgroundColor: row.swatch }"
                            ></span>
                            {{ row.label }}
                          </span>
                        </th>
                        <td
                          v-for="col in STACKUP_COLUMNS"
                          :key="col"
                          :class="[
                            `col-${col}`,
                            { num: NUMERIC_STACKUP.has(col), 'sheet-na': !row.cells[col] }
                          ]"
                        >
                          <PropertyValueEditor
                            v-if="row.cells[col]"
                            :field="row.cells[col]!"
                            :disabled="sectionDisabled('stackup')"
                            @commit="(v) => emit('edit-layer', row.index, col, v)"
                          />
                          <span v-else aria-hidden="true">–</span>
                        </td>
                        <td class="col-actions sheet-actions">
                          <button
                            v-if="row.kind === 'dielectric' && !sectionDisabled('stackup')"
                            class="row-action"
                            type="button"
                            :title="t('boardSetup.table.removeLayer')"
                            @click.stop="emit('remove-layer', row.index)"
                          >
                            <Icon name="minus" />
                          </button>
                          <button
                            v-if="row.kind === 'copper' && !sectionDisabled('stackup')"
                            class="row-action"
                            type="button"
                            :title="t('boardSetup.table.addDielectric')"
                            @click.stop="
                              (addedRow.expect(`layer:${row.index + 1}`),
                              emit('add-dielectric', row.index))
                            "
                          >
                            <Icon name="plus" />
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <dl class="layer-totals">
                  <div class="total-stat">
                    <dt>{{ t('boardSetup.table.copper') }}</dt>
                    <dd>{{ fmt(totals.copper) }}</dd>
                  </div>
                  <div class="total-stat">
                    <dt>{{ t('boardSetup.table.dielectric') }}</dt>
                    <dd>{{ fmt(totals.dielectric) }}</dd>
                  </div>
                  <div class="total-stat emphasis">
                    <dt>{{ t('boardSetup.table.total') }}</dt>
                    <dd>{{ fmt(totals.total) }}</dd>
                  </div>
                </dl>
              </div>
              <!-- The cross-section: the one preview that draws something no
             control states. -->
              <div
                ref="stackupPreview"
                class="setup-preview"
                :style="previewWrapped ? { marginLeft: `${wrappedInset}px` } : undefined"
              >
                <StackupPreview3D
                  class="section-3d"
                  :rows="section?.layers ?? []"
                  :highlight="hoveredLayer"
                  @hover="(index) => (hoveredLayer = index)"
                />
                <p class="preview-caption">{{ previewCaption }}</p>
              </div>
            </div>

            <!-- Tuning profiles (KiCad 10's): a block per profile, its own
             fields above the table of its signal layers. A width or delay is
             what was typed or what Solve wrote; nothing recomputes it. -->
            <template v-if="section?.tuningProfiles">
              <div class="net-class-heading">
                <h3 class="setting-group first">{{ t('boardSetup.sections.tuningProfiles') }}</h3>
                <span class="heading-actions">
                  <button
                    class="btn-outline btn-sm"
                    type="button"
                    :disabled="sectionDisabled('tuningProfiles')"
                    @click="(addedRow.expect(), emit('add-tuning-profile'))"
                  >
                    {{ t('boardSetup.tuningProfiles.add') }}
                  </button>
                </span>
              </div>
              <p v-if="!section.tuningProfiles.length" class="setup-note">
                {{ t('boardSetup.tuningProfiles.empty') }}
              </p>
              <section
                v-for="profile in section.tuningProfiles"
                :key="profile.index"
                class="profile-block"
                :class="profile.pending && `pending-${profile.pending}`"
                :data-row="`profile:${profile.index}`"
              >
                <p v-if="profile.pending" class="pending-note">
                  {{ t(`boardSetup.pending.${profile.pending}`) }}
                </p>
                <div class="profile-fields">
                  <label
                    v-for="field in [
                      'name',
                      'differential',
                      'targetImpedance',
                      'timeDomain',
                      'viaDelay'
                    ] as const"
                    :key="field"
                    class="profile-field"
                    :class="`field-${field}`"
                  >
                    <span class="profile-field-label">{{ profile.fields[field].label }}</span>
                    <PropertyValueEditor
                      :field="profile.fields[field]"
                      :disabled="sectionDisabled('tuningProfiles')"
                      @commit="(v) => emit('edit-tuning-profile', profile.index, field, v)"
                    />
                  </label>
                  <span class="profile-actions">
                    <button
                      class="btn-outline btn-sm"
                      type="button"
                      :disabled="sectionDisabled('tuningProfiles') || !profile.layers.length"
                      :title="t('boardSetup.tuningProfiles.solveHint')"
                      @click="emit('solve-profile', profile.index)"
                    >
                      {{ t('boardSetup.tuningProfiles.solveAll') }}
                    </button>
                    <button
                      v-if="!sectionDisabled('tuningProfiles')"
                      class="row-action"
                      type="button"
                      :title="t('boardSetup.tuningProfiles.remove')"
                      @click.stop="emit('remove-tuning-profile', profile.index)"
                    >
                      <Icon name="minus" />
                    </button>
                  </span>
                </div>
                <p v-if="profile.classes.length" class="profile-used">
                  <span class="profile-field-label">{{
                    t('boardSetup.tuningProfiles.usedBy')
                  }}</span>
                  <NetClassTag v-for="name in profile.classes" :key="name" :name="name" />
                </p>
                <div class="layer-table-wrap">
                  <table class="layer-table sheet profile-table">
                    <thead>
                      <tr>
                        <th
                          v-for="col in profileColumns(profile.differential)"
                          :key="col"
                          :class="`col-${col}`"
                        >
                          {{ t(`boardSetup.tuningProfiles.columns.${col}`) }}
                        </th>
                        <th class="col-readout">{{ t('boardSetup.tuningProfiles.readout') }}</th>
                        <th class="col-actions sheet-actions">
                          <button
                            class="btn-outline btn-icon-sm"
                            type="button"
                            :disabled="sectionDisabled('tuningProfiles')"
                            :title="t('boardSetup.tuningProfiles.addLayer')"
                            :aria-label="t('boardSetup.tuningProfiles.addLayer')"
                            @click="(addedRow.expect(), emit('add-profile-layer', profile.index))"
                          >
                            <Icon name="plus" />
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="row in profile.layers"
                        :key="row.index"
                        :data-row="`profile:${profile.index}:${row.index}`"
                      >
                        <td
                          v-for="col in profileColumns(profile.differential)"
                          :key="col"
                          :class="[
                            `col-${col}`,
                            { num: col === 'width' || col === 'gap' || col === 'delay' }
                          ]"
                        >
                          <PropertyValueEditor
                            :field="row.cells[col]"
                            :disabled="sectionDisabled('tuningProfiles')"
                            @commit="
                              (v) => emit('edit-profile-layer', profile.index, row.index, col, v)
                            "
                          />
                        </td>
                        <td
                          class="col-readout num sheet-text"
                          :title="row.readout && 'error' in row.readout ? row.readout.error : ''"
                        >
                          <Icon
                            v-if="row.readout && 'error' in row.readout"
                            name="status-error"
                            class="count-icon"
                          />
                          <template v-else>{{ readoutText(row.readout) }}</template>
                        </td>
                        <td class="col-actions sheet-actions">
                          <span v-if="!sectionDisabled('tuningProfiles')" class="row-actions">
                            <button
                              class="btn-outline btn-sm row-solve"
                              type="button"
                              :title="t('boardSetup.tuningProfiles.solveHint')"
                              @click.stop="emit('solve-profile-layer', profile.index, row.index)"
                            >
                              {{ t('boardSetup.tuningProfiles.solve') }}
                            </button>
                            <button
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.tuningProfiles.removeLayer')"
                              @click.stop="emit('remove-profile-layer', profile.index, row.index)"
                            >
                              <Icon name="minus" />
                            </button>
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </template>

            <!-- Net classes. A table for the same reason KiCad uses one: you
             read these across classes, comparing a width against a width, which
             columns do and stacked cards do not. -->
            <template v-if="section?.netClasses">
              <div class="net-class-heading">
                <h3 class="setting-group first">{{ t('boardSetup.netClasses.title') }}</h3>
                <!-- KiCad's Import colors from schematic: a one-time copy, not a link. -->
                <button
                  v-if="props.classColumns !== 'schematic'"
                  class="btn-outline btn-sm"
                  type="button"
                  :disabled="sectionDisabled('netClasses')"
                  @click="emit('import-class-colors')"
                >
                  {{ t('boardSetup.netClasses.importColors') }}
                </button>
              </div>

              <div class="layer-table-wrap">
                <table class="layer-table sheet net-class-table">
                  <thead>
                    <tr>
                      <th class="col-name">{{ t('boardSetup.netClassColumns.name') }}</th>
                      <template v-if="props.classColumns === 'schematic'">
                        <th v-for="col in SCHEMATIC_CLASS_COLUMNS" :key="col" :class="`col-${col}`">
                          {{ t(`boardSetup.netClassColumns.${col}`) }}
                        </th>
                      </template>
                      <template v-else>
                        <th v-for="col in NET_CLASS_COLUMNS" :key="col" :class="`col-${col}`">
                          {{ t(`boardSetup.netClassColumns.${col}`) }}
                        </th>
                        <th class="col-pcbColor">{{ t('boardSetup.netClassColumns.pcbColor') }}</th>
                        <th class="col-tuningProfile">
                          {{ t('boardSetup.netClassColumns.tuningProfile') }}
                        </th>
                      </template>
                      <th class="col-actions sheet-actions">
                        <button
                          class="btn-outline btn-icon-sm"
                          type="button"
                          :disabled="sectionDisabled('netClasses')"
                          :title="t('boardSetup.netClasses.add')"
                          :aria-label="t('boardSetup.netClasses.add')"
                          @click="(addedRow.expect(), emit('add-net-class'))"
                        >
                          <Icon name="plus" />
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in section.netClasses"
                      :key="row.index"
                      :data-row="`class:${row.index}`"
                      :class="row.pending && `pending-${row.pending}`"
                      :title="row.pending ? t(`boardSetup.pending.${row.pending}`) : undefined"
                    >
                      <td class="col-name">
                        <!-- The name sizes the column: a hidden copy beside the
                         input, which an input cannot do itself. -->
                        <div class="name-fit">
                          <span class="name-sizer" aria-hidden="true">{{ row.name }}</span>
                          <PropertyValueEditor
                            :field="row.nameCell"
                            :disabled="sectionDisabled('netClasses') || row.isDefault"
                            @commit="(v) => emit('edit-net-class', row.index, 'name', v)"
                          />
                        </div>
                      </td>
                      <template v-if="props.classColumns === 'schematic'">
                        <td
                          v-for="col in SCHEMATIC_CLASS_COLUMNS"
                          :key="col"
                          :class="[
                            `col-${col}`,
                            { num: col === 'wireWidth' || col === 'busWidth' }
                          ]"
                        >
                          <PropertyValueEditor
                            :field="row.schematicCells[col]"
                            :disabled="sectionDisabled('netClasses')"
                            @commit="(v) => emit('edit-net-class', row.index, col, v)"
                          />
                        </td>
                      </template>
                      <template v-else>
                        <td v-for="col in NET_CLASS_COLUMNS" :key="col" :class="`col-${col} num`">
                          <PropertyValueEditor
                            :field="row.cells[col]"
                            :disabled="sectionDisabled('netClasses')"
                            @commit="(v) => emit('edit-net-class', row.index, col, v)"
                          />
                        </td>
                        <td class="col-pcbColor">
                          <PropertyValueEditor
                            :field="row.colorCell"
                            :disabled="sectionDisabled('netClasses') || row.isDefault"
                            @commit="(v) => emit('edit-net-class', row.index, 'pcbColor', v)"
                          />
                        </td>
                        <td class="col-tuningProfile">
                          <PropertyValueEditor
                            :field="row.profileCell"
                            :disabled="sectionDisabled('netClasses')"
                            @commit="(v) => emit('edit-net-class', row.index, 'tuningProfile', v)"
                          />
                        </td>
                      </template>
                      <td class="col-actions sheet-actions">
                        <!-- Default is what every unassigned net falls back to,
                         so it is the one row that cannot go. -->
                        <button
                          v-if="!row.isDefault && !sectionDisabled('netClasses')"
                          class="row-action"
                          type="button"
                          :title="t('boardSetup.netClasses.remove')"
                          @click.stop="emit('remove-net-class', row.index)"
                        >
                          <Icon name="minus" />
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Set up a class as a standard interface: under the classes it sets
               up, saying what it supports and what it does; its draft opens here. -->
              <template v-if="props.classColumns !== 'schematic'">
                <slot v-if="$slots.presetDraft" name="presetDraft" />
                <div v-else class="interface-entry">
                  <button
                    class="btn-outline btn-md interface-button"
                    type="button"
                    :disabled="
                      sectionDisabled('netClasses') ||
                      !section.netClasses?.some((row) => !row.isDefault)
                    "
                    @click="emit('start-interface-preset')"
                  >
                    <Icon name="tool-route-pair" class="interface-icon" />
                    {{ t('boardSetup.netClasses.fromInterface') }}
                  </button>
                  <span class="interface-blurb">
                    <span>{{ t('boardSetup.netClasses.interfaceSupports') }}</span>
                    <span class="interface-adds">{{
                      section.netClasses?.some((row) => !row.isDefault)
                        ? t('boardSetup.netClasses.interfaceAdds')
                        : t('boardSetup.interfacePreset.noClasses')
                    }}</span>
                  </span>
                </div>
              </template>

              <!-- Assignment patterns: what puts a net INTO a class. Without
               these every net is Default and the classes above do nothing. -->
              <h3 class="setting-group">{{ t('boardSetup.patterns.title') }}</h3>
              <!-- The syntax by example: the pattern, then what kind it is. -->
              <dl class="pattern-syntax">
                <div>
                  <dt><code>/USB_*</code></dt>
                  <dd>{{ t('boardSetup.patterns.syntax.any') }}</dd>
                </div>
                <div>
                  <dt><code>CLK_?</code></dt>
                  <dd>{{ t('boardSetup.patterns.syntax.one') }}</dd>
                </div>
                <div>
                  <dt><code>^/ddr/DQ[0-9]+$</code></dt>
                  <dd>{{ t('boardSetup.patterns.syntax.regex') }}</dd>
                </div>
              </dl>

              <!-- The table, and beside it the nets the selected row reaches. -->
              <div class="pattern-row">
                <div class="pattern-block">
                  <div class="layer-table-wrap">
                    <table class="layer-table sheet pattern-table">
                      <thead>
                        <tr>
                          <th class="col-pattern">{{ t('boardSetup.patternColumns.pattern') }}</th>
                          <th class="col-netclass">
                            {{ t('boardSetup.patternColumns.netClass') }}
                          </th>
                          <th v-if="coverage" class="col-count">
                            {{ t('boardSetup.patternColumns.nets') }}
                          </th>
                          <th class="col-actions sheet-actions">
                            <button
                              class="btn-outline btn-icon-sm"
                              type="button"
                              :disabled="sectionDisabled('netClasses')"
                              :title="t('boardSetup.patterns.add')"
                              :aria-label="t('boardSetup.patterns.add')"
                              @click="(addedRow.expect(), emit('add-pattern'))"
                            >
                              <Icon name="plus" />
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <!-- What no row takes: the class every other net ends in. -->
                        <tr
                          v-if="coverage"
                          class="default-row"
                          :class="{ linked: selectedRow === 'default' }"
                          @click="selectedRow = 'default'"
                        >
                          <td class="col-pattern sheet-na"><span aria-hidden="true">–</span></td>
                          <td class="col-netclass sheet-text">
                            <NetClassTag :name="DEFAULT_CLASS_NAME" />
                          </td>
                          <td class="col-count num sheet-text">{{ coverage.unassigned.length }}</td>
                          <td class="col-actions sheet-actions"></td>
                        </tr>
                        <tr
                          v-for="row in patternRows"
                          :key="row.index"
                          :data-row="`pattern:${row.index}`"
                          :class="[
                            {
                              dangling: row.dangling,
                              invalid: coverage?.patterns[row.index]?.invalid,
                              linked: selectedRow === row.index
                            },
                            row.pending && `pending-${row.pending}`
                          ]"
                          @focusin="selectedRow = row.index"
                          @click="selectedRow = row.index"
                        >
                          <td
                            class="col-pattern"
                            @input="onPatternInput(row.index, $event)"
                            @focusout="onPatternBlur"
                          >
                            <PropertyValueEditor
                              :field="row.patternCell"
                              :disabled="sectionDisabled('netClasses')"
                              @commit="(v) => emit('edit-pattern', row.index, 'pattern', v)"
                            />
                          </td>
                          <td class="col-netclass">
                            <PropertyValueEditor
                              :field="row.classCell"
                              :disabled="sectionDisabled('netClasses')"
                              @commit="(v) => emit('edit-pattern', row.index, 'netClass', v)"
                            />
                          </td>
                          <td
                            v-if="coverage"
                            class="col-count num sheet-text"
                            :class="{
                              zero: !coverage.patterns[row.index]?.count,
                              overlap: !!coverage.patterns[row.index]?.overlap
                            }"
                            :title="countTitle(row.index)"
                          >
                            <Icon
                              v-if="coverage.patterns[row.index]?.invalid"
                              name="status-error"
                              class="count-icon"
                            />
                            <template v-else>{{
                              coverage.patterns[row.index]?.count ?? 0
                            }}</template>
                          </td>
                          <td class="col-actions sheet-actions">
                            <button
                              v-if="!sectionDisabled('netClasses')"
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.patterns.remove')"
                              @click.stop="removePattern(row.index)"
                            >
                              <Icon name="minus" />
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <!-- Sized by the table beside it, never by its own nets: they scroll. -->
                <section v-if="coverage && coverage.nets.length" class="net-pane">
                  <header class="net-pane-head">{{ t('boardSetup.patterns.matching') }}</header>
                  <div class="net-list">
                    <div v-for="group in netGroups.groups" :key="group.path" class="net-group">
                      <span v-if="group.path" class="net-path">{{ group.path }}</span>
                      <template
                        v-for="item in group.items"
                        :key="Array.isArray(item) ? item.join() : item"
                      >
                        <!-- A differential pair, as KiCad's naming makes one: its halves together. -->
                        <DiffPairGroup
                          v-if="Array.isArray(item)"
                          :title="t('boardSetup.patterns.pair')"
                        >
                          <span
                            v-for="net in item"
                            :key="net"
                            class="net-chip"
                            :class="{ multi: (coverage.classesOf.get(net)?.length ?? 0) > 1 }"
                            :title="netTitle(net)"
                          >
                            <Icon
                              v-if="coverage.fixed.has(net)"
                              name="pin"
                              class="net-fixed"
                            /><span class="net-name">{{ splitNetName(net).leaf }}</span></span
                          >
                        </DiffPairGroup>
                        <span
                          v-else
                          class="net-chip"
                          :class="{ multi: (coverage.classesOf.get(item)?.length ?? 0) > 1 }"
                          :title="netTitle(item)"
                        >
                          <Icon v-if="coverage.fixed.has(item)" name="pin" class="net-fixed" />{{
                            splitNetName(item).leaf
                          }}</span
                        >
                      </template>
                    </div>
                    <span v-if="netGroups.hidden" class="net-more">+{{ netGroups.hidden }}</span>
                  </div>
                </section>
              </div>

              <!-- The route tool's sizes beyond the classes' (router-behavior.md
               S4): offered in its width and via lists, never a rule. -->
              <h3 class="setting-group">{{ t('boardSetup.extraSizes.title') }}</h3>
              <!-- Widths and vias side by side; wrapped, one under the other. -->
              <div class="extra-size-row">
                <div class="extra-size-block">
                  <div class="layer-table-wrap">
                    <table class="layer-table sheet extra-size-table">
                      <thead>
                        <tr>
                          <th>{{ t('boardSetup.extraSizes.width') }}</th>
                          <th class="col-actions sheet-actions">
                            <button
                              class="btn-outline btn-icon-sm"
                              type="button"
                              :disabled="sectionDisabled('netClasses')"
                              :title="t('boardSetup.extraSizes.addTrack')"
                              :aria-label="t('boardSetup.extraSizes.addTrack')"
                              @click="(addedRow.expect(), emit('add-extra-size', 'track'))"
                            >
                              <Icon name="plus" />
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="row in section.extraTracks"
                          :key="row.index"
                          :data-row="`track:${row.index}`"
                        >
                          <td v-for="cell in row.cells" :key="cell.key" class="num">
                            <PropertyValueEditor
                              :field="cell"
                              :disabled="sectionDisabled('netClasses')"
                              @commit="
                                (v) =>
                                  emit(
                                    'edit-extra-size',
                                    'track',
                                    row.index,
                                    cell.key as ExtraSizeField,
                                    v
                                  )
                              "
                            />
                          </td>
                          <td class="col-actions sheet-actions">
                            <button
                              v-if="!sectionDisabled('netClasses')"
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.extraSizes.remove')"
                              @click.stop="emit('remove-extra-size', 'track', row.index)"
                            >
                              <Icon name="minus" />
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div class="extra-size-block">
                  <div class="layer-table-wrap">
                    <table class="layer-table sheet extra-size-table">
                      <thead>
                        <tr>
                          <th>{{ t('boardSetup.extraSizes.diameter') }}</th>
                          <th>{{ t('boardSetup.extraSizes.drill') }}</th>
                          <th class="col-actions sheet-actions">
                            <button
                              class="btn-outline btn-icon-sm"
                              type="button"
                              :disabled="sectionDisabled('netClasses')"
                              :title="t('boardSetup.extraSizes.addVia')"
                              :aria-label="t('boardSetup.extraSizes.addVia')"
                              @click="(addedRow.expect(), emit('add-extra-size', 'via'))"
                            >
                              <Icon name="plus" />
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="row in section.extraVias"
                          :key="row.index"
                          :data-row="`via:${row.index}`"
                        >
                          <td v-for="cell in row.cells" :key="cell.key" class="num">
                            <PropertyValueEditor
                              :field="cell"
                              :disabled="sectionDisabled('netClasses')"
                              @commit="
                                (v) =>
                                  emit(
                                    'edit-extra-size',
                                    'via',
                                    row.index,
                                    cell.key as ExtraSizeField,
                                    v
                                  )
                              "
                            />
                          </td>
                          <td class="col-actions sheet-actions">
                            <button
                              v-if="!sectionDisabled('netClasses')"
                              class="row-action"
                              type="button"
                              :title="t('boardSetup.extraSizes.remove')"
                              @click.stop="emit('remove-extra-size', 'via', row.index)"
                            >
                              <Icon name="minus" />
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <template v-if="props.classColumns !== 'schematic' && copperForCurrent.length">
                <h3 class="setting-group">{{ t('boardSetup.currentWidth.title') }}</h3>
                <CurrentWidthCalculator :copper="copperForCurrent" />
              </template>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* An interface setup's draft profile, tinted as its draft rows are (main.css, .sheet). */
.profile-block.pending-added {
  background-color: var(--vscode-success-subtle);
}

.profile-block.pending-edited {
  background-color: var(--vscode-warning-subtle);
}

.profile-block.pending-added,
.profile-block.pending-edited {
  padding: 10px;
  border-radius: 6px;
}

.pending-note {
  margin: 0;
  color: var(--vscode-success);
  font-size: var(--text-caption);
}

.pending-edited .pending-note {
  color: var(--vscode-warning);
}

.custom-rules-table {
  width: 100%;
}

.rule-editor-cell {
  padding: 8px;
}

.rule-editor {
  display: block;
  width: 100%;
  resize: vertical;
}

.rule-error {
  margin: 6px 0 0;
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}

.rule-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.interface-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  margin-top: 8px;
}

.interface-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.interface-icon {
  width: 18px;
  height: 18px;
}

.interface-blurb {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.interface-adds {
  color: var(--vscode-text-muted);
}

.heading-actions {
  display: flex;
  gap: 8px;
}

/* A tuning profile: its fields in a row over its layers' table. */
.profile-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}

.profile-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 16px;
}

.profile-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 104px;
}

.profile-field.field-name {
  width: 176px;
}

.profile-field-label {
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-caption);
}

.profile-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.profile-used {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
}

.profile-table {
  width: auto;
}

.profile-table :where(th, td).col-layer,
.profile-table :where(th, td).col-topReference,
.profile-table :where(th, td).col-bottomReference {
  width: 120px;
}

.profile-table :where(th, td):is(.col-width, .col-gap, .col-delay, .col-readout) {
  width: 96px;
}

.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.net-class-table .col-tuningProfile {
  width: 128px;
}

.net-class-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

/* Type floor is 11px (RULES.md §6); this surface has room, so its primary text
   sits at 13px and only the subtitle sits on the floor. */
.board-setup {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  /* Match the editor-pane background used by Settings and Manufacture. */
  background-color: var(--vscode-bg-editor);
}

.setup-title-bar {
  flex: 0 0 auto;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

.setup-title {
  margin: 0;
  color: var(--vscode-text-light, #e6f0ea);
  font-size: 16px;
  font-weight: 600;
}

.setup-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* --- Section nav ---------------------------------------------------------- */
/* Left nav is the shared `.nav-list` / `.nav-item` (DESIGN.md §3, main.css). */

/* --- Setting cards -------------------------------------------------------- */
.setup-content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px 28px;
}

/*
 * The table and the cross-section share a row under the header. They wrap
 * rather than compress: the table has real minimum column widths and the
 * diagram is fixed at 1:1, so squeezing either is worse than stacking them.
 */
.section-panes {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 24px;
}

.setup-list {
  flex: 1 1 520px;
  min-width: 0;
}

/* Beside the drawing, the list is as wide as its table, so the drawing sits
   next to the table rather than past the empty width of a stretched column. */
.setup-list:not(.two-col) {
  flex: 0 1 auto;
}

/* Two columns of WHOLE categories for a section with no preview pane beside it
   — eighteen cards in one column is a scroll, and each card is a label and a
   small field, so half the width is plenty for one.

   The split is by category, not by card: a category's settings read straight
   down, and a run broken across the boundary would have you reading up and
   over mid-category. Which categories land where is decided in script; this
   only lays the two runs out.

   Flex-wrap does the responsive half with no breakpoint to keep in sync: the
   second column only sits beside the first while there is room for two whole
   ones, and otherwise wraps under it, which reads as a single column. The
   max-width stops a wide window from stretching two columns to absurd widths —
   this is a settings pane, not a dashboard. */
.setup-columns {
  container-type: inline-size;
  display: flex;
  flex-wrap: wrap;
  max-width: 900px;
}

.setup-column {
  flex: 1 1 380px;
  min-width: 0;
}

/* The separator, and the breathing room either side of it, exist only while
   the columns are actually side by side. Keyed to the container's own width so
   a wrapped second column never draws a rule down its left edge. The threshold
   sits above 2 × the flex basis, so the rule cannot appear before the wrap
   resolves. Both columns are inset equally, so their content stays equal width
   rather than the second losing the padding to the first. */
@container (min-width: 800px) {
  .setup-column:first-child {
    padding-right: 32px;
  }

  .setup-column + .setup-column {
    padding-left: 32px;
    border-left: 1px solid var(--vscode-border, #24302b);
  }
}

/* The single-column cap keeps a value from drifting to the right edge of a wide
   pane; a column already bounds it, so the cap would only shrink it further. */
.setup-list.two-col .setting-card {
  max-width: none;
}

/* Governs the section, so it reads as a heading with a control — not a tinted
   callout. The rule under it is what says "this drives everything below". */
.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

.section-header-label {
  color: var(--vscode-text-muted, #748780);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.section-header-select {
  flex: 0 1 auto;
  min-width: 0;
}

/* As wide as its longest name, so a vendor's designator is never cut off;
   only a pane narrower than that shrinks it. */
.section-header-select :deep(.select-with-caret) {
  width: auto;
  max-width: 100%;
}

.section-header-select :deep(.dense-select) {
  width: auto;
  max-width: 100%;
  min-width: 220px;
  height: 28px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  background-color: var(--vscode-input-bg);
  color: var(--vscode-text-light, #ffffff);
  padding: 0 8px;
  font-size: 13px;
}

.section-header-select :deep(.dense-select:focus) {
  outline: none;
  border-color: var(--vscode-accent, #cca250);
}

/* Save / Manage are framework `btn-outline btn-sm` (DESIGN.md §3); this sets
   only their layout in the header row. */
.header-action {
  flex: 0 0 auto;
}

.setup-note {
  margin: 0 0 14px;
  padding: 9px 11px;
  border-left: 2px solid var(--vscode-accent, #cca250);
  color: var(--vscode-text-muted, #748780);
  font-size: 12px;
  line-height: 1.5;
}

/* The app's standing section-heading treatment (PropertyTable, LayersPanel):
   accent, 11px, upper-case. Sits tight to its run and loose from the one above,
   so the grouping is legible without a rule per group. */
.setting-group {
  max-width: 580px;
  margin: 20px 0 4px;
  padding: 0 12px;
  color: var(--vscode-accent, #cca250);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* Only the first heading of a CARD column sits tight to the top — it opens the
   column. A heading between two grids (Assignments) keeps its full lead-in, or
   it collides with the button ending the grid above. */
.setup-column .setting-group:first-of-type,
.setting-group.first {
  margin-top: 4px;
}

.layer-table-wrap + .setting-group,
.pattern-row + .setting-group {
  margin-top: 26px;
}

.setting-card {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  /* Cap the row so the value sits beside its label instead of drifting to the
     right edge of a now-wide pane — while still lining up column-wise. */
  max-width: 580px;
  padding: 11px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.setting-card:hover {
  background-color: var(--vscode-bg-hover, rgba(255, 255, 255, 0.04));
}

.setting-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.setting-label {
  color: var(--vscode-text, #d6e2dc);
  font-size: 13px;
}

/* The 11px type floor — nothing in the app goes below this (RULES.md §6). */
.setting-blurb {
  color: var(--vscode-text-muted, #748780);
  font-size: 11px;
  line-height: 1.45;
}

/* The value editor sits in its own bordered field here — unlike the property
   table, where the input IS the cell. */
.setting-value {
  flex: 0 0 auto;
  width: 124px;
}

.setting-value :deep(.dense-input),
.setting-value :deep(.dense-select) {
  width: 100%;
  height: 30px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  background-color: var(--vscode-input-bg);
  color: var(--vscode-text-light, #ffffff);
  padding: 0 8px;
  font-size: 13px;
}

.setting-value :deep(.dense-input:focus),
.setting-value :deep(.dense-select:focus) {
  outline: none;
  border-color: var(--vscode-accent, #cca250);
}

.setting-value :deep(.dense-toggle-btn) {
  font-size: 12px;
  padding: 4px 12px;
}

/* --- Glyphs --------------------------------------------------------------- */
/* Board Setup's diagram glyphs (lib/boardSetupGlyphs.ts): a 32-unit tile shown
   at 40px, each part colored by what it is. Material colors come from
   GLYPH_PALETTE on the element; a hole (the page, seen through the board) and
   the measured value come from the theme. */
.setting-glyph {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
}

.setting-glyph path {
  fill: none;
  /* One device pixel at 40px. */
  stroke-width: 0.8;
  stroke-linecap: square;
}

.setting-glyph path.filled {
  stroke: none;
}

.role-copper.filled {
  fill: var(--g-copper);
}
.setting-glyph .role-copper.wide {
  stroke: var(--g-copper);
  stroke-width: 3;
  stroke-linecap: round;
}
.role-guide {
  stroke: var(--vscode-text-muted);
  stroke-dasharray: 2 1.5;
}
.role-hole.filled {
  fill: var(--vscode-bg-editor);
}
.role-mask.filled {
  fill: var(--g-mask);
}
.role-dielectric.filled {
  fill: var(--g-dielectric);
}
/* Ink is plotted by a round pen: round ends and joins, over the square default. */
.setting-glyph .role-silk {
  stroke: var(--g-silk);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.role-silk.filled {
  fill: var(--g-silk);
}
.role-finish.filled {
  fill: var(--g-finish);
}
.role-dim {
  stroke: var(--vscode-text-light);
}

/* The open dropdown is drawn by the browser and inherits only what the option
   itself sets, so the current theme needs to be stated on <option> too. */
:deep(.dense-select option) {
  background-color: var(--vscode-input-bg);
  color: var(--vscode-text-light, #ffffff);
}

/* A tuner's legend under its heading: the meander it lays, lettered as its cards. */
.setting-glyph.tuning-legend {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
  margin: 4px 12px 8px;
}

.setting-glyph.tuning-legend path {
  stroke-width: 0.6;
}

.setting-glyph.tuning-legend .role-copper.wide {
  stroke-width: 3;
}

.legend-label {
  fill: var(--vscode-text-light);
  font-size: 7px;
  font-style: italic;
  text-anchor: middle;
}

/* --- Layer table ---------------------------------------------------------- */
/* Inline editing, KiCad/Altium-style: the row IS the layer. The grid, the
   cells and the dashes for what does not apply are the shared sheet
   (main.css, DESIGN.md §Sheets); this sizes the columns. */
.layer-table-wrap {
  margin-top: 6px;
  overflow-x: auto;
}

/* As wide as its columns, no wider: every column is sized (below), and the
   table is their sum. A pane narrower than that scrolls the wrapper rather
   than squeeze a column, since a squeezed input clips its own number. */
.layer-table {
  /* max-content, not auto: an auto table shrinks its columns below their set
     widths to fit a narrow pane, which is exactly the clipping this avoids. */
  width: max-content;
}

/* Dk and Df are the industry abbreviations and their case is meaningful, so
   they keep it — they take the weight of the row but not the upper-casing. */
.layer-table thead th.col-epsilonR,
.layer-table thead th.col-lossTangent {
  text-transform: none;
}

.col-hint {
  display: inline-flex;
  vertical-align: -2px;
  margin-left: 4px;
  color: var(--vscode-text-muted, #748780);
  opacity: 0.65;
  cursor: help;
}

.col-hint:hover {
  opacity: 1;
}

.col-hint svg {
  width: 11px;
  height: 11px;
  fill: currentColor;
}

.layer-name {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text, #d6e2dc);
}

/* A color chip tying each row to its band in the cross-section — both take
   the row's resolved color, so changing a mask color repaints all three. */
.layer-swatch {
  width: 12px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

/* Every column is sized (the table is their sum, `.layer-table`): without it
   the INPUTS clip their own values — 0.65 renders as 0.6, a wrong number on
   screen. */
.net-class-table .col-name {
  width: 128px;
}

/* The input and a hidden copy of the name share one grid cell, so the copy
   widens the column to the longest name and the input fills it. */
.name-fit {
  display: grid;
}

.name-fit > * {
  grid-area: 1 / 1;
}

.name-sizer {
  visibility: hidden;
  height: 0;
  /* The input's text and inset (propertyPanel.css, the sheet's cell). */
  padding: 0 8px;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  white-space: pre;
}

.name-fit :deep(.dense-input) {
  width: 0;
  min-width: 100%;
}

.net-class-table :where(th, td):not(.col-name, .col-actions) {
  width: 88px;
}

/* A color's swatch and a style's longest name ("Dash-dot-dot") need more. */
.net-class-table .col-pcbColor,
.net-class-table .col-schematicColor {
  width: 104px;
}

.net-class-table .col-lineStyle {
  width: 128px;
}

/* A column or two of sizes: as narrow as its numbers. */
.extra-size-table {
  width: auto;
  min-width: 0;
}

.extra-size-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 20px 32px;
}

/* The assignments and the nets they reach: side by side while both fit, the
   nets under the table once wrapped. */
/* One line of examples under the heading, a caption as quiet as the hints. */
.pattern-syntax {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0 0 8px;
  padding: 0 12px;
  font-size: var(--text-caption);
}

.pattern-syntax > div {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.pattern-syntax dt {
  color: var(--vscode-text);
  font-family: var(--font-mono, monospace);
}

.pattern-syntax dd {
  margin: 0;
  color: var(--vscode-text-muted);
}

.pattern-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px 24px;
}

.pattern-block {
  flex: 0 1 auto;
  min-width: 0;
}

.pattern-table {
  width: auto;
  min-width: 0;
}

.pattern-table .col-pattern {
  width: 260px;
}

.pattern-table .col-netclass {
  width: 168px;
}

.pattern-table .col-count {
  width: 56px;
  padding: 0 8px;
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--vscode-text);
}

.pattern-table td.col-count.zero {
  color: var(--vscode-text-muted);
}

/* Nets another row also puts in a different class: the class they end in is
   composed from both, which is sometimes the point and sometimes a slip. */
.pattern-table td.col-count.overlap {
  color: var(--vscode-accent);
  cursor: help;
}

.count-icon {
  width: 14px;
  height: 14px;
  vertical-align: -3px;
  color: var(--vscode-error);
}

.pattern-table tr.invalid :deep(.dense-input) {
  position: relative;
  z-index: 1;
  outline: 1px solid var(--vscode-error);
  outline-offset: 0;
}

.pattern-table tr.default-row {
  cursor: pointer;
}

.pattern-table tr.default-row td.sheet-text {
  color: var(--vscode-text-muted);
}

.pattern-table tbody tr.linked > :not(.sheet-actions) {
  background-image: linear-gradient(
    var(--vscode-accent-subtle-strong),
    var(--vscode-accent-subtle-strong)
  );
}

/* A pattern pointing at a class that no longer exists assigns nothing. It is
   kept rather than deleted — the fix is the user's — but it must not look live. */
.pattern-table tr.dangling {
  color: var(--vscode-text-muted, #748780);
}

.pattern-table tr.dangling :deep(.dense-select) {
  position: relative;
  z-index: 1;
  outline: 1px solid var(--vscode-error, #c9704f);
  outline-offset: 0;
}

.net-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 320px;
  align-self: stretch;
  min-width: 280px;
  max-width: 560px;
  min-height: 200px;
  margin-top: 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
}

/* Worn as the table's header row is, and as tall, so the two line up. */
.net-pane-head {
  flex: 0 0 auto;
  /* The pane's corners, less its border: square ones poke past its rounding. */
  border-radius: 3px 3px 0 0;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid var(--vscode-input-border);
  background-color: var(--vscode-bg-sidebar);
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* Out of flow, so the nets never set the pane's height: the table does. */
.net-list {
  position: absolute;
  inset: 29px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  padding: 8px;
}

.net-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
}

.net-path {
  color: var(--vscode-text-muted);
}

.net-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--vscode-text-light);
  white-space: nowrap;
}

/* A pair's half: its text trimmed as the pair trims a plain half (DiffPairGroup). */
.net-name {
  text-box: trim-both cap alphabetic;
}

/* In two classes or more: composed, so worth a second look. */
.net-chip.multi {
  text-decoration: underline dotted var(--vscode-accent);
  text-underline-offset: 3px;
}

.net-fixed {
  width: 11px;
  height: 11px;
  color: var(--vscode-accent);
}

.net-more {
  color: var(--vscode-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
}

.col-thickness,
.col-weight {
  width: 92px;
}

.col-type,
.col-material,
.col-color {
  width: 104px;
}

.col-epsilonR,
.col-lossTangent {
  width: 84px;
}

.col-actions {
  width: 34px;
}

.row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-text-muted, #748780);
  cursor: pointer;
}

.row-action svg {
  width: 14px;
  height: 14px;
}

.row-action:hover {
  background-color: var(--vscode-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--vscode-text-light, #d6e2dc);
}

.layer-totals {
  display: flex;
  gap: 26px;
  margin: 16px 0 0;
  padding: 0 4px;
}

.total-stat dt {
  color: var(--vscode-text-muted, #748780);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.total-stat dd {
  margin: 3px 0 0;
  color: var(--vscode-text, #d6e2dc);
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.total-stat.emphasis dd {
  color: var(--vscode-text-light, #e6f0ea);
  font-weight: 600;
}

/* --- Preview -------------------------------------------------------------- */
/* The table and its drawing: side by side, the drawing centered on the table
   and set just after it; wrapped, the drawing centered under the table. */
.stackup-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
}

/* Shrinks (its wrapper scrolls) only once alone on its line. */
.stackup-table {
  flex: 0 1 auto;
  min-width: 0;
}

/* Fixed, not flexible: letting the drawing grow squeezes the layer table
   out of its columns. */
.setup-preview {
  flex: 0 0 420px;
}

/* The build, drawn: as tall as the table beside it usually is. */
.section-3d {
  height: 380px;
}

/* The hovered layer and its thickness; its line is held while empty, so nothing jumps. */
.preview-caption {
  margin: 8px 0 0;
  min-height: 1.5em;
  color: var(--vscode-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  text-align: center;
}

/* A row whose slab is hovered in the preview, or the reverse. */
.layer-table tbody tr.linked th {
  color: var(--vscode-text-light);
}

/* Lit across the row's cells, not its buttons beside the grid: an accent
   wash laid over whatever each cell draws (a material tint, a recessed cell). */
.layer-table tbody tr.linked > :not(.sheet-actions) {
  background-image: linear-gradient(
    var(--vscode-accent-subtle-strong),
    var(--vscode-accent-subtle-strong)
  );
}

/* The row's material tint is the row's cells', not the buttons' beside it. */
.layer-table tbody td.sheet-actions {
  background-color: var(--vscode-bg-editor);
}

.preview-total {
  margin: 12px 0 0;
  color: var(--vscode-text-muted, #748780);
  font-size: 12px;
  line-height: 1.5;
}

.preview-total strong {
  color: var(--vscode-text, #d6e2dc);
}
</style>
