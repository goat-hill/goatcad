<script setup lang="ts">
// The agents' viewports on one 2D canvas (lib/agentViewportView.ts): a dashed
// box round each one's frame, its label beside the agent icon, a × that closes
// it. A box out of the person's view shows as a marker at the view's edge,
// pointing toward it; clicking the marker asks the canvas to frame the box.
// Nothing else here moves the camera. Placed every animation frame while a box
// shows, so it follows pan and zoom.
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import {
  closeAgentViewport,
  type AgentViewportShown,
  type ViewportFrame
} from '../../lib/agentViewportView'
import {
  placeAgentViewport,
  type MarkerInsets,
  type ViewportPlacement
} from '../../lib/agentViewportPlacement'
import { matchesHotkey } from '../../lib/hotkeys'

const props = defineProps<{
  viewports: readonly AgentViewportShown[]
  /** A frame's corners in client pixels; null while the canvas cannot place it. */
  toScreen: (
    frame: ViewportFrame
  ) => { minX: number; minY: number; maxX: number; maxY: number } | null
  /** What the canvas's own chrome covers at each edge, so a marker stays clear of it. */
  markerInsets?: () => MarkerInsets
}>()

const emit = defineEmits<{ (e: 'reveal', frame: ViewportFrame): void }>()

const { t } = useI18n()

/** How far a marker's center sits inside an edge with no chrome on it, px. */
const MARKER_INSET = 24
const EVEN_INSETS: MarkerInsets = {
  top: MARKER_INSET,
  right: MARKER_INSET,
  bottom: MARKER_INSET,
  left: MARKER_INSET
}
/** A box this near the top puts its label inside, where it can be seen. */
const LABEL_ROOM = 24

interface Placed {
  id: string
  label: string
  frame: ViewportFrame
  at: ViewportPlacement
}

const root = ref<HTMLElement | null>(null)
const placed = ref<Placed[]>([])
let frameRequest = 0

const framed = computed(() =>
  props.viewports.filter(
    (viewport): viewport is AgentViewportShown & { frame: ViewportFrame } => viewport.frame !== null
  )
)

const place = (): void => {
  frameRequest = 0
  const el = root.value
  if (!el || framed.value.length === 0) {
    placed.value = []
    return
  }
  const origin = el.getBoundingClientRect()
  const view = { width: origin.width, height: origin.height }
  const next: Placed[] = []
  // Measured only when a box is out of sight: it reads the chrome's layout.
  let insets: MarkerInsets | null = null
  for (const viewport of framed.value) {
    const corners = props.toScreen(viewport.frame)
    if (!corners) continue
    const rect = {
      left: Math.round(corners.minX - origin.left),
      top: Math.round(corners.minY - origin.top),
      width: Math.round(corners.maxX - corners.minX),
      height: Math.round(corners.maxY - corners.minY)
    }
    const seen = placeAgentViewport(view, rect, EVEN_INSETS)
    next.push({
      id: viewport.id,
      label: viewport.label,
      frame: viewport.frame,
      at:
        seen.kind === 'box'
          ? seen
          : placeAgentViewport(view, rect, (insets ??= props.markerInsets?.() ?? EVEN_INSETS))
    })
  }
  if (JSON.stringify(next) !== JSON.stringify(placed.value)) placed.value = next
  frameRequest = requestAnimationFrame(place)
}

watch(
  framed,
  () => {
    if (!frameRequest) frameRequest = requestAnimationFrame(place)
  },
  { immediate: true }
)
onUnmounted(() => {
  if (frameRequest) cancelAnimationFrame(frameRequest)
  frameRequest = 0
})

/** Esc with a box's label focused closes it, as its × does. */
const onLabelKey = (id: string, e: KeyboardEvent): void => {
  if (!matchesHotkey(e, 'editor.cancel')) return
  e.preventDefault()
  e.stopPropagation()
  closeAgentViewport(id)
}
</script>

<template>
  <div ref="root" class="agent-viewports">
    <template v-for="item in placed" :key="item.id">
      <div
        v-if="item.at.kind === 'box'"
        class="agent-viewport"
        :class="{ 'label-inside': item.at.rect.top < LABEL_ROOM }"
        :style="{
          left: item.at.rect.left + 'px',
          top: item.at.rect.top + 'px',
          width: item.at.rect.width + 'px',
          height: item.at.rect.height + 'px'
        }"
      >
        <div class="agent-viewport-label" tabindex="0" @keydown="onLabelKey(item.id, $event)">
          <Icon name="agent" class="agent-viewport-icon" />
          <span class="agent-viewport-text">{{ item.label }}</span>
          <button
            type="button"
            class="agent-viewport-close"
            :title="t('shared.agentViewport.close')"
            :aria-label="t('shared.agentViewport.close')"
            @click="closeAgentViewport(item.id)"
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <button
        v-else
        type="button"
        class="agent-viewport-marker"
        :style="{ left: item.at.x + 'px', top: item.at.y + 'px' }"
        :title="t('shared.agentViewport.reveal', { label: item.label })"
        :aria-label="t('shared.agentViewport.reveal', { label: item.label })"
        @click="emit('reveal', item.frame)"
      >
        <Icon name="agent" class="agent-viewport-icon" />
        <Icon
          name="arrow-up"
          class="agent-viewport-arrow"
          :style="{ transform: `rotate(${item.at.angle + 90}deg)` }"
        />
      </button>
    </template>
  </div>
</template>

<style scoped>
/* Low-key, in the agent's color, never part of the document or in the way. */
.agent-viewports {
  position: absolute;
  inset: 0;
  /* Under the canvas's toolbars (10) and status strips (12). */
  z-index: 9;
  overflow: hidden;
  pointer-events: none;
}

.agent-viewport {
  position: absolute;
  border: 1px dashed var(--vscode-canvas-agent);
  border-radius: 2px;
}

.agent-viewport-label {
  position: absolute;
  left: -1px;
  bottom: 100%;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 320px;
  padding: 1px 2px 1px 4px;
  background-color: var(--vscode-overlay);
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  font-size: var(--text-caption);
  color: var(--vscode-canvas-agent);
  white-space: nowrap;
  pointer-events: auto;
}

.agent-viewport.label-inside .agent-viewport-label {
  top: 2px;
  left: 2px;
  bottom: auto;
  margin-bottom: 0;
}

.agent-viewport-label:focus-visible {
  outline: 1px solid var(--vscode-input-focus);
}

.agent-viewport-icon {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
}

.agent-viewport-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-viewport-close {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.agent-viewport-close svg {
  width: 12px;
  height: 12px;
}

.agent-viewport-close:hover {
  background-color: var(--vscode-overlay-control-hover);
  color: var(--vscode-text);
}

.agent-viewport-marker {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 6px;
  transform: translate(-50%, -50%);
  background-color: var(--vscode-overlay);
  border: 1px dashed var(--vscode-canvas-agent);
  border-radius: 4px;
  color: var(--vscode-canvas-agent);
  cursor: pointer;
  pointer-events: auto;
}

.agent-viewport-marker:hover {
  background-color: var(--vscode-overlay-control-hover);
}

.agent-viewport-arrow {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
}
</style>
