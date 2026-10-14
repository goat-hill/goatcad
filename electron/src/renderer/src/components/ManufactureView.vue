<script setup lang="ts">
/**
 * Manufacture mode (`goatcad://manufacture`) — the fab-package surface.
 *
 * Master-detail (fabrication-export-workstream.md): the left rail selects an
 * output (Gerbers / Drill / BOM / Pick & place); the right pane configures and
 * previews it. The writers (lib/gerber/write.ts, drill.ts) generate the exact
 * files, and the preview renders them through our own parser
 * (GerberPreview.vue). BOM and pick & place (CPL) read the board's footprints
 * into CSVs (lib/fabBom.ts, lib/fabCpl.ts). "Export package" writes the outputs
 * the profile calls for to `./fab/` plus a zip via the `fab:export` IPC.
 *
 * Per-board: every output — BOM included — comes from the one `.kicad_pcb` being
 * fabricated, so an updated-but-unsynced schematic never changes what's shipped.
 */
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { rememberedRef } from '../lib/paneMemory'
import {
  ALL_OUTPUTS,
  BUILT_IN_EXPORT_PROFILES,
  bomPartNumber,
  exportProfileForVendor,
  findExportProfile,
  hasOutput,
  type ExportProfile,
  type FabOutput
} from '../lib/exportProfiles'
import { defaultExportLayers, type ExportLayerCategory } from '../lib/gerberExportLayers'
import { kicadLayerColorsForTheme, useAppTheme } from '../lib/theme'
import { escapeCsvField, serializeCsv } from '../lib/bomCsv'
import {
  bomMatrix as buildBomMatrix,
  boardBomComponents,
  componentsForBom,
  dnpReferences,
  type FabBomComponent
} from '../lib/fabBom'
import { parseKicadBoard, type KicadBoard } from '../lib/kicad/board'
import { collectDrillHits } from '../lib/gerber/drill'
import { exportPackage as buildPackage } from '../lib/fabExport'
import { loadClipper } from '../lib/geometry/clip'
import {
  boardCplComponents,
  componentsForCpl,
  positionsMatrix,
  type CplComponent,
  type CplOptions
} from '../lib/fabCpl'
import { boardChecksSteps } from '../lib/board/boardChecks'
import { loadBoardLibraries } from '../lib/board/boardLibraries'
import { boardLibraryIo } from '../lib/board/boardLibraryIo'
import { computeConnectivitySteps } from '../lib/board/boardConnectivity'
import { BoardSpatialIndex } from '../lib/board/spatialIndex'
import { SCHEMATIC_SOURCE } from '../lib/board/syncDrift'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  findProjectFile,
  readProjectDesignSettings
} from '../lib/kicad/project'
import {
  preflightAllowsExport,
  preflightAudit,
  type PreflightCheck,
  type PreflightFinding,
  type PreflightLevel
} from '../lib/fabPreflight'
import { activeFindings } from '../lib/kicadExclusions'
import { ruleTitle } from '../lib/designHealth'
import { tk, type MessageKey } from '../lib/messageKey'
import type { CheckResult } from '../lib/schematic/checks'
import GerberPreview from './manufacture/GerberPreview.vue'
import CplPreview from './manufacture/CplPreview.vue'
import Icon from './shared/Icon.vue'
import type { IconName } from '../lib/icons'

const props = defineProps<{
  /** The .kicad_pcb this fab package is for — the tab is opened per-board. */
  boardPath: string
  /** The board's tab holds edits its file does not; the package is written from the file. */
  unsaved?: boolean
}>()

const emit = defineEmits<{
  /** Open the board and select what a pre-flight finding names. */
  (e: 'reveal-in-board', boardPath: string, uuids: string[]): void
}>()

const { t } = useI18n()

const boardName = computed(() => props.boardPath.split(/[\\/]/).pop() || props.boardPath)

// Default the export profile to the one matching the board's setup manufacturer.
// The board's applied vendor isn't read yet (a later slice), so this falls back
// to the default profile for now.
const selectedProfileId = ref(exportProfileForVendor(undefined).id)
const selectedProfile = computed(
  () => findExportProfile(selectedProfileId.value) ?? BUILT_IN_EXPORT_PROFILES[0]
)

// What the detail pane shows: the pre-flight, which opens first, or the output
// being configured. An output resets to a supported one when the profile
// changes (e.g. switching to a bare-board profile, which has no BOM, while viewing it).
const activeOutput = rememberedRef<FabOutput | 'preflight'>(
  `manufacture:${props.boardPath}`,
  'preflight'
)
watch(
  selectedProfile,
  (profile) => {
    if (activeOutput.value !== 'preflight' && !hasOutput(profile, activeOutput.value)) {
      activeOutput.value = ALL_OUTPUTS.find((output) => hasOutput(profile, output)) ?? 'gerber'
    }
  },
  { immediate: true }
)

const outputLabel = (output: FabOutput): string => t(`manufacture.outputs.${output}`)

const selectOutput = (output: FabOutput): void => {
  if (hasOutput(selectedProfile.value, output)) activeOutput.value = output
}

// --- Gerber configure state -------------------------------------------------

// A 2-layer set for the prototype; a later slice reads the real copper count.
const gerberLayers = ref(defaultExportLayers(2).map((l) => ({ ...l, on: l.defaultOn })))

