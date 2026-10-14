<script lang="ts">
import { ref as moduleRef } from 'vue'

// The splits, as shares of what they divide — simple ratios, so the sheet reads as laid out at
// any window size — kept for the session so every chooser opens as the last was left.
/** List | preview, 2 : 3: the list wide enough for name and description, the preview the more. */
const listShare = moduleRef(2 / 5)
/** Name | Description, 1 : 1; the badges take only what they need. */
const nameShare = moduleRef(1 / 2)
/** A symbol over its details over its footprint, 3 : 1 : 2. */
const symbolDetailsShare = moduleRef(1 / 6)
const symbolSlotsShare = moduleRef(1 / 3)
/** A footprint's previews over its details, 3 : 1. */
const footprintDetailsShare = moduleRef(1 / 4)
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import ResizeHandle from './ResizeHandle.vue'
import LibraryLeafIndicators from '../LibraryLeafIndicators.vue'
import type { IconName } from '../../lib/icons'
import ComponentSymbolViewer from '../ComponentSymbolViewer.vue'
import ComponentFootprintViewer from '../ComponentFootprintViewer.vue'
import FootprintViewport3D from '../footprint/FootprintViewport3D.vue'
import {
  chooseRows,
  symbolFit,
  type ChooserGroup,
  type ChooserItem,
  type ChooserKind,
  type ChooserRow,
  type ChooserScope
} from '../../lib/libraryChooser'
import {
  findFootprint,
  findSymbol,
  footprintFilterMatcher,
  indexLoaded,
  loadIndex,
  type IndexRecord
} from '../../lib/libraryIndex'
import { libraryRecents, loadLibraryRecents, noteLibraryPick } from '../../lib/libraryRecents'
import { chooserIndexItems } from '../../lib/libraryChooserIndex'
import {
  loadLibraryFootprint,
  loadLibrarySymbol,
  previewReference,
  readFootprintFile,
  withPreviewFields,
  type PreviewFields
} from '../../lib/libraryLoad'
import { footprintsForSymbol, modelsForFootprint } from '../../lib/componentAssociations'
import ComponentSlotHead from '../ComponentSlotHead.vue'
import PartDetails from './PartDetails.vue'
import PaneSplit from './PaneSplit.vue'
import { matchPinsToPads, pinPadNumbers, type PinRef } from '../../lib/pinPadMatch'
import { datasheetUrl } from '../../lib/schematic/datasheet'
import { hotkeyLabel, matchesHotkey } from '../../lib/hotkeys'
import type { KicadFootprint } from '../../lib/kicad/footprint'
import { getLibSymbolProperty, type KicadLibSymbol } from '../../lib/kicad/schematic'

/**
 * The one library chooser (docs/libraries-workstream.md): search, rank
 * and preview symbols, power ports or footprints, and answer with a lib id.
 * The host says what is being chosen for and what the primary button does;
 * the index supplies the libraries and `extraItems` what only the host knows
 * (a design's embedded symbols).
 */
const props = withDefaults(
  defineProps<{
    kind: ChooserKind
    /** The command that opened it, as its button names it: "Place symbol", "Choose footprint". */
    title: string
    /** That command's tool glyph, beside the title. */
    icon?: IconName
    /** The primary button: Place, Assign, Change. */
    verb: string
    /** What the pick is for, shown after the title ("TP8 · TestPoint"). */
    target?: string
    /** Items ahead of the index's, winning a lib-id clash. */
    extraItems?: ChooserItem[]
    /** Lib ids the open design already uses. */
    inDesign?: readonly string[]
    /** Symbols: footprints the design already uses, listed first in the preview's picker. */
    designFootprints?: readonly string[]
    /** Footprints: the symbol being fitted — its footprint filters and pins. */
    fit?: { filters: string[]; pins: PinRef[] } | null
    /** The current value, highlighted on open. */
    initialId?: string
    /** A symbol's definition where the index cannot read it (embedded in a sheet). */
    resolveSymbol?: (id: string) => Promise<KicadLibSymbol[] | null>
    /**
     * Footprints: the Reference and Value a highlighted footprint would carry
     * once placed (`TP8`, `H1`), shown in its previews in place of `REF**`.
     */
    fieldsFor?: (footprint: KicadFootprint, id: string) => PreviewFields
  }>(),
  {
    target: '',
    icon: undefined,
    extraItems: () => [],
    inDesign: () => [],
    designFootprints: () => [],
    fit: null,
    initialId: '',
    resolveSymbol: undefined,
    fieldsFor: undefined
  }
)

const emit = defineEmits<{
  /** `footprint`: a symbol's footprint picked in the preview, when it differs from its own. */
  (event: 'pick', id: string, choice?: { footprint: string }): void
  (event: 'close'): void
  /** A pane head's Open: show this record in its own read-only tab. */
  (event: 'open', record: IndexRecord): void
}>()

const { t } = useI18n()

/** Rows drawn per open group; past it the group says how many more. */
const GROUP_CAP = 200
/** Rows a search opens groups for, in order, before leaving the rest shut. */
const SEARCH_OPEN_ROWS = 200
const QUERY_SETTLE_MS = 60

