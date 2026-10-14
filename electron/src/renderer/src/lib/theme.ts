import { readonly, ref, type Ref } from 'vue'
import { KICAD_LAYER_COLORS, MAX_INNER_COPPER_LAYERS, MAX_USER_LAYERS } from './kicad/layers'

export const APP_THEMES = ['dark', 'light'] as const
export type AppTheme = (typeof APP_THEMES)[number]
/** Duplicated in main/appConfig.ts's defaultConfig. */
export const DEFAULT_APP_THEME: AppTheme = 'dark'

/**
 * KiCad layer colors are semantic editor data, not CSS chrome: Three.js and
 * layer swatches need the same palette, while export metadata keeps using the
 * unmodified `KICAD_LAYER_COLORS` defaults — which is the whole reason the two
 * display palettes are separate values rather than edits to that one. Each
 * preserves a layer's hue and role and moves only its lightness: the light
 * palette darkens to stay legible on the pale canvas, the dark palette darkens
 * the copper a pad number sits on so that near-white ink reads against it.
 */
/**
 * The display colors for every inner layer past the eight below, and every
 * user layer past nine: they repeat the first eight and nine.
 *
 * Why a cycle and not 30 distinct colors: every copper color has to read
 * under the pad ink AND stand clear of the canvas, which pins its lightness to
 * a narrow band — and in that band only about a dozen colors can sit a
 * readable ΔE 30 apart, fewer still at a saturation that belongs beside the
 * rest of the palette. So the promise is scoped to what a reader needs: a
 * board of up to ten copper layers has ten distinct colors, and on a deeper
 * one each layer still differs from the outer pair and from every layer within
 * seven of it — the ones it is seen beside. KiCad's own theme cycles too.
 */
const cycleDeeperLayers = (palette: Record<string, string>): Record<string, string> => {
  const out = { ...palette }
  for (let n = 9; n <= MAX_INNER_COPPER_LAYERS; n++)
    out[`In${n}.Cu`] = palette[`In${((n - 1) % 8) + 1}.Cu`]
  for (let n = 10; n <= MAX_USER_LAYERS; n++)
    out[`User.${n}`] = palette[`User.${((n - 1) % 9) + 1}`]
  return out
}

const DARK_KICAD_LAYER_COLORS: Readonly<Record<string, string>> = cycleDeeperLayers({
  ...KICAD_LAYER_COLORS,
  // Copper carries two jobs at once on a dark canvas: stay readable under the
  // near-white pad-number ink, and stay apart from the other copper layers. The
  // canonical palette fails both — In4's `#0000c2` sits at 1.6:1 against the
  // canvas, near invisible, and In3's `#c20000` is a red barely separable from
  // F.Cu. Hues follow KiCad's inner-layer assignment (green / orange / cyan /
  // pink), which is what keeps the four apart from each other and from the
  // red-and-blue of the outer two; the lightness is pulled down from there for
  // the ink and for a canvas darker than KiCad's.
  'F.Cu': '#c83434',
  'B.Cu': '#4a6fae',
  'In1.Cu': '#639059',
  'In2.Cu': '#b0702c',
  'In3.Cu': '#3a8d93',
  'In4.Cu': '#a8557a',
  // In5–In8: the four colors left in the ink band that stay ΔE 30 from the
  // six above and from each other at this palette's saturation.
  'In5.Cu': '#9633cc',
  'In6.Cu': '#279b27',
  'In7.Cu': '#cc339e',
  'In8.Cu': '#5460d4'
})

/**
 * Light is dark's palette, layer for layer. Copper keeps each dark layer's hue
 * and chroma and moves only its lightness, to where the dark pad-number ink
 * (--vscode-canvas-pad-number, light) and the near-white canvas both read
 * against it — the same band the dark copper holds against its own ink and
 * canvas, so the separation the dark palette guarantees carries over.
 */
const LIGHT_KICAD_LAYER_COLORS: Readonly<Record<string, string>> = cycleDeeperLayers({
  'F.Cu': '#db4744',
  'B.Cu': '#567bbb',
  'In1.Cu': '#5a8650',
  'In2.Cu': '#ad6d28',
  'In3.Cu': '#33878d',
  'In4.Cu': '#b46085',
  'In5.Cu': '#ad4de5',
  'In6.Cu': '#138f16',
  'In7.Cu': '#d43ca5',
  'In8.Cu': '#6170e5',
  // Every other layer: the dark palette's color through base.css's light map
  // (same hue and chroma, lightness mirrored), so a layer that is faint on
  // the dark canvas is faint here too.
  'F.SilkS': '#006565',
  'B.SilkS': '#c400c4',
  'F.Mask': '#9a009b',
  'B.Mask': '#ed69ea',
  'F.Paste': '#3a3a3a',
  'B.Paste': '#707070',
  'F.CrtYd': '#573a00',
  'B.CrtYd': '#9c6900',
  'F.Fab': '#7b5900',
  'B.Fab': '#8c6801',
  'Edge.Cuts': '#313634',
  Margin: '#ad0099',
  'Dwgs.User': '#396b9d',
  'Cmts.User': '#065886',
  'Eco1.User': '#376400',
  'Eco2.User': '#544100',
  'F.Adhes': '#b862b7',
  'B.Adhes': '#97aeff',
  'User.1': '#474747',
  'User.2': '#105d34',
  'User.3': '#27678b',
  'User.4': '#6d508a',
  'User.5': '#834b4c',
  'User.6': '#00493d',
  'User.7': '#4b3d0f',
  'User.8': '#304c00',
  'User.9': '#a13f76'
})

export const kicadLayerColorsForTheme = (theme: AppTheme): Readonly<Record<string, string>> =>
  theme === 'light' ? LIGHT_KICAD_LAYER_COLORS : DARK_KICAD_LAYER_COLORS

const currentTheme = ref<AppTheme>(DEFAULT_APP_THEME)

export const useAppTheme = (): Readonly<Ref<AppTheme>> => readonly(currentTheme)

/** The theme, for code outside Vue's reactivity — the engine scenes. */
export const currentAppTheme = (): AppTheme => currentTheme.value

export const setAppTheme = (theme: AppTheme): void => {
  currentTheme.value = theme
  document.documentElement.dataset.theme = theme
}

/** Read a color from the single CSS theme configuration in assets/base.css. */
export const themeColor = (name: string, fallback = ''): string =>
  typeof document === 'undefined'
    ? fallback
    : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

export const themeGridAppearance = (): {
  gridColor: string
  axisColorX: string
  axisColorY: string
} => ({
  gridColor: themeColor('--vscode-canvas-grid'),
  axisColorX: themeColor('--vscode-canvas-axis'),
  axisColorY: themeColor('--vscode-canvas-axis')
})
