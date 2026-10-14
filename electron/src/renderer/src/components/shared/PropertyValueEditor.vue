<script setup lang="ts">
/**
 * One property *value* editor, independent of any layout.
 *
 * Extracted from PropertyTable so surfaces that are not a table can reuse the
 * editors themselves — the unit-aware distance/angle parsing, the MIXED
 * placeholder, the segmented pill, the color swatch. PropertyTable renders one
 * of these per row; Board Setup renders them inside explanatory setting cards.
 *
 * Division of labor: this component owns everything *within* one value —
 * display formatting, parse-and-commit, Enter semantics per kind (open the
 * dropdown, toggle the box, cycle the segments), ←/→ within a segmented pill,
 * and Escape reverting the text. It deliberately does NOT own focus order:
 * ↑/↓ are re-emitted as `navigate` so the host decides what a "next row" is,
 * and `focus()` is exposed so the host can drive a roving tabindex.
 */
import { computed, onBeforeUnmount, ref, watch, type Directive } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import NetClassTag from './NetClassTag.vue'
import {
  formatAngle,
  formatDistance,
  formatDistanceNm,
  hexToRgba,
  isMixed,
  parseAngle,
  parseDistance,
  parseDistanceNm,
  rgbaToHex,
  type DistanceUnit,
  type PropertyEditValue,
  type PropertyField,
  type Rgba,
  type SelectOption
} from '../../lib/propertyTable'
import { SEGMENT_GLYPHS } from '../../lib/propertyGlyphs'

const { t } = useI18n()

const props = defineProps<{
  field: PropertyField
  /** Unit the host's grid is in; distance cells format/parse against it. */
  distanceUnit?: DistanceUnit
  disabled?: boolean
  /**
   * Only to read (the visual diff, a read-only row): the value as text, with its swatch where it
   * has one — no field, caret, picker or segments. A checkbox stays, disabled:
   * the box is how a yes/no reads.
   */
  plain?: boolean
  /** Roving-tabindex value when the host manages focus order. */
  tabindex?: number
}>()

const emit = defineEmits<{
  (e: 'commit', value: PropertyEditValue): void
  (e: 'focus', target: EventTarget | null): void
  /** ↑/↓ pressed; the host moves focus (or ignores it). */
  (e: 'navigate', dir: 1 | -1): void
  /**
   * Escape abandoned the edit and the field is done with the keyboard, so the
   * host should take it back — in an editor, that means the canvas. Only fires
   * from the plain-field path: an OPEN dropdown handles its own Escape and
   * returns before reaching here, so the first press closes the list and a
   * second one leaves the field. One level per press, the Esc ladder the
   * canvas tools already follow.
   */
  (e: 'escape'): void
}>()

const unit = computed<DistanceUnit>(() => props.distanceUnit ?? 'mm')
const kind = computed(() => props.field.editor.kind)
const isDisabled = computed(() => !!props.plain || !!props.disabled || !!props.field.readonly)

// Only one branch renders, so a single shared ref always holds the live element.
const el = ref<HTMLElement | null>(null)

const focus = (): void => {
  const node = el.value
  node?.focus()
  if (node instanceof HTMLInputElement && (node.type === 'text' || node.type === 'number')) {
    node.select()
  }
}

/**
 * Focusing a text/number field selects its contents so typing replaces the
 * value — the spreadsheet behavior the table has always had. Intrinsic to the
 * control, so it lives here rather than in whichever host owns focus order.
 */
const onFocusIn = (target: EventTarget | null): void => {
  if (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number')) {
    target.select()
  }
  // Only while this cell holds focus, so no unfocused editor is listening — see
  // `onOutsideMouseDown` for why blur alone is not enough.
  window.addEventListener('mousedown', onOutsideMouseDown, true)
  emit('focus', target)
}

// The suffix shown inside a numeric input: the grid unit for distance, ° for
// angle, else the descriptor's explicit unit.
const unitSuffix = computed(() => {
  if (kind.value === 'distance') return unit.value
  if (kind.value === 'angle') return '°'
  return props.field.editor.unit ?? ''
})

const mixed = computed(() => isMixed(props.field.value))

/**
 * The typed text names its own unit ("2 mil", "45deg"): the suffix steps aside for it.
 * Until then it stays, so the unit the value is in is never lost while editing.
 */
const typedUnit = ref(false)
const onTyped = (input: HTMLInputElement): void => {
  typedUnit.value = /[^\d\s.,+\-eE]/.test(input.value)
}

