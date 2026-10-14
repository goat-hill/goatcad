/**
 * The board's view state as the GPU applies it (ARCHITECTURE.md, PCB boards:
 * View state is applied, not built).
 *
 * A board is drawn once, its geometry indifferent to the view. What the view
 * changes — the active layer, which layers show, the non-active display mode,
 * a live route's or drag's net — reaches the batches as uniforms: some shared
 * by every batch of a scene (`BoardViewUniforms`), some per slot
 * (`SlotViewUniforms`, the one layer a batch holds). Each instance carries a
 * META word set when it is written, which the shader reads them against:
 *
 *   x: net (low 24 bits) and flags (high 8)
 *   y: the copper layers its ITEM spans — a via's span, a pad's copper; set
 *      only on instances the `SPAN` flag marks, which stand for the item
 *      rather than for one of its layers (a hole, a multi-layer label)
 *   z: the copper layers on whose face a label takes dark ink (`INK_BY_FACING`)
 *   w: the copper layers on whose face a via label is not drawn, the via
 *      sitting in a pad of its own net there (`OWN_PAD`)
 *
 * Copper layers are bits by their place in `COPPER_LAYERS` — F.Cu 0, In1–In30
 * 1–30, B.Cu 31 — so every mask is one 32-bit word.
 */
import * as THREE from 'three'
import { COPPER_LAYERS } from '../kicad/layers'

/** Meta flags (bits of the high byte of `x`). */
export const META = {
  /** Stands for the whole item: shown, faded and lit by its copper span (`y`). */
  SPAN: 1,
  /** A label drawn in both inks, each copy shown where the facing copper wants it (`z`). */
  INK_BY_FACING: 2,
  /** A via label hidden where it would sit in a pad of its own net (`w`). */
  OWN_PAD: 4
} as const

/** The bit for one copper layer; 0 for anything else. */
export function copperBit(layer: string): number {
  const at = COPPER_LAYERS.indexOf(layer)
  return at < 0 ? 0 : (1 << at) >>> 0
}

/** The bits for a set of copper layers. */
export function copperMask(layers: Iterable<string>): number {
  let mask = 0
  for (const layer of layers) mask = (mask | copperBit(layer)) >>> 0
  return mask
}

/** The meta word's `x`: a net and its flags. */
export const metaNetWord = (net: number, flags = 0): number =>
  (((flags & 0xff) << 24) | (Math.max(0, net) & 0xffffff)) >>> 0

/** What every batch of one board scene reads; the scene writes it in `applyView`. */
export interface BoardViewUniforms {
  /** The focused net (a live route's or drag's); 0 for none. */
  uFocusNet: { value: number }
  uActiveMask: { value: number }
  uVisibleMask: { value: number }
  /** The copper facing the viewer: the topmost in the paint order. */
  uFacingMask: { value: number }
  /** Non-active layers dim (1) — `nonActiveDisplay === 'dim'`. */
  uDimMode: { value: number }
  /** Non-active layers hide (1), the focused net excepted. */
  uHideMode: { value: number }
  /** A focused net under dim mode: the fade is net focus's, not the slot's. */
  uFocusInDim: { value: number }
  /** What an item fading on its own (a via, a hole) keeps of its color. */
  uDimStrength: { value: number }
  /** What off-net color keeps under focus (KiCad dims toward the canvas). */
  uNetDim: { value: number }
  /** The focused net's color shift: toward white (+) or black (−). */
  uFocusShift: { value: number }
  uBackground: { value: THREE.Color }
}

export function createBoardViewUniforms(): BoardViewUniforms {
  return {
    uFocusNet: { value: 0 },
    uActiveMask: { value: 0 },
    uVisibleMask: { value: 0xffffffff },
    uFacingMask: { value: copperBit('F.Cu') },
    uDimMode: { value: 0 },
    uHideMode: { value: 0 },
    uFocusInDim: { value: 0 },
    uDimStrength: { value: 0.3 },
    uNetDim: { value: 0.3 },
    uFocusShift: { value: 0 },
    uBackground: { value: new THREE.Color(0, 0, 0) }
  }
}

/** One slot's view: the layer its batch holds, as the view treats it. */
export interface SlotViewUniforms {
  /** The slot's layer is hidden by hide mode; the focused net still shows. */
  uSlotHide: { value: number }
  /** The slot's layer is not the active one (what net focus fades in color under dim). */
  uSlotNonActive: { value: number }
  /** What net focus under dim leaves of this layer (`dimOpacityFor`). */
  uSlotSurvive: { value: number }
  /** What of this slot's color dim leaves; the rest is the canvas (1 when not dimmed). */
  uSlotDim: { value: number }
  /** Net focus tones this slot (0 for previews, which the live action draws). */
  uTone: { value: number }
  /** Labels only: this batch is the dark ink (an `INK_BY_FACING` copy shows in one). */
  uInkDark: { value: number }
}

export function createSlotViewUniforms(): SlotViewUniforms {
  return {
    uSlotHide: { value: 0 },
    uSlotNonActive: { value: 0 },
    uSlotSurvive: { value: 1 },
    uSlotDim: { value: 1 },
    uTone: { value: 1 },
    uInkDark: { value: 0 }
  }
}