const layerGroups = computed<
  { category: ExportLayerCategory; layers: typeof gerberLayers.value }[]
>(() => {
  const order: ExportLayerCategory[] = ['copper', 'technical', 'board']
  return order.map((category) => ({
    category,
    layers: gerberLayers.value.filter((l) => l.category === category)
  }))
})

const coordinateFormat = ref<'4.5' | '4.6'>('4.6')
const gerberUnits = ref<'mm' | 'inch'>('mm')

// Coordinate decimals from the format picker (4.6 → 6, 4.5 → 5).
const gerberDecimals = computed(() => (coordinateFormat.value === '4.5' ? 5 : 6))

// The plotted layers, on-state applied, in package order — drives the preview.
const selectedGerberLayers = computed(() =>
  gerberLayers.value.filter((l) => l.on).map((l) => l.name)
)

// --- Drill (Excellon) configure ---------------------------------------------

const drillUnits = ref<'mm' | 'inch'>('mm')
const drillZeros = ref<'none' | 'leading' | 'trailing'>('none')
const mergePthNpth = ref(true)
const drillMap = ref(false)

// --- BOM: real components from the board's schematic ------------------------

const bomGroup = ref(true)
const bomIncludeDnp = ref(false)

// The whole board is parsed once and shared: Gerbers, drill hits, and the BOM
// all come from the one `.kicad_pcb` being fabricated, so the package is
// internally consistent (an updated-but-unsynced schematic never changes what's
// shipped — fabBom.ts).
const board = shallowRef<KicadBoard | null>(null)
const bomComponents = ref<FabBomComponent[]>([])
const bomLoading = ref(true)

// Read on open, and again when a save lands, so the checklist is the file's.
watch(
  [() => props.boardPath, () => props.unsaved],
  async ([boardPath, unsaved], previous) => {
    const sameBoard = previous?.[0] === boardPath
    const justSaved = sameBoard && !!previous?.[1] && !unsaved
    if (sameBoard && !justSaved) return
    bomLoading.value = true
    board.value = null
    const read = await window.api.readFile(boardPath)
    if (read.success && read.content) {
      try {
        board.value = parseKicadBoard(read.content)
      } catch {
        board.value = null
      }
    }
    bomComponents.value = board.value ? boardBomComponents(board.value.footprints) : []
    // Size the plot set to the board's real copper-layer count.
    if (board.value) gerberLayers.value = makeGerberLayers(copperLayerCount(board.value))
    bomLoading.value = false
    if (board.value) void runDrc(board.value)
  },
  { immediate: true }
)

/** The profile the package is written with: the selected one, with this tab's settings applied. */
const packageProfile = computed<ExportProfile>(() => {
  const profile = selectedProfile.value
  const { gerber, drill, bom, cpl } = profile.outputs
  return {
    ...profile,
    outputs: {
      ...(gerber
        ? {
            gerber: {
              ...gerber,
              layers: selectedGerberLayers.value,
              precision: gerberDecimals.value
            }
          }
        : {}),
      ...(drill ? { drill: { ...drill, separatePlated: !mergePthNpth.value } } : {}),
      ...(bom ? { bom: { ...bom, group: bomGroup.value, includeDnp: bomIncludeDnp.value } } : {}),
      ...(cpl ? { cpl: { ...cpl, side: cplSide.value } } : {})
    }
  }
})

// --- Pre-flight -------------------------------------------------------------
// The board's DRC, run on the very file the package is written from — this
// tab has no editor session to borrow a result from — under a frame budget,
// then read with the profile, the BOM and the drill hits (lib/fabPreflight.ts).
// It holds the board to the schematic the board editor's pill does
// (lib/board/syncDrift.ts), so their parity findings agree, and runs again a
// moment after the schematic changes.

const schematicSource = inject(SCHEMATIC_SOURCE, null)
let schematicTimer: ReturnType<typeof setTimeout> | null = null
const stopSchematicChange = schematicSource?.onChange(() => {
  if (schematicTimer) clearTimeout(schematicTimer)
  schematicTimer = setTimeout(() => {
    schematicTimer = null
    if (board.value) void runDrc(board.value)
  }, 300)
})
onUnmounted(() => {
  stopSchematicChange?.()
  if (schematicTimer) clearTimeout(schematicTimer)
})

const drc = shallowRef<CheckResult[] | null>(null)
/** The project's text variables, which the plotted text resolves `${NAME}` from. */
const textVariables = shallowRef<Readonly<Record<string, string>>>({})
let drcToken = 0
const FRAME_BUDGET_MS = 8

async function runDrc(b: KicadBoard): Promise<void> {
  const token = ++drcToken
  drc.value = null
  const project = await findProjectFile(props.boardPath)
  const settings = (project ? await readProjectDesignSettings(project) : null) ?? {
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
    patterns: [],
    assignments: []
  }
  if (token !== drcToken) return
  textVariables.value = settings.textVariables ?? {}
  // Custom pads' thermal rings go through the geometry engine.
  await loadClipper()
  if (token !== drcToken) return
  let sliceStart = performance.now()
  const pause = async (): Promise<boolean> => {
    if (performance.now() - sliceStart < FRAME_BUDGET_MS) return true
    await new Promise((resolve) => setTimeout(resolve, 0))
    sliceStart = performance.now()
    return token === drcToken
  }
  const index = BoardSpatialIndex.build(b)
  const connectivitySteps = computeConnectivitySteps(b, index)
  let conn = connectivitySteps.next()
  while (!conn.done) {
    if (!(await pause())) return
    conn = connectivitySteps.next()
  }
  // The footprint libraries too, so the pre-flight counts what the pill does.
  const libraries = await loadBoardLibraries(boardLibraryIo(props.boardPath), b)
  if (token !== drcToken) return
  const read = schematicSource ? await schematicSource.read() : null
  if (token !== drcToken) return
  const checks = boardChecksSteps({
    board: b,
    index,
    connectivity: conn.value,
    settings,
    libraries,
    schematic: read?.state === 'ready' ? read.netlist : null
  })
  let step = checks.next()
  while (!step.done) {
    if (!(await pause())) return
    step = checks.next()
  }
  drc.value = step.value
}