const search = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const query = ref('')
const settledQuery = ref('')
const indexTick = ref(0)
/** The keyboard cursor: a group heading (its key) or a row (`<group key>|<lib id>`). */
const activeKey = ref<string | null>(null)
const expanded = ref<ReadonlySet<string>>(new Set())

let settleTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (value) => {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => (settledQuery.value = value), QUERY_SETTLE_MS)
})

/** The index's items of this kind, prepared when the index loaded (`libraryChooserIndex.ts`). */
const indexItems = computed<ChooserItem[]>(() => {
  void indexTick.value
  return chooserIndexItems(props.kind)
})

const items = computed<ChooserItem[]>(() => [...props.extraItems, ...indexItems.value])

const fitTest = computed(() => {
  if (props.kind !== 'footprint' || !props.fit) return undefined
  const filter = footprintFilterMatcher(props.fit.filters)
  return symbolFit(filter, pinPadNumbers(props.fit.pins).size)
})

const recent = computed(() => libraryRecents(props.kind))
const inDesign = computed(() => new Set(props.inDesign))

const groups = computed<ChooserGroup[]>(() =>
  chooseRows(items.value, {
    query: settledQuery.value,
    inDesign: inDesign.value,
    recent: recent.value,
    ...(fitTest.value ? { fit: fitTest.value } : {})
  })
)

const rowKey = (group: ChooserGroup, row: ChooserRow): string => `${group.key}|${row.item.id}`

const isOpen = (group: string): boolean => expanded.value.has(group)

const toggleGroup = (group: string): void => {
  const next = new Set(expanded.value)
  if (next.has(group)) next.delete(group)
  else next.add(group)
  expanded.value = next
  activeKey.value = group
}

// Groups start shut, bar the one holding the current value. A search opens the
// groups it found, best first, until about a screenful of rows is open — so
// typing and Enter still take the best match without a one-letter search
// drawing every library.
const resetExpanded = (): void => {
  if (settledQuery.value.trim()) {
    const open = new Set<string>()
    let rows = 0
    for (const group of groups.value) {
      if (rows >= SEARCH_OPEN_ROWS) break
      open.add(group.key)
      rows += Math.min(group.count, GROUP_CAP)
    }
    expanded.value = open
    return
  }
  const current = props.initialId
    ? groups.value.find((group) => group.rows().some((row) => row.item.id === props.initialId))
    : undefined
  expanded.value = new Set(current ? [current.key] : [])
}
watch(settledQuery, (query) => {
  resetExpanded()
  // A new search reads from the top and highlights its best match.
  if (list.value) list.value.scrollTop = 0
  if (query.trim())
    void nextTick(() => (activeKey.value = stops.value.find((key) => key.includes('|')) ?? null))
})

/** What the keyboard moves over: every heading, and the drawn rows of open groups. */
const stops = computed<string[]>(() =>
  groups.value.flatMap((group) => [
    group.key,
    ...(isOpen(group.key)
      ? group
          .rows()
          .slice(0, GROUP_CAP)
          .map((row) => rowKey(group, row))
      : [])
  ])
)

const rowByKey = computed(
  () =>
    new Map(
      groups.value
        .filter((group) => isOpen(group.key))
        .flatMap((group) => group.rows().map((row) => [rowKey(group, row), row] as const))
    )
)

/** The highlighted row; null on a heading. */
const active = computed<ChooserRow | null>(() =>
  activeKey.value ? (rowByKey.value.get(activeKey.value) ?? null) : null
)

/** The key of a lib id's first row, for highlighting the current value. */
const firstRowKey = (id: string): string | undefined => {
  for (const group of groups.value)
    for (const row of group.rows()) if (row.item.id === id) return rowKey(group, row)
  return undefined
}

watch(stops, (next) => {
  if (activeKey.value && next.includes(activeKey.value)) return
  // A search lands on its best match; otherwise the first heading.
  const firstRow = next.find((key) => key.includes('|'))
  activeKey.value = (settledQuery.value.trim() && firstRow) || next[0] || null
})

/** The index record behind a row, for the Library manager's availability columns. */
const recordOf = (item: ChooserItem): IndexRecord | undefined =>
  props.kind === 'footprint' ? findFootprint(item.id) : findSymbol(item.id)

const groupLabel = (group: ChooserGroup): string => {
  if (group.section === 'design') return t('shared.libraryChooser.sections.design')
  if (group.section === 'recent') return t('shared.libraryChooser.sections.recent')
  if (group.section === 'fits') return t('shared.libraryChooser.sections.fits')
  return group.library ?? ''
}

const scopeLabel = (scope: ChooserScope): string => {
  switch (scope) {
    case 'design':
      return t('shared.libraryChooser.scopes.design')
    case 'project':
      return t('shared.libraryChooser.scopes.project')
    case 'global':
      return t('shared.libraryChooser.scopes.global')
  }
  return t('shared.libraryChooser.scopes.system')
}

