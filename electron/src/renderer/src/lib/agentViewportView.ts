/**
 * What the person sees of the agents' viewports on their own canvases
 * (docs/agent-api.md, "The agent viewport"): a dashed box round
 * each viewport's last frame, labeled as the agent's, with a × that closes
 * it. Never part of the document, and nothing of the person's view moves for
 * it. An agent's uncommitted route is not drawn here, only in the picture its
 * call answers.
 *
 * The window's viewport registry (`agentViewports.ts`) publishes here on every
 * change; each canvas reads its own document's. Closing from the canvas runs
 * the registry's own close, registered once by the window.
 */
import type * as THREE from 'three'
import { shallowRef } from 'vue'
import type { ViewInsets } from './engine/bringIntoView'
import type { ViewportEngine } from './engine/ViewportEngine'
import { measureViewportInsets } from './engine/viewportInsets'

/** A rectangle in the document's millimeters, y down. */
export interface ViewportFrame {
  x: number
  y: number
  width: number
  height: number
}

/** One agent viewport as a canvas shows it. */
export interface AgentViewportShown {
  id: string
  /** The document it is on. */
  path: string
  /** The agent's label. */
  label: string
  /** What its last activity framed; null before anything did, when no box shows. */
  frame: ViewportFrame | null
}

const NONE: readonly AgentViewportShown[] = []

/** Replaced whole on every change, so a reader's computed re-runs. */
const shown = shallowRef<Readonly<Record<string, readonly AgentViewportShown[]>>>({})
let closer: ((id: string) => void) | null = null

/** Show every live viewport, replacing what was shown. */
export function showAgentViewports(list: readonly AgentViewportShown[]): void {
  const next: Record<string, AgentViewportShown[]> = {}
  for (const viewport of list) (next[viewport.path] ??= []).push(viewport)
  shown.value = next
}

/** The viewports shown on a document, read reactively. */
export function agentViewportsFor(path: string | null | undefined): readonly AgentViewportShown[] {
  return path ? (shown.value[path] ?? NONE) : NONE
}

/** The registry's close for the person's ×. */
export function onAgentViewportClose(close: ((id: string) => void) | null): void {
  closer = close
}

/** The person closes a viewport from the canvas. */
export function closeAgentViewport(id: string): void {
  closer?.(id)
}

/**
 * A canvas's handlers for AgentViewportOverlay. `toBox` maps a frame into the
 * engine's space (the board mirrors x while flipped); `chrome` names what floats
 * over the canvas, which a box's edge marker keeps clear of. The camera moves
 * only on `reveal`, when the person clicks a marker, and then as their own view.
 */
export function agentViewportHandlers(
  engine: () => ViewportEngine | null,
  toBox: (frame: ViewportFrame) => THREE.Box3,
  container: () => HTMLElement | null | undefined,
  chrome: readonly string[]
): {
  toScreen: (
    frame: ViewportFrame
  ) => { minX: number; minY: number; maxX: number; maxY: number } | null
  markerInsets: () => ViewInsets
  reveal: (frame: ViewportFrame) => void
} {
  return {
    toScreen: (frame) => {
      const view = engine()
      if (!view) return null
      const box = toBox(frame)
      const a = view.worldToScreen(box.min.x, box.min.y)
      const b = view.worldToScreen(box.max.x, box.max.y)
      return {
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y)
      }
    },
    markerInsets: () => {
      const host = container()
      return measureViewportInsets(host, chrome, host?.closest<HTMLElement>('.viewport-host-area'))
    },
    reveal: (frame) => {
      const view = engine()
      if (!view) return
      view.zoomToFit(toBox(frame))
      view.markViewFramedByUser()
    }
  }
}
