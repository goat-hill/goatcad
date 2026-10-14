// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A board holds up to 32 copper layers — `F.Cu`, `In1.Cu` … `In30.Cu`, `B.Cu`
 * (`MAX_CU_LAYERS`, `include/layer_ids.h`) — and up to 45 user layers,
 * `User.1` … `User.45`. Every table below covers the whole range: a layer a
 * table leaves out is a layer the board cannot list, color or draw.
 */
export const MAX_INNER_COPPER_LAYERS = 30
export const MAX_USER_LAYERS = 45

/** `In1.Cu` … `In30.Cu`, front to back. */
export const INNER_COPPER_LAYERS: readonly string[] = Array.from(
  { length: MAX_INNER_COPPER_LAYERS },
  (_, i) => `In${i + 1}.Cu`
)

/** `User.1` … `User.45`. */
export const USER_LAYERS: readonly string[] = Array.from(
  { length: MAX_USER_LAYERS },
  (_, i) => `User.${i + 1}`
)

/**
 * KiCad's default colors for `In5.Cu` onward (`builtin_color_themes.h`), which
 * repeat an eight-color cycle from `In5` on. `In1`–`In4` keep the tuned
 * values in the table below.
 */
const KICAD_DEEPER_INNER_CYCLE = [
  '#a7a5c6',
  '#28ccd9',
  '#e8b2a7',
  '#f2eda1',
  '#8dcb81',
  '#ed7c33',
  '#5bc3eb',
  '#f76f8e'
]

function deeperInnerCopperColors(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let n = 5; n <= MAX_INNER_COPPER_LAYERS; n++) {
    out[`In${n}.Cu`] = KICAD_DEEPER_INNER_CYCLE[(n - 5) % KICAD_DEEPER_INNER_CYCLE.length]
  }
  return out
}

/** `User.10` onward repeat `User.1`–`User.9`'s colors, as KiCad's theme repeats its own. */
const FIRST_USER_COLORS = [
  '#c2c2c2',
  '#89d0a0',
  '#71b0d8',
  '#b899d8',
  '#d89999',
  '#99d8c8',
  '#d8c899',
  '#a8d871',
  '#d871a8'
]

function moreUserLayerColors(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let n = 10; n <= MAX_USER_LAYERS; n++) {
    out[`User.${n}`] = FIRST_USER_COLORS[(n - 1) % FIRST_USER_COLORS.length]
  }
  return out
}

/**
 * Standard colors for KiCad layers used across the renderer and sidebar UI.
 * Red for Front Copper, Blue for Back Copper, Cyan for Silkscreen, etc.
 */
export const KICAD_LAYER_COLORS: Record<string, string> = {
  'F.Cu': '#ff5c5c', // Front Copper: Red
  'B.Cu': '#5c5cff', // Back Copper: Blue
  'F.SilkS': '#00cccc', // Front Silkscreen: Cyan
  'B.SilkS': '#cc00cc', // Back Silkscreen: Purple/Magenta
  'F.Mask': '#ff55ff', // Front Mask: Purple
  'B.Mask': '#990099', // Back Mask: Dark Purple
  'F.Paste': '#cccccc', // Front Paste: Light Gray
  'B.Paste': '#888888', // Back Paste: Dark Gray
  'F.CrtYd': '#ffb834', // Front Courtyard: Yellow/Orange
  'B.CrtYd': '#aa7510', // Back Courtyard: Muted Orange
  'F.Fab': '#cca250', // Front Fabrication: Gold/Yellow
  'B.Fab': '#aa8530', // Back Fabrication: Muted Gold
  // Board-only layers (KiCad pcbnew defaults, adjusted for the dark theme)
  'In1.Cu': '#c2c200', // Inner Copper 1: Yellow
  'In2.Cu': '#c200c2', // Inner Copper 2: Magenta
  'In3.Cu': '#c20000', // Inner Copper 3: Dark Red
  'In4.Cu': '#0000c2', // Inner Copper 4: Dark Blue
  'Edge.Cuts': '#d0d2cd', // Board Outline: Off-White
  Margin: '#ff26e2', // Margin: Pink
  'Dwgs.User': '#6b9fd4', // User Drawings: Light Blue
  'Cmts.User': '#7bc0f4', // User Comments: Sky Blue
  'Eco1.User': '#84cc44', // Eco 1: Green
  'Eco2.User': '#e8c04c', // Eco 2: Amber
  'F.Adhes': '#a34fa3', // Front Adhesive: Violet
  'B.Adhes': '#3545a8', // Back Adhesive: Indigo
  'User.1': '#c2c2c2', // General-purpose user layers (dimensions, notes, ...)
  'User.2': '#89d0a0',
  'User.3': '#71b0d8',
  'User.4': '#b899d8',
  'User.5': '#d89999',
  'User.6': '#99d8c8',
  'User.7': '#d8c899',
  'User.8': '#a8d871',
  'User.9': '#d871a8',
  ...deeperInnerCopperColors(),
  ...moreUserLayerColors()
}

