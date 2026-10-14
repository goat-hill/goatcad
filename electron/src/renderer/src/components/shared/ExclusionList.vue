<script setup lang="ts">
/**
 * The project's KiCad exclusions, as Board Setup and Schematic Setup list them
 * (`lib/kicadExclusions.ts`): each one's rule, its comment, and what it
 * excludes here now. Read-only — they are made and removed in KiCad.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import type { KicadExclusion } from '../../lib/kicadExclusions'
import type { CheckResult } from '../../lib/schematic/checks'

const { t } = useI18n()

const props = defineProps<{
  exclusions: readonly KicadExclusion[]
  ruleTitle: (key: string) => string
  /** The checks' current findings, excluded ones marked; null before they have run. */
  results: readonly CheckResult[] | null
}>()

/** What each exclusion excludes now, by its string. */
const excludedBy = computed(() => {
  const out = new Map<string, string[]>()
  for (const result of props.results ?? []) {
    const raw = result.excluded?.exclusion
    if (!raw) continue
    const list = out.get(raw) ?? []
    list.push(result.subject || result.items.join(', '))
    out.set(raw, list)
  }
  return out
})

type Status = 'matched' | 'unmatched' | 'noItems' | 'unknown'

const statusOf = (exclusion: KicadExclusion): Status => {
  if (!exclusion.ids.length) return 'noItems'
  if (!props.results) return 'unknown'
  return excludedBy.value.has(exclusion.raw) ? 'matched' : 'unmatched'
}
</script>

<template>
  <div class="exclusion-list">
    <p class="exclusion-note">{{ t('ruleChecks.exclusions.note') }}</p>
    <p v-if="!exclusions.length" class="exclusion-empty">{{ t('ruleChecks.exclusions.none') }}</p>
    <div
      v-for="exclusion in exclusions"
      :key="exclusion.raw"
      class="exclusion-row"
      :class="statusOf(exclusion)"
    >
      <span class="exclusion-text">
        <span class="exclusion-title" :title="exclusion.key">{{ ruleTitle(exclusion.key) }}</span>
        <span v-if="exclusion.comment" class="exclusion-comment">{{ exclusion.comment }}</span>
        <span v-if="excludedBy.get(exclusion.raw)" class="exclusion-subjects">
          {{ excludedBy.get(exclusion.raw)!.join(' · ') }}
        </span>
      </span>
      <span
        class="exclusion-status"
        :title="
          statusOf(exclusion) === 'unmatched'
            ? t('ruleChecks.exclusions.unmatchedHint')
            : statusOf(exclusion) === 'noItems'
              ? t('ruleChecks.exclusions.noItemsHint')
              : undefined
        "
      >
        <Icon
          v-if="statusOf(exclusion) === 'unmatched' || statusOf(exclusion) === 'noItems'"
          name="info"
          class="status-glyph"
        />
        {{
          statusOf(exclusion) === 'matched'
            ? t('ruleChecks.exclusions.matched', excludedBy.get(exclusion.raw)?.length ?? 0)
            : statusOf(exclusion) === 'unmatched'
              ? t('ruleChecks.exclusions.unmatched')
              : statusOf(exclusion) === 'noItems'
                ? t('ruleChecks.exclusions.noItems')
                : ''
        }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.exclusion-list {
  max-width: 880px;
}

.exclusion-note {
  margin: 0 0 14px;
  padding: 9px 11px;
  border-left: 2px solid var(--vscode-accent);
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.exclusion-empty {
  color: var(--vscode-text-muted);
  font-size: var(--text-body);
}

.exclusion-row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding: 4px 8px;
  border-radius: 4px;
}

.exclusion-row:nth-of-type(even) {
  background-color: color-mix(in srgb, var(--vscode-text) 4%, transparent);
}

.exclusion-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.exclusion-title {
  color: var(--vscode-text-light);
  font-size: var(--text-body);
}

.exclusion-comment {
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
  font-style: italic;
}

.exclusion-subjects {
  overflow: hidden;
  color: var(--vscode-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exclusion-row.unmatched .exclusion-title,
.exclusion-row.noItems .exclusion-title {
  opacity: 0.6;
}

.exclusion-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.status-glyph {
  width: 12px;
  height: 12px;
}
</style>
