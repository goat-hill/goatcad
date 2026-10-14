// Generates the social/meta raster assets that can't be SVG:
//
//   public/og.png              1200×630 Open Graph card — the app icon, the
//                              two-tone wordmark and the tagline on the forest
//                              ground. Drawn, not a screenshot: a full editor
//                              window is noise at link-preview size, and a
//                              drawn card does not go stale when the UI does.
//   public/apple-touch-icon.png 180×180 opaque icon from the provisional brand
//                              mark. iOS renders transparency as black, hence
//                              the solid --bg fill.
//   public/favicon.png         96×96 raster of public/favicon.svg, for browsers
//                              that ignore the SVG — and for Google Search,
//                              which takes no SVG favicons and recommends
//                              larger than 48×48. The name carries no size
//                              because Google wants the favicon URL stable.
//
// Run manually after the brand mark, name or tagline changes:
//   cd web && node scripts/make-og-assets.mjs   (or: npm run og-assets)
//
// sharp is Astro's own dependency (it powers astro:assets), nothing added.
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { TAGLINE, WORDMARK_PARTS } from '../src/brand.ts'

// From src/styles/tokens.css.
const BG = '#151c19' // --bg
const TEXT = '#c5d3cd' // --text
const TEXT_BRIGHT = '#ffffff' // --text-bright
const ACCENT = '#cca250' // --accent
const MARK_FAR = '#5a6661' // --mark-far

// The hills come from brand-mark.svg (far first, then near) so the card cannot
// drift from the mark. Their fills are set here: the file's own colors switch
// on prefers-color-scheme, and the card is always dark.
const [farHill, nearHill] = [
  ...readFileSync('public/brand-mark.svg', 'utf8').matchAll(/<path[^>]* d="([^"]+)"/g)
].map((m) => m[1])

// The app icon as BRAND.md draws it: the mark at 75% of a forest rounded
// square (#26342e → #131a17). ICON is its edge in card pixels.
const ICON = 168
const ICON_X = (1200 - ICON) / 2
const ICON_Y = 130
const MARK = ICON * 0.75
const MARK_SCALE = MARK / 64

// The site's own font stack. librsvg resolves it through fontconfig, so the
// face is whichever of these the machine running this script has.
const FONT = `'Segoe UI', -apple-system, Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif`

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26342e" />
      <stop offset="1" stop-color="#131a17" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="${BG}" />
  <g transform="translate(${ICON_X} ${ICON_Y})">
    <rect width="${ICON}" height="${ICON}" rx="${ICON * 0.225}" fill="url(#ground)" stroke="#2c3b35" stroke-width="1.5" />
    <g transform="translate(${(ICON - MARK) / 2} ${(ICON - MARK) / 2}) scale(${MARK_SCALE})">
      <path d="${farHill}" fill="${MARK_FAR}" />
      <path d="${nearHill}" fill="${ACCENT}" />
    </g>
  </g>
  <text x="600" y="424" text-anchor="middle" font-family="${FONT}" font-size="92" font-weight="700" letter-spacing="-2.3"><tspan fill="${TEXT_BRIGHT}">${WORDMARK_PARTS[0]}</tspan><tspan fill="${ACCENT}">${WORDMARK_PARTS[1]}</tspan></text>
  <text x="600" y="490" text-anchor="middle" font-family="${FONT}" font-size="34" fill="${TEXT}">${TAGLINE}</text>
</svg>`

await sharp(Buffer.from(card)).png().toFile('public/og.png')

await sharp('public/brand-mark.svg', { density: 300 })
  .resize(132, 132, { fit: 'contain', background: BG })
  .extend({ top: 24, bottom: 24, left: 24, right: 24, background: BG })
  .flatten({ background: BG })
  .png()
  .toFile('public/apple-touch-icon.png')

await sharp('public/favicon.svg', { density: 300 })
  .resize(96, 96)
  .png()
  .toFile('public/favicon.png')

console.log('wrote public/og.png, public/apple-touch-icon.png and public/favicon.png')
