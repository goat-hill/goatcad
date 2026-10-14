/**
 * Teardrop settings: a pad's or via's `(teardrops …)` block
 * (`PCB_IO_KICAD_SEXPR_PARSER::parseTEARDROP_PARAMETERS`) and the board's
 * defaults in `.kicad_pro` (`board.design_settings.teardrop_parameters` and
 * `teardrop_options`, `BOARD_DESIGN_SETTINGS`). Lengths are integer nm.
 */
import {
  findChild,
  getFirstAtomValue,
  getToken,
  makeAtom,
  makeList,
  markNodeDirty,
  type SExprList,
  type SExprNode
} from '../../kicad/sexpr'
import { formatNmAtom, mmAtomToNm, mmToNm, nmToMm, type Nm } from '../../kicad/coordinates'

/** `TEARDROP_PARAMETERS`. */
export interface TeardropParams {
  enabled: boolean
  /** Best length, as a share of the pad's or via's size. */
  bestLengthRatio: number
  /** nm. */
  maxLength: number
  /** Best width, as a share of the pad's or via's size. */
  bestWidthRatio: number
  /** nm. */
  maxWidth: number
  curvedEdges: boolean
  /** A track at least this share of the pad's or via's size gets none. */
  filterRatio: number
  allowTwoSegments: boolean
  /** Skip a pad a zone of its net already joins to the track (KiCad stores the inverse). */
  preferZoneConnections: boolean
}

/** `TEARDROP_PARAMETERS`' constructor. */
export const DEFAULT_TEARDROP: Readonly<TeardropParams> = {
  enabled: false,
  bestLengthRatio: 0.5,
  maxLength: mmToNm(1),
  bestWidthRatio: 1,
  maxWidth: mmToNm(2),
  curvedEdges: false,
  filterRatio: 0.9,
  allowTwoSegments: true,
  preferZoneConnections: true
}

const flag = (node: SExprList, token: string): boolean | undefined => {
  const child = findChild(node, token)
  if (!child) return undefined
  // `parseMaybeAbsentBool`: a bare token means yes.
  const v = getFirstAtomValue(child)
  return v === undefined ? true : v === 'yes' || v === 'true'
}

const number = (node: SExprList, token: string): number | undefined => {
  const child = findChild(node, token)
  const v = child ? getFirstAtomValue(child) : undefined
  return v === undefined ? undefined : Number(v)
}

/**
 * A pad's or via's settings: its `(teardrops …)` block over the defaults the
 * parser starts from (off, one segment, no zone preference), or the plain
 * defaults when it has none.
 */
export function readTeardropParams(item: SExprList): TeardropParams {
  const node = findChild(item, 'teardrops')
  if (!node) return { ...DEFAULT_TEARDROP }
  const len = (token: string, fallback: number): number => {
    const child = findChild(node, token)
    const v = child ? getFirstAtomValue(child) : undefined
    return v === undefined ? fallback : mmAtomToNm(v)
  }
  const curvePoints = number(node, 'curve_points')
  return {
    enabled: flag(node, 'enabled') ?? false,
    bestLengthRatio: number(node, 'best_length_ratio') ?? DEFAULT_TEARDROP.bestLengthRatio,
    maxLength: len('max_length', DEFAULT_TEARDROP.maxLength),
    bestWidthRatio: number(node, 'best_width_ratio') ?? DEFAULT_TEARDROP.bestWidthRatio,
    maxWidth: len('max_width', DEFAULT_TEARDROP.maxWidth),
    curvedEdges:
      flag(node, 'curved_edges') ??
      (curvePoints !== undefined ? curvePoints > 0 : DEFAULT_TEARDROP.curvedEdges),
    filterRatio: number(node, 'filter_ratio') ?? DEFAULT_TEARDROP.filterRatio,
    allowTwoSegments: flag(node, 'allow_two_segments') ?? false,
    preferZoneConnections: flag(node, 'prefer_zone_connections') ?? false
  }
}

/** `isDefaultTeardropParameters`: KiCad writes no block for these. */
export function isDefaultTeardrop(p: TeardropParams): boolean {
  return (Object.keys(DEFAULT_TEARDROP) as (keyof TeardropParams)[]).every(
    (k) => p[k] === DEFAULT_TEARDROP[k]
  )
}

