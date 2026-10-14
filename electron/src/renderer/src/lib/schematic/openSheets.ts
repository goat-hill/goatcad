/**
 * The schematic documents open in the app, by absolute path.
 *
 * A hierarchy spans files, and any of them may be open in another tab with
 * unsaved edits. Every cross-sheet reader — the hierarchy resolver, the
 * connectivity inputs, the checks over both — otherwise sees a sibling from
 * disk, or from a copy cached when the tree was last resolved, and neither is
 * what the user is looking at. The visible symptom is a check that fires and
 * cannot be cleared: a hierarchical label added in the child does not resolve
 * the parent's `sheet-pin-unmatched`, because the parent is still matching
 * against the child as it was.
 *
 * The source is the tab store rather than an editor, because **exactly one
 * editor exists** — `EditorArea` mounts the active tab's and keys it on the
 * path, so switching tabs destroys it. Only the tab store holds every open
 * sheet, edited or not, and only it can answer for the sheet nobody is looking
 * at. Text in, parse out, cached until the text changes: a check runs over
 * every sibling and must not re-parse them each time.
 */
import { shallowRef } from 'vue'
import { samePath } from '../kicad/paths'
import {
  parseKicadSchematic,
  serializeKicadSchematic,
  type KicadSchematic
} from '../kicad/schematic'
import { browserHierarchyFs, type HierarchyFs } from './hierarchy'
import { formatUpgrader } from '../formatUpgrade'

/** Live text for an open sheet, or null when no tab holds it. */
export type OpenSheetSource = (path: string) => string | null

let source: OpenSheetSource | null = null
const parsed = new Map<string, { text: string; document: KicadSchematic }>()

/** Register the tab store as the source. Returns the unregister. */
export const setOpenSheetSource = (read: OpenSheetSource): (() => void) => {
  source = read
  return () => {
    if (source === read) {
      source = null
      parsed.clear()
    }
  }
}

/** The live document for a path, or null when no open tab holds it. */
export const openSheetAt = (path: string): KicadSchematic | null => {
  const text = source?.(path) ?? null
  if (text === null) return null
  const hit = parsed.get(path)
  if (hit && hit.text === text) return hit.document
  try {
    const document = parseKicadSchematic(text)
    parsed.set(path, { text, document })
    return document
  } catch {
    // A sheet mid-edit can be unparseable; the caller falls back to disk.
    return null
  }
}

/** Whether two paths name the same file, as the rest of the hierarchy compares
 *  them — exported so a source can match its own keys the same way. */
export const sameSheetPath = samePath

/**
 * Bumped whenever an open sheet's text changes without its editor doing it —
 * a write to a sheet no editor is mounted for, a sibling's rewrite, a rename's
 * forwarding. A mounted editor's cross-sheet readers depend on it, so a rail
 * driven on a sheet written behind the tab clears on the sheet in front.
 */
export const openSheetsVersion = shallowRef(0)

export const noteOpenSheetChanged = (): void => {
  openSheetsVersion.value += 1
}

/**
 * Disk, except where a tab holds the sheet — there the buffer is the truth.
 *
 * The hierarchy resolver reads every sheet through this, so without the
 * override a sheet added and not yet saved does not exist to it: the tree comes
 * back without the child, and the checks that police the boundary pass a block
 * they cannot see. The seam is why `HierarchyFs` is injected at all.
 */
export const liveHierarchyFs: HierarchyFs = {
  readFile: async (path: string) => {
    const live = openSheetAt(path)
    if (live) return serializeKicadSchematic(live)
    // A sheet no tab holds reads as an open one would: migrated to KiCad 10.
    const disk = await browserHierarchyFs.readFile(path)
    return disk === null ? null : formatUpgrader.upgrade(path, disk)
  },
  listSchematics: (dir: string) => browserHierarchyFs.listSchematics(dir)
}
