import { describe, expect, it } from 'vitest'
import { selectionChromeColors } from '../engine/SelectionChrome'
import { COPPER_LAYERS, KICAD_LAYER_COLORS } from '../kicad/layers'
import { APP_THEMES, kicadLayerColorsForTheme } from '../theme'

/** WCAG relative-luminance contrast ratio, so the palette claims are checkable. */
const contrast = (a: string, b: string): number => {
  const luminance = (hex: string): number => {
    const channel = (i: number): number => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** CIE76 color difference — "can a reader tell these two layers apart". */
const deltaE = (a: string, b: string): number => {
  const lab = (hex: string): [number, number, number] => {
    const c = (i: number): number => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const [r, g, bl] = [c(0), c(1), c(2)]
    const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047)
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * bl)
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const [la, lb] = [lab(a), lab(b)]
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

describe('kicadLayerColorsForTheme', () => {
  it('leaves the canonical palette alone — exports and swatch identity ride on it', () => {
    expect(KICAD_LAYER_COLORS['F.Cu']).toBe('#ff5c5c')
  })

  it('covers every layer in both themes, so nothing falls back to a stray color', () => {
    for (const theme of APP_THEMES) {
      expect(Object.keys(kicadLayerColorsForTheme(theme)).sort()).toEqual(
        Object.keys(KICAD_LAYER_COLORS).sort()
      )
    }
  })

  it('reads under the near-white pad ink on every copper layer', () => {
    const dark = kicadLayerColorsForTheme('dark')
    const ink = '#eef3f0' // --vscode-canvas-pad-number, dark theme
    for (const layer of COPPER_LAYERS) {
      expect(contrast(dark[layer], ink)).toBeGreaterThan(3)
    }
  })

  it('keeps every copper layer visible against the dark canvas', () => {
    const dark = kicadLayerColorsForTheme('dark')
    for (const layer of COPPER_LAYERS) {
      expect(contrast(dark[layer], '#101513')).toBeGreaterThan(3)
    }
  })

  it('keeps the copper layers apart from one another', () => {
    // The canonical palette fails this: In3's dark red sits ~21 from F.Cu's,
    // and those are the two a reader most has to tell apart on a real board.
    const dark = kicadLayerColorsForTheme('dark')
    // Up to ten copper layers, every one apart from every other.
    const tenLayers = ['F.Cu', ...COPPER_LAYERS.slice(1, 9), 'B.Cu']
    for (let i = 0; i < tenLayers.length; i++) {
      for (let j = i + 1; j < tenLayers.length; j++) {
        expect(deltaE(dark[tenLayers[i]], dark[tenLayers[j]])).toBeGreaterThan(30)
      }
    }
  })

  it('keeps a deep stack readable where colors must repeat', () => {
    // Past ten layers the ink band holds too few distinct colors (theme.ts),
    // so each layer is held apart from the outer pair and from the seven
    // layers either side of it — the ones it is seen beside.
    const dark = kicadLayerColorsForTheme('dark')
    const stack = [...COPPER_LAYERS]
    stack.forEach((layer, i) => {
      for (const other of [...stack.slice(i + 1, i + 8), 'F.Cu', 'B.Cu']) {
        if (other !== layer) expect(deltaE(dark[layer], dark[other])).toBeGreaterThan(30)
      }
    })
  })

  it('holds the light copper where the dark pad ink and the light canvas both read', () => {
    const light = kicadLayerColorsForTheme('light')
    const ink = '#121a16' // --vscode-canvas-pad-number, light theme
    const canvas = '#fbfffd' // --vscode-bg-viewport, light theme
    for (const layer of COPPER_LAYERS) {
      expect(contrast(light[layer], ink)).toBeGreaterThan(3)
      expect(contrast(light[layer], canvas)).toBeGreaterThan(3)
    }
  })

  it('keeps the light copper layers apart as the dark ones are', () => {
    const light = kicadLayerColorsForTheme('light')
    const stack = [...COPPER_LAYERS]
    stack.forEach((layer, i) => {
      for (const other of [...stack.slice(i + 1, i + 8), 'F.Cu', 'B.Cu']) {
        if (other !== layer) expect(deltaE(light[layer], light[other])).toBeGreaterThan(30)
      }
    })
  })

  it('uses a complete, higher-contrast display palette on light canvases', () => {
    const light = kicadLayerColorsForTheme('light')

    expect(Object.keys(light).sort()).toEqual(Object.keys(KICAD_LAYER_COLORS).sort())
    expect(light['F.Cu']).not.toBe(KICAD_LAYER_COLORS['F.Cu'])
    expect(light['B.Cu']).not.toBe(KICAD_LAYER_COLORS['B.Cu'])
    expect(light['Edge.Cuts']).not.toBe(KICAD_LAYER_COLORS['Edge.Cuts'])
  })
})

describe('selectionChromeColors', () => {
  it('has safe selection colors for non-renderer callers', () => {
    expect(selectionChromeColors()).toEqual({ core: '#66b3ff', rim: '#0b0f0d' })
  })
})

describe('canvas pad-number ink', () => {
  // The scenes read --vscode-canvas-pad-number, so both themes must define it;
  // a missing one silently falls back and stops following the theme.
  it('is defined in both themes, and inverts between them', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../../assets/base.css', import.meta.url), 'utf8')
    const inks = [...css.matchAll(/--vscode-canvas-pad-number:\s*(#[0-9a-f]{6})/gi)].map(
      (m) => m[1]
    )
    expect(inks).toHaveLength(APP_THEMES.length)

    const luma = (hex: string): number =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
    // base.css orders dark first: light ink on the dark canvas, dark on the light one
    expect(luma(inks[0])).toBeGreaterThan(luma(inks[1]))
  })
})

describe('theme tokens', () => {
  // Every token a theme defines, the other must too: one missing falls through
  // to dark's value (or the call site's fallback) and stops following the theme.
  it('are defined in both themes', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../../assets/base.css', import.meta.url), 'utf8')
    const split = css.indexOf(":root[data-theme='light']")
    const tokens = (block: string): string[] =>
      [...block.matchAll(/^\s*(--vscode-[\w-]+):/gm)].map((m) => m[1]).sort()
    const dark = tokens(css.slice(0, split))
    const light = tokens(css.slice(split, css.indexOf('\n:root {', split)))
    expect(light).toEqual(dark)
  })
})