/** The board's defaults per shape, and which items Edit teardrops last aimed at. */
export interface TeardropSettings {
  round: TeardropParams
  rect: TeardropParams
  /** Track to track; `track.enabled` is `targets.trackToTrack`. */
  track: TeardropParams
  targets: {
    vias: boolean
    pthPads: boolean
    smdPads: boolean
    trackToTrack: boolean
    roundShapesOnly: boolean
  }
}

export const DEFAULT_TEARDROP_SETTINGS: Readonly<TeardropSettings> = {
  round: DEFAULT_TEARDROP,
  rect: DEFAULT_TEARDROP,
  track: DEFAULT_TEARDROP,
  targets: { vias: true, pthPads: true, smdPads: true, trackToTrack: false, roundShapesOnly: false }
}

const TARGET_NAMES = {
  round: 'td_round_shape',
  rect: 'td_rect_shape',
  track: 'td_track_end'
} as const

type Json = Record<string, unknown>

/**
 * The board's teardrop settings from `.kicad_pro` text, as
 * `BOARD_DESIGN_SETTINGS` loads them. KiCad keeps track-to-track's `enabled`
 * only in memory; here it is `td_ontrackend`, the target Edit Teardrops saves.
 */
export function extractTeardropSettings(projectJsonText: string | null): TeardropSettings {
  const out: TeardropSettings = {
    round: { ...DEFAULT_TEARDROP },
    rect: { ...DEFAULT_TEARDROP },
    track: { ...DEFAULT_TEARDROP },
    targets: { ...DEFAULT_TEARDROP_SETTINGS.targets }
  }
  let ds: Json | undefined
  try {
    const json = projectJsonText ? (JSON.parse(projectJsonText) as Json) : null
    ds = ((json?.board as Json | undefined)?.design_settings as Json | undefined) ?? undefined
  } catch {
    ds = undefined
  }
  const options = Array.isArray(ds?.teardrop_options) ? (ds.teardrop_options as Json[]) : []
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue
    const b = (k: string): boolean | undefined =>
      typeof entry[k] === 'boolean' ? (entry[k] as boolean) : undefined
    out.targets.vias = b('td_onvia') ?? out.targets.vias
    out.targets.pthPads = b('td_onpthpad') ?? out.targets.pthPads
    out.targets.smdPads = b('td_onsmdpad') ?? out.targets.smdPads
    out.targets.trackToTrack = b('td_ontrackend') ?? out.targets.trackToTrack
    out.targets.roundShapesOnly = b('td_onroundshapesonly') ?? out.targets.roundShapesOnly
    // Legacy settings, applied to every shape.
    for (const p of [out.round, out.rect, out.track]) {
      p.allowTwoSegments = b('td_allow_use_two_tracks') ?? p.allowTwoSegments
      if (typeof entry.td_curve_segcount === 'number' && entry.td_curve_segcount > 0)
        p.curvedEdges = true
      const onPadsInZones = b('td_on_pad_in_zone')
      if (onPadsInZones !== undefined) p.preferZoneConnections = !onPadsInZones
    }
  }
  const params = Array.isArray(ds?.teardrop_parameters) ? (ds.teardrop_parameters as Json[]) : []
  for (const entry of params) {
    if (!entry || typeof entry !== 'object') continue
    const key = (Object.keys(TARGET_NAMES) as (keyof typeof TARGET_NAMES)[]).find(
      (k) => TARGET_NAMES[k] === entry.td_target_name
    )
    if (!key) continue
    const p = out[key]
    const n = (k: string): number | undefined =>
      typeof entry[k] === 'number' ? (entry[k] as number) : undefined
    const maxLen = n('td_maxlen')
    if (maxLen !== undefined) p.maxLength = mmToNm(maxLen)
    const maxHeight = n('td_maxheight')
    if (maxHeight !== undefined) p.maxWidth = mmToNm(maxHeight)
    p.bestLengthRatio = n('td_length_ratio') ?? p.bestLengthRatio
    p.bestWidthRatio = n('td_height_ratio') ?? p.bestWidthRatio
    if ((n('td_curve_segcount') ?? 0) > 0) p.curvedEdges = true
    p.filterRatio = n('td_width_to_size_filter_ratio') ?? p.filterRatio
    if (typeof entry.td_allow_use_two_tracks === 'boolean')
      p.allowTwoSegments = entry.td_allow_use_two_tracks
    if (typeof entry.td_on_pad_in_zone === 'boolean')
      p.preferZoneConnections = !entry.td_on_pad_in_zone
  }
  out.track.enabled = out.targets.trackToTrack
  return out
}

