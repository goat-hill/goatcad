/**
 * The Board Setup presets the user saved: constraint configurations (the
 * rules and the Default class's sizes) and stackup builds, each by name.
 *
 * App-wide, like the shipped ones they sit beside: a configuration is the
 * user's own fab or house style, carried from board to board. A board records
 * which it was set up with in its `.kicad_pro` (`BoardSetupChoice`), by the
 * preset's id; on a machine without the preset it reads as Custom.
 *
 * Main normalizes only the shape (numbers, booleans, strings); the renderer
 * store (`renderer/src/lib/board/userSetupPresets.ts`) holds each value to the
 * keys and ranges Board Setup knows.
 */

export interface SavedSetupProfile {
  /**
   * `user:<random UUID>`, made once when the name is first saved. Saving over the
   * name keeps it; a preset removed and saved again under its name gets a new
   * one, so a board set up with the removed one never claims its successor.
   */
  id: string
  /** What the user called it; saving the same name replaces it. */
  name: string
  /** Design rule → value, as `DesignRules` keys them (mm, counts, toggles). */
  rules: Record<string, number | boolean>
  /** The Default class's sizes, mm. */
  defaults: Record<string, number>
}

export interface SavedStackupPreset {
  /** As `SavedSetupProfile.id`. */
  id: string
  name: string
  /** The build as `StackupSpec` keys it: mm, a copper count, names. */
  spec: Record<string, number | string>
}

export interface BoardSetupPresets {
  profiles: SavedSetupProfile[]
  stackups: SavedStackupPreset[]
}
