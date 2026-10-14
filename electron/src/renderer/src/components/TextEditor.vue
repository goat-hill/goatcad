<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchesHotkey } from '../lib/hotkeys'
import { findStepFor } from '../lib/canvasFind'
import Icon from './shared/Icon.vue'

const { t } = useI18n()

const props = defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  /** A user edit landed (drives EditorArea's dirty tracking). */
  (e: 'change'): void
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const backdrop = ref<HTMLDivElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null)

// ----------------------------------------------------
// Find widget state
// ----------------------------------------------------
const findOpen = ref(false)
const query = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const useRegex = ref(false)

interface MatchRange {
  start: number
  end: number
}

const matches = ref<MatchRange[]>([])
const currentIndex = ref(0)
// A malformed regex (while the user is still typing one) shouldn't throw;
// the widget just shows zero matches and flags the field.
const regexError = ref(false)

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const computeMatches = (text: string): MatchRange[] => {
  regexError.value = false
  if (!query.value) return []
  let pattern = useRegex.value ? query.value : escapeRegExp(query.value)
  if (wholeWord.value) pattern = `\\b(?:${pattern})\\b`
  let re: RegExp
  try {
    re = new RegExp(pattern, caseSensitive.value ? 'g' : 'gi')
  } catch {
    regexError.value = true
    return []
  }
  const found: MatchRange[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Zero-width matches (e.g. an empty regex alternative) would loop forever.
    if (m.index === re.lastIndex) re.lastIndex++
    else found.push({ start: m.index, end: m.index + m[0].length })
    // Guard against pathological queries on multi-MB files.
    if (found.length >= 20000) break
  }
  return found
}

// keepPosition is set when the document itself changed underneath an open
// widget: recompute the highlights but never touch the caret/scroll, so typing
// in the textarea isn't yanked around. A false value (open, or query/option
// change) re-anchors on the caret and reveals the current match.
const refreshMatches = (keepPosition = false): void => {
  const caret = textarea.value?.selectionStart ?? 0
  const next = computeMatches(props.modelValue)
  matches.value = next
  if (!next.length) {
    currentIndex.value = 0
    return
  }
  if (keepPosition) {
    if (currentIndex.value >= next.length) currentIndex.value = next.length - 1
    return
  }
  // Land on the first match at or after the caret, VS Code style.
  const at = next.findIndex((r) => r.start >= caret)
  currentIndex.value = at === -1 ? 0 : at
  void nextTick(scrollCurrentIntoView)
}

// ----------------------------------------------------
// Highlight overlay
// ----------------------------------------------------
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const highlightedHtml = computed(() => {
  const text = props.modelValue
  const ms = matches.value
  if (!ms.length) return escapeHtml(text)
  let out = ''
  let last = 0
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]
    out += escapeHtml(text.slice(last, m.start))
    const cls = i === currentIndex.value ? 'te-match te-match-current' : 'te-match'
    out += `<mark class="${cls}">${escapeHtml(text.slice(m.start, m.end))}</mark>`
    last = m.end
  }
  out += escapeHtml(text.slice(last))
  // A trailing newline needs a trailing space so the last (empty) line has a
  // box the same height as the textarea's — otherwise the two drift by a row.
  return out + (text.endsWith('\n') ? ' ' : '')
})

const syncScroll = (): void => {
  const ta = textarea.value
  const bd = backdrop.value
  if (!ta || !bd) return
  bd.scrollTop = ta.scrollTop
  bd.scrollLeft = ta.scrollLeft
}

const scrollCurrentIntoView = (): void => {
  const ta = textarea.value
  const bd = backdrop.value
  if (!ta || !bd) return
  const mark = bd.querySelector<HTMLElement>('.te-match-current')
  if (!mark) return
  const markTop = mark.offsetTop
  const markBottom = markTop + mark.offsetHeight
  const viewTop = ta.scrollTop
  const viewBottom = viewTop + ta.clientHeight
  if (markTop < viewTop) {
    ta.scrollTop = Math.max(0, markTop - ta.clientHeight / 3)
  } else if (markBottom > viewBottom) {
    ta.scrollTop = markBottom - ta.clientHeight + ta.clientHeight / 3
  }
  // Keep the current match selected so Escape drops the caret on it.
  ta.setSelectionRange(
    matches.value[currentIndex.value].start,
    matches.value[currentIndex.value].end
  )
  syncScroll()
}