/** The keys that bring the search back, as the tooltip names them. */
const searchKeys = `${hotkeyLabel('editor.focusSearch')}, ${hotkeyLabel('editor.find')}`

const placeholder = computed(() =>
  props.kind === 'footprint'
    ? t('shared.libraryChooser.search.footprint')
    : props.kind === 'power'
      ? t('shared.libraryChooser.search.power')
      : t('shared.libraryChooser.search.symbol')
)

// ---- preview -------------------------------------------------------------

const previewFootprint = shallowRef<KicadFootprint | null>(null)
const previewChain = shallowRef<KicadLibSymbol[] | null>(null)
/**
 * A symbol's footprints (`componentAssociations.ts`, as the Component view
 * lists them): the one it assigns, then those its filters match. `assigned` is
 * its Footprint field; '' for a generic part, whose list starts at none.
 */
const symbolFootprints = shallowRef<{ assigned: string; candidates: string[] } | null>(null)
/** The footprint picked in the preview: the assigned one until changed, '' for none. */
const chosenFootprint = ref('')
/** The picked footprint, previewed under the symbol in 2D and 3D. */
const symbolFootprint = shallowRef<{
  id: string
  footprint: KicadFootprint | null
  file: string | null
  loading: boolean
} | null>(null)
const previewState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
let previewToken = 0

const PREVIEW_SETTLE_MS = 90
let previewTimer: ReturnType<typeof setTimeout> | undefined

const loadSymbolFootprint = async (id: string, token = previewToken): Promise<void> => {
  if (!id) {
    symbolFootprint.value = null
    return
  }
  const file = findFootprint(id)?.file ?? null
  symbolFootprint.value = { id, footprint: null, file, loading: !!file }
  const footprint = file ? await loadLibraryFootprint(id) : null
  if (token !== previewToken || chosenFootprint.value !== id) return
  symbolFootprint.value = { id, footprint, file, loading: false }
}

const chooseFootprint = (id: string): void => {
  chosenFootprint.value = id
  void loadSymbolFootprint(id)
}

const loadPreview = async (item: ChooserItem | null): Promise<void> => {
  const token = ++previewToken
  previewFootprint.value = null
  previewChain.value = null
  symbolFootprint.value = null
  symbolFootprints.value = null
  chosenFootprint.value = ''
  if (!item) {
    previewState.value = 'idle'
    return
  }
  previewState.value = 'loading'
  try {
    if (props.kind === 'footprint') {
      const footprint = item.file ? await readFootprintFile(item.file) : null
      if (token !== previewToken) return
      previewFootprint.value = footprint
      previewState.value = footprint ? 'ready' : 'failed'
    } else {
      const chain =
        (props.resolveSymbol ? await props.resolveSymbol(item.id) : null) ??
        (await loadLibrarySymbol(item.id))
      if (token !== previewToken) return
      previewChain.value = chain
      previewState.value = chain ? 'ready' : 'failed'
      // The definition being placed speaks first; its library record fills in.
      const record = findSymbol(item.id)
      const field = (key: string): string | undefined =>
        chain ? getLibSymbolProperty(chain[0], key)?.trim() : undefined
      const assigned = field('Footprint') ?? record?.footprint ?? ''
      const filters =
        field('ki_fp_filters')?.split(/\s+/).filter(Boolean) ?? record?.fpFilters ?? []
      const candidates = footprintsForSymbol({ footprint: assigned, fpFilters: filters }).map(
        (footprint) => footprint.id
      )
      // An assigned footprint no library holds is still the symbol's: list it, and say so.
      if (assigned && !candidates.includes(assigned)) candidates.unshift(assigned)
      // After the assigned one, what the design already uses: its 0402s before every package.
      const used = new Set(props.designFootprints)
      const rest = candidates.slice(assigned ? 1 : 0)
      candidates.splice(
        assigned ? 1 : 0,
        rest.length,
        ...rest.filter((id) => used.has(id)),
        ...rest.filter((id) => !used.has(id))
      )
      symbolFootprints.value = { assigned, candidates }
      chosenFootprint.value = assigned
      void loadSymbolFootprint(assigned, token)
    }
  } catch {
    if (token === previewToken) previewState.value = 'failed'
  }
}

watch(
  () => active.value?.item.id ?? null,
  () => {
    clearTimeout(previewTimer)
    const item = active.value?.item ?? null
    previewTimer = setTimeout(() => void loadPreview(item), PREVIEW_SETTLE_MS)
  },
  { immediate: true }
)

/** What the Footprint and 3D slots show: the highlighted footprint, or a symbol's own. */
const shownFootprint = computed<{
  id: string
  footprint: KicadFootprint | null
  file: string | null
  loading: boolean
} | null>(() => {
  const item = active.value?.item
  if (!item) return null
  if (props.kind === 'footprint') {
    const footprint = previewFootprint.value
    return {
      id: item.id,
      footprint: footprint ? placedLook(footprint, item.id) : null,
      file: item.file ?? null,
      loading: previewState.value === 'loading'
    }
  }
  if (previewState.value === 'loading')
    return { id: '', footprint: null, file: null, loading: true }
  const own = chosenFootprint.value ? symbolFootprint.value : null
  return own?.footprint ? { ...own, footprint: placedLook(own.footprint, own.id) } : own
})