/** Copper layer names in physical stacking order, front to back. */
export const COPPER_LAYERS: readonly string[] = ['F.Cu', ...INNER_COPPER_LAYERS, 'B.Cu']

export function isCopperLayer(layer: string): boolean {
  return layer === '*.Cu' || layer.endsWith('.Cu')
}

/**
 * A via belongs to every copper layer it passes through, so it has no layer to
 * be ordered by. It gets a slot of its own instead, above all copper — where
 * KiCad puts `LAYER_VIA_*`. The parentheses keep it from ever colliding with a
 * real KiCad layer token.
 */
export const VIA_PSEUDO_LAYER = '(vias)'

/**
 * Pad and via net names, above every layer — where KiCad draws
 * `LAYER_PAD_NETNAMES` and `LAYER_VIA_NETNAMES`. A label is ink ON the copper,
 * so nothing may cover it: not a via's copper on the same pad, not the hole it
 * bores, not a promoted layer.
 */
export const NETNAMES_PSEUDO_LAYER = '(netnames)'

/**
 * Paint order for every PCB surface — the board editor and the footprint
 * editor both — bottom to top. A layer's INDEX here is its render slot, and
 * both the z a scene emits and the draw order it sorts by come from that
 * index, so re-stacking is an edit to this list and nothing else.
 *
 * This is KiCad's own order, read off `GAL_LAYER_ORDER` in
 * `pcbnew/pcb_draw_panel_gal.cpp` and reversed — that array is written top to
 * bottom, since `VIEW::compareRenderingOrder` sorts descending and
 * `redrawRect` walks the result forward. KiCad applies it in the
 * `PCB_DRAW_PANEL_GAL` constructor, which the footprint editor builds too, so
 * one list covering both editors is what KiCad does as well.
 *
 * The consequence worth knowing, because it surprises people: **copper draws
 * OVER silkscreen**. That is why KiCad has a silk-over-pad DRC rule at all.
 */
export const PCB_LAYER_STACK: readonly string[] = [
  'B.Fab',
  'B.CrtYd',
  'B.Adhes',
  'B.Paste',
  'B.SilkS',
  'B.Mask',
  'B.Cu',
  ...[...INNER_COPPER_LAYERS].reverse(),
  'F.Fab',
  'F.CrtYd',
  'F.Adhes',
  'F.Paste',
  'F.SilkS',
  'F.Mask',
  'F.Cu',
  VIA_PSEUDO_LAYER,
  ...[...USER_LAYERS].reverse(),
  'Margin',
  'Edge.Cuts',
  'Eco2.User',
  'Eco1.User',
  'Cmts.User',
  'Dwgs.User',
  NETNAMES_PSEUDO_LAYER
]

/** Layer a scene falls back to when handed one the stack does not name. */
export const DEFAULT_PCB_LAYER = 'F.SilkS'

/** Wildcard layers (`*.Cu`, `F&B.Cu`, `*.Mask`, …) render on the front of the stack. */
export function resolveWildcardLayer(layer: string | undefined): string {
  if (!layer) return DEFAULT_PCB_LAYER
  if (layer === 'F&B.Cu') return 'F.Cu'
  return layer.startsWith('*.') ? `F.${layer.slice(2)}` : layer
}

/**
 * The concrete layers a KiCad layer token names.
 *
 * `*.Cu` is the one that depends on the board: it is `LSET::AllCuMask()`, every
 * copper layer the board *has* — so a thru-hole pad on a four-layer board has
 * an annulus on both inner layers too, and the same footprint means two layers
 * in the footprint editor and four here. `F&B.Cu` is the token for the outer
 * pair only. Every other wildcard is a fixed front/back pair.
 *
 * The board's copper list is passed in already filtered to layers the stack
 * knows, so a design deeper than `COPPER_LAYERS` draws what it can rather than
 * falling back to a silkscreen slot.
 */
