<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ExplainedLimit } from '../../lib/board/rules/explain'
import { formatDistance, type DistanceUnit } from '../../lib/propertyTable'
import { warningSourceOf } from '../../lib/board/pcbPropertySchema'
import RuleSource from '../shared/RuleSource.vue'

/**
 * "Why this limit?" under the properties of one or two copper items: each
 * clearance and size the rules require of them, and what set it — KiCad's
 * Clearance and Constraints Resolution (`lib/board/rules/explain.ts`).
 */
const props = defineProps<{
  limits: readonly ExplainedLimit[]
  unit: DistanceUnit
  /** Two items, held to each other; else one, held to its own sizes. */
  pair: boolean
  /** A net class's PCB color, CSS, for its tag where a source names one. */
  classColor?: (name: string) => string | undefined
}>()

/** A source or step's rule as the panel shows one: a class as its tag, a rule by its name. */
const sourceOf = (name: string): ReturnType<typeof warningSourceOf> =>
  warningSourceOf(name, props.classColor)

const { t } = useI18n()

const length = (mm: number): string => `${formatDistance(mm, props.unit)} ${props.unit}`

const valueOf = (limit: ExplainedLimit): string => {
  if (limit.sameNet) return t('pcbEditor.limits.sameNet')
  if (limit.connection) {
    const { style, gap, spokeWidth } = limit.connection
    return style === 'thermal'
      ? t('pcbEditor.limits.connection.thermal', { gap: length(gap), spoke: length(spokeWidth) })
      : style === 'solid'
        ? t('pcbEditor.limits.connection.solid')
        : t('pcbEditor.limits.connection.none')
  }
  if (limit.unset) return t('pcbEditor.limits.unset')
  const parts: string[] = []
  if (limit.min !== undefined) parts.push(t('pcbEditor.limits.min', { value: length(limit.min) }))
  if (limit.opt !== undefined) parts.push(t('pcbEditor.limits.opt', { value: length(limit.opt) }))
  if (limit.max !== undefined) parts.push(t('pcbEditor.limits.max', { value: length(limit.max) }))
  return parts.join(', ') || t('pcbEditor.limits.unset')
}

const nameOf = (limit: ExplainedLimit): string =>
  t(`pcbEditor.limits.constraint.${limit.constraint}`)

/** A step's outcome and value; its rule shows before it, as a tag or a name. */
const stepOf = (step: ExplainedLimit['steps'][number]): string =>
  [
    t(`pcbEditor.limits.outcome.${step.outcome}`),
    typeof step.value === 'number' ? length(step.value) : (step.value ?? '')
  ]
    .filter(Boolean)
    .join(' · ')
</script>

<template>
  <section class="limits" :title="t('pcbEditor.limits.hint')">
    <h3 class="eyebrow">{{ t('pcbEditor.limits.title') }}</h3>
    <p v-if="limits.length === 0" class="none">
      {{ pair ? t('pcbEditor.limits.none') : t('pcbEditor.limits.noneOne') }}
    </p>
    <details
      v-for="(limit, i) in limits"
      :key="`${limit.constraint}:${limit.layer ?? ''}:${i}`"
      class="limit"
    >
      <summary>
        <span class="name">
          {{ nameOf(limit) }}<span v-if="limit.layer" class="layer"> · {{ limit.layer }}</span>
        </span>
        <span class="value">{{ valueOf(limit) }}</span>
        <span class="source"><RuleSource :source="sourceOf(limit.source)" /></span>
      </summary>
      <ol v-if="limit.steps.length" class="steps" :aria-label="t('pcbEditor.limits.steps')">
        <li v-for="(step, j) in limit.steps" :key="j">
          <template v-if="step.rule"><RuleSource :source="sourceOf(step.rule)" /> · </template
          >{{ stepOf(step) }}
        </li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.limits {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 10px 12px;
}

/* Section eyebrow, as the property groups' titles. */
.eyebrow {
  margin: 0;
  padding-top: 2px;
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.none {
  margin: 0;
  color: var(--vscode-text-muted);
}

.limit summary {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 8px;
  padding: 2px 0;
  cursor: pointer;
  list-style: none;
}

.limit summary::-webkit-details-marker {
  display: none;
}

.layer,
.source {
  color: var(--vscode-text-muted);
}

.value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.source {
  grid-column: 1 / -1;
  font-size: var(--text-caption);
}

.steps {
  margin: 2px 0 6px;
  padding-left: 18px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}
</style>