/** The string shown in an input, converting distance/angle for display. */
/** An empty input's muted stand-in: the inherited distance, else the placeholder text. */
const inputPlaceholder = computed(() => {
  if (mixed.value) return '‹…›'
  const { placeholderValue, placeholder, model } = props.field.editor
  if (kind.value === 'distance' && placeholderValue !== undefined) {
    return model === 'nm'
      ? formatDistanceNm(placeholderValue, unit.value)
      : formatDistance(placeholderValue, unit.value)
  }
  return placeholder ?? ''
})

const textValue = computed(() => {
  const field = props.field
  if (isMixed(field.value) || field.value === null) return ''
  const { negate, scale, model } = field.editor
  if (kind.value === 'distance' && typeof field.value === 'number') {
    return model === 'nm'
      ? formatDistanceNm(field.value, unit.value, negate)
      : formatDistance(field.value, unit.value, negate)
  }
  if (kind.value === 'angle' && typeof field.value === 'number') {
    return formatAngle(field.value, scale ?? 1)
  }
  return String(field.value)
})

const selectValue = computed(() => (mixed.value ? '' : String(props.field.value)))

const currentOption = computed(() =>
  props.field.editor.options?.find((o) => o.value === selectValue.value)
)
/** The swatch for the current selection, when the options carry colors. */
const swatchColor = computed(() => currentOption.value?.color ?? '')
const currentLabel = computed(() => currentOption.value?.label ?? '')
/** The chosen option is a plain entry in a tags list ("New class…"). */
const currentOptionPlain = computed(
  () => props.field.editor.options?.find((o) => o.value === props.field.value)?.plain === true
)
/** Only selects whose options are colors, or net classes shown as tags, get the custom list. */
const hasSwatches = computed(
  () => !!props.field.editor.tags || !!props.field.editor.options?.some((o) => o.color)
)
/** A select left on its empty option, which an optional select's inherited value is. */
const selectInherits = computed(
  () => !!props.field.editor.optional && !mixed.value && selectValue.value === ''
)

// multiselect: the same list, where a pick toggles one option and the list
// stays open for the next. The value is the ticked options' values, comma-joined.
const isMulti = computed(() => kind.value === 'multiselect')
/** The options ticked now; none while the selection disagrees. */
const chosen = computed(
  () =>
    new Set(
      mixed.value || props.field.value === null
        ? []
        : String(props.field.value).split(',').filter(Boolean)
    )
)
const chosenOptions = computed(() =>
  (props.field.editor.options ?? []).filter((o) => chosen.value.has(o.value))
)
const isCurrent = (value: string): boolean =>
  isMulti.value ? chosen.value.has(value) : value === selectValue.value

/** Tick or untick one option; the last one ticked stays, as the value needs one. */
const toggleOption = (value: string): void => {
  const next = new Set(chosen.value)
  if (next.has(value)) {
    if (next.size === 1) return
    next.delete(value)
  } else next.add(value)
  const options = props.field.editor.options ?? []
  commitRaw(
    options
      .filter((o) => next.has(o.value))
      .map((o) => o.value)
      .join(',')
  )
}

const open = ref(false)
const activeIndex = ref(0)
/**
 * The popup is `position: fixed` and placed from the trigger's rect, because a
 * normally-positioned list would be clipped by any scrolling ancestor — the
 * stackup table scrolls horizontally, which would cut the color list in half.
 */
const listRect = ref({ top: 0, left: 0, width: 0 })

const closeList = (): void => {
  open.value = false
  window.removeEventListener('scroll', closeList, true)
  window.removeEventListener('resize', closeList)
  window.removeEventListener('mousedown', onDocumentDown, true)
}

function onDocumentDown(e: MouseEvent): void {
  if (!(e.target instanceof Node) || !el.value?.parentElement?.contains(e.target)) closeList()
}

const openList = (): void => {
  const rect = el.value?.getBoundingClientRect()
  if (!rect) return
  listRect.value = { top: rect.bottom + 2, left: rect.left, width: rect.width }
  const options = props.field.editor.options ?? []
  activeIndex.value = Math.max(
    0,
    options.findIndex((o) => isCurrent(o.value))
  )
  open.value = true
  // Capture-phase so a scroll in any ancestor closes it rather than detaching
  // the list from the control it belongs to.
  window.addEventListener('scroll', closeList, true)
  window.addEventListener('resize', closeList)
  window.addEventListener('mousedown', onDocumentDown, true)
}

const toggleOpen = (): void => {
  if (isDisabled.value) return
  if (open.value) closeList()
  else openList()
}