/**
 * A footprint as the part would carry it: the symbol's reference and value in
 * the symbol chooser, the host's (`fieldsFor`) in a footprint chooser.
 */
const placedLook = (footprint: KicadFootprint, id: string): KicadFootprint => {
  if (props.kind === 'footprint')
    return props.fieldsFor
      ? withPreviewFields(footprint, props.fieldsFor(footprint, id))
      : footprint
  const chain = previewChain.value
  if (!chain) return footprint
  return withPreviewFields(footprint, {
    reference: previewReference(chain),
    value: getLibSymbolProperty(chain[0], 'Value') ?? chain[0].name
  })
}

/** Why a slot is empty, so every slot is always there and says so. */
const symbolMessage = computed(() =>
  previewState.value === 'failed'
    ? t('shared.libraryChooser.unreadable')
    : previewState.value === 'loading'
      ? t('shared.libraryChooser.loading')
      : ''
)
const footprintMessage = computed(() => {
  const shown = shownFootprint.value
  if (!active.value) return ''
  if (!shown) return t('shared.libraryChooser.noFootprint')
  if (shown.loading) return t('shared.libraryChooser.loading')
  if (!shown.file) return t('shared.libraryChooser.footprintMissing')
  return shown.footprint ? '' : t('shared.libraryChooser.unreadable')
})
const modelMessage = computed(
  () =>
    footprintMessage.value ||
    (shownFootprint.value?.footprint?.model ? '' : t('shared.libraryChooser.noModel'))
)

// ---- the panes' heads (ComponentSlotHead, as the Component view's) --------

const symbolRecords = computed<IndexRecord[]>(() => {
  const record = active.value ? findSymbol(active.value.item.id) : undefined
  return record ? [record] : []
})

/** The footprints a head offers: a symbol's candidates, or the footprint itself. */
const footprintRecords = computed<IndexRecord[]>(() => {
  if (props.kind === 'footprint') {
    const record = active.value ? findFootprint(active.value.item.id) : undefined
    return record ? [record] : []
  }
  return (symbolFootprints.value?.candidates ?? []).flatMap((id) => findFootprint(id) ?? [])
})

const chosenFootprintIndex = computed(() =>
  props.kind === 'footprint'
    ? 0
    : footprintRecords.value.findIndex((record) => record.id === chosenFootprint.value)
)

const onFootprintSelected = (index: number): void =>
  chooseFootprint(footprintRecords.value[index]?.id ?? '')

/** A generic part (no Footprint field) starts at none. */
const footprintNoneLabel = computed(() =>
  props.kind !== 'footprint' && symbolFootprints.value && !symbolFootprints.value.assigned
    ? t('shared.libraryChooser.noFootprintOption')
    : ''
)

const modelRecords = computed<IndexRecord[]>(() =>
  shownFootprint.value?.footprint ? modelsForFootprint(shownFootprint.value.id) : []
)

const pinMap = computed(() => {
  if (!props.fit?.pins.length || !previewFootprint.value) return null
  return matchPinsToPads(
    props.fit.pins,
    previewFootprint.value.pads.map((pad) => pad.number)
  )
})

const listPins = (pins: PinRef[]): string =>
  pins
    .map((pin) => (pin.name && pin.name !== '~' ? `${pin.number} ${pin.name}` : pin.number))
    .join(', ')

const previewDatasheet = computed(() => {
  const item = active.value?.item
  if (!item || props.kind === 'footprint') return null
  return datasheetUrl(findSymbol(item.id)?.datasheet)
})

// ---- splits ----------------------------------------------------------------
// A drag moves a share by the pixels dragged over the size it divides; the
// pixel minimums keep every pane usable however small the window.

const LIST_MIN = 280
const PREVIEW_MIN = 420
const DETAILS_MIN = 56
const SLOTS_MIN = 120
const SYMBOL_MIN = 120
const NAME_MIN = 120
/** What the Description column keeps when Name widens. */
const DESCRIPTION_MIN = 120
/** The table's row inset (indent and right padding), outside its columns. */
const TABLE_INSET = 44

const body = ref<HTMLElement | null>(null)
const views = ref<HTMLElement | null>(null)

const detailsShare = computed(() =>
  props.kind === 'footprint' ? footprintDetailsShare.value : symbolDetailsShare.value
)

/** `start` moved by `grow` px of `size`, held between `min` px and `size - keep` px. */
const shareAfter = (
  start: number,
  grow: number,
  size: number,
  min: number,
  keep: number
): number =>
  size > 0 ? Math.max(min / size, Math.min((size - keep) / size, start + grow / size)) : start

let listStart = 0
let nameStart = 0
let detailsStart = 0
let slotsStart = 0

const resizeList = (grow: number): void => {
  const size = body.value?.clientWidth ?? 0
  listShare.value = shareAfter(listStart, grow, size, LIST_MIN, PREVIEW_MIN)
}

