# GoatCAD Web (`web/`)

The marketing site at [goatcad.com](https://goatcad.com). Entirely frontend, prerendered to static HTML, deployed to Cloudflare Workers.

Read [BRAND.md](./BRAND.md) before touching any user-facing surface. **Keep this file updated** whenever the structure, deploy pipeline, or release contract changes.

---

## 1. Stack, and why

**Astro.** The reasoning, recorded because it will be questioned:

- **The landing page is markup we own.** A `.astro` file is HTML plus scoped CSS with a frontmatter script block. There is no theme system to fight, which matters because the branding is pending (see BRAND.md §3) and many design iterations are expected. Iterating means editing markup.
- **Fast by default, not by optimization.** Zero JS shipped unless explicitly opted into; everything prerenders to static HTML.
- **Docs get a real abstraction later.** Content Collections give type-safe frontmatter, schema validation, and queryable markdown — the eventual "edit markdown, get a rich branded docs experience" requirement, without hand-rolling a pipeline.
- **It is a Cloudflare framework.** Cloudflare acquired Astro in January 2026. Static Astro needs no adapter on Workers.
- **Vue stays available.** Astro islands support Vue, so a future interactive demo (e.g. a live board viewer built from the app's `lib/engine/` code) can mount as an island without the whole site adopting Vue.

**Deliberately rejected:** VitePress (its theme system fights a bespoke landing page exactly where iteration matters most); Vite+Vue+vite-ssg (DIY prerendering and DIY markdown glue, ships the Vue runtime to render a page that never changes); plain HTML (fine for one page, but the docs endgame means hand-rolling markdown).

**`web/` is a self-contained npm project, not an npm workspace.** It has its own `package.json` and `node_modules`, so site dependencies never touch the Electron build. The root `./bin/validate` and `./bin/verify` do not know it exists.

**Self-contained is enforced by `resolve.tsconfigPaths: false` in `astro.config.mjs` — do not remove it.** Vite's tsconfig-paths resolution searches _up_ the directory tree: from `web/` it finds the repo-root `tsconfig.json`, follows its project `references` into `tsconfig.node.json`, and tries to resolve that file's `extends: @electron-toolkit/tsconfig` out of the **root** `node_modules`. That makes the site build silently depend on the Electron install — which passes locally and fails in CI, where the web job only installs `web/`. `astro check` is unaffected, so the failure appears only at build time.

**Testing that locally requires hiding the root install**, since a populated root `node_modules` masks the bug entirely:

```bash
mv node_modules .node_modules_hidden && (cd web && npm run build); mv .node_modules_hidden node_modules
```

---

## 2. Structure

```
web/
├── package.json        # own project; NOT a workspace member
├── astro.config.mjs    # site: 'https://goatcad.com' (drives canonical URLs + absolute OG image paths)
├── wrangler.jsonc      # assets-only Worker (no `main`) + custom domain routes
├── tsconfig.json       # extends astro/tsconfigs/strict
├── scripts/
│   ├── make-og-assets.mjs   # regenerates og.png + apple-touch-icon.png + favicon.png (npm run og-assets)
│   ├── screenshot.mjs       # PNG of a page: astro build → preview server → Playwright/system Chrome (bin/screenshot)
│   └── record.mjs           # mp4/gif of a page driven by a --script, encoded with ffmpeg (bin/record)
├── public/             # served verbatim: favicon.svg, brand-mark.svg, robots.txt
│                       # (points at the generated sitemap-index.xml),
│                       # og.png + apple-touch-icon.png + favicon.png (generated, see scripts/)
└── src/
    ├── brand.ts        # PRODUCT_NAME / WORDMARK_PARTS / TAGLINE / DOMAIN / URLs — rename = 1 file
    ├── i18n/           # the landing page's languages — see §3 "Languages"
    │   ├── locales.ts  # LOCALES (the app's launch set), endonyms, URL segments, og:locale
    │   ├── index.ts    # strings(locale), fmt() for {product}/{platform}…, displayWidth()
    │   └── strings/    # en.ts is the source (its meta reads brand.ts); the rest `satisfies Strings`
    ├── content.config.ts  # `docs` Content Collection: glob loader + zod frontmatter schema (title/description/order/installMatrix)
    ├── assets/
    │   └── screenshots/  # real app captures from electron/bin/screenshot; served via astro:assets
    │                     # (<Image> → webp at build; sharp is Astro's own dep, nothing added)
    ├── content/
    │   └── docs/         # the docs, authored as markdown (index/installation/getting-started/
    │                     # kicad-compatibility/agents/part-search/git); frontmatter validated by content.config.ts
    ├── data/
    │   ├── release.json  # version + per-OS asset URLs, written by the bump job (see §4)
    │   ├── release.ts    # types + isPublished() guard over the JSON
    │   └── channels.ts   # package-manager channels + `live` flags — the site's copy of RELEASES.md §3
    ├── styles/
    │   ├── tokens.css    # ported from src/renderer/src/assets/base.css; + light theme, ink/code tokens
    │   └── global.css    # reset, base type, reduced-motion brake, the shared .btn recipe
    ├── layouts/
    │   ├── Base.astro    # <head>, meta/OG, nav, footer
    │   └── DocsLayout.astro  # docs shell: two-level nav rail + article, wraps Base; the whole "docs theme" (no framework, same tokens, light/dark)
    ├── pages/
    │   ├── index.astro   # the landing page in English, at /
    │   ├── [locale]/index.astro  # the same page in every other language, at /de/, /zh-cn/, /ja/, /fr/, /es/
    │   ├── privacy.astro # privacy notice; claims map to real code behavior (the app's update check included) — update it in the same PR as any change to what the site/app touch on the network
    │   ├── docs/
    │   │   └── [...slug].astro  # one route renders every docs page; `index` entry → /docs, others → /docs/<id>
    │   └── 404.astro     # builds dist/404.html — see the not_found_handling note in §5
    └── components/
        ├── Home.astro         # the landing page body + JSON-LD, given a locale; both index routes render it
        ├── Hero.astro         # consumes <HeroArt/> through one seam
        ├── art/
        │   ├── HeroArt.astro      # the swappable motif — see BRAND.md §4
        │   ├── HeroSky.astro      # the motif's night sky over the whole hero, behind the text
        │   ├── BrandMark.astro    # provisional square mark; duplicated in public/ + favicon
        │   └── PlatformIcon.astro # inline macOS/Windows/Linux marks for download surfaces (not our trademarks)
        ├── Nav.astro
        ├── LanguageSwitcher.astro   # the landing page's language menu: a <details> of endonym links, no JS needed
        ├── Wordmark.astro           # mark + two-tone name; only place the name is rendered
        ├── DownloadButtons.astro   # hero CTA: per-OS buttons + live channel commands
        ├── InstallMatrix.astro      # docs install payload: InstallCards
        ├── InstallCards.astro       # one card per platform, derived from release.json + channels.ts
        ├── ThemeToggle.astro        # docs-only Auto/Light/Dark cycle; the OS preference itself needs no JS
        ├── Showcase.astro           # below-the-fold proof: CSS-only hard-cut slideshow of the board/schematic/
        │                            # 3D-board captures + one-IDE pitch text; future live-render island mount
        ├── Agent.astro              # bring-your-own-agent pitch: a mock split editor, a schematic beside a Claude tab
        │                            # that adds a TLV76733 LDO; the sheet is real GoatCAD SVG exports (assets/agent-demo/,
        │                            # one per build step) faded in on the terminal's clock (a script plays it once
        │                            # in view; static without JS or with reduced motion)
        ├── MediaPlaceholder.astro   # designed frame for not-yet-captured screenshots/animations (currently unused)
        ├── Pitch.astro              # remaining pitch point: drop-in for KiCad (one-IDE moved to Showcase)
        └── Footer.astro             # © COMPANY_NAME; link set mirrors Nav.astro
```

**Comments go in the frontmatter (`---`) block, never the template.** HTML/SVG comments in an `.astro` template are shipped verbatim to the browser — internal notes in the template become public. This bit us once already.

### Tooling integration

- **Prettier stays single-rooted.** `prettier-plugin-astro` is in the _root_ devDependencies so `.astro` files format under the existing `.prettierrc.yaml`. There is one formatter for the whole repo.
- **Root ESLint ignores `web/`.** Type safety comes from `astro check` (Astro's own default). Per the dependency policy, ESLint here has to earn its place first.
- **`web/bin/` wrappers** follow the existing nvm-sourcing pattern, because `npm` is not on `PATH`: `web/bin/dev`, `web/bin/build`, `web/bin/check`, `web/bin/format`, `web/bin/preview`, and the visual-verification pair `web/bin/screenshot` / `web/bin/record` (see below). Use these rather than `npx`, which is prohibited outright — see [RULES.md](./RULES.md) §1 for why. `wrangler` is a declared devDependency for exactly that reason.
- **Restart `web/bin/dev` after any change to `astro.config.mjs` or `src/content.config.ts`.** Astro is supposed to restart itself on a config change; it has been observed not to, leaving a dev server that keeps hot-reloading `.astro` components while serving markdown rendered by the _old_ config — a half-updated page that looks like a content bug. The tell is that a change you know you made is missing from `curl localhost:<port>/<page>` while `astro build` output has it. Nuke `web/.astro` too if content still looks stale. Component and markdown edits alone hot-reload fine.
- **Screenshot / record harness.** `web/bin/screenshot` and `web/bin/record` capture a page as a PNG or mp4/gif — the web members of the repo-wide `screenshot-app` / `record-app` skills (the others live in `electron/` and `develop/`). They build the site, serve `dist/` through Astro's programmatic `preview()`, and drive the machine's **system Google Chrome** with Playwright. `playwright-core` is a declared devDependency, pinned to the same `^1.61.1` the Electron harnesses use; it ships **no browser binary** (`channel: 'chrome'` reaches the installed Chrome), so it adds no browser download to `web/`'s install or to the ~40s CI `web` job. Drivers are `({ browser, context, page }) => {}` — same page-driving shape as the GoatHerd DOM drivers. Full usage is in `.claude/skills/screenshot-app/SKILL.md` and `record-app/SKILL.md`.

---

## 3. Landing page rules

- **~0 KB JS.** No framework on the landing page. If something needs JS, justify it or use progressive enhancement.
- **Scripts are plain `<script>`, not `is:inline`.** Astro type-checks, minifies and inlines a small processed script, so its comments and whitespace never ship; nothing is fetched separately. It runs as a deferred module, which suits anything that waits on a click, a tap or a scroll. `is:inline` ships the source byte for byte, so use it only for code that must run before first paint — the theme init in `Base.astro` and the platform promotion in `DownloadButtons.astro` — and keep its comments in the component's frontmatter, not in the script. Write `{/* */}` in markup, never `<!-- -->`: `compressHTML` keeps HTML comments.
- **No external requests.** No CDN, no external fonts. System font stack, same as the app. Everything inlined or self-hosted.
- **The hero art's tap script is progressive enhancement.** Touch screens have no hover, so a ~20-line script in `HeroArt.astro` lets a tap turn the art's hover scenes on and off. It does nothing where hover exists, and without JS the scenes are hover-only.
- **OS detection is progressive enhancement.** All three OS download links are always present in the HTML, so the page is fully usable with JS disabled. A small inline script promotes the matching one via `navigator.userAgentData?.platform`. It is an enhancement — never the mechanism.
- **The hero art seam** is described in BRAND.md §4. Respect it.
- **One button recipe.** `.btn` / `.btn-secondary` live in `global.css`, not in a component: the hero CTA and the docs install matrix render the same act and must look identical. The gradient, glow, and hover sweep all derive from `--accent` via `color-mix`, so the pending accent still changes in one place. Components add layout (width, padding, font-size) only. The sweep is `display: none` under reduced motion — the blanket brake in `global.css` would only make it instant, which is worse than absent.
- **Platform marks** (`components/art/PlatformIcon.astro`) are inline SVG in `currentColor`, drawn in-repo rather than pulled from an icon set — no dependency, no request. The Apple mark and Tux are **not ours**: they identify whose build a download is for and must never appear as part of GoatCAD's identity (BRAND.md).

### Languages

**Only the landing page is translated**, into the app's launch languages (`en`, `de`, `zh-CN`, `ja`, `fr`, `es`). Docs and privacy stay English; their nav links point at the same English pages from every language, and they show no switcher.

- **Routes.** English at `/`, the others under a lowercase prefix (`/zh-cn/`). `pages/[locale]/index.astro` builds only the listed prefixes. **No redirect by browser language or IP**, ever: the switcher is the only way the language changes, and every language links to every other.
- **A pick in the switcher is remembered** (`localStorage['goatcad-locale']`), and nothing else is: landing on `/ja/` from a link stores nothing. On a later visit `/` sends that visitor to their language before first paint (an inline script in `Base.astro`, English home only), and the logo on English-only pages (docs, privacy) points at their language's home. Picking English stores `en`, which stays put. Crawlers have no storage, so they see every version as before.
- **Copy lives in `src/i18n/strings/`, not in components.** Components take a `locale` prop and read `strings(locale)`. A missing or extra key fails `astro check`. The product name is `{product}`, filled by `fmt()`, never written into a string.
- **Marketing lines are adapted, not transcribed.** A translation keeps a line's spirit where the literal words read badly (the tagline, the headings). Facts never move: part numbers, vendors, file extensions, net names.
- **The agent demo speaks the reader's language, its tools don't.** The prompt and the agent's sentences translate, because an agent answers in the language it is asked in. Tool calls and their `⎿` results stay English, because that is what the app returns. The typed prompt is sized by `displayWidth()`, as a CJK character is two `ch` wide.
- **Head.** `<html lang>`, `og:locale` plus alternates, and hreflang links to every version plus `x-default` → `/`. The sitemap carries the same alternates (`astro.config.mjs`). The OG card stays the English artwork.
- **Register follows the app**: German _Sie_, Spanish _usted_, French _vous_, Chinese 你.
- **The inline download script gets its words from data attributes** (`data-share`, `data-available`, each link's `data-label`), since an inline script cannot import the strings.

**No GitHub links and no open-source or license claims until `goat-hill/goatcad` is public.** Restoring them is part of publishing it: the nav and footer, the no-release download CTA, the install cards' "All downloads" link, the Pitch's "open source" point and its license card, the hero lede, the JSON-LD `license` field, and the docs' release-notes and issue links.

---

## 4. Release version contract

`web/src/data/release.json` is committed and read at build time, so the download buttons are fully static — no runtime API call, no loading state, no dependency on GitHub's API being reachable.

```json
{
  "version": "1.0.0",
  "notesUrl": "https://github.com/goat-hill/goatcad/releases/tag/v1.0.0",
  "assets": {
    "mac": "https://download.goatcad.com/releases/...dmg",
    "win": "https://download.goatcad.com/releases/...exe",
    "linux": "https://download.goatcad.com/releases/...AppImage"
  }
}
```

Asset URLs point at the builds on R2, not GitHub — see [RELEASES.md §8](./RELEASES.md).

**Before the first bump, the file is all-null** (nothing published). It briefly held placeholder data instead — version `0.1.0` with every link at the GitHub releases page, so the landing page was designed against its published state — but that rendered download buttons for every visitor, which pointed visitors at builds that did not exist yet. `isPublished()` in `release.ts` narrows on the all-null state, and `DownloadButtons.astro` degrades to the line "Coming soon to macOS, Windows and Linux" — no button: the docs are in the nav, and the hero's one big button is only ever an install. On a phone or tablet (by `userAgentData.mobile`, the user agent, or a touch "Mac" for iPadOS) the downloads give way to "Available for macOS, Windows and Linux" (no version) and, where `navigator.share` exists, a "Send to your computer" button that shares the site's link.

The bump job runs after the promote job, and derives asset URLs from **the files the build jobs actually uploaded** — their per-platform lists on R2 — mapped onto `download.goatcad.com`, not from predicted filenames: artifact names come from `electron-builder.yml`, which can change without anyone thinking about this workflow, so a predicted name would silently start 404ing. It fails the workflow if a platform's asset is missing rather than committing a half-filled file.

**The bump triggers on `release: published`, NOT on tag push. This is load-bearing.** `release.yml` creates releases as **drafts** — a tag-triggered bump would put a build nobody has reviewed on the site and in the update feed. Publishing the draft is the human act that means "these files are real"; that is the only correct signal. Do not "simplify" this to the tag trigger.

The bump job commits `release.json` to `master` and then starts `web-deploy.yml` by name: a push made with the workflow's own token triggers no other workflow, so the `web/**` path filter never sees that commit. Hand-editing the file remains a valid fallback.

---

## 5. Deploy runbook

**Hosting:** an **assets-only Worker** — no Worker script at all. `main` is optional when `assets` is configured, and the site has no backend.

```jsonc
{
  "name": "goatcad-web",
  "compatibility_date": "2026-07-16",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page",
    "html_handling": "auto-trailing-slash",
  },
  "routes": [
    { "pattern": "goatcad.com", "custom_domain": true },
    { "pattern": "www.goatcad.com", "custom_domain": true },
  ],
}
```

Note the enum values are **hyphenated** (`404-page`, not `404_page`) — the docs are inconsistent about this and the underscore form silently does nothing. `404-page` requires `dist/404.html` to exist, which is why `src/pages/404.astro` is not optional: without it Cloudflare serves a bare unbranded 404.

**Pipeline:**

- `.github/workflows/web-deploy.yml` — on push to `master` filtered to `paths: ['web/**']`, plus `workflow_dispatch`. Runs `astro check` → `astro build` → `cloudflare/wrangler-action@v3` with `workingDirectory: web`.
- `ci.yml` has a `web` job that typechecks and builds without deploying. It runs on every push/PR rather than only on `web/**`: GitHub Actions has no job-level `paths` filter, and a ~40s job is not worth taking on a filter action as a dependency.
- `.github/workflows/web-release-bump.yml` — promotes a published release's update feeds on R2, bumps `release.json` and starts the deploy; see §4 and [RELEASES.md §8](./RELEASES.md). Its R2 credentials are a separate bucket-scoped token, not the deploy token below.

**The Worker is created by the first `wrangler deploy`.** Do not create it in the Cloudflare dashboard: the dashboard's "connect to GitHub" flow is **Workers Builds**, Cloudflare's own CI, which would be a second pipeline deploying the same branch as `web-deploy.yml` — double deploys racing each other. Pick one; this repo uses GitHub Actions, so its build config stays in the repo where it is reviewable and agent-visible.

**One-time manual setup (cannot be automated from here):**

1. `goatcad.com` must be an **active zone** on Cloudflare. A custom domain cannot attach otherwise, and the apex/`www` must have no conflicting CNAME record — Cloudflare creates the DNS records itself. Domains registered through Cloudflare Registrar are already active zones.
2. Repo secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Token permissions — use a scoped custom token, not the template.**

Cloudflare's docs point at the **"Edit Cloudflare Workers"** template while simultaneously advising you to "scope the token as much as possible". The template is convenience, not least privilege: it grants **Workers KV: Edit and R2: Edit account-wide** — storage this site does not use and cannot use, since an assets-only Worker has no bindings — and **Workers Routes: Edit on _all_ zones**. A leaked CI token with that scope could overwrite storage in unrelated projects.

The true minimum is not documented anywhere. **These two permissions are confirmed sufficient** — verified against the real first deploy on 2026-07-16, which created the Worker and attached both custom domains:

| Scope                           | Why                                                     |
| :------------------------------ | :------------------------------------------------------ |
| Account → Workers Scripts: Edit | Uploads the script and its static assets.               |
| Zone → Workers Routes: Edit     | Only because `wrangler.jsonc` declares `custom_domain`. |

**Resources** (where the actual scoping happens):

- Account Resources: **Include → this account only**
- Zone Resources: **Include → Specific zone → `goatcad.com`**

Confirmed **not** needed, despite the template including them:

- **Workers KV / R2: Edit** — no bindings exist. Nothing to read or write.
- **Account Settings: Read** — a `Workers Scripts: Edit` token can already resolve the account it is scoped to, so wrangler infers the account with no help. (`CLOUDFLARE_ACCOUNT_ID` is still passed in CI to keep the deploy explicit rather than dependent on inference — cheap insurance if a second account ever appears.)
- **User Details: Read** — not required by this deploy path.

**Test a new token locally before it goes into GitHub.** Run a deploy with it exported — a too-tight scope surfaces as an immediate, explicit permission error, which is far cheaper than discovering it through red CI runs one commit at a time.

**Watch for paste artifacts.** The first token was rejected with an opaque `fetch failed` from wrangler and a bare `HTTP 400` from the API because a stray `0x1b` (ESC) byte had ridden along on the paste. If a token that looks correct is rejected, check for control characters (`od -c`) before assuming the scope is wrong.

**Local:** `web/bin/dev` runs the Astro dev server (`--background` daemonises it; manage with `astro dev stop|status|logs`). `web/bin/preview` builds and serves through the **real Workers runtime**, which is the only way to check assets behavior the Astro dev server does not model — `not_found_handling`, `html_handling`, trailing slashes. Run it before shipping anything that touches routing or `wrangler.jsonc`.

---

## 6. Docs

Markdown in `web/src/content/docs/`, one file per page. Anything about installing or updating is governed by [RELEASES.md](./RELEASES.md), not by this file. **Adding a page is: drop a markdown file there with `title` / `description` / `order` frontmatter** — route, sidebar entry, and sitemap all follow. `content.config.ts` validates the frontmatter, `pages/docs/[...slug].astro` routes it (`index` → `/docs`), `DocsLayout.astro` is the whole theme.

### Writing rules

Docs are not marketing. The landing page sells; these pages are read by someone who has already decided and now wants the answer.

- **Be efficient.** Shortest version that is still correct. Cut throat-clearing intros ("This page walks through…"), cut the summary paragraph at the end, cut every adjective that isn't load-bearing.
- **No marketing voice.** No "fast, modern, powerful, seamless, simply, just, effortlessly". Claims that belong in the pitch belong on the landing page.
- **Assume a competent engineer.** Do not narrate what the platform already taught them: no "run the installer", "follow the prompts", "click Next", "launch it from the Start menu". State the non-obvious part or say nothing.
- **Show rather than tell — but only when showing adds information.** A command, a file tree, a table of what maps to what, a screenshot of a UI that is genuinely hard to describe. Never a screenshot as decoration; a picture of a paragraph is worse than the paragraph.
- **Lead with what the reader came for.** The install page's job is to hand over the command or the link; prose comes after it, if at all. Same for any page that has one obvious payload.
- **Concrete nouns.** Real file names, real menu labels, real commands. If the specific is not known yet, leave it out and log it in [web-launch-next-steps.md](./web-launch-next-steps.md) rather than filling the gap with vague copy.
- **State the boundary.** Where a page stops, say what covers the rest and link it.
- **Say it on exactly one page.** If two pages explain the file model, one of them is wrong within a month. Link instead of restating.
- **Don't write a section the product already answers.** "Uninstalling", "Updating", "Saving your work" as a how-to — a reader who has the app installed does not need to be told how their OS removes apps. Document only what the product does _not_ make obvious.
- **Never document a channel or a behavior that does not exist.** Install commands come from `src/data/channels.ts` and download links from `release.json`, both rendered by `InstallMatrix.astro` — a docs page must not hand-write either. A reader who runs an aspirational command gets an error, which is worse than seeing nothing. [RELEASES.md](./RELEASES.md) is the strategy this implements; §6 there is the consistency contract.

### Design rules

The docs deliberately diverge from the landing page — they are read, not scanned:

- **Contrast over atmosphere.** Body prose uses `--text`; `--text-muted` is chrome only (labels, captions, the sidebar's resting state). Never set prose in muted gray.
- **Light and dark.** Docs pages pass `colorScheme="auto"` to `Base.astro`: the OS preference decides via pure CSS (`:root[data-color-scheme='auto']` in `tokens.css`), and `ThemeToggle.astro` cycles Auto → Light → Dark, storing the override under `goatcad-theme`. A tiny pre-paint script in `Base.astro` applies the stored value; with JS off, the OS preference still works. **The landing page stays pinned dark** — the hero art assumes it.
- **Brand color has three jobs, and one token each.** `--accent` fills (buttons). `--accent-ink` is accent-as-text (links, the wordmark's "CAD"). `--brand-ink` is the settled forest green pulled up to a legible foreground — inline code, the sidebar's section label — for places that want color but must not read as clickable. Docs would otherwise be a gray page with a copper link in it; this is what keeps them in the brand. Code surfaces get their own `--code-bg` / `--code-border` rather than inheriting the highlighter's, which is another product's gray and, in light mode, was whiter than the page around it.
- **One recurring accent, not many.** Every `h2` opens on a hairline rule with a short copper tick. That single repeated mark carries the rhythm of a long page; adding a second accent shape somewhere else makes both weaker.
- **Smaller type, looser lines.** The docs grid drops to `0.9375rem` / `1.7` so more of a page is visible; the measure stays capped so lines don't run long.
- **Two columns, not three.** Left nav rail plus article. There is no on-this-page TOC column: it cost the prose a column of width and duplicated navigation. Instead the rail carries **two levels** — pages, and the current page's `h2`s beneath it, so a section is one click away. That makes every `h2` a navigation label: write them as short, scannable nouns, and don't leave a trailing "Next" section, which shows up in the rail as noise (the rail already says what comes next).
- **Code blocks follow the theme.** `astro.config.mjs` gives Shiki both `github-light` and `github-dark` with `defaultColor: false`, so it emits `--shiki-light` / `--shiki-dark` custom properties and `DocsLayout` picks per theme — the same three cases `tokens.css` resolves. Commands run full width rather than the text measure. Watch the compounding font sizes: the global inline-`code` rule is `0.9em`, which on the docs' smaller base lands near 12px, so `pre code` sets an absolute size instead.

---

## 7. Not built yet

**The launch queue lives in [web-launch-next-steps.md](./web-launch-next-steps.md)** — blockers (repo flip, Windows signing), big builds (docs, blog, compatibility page, live demo), distribution channels, and pending decisions. The items below are the original short list, kept for the pointers in the rest of this file:

- **Docs — shipped (starter set); see §6 for the writing and design rules.** Markdown authoring with a branded experience, via Astro Content Collections at `src/content/docs/` (the stack was chosen for this). A bespoke thin layer — `content.config.ts` + `DocsLayout.astro` + `pages/docs/[...slug].astro` — not a docs theme framework, so the pages ride the same green tokens as the landing page (Starlight was considered and passed over for the same theme-fights-the-brand reason VitePress was, §1). Four pages so far: overview, installation, getting-started, kicad-compatibility. Content wants a maintainer pass on specifics (exact KiCad format-version range, first-run UI names, and the install commands, which are written for channels that do not exist yet).
  - This is when **`@astrojs/sitemap`** earned its place (the dependency the launch queue earmarked): it replaced the hand-maintained `public/sitemap.xml`, emits `/sitemap-index.xml`, and now auto-covers every page. `robots.txt` points at it.
- Site i18n — **shipped for the landing page** (§3 "Languages"). Docs, privacy and 404 are still English only.
- Blog.

Blog still appears in the nav/footer as a non-link "soon" placeholder (`Nav.astro`/`Footer.astro`) — an internal link that 404s on our own site reads as broken. Turn it into a real link when its surface ships, the way Docs already was.