const choose = (value: string): void => {
  if (isMulti.value) {
    toggleOption(value)
    return
  }
  closeList()
  commitRaw(value)
  el.value?.focus()
}

const onSwatchKeydown = (e: KeyboardEvent): void => {
  const options = props.field.editor.options ?? []
  if (!open.value) {
    // Closed: ↑/↓ belong to the host's row navigation, as with any other cell.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      emit('navigate', e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openList()
    }
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const dir = e.key === 'ArrowDown' ? 1 : -1
    activeIndex.value = (activeIndex.value + dir + options.length) % options.length
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const opt = options[activeIndex.value]
    if (opt) choose(opt.value)
    return
  }
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeList()
  }
}

onBeforeUnmount(() => {
  closeList()
  window.removeEventListener('mousedown', onOutsideMouseDown, true)
})

const isChecked = computed(() => props.field.value === true)

/** A plain cell's text: what the editor would show, a choice by its label. */
const plainText = computed(() => {
  if (mixed.value) return '‹…›'
  if (isMulti.value) return chosenOptions.value.map((o) => o.label).join(', ')
  if (kind.value === 'select' || kind.value === 'segmented')
    return currentLabel.value || selectValue.value
  if (kind.value === 'color') return isColorUnset.value ? colorLabel.value : colorHex.value
  return textValue.value
})
/** The swatches a plain cell shows: a color's own, or the chosen options'. */
const plainSwatches = computed((): string[] => {
  if (kind.value === 'color') return isColorUnset.value ? [] : [colorHex.value]
  if (isMulti.value) return chosenOptions.value.flatMap((o) => (o.color ? [o.color] : []))
  return swatchColor.value ? [swatchColor.value] : []
})

// Color cells: the null/unset value and the swatch/hex the picker shows.
const colorValue = computed<Rgba | null>(() =>
  mixed.value || props.field.value === null ? null : (props.field.value as Rgba)
)
const colorHex = computed(() => {
  const c = colorValue.value
  return c ? rgbaToHex(c) : '#000000'
})
/** No swatch to show: either nothing is set, or the selection disagrees. */
const isColorUnset = computed(() => mixed.value || props.field.value === null)
/**
 * What an empty color cell reads as, and why the two cases must differ: `‹…›` is
 * the MIXED placeholder every other kind uses, so showing it for an unset color
 * made a single selected item look like several with disagreeing colors.
 * "Default" says the real thing — the item takes the theme's color.
 */
const colorLabel = computed(() =>
  mixed.value
    ? '‹…›'
    : (props.field.editor.placeholder ?? t('shared.propertiesPanel.colorInherited'))
)

const onColorInput = (input: HTMLInputElement): void => {
  emit('commit', hexToRgba(input.value, colorValue.value?.a ?? 1))
}

/**
 * A click anywhere in the cell opens the picker — except on the two children
 * that mean something else. The swatch IS the native input, so it opens itself
 * and a second call here would fight it; the clear button resets to Default,
 * and reopening the picker on top of that would undo the intent.
 */
const onColorCellClick = (event: MouseEvent): void => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('.color-swatch, .color-clear')) return
  openColorPicker()
}

/** Open the native picker from anywhere in the cell, not just the swatch. */
const openColorPicker = (): void => {
  if (isDisabled.value) return
  const node = el.value as (HTMLInputElement & { showPicker?: () => void }) | null
  if (node?.showPicker) node.showPicker()
  else node?.click()
}

// Checkbox indeterminate is a DOM property, not an attribute — bind it directly.
const vIndeterminate: Directive<HTMLInputElement, boolean> = {
  mounted: (node, binding) => (node.indeterminate = binding.value),
  updated: (node, binding) => (node.indeterminate = binding.value)
}

/**
 * The raw text this cell last emitted, so one edit reaches the host once even
 * though several paths can flush it — Enter, the outside-pointerdown flush, the
 * native `change`, and blur can all fire for a single typed value. Cleared when a
 * new value arrives from the host, which is what makes the next edit committable.
 */
let emittedRaw: string | null = null
watch(
  () => props.field.value,
  () => {
    emittedRaw = null
  }
)