/** The Name column, from its header's right edge; Description takes the rest. */
const resizeName = (grow: number): void => {
  const size = (list.value?.clientWidth ?? 0) - TABLE_INSET
  nameShare.value = shareAfter(nameStart, grow, size, NAME_MIN, DESCRIPTION_MIN)
}

const resizeDetails = (grow: number): void => {
  const size = views.value?.clientHeight ?? 0
  const above = props.kind === 'footprint' ? SLOTS_MIN : SYMBOL_MIN + symbolSlotsShare.value * size
  const next = shareAfter(detailsStart, grow, size, DETAILS_MIN, above)
  if (props.kind === 'footprint') footprintDetailsShare.value = next
  else symbolDetailsShare.value = next
}

/** The footprint slots under a symbol: the symbol above keeps at least its minimum. */
const resizeSlots = (grow: number): void => {
  const size = views.value?.clientHeight ?? 0
  const keep = SYMBOL_MIN + symbolDetailsShare.value * size
  symbolSlotsShare.value = shareAfter(slotsStart, grow, size, SLOTS_MIN, keep)
}

const percent = (share: number): string => `${(share * 100).toFixed(3)}%`

// ---- keys ----------------------------------------------------------------

const pick = (row: ChooserRow | null): void => {
  if (!row) return
  noteLibraryPick(props.kind, row.item.id)
  const own = symbolFootprints.value
  if (props.kind !== 'footprint' && own && chosenFootprint.value !== own.assigned)
    emit('pick', row.item.id, { footprint: chosenFootprint.value })
  else emit('pick', row.item.id)
}

const move = (delta: number): void => {
  const keys = stops.value
  if (!keys.length) return
  const index = activeKey.value ? keys.indexOf(activeKey.value) : -1
  activeKey.value = keys[Math.max(0, Math.min(keys.length - 1, index + delta))]
  navigating.value = true
}

// The highlighted row stays in view however it moved: a key, a search, the current value on open.
watch(activeKey, () =>
  nextTick(() => list.value?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }))
)

/** Enter: a heading opens or shuts, a row is taken. */
const activate = (): void => {
  const key = activeKey.value
  if (key && !key.includes('|')) toggleGroup(key)
  else pick(active.value)
}

/**
 * Whether ←/→ work the tree rather than the search text: from the moment the
 * highlight is moved (a key, a click) until the next keystroke into the search.
 */
const navigating = ref(false)
watch(query, () => (navigating.value = false))

/** The group a key belongs to: a heading's own, or the one holding a row. */
const groupOfKey = (key: string): string => (key.includes('|') ? key.split('|')[0] : key)

/** →: open the highlighted group. ←: shut the group the highlight is in, landing on its heading. */
const openOrShut = (open: boolean): boolean => {
  const key = activeKey.value
  if (!key || !navigating.value) return false
  const group = groupOfKey(key)
  if (open) {
    if (key.includes('|') || isOpen(group)) return true
    toggleGroup(group)
  } else if (isOpen(group)) toggleGroup(group)
  else activeKey.value = group
  return true
}

/** A click in the list: the highlight moves there, and ←/→ follow it. */
const highlight = (key: string): void => {
  activeKey.value = key
  navigating.value = true
}
const highlightGroup = (group: string): void => {
  toggleGroup(group)
  navigating.value = true
}

const onSearchKeydown = async (event: KeyboardEvent): Promise<void> => {
  if (event.key === 'ArrowDown') move(1)
  else if (event.key === 'ArrowUp') move(-1)
  else if (event.key === 'PageDown') move(10)
  else if (event.key === 'PageUp') move(-10)
  else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    if (!openOrShut(event.key === 'ArrowRight')) return
  } else if (event.key === 'Enter') {
    event.preventDefault()
    // A query typed faster than the debounce settles first, so Enter takes its best match.
    if (settledQuery.value !== query.value) {
      clearTimeout(settleTimer)
      settledQuery.value = query.value
      await nextTick()
      await nextTick()
    }
    activate()
    return
  } else return
  event.preventDefault()
}

// Escape closes from anywhere in the sheet (DESIGN.md §Modals), on the window
// so it works whatever has focus.
const root = ref<HTMLElement | null>(null)

/** Back to the search, its text selected so typing replaces it. */
const focusSearch = (): void => {
  search.value?.focus()
  search.value?.select()
}

/** A press on the previews or details: the canvas is what is being worked, not the search. */
const leaveSearch = (): void => search.value?.blur()

/** The list's keys, also when focus has left the search for a preview. */
const LIST_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'PageDown',
  'PageUp',
  'Enter'
])

