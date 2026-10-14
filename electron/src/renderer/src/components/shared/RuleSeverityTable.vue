<script setup lang="ts">
/**
 * Every rule a checker names, as Board Setup's Design Rules and Schematic
 * Setup's Electrical Rules list them: KiCad's rules in KiCad's groups, each
 * with its severity for this project and whether GoatCAD checks it yet
 * (design-health-workstream.md). Severities are KiCad's own `rule_severities`,
 * so the host writes them to the project file, not to an undo stack.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import PropertyValueEditor from './PropertyValueEditor.vue'
import Icon from './Icon.vue'
import type { PropertyEditValue } from '../../lib/propertyTable'
import {
  RULE_SEVERITIES,
  effectiveSeverity,
  isChecked,
  isRuleSeverity,
  type CatalogRule,
  type RuleSeverity,
  type SeverityMap
} from '../../lib/ruleSeverity'

const { t } = useI18n()

const props = defineProps<{
  catalog: readonly CatalogRule[]
  groupLabel: (group: string) => string
  ruleTitle: (key: string) => string
  severities: SeverityMap
  /** Current findings per KiCad key; null while none have been counted. */
  counts?: ReadonlyMap<string, number> | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'set', key: string, severity: RuleSeverity): void
}>()

const groups = computed(() => {
  const out: Array<{ group: string; rules: CatalogRule[] }> = []
  for (const rule of props.catalog) {
    const last = out[out.length - 1]
    if (last?.group === rule.group) last.rules.push(rule)
    else out.push({ group: rule.group, rules: [rule] })
  }
  return out
})

const severityOptions = computed(() =>
  RULE_SEVERITIES.map((value) => ({ value, label: t(`ruleChecks.severity.${value}`) }))
)

const severityOf = (rule: CatalogRule): RuleSeverity => effectiveSeverity(rule, props.severities)

/** What the checks report now; null where nothing is known (not checked, ignored, not yet run). */
const statusOf = (rule: CatalogRule): 'passing' | 'findings' | null => {
  const count = props.counts?.get(rule.key)
  if (!rule.codes.length || count === undefined || severityOf(rule) === 'ignore') return null
  return count > 0 ? 'findings' : 'passing'
}

const statusLabel = (rule: CatalogRule): string =>
  statusOf(rule) === 'findings'
    ? t('ruleChecks.status.findings', props.counts?.get(rule.key) ?? 0)
    : t('ruleChecks.status.passing')

const onCommit = (key: string, value: PropertyEditValue): void => {
  if (isRuleSeverity(value)) emit('set', key, value)
}
</script>

<template>
  <div class="rule-table">
    <template v-for="entry in groups" :key="entry.group">
      <h3 class="rule-group">{{ groupLabel(entry.group) }}</h3>
      <div
        v-for="rule in entry.rules"
        :key="rule.key"
        class="rule-row"
        :class="{ unchecked: !isChecked(rule), ignored: severityOf(rule) === 'ignore' }"
      >
        <span class="rule-severity" :class="`severity-${severityOf(rule)}`">
          <PropertyValueEditor
            :field="{
              key: rule.key,
              editor: { kind: 'segmented', options: severityOptions },
              value: severityOf(rule)
            }"
            :disabled="disabled"
            @commit="(value) => onCommit(rule.key, value)"
          />
        </span>
        <span class="rule-text">
          <span class="rule-name">
            <span class="rule-title" :title="rule.key">{{ ruleTitle(rule.key) }}</span>
            <span
              v-if="!isChecked(rule)"
              class="rule-unchecked"
              :title="t('ruleChecks.notSupported')"
              :aria-label="t('ruleChecks.notSupported')"
              role="img"
            >
              <Icon name="status-warning" />
            </span>
          </span>
        </span>
        <span
          v-if="statusOf(rule)"
          class="rule-status"
          :class="[statusOf(rule), statusOf(rule) === 'findings' ? severityOf(rule) : '']"
        >
          {{ statusLabel(rule) }}
        </span>
        <span v-if="severityOf(rule) !== rule.severity" class="rule-default">
          {{
            t('ruleChecks.defaultSeverity', {
              severity: t(`ruleChecks.severity.${rule.severity}`)
            })
          }}
          <button
            type="button"
            class="btn-outline btn-sm"
            :disabled="disabled"
            @click="emit('set', rule.key, rule.severity)"
          >
            {{ t('ruleChecks.restore') }}
          </button>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rule-table {
  max-width: 880px;
}

/* The app's section eyebrow (PcbBoardSetup's .setting-group). */
.rule-group {
  margin: 18px 0 4px;
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* The control leads its row and the name follows it, so nothing sits between a
   rule and its setting; alternate rows are banded rather than ruled, and the
   row under the pointer lights, to carry the eye along a row. */
.rule-row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding: 3px 8px;
  border-radius: 4px;
}

.rule-row:nth-of-type(even) {
  background-color: color-mix(in srgb, var(--vscode-text) 4%, transparent);
}

.rule-row:hover {
  background-color: var(--vscode-bg-hover);
}

.rule-text {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rule-title {
  color: var(--vscode-text-light);
  font-size: var(--text-body);
}

.rule-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* A rule GoatCAD does not check yet, or one the project turned off: the name
   recedes (the glyph says which is which). */
.rule-row.unchecked .rule-title,
.rule-row.ignored .rule-title {
  opacity: 0.6;
}

.rule-unchecked {
  display: inline-flex;
  color: var(--vscode-warning);
  cursor: help;
}

.rule-unchecked :deep(svg) {
  width: 14px;
  height: 14px;
}

/* At the row's right edge, so a changed rule's row keeps its height. */
.rule-default {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  white-space: nowrap;
}

.rule-status {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--vscode-border);
  border-radius: 10px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-align: center;
  white-space: nowrap;
}

.rule-status.passing {
  color: var(--vscode-text);
}

.rule-status.findings.error {
  color: var(--vscode-error);
  border-color: var(--vscode-error);
  background-color: var(--vscode-error-subtle);
}

.rule-status.findings.warning {
  color: var(--vscode-warning);
  border-color: var(--vscode-warning);
  background-color: var(--vscode-warning-subtle);
}

.rule-severity {
  flex: 0 0 auto;
}

/* The selected severity wears its own color, the health pill's, in the soft
   tint rather than solid, so the column reads as settings, not alarms
   (DESIGN.md "A selected tool is copper"). */
.rule-severity.severity-error :deep(.dense-toggle-btn.active) {
  background-color: var(--vscode-error-subtle);
  color: var(--vscode-error);
  box-shadow: inset 0 0 0 1px var(--vscode-error);
}

.rule-severity.severity-warning :deep(.dense-toggle-btn.active) {
  background-color: var(--vscode-warning-subtle);
  color: var(--vscode-warning);
  box-shadow: inset 0 0 0 1px var(--vscode-warning);
}

.rule-severity.severity-ignore :deep(.dense-toggle-btn.active) {
  background-color: color-mix(in srgb, var(--vscode-text-muted) 14%, transparent);
  color: var(--vscode-text-muted);
  box-shadow: inset 0 0 0 1px var(--vscode-text-muted);
}

.rule-group {
  padding: 0 8px;
}
</style>
