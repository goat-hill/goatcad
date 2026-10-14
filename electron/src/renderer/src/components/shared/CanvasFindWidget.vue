<script setup lang="ts">
/**
 * The canvas editors' find bar, after the text editor's VS Code-style widget:
 * the query with its three switches, where the current hit stands, next and
 * previous, an optional scope, and — where the editor can write what it finds
 * (the schematic) — a replace row. The editor owns the search
 * (`lib/canvasFind.ts`); this draws it and reports the gestures. Enter steps
 * forward, Shift+Enter back, Escape closes.
 */
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import type { FindTextOptions } from '../../lib/canvasFind'

const query = defineModel<string>('query', { required: true })
const options = defineModel<FindTextOptions>('options', { required: true })
const replacement = defineModel<string>('replacement', { default: '' })
const replaceOpen = defineModel<boolean>('replaceOpen', { default: false })
const scope = defineModel<string>('scope', { default: '' })

const props = defineProps<{
  /** "3 of 9", "No results", or empty while there is no query. */
  countLabel: string
  hasMatches: boolean
  /** The query does not compile as a regular expression. */
  invalid: boolean
  /** Offers the replace row: an editor that can write what it finds. */
  canReplace?: boolean
  readOnly?: boolean
  /** Where the search looks, when the editor offers a choice. */
  scopes?: Array<{ value: string; label: string }>
  scopeTitle?: string
}>()

const emit = defineEmits<{
  (e: 'next'): void
  (e: 'previous'): void
  (e: 'replace'): void
  (e: 'replace-all'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const queryInput = ref<HTMLInputElement | null>(null)

const toggle = (key: keyof FindTextOptions): void => {
  options.value = { ...options.value, [key]: !options.value[key] }
}

// Enter and Escape stop here: the editor's own keys must not act on them too
// (Escape would drop the selection the widget just made).
const onQueryKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.shiftKey) emit('previous')
    else emit('next')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

const onReplaceKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) emit('replace-all')
    else emit('replace')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

const onScope = (event: Event): void => {
  scope.value = (event.target as HTMLSelectElement).value
}

/** Focus the query with its text selected, as Ctrl/Cmd+F does. */
const focus = (): void => {
  void nextTick(() => {
    queryInput.value?.focus()
    queryInput.value?.select()
  })
}

defineExpose({ focus })
</script>

<template>
  <div class="canvas-find" @mousedown.stop>
    <div class="find-row">
      <button
        v-if="props.canReplace"
        type="button"
        class="find-act"
        :aria-expanded="replaceOpen"
        :title="t('schematicEditor.find.toggleReplace')"
        @click="replaceOpen = !replaceOpen"
      >
        <Icon name="chevron-right" class="disclosure" :class="{ open: replaceOpen }" />
      </button>
      <div class="find-field" :class="{ invalid }">
        <input
          ref="queryInput"
          v-model="query"
          class="find-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('editorArea.find.placeholder')"
          @keydown="onQueryKeydown"
        />
        <button
          type="button"
          class="find-opt"
          :class="{ active: options.matchCase }"
          :title="t('editorArea.find.matchCase')"
          @click="toggle('matchCase')"
        >
          <span class="opt-glyph">Aa</span>
        </button>
        <button
          type="button"
          class="find-opt"
          :class="{ active: options.wholeWord }"
          :title="t('editorArea.find.matchWholeWord')"
          @click="toggle('wholeWord')"
        >
          <span class="opt-glyph underline">ab</span>
        </button>
        <button
          type="button"
          class="find-opt"
          :class="{ active: options.regex }"
          :title="t('editorArea.find.useRegex')"
          @click="toggle('regex')"
        >
          <span class="opt-glyph">.*</span>
        </button>
      </div>
      <span v-if="countLabel" class="find-count">{{ countLabel }}</span>
      <button
        type="button"
        class="find-act"
        :disabled="!hasMatches"
        :title="t('editorArea.find.previousMatch')"
        @click="emit('previous')"
      >
        <Icon name="chevron-up-sm" />
      </button>
      <button
        type="button"
        class="find-act"
        :disabled="!hasMatches"
        :title="t('editorArea.find.nextMatch')"
        @click="emit('next')"
      >
        <Icon name="chevron-down-sm" />
      </button>
      <select
        v-if="props.scopes?.length"
        class="field-sm find-scope"
        :value="scope"
        :title="props.scopeTitle"
        @change="onScope"
      >
        <option v-for="option in props.scopes" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <button
        type="button"
        class="find-act"
        :title="t('editorArea.find.close')"
        @click="emit('close')"
      >
        <Icon name="close-sm" />
      </button>
    </div>

    <div v-if="props.canReplace && replaceOpen && !readOnly" class="find-row replace-row">
      <div class="find-field">
        <input
          v-model="replacement"
          class="find-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('schematicEditor.find.replacePlaceholder')"
          @keydown="onReplaceKeydown"
        />
      </div>
      <button
        type="button"
        class="btn-outline btn-sm"
        :disabled="!hasMatches"
        @click="emit('replace')"
      >
        {{ t('schematicEditor.find.replace') }}
      </button>
      <button
        type="button"
        class="btn-outline btn-sm"
        :disabled="!hasMatches"
        @click="emit('replace-all')"
      >
        {{ t('schematicEditor.find.replaceAll') }}
      </button>
      <slot name="replace-options" />
    </div>

    <slot name="notice" />
  </div>
</template>

<style scoped>
/* Sits in the canvas's top-right slot (.canvas-top-right, canvasToolbar.css)
   in the top bar's chrome and height: 3px inset, 32px rows, 8px radius. */
.canvas-find {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
}

.find-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 32px;
}

.replace-row {
  padding-left: 30px;
}

.find-field {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 0 2px 0 4px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background-color: var(--vscode-input-bg);
}

.find-field:focus-within {
  border-color: var(--vscode-input-focus);
}

.find-field.invalid {
  border-color: var(--vscode-error);
}

.find-input {
  width: 150px;
  padding: 4px 2px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--vscode-text);
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
}

.find-opt,
.find-act {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.find-opt:hover,
.find-act:hover:not(:disabled) {
  background-color: var(--vscode-bg-hover);
  color: var(--vscode-text);
}

.find-opt.active {
  border-color: var(--vscode-accent);
  background-color: var(--vscode-bg-active);
  color: var(--vscode-text-light);
}

.find-act {
  width: 28px;
  height: 28px;
}

.find-act:disabled {
  opacity: 0.4;
  cursor: default;
}

.find-act :deep(svg) {
  width: 14px;
  height: 14px;
}

.opt-glyph {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: 600;
  line-height: 1;
}

.opt-glyph.underline {
  text-decoration: underline;
}

.find-count {
  padding: 0 4px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.find-scope {
  max-width: 96px;
}

/* Classes an editor's slotted rows take: `.find-check` for a switch beside the
   replace buttons, `.find-row.notice-row` with `.notice-glyph` / `.notice-text`
   for a row that asks before acting. */
:slotted(.find-row) {
  display: flex;
  align-items: center;
  gap: 4px;
}

:slotted(.find-check) {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  color: var(--vscode-text-muted);
  cursor: pointer;
  white-space: nowrap;
}

:slotted(.find-check input) {
  margin: 0;
  accent-color: var(--vscode-accent);
}

:slotted(.notice-row) {
  padding-left: 28px;
}

:slotted(.notice-glyph) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--vscode-warning);
}

:slotted(.notice-text) {
  max-width: 320px;
}
</style>
