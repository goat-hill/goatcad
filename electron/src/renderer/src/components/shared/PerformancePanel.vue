<script setup lang="ts">
/**
 * The findings drawer's Performance tab: how long the last run of each of an
 * editor's background tasks took, and where the time went. Each task's bar is
 * against the slowest task, so the costly one stands out; its steps' bars are
 * against the task itself, slowest first.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'

export interface PerformanceTask {
  id: string
  title: string
  /** What the run covered: all zones, the edit's region. */
  scope: string
  ms: number
  steps: Array<{ name: string; ms: number }>
}

const props = defineProps<{
  tasks: PerformanceTask[]
}>()

const { t } = useI18n()

/** Steps shown before a task's rest fold into one line. */
const SHOWN_STEPS = 8

const slowest = computed(() => Math.max(1, ...props.tasks.map((task) => task.ms)))
const open = ref(new Set<string>())
const toggle = (id: string): void => {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const stepsOf = (task: PerformanceTask): Array<{ name: string; ms: number }> =>
  [...task.steps].sort((a, b) => b.ms - a.ms)

const shown = (task: PerformanceTask): Array<{ name: string; ms: number }> => {
  const steps = stepsOf(task)
  return open.value.has(task.id) ? steps : steps.slice(0, SHOWN_STEPS)
}

const rest = (task: PerformanceTask): { count: number; ms: number } => {
  const hidden = stepsOf(task).slice(SHOWN_STEPS)
  return { count: hidden.length, ms: hidden.reduce((sum, step) => sum + step.ms, 0) }
}

const duration = (ms: number): string =>
  ms < 1000
    ? t('designHealth.performance.ms', { ms: Math.round(ms) })
    : t('designHealth.performance.seconds', { s: (ms / 1000).toFixed(ms < 10000 ? 2 : 1) })

const total = computed(() => props.tasks.reduce((sum, task) => sum + task.ms, 0))

const width = (ms: number, of: number): string => `${Math.max(0.5, (100 * ms) / of)}%`
</script>

<template>
  <div class="performance-panel">
    <p v-if="!tasks.length" class="performance-empty">{{ t('designHealth.performance.empty') }}</p>
    <div v-else class="total-line">
      <span>{{ t('designHealth.performance.total') }}</span>
      <span class="time">{{ duration(total) }}</span>
    </div>
    <section v-for="task in tasks" :key="task.id" class="task">
      <div class="task-line">
        <span class="task-title">{{ task.title }}</span>
        <span class="task-scope">{{ task.scope }}</span>
        <span class="bar-track">
          <span class="bar task-bar" :style="{ width: width(task.ms, slowest) }" />
        </span>
        <span class="time">{{ duration(task.ms) }}</span>
      </div>
      <div v-for="step in shown(task)" :key="step.name" class="step-line">
        <span class="step-name" :title="step.name">{{ step.name }}</span>
        <span class="bar-track">
          <span class="bar" :style="{ width: width(step.ms, task.ms) }" />
        </span>
        <span class="time">{{ duration(step.ms) }}</span>
      </div>
      <button
        v-if="rest(task).count > 0 || open.has(task.id)"
        type="button"
        class="step-line step-more"
        @click="toggle(task.id)"
      >
        <Icon name="chevron-right" class="chevron" :class="{ expanded: open.has(task.id) }" />
        <span class="step-name">{{
          open.has(task.id)
            ? t('designHealth.performance.fewer')
            : t('designHealth.performance.more', rest(task).count)
        }}</span>
        <span class="bar-track" />
        <span v-if="!open.has(task.id)" class="time">{{ duration(rest(task).ms) }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.performance-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 12px 8px;
}

/* The tasks' times together, in the time column. */
.total-line {
  display: flex;
  justify-content: space-between;
  min-height: 24px;
  align-items: center;
  font-weight: 600;
}

.performance-empty {
  margin: 4px 0;
  color: var(--vscode-text-muted);
}

/* One grid for a task and its steps, so every bar starts and ends in one column. */
.task-line,
.step-line {
  display: grid;
  grid-template-columns: minmax(96px, 160px) minmax(0, 120px) minmax(80px, 1fr) 64px;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.step-name {
  grid-column: span 2;
}

.task-title {
  font-weight: 600;
}

.task-scope,
.step-more {
  color: var(--vscode-text-muted);
}

.task-scope,
.step-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Under the task's title, as a finding sits under its rule. */
.step-line .step-name {
  padding-left: 16px;
  font-family: var(--font-mono, monospace);
}

.bar-track {
  height: 8px;
  border-radius: 2px;
  background: var(--vscode-bg-hover);
  overflow: hidden;
}

.bar {
  display: block;
  height: 100%;
  background: var(--vscode-text-muted);
}

.task-bar {
  background: var(--vscode-accent);
}

.time {
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
}

.step-more {
  width: 100%;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.step-more:hover {
  color: var(--vscode-text);
}

.step-more .step-name {
  font-family: inherit;
}

.chevron {
  position: absolute;
  width: 12px;
  height: 12px;
}

.step-more {
  position: relative;
}

.chevron.expanded {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: no-preference) {
  .chevron {
    transition: transform 0.12s ease;
  }
}
</style>
