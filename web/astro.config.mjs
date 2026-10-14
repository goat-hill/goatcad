// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

// Static output, no Cloudflare adapter: the site has no backend, so it deploys
// as an assets-only Worker (see wrangler.jsonc). Per Cloudflare's docs, "if you
// want to use Astro as a static site generator, you do not need the Astro
// Cloudflare adapter" — an adapter would only buy SSR we have no use for.
export default defineConfig({
  // Drives canonical URLs and absolute OG image paths.
  site: 'https://goatcad.com',

  // Now that docs multiply the page count, the sitemap is generated rather than
  // hand-maintained — this is the moment the dependency earns its place, per
  // docs/WEB.md §7 / web-launch-next-steps.md §2. Emits /sitemap-index.xml
  // (referenced by public/robots.txt), replacing the old public/sitemap.xml.
  // i18n: the landing page's language versions (src/i18n/locales.ts) list one
  // another as hreflang alternates in the sitemap too, keyed by URL prefix.
  // English pages have no prefix; docs exist only in English, so they get none.
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', de: 'de', 'zh-cn': 'zh-CN', ja: 'ja', fr: 'fr', es: 'es' }
      }
    })
  ],

  // Code blocks follow the page theme instead of being pinned to one palette.
  // defaultColor: false makes Shiki emit both themes as CSS custom properties
  // (--shiki-light / --shiki-dark) and no hardcoded colour, so DocsLayout picks
  // per theme — see docs/WEB.md §6. Without it, a dark block sits in a light
  // page at whatever contrast github-dark happened to have.
  markdown: {
    shikiConfig: {
      // Vitesse over GitHub's themes: its palette is muted olive/green/amber
      // rather than GitHub blue-and-purple, so highlighted code sits inside the
      // forest brand instead of importing another product's colours. Only the
      // token colours are used — DocsLayout supplies the block's own surface.
      themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
      defaultColor: false
    }
  }

  // NOTE: no tsconfig may exist at the repo root above web/. Rolldown-vite
  // resolves a tsconfig for each module by walking UP the tree, and .astro
  // files are not matched by web/tsconfig.json's `include`, so the walk
  // continues past it — a root tsconfig whose extends-chain lives in another
  // project's node_modules breaks `astro build` in CI (where only web/ is
  // installed). See docs/WEB.md §2.
})