export function expandLayerToken(
  layer: string,
  copperLayers: readonly string[] = ['F.Cu', 'B.Cu']
): string[] {
  if (layer === '*.Cu') return [...copperLayers]
  if (layer === 'F&B.Cu') return ['F.Cu', 'B.Cu']
  if (layer.startsWith('*.')) {
    const side = layer.slice(2)
    return [`F.${side}`, `B.${side}`]
  }
  return [layer]
}

const flipSide = (layer: string): string =>
  layer.startsWith('F.')
    ? `B.${layer.slice(2)}`
    : layer.startsWith('B.')
      ? `F.${layer.slice(2)}`
      : layer

export interface LayerOrderOptions {
  /** Promoted to the top so the layer being worked on is never buried. */
  activeLayer?: string
  /** Viewing from the back: the front and back halves trade places. */
  flipped?: boolean
}

/**
 * The paint order for one view, bottom to top: `PCB_LAYER_STACK` with that
 * view's promotions applied.
 */
export function pcbLayerOrder(options: LayerOrderOptions = {}): string[] {
  const order = options.flipped ? PCB_LAYER_STACK.map(flipSide) : [...PCB_LAYER_STACK]
  const active = options.activeLayer
  if (active) {
    const at = order.indexOf(active)
    if (at >= 0) {
      order.splice(at, 1)
      order.push(active)
      raiseViasOverCopper(order)
      // The net names stay over whatever was promoted.
      order.splice(order.indexOf(NETNAMES_PSEUDO_LAYER), 1)
      order.push(NETNAMES_PSEUDO_LAYER)
    }
  }
  return order
}

/**
 * Vias pass through the copper they sit on, so nothing on a copper layer may
 * bury them — a zone fill on the active layer least of all. Promoting a copper
 * layer would do exactly that, so the via slot follows it up. KiCad does the
 * same: `PCB_DRAW_PANEL_GAL::SetTopLayer` re-raises the via and hole layers
 * after handing the picked layer the top.
 */
function raiseViasOverCopper(order: string[]): void {
  const topCopper = order.reduce((top, layer, i) => (isCopperLayer(layer) ? i : top), -1)
  const at = order.indexOf(VIA_PSEUDO_LAYER)
  if (at < 0 || at > topCopper) return
  order.splice(at, 1)
  order.splice(topCopper, 0, VIA_PSEUDO_LAYER)
}

/**
 * How see-through a layer's paint is before any display mode touches it. Mask
 * and paste describe a *covering* rather than a conductor — the copper under
 * them is meant to read through — so they alone are translucent at rest.
 *
 * Here rather than in each scene because both PCB scenes drew the same table
 * from memory and had already drifted apart on the neighbouring zone-fill
 * value (0.32 on the board, 0.35 in the footprint editor, for the same pour).
 */
export const baseLayerAlpha = (layer: string | undefined): number => {
  const clean = resolveWildcardLayer(layer)
  if (clean === 'F.Mask' || clean === 'B.Mask') return 0.4
  if (clean === 'F.Paste' || clean === 'B.Paste') return 0.7
  return 1
}

/**
 * What 'dim' leaves of a non-active layer's color, the rest the canvas's, mixed
 * as sRGB values (`boardView.ts` `dimToward`). KiCad's default
 * (`pcb_painter.cpp`: `m_hiContrastFactor = 1.0f - 0.8f`), a user setting there
 * (`hicontrast_dimming_factor`). Not adjustable yet; this is the value to hand
 * it when it becomes so.
 */
export const DIM_ALPHA_FACTOR = 0.2

/**
 * Edge.Cuts never fades as far as the rest. The board outline is what you
 * navigate by while working on some other layer, so KiCad floors its dim factor
 * at 0.3 — "arbitrary choice after tests", says the comment in
 * `pcb_painter.cpp`, and it is right.
 */
export const DIM_ALPHA_FLOOR_EDGE_CUTS = 0.3

/** How much of a layer survives 'dim' — the floor above applies to the edge. */
export const dimOpacityFor = (layer: string | undefined): number =>
  resolveWildcardLayer(layer) === 'Edge.Cuts'
    ? Math.max(DIM_ALPHA_FACTOR, DIM_ALPHA_FLOOR_EDGE_CUTS)
    : DIM_ALPHA_FACTOR

/** A zone's pour, fainter than the outline that bounds it. */
export const ZONE_FILL_ALPHA = 0.32

/**
 * Where a piece of geometry sits INSIDE its layer's band, bottom to top: a
 * fill under the outline that bounds it, a drill mark over the pad it bores.
 */
export const LAYER_DEPTH = { fill: 0, body: 1, detail: 2, marker: 3, label: 4 } as const
export type LayerDepth = keyof typeof LAYER_DEPTH