/** Parse a raw input string per editor kind and emit it, dropping no-ops. */
const commitRaw = (raw: string): void => {
  const field = props.field
  if (raw === emittedRaw) return
  emittedRaw = raw
  const { negate, cardinal, scale, model } = field.editor
  // An optional override cleared: back to inheriting.
  if (
    field.editor.optional &&
    raw.trim() === '' &&
    (kind.value === 'number' || kind.value === 'distance')
  ) {
    if (field.value !== null) emit('commit', null)
    return
  }
  if (kind.value === 'number') {
    const n = Number(raw)
    if (raw.trim() === '' || Number.isNaN(n)) return
    if (!isMixed(field.value) && n === field.value) return
    emit('commit', n)
    return
  }
  if (kind.value === 'distance') {
    const parsed =
      model === 'nm'
        ? parseDistanceNm(raw, unit.value, negate)
        : parseDistance(raw, unit.value, negate)
    if (parsed === null) return
    if (!isMixed(field.value) && parsed === field.value) return
    emit('commit', parsed)
    return
  }
  if (kind.value === 'angle') {
    const deg = parseAngle(raw, scale ?? 1, cardinal)
    if (deg === null) return
    if (!isMixed(field.value) && deg === field.value) return
    emit('commit', deg)
    return
  }
  // text / select / segmented
  // The mixed placeholder; an optional select's empty option (inherit) commits.
  if (raw === '' && kind.value === 'select' && (mixed.value || !field.editor.optional)) return
  const text = kind.value === 'text' && !field.editor.skipTrim ? raw.trim() : raw
  // A trim that leaves the stored value unchanged triggers no re-render, so
  // `:value` never patches and the typed space would sit there looking accepted.
  if (text !== raw && el.value instanceof HTMLInputElement) el.value.value = text
  if (!isMixed(field.value) && text === field.value) return
  emit('commit', text)
}

const onCheckbox = (input: HTMLInputElement): void => emit('commit', input.checked)

/** Kinds whose value sits in a text box the user can walk away from mid-edit. */
const isTextual = computed(() => ['text', 'number', 'distance', 'angle'].includes(kind.value))

/**
 * Apply what is typed but not yet committed. Leaving a cell applies the edit —
 * Escape is how you abandon one — so this runs on blur and on any outside
 * mousedown.
 *
 * Skips an UNTOUCHED box, and that guard is load-bearing twice over: it is what
 * makes Escape an abort (the key restores the rendered text, so the blur that
 * follows sees nothing to apply), and it stops a MIXED field from committing its
 * empty placeholder over every selected item just because it was focused.
 */
/** A text field's native change, which fires as it is left: a commit, unless only Enter commits. */
const onTextChange = (input: HTMLInputElement): void => {
  if (!props.field.editor.commitOnEnter) commitRaw(input.value)
}

const flushPending = (): void => {
  if (props.field.editor.commitOnEnter) return
  const node = el.value
  if (!isTextual.value || !(node instanceof HTMLInputElement)) return
  if (node.value === textValue.value) return
  commitRaw(node.value)
}

/**
 * Apply before an outside click is HANDLED, not merely on blur.
 *
 * Blur is too late for a click on a canvas: an editor's own mousedown handler
 * changes the selection while the focus change — and the blur it implies — is
 * still the browser's pending default action, so a blur-time commit would land on
 * whatever that click just selected. A capture-phase document listener runs
 * before any element's handler, so the edit reaches the host first.
 */
function onOutsideMouseDown(e: MouseEvent): void {
  if (e.target instanceof Node && el.value?.contains(e.target)) return
  flushPending()
}

// A commit (Enter) shows the value formatted again, in the field's own unit.
watch(textValue, () => (typedUnit.value = false))

const onBlur = (): void => {
  typedUnit.value = false
  window.removeEventListener('mousedown', onOutsideMouseDown, true)
  flushPending()
}

/** The SVG path for a segment's icon, or undefined to show its text label. */
const glyphFor = (opt: SelectOption): string | undefined =>
  opt.icon ? SEGMENT_GLYPHS[opt.icon] : undefined

// Move a segmented field's selection one step (wrapping), committing the result.
// From MIXED it starts at the first/last option per direction.
const cycleSegment = (dir: 1 | -1): void => {
  const opts = props.field.editor.options ?? []
  if (!opts.length) return
  const cur = mixed.value ? -1 : opts.findIndex((o) => o.value === selectValue.value)
  const start = cur < 0 ? (dir === 1 ? 0 : opts.length - 1) : cur + dir
  const next = ((start % opts.length) + opts.length) % opts.length
  commitRaw(opts[next].value)
}

const onSegmentClick = (value: string): void => {
  commitRaw(value)
  focus()
}

/**
 * Exposed so a host can mirror a label click onto the value (whole-row hit).
 *
 * "Activate" means whatever the value's own click means, not merely focus: a
 * checkbox toggles, a color opens its picker. Anything else focuses and selects,
 * which is what a click on a text input does.
 */
