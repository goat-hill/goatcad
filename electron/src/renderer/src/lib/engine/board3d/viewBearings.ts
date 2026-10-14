import type { ViewPreset } from '../Viewport3DEngine'

/**
 * Each 3D view preset as a camera bearing, degrees. Azimuth 0 looks from the
 * front (the board's bottom edge), 90 from the right; elevation 90 is straight
 * down. `iso` and `front` are the PCB editor's 3D presets, in degrees — keep
 * them in step with `view3DDirection` in `ViewportEngine.ts`. Its own module
 * so the board door can read it without the 3D engine.
 */
export const VIEW_BEARINGS: Record<ViewPreset, { azimuth: number; elevation: number }> = {
  iso: { azimuth: 41.28, elevation: 29.6 },
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
  front: { azimuth: 0, elevation: 6.84 },
  back: { azimuth: 180, elevation: 0 },
  right: { azimuth: 90, elevation: 0 },
  left: { azimuth: -90, elevation: 0 }
}
