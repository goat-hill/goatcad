import { reactive } from 'vue'
import { DEFAULT_CLEANUP_OPTIONS, type CleanupKind, type CleanupOptions } from './trackCleanup'

/** What the Clean up tracks and vias dialog asks for: the passes and what they reach. */
export interface CleanupRequest {
  options: CleanupOptions
  /** Refill the zones first when their fills are out of date, and after. */
  refill: boolean
  /** Only the selected tracks and vias. */
  selectionOnly: boolean
  /** Only copper on this net. */
  net: number | null
  /** Only copper on this copper layer. */
  layer: string | null
}

/** One change of the dialog's preview. */
export interface CleanupRow {
  key: string
  kind: CleanupKind
  /** Where, in file millimeters: `x, y`. */
  at: string
  net: string
  layer: string
}

/** The passes and the refill, kept for the session as last chosen. */
export const cleanupChoice = reactive<{ options: CleanupOptions; refill: boolean }>({
  options: { ...DEFAULT_CLEANUP_OPTIONS },
  refill: true
})
