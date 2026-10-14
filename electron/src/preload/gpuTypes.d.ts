/**
 * Which GPU the app's WebGL canvases ask for on a machine with more than one —
 * WebGL's own `powerPreference` values, so the setting passes straight through.
 * Shared by main (config store) and renderer (context creation).
 */
export type GpuPowerPreference = 'default' | 'low-power' | 'high-performance'