const DEPTHS_PER_LAYER = Object.keys(LAYER_DEPTH).length

/**
 * World-space gap between adjacent depths. Among the document z is only the
 * address of a slot (`layerSlot`) and a depth within it — what covers what is
 * paint order alone (`PaintOrder`) — but the selection chrome is drawn early and depth
 * tested (`CHROME_STACK`, z 0.57 and up), so the whole stack, the selected
 * band and the previews above it included, has to stay below that z or it
 * paints over the handles. Twice the layer stack at five depths a slot fits
 * under it at this step.
 */
const DEPTH_STEP = 0.0005

/** Render z for a slot from `pcbLayerOrder` at one of its depths. */
export const layerZ = (slot: number, depth: LayerDepth = 'body'): number =>
  (slot * DEPTHS_PER_LAYER + LAYER_DEPTH[depth]) * DEPTH_STEP

/** The slot a `layerZ` came from — how a scene routes geometry by its z. */
export const layerSlot = (z: number): number =>
  Math.floor(Math.round(z / DEPTH_STEP) / DEPTHS_PER_LAYER)

/**
 * The board's own area — what is board, as against cutout and everything
 * outside it — tinted under every layer at a strength that leaves the grid
 * readable through it.
 */
export const BOARD_AREA_ALPHA = 0.22

/**
 * The selected band: a second copy of every slot, above the whole document, so
 * a selected item draws in front of everything unselected with its own
 * internal order intact — a footprint's pads over its fab lines, a pad's
 * number on its pad. Selecting copies an element's paint up by one band
 * (`LayeredBatch.liftElements`); its z shifts by `LIFT_Z`, so its slot follows
 * from the one number and its render order from the slot (`PaintOrder`).
 * The schematic draws the same way by its own z lift (`Z.selectedLift`,
 * SchematicScene).
 */
export const LIFTED_SLOT_OFFSET = PCB_LAYER_STACK.length + 1

/** The z one band up: what selecting adds to every piece of an element. */
export const LIFT_Z = layerZ(LIFTED_SLOT_OFFSET, 'fill')

/** The band as the per-slot batches take it (`LayeredBatch`, `SlotBand`). */
export const SELECTED_BAND = { offset: LIFTED_SLOT_OFFSET, dz: LIFT_Z } as const

/** Whether a slot is in the selected band. */
export const isLiftedSlot = (slot: number): boolean => slot >= LIFTED_SLOT_OFFSET

/**
 * Above the selected band too: a tool preview stands in front of what it would
 * change, the selection included. What a preview draws over its own body (a
 * via's bore, a violation mark) takes a higher depth of this slot.
 */
export const PREVIEW_SLOT = 2 * LIFTED_SLOT_OFFSET
export const PREVIEW_Z = layerZ(PREVIEW_SLOT, 'body')

/**
 * A surface's paint addresses: each layer's slot, its place in the stack as
 * written (mirrored for a flipped view). Both PCB scenes hold one and ask it
 * for every z they emit, so neither carries a depth table of its own. The
 * active layer does not move a slot: promotion is render order, which
 * `PaintOrder` applies to the meshes (ARCHITECTURE.md, Paint order).
 */
export class LayerStack {
  private readonly slots = new Map<string, number>()

  constructor(options: { flipped?: boolean } = {}) {
    this.arrange(options)
  }

  /** Address the stack for a flipped view or not. Call before a rebuild. */
  public arrange(options: { flipped?: boolean } = {}): void {
    this.slots.clear()
    pcbLayerOrder({ flipped: options.flipped }).forEach((layer, slot) =>
      this.slots.set(layer, slot)
    )
  }

  public slotOf(layer: string | undefined): number {
    const clean = resolveWildcardLayer(layer)
    return this.slots.get(clean) ?? this.slots.get(DEFAULT_PCB_LAYER) ?? 0
  }

  /** The layer occupying a slot — the inverse of `slotOf`, for a caller
   *  holding geometry (which knows its z, so its slot) and needing the name. */
  public layerAt(slot: number): string | undefined {
    for (const [layer, at] of this.slots) if (at === slot) return layer
    return undefined
  }

  public zOf(layer: string | undefined, depth: LayerDepth = 'body'): number {
    return layerZ(this.slotOf(layer), depth)
  }
}

/** An inner copper layer's name, capturing its number. */
export const INNER_COPPER_LAYER = /^In(\d+)\.Cu$/