const activate = (): void => {
  if (isDisabled.value) return
  const node = el.value
  if (kind.value === 'checkbox' && node instanceof HTMLInputElement) {
    node.checked = !node.checked
    onCheckbox(node)
  }
  focus()
  // After `focus`, so the roving tabindex lands on this row either way — and a
  // label click is still user activation by the time the host's nextTick runs,
  // which `showPicker()` requires.
  if (kind.value === 'color') openColorPicker()
  // A choice opens its list: activating a row whose value is a choice is
  // asking to choose.
  else if (kind.value === 'select' && hasSwatches.value) openList()
  else if (kind.value === 'select' && node instanceof HTMLSelectElement) {
    try {
      node.showPicker()
    } catch {
      // Not user activation after all (a keyboard path): focused is enough.
    }
  }
}
defineExpose({ focus, activate })

const onKeydown = (e: KeyboardEvent): void => {
  const target = e.target as HTMLElement
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // Take over native number-stepping / select-value-cycling as host navigation.
    e.preventDefault()
    emit('navigate', e.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && kind.value === 'segmented') {
    // ←/→ step within an all-options-visible toggle (rows stay on ↑/↓).
    e.preventDefault()
    cycleSegment(e.key === 'ArrowRight' ? 1 : -1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (kind.value === 'segmented') {
      cycleSegment(1)
    } else if (kind.value === 'select') {
      // Opens the native dropdown; while it's open its keys go to the popup, so
      // ↑/↓ cycle options there and host row-nav only resumes once it closes.
      const select = target as HTMLSelectElement & { showPicker?: () => void }
      select.showPicker?.()
    } else if (kind.value === 'checkbox') {
      const box = target as HTMLInputElement
      box.checked = !box.checked
      onCheckbox(box)
    } else if (kind.value === 'color') {
      // The native color picker opens on click; Enter here does nothing.
    } else {
      commitRaw((target as HTMLInputElement).value)
    }
    return
  }
  if (e.key === 'Escape') {
    // Keep the host editor's global cancel from clearing the whole selection.
    e.stopPropagation()
    if (target instanceof HTMLInputElement) target.value = textValue.value
    // Blur before handing over, so the pending-edit flush (which watches for an
    // outside mousedown) cannot re-apply the text Escape just reverted.
    ;(target as HTMLElement | null)?.blur?.()
    emit('escape')
    return
  }
}
</script>

<template>
  <!-- checkbox — the <label> spans the value cell so a click anywhere in it
       toggles, natively: no handler, no risk of double-toggling the box it
       wraps, and the keyboard/a11y behavior comes free. -->
  <span v-if="plain && kind !== 'checkbox'" class="plain-value" :title="plainText">
    <NetClassTag
      v-if="props.field.editor.tags && !mixed && plainText"
      :name="plainText"
      :color="swatchColor || null"
    />
    <template v-else>
      <span
        v-for="(color, i) in plainSwatches"
        :key="i"
        class="select-swatch"
        :style="{ backgroundColor: color }"
      />
      <span class="plain-text" :class="{ 'mixed-label': mixed }">{{ plainText }}</span>
      <span v-if="unitSuffix && plainText" class="plain-unit">{{ unitSuffix }}</span>
    </template>
  </span>

  <label v-else-if="kind === 'checkbox'" class="checkbox-cell" :class="{ disabled: isDisabled }">
    <input
      ref="el"
      v-indeterminate="mixed"
      class="cell-checkbox"
      type="checkbox"
      :checked="isChecked"
      :disabled="isDisabled"
      :tabindex="props.tabindex"
      @focus="onFocusIn($event.target)"
      @change="onCheckbox($event.target as HTMLInputElement)"
      @keydown="onKeydown"
    />
  </label>

  <!--
    select — two forms. Options carrying a swatch color (solder mask, layers)
    get a real listbox, because a native <option> cannot hold markup and styled
    option backgrounds only render on Linux/Windows (macOS draws a native popup
    that ignores them) — so comparing colors side by side is only possible with
    our own list. Everything else keeps the native <select>: it is cheaper,
    accessible for free, and indistinguishable to the user.
  -->
  <div v-else-if="(kind === 'select' && hasSwatches) || isMulti" class="swatch-select">
    <button
      ref="el"
      type="button"
      class="dense-select swatch-trigger"
      :disabled="isDisabled"
      :tabindex="props.tabindex"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @focus="onFocusIn($event.target)"
      @keydown="onSwatchKeydown"
      @click="toggleOpen"
    >
      <template v-if="isMulti">
        <span class="swatch-stack">
          <span
            v-for="opt in chosenOptions"
            :key="opt.value"
            class="select-swatch"
            :style="{ backgroundColor: opt.color }"
          />
        </span>
        <span class="swatch-label" :class="{ 'mixed-label': mixed }">{{
          mixed ? '‹…›' : chosenOptions.map((o) => o.label).join(', ')
        }}</span>
      </template>
      <span v-else-if="props.field.editor.tags" class="swatch-label">
        <template v-if="currentOptionPlain">{{ currentLabel }}</template>
        <NetClassTag v-else-if="currentLabel" :name="currentLabel" :color="swatchColor || null" />
      </span>
      <template v-else>
        <span class="select-swatch" :style="{ backgroundColor: swatchColor }" />
        <span class="swatch-label">{{ currentLabel }}</span>
      </template>
      <Icon name="chevron-down" class="select-caret" aria-hidden="true" />
    </button>

    <ul
      v-if="open"
      class="swatch-list"
      role="listbox"
      :aria-multiselectable="isMulti"
      :style="{
        top: `${listRect.top}px`,
        left: `${listRect.left}px`,
        width: `${listRect.width}px`
      }"
    >
      <li
        v-for="(opt, i) in props.field.editor.options"
        :key="opt.value"
        class="swatch-option"
        :class="{ active: i === activeIndex, current: isCurrent(opt.value) }"
        role="option"
        :aria-selected="isCurrent(opt.value)"
        @mouseenter="activeIndex = i"
        @mousedown.prevent="choose(opt.value)"
      >
        <span v-if="props.field.editor.tags" class="swatch-option-label">
          <template v-if="opt.plain">{{ opt.label }}</template>
          <NetClassTag v-else :name="opt.label" :color="opt.color ?? null" />
        </span>
        <template v-else>
          <span class="select-swatch" :style="{ backgroundColor: opt.color }" />
          <span class="swatch-option-label">{{ opt.label }}</span>
        </template>
        <Icon
          v-if="isMulti && isCurrent(opt.value)"
          name="check"
          class="swatch-check"
          aria-hidden="true"
        />
      </li>
    </ul>
  </div>

  <!-- The native caret sits wherever Chromium puts it; ours is the swatch
       select's chevron, on the same right edge as a unit suffix. -->
  <div v-else-if="kind === 'select'" class="select-with-caret">
    <select
      ref="el"
      class="dense-select"
      :class="{ inherits: selectInherits }"
      :value="selectValue"
      :disabled="isDisabled"
      :tabindex="props.tabindex"
      @focus="onFocusIn($event.target)"
      @change="commitRaw(($event.target as HTMLSelectElement).value)"
      @keydown="onKeydown"
    >
      <option v-if="mixed" value="" disabled>‹…›</option>
      <option v-for="opt in props.field.editor.options" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>
    <Icon name="chevron-down" class="select-caret" aria-hidden="true" />
  </div>

  <!-- segmented: an all-options-visible pill toggle (short 2–3 option sets) -->
  <div
    v-else-if="kind === 'segmented'"
    ref="el"
    class="dense-toggle segmented"
    role="radiogroup"
    :aria-disabled="isDisabled"
    :tabindex="props.tabindex"
    @focus="onFocusIn($event.target)"
    @keydown="onKeydown"
  >
    <button
      v-for="opt in props.field.editor.options"
      :key="opt.value"
      type="button"
      class="dense-toggle-btn"
      :class="{ active: selectValue === opt.value }"
      role="radio"
      :aria-checked="selectValue === opt.value"
      :aria-label="opt.label"
      :title="opt.label"
      :disabled="isDisabled"
      tabindex="-1"
      @mousedown.prevent
      @click="onSegmentClick(opt.value)"
    >
      <svg v-if="glyphFor(opt)" class="dense-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path :d="glyphFor(opt)" />
      </svg>
      <template v-else>{{ opt.label }}</template>
    </button>
  </div>

  <!-- color: swatch + native picker, with a clear-to-unset affordance -->
  <div
    v-else-if="kind === 'color'"
    class="color-cell"
    :class="{ disabled: isDisabled }"
    @click="onColorCellClick"
  >
    <input
      ref="el"
      class="color-swatch"
      :class="{ unset: isColorUnset }"
      type="color"
      :value="colorHex"
      :disabled="isDisabled"
      :tabindex="props.tabindex"
      @focus="onFocusIn($event.target)"
      @input="onColorInput($event.target as HTMLInputElement)"
      @keydown="onKeydown"
    />
    <!-- No handler of its own: the cell owns the click, so the label, the swatch
         and the empty space are one target. -->
    <span class="color-label">{{ isColorUnset ? colorLabel : colorHex }}</span>
    <!-- The only route back to the theme color: a native picker has no "unset"
         option, so once a color is chosen this button is what restores Default. -->
    <button
      v-if="!isColorUnset && !isDisabled"
      type="button"
      class="btn-outline btn-cell color-clear"
      :title="t('shared.propertiesPanel.colorReset')"
      tabindex="-1"
      @click="emit('commit', null)"
    >
      <Icon name="close-sm" />
    </button>
  </div>

  <!-- number / distance / angle (with unit label) -->
  <div
    v-else-if="kind === 'number' || kind === 'distance' || kind === 'angle'"
    class="input-with-unit"
    :class="{ 'has-unit': !!unitSuffix, 'typed-unit': typedUnit }"
  >
    <input
      ref="el"
      class="dense-input"
      :class="{ mixed }"
      :type="kind === 'number' ? 'number' : 'text'"
      :value="textValue"
      :placeholder="inputPlaceholder"
      :step="props.field.editor.step"
      :min="props.field.editor.min"
      :max="props.field.editor.max"
      :disabled="isDisabled"
      :tabindex="props.tabindex"
      @focus="onFocusIn($event.target)"
      @input="onTyped($event.target as HTMLInputElement)"
      @change="commitRaw(($event.target as HTMLInputElement).value)"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <span v-if="unitSuffix" class="unit-label">{{ unitSuffix }}</span>
  </div>

  <!-- text -->
  <input
    v-else
    ref="el"
    class="dense-input"
    :class="{ mixed }"
    type="text"
    :value="textValue"
    :placeholder="mixed ? '‹…›' : (props.field.editor.placeholder ?? '')"
    :disabled="isDisabled"
    :tabindex="props.tabindex"
    @focus="onFocusIn($event.target)"
    @change="onTextChange($event.target as HTMLInputElement)"
    @blur="onBlur"
    @keydown="onKeydown"
  />
