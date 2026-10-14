/**
 * Which via a route places, and where it goes (docs/router-behavior.md R24,
 * R35, R40–R42): the layer pair, the via's type and the layers it spans,
 * as KiCad's router decides them (`ROUTER_TOOL::handleLayerSwitch`). Pure —
 * the editor supplies the board's copper, the pair and the copper the route
 * is headed for.
 */

/** What a route's via is: through every layer, blind or buried between two, or a microvia. */
export type RouteViaType = 'through' | 'blind' | 'micro'

/** The two layers a via toggles between and a blind via spans (R40). */
export interface LayerPair {
  top: string
  bottom: string
}

/** A saved layer pair, as KiCad keeps them in the project (`board.layer_pairs`). */
export interface LayerPairPreset extends LayerPair {
  name?: string
  enabled: boolean
}

/** The pair a board starts with: its outer copper, as KiCad's does. */
export const defaultLayerPair = (copper: readonly string[]): LayerPair => ({
  top: copper[0] ?? 'F.Cu',
  bottom: copper[copper.length - 1] ?? 'B.Cu'
})

/** The other layer of the pair, for a layer in it. */
const pairedLayer = (layer: string, pair: LayerPair): string | null =>
  layer === pair.top ? pair.bottom : layer === pair.bottom ? pair.top : null

/**
 * Where a via goes from `current` (R35, R41), or null where it would go
 * nowhere. A through via goes to the layer of the copper the route is headed
 * for (`toward`, the nearest unconnected copper of its net), or, where that
 * copper reaches every layer or there is none, across the pair. A blind via
 * or microvia goes across the pair, or from a layer outside it to the pair's
 * top. One that would join the outer layers is a through via.
 */
export function viaTarget(opts: {
  type: RouteViaType
  current: string
  pair: LayerPair
  copper: readonly string[]
  /** The layers of the copper the route is headed for, if any. */
  toward?: readonly string[]
}): { target: string; type: RouteViaType } | null {
  const { current, pair, copper } = opts
  let type = opts.type
  let target: string
  if (type === 'through') {
    const toward = opts.toward?.filter((l) => copper.includes(l)) ?? []
    const through = toward.length === 0 || toward.length === copper.length
    if (through) target = pairedLayer(current, pair) ?? pair.top
    else if (toward.includes(current)) target = pairedLayer(current, pair) ?? pair.top
    else target = toward[0]
  } else {
    target = pairedLayer(current, pair) ?? pair.top
  }
  if (target === current) return null
  type = settledViaType(type, current, target, copper)
  return { target, type }
}

/** A blind via or microvia between the outer layers is a through via; any other keeps its type. */
export function settledViaType(
  type: RouteViaType,
  from: string,
  to: string,
  copper: readonly string[]
): RouteViaType {
  const outer = defaultLayerPair(copper)
  const joinsOuter =
    (from === outer.top && to === outer.bottom) || (from === outer.bottom && to === outer.top)
  return type !== 'through' && joinsOuter ? 'through' : type
}

/** The copper layers a via spans: all of them through, else those from one end to the other. */
export function viaSpan(
  type: RouteViaType,
  from: string,
  to: string,
  copper: readonly string[]
): string[] {
  if (type === 'through') return [...copper]
  const a = copper.indexOf(from)
  const b = copper.indexOf(to)
  if (a < 0 || b < 0) return [from, to]
  return copper.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/**
 * The via as the file writes it: its two end layers, top first in stack
 * order, and its marker — KiCad 10's `blind` when it reaches an outer layer,
 * `buried` when it does not, `micro`, or none for a through via.
 */
export function viaFileForm(
  type: RouteViaType,
  span: readonly string[],
  copper: readonly string[]
): { layers: [string, string]; type?: 'blind' | 'buried' | 'micro' } {
  const outer = defaultLayerPair(copper)
  if (type === 'through') return { layers: [outer.top, outer.bottom] }
  const first = span[0] ?? outer.top
  const last = span[span.length - 1] ?? outer.bottom
  if (type === 'micro') return { layers: [first, last], type: 'micro' }
  const reachesOuter = [first, last].some((l) => l === outer.top || l === outer.bottom)
  return { layers: [first, last], type: reachesOuter ? 'blind' : 'buried' }
}

/** The next enabled preset after the one matching `pair`, for Shift+V; null with none enabled. */
export function nextLayerPair(
  presets: readonly LayerPairPreset[],
  pair: LayerPair
): LayerPairPreset | null {
  const enabled = presets.filter((p) => p.enabled)
  if (enabled.length === 0) return null
  const i = enabled.findIndex((p) => p.top === pair.top && p.bottom === pair.bottom)
  return enabled[(i + 1) % enabled.length]
}