const onWindowKeydown = (event: KeyboardEvent): void => {
  if (matchesHotkey(event, 'app.dismiss')) {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  // Keys aimed inside the sheet go to their own handlers (and stop at its root).
  if (event.target instanceof Node && root.value?.contains(event.target)) return
  // Focus left for a preview canvas: the editor behind the sheet must not act
  // on Delete or R while it is open.
  event.stopPropagation()
  if (matchesHotkey(event, 'editor.focusSearch') || matchesHotkey(event, 'editor.find')) {
    event.preventDefault()
    focusSearch()
  } else if (LIST_KEYS.has(event.key)) void onSearchKeydown(event)
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
  void loadLibraryRecents()
  search.value?.focus()
  resetExpanded()
  if (props.initialId) activeKey.value = firstRowKey(props.initialId) ?? null
  // Refetches only when a library changed since the last load (libraryIndex.ts).
  void loadIndex().then(
    () => {
      indexTick.value++
      void nextTick(() => {
        resetExpanded()
        const current = props.initialId ? firstRowKey(props.initialId) : undefined
        if (current) activeKey.value = current
      })
    },
    () => {}
  )
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  clearTimeout(settleTimer)
  clearTimeout(previewTimer)
})
</script>

<template>
  <!-- On the body, so no editor's stacking or clipping can hold the sheet in its pane. -->
  <Teleport to="body">
    <div class="chooser-overlay" @mousedown.self="emit('close')">
      <div ref="root" class="chooser" role="dialog" aria-modal="true" @keydown.stop>
        <header class="chooser-head">
          <h2 class="chooser-title">
            <Icon v-if="icon" :name="icon" class="chooser-icon" />
            {{ title }}
            <span v-if="target" class="chooser-target">{{ target }}</span>
          </h2>
          <button
            class="btn-subtle btn-icon-md"
            :title="t('shared.libraryChooser.cancel')"
            :aria-label="t('shared.libraryChooser.cancel')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </header>

        <div ref="body" class="chooser-body">
          <div class="list-pane" :style="{ flexBasis: percent(listShare) }">
            <div class="chooser-search-field">
              <!-- The tool search's glyph and metrics (ToolbarSearch), so every search reads alike. -->
              <Icon name="tool-search" class="search-glyph" />
              <input
                ref="search"
                v-model="query"
                class="chooser-search"
                :placeholder="placeholder"
                spellcheck="false"
                :title="t('shared.libraryChooser.searchTitle', { keys: searchKeys })"
                @keydown="onSearchKeydown"
                @blur="navigating = true"
              />
            </div>
            <div
              ref="list"
              class="chooser-list"
              role="tree"
              :style="{ '--chooser-columns': `${percent(nameShare)} minmax(0, 1fr) auto` }"
            >
              <div class="chooser-columns">
                <span class="column-name">
                  {{ t('shared.libraryChooser.columns.name') }}
                  <ResizeHandle
                    edge="right"
                    @resize-start="nameStart = nameShare"
                    @resize="resizeName"
                  />
                </span>
                <span>{{ t('shared.libraryChooser.columns.description') }}</span>
                <span></span>
              </div>
              <template v-for="group in groups" :key="group.key">
                <button
                  class="chooser-group"
                  :class="{ active: activeKey === group.key }"
                  role="treeitem"
                  :aria-expanded="isOpen(group.key)"
                  @mousedown.prevent
                  @click="highlightGroup(group.key)"
                >
                  <Icon
                    name="chevron-right"
                    class="disclosure"
                    :class="{ open: isOpen(group.key) }"
                  />
                  <span class="group-name">{{ groupLabel(group) }}</span>
                  <span class="group-count">{{ group.count }}</span>
                </button>
                <template v-if="isOpen(group.key)">
                  <button
                    v-for="row in group.rows().slice(0, GROUP_CAP)"
                    :key="rowKey(group, row)"
                    class="chooser-row"
                    :class="{ active: rowKey(group, row) === activeKey }"
                    role="treeitem"
                    :aria-selected="rowKey(group, row) === activeKey"
                    :title="row.item.id"
                    @mousedown.prevent="highlight(rowKey(group, row))"
                    @dblclick="pick(row)"
                  >
                    <span class="row-name">
                      <span class="row-name-text">{{ row.item.name }}</span>
                    </span>
                    <span class="row-description">{{ row.item.description }}</span>
                    <span class="row-badges">
                      <span v-if="row.fits === true" class="row-badge fits">{{
                        t('shared.libraryChooser.fits')
                      }}</span>
                      <LibraryLeafIndicators
                        v-if="recordOf(row.item)"
                        :record="recordOf(row.item)!"
                        hide-own
                        colored
                      />
                    </span>
                  </button>
                  <div v-if="group.count > GROUP_CAP" class="chooser-note">
                    {{ t('shared.libraryChooser.moreResults', { n: group.count - GROUP_CAP }) }}
                  </div>
                </template>
              </template>
              <div v-if="!groups.length" class="chooser-note">
                {{
                  !indexLoaded() && !items.length
                    ? t('shared.libraryChooser.indexing')
                    : t('shared.libraryChooser.noMatches')
                }}
              </div>
            </div>
          </div>
          <PaneSplit
            axis="x"
            grows="before"
            @resize-start="listStart = listShare"
            @resize="resizeList"
          />

          <section
            ref="views"
            class="chooser-preview"
            :class="{ 'symbol-first': kind !== 'footprint' }"
            @mousedown.capture="leaveSearch"
          >
            <template v-if="kind !== 'footprint'">
              <div class="preview-pane symbol-pane">
                <ComponentSlotHead
                  type="symbol"
                  :records="symbolRecords"
                  openable
                  :selected="0"
                  :empty-label="active?.item.id ?? ''"
                  @open="(record) => emit('open', record)"
                />
                <div class="preview-frame">
                  <ComponentSymbolViewer
                    v-if="previewState === 'ready'"
                    :chain="previewChain"
                    bare
                  />
                  <div v-else class="preview-empty">{{ symbolMessage }}</div>
                </div>
              </div>
              <PaneSplit
                class="slots-split"
                axis="y"
                grows="after"
                @resize-start="slotsStart = symbolSlotsShare"
                @resize="resizeSlots"
              />
            </template>
            <div
              class="footprint-slots"
              :style="
                kind !== 'footprint' ? { flex: 'none', height: percent(symbolSlotsShare) } : {}
              "
            >
              <div class="preview-pane">
                <ComponentSlotHead
                  type="footprint"
                  :records="footprintRecords"
                  :selected="chosenFootprintIndex"
                  :none-label="footprintNoneLabel"
                  openable
                  :empty-label="footprintMessage || shownFootprint?.id || ''"
                  @update:selected="onFootprintSelected"
                  @open="(record) => emit('open', record)"
                />
                <div class="preview-frame">
                  <ComponentFootprintViewer
                    v-if="shownFootprint?.footprint"
                    :file="shownFootprint.file ?? ''"
                    :parsed="shownFootprint.footprint"
                    bare
                  />
                  <div v-else class="preview-empty">{{ footprintMessage }}</div>
                </div>
              </div>
              <div class="preview-pane">
                <ComponentSlotHead
                  type="model"
                  :records="modelRecords"
                  openable
                  :selected="0"
                  together
                  :empty-label="modelMessage"
                  @open="(record) => emit('open', record)"
                />
                <div class="preview-frame">
                  <FootprintViewport3D
                    v-if="!modelMessage && shownFootprint?.footprint"
                    :footprint="shownFootprint.footprint"
                    :file-path="shownFootprint.file"
                    initial-view="top"
                    bare
                  />
                  <div v-else class="preview-empty">{{ modelMessage }}</div>
                </div>
              </div>
            </div>
            <PaneSplit
              class="details-split"
              axis="y"
              grows="after"
              @resize-start="detailsStart = detailsShare"
              @resize="resizeDetails"
            />
            <div class="details-pane" :style="{ height: percent(detailsShare) }">
              <PartDetails
                v-if="active"
                :id="active.item.id"
                :description="active.item.description"
                :keywords="active.item.keywords"
                :source="scopeLabel(active.item.scope)"
                :datasheet="previewDatasheet"
              >
                <template v-if="pinMap">
                  <dt>{{ t('shared.libraryChooser.details.pinMap') }}</dt>
                  <dd v-if="!pinMap.pinsWithoutPad.length && !pinMap.padsWithoutPin.length">
                    {{ t('shared.libraryChooser.pinMap.allMatch', { n: pinMap.matched }) }}
                  </dd>
                  <dd v-else class="pin-map-warning">
                    <span v-if="pinMap.pinsWithoutPad.length">{{
                      t('shared.libraryChooser.pinMap.pinsWithoutPad', {
                        list: listPins(pinMap.pinsWithoutPad)
                      })
                    }}</span>
                    <span v-if="pinMap.padsWithoutPin.length">{{
                      t('shared.libraryChooser.pinMap.padsWithoutPin', {
                        list: pinMap.padsWithoutPin.join(', ')
                      })
                    }}</span>
                  </dd>
                </template>
              </PartDetails>
            </div>
          </section>
        </div>

        <footer class="chooser-foot">
          <button class="btn-outline btn-md" @click="emit('close')">
            {{ t('shared.libraryChooser.cancel') }}
          </button>
          <button class="btn-cta btn-md" :disabled="!active" @click="pick(active)">
            {{ verb }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.chooser-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-scrim);
  backdrop-filter: blur(4px);
}

