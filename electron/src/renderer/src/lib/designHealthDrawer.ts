import { computed, type ComputedRef } from 'vue'
import { sectionState, setSectionCollapsed, setSectionHeight } from './panelLayout'

export type HealthEditor = 'schematic' | 'pcb' | 'footprint' | 'symbol'

export const HEALTH_DRAWER_DEFAULT_HEIGHT = 180
/** Past this the canvas above it is a strip; the list scrolls instead. */
export const HEALTH_DRAWER_MAX_HEIGHT = 480

export interface HealthDrawerState {
  open: ComputedRef<boolean>
  height: ComputedRef<number>
  toggle(): void
  show(): void
  close(): void
  resize(height: number, commit?: boolean): void
}

/**
 * Whether an editor kind's findings drawer is open, and how tall. Per editor
 * kind and kept in the panel-layout store, because a tab switch destroys the
 * editor (`panelLayout.ts`) and the drawer should be where it was left.
 */
export const useHealthDrawer = (editor: HealthEditor): HealthDrawerState => {
  const id = `design-health:${editor}`
  const state = sectionState(id)
  const open = computed(() => state.value.collapsed === false)
  return {
    open,
    height: computed(() => state.value.height ?? HEALTH_DRAWER_DEFAULT_HEIGHT),
    toggle: () => setSectionCollapsed(id, open.value),
    show: () => setSectionCollapsed(id, false),
    close: () => setSectionCollapsed(id, true),
    resize: (height, commit = false) =>
      setSectionHeight(id, Math.min(HEALTH_DRAWER_MAX_HEIGHT, height), commit)
  }
}
