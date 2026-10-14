/**
 * A keycap as the hint strips and key cards show it (DESIGN.md §Hotkeys): its
 * label, or a number key that steps a setting, marked up or down beside its
 * number so `1` and `2` read as a pair without words.
 */
export type KeyCap = string | { label: string; step: 'up' | 'down' }

export const keyCapLabel = (cap: KeyCap): string => (typeof cap === 'string' ? cap : cap.label)
