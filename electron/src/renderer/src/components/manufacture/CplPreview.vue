<script setup lang="ts">
/**
 * Pick-and-place (CPL) preview for Manufacture mode (fabrication-export §5d).
 *
 * The board as it comes off the line, seen straight down (`CplViewport`: the
 * 3D board through an orthographic camera), one side at a time — the back
 * turned over, as it is held to place its underside — beside the placements,
 * listed by side. Every part is faded until it is asked for: hovering a row,
 * or a part on the board, shows it whole with a pip at its centroid, a tick
 * for its rotation and the coordinates exactly as the CSV writes them. The
 * position file's origin is marked, or pointed to from the edge when it lies
 * off the view, since a file measured from the page corner is the usual
 * surprise at the fab.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KicadBoard } from '../../lib/kicad/board'
import { buildCplRows, type CplComponent, type CplOptions } from '../../lib/fabCpl'
import { findProjectFile } from '../../lib/kicad/project'
import { KICAD_LAYER_COLORS } from '../../lib/kicad/layers'
import { CplViewport, type CplSideView } from '../../lib/engine/board3d/cplViewport'

const { t } = useI18n()

const props = defineProps<{
  board: KicadBoard | null
  /** The .kicad_pcb the board was read from, for its models' links. */
  boardPath: string
  /** The components to plot (already filtered by side/DNP upstream). */
  components: CplComponent[]
  /** Coalesce identical parts (value + footprint) into one list row. */
  group: boolean
  /** The CSV's units, so a label reads as the file does. */
  units: CplOptions['units']
}>()

const TOP_COLOR = KICAD_LAYER_COLORS['F.Cu']
const BOTTOM_COLOR = KICAD_LAYER_COLORS['B.Cu']

const footprintName = (fp: string): string => {
  const colon = fp.indexOf(':')
  return colon >= 0 ? fp.slice(colon + 1) : fp
}

// ---- The list: by side, then by part --------------------------------------

interface ListItem {
  key: string
  title: string
  subtitle: string
  footprint: string
  side: CplSideView
  references: string[]
}

/** A row's identity: its group (value, footprint and side) or its reference. */
const keyOf = (c: CplComponent): string =>
  props.group ? `${c.side}|${c.value}|${footprintName(c.footprint)}` : c.reference

const listItems = computed<ListItem[]>(() => {
  const items = new Map<string, ListItem>()
  for (const c of props.components) {
    const key = keyOf(c)
    const item = items.get(key)
    if (item) {
      item.references.push(c.reference)
      continue
    }
    items.set(key, {
      key,
      title: props.group ? c.value || footprintName(c.footprint) || '—' : c.reference,
      subtitle: [c.value, footprintName(c.footprint)].filter(Boolean).join(' · '),
      footprint: footprintName(c.footprint),
      side: c.side,
      references: [c.reference]
    })
  }
  // A group reads as its footprint and how many it places.
  if (props.group)
    for (const item of items.values())
      item.subtitle = `${item.footprint} · ${item.references.length}×`
  return [...items.values()]
})
const sections = computed(() =>
  (['top', 'bottom'] as const)
    .map((side) => ({ side, items: listItems.value.filter((item) => item.side === side) }))
    .filter((section) => section.items.length > 0)
)

// ---- The board --------------------------------------------------------------

const host = ref<HTMLDivElement | null>(null)
const viewport = shallowRef<CplViewport | null>(null)
const side = ref<CplSideView>('top')
/** The row under the pointer, shown while it is there. */
const hovered = ref<string | null>(null)
/** The row clicked, shown whenever nothing else is hovered. */
const selected = ref<string | null>(null)
const activeKey = computed(() => hovered.value ?? selected.value)
/** Click a row or a part to keep it shown; click it again to let it go. */
const select = (key: string | null): void => {
  selected.value = key !== null && key === selected.value ? null : key
}
const list = ref<HTMLElement | null>(null)
// A part picked on the board brings its row into view.
watch(selected, async () => {
  await nextTick()
  list.value?.querySelector('.cpl-row.selected')?.scrollIntoView({ block: 'nearest' })
})
/** Bumped when the view moves, so the overlay follows it. */
const viewTick = ref(0)
const size = ref({ width: 0, height: 0 })
let stopView: (() => void) | null = null
let resize: ResizeObserver | null = null