/** KiCad 10's fixed layer ids (`PCB_LAYER_ID`, `include/layer_ids.h`) for the named layers. */
const LAYER_IDS: Record<string, number> = {
  'F.Cu': 0,
  'B.Cu': 2,
  'F.Mask': 1,
  'B.Mask': 3,
  'F.SilkS': 5,
  'B.SilkS': 7,
  'F.Adhes': 9,
  'B.Adhes': 11,
  'F.Paste': 13,
  'B.Paste': 15,
  'Dwgs.User': 17,
  'Cmts.User': 19,
  'Eco1.User': 21,
  'Eco2.User': 23,
  'Edge.Cuts': 25,
  Margin: 27,
  'B.CrtYd': 29,
  'F.CrtYd': 31,
  'B.Fab': 33,
  'F.Fab': 35,
  Rescue: 37
}

/**
 * A layer's KiCad 10 id — the order KiCad's writer lists a layer set in
 * (`formatLayers`). Inner copper is `In<n>` at 2 + 2n, user layers `User.<n>`
 * at 37 + 2n; a name KiCad does not know sorts last.
 */
export function kicadLayerId(name: string): number {
  const known = LAYER_IDS[name]
  if (known !== undefined) return known
  const inner = INNER_COPPER_LAYER.exec(name)
  if (inner) return 2 + 2 * Number(inner[1])
  const user = /^User\.(\d+)$/.exec(name)
  return user ? 37 + 2 * Number(user[1]) : Infinity
}

/**
 * Whether a zone's border hatch rises left to right on screen (`/`), as
 * `ZONE::HatchBorder` slopes it: by its first layer's id, falling (`\\`) on an
 * odd one. Every copper layer's id is even, so copper zones all rise, on
 * whichever layer; a wildcard counts as its first copper layer, F.Cu.
 */
export function zoneHatchRises(layers: readonly string[]): boolean {
  const first = layers[0]
  if (first === undefined || first.includes('*') || first.includes('&')) return true
  const id = kicadLayerId(first)
  return !Number.isFinite(id) || id % 2 === 0
}

/** A board layer-table row, as `KicadBoardLayer` holds it. */
interface LayerRow {
  ordinal: number
  name: string
  type: string
  userName?: string
}

/**
 * The opposite of each layer on a board with this layer table
 * (`BOARD::FlipLayer`, set up by `recalcOpposites`): the front / back pairs,
 * inner copper end for end on four layers or more, and front / back user
 * layers paired first by a shared name after the first '.', then as
 * consecutive renamed pairs. Any other layer is its own opposite.
 */
export function boardLayerFlipper(layers: readonly LayerRow[]): (layer: string) => string {
  const copper = layers.filter((l) => l.name.endsWith('.Cu')).length
  const opposite = new Map<string, string>()
  const users = layers
    .filter((l) => /^User\.\d+$/.test(l.name))
    .sort((a, b) => a.ordinal - b.ordinal)
  const sided = (t: string): boolean => t === 'front' || t === 'back'
  const principal = (l: LayerRow): string => {
    const shown = l.userName ?? l.name
    const dot = shown.indexOf('.')
    return dot === -1 ? '' : shown.slice(dot + 1)
  }
  const pair = (a: LayerRow, b: LayerRow): void => {
    opposite.set(a.name, b.name)
    opposite.set(b.name, a.name)
  }
  for (let i = 0; i < users.length; i++) {
    const a = users[i]!
    if (opposite.has(a.name) || !sided(a.type)) continue
    const name = principal(a)
    const b = users
      .slice(i + 1)
      .find(
        (b) =>
          !opposite.has(b.name) &&
          sided(b.type) &&
          a.type !== b.type &&
          name !== '' &&
          principal(b) === name
      )
    if (b) pair(a, b)
  }
  const byOrdinal = new Map(users.map((l) => [l.ordinal, l]))
  const renamed = (l: LayerRow): boolean => l.userName !== undefined && l.userName !== l.name
  for (const a of users) {
    const b = byOrdinal.get(a.ordinal + 2)
    if (!b || opposite.has(a.name) || opposite.has(b.name)) continue
    if (a.type === 'front' && b.type === 'back' && renamed(a) && renamed(b)) pair(a, b)
  }
  return (layer) => {
    const side = flipSide(layer)
    if (side !== layer) return side
    const inner = INNER_COPPER_LAYER.exec(layer)
    if (inner && copper >= 4) {
      const k = Number(inner[1])
      return `In${Math.min(Math.max(copper - 1 - k, 1), copper - 2)}.Cu`
    }
    return opposite.get(layer) ?? layer
  }
}