/* The window less a margin: a library is long, and the preview earns the width. */
.chooser {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 92% of the window, an even 4% margin round it; capped across so a wide monitor does not
     pull the list and its previews apart. */
  width: 92vw;
  max-width: 1680px;
  height: 92vh;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
  color: var(--vscode-text);
  font-size: var(--text-body);
}

.chooser-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chooser-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

/* A tool glyph is drawn on a 20px grid and only crisp at 20px (DESIGN.md §Icons). */
.chooser-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--vscode-text-light);
}

.chooser-target {
  margin-left: 12px;
  color: var(--vscode-text-muted);
  font-weight: 400;
}

/* One frame, everything inside it flush: panes meet at 1px rules, no inner boxes. */
.chooser-body {
  display: flex;
  overflow: hidden;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  flex: 1;
  min-height: 0;
}

.list-pane {
  flex-direction: column;
  position: relative;
  display: flex;
  flex-shrink: 0;
  min-height: 0;
}

.chooser-search-field {
  position: relative;
  flex-shrink: 0;
  /* A fixed height, the input laid over it with no vertical padding and the glyph centered on
     the same box — the tool search's construction (ToolbarSearch), so the text's middle and the
     glyph's agree. The rule under it is the container's, outside both. */
  height: 40px;
  border-bottom: 1px solid var(--vscode-border);
  background: var(--vscode-input-bg);
}