/** The uniforms one viewed batch takes: the scene's, shared, and its slot's own. */
export interface BatchView {
  shared: BoardViewUniforms
  slot: SlotViewUniforms
}

/**
 * GLSL for a vertex shader built with `BOARD_VIEW`: the uniforms, and the
 * questions the view asks of one instance. `iMeta` is the instance's meta.
 */
export const BOARD_VIEW_GLSL = /* glsl */ `
  attribute uvec4 iMeta;
  uniform uint uFocusNet;
  uniform uint uActiveMask;
  uniform uint uVisibleMask;
  uniform uint uFacingMask;
  uniform float uDimMode;
  uniform float uHideMode;
  uniform float uFocusInDim;
  uniform float uDimStrength;
  uniform float uNetDim;
  uniform float uFocusShift;
  uniform vec3 uBackground;
  uniform float uSlotHide;
  uniform float uSlotNonActive;
  uniform float uSlotSurvive;
  uniform float uSlotDim;
  uniform float uTone;
  uniform float uInkDark;

  const uint META_SPAN = 1u;
  const uint META_INK_BY_FACING = 2u;
  const uint META_OWN_PAD = 4u;

  uint viewFlags() { return iMeta.x >> 24u; }
  bool viewFocused() { return uFocusNet != 0u; }
  bool viewOnFocus() { return viewFocused() && (iMeta.x & 0xffffffu) == uFocusNet; }
  bool viewSpan() { return (viewFlags() & META_SPAN) != 0u; }

  /** Not drawn in this view. */
  bool viewHidden() {
    bool onFocus = viewOnFocus();
    if (uSlotHide > 0.5 && !onFocus) return true;
    uint flags = viewFlags();
    if ((flags & META_SPAN) != 0u) {
      uint shown = uVisibleMask;
      if (uHideMode > 0.5 && !onFocus) shown &= uActiveMask;
      if ((iMeta.y & shown) == 0u) return true;
    }
    if ((flags & META_INK_BY_FACING) != 0u && (((iMeta.z & uFacingMask) != 0u) != (uInkDark > 0.5)))
      return true;
    if ((flags & META_OWN_PAD) != 0u && (iMeta.w & uFacingMask) != 0u) return true;
    return false;
  }

  /** Off the active layer: by the item's span when it stands for the item, else by its slot. */
  bool viewNonActive() {
    return viewSpan() ? (iMeta.y & uActiveMask) == 0u : uSlotNonActive > 0.5;
  }

  vec3 viewToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 viewToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  /** \`color\` keeping \`keep\` of itself against the canvas, mixed as sRGB values (as \`dimToward\`). */
  vec3 viewDimmed(vec3 color, float keep) {
    if (keep >= 1.0) return color;
    return viewToLinear(mix(viewToSrgb(uBackground), viewToSrgb(color), keep));
  }

  /**
   * What dim leaves of an instance's color: its slot's share, or its own when
   * it stands for a whole item (a via, a hole) off the active layer. Alpha is
   * untouched: a dimmed layer is a darker layer, not a see-through one.
   */
  float viewDim() {
    if (!viewSpan()) return uSlotDim;
    return (uDimMode > 0.5 && !viewFocused() && viewNonActive()) ? uDimStrength : 1.0;
  }

  /** An instance's color in the view: dimmed, and under net focus its net lit, the rest sunk toward the canvas. */
  vec3 viewColor(vec3 color) {
    color = viewDimmed(color, viewDim());
    if (!viewFocused() || uTone < 0.5) return color;
    if (viewOnFocus())
      return uFocusShift >= 0.0 ? color + (vec3(1.0) - color) * uFocusShift : color * (1.0 + uFocusShift);
    float survive = (uFocusInDim > 0.5 && viewNonActive()) ? uSlotSurvive : 1.0;
    return mix(color, uBackground, 1.0 - uNetDim * survive);
  }

  /** A label's alpha under net focus, which fades rather than darkens it. */
  float viewLabelAlpha() {
    return (viewFocused() && uTone > 0.5 && !viewOnFocus()) ? uNetDim : 1.0;
  }
`

/**
 * `color` keeping `keep` of itself against `background`, into `target`: KiCad's
 * `COLOR4D::Mix`, which mixes the sRGB values a person sees. A mix of linear
 * values reads far brighter, since most of a dark canvas's mix lands in the
 * curve's steep end. The CPU twin of the shader's `viewDimmed`.
 */
export function dimToward(
  target: THREE.Color,
  color: THREE.Color,
  background: THREE.Color,
  keep: number
): THREE.Color {
  if (keep >= 1) return target.copy(color)
  const from = background.clone().convertLinearToSRGB()
  return target
    .copy(color)
    .convertLinearToSRGB()
    .lerp(from, 1 - keep)
    .convertSRGBToLinear()
}

/** The uniforms object a viewed batch's material takes. */
export function batchViewUniforms(view: BatchView): Record<string, { value: unknown }> {
  return { ...view.shared, ...view.slot }
}
