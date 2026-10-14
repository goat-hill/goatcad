/**
 * A 2D viewport's remembered framing, as persisted state.
 *
 * Zoom and pan ride on the window session rather than the config store: the
 * framing belongs to an open tab, so it is restored with that tab, dropped
 * when it closes, and never written to a KiCad file — KiCad does not persist a
 * camera at all, and a file that changed every time someone scrolled would be
 * a file the user has to think about.
 *
 * The renderer-side store is `renderer/src/lib/engine/cameraStore.ts`, which
 * keys on a subject rather than a file: one tab may frame several (the symbol
 * editor's units), so a tab carries a map, keyed by what follows its path.
 */

export interface CameraState2D {
  x: number
  y: number
  zoom: number
}

/** A tab's cameras, keyed by the remainder of the subject key after its path. */
export type TabCameras = Record<string, CameraState2D>