const preflight = computed<PreflightFinding[] | null>(() =>
  board.value && drc.value
    ? preflightAudit({
        board: board.value,
        profile: selectedProfile.value,
        drc: activeFindings(drc.value),
        bom: bomComponents.value,
        drillHits: drillHits.value
      })
    : null
)
const preflightGroups = computed(() =>
  (['blocking', 'review', 'passed'] as const)
    .map((level) => ({ level, findings: (preflight.value ?? []).filter((f) => f.level === level) }))
    .filter((group) => group.findings.length > 0)
)
const reviewCount = computed(
  () => (preflight.value ?? []).filter((f) => f.level === 'review').length
)
const blocked = computed(() => !!preflight.value && !preflightAllowsExport(preflight.value))

const CHECK_TITLES: Record<PreflightCheck, MessageKey> = {
  outline: tk('manufacture.preflight.check.outline'),
  drcErrors: tk('manufacture.preflight.check.drcErrors'),
  drcWarnings: tk('manufacture.preflight.check.drcWarnings'),
  unfilledZones: tk('manufacture.preflight.check.unfilledZones'),
  drillSize: tk('manufacture.preflight.check.drillSize'),
  holeSpacing: tk('manufacture.preflight.check.holeSpacing'),
  partNumbers: tk('manufacture.preflight.check.partNumbers'),
  values: tk('manufacture.preflight.check.values')
}
const GROUP_TITLES: Record<PreflightLevel, MessageKey> = {
  blocking: tk('manufacture.preflight.group.blocking'),
  review: tk('manufacture.preflight.group.review'),
  passed: tk('manufacture.preflight.group.passed')
}
const LEVEL_ICONS: Record<PreflightLevel, IconName> = {
  blocking: 'status-error',
  review: 'status-warning',
  passed: 'status-ok'
}

/** What a finding names, capped, with how many more there are. */
const namesOf = (finding: PreflightFinding, names: string[]): string => {
  const more = finding.count - names.length
  const list = names.join(', ')
  return more > 0 ? t('manufacture.preflight.more', { list, more }) : list
}

/** The sentence under a finding's title: what was found, with its numbers. */
const findingDetail = (f: PreflightFinding): string => {
  const passed = f.level === 'passed'
  const field = bomPartNumber(selectedProfile.value) ?? 'MPN'
  switch (f.check) {
    case 'outline':
      return passed
        ? t('manufacture.preflight.outline.passed')
        : t('manufacture.preflight.outline.found')
    case 'drcErrors':
    case 'drcWarnings': {
      if (passed)
        return f.check === 'drcErrors'
          ? t('manufacture.preflight.drc.noErrors')
          : t('manufacture.preflight.drc.noWarnings')
      // The rules themselves are listed under the line, with their counts.
      return f.check === 'drcErrors'
        ? t('manufacture.preflight.drc.errors', { count: f.count }, f.count)
        : t('manufacture.preflight.drc.warnings', { count: f.count }, f.count)
    }
    case 'unfilledZones':
      return passed
        ? t('manufacture.preflight.zones.passed')
        : t(
            'manufacture.preflight.zones.found',
            { count: f.count, names: namesOf(f, f.subjects) },
            f.count
          )
    case 'drillSize':
      return passed
        ? t('manufacture.preflight.drill.passed', { limit: f.limit })
        : t(
            'manufacture.preflight.drill.found',
            { count: f.count, actual: f.actual, limit: f.limit },
            f.count
          )
    case 'holeSpacing':
      return passed
        ? t('manufacture.preflight.spacing.passed', { limit: f.limit })
        : t('manufacture.preflight.spacing.found', { actual: f.actual, limit: f.limit })
    case 'partNumbers':
      return passed
        ? t('manufacture.preflight.partNumbers.passed', { field })
        : t(
            'manufacture.preflight.partNumbers.found',
            { count: f.count, field, refs: namesOf(f, f.subjects) },
            f.count
          )
    case 'values':
      return passed
        ? t('manufacture.preflight.values.passed')
        : t(
            'manufacture.preflight.values.found',
            { count: f.count, refs: namesOf(f, f.subjects) },
            f.count
          )
  }
}

/** A DRC rule code as the health drawer titles it. */
const ruleLabel = (code: string): string => {
  const key = ruleTitle(code)
  return key ? t(key) : code
}

/** The header's one-line verdict beside Export. */
const preflightStatus = computed(() => {
  if (!preflight.value) return t('manufacture.preflight.status.checking')
  if (blocked.value) return t('manufacture.preflight.status.blocked')
  return reviewCount.value > 0
    ? t('manufacture.preflight.status.review', { count: reviewCount.value }, reviewCount.value)
    : t('manufacture.preflight.status.ready')
})

