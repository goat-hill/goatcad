// Cross-select between a schematic and its board: selecting a part in one
// selects and reveals it in the other (split-view-workstream.md §6).
//
// A probe is an EVENT on a bus, never one editor reaching into the other, so the
// other editor may equally be across the split or in another window: local
// subscribers hear it directly and main relays it to the other windows — the
// project change bus's shape (lib/projectBus.ts).
//
// Only a user's own selection or highlight gesture emits. The receiving side
// selects or highlights programmatically, which emits nothing, so a probe
// cannot echo.

import type { CrossProbe, CrossProbeTarget } from '../../../preload/crossProbeTypes'
import type { KicadBoard, KicadBoardFootprint } from './kicad/board'
import { findChild, getFirstAtomValue } from './kicad/sexpr'
import { dirnameOf, resolveRelativePath } from './kicad/paths'

export type { CrossProbe, CrossProbeTarget }

/** Where a probe came from: the group it was made in, or another window. */
export interface CrossProbeSource {
  groupId: string | null
  remote: boolean
}

type Listener = (probe: CrossProbe, source: CrossProbeSource) => void

const listeners = new Set<Listener>()

export function onCrossProbe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let workspaceRoot: string | null = null

/** The window's workspace, stamped on what it emits; App keeps it current. */
export function setCrossProbeRoot(root: string | null): void {
  workspaceRoot = root
}

/** Announce a selection made in `groupId`, here and to the other windows. */
export function emitCrossProbe(
  origin: CrossProbe['origin'],
  targets: CrossProbeTarget[],
  groupId: string | null
): void {
  if (targets.length === 0) return
  const probe: CrossProbe = { root: workspaceRoot, origin, targets }
  for (const listener of listeners) listener(probe, { groupId, remote: false })
  window.api.notifyCrossProbe(probe)
}

/**
 * Announce a net highlighted in a schematic or a board, '' for cleared: the
 * other side lights the same net, as KiCad's cross-probe does. It moves no tab.
 */
export function emitNetProbe(
  origin: 'schematic' | 'board',
  net: string,
  groupId: string | null
): void {
  const probe: CrossProbe = { root: workspaceRoot, origin, targets: [], net }
  for (const listener of listeners) listener(probe, { groupId, remote: false })
  window.api.notifyCrossProbe(probe)
}

/** Deliver a probe another window made, if it is looking at the same workspace. */
export function receiveCrossProbe(probe: CrossProbe): void {
  if (probe.root !== workspaceRoot) return
  for (const listener of listeners) listener(probe, { groupId: null, remote: true })
}

const childText = (footprint: KicadBoardFootprint, token: string): string => {
  const node = findChild(footprint._raw, token)
  return node ? (getFirstAtomValue(node) ?? '') : ''
}

/** The symbol a board footprint is linked to: the last segment of its `(path …)`. */
export const symbolUuidOfFootprint = (footprint: KicadBoardFootprint): string | null => {
  const segments = childText(footprint, 'path').split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : null
}

/** What selecting these footprints says to a schematic. */
export const boardProbeTargets = (
  board: KicadBoard,
  boardPath: string,
  footprintIndices: readonly number[]
): CrossProbeTarget[] => {
  const targets: CrossProbeTarget[] = []
  for (const index of footprintIndices) {
    const footprint = board.footprints[index]
    const symbolUuid = footprint ? symbolUuidOfFootprint(footprint) : null
    if (!footprint || !symbolUuid) continue
    // `sheetfile` is spelled from the root sheet's folder, which is the board's.
    const sheetFile = childText(footprint, 'sheetfile')
    targets.push({
      symbolUuid,
      ...(sheetFile ? { sheetFile: resolveRelativePath(dirnameOf(boardPath), sheetFile) } : {})
    })
  }
  return targets
}

/**
 * The footprints a schematic selection names. A multi-unit part links by one
 * unit's uuid only, so a probe from another unit finds nothing — the reference
 * is the fallback the caller has (`referencesBySymbol`).
 */
export const footprintIndicesFor = (
  board: KicadBoard,
  symbolUuids: readonly string[],
  references: readonly string[] = []
): number[] => {
  const uuids = new Set(symbolUuids)
  const refs = new Set(references.filter((reference) => reference && !reference.endsWith('?')))
  const byUuid: number[] = []
  const byReference: number[] = []
  board.footprints.forEach((footprint, index) => {
    const uuid = symbolUuidOfFootprint(footprint)
    if (uuid && uuids.has(uuid)) byUuid.push(index)
    else if (footprint.reference && refs.has(footprint.reference)) byReference.push(index)
  })
  return byUuid.length > 0 ? byUuid : byReference
}
