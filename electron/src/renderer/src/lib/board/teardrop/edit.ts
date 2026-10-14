/**
 * Edit teardrops, KiCad's Edit ▸ Edit Teardrops (`DIALOG_GLOBAL_EDIT_TEARDROPS`):
 * turn teardrops on, set or off for the pads and vias a target and filter
 * pick, then rebuild every teardrop. The dialog and `board_set_teardrops` both
 * run it, as one command.
 */
import type { KicadBoard, KicadVia } from '../../kicad/board'
import { padOnLayer, type KicadPad } from '../../kicad/footprint'
import type { SExprList } from '../../kicad/sexpr'
import type { BoardSession } from '../boardSession'
import { boardIndex } from '../spatialIndex'
import {
  applyTeardropPlan,
  clearLegacyTeardrops,
  planTeardrops,
  type TeardropOptions
} from './manager'
import {
  readTeardropParams,
  writeTeardropParams,
  type TeardropParams,
  type TeardropSettings
} from './params'

export type TeardropAction = 'add' | 'set' | 'remove' | 'removeAll'

export interface TeardropEdit {
  action: TeardropAction
  targets: { vias: boolean; pthPads: boolean; smdPads: boolean; trackToTrack: boolean }
  /** Only round pads (and every via). */
  roundOnly?: boolean
  /** Only pads and vias that have teardrops already. */
  existingOnly?: boolean
  /** Only these pads and vias. */
  items?: ReadonlySet<KicadPad | KicadVia>
  /** Only pads and vias on these nets. */
  nets?: ReadonlySet<number>
  /** Only pads and vias on these copper layers. */
  layers?: ReadonlySet<string>
  /** For `set`: the values to write; an absent one keeps each item's own. */
  values?: Partial<Omit<TeardropParams, 'enabled'>>
}

export interface TeardropEditResult {
  pads: number
  vias: number
  /** The pads and vias written. */
  touched: Array<KicadPad | KicadVia>
  /** The board's settings after the edit: Edit teardrops remembers its targets. */
  settings: TeardropSettings
}

const isRoundPad = (pad: KicadPad): boolean => {
  const on = padOnLayer(pad, 'F.Cu')
  return on.shape === 'circle' || (on.shape === 'oval' && on.size.w === on.size.h)
}

const padOn = (pad: KicadPad, layer: string): boolean =>
  pad.layers.some(
    (l) =>
      l === layer ||
      (l === '*.Cu' && layer.endsWith('.Cu')) ||
      (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu'))
  )

/** Write the edit's settings into the board's pads and vias; the counts of each changed. */
export function applyTeardropEdit(
  board: KicadBoard,
  edit: TeardropEdit,
  settings: TeardropSettings,
  /** False counts what the edit would reach and writes nothing. */
  write = true
): TeardropEditResult {
  const removeAll = edit.action === 'removeAll'
  let pads = 0
  let vias = 0
  const touched: Array<KicadPad | KicadVia> = []
  const next = (current: TeardropParams, round: boolean): TeardropParams => {
    switch (edit.action) {
      case 'remove':
      case 'removeAll':
        return { ...current, enabled: false }
      case 'add':
        return { ...(round ? settings.round : settings.rect), enabled: true }
      case 'set':
        return { ...current, ...edit.values, enabled: edit.existingOnly ? current.enabled : true }
    }
  }
  const picked = (
    item: KicadPad | KicadVia,
    net: number,
    onLayer: (l: string) => boolean,
    round: boolean
  ): boolean => {
    if (removeAll) return true
    if (edit.items && !edit.items.has(item)) return false
    if (edit.nets && !edit.nets.has(net)) return false
    if (edit.layers && ![...edit.layers].some(onLayer)) return false
    if (edit.roundOnly && !round) return false
    if (edit.existingOnly && !readTeardropParams(item._raw as SExprList).enabled) return false
    return true
  }
  if (edit.targets.vias || removeAll)
    for (const via of board.vias) {
      if (!picked(via, via.net, (l) => via.layers.includes(l), true)) continue
      const current = readTeardropParams(via._raw)
      if (write) writeTeardropParams(via._raw, next(current, true), 'via', via._raw)
      touched.push(via)
      vias++
    }
  for (const fp of board.footprints)
    for (const pad of fp.footprint.pads) {
      const smd = pad.type === 'smd' || pad.type === 'connect'
      const wanted =
        removeAll || (pad.type === 'thru_hole' ? edit.targets.pthPads : smd && edit.targets.smdPads)
      if (!wanted) continue
      const round = isRoundPad(pad)
      if (!picked(pad, pad.net?.number ?? 0, (l) => padOn(pad, l), round)) continue
      const raw = pad._raw as SExprList
      if (write) writeTeardropParams(raw, next(readTeardropParams(raw), round), 'pad', fp._raw)
      touched.push(pad)
      pads++
    }

  // KiCad keeps track-to-track's switch in memory; here it is the target saved.
  const t = edit.targets
  const trackToTrack = t.trackToTrack
    ? edit.action === 'add' || edit.action === 'set'
    : settings.targets.trackToTrack
  return {
    pads,
    vias,
    touched,
    settings: {
      ...settings,
      track: { ...settings.track, enabled: trackToTrack },
      targets: {
        vias: t.vias,
        pthPads: t.pthPads,
        smdPads: t.smdPads,
        trackToTrack,
        roundShapesOnly: edit.roundOnly ?? false
      }
    }
  }
}

/**
 * Run an edit as one command on a session: the settings written, every
 * teardrop rebuilt, a KiCad 7 board's teardrops taken over (as KiCad's dialog
 * clears `legacy_teardrops`). Null when the session refused the command.
 */
export function editTeardrops(
  session: BoardSession,
  label: string,
  edit: TeardropEdit
): TeardropEditResult | null {
  const board = session.board()
  if (!board) return null
  const options: TeardropOptions = session.teardropOptions()
  let result: TeardropEditResult | null = null
  const ok = session.runCommand(
    label,
    () => {
      clearLegacyTeardrops(board)
      result = applyTeardropEdit(board, edit, options.settings)
      const plan = planTeardrops(board, boardIndex(board), 'all', {
        ...options,
        settings: result.settings
      })
      applyTeardropPlan(board, plan, session.teardropOwners())
    },
    { teardrops: false }
  )
  return ok ? result : null
}

/** What the Edit teardrops dialog asks for, before its net, class and selection are resolved. */
export interface TeardropDialogRequest {
  action: TeardropAction
  targets: { vias: boolean; pthPads: boolean; smdPads: boolean; trackToTrack: boolean }
  selectionOnly: boolean
  net: number | null
  netClass: string | null
  layer: string | null
  roundOnly: boolean
  existingOnly: boolean
  /** For set: lengths in nm, ratios as fractions; an absent one keeps each item's own. */
  values: {
    bestLengthRatio?: number
    maxLength?: number
    bestWidthRatio?: number
    maxWidth?: number
    filterRatio?: number
    curvedEdges?: boolean
    allowTwoSegments?: boolean
    preferZoneConnections?: boolean
  }
}