const showOnBoard = (finding: PreflightFinding): void =>
  emit('reveal-in-board', props.boardPath, finding.targets)

/** Copper-layer count from the board's layer table (min 2). */
function copperLayerCount(b: KicadBoard): number {
  return Math.max(2, b.layers.filter((l) => l.name.endsWith('.Cu')).length)
}

const makeGerberLayers = (
  copper: number
): Array<ReturnType<typeof defaultExportLayers>[number] & { on: boolean }> =>
  defaultExportLayers(copper).map((l) => ({ ...l, on: l.defaultOn }))

// Drilled holes (pads + vias) from the board, for the drill output + preview.
const drillHits = computed(() => (board.value ? collectDrillHits(board.value) : []))

const drillStats = computed(() => {
  const hits = drillHits.value
  const tools = new Set(hits.map((h) => Math.round(h.diameter * 1000)))
  return { holes: hits.length, tools: tools.size }
})

// The BOM as the package writes it: the profile's columns, header first.
const bomMatrix = computed(() =>
  buildBomMatrix(bomComponents.value, packageProfile.value.outputs.bom ?? {})
)
const bomRowCount = computed(() => bomMatrix.value.length - 1)

// Total = individual parts in the BOM; unique = line items after grouping.
const bomStats = computed(() => ({
  total: componentsForBom(bomComponents.value, bomIncludeDnp.value).length,
  unique: bomRowCount.value
}))
// DNP parts are listed under the BOM even when excluded from it.
const bomDnp = computed(() => dnpReferences(bomComponents.value))

// Swatches match the board editor's display palette for the theme; the
// export layer's own color is KiCad's canonical one.
const appTheme = useAppTheme()
const layerSwatches = computed(() => kicadLayerColorsForTheme(appTheme.value))

// One color per column so the eye can follow a column down the file. Kept small
// and readable on the viewport background; a real categorical palette is a later
// design-framework token set.
const BOM_COLUMN_COLORS = [
  'var(--vscode-text)',
  'var(--vscode-source-number)',
  'var(--vscode-success)',
  'var(--vscode-accent)'
]
const columnColor = (index: number): string => BOM_COLUMN_COLORS[index % BOM_COLUMN_COLORS.length]

async function exportBom(): Promise<void> {
  const csv = serializeCsv(bomMatrix.value)
  const defaultPath = `${props.boardPath.replace(/\.kicad_pcb$/i, '')}-bom.csv`
  const target = await window.api.saveFileDialog(defaultPath)
  if (!target) return
  const res = await window.api.createFile(target, csv)
  if (!res.success) console.error('BOM export failed:', res.error)
}

// --- Pick & place (CPL): real centroids from the board ----------------------

const cplSide = ref<'both' | 'front'>('both')
const cplGroup = ref(false)

// The settings above start from the profile's; edits make the package's profile a fork of it.
watch(
  selectedProfile,
  (profile) => {
    const { gerber, drill, bom, cpl } = profile.outputs
    coordinateFormat.value = gerber?.precision === 5 ? '4.5' : '4.6'
    mergePthNpth.value = !(drill?.separatePlated ?? true)
    bomGroup.value = bom?.group ?? true
    bomIncludeDnp.value = bom?.includeDnp ?? false
    cplSide.value = cpl?.side === 'front' ? 'front' : 'both'
  },
  { immediate: true }
)

const cplComponents = computed<CplComponent[]>(() =>
  board.value ? boardCplComponents(board.value.footprints) : []
)
// Units follow the profile (mm/mil); side is user-chosen; DNP parts aren't placed.
const cplOptions = computed<CplOptions>(() => ({
  units: selectedProfile.value.outputs.cpl?.units ?? 'mm',
  side: cplSide.value,
  includeDnp: false
}))
// The placements that will actually be written — also what the preview plots.
const cplVisible = computed(() => componentsForCpl(cplComponents.value, cplOptions.value))
const cplStats = computed(() => {
  const top = cplVisible.value.filter((c) => c.side === 'top').length
  return { total: cplVisible.value.length, top, bottom: cplVisible.value.length - top }
})

async function exportCpl(): Promise<void> {
  const csv = serializeCsv(
    positionsMatrix(cplComponents.value, packageProfile.value.outputs.cpl ?? {})
  )
  const target = await window.api.saveFileDialog(
    `${props.boardPath.replace(/\.kicad_pcb$/i, '')}-cpl.csv`
  )
  if (!target) return
  const res = await window.api.createFile(target, csv)
  if (!res.success) console.error('CPL export failed:', res.error)
}

// --- Export footer ----------------------------------------------------------

const zip = ref(true)
const exporting = ref(false)
const exportError = ref<string | null>(null)

const boardBaseName = computed(() => boardName.value.replace(/\.kicad_pcb$/i, ''))
const boardDir = computed(() =>
  props.boardPath.slice(
    0,
    Math.max(props.boardPath.lastIndexOf('/'), props.boardPath.lastIndexOf('\\'))
  )
)

// The button is live once the board has parsed, unless the pre-flight blocks.
// Not before the pre-flight has an answer, or while it checks again.
const canExport = computed(
  () => board.value !== null && !exporting.value && preflight.value !== null && !blocked.value
)

