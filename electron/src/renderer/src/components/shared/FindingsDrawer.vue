<script lang="ts">
import { ref as moduleRef } from 'vue'

export type DrawerTab = 'problems' | 'performance' | 'settings'

/**
 * The view last chosen — a tab, or the gear's settings — shared by every
 * drawer and kept across a tab switch that destroys the editor, as a VS Code
 * panel stays on its last view.
 */
const lastTab = moduleRef<DrawerTab>('problems')
</script>

<script setup lang="ts">
/**
 * The findings drawer: what an editor's checks found, under its canvas, grouped
 * by rule. Clicking a finding asks the editor to locate it; the editor selects
 * and reveals it, and the list stays put so the next one is a click away.
 *
 * It sits below the canvas, never over it and never in a tab, because the loop
 * it serves is list ↔ canvas (`docs/design-health-workstream.md`). ↑/↓ step
 * through the findings and locate each; Escape closes the drawer.
 *
 * Pinned, the same list is `embedded` in the right bar's Problems panel: that
 * panel's header titles, sizes and unpins it, so this drops its own.
 *
 * An editor that times its checks fills the `performance` slot, and the header
 * becomes a strip of panel tabs, Problems and Performance, VS Code's way; one
 * with settings for how its checks run fills `settings`, which the header's
 * gear opens. Pinned in the right bar, the list keeps only its gear.
 */
import { computed, nextTick, ref, useSlots, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import ResizeHandle from './ResizeHandle.vue'
import {
  excludedFindings,
  groupFindings,
  healthCounts,
  measureValue,
  ruleTitle,
  type HealthFinding,
  type HealthGroup
} from '../../lib/designHealth'

const { t } = useI18n()

const props = defineProps<{
  findings: HealthFinding[]
  height: number
  /** The checks have not finished a first run: an empty list is not a clean one. */
  pending?: boolean
  /** A check is running, so a pending list is on its way. */
  checking?: boolean
  /** Offer a re-run of every check (an editor that checks round edits). */
  rerunnable?: boolean
  /** In the right bar: no title, resize, close or pin — the bar's panel has those. */
  embedded?: boolean
  /**
   * A finding to show, as a click on its canvas marker asks: its row selected
   * and scrolled to, its rule unfolded. `seq` tells two asks for one finding apart.
   */
  reveal?: { key: string; seq: number } | null
  /** A quick fix for every finding of a rule, its label by rule code. */
  groupFixes?: Readonly<Record<string, string>>
}>()

const emit = defineEmits<{
  /** Show a finding: `zoom` (a double click) frames it close, else it is centered. */
  (e: 'locate', finding: HealthFinding, zoom: boolean): void
  /** The finding's quick fix was asked for (`HealthFinding.fix`). */
  (e: 'fix', finding: HealthFinding): void
  /** The rule's quick fix for all its findings was asked for (`groupFixes`). */
  (e: 'fix-group', code: string): void
  (e: 'close'): void
  /** Every check was asked to run again, over the whole design. */
  (e: 'rerun'): void
  (e: 'resize', height: number, commit: boolean): void
  /** Move the list into the right bar. */
  (e: 'pin'): void
}>()

const slots = useSlots()
const tabbed = computed(() => !!slots.performance && !props.embedded)
const tab = computed<DrawerTab>(() =>
  (lastTab.value === 'performance' && tabbed.value) ||
  (lastTab.value === 'settings' && !!slots.settings)
    ? lastTab.value
    : 'problems'
)
const choose = (next: DrawerTab): void => {
  lastTab.value = next
}
const toggleSettings = (): void => choose(tab.value === 'settings' ? 'problems' : 'settings')

const groups = computed(() => groupFindings(props.findings, (code) => titleOf({ code })))
const counts = computed(() => healthCounts(props.findings))
/** What the project's KiCad exclusions name: listed last, folded, never counted. */
const excluded = computed(() => excludedFindings(props.findings))
const EXCLUDED = 'excluded'

/** Rules folded shut, by code; a rule's findings reappear when it is opened. */
const folded = ref(new Set<string>([EXCLUDED]))
const toggleGroup = (code: string): void => {
  const next = new Set(folded.value)
  if (next.has(code)) next.delete(code)
  else next.add(code)
  folded.value = next
}

const titleOf = (group: Pick<HealthGroup, 'code'>): string => {
  const key = ruleTitle(group.code)
  return key ? t(key) : group.code
}

// The finding last located. Kept by key, so it survives the re-run an edit
// triggers; cleared once the finding is fixed and leaves the list.
const activeKey = ref<string | null>(null)
watch(
  () => props.findings,
  (findings) => {
    if (activeKey.value && !findings.some((finding) => finding.key === activeKey.value)) {
      activeKey.value = null
    }
  }
)

const locate = (finding: HealthFinding, zoom = false): void => {
  activeKey.value = finding.key
  emit('locate', finding, zoom)
}

const list = ref<HTMLElement | null>(null)
const scrollTo = (key: string): void => {
  void nextTick(() =>
    list.value
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  )
}

// A reveal waits for its finding: an editor just opened on another sheet may
// still be checking when the request lands. Each reveal is applied once.
let revealed = -1
watch(
  [() => props.reveal, () => props.findings],
  ([reveal, findings]) => {
    const finding = reveal && reveal.seq !== revealed && findings.find((f) => f.key === reveal.key)
    if (!finding) return
    revealed = reveal.seq
    choose('problems')
    const group = finding.excluded ? EXCLUDED : finding.code
    if (folded.value.has(group)) toggleGroup(group)
    activeKey.value = finding.key
    scrollTo(finding.key)
  },
  { immediate: true }
)

/** The findings in reading order, skipping folded rules: what ↑/↓ walk. */
const visible = computed(() => [
  ...groups.value.flatMap((group) => (folded.value.has(group.code) ? [] : group.findings)),
  ...(folded.value.has(EXCLUDED) ? [] : excluded.value)
])

/** A row's numbers, short: "0.15 mm, needs 0.2 mm (netclass 'Power')"; else its detail. */
const detailOf = (finding: HealthFinding): string => {
  const m = finding.measure
  if (!m) return finding.detail ?? ''
  const values = { actual: measureValue(m.actual, m.unit), limit: measureValue(m.limit, m.unit) }
  const text =
    m.bound === 'min'
      ? t('designHealth.drawer.needs', values)
      : t('designHealth.drawer.allows', values)
  return m.rule ? t('designHealth.drawer.byRule', { text, rule: m.rule }) : text
}

const findingTitle = (finding: HealthFinding): string => {
  const key = ruleTitle(finding.code)
  return key ? t(key) : finding.code
}

const step = (delta: number): void => {
  const rows = visible.value
  if (!rows.length) return
  const at = rows.findIndex((finding) => finding.key === activeKey.value)
  const next =
    rows[at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length]
  locate(next)
  scrollTo(next.key)
}

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'ArrowDown') step(1)
  else if (event.key === 'ArrowUp') step(-1)
  else if (event.key === 'Escape' && !props.embedded) emit('close')
  else return
  event.preventDefault()
  event.stopPropagation()
}