const projectDir = async (): Promise<string | null> => {
  const project = await findProjectFile(props.boardPath)
  return project ? project.replace(/[\\/][^\\/]*$/, '') : null
}

onMounted(async () => {
  if (!host.value) return
  const view = new CplViewport(host.value)
  viewport.value = view
  stopView = view.onViewChange(() => viewTick.value++)
  resize = new ResizeObserver(() => {
    size.value = { width: host.value?.clientWidth ?? 0, height: host.value?.clientHeight ?? 0 }
    viewTick.value++
  })
  resize.observe(host.value)
  await view.setBoard(props.board, props.boardPath, await projectDir())
})

onBeforeUnmount(() => {
  cancelAnimationFrame(pickFrame)
  stopView?.()
  resize?.disconnect()
  viewport.value?.destroy()
  viewport.value = null
})

watch(
  () => props.board,
  async (board) => viewport.value?.setBoard(board, props.boardPath, await projectDir())
)
watch(side, (next) => viewport.value?.setSide(next))

const byReference = computed(() => new Map(props.components.map((c) => [c.reference, c])))
const activeItem = computed(() => listItems.value.find((item) => item.key === activeKey.value))
const activeParts = computed<CplComponent[]>(() =>
  (activeItem.value?.references ?? [])
    .map((reference) => byReference.value.get(reference))
    .filter((c): c is CplComponent => !!c)
)

watch(activeParts, (parts) => {
  viewport.value?.setHighlight(new Set(parts.map((c) => c.reference)))
  // A part on the other side turns the board over to show it.
  if (parts.length && parts.every((c) => c.side !== side.value)) side.value = parts[0].side
})

/** Keep the part clicked on the board shown; a click on bare board lets it go. */
const onBoardClick = (event: MouseEvent): void => {
  if (Math.hypot(event.clientX - (pressAt?.x ?? 0), event.clientY - (pressAt?.y ?? 0)) > 4) return
  const reference = viewport.value?.pick(event.clientX, event.clientY)
  const c = reference ? byReference.value.get(reference) : undefined
  selected.value = c ? keyOf(c) : null
}
/** Where the last press began: a drag to pan is not a click. */
let pressAt: { x: number; y: number } | null = null
const onBoardPress = (event: PointerEvent): void => {
  pressAt = { x: event.clientX, y: event.clientY }
}

/**
 * A row for the part under the pointer on the board, picked once a frame
 * however fast the pointer moves.
 */
let pointer: { x: number; y: number } | null = null
let pickFrame = 0
const onBoardHover = (event: PointerEvent): void => {
  if (event.buttons) return
  pointer = { x: event.clientX, y: event.clientY }
  if (pickFrame) return
  pickFrame = requestAnimationFrame(() => {
    pickFrame = 0
    if (!pointer) return
    const reference = viewport.value?.pick(pointer.x, pointer.y)
    const c = reference ? byReference.value.get(reference) : undefined
    const key = c ? keyOf(c) : null
    if (key !== hovered.value) hovered.value = key
  })
}
const onBoardLeave = (): void => {
  pointer = null
  hovered.value = null
}

// ---- The overlay: pips, labels, the origin ----------------------------------

interface Pip {
  reference: string
  x: number
  y: number
  tx: number
  ty: number
  label: string
}

const pips = computed<Pip[]>(() => {
  void viewTick.value
  const view = viewport.value
  if (!view) return []
  return activeParts.value
    .filter((c) => c.side === side.value)
    .map((c) => {
      const at = view.toScreen(c.x, c.y)
      // The tick runs along the part's rotation, CCW in the file's y-up sense,
      // mirrored with the board when it is seen from below.
      const angle = (c.rotation * Math.PI) / 180
      const flip = side.value === 'top' ? 1 : -1
      const row = buildCplRows([c], { units: props.units, side: 'both', includeDnp: true })[0]
      return {
        reference: c.reference,
        x: at.x,
        y: at.y,
        tx: at.x + flip * 18 * Math.cos(angle),
        ty: at.y - 18 * Math.sin(angle),
        label: `${c.reference}  X ${row.midX}  Y ${row.midY}  ${row.rotation}°`
      }
    })
})

/** A label near the right edge reads leftward from its pip, so it stays on the map. */
const labelLeft = computed(() => {
  const pip = pips.value[0]
  return !!pip && pip.x + 10 + pip.label.length * 7.5 > size.value.width - 8
})

