import { watch, type Ref, type WatchStopHandle } from 'vue'
import { themeColor, useAppTheme } from '../theme'
import { designHealthViewState } from '../designHealthView'
import { FindingMarkers, type FindingMarker } from './FindingMarkers'
import type { ViewportEngine } from './ViewportEngine'

/** A finding to mark, in the editor's own frame; the viewport maps it to the engine's. */
export interface DocumentMarker {
  key: string
  x: number
  y: number
  severity: 'error' | 'warning'
  selected?: boolean
}

/** Over the document and its chrome. */
const MARKER_Z = 0.9

/**
 * One viewport's finding markers (`FindingMarkers`): added to its engine's
 * scene once the engine exists, kept in step with the markers and the theme,
 * and asked what a click lands on. The viewport maps its editor's frame to
 * the engine's (`toWorld`) — a board viewed from the back mirrors x.
 */
export function findingMarkersLayer(
  markers: Ref<readonly DocumentMarker[] | undefined>,
  toWorld: (x: number, y: number) => { x: number; y: number },
  baseUnit: number
): {
  install(engine: ViewportEngine): void
  /** Map again: the frame changed (a board flipped). */
  refresh(): void
  /** The marker under a click, by its finding's key; null where there is none. */
  hitAt(event: { clientX: number; clientY: number }): string | null
  dispose(): void
} {
  let engine: ViewportEngine | null = null
  let layer: FindingMarkers | null = null
  const stops: WatchStopHandle[] = []
  const theme = useAppTheme()
  const view = designHealthViewState()

  const paint = (): void => {
    layer?.setColors(
      themeColor('--vscode-canvas-marker-error', '#ff3fb4'),
      themeColor('--vscode-canvas-marker-warning', '#ffb020'),
      themeColor('--vscode-canvas-marker-edge', '#0b0f0d')
    )
  }
  const place = (): void => {
    if (!layer || !engine) return
    const errorsOnly = view.value.errorsOnly
    const world: FindingMarker[] = (markers.value ?? [])
      .filter((m) => !errorsOnly || m.severity === 'error')
      .map((m) => ({
        ...toWorld(m.x, m.y),
        key: m.key,
        severity: m.severity,
        ...(m.selected ? { selected: true } : {})
      }))
    layer.setMarkers(world)
    engine.render()
  }

  return {
    install(next) {
      engine = next
      layer = new FindingMarkers(MARKER_Z, baseUnit)
      next.scene.add(layer.object)
      next.registerScreenScaled(layer)
      paint()
      place()
      stops.push(watch(markers, place))
      stops.push(watch(() => view.value.errorsOnly, place))
      stops.push(
        watch(theme, () => {
          paint()
          engine?.render()
        })
      )
    },
    refresh: place,
    hitAt(event) {
      if (!engine || !layer) return null
      const at = engine.clientToWorld(event)
      return layer.hit(at.x, at.y)?.key ?? null
    },
    dispose() {
      for (const stop of stops) stop()
      if (engine && layer) {
        engine.unregisterScreenScaled(layer)
        engine.scene.remove(layer.object)
      }
      layer?.dispose()
      layer = null
      engine = null
    }
  }
}
