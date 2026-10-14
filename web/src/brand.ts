/**
 * Product-facing identity (docs/BRAND.md). The name lives here and nowhere
 * else, so a rename is a one-line change, not a find-and-replace across the
 * site. Never hardcode the product name in a
 * component or a copy string.
 */
export const PRODUCT_NAME = 'GoatCAD'

/**
 * The wordmark renders the name in two tones, so it needs the split point.
 * It lives here rather than in the component to keep the rename honest: these
 * parts must always concatenate to PRODUCT_NAME (asserted below), so a rename
 * cannot silently leave a stale name painted on the logo.
 */
export const WORDMARK_PARTS = ['Goat', 'CAD'] as const

if (WORDMARK_PARTS.join('') !== PRODUCT_NAME) {
  // Build-time failure, not a runtime one: this module is evaluated during the
  // static build, so a mismatch breaks the build rather than shipping.
  throw new Error(
    `WORDMARK_PARTS ("${WORDMARK_PARTS.join('')}") must spell PRODUCT_NAME ("${PRODUCT_NAME}")`
  )
}

/** Legal entity for the copyright line. Distinct from the product name. */
export const COMPANY_NAME = 'Goat Hill Electronics LLC'

/** The company site; the footer's copyright name and the JSON-LD publisher link to it. */
export const COMPANY_URL = 'https://goat-hill.com/'

export const DOMAIN = 'goatcad.com'

export const SITE_URL = `https://${DOMAIN}`

export const TAGLINE = 'The modern, AI-native workbench for circuit board design.'

/**
 * What follows the name in the home page's <title>. Not the tagline: Google
 * cuts titles at about 600px (~50–60 chars), and "GoatCAD — <tagline>" ran to
 * 67 and was clipped mid-phrase in results.
 */
export const HOME_TITLE = 'AI-native PCB design'

/** Meta description. Kept under ~160 chars so search engines don't truncate it. */
export const DESCRIPTION =
  `${PRODUCT_NAME} is a modern, AI-native workbench for circuit board design. ` +
  `Draw schematics and boards alongside Claude Code or Codex.`