/** The position file's origin: marked where it is, else an arrow at the edge toward it. */
const origin = computed(() => {
  void viewTick.value
  const view = viewport.value
  const { width, height } = size.value
  if (!view || !width || !height) return null
  const at = view.toScreen(0, 0)
  const margin = 24
  if (at.x >= margin && at.x <= width - margin && at.y >= margin && at.y <= height - margin)
    return { inside: true as const, x: at.x, y: at.y }
  // Where the line from the center toward it leaves the view.
  const cx = width / 2
  const cy = height / 2
  const dx = at.x - cx
  const dy = at.y - cy
  const scale = Math.min(
    dx ? (width / 2 - margin) / Math.abs(dx) : Infinity,
    dy ? (height / 2 - margin) / Math.abs(dy) : Infinity
  )
  return {
    inside: false as const,
    x: cx + dx * scale,
    y: cy + dy * scale,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    distance: Math.hypot(...distanceToOrigin()).toFixed(0)
  }
})

/** How far the view's center is from the origin, board millimeters. */
const distanceToOrigin = (): [number, number] => {
  const view = viewport.value
  const { width, height } = size.value
  if (!view) return [0, 0]
  const center = view.toScreen(0, 0)
  const probe = view.toScreen(1, 0)
  const pxPerMm = Math.abs(probe.x - center.x) || 1
  return [(center.x - width / 2) / pxPerMm, (center.y - height / 2) / pxPerMm]
}

const sideColor = (s: CplSideView): string => (s === 'bottom' ? BOTTOM_COLOR : TOP_COLOR)
</script>

<template>
  <div class="cpl-preview">
    <div v-if="!board" class="cpl-empty">{{ t('manufacture.gerber.previewLoading') }}</div>
    <div v-else-if="components.length === 0" class="cpl-empty">
      {{ t('manufacture.cpl.empty') }}
    </div>
    <template v-else>
      <div class="cpl-map">
        <div
          ref="host"
          class="cpl-board"
          @pointermove="onBoardHover"
          @pointerdown="onBoardPress"
          @pointerleave="onBoardLeave"
          @click="onBoardClick"
          @dblclick="viewport?.fit()"
        />
        <svg class="cpl-overlay" :width="size.width" :height="size.height">
          <g v-if="origin" class="cpl-origin">
            <!-- The layout's place-file origin mark (OriginMarker): a ring crossed by two arms. -->
            <template v-if="origin.inside">
              <g v-for="layer in ['rim', 'core']" :key="layer" :class="layer">
                <circle :cx="origin.x" :cy="origin.y" r="7" />
                <line :x1="origin.x - 11" :y1="origin.y" :x2="origin.x + 11" :y2="origin.y" />
                <line :x1="origin.x" :y1="origin.y - 11" :x2="origin.x" :y2="origin.y + 11" />
              </g>
              <text :x="origin.x + 14" :y="origin.y - 10">{{ t('manufacture.cpl.origin') }}</text>
            </template>
            <template v-else>
              <g :transform="`translate(${origin.x} ${origin.y}) rotate(${origin.angle})`">
                <path d="M 8 0 L -6 -6 L -6 6 Z" />
              </g>
              <text
                :x="origin.x"
                :y="origin.y"
                :dx="origin.x > size.width / 2 ? -12 : 12"
                :dy="origin.y > size.height / 2 ? -10 : 18"
                :text-anchor="origin.x > size.width / 2 ? 'end' : 'start'"
              >
                {{ t('manufacture.cpl.originOff', { distance: origin.distance }) }}
              </text>
            </template>
          </g>
          <!-- A dot at the centroid and a line along the rotation. -->
          <g v-for="pip in pips" :key="pip.reference" class="cpl-pip">
            <g v-for="layer in ['rim', 'core']" :key="layer" :class="layer">
              <line :x1="pip.x" :y1="pip.y" :x2="pip.tx" :y2="pip.ty" />
              <circle :cx="pip.x" :cy="pip.y" r="4" />
            </g>
          </g>
          <text
            v-if="pips.length === 1"
            class="cpl-pip-label"
            :x="pips[0].x + (labelLeft ? -10 : 10)"
            :y="pips[0].y + 20"
            :text-anchor="labelLeft ? 'end' : 'start'"
          >
            {{ pips[0].label }}
          </text>
        </svg>
        <div class="segmented cpl-side-toggle">
          <button class="segmented-btn" :class="{ active: side === 'top' }" @click="side = 'top'">
            {{ t('manufacture.cpl.top') }}
          </button>
          <button
            class="segmented-btn"
            :class="{ active: side === 'bottom' }"
            @click="side = 'bottom'"
          >
            {{ t('manufacture.cpl.bottom') }}
          </button>
        </div>
        <p class="cpl-note">{{ t('manufacture.cpl.rotationNote') }}</p>
      </div>

      <aside class="cpl-list">
        <div class="cpl-list-head">{{ t('manufacture.cpl.listTitle') }}</div>
        <div ref="list" class="cpl-rows">
          <section v-for="section in sections" :key="section.side">
            <h4 class="cpl-section">
              <span class="cpl-dot" :style="{ background: sideColor(section.side) }" />
              {{ section.side === 'top' ? t('manufacture.cpl.top') : t('manufacture.cpl.bottom') }}
              <span class="cpl-count">{{ section.items.length }}</span>
            </h4>
            <ul>
              <li
                v-for="item in section.items"
                :key="item.key"
                class="cpl-row"
                :class="{ active: hovered === item.key, selected: selected === item.key }"
                @mouseenter="hovered = item.key"
                @mouseleave="hovered = null"
                @click="select(item.key)"
              >
                <span class="cpl-row-title">{{ item.title }}</span>
                <span class="cpl-row-sub">{{ item.subtitle }}</span>
              </li>
            </ul>
          </section>
        </div>
      </aside>
    </template>
  </div>