</template>

<style scoped>
/*
 * Only styles INTRINSIC to a control live here — the ones true wherever the
 * editor is used. The surrounding skin (is it a borderless table cell or a
 * bordered field in a card?) belongs to the host: PropertyTable strips the
 * input's box with :deep() so the input *is* the cell, and Board Setup gives
 * the same editor its own treatment.
 */

/* Spaced as a table's input, so plain and editable cells line up. */
.plain-value {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  color: var(--vscode-text-light);
  font-size: var(--text-body-sm);
  font-family: var(--font-mono, monospace);
}

.plain-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plain-unit {
  flex: none;
  margin-left: auto;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

/*
 * One smart field: a single text input plus a muted unit hint sitting inside
 * its border. The hint shows the current unit (mm/mil/°); the field itself
 * parses `2`, `2mm`, `2 mil`, … and converts. On focus the hint fades so you
 * have the full width to type a value + unit.
 */
.input-with-unit {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 24px;
}

.input-with-unit.has-unit .dense-input {
  padding-right: 34px;
}

.unit-label {
  position: absolute;
  right: 8px;
  font-size: var(--text-caption);
  font-family: var(--font-mono, monospace);
  color: var(--vscode-text-muted);
  pointer-events: none;
  user-select: none;
  transition: opacity 0.1s ease;
}

/* A typed "2 mil" carries its own unit: the suffix gets out of its way. */
.input-with-unit.typed-unit .unit-label {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .unit-label {
    transition: none;
  }
}

.swatch-select {
  position: relative;
  display: block;
  width: 100%;
}

/* Wears the host's .dense-select skin so it is indistinguishable from a native
   select sitting next to it in the same table. */
.swatch-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  cursor: pointer;
}