let resizeStart = props.height
</script>

<template>
  <section
    class="findings-drawer"
    :class="{ embedded }"
    :style="embedded ? undefined : { height: height + 'px' }"
    tabindex="0"
    @keydown="onKeydown"
  >
    <ResizeHandle
      v-if="!embedded"
      edge="top"
      @resize-start="resizeStart = height"
      @resize="(grow) => emit('resize', resizeStart + grow, false)"
      @resize-end="emit('resize', height, true)"
    />
    <header class="drawer-header">
      <div v-if="tabbed" class="panel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="panel-tab"
          :class="{ active: tab === 'problems' }"
          :aria-selected="tab === 'problems'"
          @click="choose('problems')"
        >
          {{ t('designHealth.drawer.title') }}
        </button>
        <button
          type="button"
          role="tab"
          class="panel-tab"
          :class="{ active: tab === 'performance' }"
          :aria-selected="tab === 'performance'"
          @click="choose('performance')"
        >
          {{ t('designHealth.drawer.performance') }}
        </button>
      </div>
      <span v-else-if="!embedded" class="drawer-title">{{ t('designHealth.drawer.title') }}</span>
      <!-- Under the canvas the pill beside it counts these; pinned, the pill is gone. -->
      <template v-if="embedded && tab === 'problems'">
        <span v-if="counts.errors" class="count error">
          <Icon name="status-error" class="glyph" />{{ counts.errors }}
        </span>
        <span v-if="counts.warnings" class="count warning">
          <Icon name="status-warning" class="glyph" />{{ counts.warnings }}
        </span>
      </template>
      <button
        v-if="rerunnable && tab === 'problems'"
        type="button"
        class="btn-subtle btn-icon-sm drawer-rerun"
        :title="t('designHealth.drawer.rerun')"
        @click="emit('rerun')"
      >
        <Icon name="refresh" class="glyph" />
      </button>
      <button
        v-if="$slots.settings"
        type="button"
        class="btn-subtle btn-icon-sm drawer-settings"
        :class="{ active: tab === 'settings' }"
        :aria-pressed="tab === 'settings'"
        :title="t('designHealth.drawer.settings')"
        @click="toggleSettings"
      >
        <Icon name="settings" class="glyph" />
      </button>
      <template v-if="!embedded">
        <button
          type="button"
          class="btn-subtle btn-icon-sm drawer-pin"
          :title="t('shared.viewportPopover.pin')"
          @click="emit('pin')"
        >
          <Icon name="pin" class="glyph" />
        </button>
        <button
          type="button"
          class="btn-subtle btn-icon-sm"
          :title="t('designHealth.drawer.close')"
          @click="emit('close')"
        >
          <Icon name="close" class="glyph" />
        </button>
      </template>
    </header>

    <div v-if="tab === 'performance'" class="drawer-body">
      <slot name="performance" />
    </div>
    <div v-else-if="tab === 'settings'" class="drawer-body">
      <slot name="settings" />
    </div>
    <div v-else ref="list" class="drawer-body">
      <p v-if="!groups.length" class="drawer-empty">
        {{
          !pending
            ? t('designHealth.drawer.clean')
            : checking
              ? t('designHealth.drawer.checking')
              : t('designHealth.drawer.pending')
        }}
      </p>
      <div v-for="group in groups" :key="group.code" class="rule-group">
        <div class="rule-head">
          <button
            type="button"
            class="rule-header"
            :aria-expanded="!folded.has(group.code)"
            @click="toggleGroup(group.code)"
          >
            <Icon
              name="chevron-right"
              class="chevron"
              :class="{ expanded: !folded.has(group.code) }"
            />
            <Icon
              :name="group.severity === 'error' ? 'status-error' : 'status-warning'"
              class="glyph"
              :class="group.severity"
              :aria-label="
                group.severity === 'error'
                  ? t('designHealth.drawer.severity.error')
                  : t('designHealth.drawer.severity.warning')
              "
            />
            <span class="rule-title">{{ titleOf(group) }}</span>
            <span class="rule-count">{{
              t('designHealth.drawer.count', group.findings.length)
            }}</span>
          </button>
          <button
            v-if="groupFixes?.[group.code]"
            type="button"
            class="btn-outline btn-sm finding-fix"
            @click="emit('fix-group', group.code)"
          >
            {{ groupFixes[group.code] }}
          </button>
        </div>
        <template v-if="!folded.has(group.code)">
          <div
            v-for="finding in group.findings"
            :key="finding.key"
            class="finding-line"
            :class="{ active: finding.key === activeKey }"
          >
            <button
              type="button"
              class="finding-row"
              :data-key="finding.key"
              @click="locate(finding)"
              @dblclick="locate(finding, true)"
            >
              <span class="finding-subject">{{ finding.subject }}</span>
              <span v-if="finding.layer" class="finding-place">{{ finding.layer }}</span>
              <span v-if="finding.measure || finding.detail" class="finding-detail">{{
                detailOf(finding)
              }}</span>
              <span v-if="finding.place" class="finding-place">{{ finding.place }}</span>
            </button>
            <button
              v-if="finding.fix"
              type="button"
              class="btn-outline btn-sm finding-fix"
              @click="emit('fix', finding)"
            >
              {{ finding.fix }}
            </button>
          </div>
        </template>
      </div>

      <div v-if="excluded.length" class="rule-group excluded-group">
        <button
          type="button"
          class="rule-header"
          :aria-expanded="!folded.has(EXCLUDED)"
          :title="t('designHealth.drawer.excludedHint')"
          @click="toggleGroup(EXCLUDED)"
        >
          <Icon name="chevron-right" class="chevron" :class="{ expanded: !folded.has(EXCLUDED) }" />
          <Icon name="eye-off" class="glyph muted" />
          <span class="rule-title">{{ t('designHealth.drawer.excluded') }}</span>
          <span class="rule-count">{{ t('designHealth.drawer.count', excluded.length) }}</span>
        </button>
        <template v-if="!folded.has(EXCLUDED)">
          <button
            v-for="finding in excluded"
            :key="finding.key"
            type="button"
            class="finding-row"
            :class="{ active: finding.key === activeKey }"
            :data-key="finding.key"
            @click="locate(finding)"
          >
            <span class="finding-rule">{{ findingTitle(finding) }}</span>
            <span class="finding-subject">{{ finding.subject }}</span>
            <span v-if="finding.excluded?.comment" class="finding-place">{{
              finding.excluded.comment
            }}</span>
            <span v-else-if="finding.place" class="finding-place">{{ finding.place }}</span>
          </button>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.findings-drawer {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--vscode-border);
  background: var(--vscode-bg-sidebar);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.findings-drawer:focus {
  outline: none;
}

