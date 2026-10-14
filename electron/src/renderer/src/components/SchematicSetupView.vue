<script setup lang="ts">
/**
 * Schematic Setup — a design's project settings for its schematic, as a tab
 * (`goatcad://schematic-setup/<root sheet>`), the schematic's twin of Board
 * Setup: Electrical Rules, every ERC rule KiCad names with this project's
 * severity for it (shared/RuleSeverityTable); Net Classes, the project's classes
 * with the schematic's columns (wire and bus width, color, line style) and their
 * patterns, Board Setup's own page (KiCad's two setups edit the one
 * `net_settings`); and Exclusions, the findings a KiCad user excluded
 * (shared/ExclusionList). All live in the `.kicad_pro`; severities and classes
 * are written straight out, not undone, and exclusions only read.
 */
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import RuleSeverityTable from './shared/RuleSeverityTable.vue'
import { rememberedRef } from '../lib/paneMemory'
import ExclusionList from './shared/ExclusionList.vue'
import PcbBoardSetup from './pcb/PcbBoardSetup.vue'
import { EDITOR_WORKSPACE } from '../lib/editorWorkspace'
import {
  extractDesignSettings,
  extractRuleSeverities,
  findProjectFile,
  writeProjectDesignSettings,
  writeProjectRuleSeverities,
  type BoardDesignSettings
} from '../lib/kicad/project'
import {
  addNetClass,
  addNetClassPattern,
  buildNetClassRows,
  buildPatternRows,
  editNetClass,
  editNetClassPattern,
  removeNetClass,
  removeNetClassPattern,
  type BoardSetupSection,
  type NetClassEditColumn,
  type NetClassModel
} from '../lib/board/boardSetupSchema'
import { assignableNets } from '../lib/board/netClassCoverage'
import { BUILT_IN_PROFILES, defaultStackupOf } from '../lib/manufacturingProfiles'
import type { PropertyEditValue } from '../lib/propertyTable'
import { ERC_CATALOG } from '../lib/schematic/ercCatalog'
import { ERC_KICAD_KEYS, type CheckResult } from '../lib/schematic/checks'
import type { RuleSeverity, SeverityMap } from '../lib/ruleSeverity'
import { emitProjectChange, fileChange, onProjectChange } from '../lib/projectBus'
import { samePath } from '../lib/kicad/paths'
import { extractExclusions, type KicadExclusion } from '../lib/kicadExclusions'

const { t } = useI18n()

const props = defineProps<{
  /** The design's root `.kicad_sch`. */
  rootPath: string
}>()

const workspace = inject(EDITOR_WORKSPACE, null)

type Section = 'rules' | 'netClasses' | 'exclusions'
const SECTIONS: Section[] = ['rules', 'netClasses', 'exclusions']
const section = rememberedRef<Section>('schematic-setup', 'rules')

const projectPath = ref<string | null>(null)
const severities = ref<SeverityMap>({})
const exclusions = ref<KicadExclusion[]>([])
const loaded = ref(false)
/** The project's design settings as last read: what a class edit writes back around. */
const settings = shallowRef<BoardDesignSettings | null>(null)
/** The classes and patterns being edited; a pattern still blank stays here until it says something. */
const classModel = shallowRef<NetClassModel>({ classes: [], patterns: [], edited: false })

const readProject = async (): Promise<void> => {
  const file = projectPath.value
  const read = file ? await window.api.readFile(file) : null
  const text = read?.success ? (read.content ?? '') : ''
  severities.value = (text && extractRuleSeverities(text, 'erc')) || {}
  exclusions.value = text ? extractExclusions(text, 'erc') : []
  const design = text ? extractDesignSettings(text) : null
  settings.value = design
  const drafts = classModel.value.patterns.filter((p) => !p.pattern.trim())
  classModel.value = {
    classes: design?.classes ?? [],
    patterns: [...(design?.patterns ?? []), ...drafts],
    edited: false
  }
}

const netSection = computed<BoardSetupSection>(() => ({
  id: 'netClasses',
  title: t('schematicSetup.sections.netClasses'),
  settings: [],
  netClasses: buildNetClassRows(classModel.value.classes, t),
  netClassPatterns: buildPatternRows(classModel.value.classes, classModel.value.patterns, t)
}))

/** Take a class edit and write it to the project, as Board Setup does. */
const applyClasses = async (next: NetClassModel): Promise<void> => {
  if (next === classModel.value) return
  classModel.value = next
  const file = projectPath.value
  const read = settings.value
  if (!file || !read) return
  const { rules, extraSizes } = read
  const written = await writeProjectDesignSettings(file, {
    rules,
    classes: [...next.classes],
    patterns: next.patterns.filter((p) => p.pattern.trim()),
    ...(extraSizes ? { extraSizes } : {})
  })
  if (written) void emitProjectChange(null, fileChange('file-changed', file))
}
const onNetClassEdit = (
  index: number,
  column: NetClassEditColumn,
  value: PropertyEditValue
): Promise<void> => applyClasses(editNetClass(classModel.value, index, column, value))
const onAddNetClass = (): Promise<void> =>
  applyClasses(addNetClass(classModel.value, t('boardSetup.netClasses.newName')))