.search-glyph {
  position: absolute;
  top: 50%;
  left: 8px;
  z-index: 1;
  width: 20px;
  height: 20px;
  transform: translateY(-50%);
  color: var(--vscode-text-muted);
  pointer-events: none;
}

.chooser-search {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0 12px 0 34px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--vscode-text);
  font-size: var(--text-body);
}

.chooser-search-field:focus-within {
  box-shadow: inset 0 -1px 0 var(--vscode-accent);
}

.chooser-list {
  /* The data surface (`--vscode-data-bg`, Settings' ground), the sheet's chrome around it on
     the sidebar's: a step of contrast between what is read and what frames it. */
  background: var(--vscode-data-bg);
  /* Name | Description, shared by the header and every row so the columns line up. */
  /* Overridden inline by the Name column's share (`resizeName`). */
  --chooser-columns: 50% minmax(0, 1fr) auto;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.column-name {
  position: relative;
}

/* On the gap between the two columns, as the app's other splits sit on their rule. */
.column-name > .resize-handle {
  right: -10px;
}

.chooser-columns {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  flex-shrink: 0;
  grid-template-columns: var(--chooser-columns);
  gap: 16px;
  padding: 6px 12px 6px 32px;
  border-bottom: 1px solid var(--vscode-border);
  background: var(--vscode-bg-sidebar);
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  /* Bold, so the header reads as a header against the group headings and rows below it. */
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.chooser-group {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 12px 4px 8px;
  border: none;
  border-bottom: 1px solid var(--vscode-border);
  background: transparent;
  color: var(--vscode-text-light);
  font-size: var(--text-body);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.group-count {
  margin-left: auto;
  color: var(--vscode-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-body-sm);
  font-weight: 400;
}

.chooser-row {
  display: grid;
  flex-shrink: 0;
  grid-template-columns: var(--chooser-columns);
  align-items: center;
  gap: 16px;
  min-height: 32px;
  padding: 4px 12px 4px 32px;
  border: none;
  border-bottom: 1px solid var(--vscode-border);
  background: transparent;
  color: var(--vscode-text);
  font-size: var(--text-body);
  font-weight: 400;
  text-align: left;
  cursor: pointer;
}

.chooser-group:hover,
.chooser-row:hover {
  background-color: var(--vscode-bg-hover);
}

/* The keyboard's row, as the selection nav marks its item: a fill and a copper inset bar, so it
   never reads as the row the pointer is resting on. */
.chooser-group.active,
.chooser-row.active {
  background-color: var(--vscode-bg-active);
  box-shadow: inset 2px 0 0 var(--vscode-accent);
}

.row-name {
  /* The key column — the part's name — in the data foreground; its description stays muted. */
  color: var(--vscode-data-fg);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.row-name-text,
.row-description {
  /* Room under the baseline: a clipped line box hides underscores. */
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-description {
  color: var(--vscode-text-muted);
}

.row-badges {
  display: flex;
  gap: 4px;
}

.row-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  line-height: 1;
  border-radius: 999px;
  background: var(--vscode-overlay-control);
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  white-space: nowrap;
}

.row-badge.fits {
  background: var(--vscode-success-subtle);
  color: var(--vscode-success);
}

.chooser-note {
  padding: 12px 12px 12px 32px;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
}

.chooser-preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.preview-frame {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--vscode-bg-viewport);
}

.preview-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.symbol-pane {
  flex: 1;
}

/* A footprint in 2D and 3D, side by side, under the symbol (or alone for a footprint). */
.footprint-slots {
  display: flex;
  flex: 2;
  min-height: 0;
}

.footprint-slots > .preview-pane + .preview-pane {
  border-left: 1px solid var(--vscode-border);
}

/* A symbol's details read under it, above its footprint and model; a footprint's under the
   footprint itself. Ordered rather than repeated, so each pane is written once. */
.chooser-preview.symbol-first .symbol-pane {
  order: 1;
}
.chooser-preview.symbol-first .details-split {
  order: 2;
}
.chooser-preview.symbol-first .details-pane {
  order: 3;
}
.chooser-preview.symbol-first .slots-split {
  order: 4;
}
.chooser-preview.symbol-first .footprint-slots {
  order: 5;
}

.details-pane {
  position: relative;
  flex-shrink: 0;
}

.preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--vscode-text-muted);
}

/* Through PartDetails' slot: specific enough to keep the warning over its data foreground. */
.part-details dd.pin-map-warning {
  color: var(--vscode-warning);
}

.chooser-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