/**
 * `.kicad_pro` text with the teardrop settings written as KiCad writes them,
 * keys sorted as its JSON is; null when the text is not JSON.
 */
export function patchTeardropSettings(
  projectJsonText: string,
  settings: TeardropSettings
): string | null {
  let json: Json
  try {
    json = JSON.parse(projectJsonText) as Json
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const board = (json.board as Json | undefined) ?? {}
  const ds = (board.design_settings as Json | undefined) ?? {}
  const entry = (name: string, p: TeardropParams): Json => ({
    td_allow_use_two_tracks: p.allowTwoSegments,
    td_curve_segcount: p.curvedEdges ? 1 : 0,
    td_height_ratio: p.bestWidthRatio,
    td_length_ratio: p.bestLengthRatio,
    td_maxheight: nmToMm(p.maxWidth as Nm),
    td_maxlen: nmToMm(p.maxLength as Nm),
    td_on_pad_in_zone: !p.preferZoneConnections,
    td_target_name: name,
    td_width_to_size_filter_ratio: p.filterRatio
  })
  const t = settings.targets
  json.board = {
    ...board,
    design_settings: {
      ...ds,
      teardrop_options: [
        {
          td_onpthpad: t.pthPads,
          td_onroundshapesonly: t.roundShapesOnly,
          td_onsmdpad: t.smdPads,
          td_ontrackend: t.trackToTrack,
          td_onvia: t.vias
        }
      ],
      teardrop_parameters: [
        entry(TARGET_NAMES.round, settings.round),
        entry(TARGET_NAMES.rect, settings.rect),
        entry(TARGET_NAMES.track, settings.track)
      ]
    }
  }
  return `${JSON.stringify(json, null, 2)}\n`
}

/** `FormatDouble2Str`: ten significant digits, no trailing zeros. */
const formatRatio = (v: number): string => String(Number(v.toPrecision(10)))

/**
 * Write a pad's or via's settings as KiCad does (`formatTeardropParameters`):
 * no block at all for the defaults, else the whole block, a via's before its
 * `(net …)` and a pad's before its `(tenting …)` or `(uuid …)`. `top` is the
 * board item that holds it, marked dirty first (the via, or the pad's footprint).
 */
export function writeTeardropParams(
  item: SExprList,
  params: TeardropParams,
  kind: 'pad' | 'via',
  top: SExprNode
): void {
  markNodeDirty(top)
  const at = item.start
  const index = item.children.findIndex((c) => c.type === 'list' && getToken(c) === 'teardrops')
  if (isDefaultTeardrop(params)) {
    if (index >= 0) item.children.splice(index, 1)
    return
  }
  const yn = (b: boolean): string => (b ? 'yes' : 'no')
  const value = (token: string, v: string): SExprList =>
    makeList([makeAtom(token, false, at), makeAtom(v, false, at)], at)
  const node = makeList(
    [
      makeAtom('teardrops', false, at),
      value('best_length_ratio', formatRatio(params.bestLengthRatio)),
      value('max_length', formatNmAtom(params.maxLength as Nm)),
      value('best_width_ratio', formatRatio(params.bestWidthRatio)),
      value('max_width', formatNmAtom(params.maxWidth as Nm)),
      value('curved_edges', yn(params.curvedEdges)),
      value('filter_ratio', formatRatio(params.filterRatio)),
      value('enabled', yn(params.enabled)),
      value('allow_two_segments', yn(params.allowTwoSegments)),
      value('prefer_zone_connections', yn(params.preferZoneConnections))
    ],
    at
  )
  if (index >= 0) {
    item.children[index] = node
    return
  }
  const before =
    kind === 'via' ? ['net', 'uuid', 'tstamp'] : ['tenting', 'uuid', 'tstamp', 'padstack']
  const at2 = item.children.findIndex(
    (c) => c.type === 'list' && before.includes(getToken(c) ?? '')
  )
  if (at2 >= 0) item.children.splice(at2, 0, node)
  else item.children.push(node)
}

/** The Properties rows' keys: a pad's or via's teardrop settings, ratios shown in percent. */
export const TEARDROP_ROWS = [
  'teardropsEnabled',
  'teardropBestLength',
  'teardropMaxLength',
  'teardropBestWidth',
  'teardropMaxWidth',
  'teardropCurved',
  'teardropTwoSegments',
  'teardropMaxTrackWidth',
  'teardropPreferZone'
] as const

/** A row's value on an item's settings, as the row shows it. */
export function teardropRowValue(
  p: TeardropParams,
  key: (typeof TEARDROP_ROWS)[number]
): number | boolean {
  switch (key) {
    case 'teardropsEnabled':
      return p.enabled
    case 'teardropBestLength':
      return Math.round(p.bestLengthRatio * 1000) / 10
    case 'teardropMaxLength':
      return p.maxLength
    case 'teardropBestWidth':
      return Math.round(p.bestWidthRatio * 1000) / 10
    case 'teardropMaxWidth':
      return p.maxWidth
    case 'teardropCurved':
      return p.curvedEdges
    case 'teardropTwoSegments':
      return p.allowTwoSegments
    case 'teardropMaxTrackWidth':
      return Math.round(p.filterRatio * 1000) / 10
    case 'teardropPreferZone':
      return p.preferZoneConnections
  }
}

/** An item's settings with one row edited; null for a key that is no teardrop row. */
export function teardropRowEdit(
  p: TeardropParams,
  key: string,
  value: unknown
): TeardropParams | null {
  const n = typeof value === 'number' ? value : Number(value) || 0
  const b = !!value
  switch (key) {
    case 'teardropsEnabled':
      return { ...p, enabled: b }
    case 'teardropBestLength':
      return { ...p, bestLengthRatio: n / 100 }
    case 'teardropMaxLength':
      return { ...p, maxLength: Math.round(n) }
    case 'teardropBestWidth':
      return { ...p, bestWidthRatio: n / 100 }
    case 'teardropMaxWidth':
      return { ...p, maxWidth: Math.round(n) }
    case 'teardropCurved':
      return { ...p, curvedEdges: b }
    case 'teardropTwoSegments':
      return { ...p, allowTwoSegments: b }
    case 'teardropMaxTrackWidth':
      return { ...p, filterRatio: n / 100 }
    case 'teardropPreferZone':
      return { ...p, preferZoneConnections: b }
    default:
      return null
  }
}

/**
 * A pad's or via's `teardrops` record key, as `items_get` answers it and
 * `board_set_teardrops` takes its values: lengths in mm, ratios as fractions.
 * Absent for an item at the defaults, which has none.
 */
export function teardropRecordOf(item: SExprList): {
  teardrops?: Record<string, number | boolean>
} {
  const p = readTeardropParams(item)
  if (isDefaultTeardrop(p)) return {}
  return {
    teardrops: {
      enabled: p.enabled,
      bestLengthRatio: p.bestLengthRatio,
      maxLength: nmToMm(p.maxLength as Nm),
      bestWidthRatio: p.bestWidthRatio,
      maxWidth: nmToMm(p.maxWidth as Nm),
      curvedEdges: p.curvedEdges,
      filterRatio: p.filterRatio,
      allowTwoSegments: p.allowTwoSegments,
      preferZoneConnections: p.preferZoneConnections
    }
  }
}

/** An item's settings with a record's `teardrops` written over them; null returns them to the defaults. */
export function teardropsFromRecord(item: SExprList, value: unknown): TeardropParams {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_TEARDROP }
  const r = value as Record<string, unknown>
  const p = readTeardropParams(item)
  const num = (k: string): number | undefined =>
    typeof r[k] === 'number' ? (r[k] as number) : undefined
  const bool = (k: string): boolean | undefined =>
    typeof r[k] === 'boolean' ? (r[k] as boolean) : undefined
  const len = (k: string): number | undefined => {
    const v = num(k)
    return v === undefined ? undefined : mmToNm(v)
  }
  return {
    enabled: bool('enabled') ?? p.enabled,
    bestLengthRatio: num('bestLengthRatio') ?? p.bestLengthRatio,
    maxLength: len('maxLength') ?? p.maxLength,
    bestWidthRatio: num('bestWidthRatio') ?? p.bestWidthRatio,
    maxWidth: len('maxWidth') ?? p.maxWidth,
    curvedEdges: bool('curvedEdges') ?? p.curvedEdges,
    filterRatio: num('filterRatio') ?? p.filterRatio,
    allowTwoSegments: bool('allowTwoSegments') ?? p.allowTwoSegments,
    preferZoneConnections: bool('preferZoneConnections') ?? p.preferZoneConnections
  }
}