const onRemoveNetClass = (index: number): Promise<void> =>
  applyClasses(removeNetClass(classModel.value, index))
const onPatternEdit = (
  index: number,
  field: 'pattern' | 'netClass',
  value: PropertyEditValue
): Promise<void> => applyClasses(editNetClassPattern(classModel.value, index, field, value))
const onAddPattern = (): Promise<void> => applyClasses(addNetClassPattern(classModel.value))
const onRemovePattern = (index: number): Promise<void> =>
  applyClasses(removeNetClassPattern(classModel.value, index))

/** Board Setup's frame wants a stackup; the net class page draws none. */
const NO_STACKUP = defaultStackupOf(BUILT_IN_PROFILES[0])

/** A rule's title; a key KiCad 10 does not name (a legacy one) reads as itself. */
const ercRuleTitle = (key: string): string =>
  ERC_CATALOG.some((rule) => rule.key === key) ? t(`ruleChecks.erc.${key}`) : key

watch(
  () => props.rootPath,
  async (root) => {
    loaded.value = false
    projectPath.value = await findProjectFile(root)
    await readProject()
    loaded.value = true
  },
  { immediate: true }
)

const stopProjectWatch = onProjectChange((changes) => {
  const file = projectPath.value
  if (file && changes.some((c) => 'path' in c && samePath(c.path, file))) void readProject()
})
onUnmounted(stopProjectWatch)

const onSet = async (key: string, severity: RuleSeverity): Promise<void> => {
  const file = projectPath.value
  if (!file) return
  severities.value = { ...severities.value, [key]: severity }
  if (await writeProjectRuleSeverities(file, 'erc', { [key]: severity })) {
    void emitProjectChange(null, fileChange('file-changed', file))
  }
}

// The design's current findings, from the root sheet's session when its tab has
// one; the ERC is design-wide, so any sheet's session would count the same.
const results = shallowRef<CheckResult[] | null>(null)
/** The design's nets, which the patterns are matched against. */
const netNames = shallowRef<string[]>([])
watch(
  () => props.rootPath,
  (root, _old, onCleanup) => {
    const session = workspace?.sheetSessionFor(root) ?? null
    if (!session) {
      results.value = null
      return
    }
    const read = (): void => {
      results.value = session.checks()
      netNames.value = assignableNets(session.connectivity()?.nets.map((net) => net.name) ?? [])
    }
    read()
    onCleanup(session.subscribe(read))
  },
  { immediate: true }
)

const counts = computed<ReadonlyMap<string, number> | null>(() => {
  if (!results.value) return null
  const out = new Map<string, number>()
  for (const result of results.value) {
    if (result.excluded) continue
    const key = ERC_KICAD_KEYS[result.code]
    if (key) out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
})
</script>

<template>
  <div class="schematic-setup">
    <header class="setup-title-bar">
      <h1 class="setup-title">{{ t('schematicSetup.title') }}</h1>
    </header>

    <div class="setup-body">
      <nav class="nav-list" role="tablist">
        <button
          v-for="id in SECTIONS"
          :key="id"
          class="nav-item"
          :class="{ active: id === section }"
          role="tab"
          :aria-selected="id === section"
          @click="section = id"
        >
          {{ t(`schematicSetup.sections.${id}`) }}
        </button>
      </nav>

      <div class="setup-content">
        <p v-if="loaded && !projectPath" class="setup-note">
          {{ t('schematicSetup.noProject') }}
        </p>
        <PcbBoardSetup
          v-if="section === 'netClasses'"
          embedded
          class-columns="schematic"
          :sections="[netSection]"
          :stackup="NO_STACKUP"
          :layer-rows="[]"
          :read-only="!projectPath"
          :severities="{}"
          :rule-counts="null"
          :exclusions="[]"
          :check-results="null"
          :net-names="netNames"
          :net-assignments="settings?.assignments ?? []"
          @edit-net-class="onNetClassEdit"
          @add-net-class="onAddNetClass"
          @remove-net-class="onRemoveNetClass"
          @edit-pattern="onPatternEdit"
          @add-pattern="onAddPattern"
          @remove-pattern="onRemovePattern"
        />
        <ExclusionList
          v-else-if="section === 'exclusions'"
          :exclusions="exclusions"
          :rule-title="ercRuleTitle"
          :results="results"
        />
        <RuleSeverityTable
          v-else
          :catalog="ERC_CATALOG"
          :group-label="(group) => t(`ruleChecks.ercGroups.${group}`)"
          :rule-title="ercRuleTitle"
          :severities="severities"
          :counts="counts"
          :disabled="!projectPath"
          @set="onSet"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The frame is Board Setup's (pcb/PcbBoardSetup.vue): a title bar, the shared
   `.nav-list` beside the content. */
.schematic-setup {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background-color: var(--vscode-bg-editor);
}

.setup-title-bar {
  flex: 0 0 auto;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--vscode-border);
}

.setup-title {
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 600;
}

.setup-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.setup-content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px 28px;
}

.setup-note {
  margin: 0 0 14px;
  padding: 9px 11px;
  border-left: 2px solid var(--vscode-accent);
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}
</style>