/**
 * Assemble the whole fab package — gerbers + drill (per the profile), plus the
 * BOM and CPL CSVs the profile calls for — and hand it to the main process to
 * write into `./fab/` beside the project, plus a zip.
 */
async function exportPackage(): Promise<void> {
  if (!board.value) return
  exporting.value = true
  exportError.value = null
  try {
    // Silk clipping needs the wasm geometry engine; a failed load degrades to
    // unclipped output with a warning rather than blocking the export.
    await loadClipper()
    const pkg = buildPackage(board.value, packageProfile.value, {
      boardName: boardBaseName.value,
      textVariables: textVariables.value
    })
    const res = await window.api.exportFabPackage({
      directory: `${boardDir.value}/fab`,
      files: pkg.files.map((f) => ({ name: f.name, content: f.content })),
      archive: zip.value ? pkg.archive : null
    })
    if (!res.success) {
      exportError.value = res.error ?? 'Export failed'
      return
    }
    if (res.revealPath) await window.api.revealPath(res.revealPath)
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="manufacture-view">
    <header class="mfg-header">
      <h1 class="mfg-title">{{ t('manufacture.title') }}</h1>

      <div class="mfg-picker">
        <span class="mfg-picker-label">{{ t('manufacture.board') }}</span>
        <span class="mfg-board-name">{{ boardName }}</span>
      </div>

      <div class="mfg-picker">
        <label class="mfg-picker-label" for="mfg-profile">
          {{ t('manufacture.exportProfile') }}
        </label>
        <select id="mfg-profile" v-model="selectedProfileId" class="field-md mfg-select">
          <option v-for="profile in BUILT_IN_EXPORT_PROFILES" :key="profile.id" :value="profile.id">
            {{ profile.vendor }}
          </option>
        </select>
      </div>

      <!-- Export controls float right, sparing a bottom footer row. -->
      <div class="mfg-actions">
        <span class="mfg-actions-label">{{ t('manufacture.outputFolder') }}</span>
        <code class="mfg-folder">./fab/</code>
        <label class="mfg-zip">
          <input v-model="zip" type="checkbox" />
          {{ t('manufacture.zip') }}
        </label>
        <button
          class="mfg-status"
          :class="{
            blocked,
            review: !blocked && reviewCount > 0,
            ready: preflight && !blocked && !reviewCount
          }"
          type="button"
          @click="activeOutput = 'preflight'"
        >
          {{ preflightStatus }}
        </button>
        <button class="btn-cta btn-md" :disabled="!canExport" @click="exportPackage">
          {{ exporting ? t('manufacture.exporting') : t('manufacture.export') }}
        </button>
      </div>
      <p v-if="exportError" class="mfg-export-error">{{ exportError }}</p>
    </header>

    <div class="mfg-body">
      <nav class="nav-list">
        <button
          class="nav-item"
          :class="{ active: activeOutput === 'preflight' }"
          @click="activeOutput = 'preflight'"
        >
          {{ t('manufacture.preflight.title') }}
        </button>
        <button
          v-for="output in ALL_OUTPUTS"
          :key="output"
          class="nav-item"
          :class="{ active: activeOutput === output }"
          :disabled="!hasOutput(selectedProfile, output)"
          @click="selectOutput(output)"
        >
          {{ outputLabel(output) }}
        </button>
      </nav>

      <main class="mfg-detail">
        <!-- Pre-flight: what stands between this board and a package its fab
             builds, grouped blocking / to review / passed. -->
        <section v-if="activeOutput === 'preflight'" class="mfg-configure mfg-preflight">
          <h3 class="mfg-detail-title">{{ t('manufacture.preflight.title') }}</h3>
          <div v-if="unsaved" class="mfg-pf-row review">
            <Icon name="status-warning" class="mfg-pf-icon" />
            <div class="mfg-pf-text">
              <span class="mfg-pf-title">{{ t('manufacture.preflight.unsaved.title') }}</span>
              <span class="mfg-pf-detail">{{ t('manufacture.preflight.unsaved.detail') }}</span>
            </div>
          </div>
          <p v-if="!preflight" class="mfg-hint">{{ t('manufacture.preflight.status.checking') }}</p>
          <div v-for="group in preflightGroups" :key="group.level" class="mfg-pf-group">
            <span class="mfg-block-title">{{ t(GROUP_TITLES[group.level]) }}</span>
            <div
              v-for="finding in group.findings"
              :key="finding.check"
              class="mfg-pf-row"
              :class="finding.level"
            >
              <Icon :name="LEVEL_ICONS[finding.level]" class="mfg-pf-icon" />
              <div class="mfg-pf-text">
                <span class="mfg-pf-title">{{ t(CHECK_TITLES[finding.check]) }}</span>
                <span class="mfg-pf-detail">{{ findingDetail(finding) }}</span>
                <ul v-if="finding.level !== 'passed' && finding.breakdown" class="mfg-pf-list">
                  <li v-for="row in finding.breakdown" :key="row.subject">
                    <span class="mfg-pf-rule">{{ ruleLabel(row.subject) }}</span>
                    <span class="mfg-pf-count">{{ row.count }}</span>
                  </li>
                </ul>
              </div>
              <button
                v-if="finding.level !== 'passed' && finding.targets.length"
                class="btn-outline btn-sm"
                type="button"
                @click="showOnBoard(finding)"
              >
                {{ t('manufacture.preflight.showOnBoard') }}
              </button>
            </div>
          </div>
        </section>

        <!-- Gerbers: real configure + a representative preview. -->
        <template v-else-if="activeOutput === 'gerber'">
          <section class="mfg-configure">
            <h3 class="mfg-detail-title">{{ t('manufacture.detail.configure') }}</h3>
            <div class="mfg-config-grid">
              <div v-for="group in layerGroups" :key="group.category" class="mfg-config-block">
                <span class="mfg-block-title">
                  {{ t(`manufacture.gerber.category.${group.category}`) }}
                </span>
                <label v-for="layer in group.layers" :key="layer.name" class="mfg-layer">
                  <input v-model="layer.on" type="checkbox" />
                  <span
                    class="mfg-swatch"
                    :style="{ background: layerSwatches[layer.name] ?? layer.color }"
                  />
                  <span class="mfg-layer-name">{{ layer.name }}</span>
                </label>
              </div>

              <div class="mfg-config-block">
                <span class="mfg-block-title">{{ t('manufacture.gerber.format') }}</span>
                <div class="mfg-field">
                  <label class="mfg-field-label" for="mfg-coord">
                    {{ t('manufacture.gerber.coordinateFormat') }}
                  </label>
                  <select id="mfg-coord" v-model="coordinateFormat" class="field-sm">
                    <option value="4.6">4.6</option>
                    <option value="4.5">4.5</option>
                  </select>
                </div>
                <div class="mfg-field">
                  <label class="mfg-field-label" for="mfg-units">
                    {{ t('manufacture.gerber.units') }}
                  </label>
                  <select id="mfg-units" v-model="gerberUnits" class="field-sm">
                    <option value="mm">mm</option>
                    <option value="inch">inch</option>
                  </select>
                </div>
                <div class="mfg-field">
                  <span class="mfg-field-label">{{ t('manufacture.gerber.naming') }}</span>
                  <span class="mfg-field-value">
                    {{
                      t(
                        `manufacture.gerber.namingValue.${selectedProfile.outputs.gerber?.naming ?? 'kicad'}`
                      )
                    }}
                  </span>
                </div>
              </div>
            </div>
            <p class="mfg-hint">{{ t('manufacture.gerber.layerCountNote') }}</p>
          </section>

          <section class="mfg-preview">
            <h3 class="mfg-detail-title">{{ t('manufacture.detail.preview') }}</h3>
            <!-- The exact Gerbers we would write, generated and rendered through
                 our own parser (fabrication-export §5a). -->
            <GerberPreview
              :board="board"
              :layers="selectedGerberLayers"
              :decimals="gerberDecimals"
              :text-variables="textVariables"
              :drill-hits="[]"
            />
          </section>
        </template>

        <!-- Drill (Excellon): sample configure + placeholder preview. -->
        <template v-else-if="activeOutput === 'drill'">
          <section class="mfg-configure">
            <h3 class="mfg-detail-title">{{ t('manufacture.detail.configure') }}</h3>
            <div class="mfg-config-grid">
              <div class="mfg-config-block">
                <div class="mfg-field">
                  <span class="mfg-field-label">{{ t('manufacture.drill.format') }}</span>
                  <span class="mfg-field-value">{{ t('manufacture.drill.formatValue') }}</span>
                </div>
                <div class="mfg-field">
                  <label class="mfg-field-label" for="mfg-drill-units">
                    {{ t('manufacture.drill.units') }}
                  </label>
                  <select id="mfg-drill-units" v-model="drillUnits" class="field-sm">
                    <option value="mm">mm</option>
                    <option value="inch">inch</option>
                  </select>
                </div>
                <div class="mfg-field">
                  <label class="mfg-field-label" for="mfg-drill-zeros">
                    {{ t('manufacture.drill.zeros') }}
                  </label>
                  <select id="mfg-drill-zeros" v-model="drillZeros" class="field-sm">
                    <option value="none">{{ t('manufacture.drill.zerosValue.none') }}</option>
                    <option value="leading">{{ t('manufacture.drill.zerosValue.leading') }}</option>
                    <option value="trailing">
                      {{ t('manufacture.drill.zerosValue.trailing') }}
                    </option>
                  </select>
                </div>
              </div>
              <div class="mfg-config-block">
                <span class="mfg-block-title">{{ t('manufacture.drill.options') }}</span>
                <label class="mfg-check">
                  <input v-model="mergePthNpth" type="checkbox" />
                  {{ t('manufacture.drill.merge') }}
                </label>
                <label class="mfg-check">
                  <input v-model="drillMap" type="checkbox" />
                  {{ t('manufacture.drill.map') }}
                </label>
              </div>
            </div>
          </section>
          <section class="mfg-preview">
            <div class="mfg-preview-head">
              <h3 class="mfg-head-title">{{ t('manufacture.detail.preview') }}</h3>
              <p class="mfg-bom-stats mfg-drill-stats">
                {{
                  t('manufacture.drill.stats', {
                    holes: drillStats.holes,
                    tools: drillStats.tools
                  })
                }}
              </p>
            </div>
            <!-- The board's holes over its outline, from the same drill data the
                 Excellon file is written from. -->
            <GerberPreview
              :board="board"
              :layers="['Edge.Cuts']"
              :decimals="gerberDecimals"
              :text-variables="textVariables"
              :drill-hits="drillHits"
              emphasize-drill
            />
          </section>
        </template>

        <!-- BOM: sample configure + a sample table preview. -->
        <template v-else-if="activeOutput === 'bom'">
          <section class="mfg-configure">
            <h3 class="mfg-detail-title">{{ t('manufacture.detail.configure') }}</h3>
            <div class="mfg-config-grid">
              <div class="mfg-config-block">
                <span class="mfg-block-title">{{ t('manufacture.bom.options') }}</span>
                <label class="mfg-check">
                  <input v-model="bomGroup" type="checkbox" />
                  {{ t('manufacture.bom.group') }}
                </label>
                <label class="mfg-check">
                  <input v-model="bomIncludeDnp" type="checkbox" />
                  {{ t('manufacture.bom.includeDnp') }}
                </label>
              </div>
              <div class="mfg-config-block">
                <div class="mfg-field">
                  <span class="mfg-field-label">{{ t('manufacture.bom.partNumber') }}</span>
                  <span class="mfg-field-value">{{ bomPartNumber(selectedProfile) }}</span>
                </div>
                <div class="mfg-field">
                  <span class="mfg-field-label">{{ t('manufacture.bom.format') }}</span>
                  <span class="mfg-field-value">{{ t('manufacture.bom.formatValue') }}</span>
                </div>
              </div>
            </div>
          </section>
          <section class="mfg-preview">
            <!-- Export sits above the file, prominent, so it isn't lost below a
                 long BOM. -->
            <div class="mfg-preview-head">
              <h3 class="mfg-head-title">{{ t('manufacture.detail.preview') }}</h3>
              <button class="btn-cta btn-md" :disabled="!bomRowCount" @click="exportBom">
                {{ t('manufacture.bom.export') }}
              </button>
            </div>
            <div v-if="bomLoading" class="mfg-csv-empty">{{ t('manufacture.bom.loading') }}</div>
            <div v-else-if="!bomRowCount" class="mfg-csv-empty">
              {{ t('manufacture.bom.empty') }}
            </div>
            <template v-else>
              <p class="mfg-bom-stats">
                {{ t('manufacture.bom.stats', { total: bomStats.total, unique: bomStats.unique }) }}
              </p>
              <!-- The .csv file as it will be written, colored by column so the
                   fields are easy to follow. -->
              <div class="mfg-csv">
                <div
                  v-for="(row, r) in bomMatrix"
                  :key="r"
                  class="mfg-csv-row"
                  :class="{ header: r === 0 }"
                >
                  <template v-for="(cell, c) in row" :key="c">
                    <span v-if="c > 0" class="mfg-csv-sep">,</span>
                    <span class="mfg-csv-cell" :style="{ color: columnColor(c) }">{{
                      escapeCsvField(cell)
                    }}</span>
                  </template>
                </div>
              </div>
              <p v-if="bomDnp.length" class="mfg-bom-dnp">
                <span class="mfg-bom-dnp-label">{{ t('manufacture.bom.dnpLabel') }}</span>
                {{ bomDnp.join(', ') }}
              </p>
            </template>
          </section>
        </template>

        <!-- Pick & place (CPL): real centroids + interactive placement map. -->
        <template v-else-if="activeOutput === 'cpl'">
          <section class="mfg-configure">
            <h3 class="mfg-detail-title">{{ t('manufacture.detail.configure') }}</h3>
            <div class="mfg-config-grid">
              <div class="mfg-config-block">
                <span class="mfg-block-title">{{ t('manufacture.bom.options') }}</span>
                <label class="mfg-check">
                  <input v-model="cplGroup" type="checkbox" />
                  {{ t('manufacture.cpl.group') }}
                </label>
              </div>
              <div class="mfg-config-block">
                <div class="mfg-field">
                  <label class="mfg-field-label" for="mfg-cpl-side">
                    {{ t('manufacture.cpl.side') }}
                  </label>
                  <select id="mfg-cpl-side" v-model="cplSide" class="field-sm">
                    <option value="both">{{ t('manufacture.cpl.sideValue.both') }}</option>
                    <option value="front">{{ t('manufacture.cpl.sideValue.top') }}</option>
                  </select>
                </div>
                <div class="mfg-field">
                  <span class="mfg-field-label">{{ t('manufacture.cpl.units') }}</span>
                  <span class="mfg-field-value">{{ cplOptions.units }}</span>
                </div>
              </div>
            </div>
          </section>
          <section class="mfg-preview">
            <div class="mfg-preview-head">
              <h3 class="mfg-head-title">{{ t('manufacture.detail.preview') }}</h3>
              <p class="mfg-bom-stats mfg-drill-stats">
                {{
                  t('manufacture.cpl.stats', {
                    total: cplStats.total,
                    top: cplStats.top,
                    bottom: cplStats.bottom
                  })
                }}
              </p>
              <button class="btn-cta btn-md" :disabled="!cplVisible.length" @click="exportCpl">
                {{ t('manufacture.cpl.export') }}
              </button>
            </div>
            <CplPreview
              :board="board"
              :board-path="boardPath"
              :components="cplVisible"
              :group="cplGroup"
              :units="cplOptions.units"
            />
          </section>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.manufacture-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-bg-editor);
  color: var(--vscode-text);
  font-size: 13px;
}