.drawer-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--vscode-border);
}

/* VS Code's panel tabs: eyebrow labels, the open one underlined. */
.panel-tabs {
  display: flex;
  align-self: stretch;
  gap: 12px;
  margin: -4px 0;
}

.panel-tab {
  min-height: 24px;
  padding: 0 4px;
  border: none;
  border-bottom: 1px solid transparent;
  background: none;
  color: var(--vscode-text-muted);
  font: inherit;
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.panel-tab:hover {
  color: var(--vscode-text);
}

.panel-tab.active {
  border-bottom-color: var(--vscode-text);
  color: var(--vscode-text-light);
}

/* DESIGN.md's section eyebrow. */
.drawer-title {
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono, monospace);
}

.count.error,
.glyph.error {
  color: var(--vscode-error);
}

.count.warning,
.glyph.warning {
  color: var(--vscode-warning);
}

.drawer-pin {
  margin-left: auto;
}

.drawer-settings.active {
  background: var(--vscode-bg-active);
  color: var(--vscode-text-light);
}

/* In the right bar: the bar's panel is the frame, and fills its height. */
.findings-drawer.embedded {
  flex: 1;
  height: 100%;
  border-top: none;
  background: none;
}

.findings-drawer.embedded .drawer-header:empty {
  display: none;
}