// ----------------------------------------------------
// Navigation
// ----------------------------------------------------
const findNext = (): void => {
  if (!matches.value.length) return
  currentIndex.value = (currentIndex.value + 1) % matches.value.length
  void nextTick(scrollCurrentIntoView)
}

const findPrev = (): void => {
  if (!matches.value.length) return
  currentIndex.value = (currentIndex.value - 1 + matches.value.length) % matches.value.length
  void nextTick(scrollCurrentIntoView)
}

const countLabel = computed(() => {
  if (!query.value) return ''
  if (!matches.value.length) return t('editorArea.find.noResults')
  return t('editorArea.find.results', {
    current: currentIndex.value + 1,
    total: matches.value.length
  })
})

// Recompute whenever the query or an option changes.
watch([query, caseSensitive, wholeWord, useRegex], () => refreshMatches())
// Keep the overlay aligned as the document changes while find is open.
watch(
  () => props.modelValue,
  () => {
    if (findOpen.value) refreshMatches(true)
  }
)

// ----------------------------------------------------
// Open / close
// ----------------------------------------------------
const openFind = (): void => {
  const ta = textarea.value
  const selected =
    ta && ta.selectionStart !== ta.selectionEnd
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : ''
  // A one-line selection seeds the query (VS Code); ignore multi-line ones.
  if (selected && !selected.includes('\n')) query.value = selected
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
    refreshMatches()
  })
}

const closeFind = (): void => {
  findOpen.value = false
  matches.value = []
  textarea.value?.focus()
}

const toggleCase = (): void => {
  caseSensitive.value = !caseSensitive.value
}
const toggleWholeWord = (): void => {
  wholeWord.value = !wholeWord.value
}
const toggleRegex = (): void => {
  useRegex.value = !useRegex.value
}

// ----------------------------------------------------
// Input plumbing
// ----------------------------------------------------
const onInput = (e: Event): void => {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  emit('change')
}

const onWrapKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'editor.find')) {
    e.preventDefault()
    openFind()
    return
  }
  // F3 / Shift+F3 (⌘G / ⌘⇧G): the canvas editors' find next and previous, here too.
  const step = findStepFor(e)
  if (!step) return
  e.preventDefault()
  if (!findOpen.value || !query.value) openFind()
  else if (step > 0) findNext()
  else findPrev()
}

const onFindKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) findPrev()
    else findNext()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
}
</script>

<template>
  <div class="te-wrap" @keydown="onWrapKeydown">
    <!-- VS Code-style find widget, pinned to the top-left of the editor -->
    <div v-if="findOpen" class="te-find">
      <div class="te-find-field" :class="{ 'te-find-error': regexError }">
        <input
          ref="findInput"
          v-model="query"
          class="te-find-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('editorArea.find.placeholder')"
          @keydown="onFindKeydown"
        />
        <div class="te-find-options">
          <button
            type="button"
            class="te-opt"
            :class="{ active: caseSensitive }"
            :title="t('editorArea.find.matchCase')"
            @click="toggleCase"
          >
            <span class="te-opt-glyph">Aa</span>
          </button>
          <button
            type="button"
            class="te-opt"
            :class="{ active: wholeWord }"
            :title="t('editorArea.find.matchWholeWord')"
            @click="toggleWholeWord"
          >
            <span class="te-opt-glyph te-opt-underline">ab</span>
          </button>
          <button
            type="button"
            class="te-opt"
            :class="{ active: useRegex }"
            :title="t('editorArea.find.useRegex')"
            @click="toggleRegex"
          >
            <span class="te-opt-glyph">.*</span>
          </button>
        </div>
      </div>

      <div class="te-find-count">{{ countLabel }}</div>

      <div class="te-find-actions">
        <button
          type="button"
          class="te-act"
          :disabled="!matches.length"
          :title="t('editorArea.find.previousMatch')"
          @click="findPrev"
        >
          <Icon name="chevron-up-sm" />
        </button>
        <button
          type="button"
          class="te-act"
          :disabled="!matches.length"
          :title="t('editorArea.find.nextMatch')"
          @click="findNext"
        >
          <Icon name="chevron-down-sm" />
        </button>
        <button type="button" class="te-act" :title="t('editorArea.find.close')" @click="closeFind">
          <Icon name="close-sm" />
        </button>
      </div>
    </div>

    <div class="te-body">
      <!-- Safe: highlightedHtml is built only from escapeHtml()'d document text
           plus our own <mark> wrappers — no unescaped user content reaches it. -->
      <!-- eslint-disable vue/no-v-html -->
      <div
        v-if="findOpen"
        ref="backdrop"
        class="te-backdrop"
        aria-hidden="true"
        v-html="highlightedHtml"
      ></div>
      <!-- eslint-enable vue/no-v-html -->
      <textarea
        ref="textarea"
        class="te-textarea"
        spellcheck="false"
        :value="modelValue"
        :placeholder="placeholder"
        @input="onInput"
        @scroll="syncScroll"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
