import {
  computed,
  nextTick,
  reactive,
  ref,
  useTemplateRef,
  type ComputedRef,
  type Ref,
  type ShallowRef
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  compileQuery,
  findHits,
  findStepFor,
  FIND_TEXT_DEFAULTS,
  steppedHit,
  type FindCandidate,
  type FindHit,
  type FindTextOptions
} from './canvasFind'
import { matchesHotkey } from './hotkeys'

/** What `CanvasFindWidget` exposes to its editor. */
interface FindWidgetHandle {
  focus(): void
}

export interface CanvasFind<T> {
  state: { query: string; options: FindTextOptions }
  open: Ref<boolean>
  /** The editor's `CanvasFindWidget`, which its template names `ref="findWidget"`. */
  widget: Readonly<ShallowRef<FindWidgetHandle | null>>
  results: ComputedRef<FindHit<T>[]>
  invalid: ComputedRef<boolean>
  countLabel: ComputedRef<string>
  openFind(): void
  closeFind(): void
  step(delta: 1 | -1): void
  /** Ctrl/Cmd+F, F3 / Shift+F3 (⌘G / ⌘⇧G): true when the key was one of them. */
  keydown(event: KeyboardEvent): boolean
}

/**
 * Find for an editor with no replace (board, footprint, symbol): the widget's
 * query and switches, the hits over the texts the editor offers, and next /
 * previous. The editor shows a hit — selects what it names and reveals it —
 * and, when the widget closes, takes the keyboard back.
 */
export function useCanvasFind<T>(config: {
  candidates: () => readonly FindCandidate<T>[]
  show: (hit: FindHit<T>) => void
  /** Which way the editor's y runs, for reading order. */
  yDown: boolean
  /** A lone selected text, to seed the query from as a text editor does. */
  seed?: () => string
  onClose?: () => void
}): CanvasFind<T> {
  const { t } = useI18n()
  const state = reactive({ query: '', options: { ...FIND_TEXT_DEFAULTS } })
  const open = ref(false)
  const widget = useTemplateRef<FindWidgetHandle>('findWidget')
  const currentKey = ref<string | null>(null)

  const results = computed(() =>
    open.value ? findHits(config.candidates(), state.query, state.options, config.yDown) : []
  )
  const invalid = computed(
    () => open.value && !!state.query && !compileQuery(state.query, state.options)
  )
  const index = computed(() => results.value.findIndex((hit) => hit.key === currentKey.value))
  const countLabel = computed(() => {
    if (!state.query) return ''
    const total = results.value.length
    if (!total) return t('editorArea.find.noResults')
    return t('editorArea.find.results', { current: Math.max(index.value, 0) + 1, total })
  })

  const step = (delta: 1 | -1): void => {
    const list = results.value
    const next = steppedHit(index.value, delta, list.length)
    if (next < 0) return
    currentKey.value = list[next].key
    config.show(list[next])
  }

  const openFind = (): void => {
    const seed = config.seed?.() ?? ''
    if (seed && !seed.includes('\n')) state.query = seed
    open.value = true
    void nextTick(() => widget.value?.focus())
  }

  const closeFind = (): void => {
    open.value = false
    config.onClose?.()
  }

  const keydown = (event: KeyboardEvent): boolean => {
    if (matchesHotkey(event, 'editor.find')) {
      event.preventDefault()
      openFind()
      return true
    }
    const delta = findStepFor(event)
    if (!delta) return false
    event.preventDefault()
    if (!state.query) openFind()
    else {
      open.value = true
      step(delta)
    }
    return true
  }

  return {
    state,
    open,
    widget,
    results,
    invalid,
    countLabel,
    openFind,
    closeFind,
    step,
    keydown
  }
}