.mfg-header {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-end;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vscode-border);
}

/* Sits inline, to the left of the pickers; centered against their height
   (the header aligns everything else to flex-end). */
.mfg-title {
  align-self: center;
  margin: 0;
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.mfg-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mfg-picker-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.mfg-board-name {
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: 13px;
}

/* The export-profile select is a framework control (.field-md); this only sets
   its width. */
.mfg-select {
  min-width: 200px;
}

.mfg-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Left output selector is the shared `.nav-list` / `.nav-item` (DESIGN.md §3). */

/* Right pane: configure stacked above preview. */
/* No padding on the container so the preview can bleed to the pane edges;
   the configure section pads itself. */
.mfg-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.mfg-configure {
  flex-shrink: 0;
  padding: 16px 20px;
}

/* Fixed-width columns packed left — as many as fit, without stretching to fill. */
.mfg-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, 160px);
  justify-content: start;
  gap: 14px 24px;
  align-items: start;
  margin-bottom: 8px;
}

.mfg-config-block {
  min-width: 0;
}

.mfg-block-title {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
  margin: 0 0 4px;
}

.mfg-preview {
  flex: 1;
  min-width: 0;
  min-height: 260px;
  display: flex;
  flex-direction: column;
}

.mfg-detail-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}

/* The preview title is inset to match configure; the board below is full-bleed. */
.mfg-preview .mfg-detail-title {
  padding: 12px 20px 0;
  margin-bottom: 8px;
}