.glyph {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
  /* A row scrolled to (↑/↓, a marker's click) lands below the stuck header. */
  scroll-padding-top: 24px;
}

.drawer-empty {
  margin: 8px 12px;
  color: var(--vscode-text-muted);
}

.rule-header,
.finding-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.rule-header {
  padding: 0 12px 0 8px;
}

/* A group's header stays at the top while its findings scroll under it, so a
   row deep in a long group still says which problem it is. */
.rule-header {
  position: sticky;
  /* Flush with the list's top edge, over its 4px of padding, so no row shows above it. */
  top: -4px;
  z-index: 1;
  background-color: var(--vscode-bg-sidebar);
}

/* A rule's header row: the header, and a fix for all its findings beside it,
   sticky together. */
.rule-head {
  position: sticky;
  top: -4px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  background-color: var(--vscode-bg-sidebar);
}

.rule-head:has(> .finding-fix) {
  padding-right: 12px;
}

.rule-head > .rule-header {
  position: static;
  flex: 1;
  min-width: 0;
}

.rule-header:hover,
.finding-row:hover {
  background: var(--vscode-bg-hover);
}

.chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--vscode-text-muted);
}

.chevron.expanded {
  transform: rotate(90deg);
}

.rule-title {
  font-weight: 600;
}

.rule-count {
  color: var(--vscode-text-muted);
}

/* Indented to sit under the rule's title, past its chevron and glyph. */
.finding-row {
  padding: 0 12px 0 48px;
}

/* The row and its fix share one line; the line carries the hover and the mark. */
.finding-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 12px;
}

.finding-line:hover {
  background: var(--vscode-bg-hover);
}

.finding-line.active {
  background: var(--vscode-bg-active);
}

.finding-line .finding-row {
  flex: 1;
  min-width: 0;
}

.finding-line .finding-row:hover {
  background: none;
}

.finding-fix {
  flex-shrink: 0;
}

.finding-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
}

.finding-place {
  flex-shrink: 0;
  color: var(--vscode-text-muted);
}

/* The numbers a finding turns on, after its subject; the subject keeps priority when narrow. */
.finding-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-text-muted);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.glyph.muted,
.excluded-group .rule-title,
.finding-rule {
  color: var(--vscode-text-muted);
}

.finding-rule {
  flex-shrink: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .chevron {
    transition: transform 0.12s ease;
  }
}
</style>
