/**
 * Which keys the hint teaches for the operation in hand (docs/router-behavior.md
 * K1–K4): a route, a pair route or a tune. Each operation has its keys in the
 * order they matter; the hint shows the first few that fit, the moment's own
 * first, and `?` opens the card of the rest only when some did not fit.
 */
import type { HotkeyActionId } from '../hotkeys'
import type { RouteState } from './router/engine'

/** One row of keys: a hint's key with what it does, a card's line. */
export type KeyRow =
  | 'via'
  | 'width'
  | 'narrower'
  | 'posture'
  | 'finish'
  | 'end'
  | 'unroute'
  | 'cancel'
  | 'corner'
  | 'mode'
  | 'viaSize'
  | 'customSize'
  | 'dropVia'
  | 'blindVia'
  | 'microVia'
  | 'viaPickLayer'
  | 'layer'
  | 'layerPair'
  | 'pairVia'
  | 'pairSize'
  | 'spacing'
  | 'amplitude'
  | 'tighter'
  | 'taller'

export interface OpKeys {
  /** Every key the hint may show, in the order it shows them. */
  hint: KeyRow[]
  /** The most the hint shows, before the space it has: one where a moment calls for one key. */
  max: number
  /** The card `?` opens: every key of the operation. */
  card: KeyRow[]
}

/** The most keys one hint shows (K1). */
const MAX_KEYS = 3

const NONE: OpKeys = { hint: [], max: MAX_KEYS, card: [] }

/** A live route's keys, most needed first (K1). */
const ROUTE_ROWS: readonly KeyRow[] = [
  'via',
  'width',
  'posture',
  'finish',
  'end',
  'unroute',
  'corner',
  'layer',
  'layerPair',
  'viaSize',
  'customSize',
  'blindVia',
  'microVia',
  'viaPickLayer',
  'mode',
  'cancel'
]

/** The row a key done by mouse echoes (K2). */
const ECHO_ROWS: Partial<Record<HotkeyActionId, KeyRow>> = {
  'pcb.routeVia': 'via',
  'pcb.trackWidthNext': 'width',
  'pcb.trackWidthPrev': 'width',
  'pcb.viaSizeNext': 'viaSize',
  'pcb.viaSizePrev': 'viaSize',
  'pcb.routePosture': 'posture',
  'pcb.routeCorner': 'corner'
}

export interface RouteHintContext {
  /** A route is in progress. */
  live: boolean
  /** What the router is doing with the head, null before the first proposal. */
  state: RouteState | null
  viaArmed: boolean
  /** A legal width narrower than the one in use exists, and the narrowest gets through. */
  narrower: boolean
  /** The head is near a pad of its net that the routed layer does not reach. */
  nearViaPad: boolean
  /** A key the person just did by mouse, shown once (K2). */
  echo: HotkeyActionId | null
}

/**
 * The route tool's keys. Before a route, none but an echo. While one is live,
 * the route's keys; with a via armed, its size and how to drop it first; near
 * a pad of the net on another layer, `V` alone, and blocked at a gap a
 * narrower size would pass, `Shift+W` alone, the rest behind `?`.
 */
export function routeOpKeys(ctx: RouteHintContext): OpKeys {
  const echo = ctx.echo ? ECHO_ROWS[ctx.echo] : undefined
  if (!ctx.live) return { ...NONE, hint: echo ? [echo] : [] }
  // Backspace drops an armed via before it steps the route back (R21, R24).
  const card: KeyRow[] = ctx.viaArmed
    ? ['viaSize', 'dropVia', ...ROUTE_ROWS.filter((r) => r !== 'viaSize' && r !== 'unroute')]
    : [...ROUTE_ROWS]
  const lead: KeyRow[] =
    ctx.viaArmed || (!ctx.nearViaPad && !(ctx.state === 'blocked' && ctx.narrower))
      ? []
      : ctx.nearViaPad
        ? ['via']
        : ['narrower']
  // Narrower is width's own key, said for the moment: the one row stands for both.
  const rest = card.filter((r) => !(lead.includes('narrower') && r === 'width'))
  return {
    hint: unique([...lead, ...(echo ? [echo] : []), ...rest]),
    max: lead.length > 0 ? 1 : MAX_KEYS,
    card
  }
}

/** A pair route's keys (PR1–PR6): none until it starts, then its via pair, sizes and steps. */
export function pairOpKeys(live: boolean): OpKeys {
  if (!live) return NONE
  const card: KeyRow[] = ['pairVia', 'pairSize', 'unroute', 'end', 'cancel']
  return { hint: card, max: MAX_KEYS, card }
}

export interface TuneHintContext {
  /** A pattern is in hand. */
  live: boolean
  /** The pattern's net is short of its target. */
  short: boolean
}

/**
 * The tuner's keys (T1): none until a pattern is in hand, then its spacing
 * and amplitude; short of the target, the one of each that adds length.
 */
export function tuneOpKeys(ctx: TuneHintContext): OpKeys {
  if (!ctx.live) return NONE
  const card: KeyRow[] = ['spacing', 'amplitude']
  return { hint: ctx.short ? ['tighter', 'taller'] : card, max: MAX_KEYS, card }
}

const unique = (rows: KeyRow[]): KeyRow[] => [...new Set(rows)]