.mfg-hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--vscode-text-muted);
}

.mfg-layer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  font-size: 13px;
  cursor: pointer;
}

.mfg-swatch {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
  border: 1px solid rgba(0, 0, 0, 0.3);
}

.mfg-layer-name {
  font-family: var(--font-mono);
  font-size: 12px;
}

.mfg-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 4px 0;
}

.mfg-field-label {
  font-size: 13px;
}

.mfg-field-value {
  font-size: 12px;
  color: var(--vscode-text-muted);
}

/* A checkbox option row (drill/BOM options). */
.mfg-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  font-size: 13px;
  cursor: pointer;
}

/* Preview header: title left, prominent Export button right, above the file. */
.mfg-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px 10px;
}

.mfg-head-title {
  margin: 0;
  font-size: var(--text-body);
  font-weight: 600;
}

/* BOM .csv file preview: the exact output, colored by column. */
.mfg-csv {
  margin: 0 20px 16px;
  padding: 12px 14px;
  background: var(--vscode-bg-viewport);
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
  line-height: 1.8;
}

.mfg-csv-row {
  white-space: nowrap;
}

.mfg-csv-row.header .mfg-csv-cell {
  font-weight: 700;
}

.mfg-csv-sep {
  color: var(--vscode-text-muted);
  padding: 0 1px;
}