.te-wrap {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  display: flex;
  min-height: 0;
}

.te-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

/* The overlay and the textarea MUST share identical text metrics and box
   geometry, or the highlight rectangles drift from the glyphs. Any change to
   one must be mirrored in the other. */
.te-backdrop,
.te-textarea {
  position: absolute;
  inset: 0;
  margin: 0;
  border: 0;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: normal;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  /* The vertical scrollbar takes layout width (10px, see base.css). Reserving
     the gutter on BOTH layers keeps their wrap width equal — without it the
     textarea rewraps 10px narrower once it scrolls and the highlights drift. */
  scrollbar-gutter: stable;
}

.te-backdrop {
  overflow: hidden;
  color: transparent;
  pointer-events: none;
  z-index: 1;
}

.te-textarea {
  background-color: transparent;
  color: var(--vscode-source-text);
  resize: none;
  outline: none;
  overflow: auto;
  z-index: 2;
}

/* The <mark>s live inside the v-html backdrop, so they never get this
   component's scoped data-attribute — plain `.te-match` rules would miss them
   and the browser's default yellow <mark> would show through. :deep() pierces
   the scope so the gold wash (and the current-match emphasis) actually land. */
.te-backdrop :deep(.te-match) {
  border-radius: 2px;
  /* Softer wash for the non-current hits (VS Code's findMatchHighlight). */
  background-color: var(--vscode-accent-find);
  box-shadow: 0 0 0 1px var(--vscode-accent-border);
  color: transparent;
}

.te-backdrop :deep(.te-match-current) {
  background-color: var(--vscode-accent-find-current);
  box-shadow: 0 0 0 1px var(--vscode-accent);
}

/* ---- Find widget chrome ---- */
.te-find {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background-color: var(--vscode-bg-dropdown);
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px var(--vscode-shadow-float);
}

.te-find-field {
  display: flex;
  align-items: center;
  gap: 4px;
  background-color: var(--vscode-input-bg);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  padding: 0 4px;
}

.te-find-field:focus-within {
  border-color: var(--vscode-input-focus);
}

.te-find-error {
  border-color: var(--vscode-error);
}

.te-find-input {
  width: 180px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--vscode-text);
  font-size: 12px;
  font-family: var(--font-mono);
  padding: 4px 2px;
}

.te-find-options {
  display: flex;
  align-items: center;
  gap: 1px;
}

.te-opt {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.te-opt:hover {
  background-color: var(--vscode-bg-hover);
  color: var(--vscode-text);
}

.te-opt.active {
  background-color: var(--vscode-bg-active);
  border-color: var(--vscode-accent);
  color: var(--vscode-text-light);
}

.te-opt-glyph {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-family: var(--font-mono);
}

.te-opt-underline {
  text-decoration: underline;
}

.te-find-count {
  min-width: 52px;
  text-align: center;
  font-size: 11px;
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.te-find-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}

.te-act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.te-act:hover:not(:disabled) {
  background-color: var(--vscode-bg-hover);
  color: var(--vscode-text-light);
}

.te-act:disabled {
  opacity: 0.4;
  cursor: default;
}

.te-act svg {
  width: 14px;
  height: 14px;
}
</style>