</template>

<style scoped>
.cpl-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  border-top: 1px solid var(--vscode-border);
  background: var(--vscode-bg-viewport);
}

.cpl-map {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.cpl-board {
  position: absolute;
  inset: 0;
  cursor: grab;
}

.cpl-board:active {
  cursor: grabbing;
}

.cpl-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cpl-overlay line,
.cpl-overlay circle {
  fill: none;
  stroke-linecap: square;
}

/* Every mark is a core over a rim, as the canvas chrome draws it, so it reads on
   the board and off it alike. */
.cpl-overlay .rim line,
.cpl-overlay .rim circle {
  stroke: var(--vscode-canvas-selection-rim);
  stroke-width: 3.5;
}

.cpl-overlay .core line,
.cpl-overlay .core circle {
  stroke-width: 1.5;
}

.cpl-pip .core line,
.cpl-pip .core circle {
  stroke: var(--vscode-canvas-selection);
}

.cpl-pip .core circle {
  fill: var(--vscode-canvas-selection);
}

.cpl-pip line {
  stroke-linecap: round;
}

.cpl-origin .core line,
.cpl-origin .core circle {
  stroke: var(--vscode-accent);
}

.cpl-origin path {
  fill: var(--vscode-accent);
  stroke: var(--vscode-canvas-selection-rim);
  stroke-width: 1;
}

.cpl-pip-label,
.cpl-origin text {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: 600;
  paint-order: stroke;
  stroke: var(--vscode-canvas-selection-rim);
  stroke-width: 3px;
}

.cpl-pip-label {
  fill: var(--vscode-canvas-selection);
}

.cpl-origin text {
  fill: var(--vscode-accent);
}

.cpl-side-toggle {
  position: absolute;
  top: 12px;
  right: 12px;
  background: var(--vscode-bg-editor);
}

.cpl-note {
  position: absolute;
  left: 16px;
  bottom: 8px;
  margin: 0;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
  pointer-events: none;
}

.cpl-list {
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-editor);
  font-size: var(--text-body-sm);
}

.cpl-list-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-border);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.cpl-rows {
  flex: 1;
  overflow: auto;
}

.cpl-rows ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cpl-section {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 12px;
  background: var(--vscode-bg-editor);
  border-bottom: 1px solid var(--vscode-border);
  color: var(--vscode-accent);
  font-size: var(--text-caption);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.cpl-count {
  color: var(--vscode-text-muted);
  font-weight: 400;
}

.cpl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.cpl-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--vscode-border);
}

.cpl-row {
  cursor: pointer;
}

.cpl-row.active {
  background: var(--vscode-bg-hover);
}

.cpl-row.selected {
  background: var(--vscode-bg-active);
  box-shadow: inset 2px 0 0 var(--vscode-canvas-selection);
}

.cpl-row-title {
  font-family: var(--font-mono);
  color: var(--vscode-text);
}

.cpl-row-sub {
  color: var(--vscode-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cpl-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-text-muted);
}
</style>