.swatch-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * A select's caret, native or swatch: the chevron's glyph spans the middle half
 * of its 16px box, so the box overhangs the 8px right padding to put the glyph's
 * right edge on a unit suffix's ink (`.unit-label`, right: 8px, whose last
 * letter's side bearing leaves it 1px further in).
 */
.select-caret {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: -3px;
  opacity: 0.6;
}

.select-with-caret {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.select-with-caret .dense-select {
  appearance: none;
  padding-right: 24px;
}

.select-with-caret .select-caret {
  position: absolute;
  right: 8px;
  color: var(--vscode-text-light, #ffffff);
  pointer-events: none;
}

.select-with-caret .dense-select:disabled + .select-caret {
  opacity: 0.3;
}

.swatch-list {
  position: fixed;
  z-index: 60;
  max-height: 260px;
  overflow-y: auto;
  margin: 0;
  padding: 3px;
  list-style: none;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 4px;
  background-color: var(--vscode-input-bg);
  box-shadow: 0 6px 18px var(--vscode-shadow-float);
}

.swatch-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 3px;
  color: var(--vscode-text, #d6e2dc);
  font-size: 12px;
  cursor: pointer;
}

.swatch-option.current {
  color: var(--vscode-text-light, #ffffff);
}

.swatch-option.active {
  background-color: var(--vscode-bg-active, rgba(204, 162, 80, 0.14));
}

.swatch-option-label {
  flex: 1 1 auto;
}

.swatch-check {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  color: var(--vscode-accent, #cca250);
}

/* A multiselect's ticked swatches, overlapped like a deck so four layers
   still leave the label room. */
.swatch-stack {
  display: flex;
  flex: 0 0 auto;
}

.swatch-stack .select-swatch + .select-swatch {
  margin-left: -5px;
}

.mixed-label {
  color: var(--vscode-text-muted);
  font-style: italic;
}

.select-swatch {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 3px;
}

/* An optional select on its inherited value reads as an empty input's placeholder. */
.dense-select.inherits {
  color: var(--vscode-text-muted);
}

.dense-select.inherits option {
  color: var(--vscode-text-light, #ffffff);
}

.mixed::placeholder {
  color: var(--vscode-text-muted);
  font-style: italic;
}

/* The container is the one roving-tabindex focus target; buttons carry
   tabindex -1 and don't steal focus (mousedown prevented), so the host's ↑/↓
   still navigate and Enter/←/→ cycle options. */
.segmented:focus {
  outline: none;
  border-color: var(--vscode-accent, #cca250);
  box-shadow: 0 0 0 1px var(--vscode-accent, #cca250);
}

.dense-toggle-icon {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Color cell: a square swatch, the hex/unset label, and a clear button. */
/* Spans the value cell so a click anywhere in it toggles the box it wraps. */
.checkbox-cell {
  display: flex;
  align-items: center;
  height: 24px;
  cursor: pointer;
}

.checkbox-cell.disabled,
.color-cell.disabled {
  cursor: default;
}

/* The whole cell is the picker's target (`onColorCellClick`), so it takes the
   pointer; the hover PAINT is the row's, in PropertyTable, so hovering the
   label half looks identical to hovering this one. */
.color-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  cursor: pointer;
  /* No padding on the right: the clear button is a `btn-cell` and sits flush to
     the cell edge, lining up with the row-action column of every other row. */
  padding: 0 0 0 8px;
}

.color-swatch {
  width: 22px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  cursor: pointer;
  /* The checker sits BEHIND the color rather than around it, so it reads as
     what it is — a transparency backdrop — and shows through wherever the
     color does not cover. */
  background-image:
    linear-gradient(45deg, var(--vscode-bg-active) 25%, transparent 25%),
    linear-gradient(-45deg, var(--vscode-bg-active) 25%, transparent 25%);
  background-size: 8px 8px;
  background-position:
    0 0,
    4px 4px;
}

/* Chromium (the only engine here) insets an `input[type=color]`'s fill inside a
   padded wrapper with its own bordered swatch, so the color reads as a small
   chip floating in a larger control and the target looks smaller than it is.
   Flattening both makes the color the whole swatch. */
.color-swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}

/* No explicit color: hide the fill entirely so the checker below is the whole
   swatch, rather than a rim around a color the file does not actually carry. */
.color-swatch.unset::-webkit-color-swatch {
  opacity: 0;
}

.color-label {
  /* A hex triplet is data, so it is set in mono like every other value the
     panel reports — which also makes `tabular-nums` redundant, since a mono
     face already gives every digit one width. */
  font-family: var(--font-mono, monospace);
  /* Was 10px, under RULES.md §6's floor; raised on the way past. */
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
  /* Opens the picker, same as the swatch — the cell is one target. */
  cursor: pointer;
}

/* Sizing and paint come from `btn-outline btn-cell` (assets/main.css) — the
   same 24x24 square-cornered shape a row action uses, which is what gets it to
   DESIGN.md's minimum target. A bare glyph was legible and too small to hit. */
.color-clear {
  margin-left: auto;
  flex: 0 0 auto;
}
</style>