.mfg-csv-empty {
  margin: 0 20px 16px;
  padding: 20px;
  border: 1px dashed var(--vscode-border);
  border-radius: 6px;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  text-align: center;
}

.mfg-bom-stats {
  margin: 0 20px 8px;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

.mfg-bom-dnp {
  margin: 10px 20px 16px;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

.mfg-bom-dnp-label {
  margin-right: 6px;
  font-family: var(--font-family);
  font-weight: 600;
  color: var(--vscode-text);
}

/* Export controls, floated to the right of the pickers in the header. */
.mfg-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.mfg-actions-label {
  font-size: 12px;
  color: var(--vscode-text-muted);
}

.mfg-folder {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 2px 6px;
  background: var(--vscode-input-bg);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
}

.mfg-zip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.mfg-export-error {
  flex-basis: 100%;
  margin: 6px 0 0;
  color: var(--vscode-error, #d16d78);
  font-size: 12px;
}

/* The pre-flight verdict beside Export: a quiet chip that opens the checklist. */
.mfg-status {
  padding: 3px 10px;
  border: 1px solid var(--vscode-border);
  border-radius: 999px;
  background: transparent;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  cursor: pointer;
}

.mfg-status.blocked {
  color: var(--vscode-error);
  border-color: var(--vscode-error);
}

.mfg-status.review {
  color: var(--vscode-warning);
  border-color: var(--vscode-warning);
}

.mfg-status.ready {
  color: var(--vscode-success);
  border-color: var(--vscode-success);
}

.mfg-pf-group {
  margin-bottom: 16px;
  max-width: 720px;
}

.mfg-pf-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--vscode-border);
}

/* The glyph takes its size here: an Icon's svg has none of its own. */
.mfg-pf-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--vscode-text-muted);
}

.mfg-pf-row.blocking .mfg-pf-icon {
  color: var(--vscode-error);
}

.mfg-pf-row.review .mfg-pf-icon {
  color: var(--vscode-warning);
}

.mfg-pf-row.passed .mfg-pf-icon {
  color: var(--vscode-success);
}

.mfg-pf-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mfg-pf-title {
  font-size: var(--text-body);
}

.mfg-pf-detail {
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
  overflow-wrap: anywhere;
}

/* A DRC row's rules, one per line with its count. */
.mfg-pf-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.mfg-pf-list li {
  padding: 1px 0;
}

.mfg-pf-rule {
  color: var(--vscode-text);
}

.mfg-pf-count {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}

/* Drill hole/tool count, aligned with the preview header. */
.mfg-drill-stats {
  margin: 0;
}
</style>
