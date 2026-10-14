# GoatCAD Brand

Governs both the Electron app and the marketing site (`web/`). Read this before writing any user-facing copy or building any visual surface.

Everything here is the brand as it is. Change any of it only with the maintainer's sign-off; what is not here is not decided.

---

## 1. Name and domain

**Domain:** `goatcad.com`. It is the only domain owned — there is no `goatpcb.com`. Do not write redirects or canonical tags for domains that do not exist.

---

## 2. Identity and voice

### The green

The palette is emerald/forest. Source of truth is `src/renderer/src/assets/base.css`:

- Background family: `#151c19` (deep forest-tinted charcoal), `#1a221f`, `#202b27`, `#25332e`
- Text: `#c5d3cd` (soft mint-tinted gray), muted `#748780`
- Borders: `#24302b`

The site ports these into `web/src/styles/tokens.css`. They are duplicated by necessity (separate npm projects, no shared package) — if you change one side, change the other.

### Tagline

**"The modern, AI-native workbench for circuit board design."** Lives in `web/src/brand.ts` as `TAGLINE`, which is also the landing page's `<title>` suffix. KiCad stays out of the tagline deliberately — see Positioning below.

### License

**GPL-3.0-or-later**, KiCad's own license, chosen for broad adoption. The KiCad-derived code (`kicad-parity.md`, RULES.md §7) is GPLv3 whatever we pick, so nothing more permissive is open to us. The text is the repo-root `LICENSE`, every `package.json` declares it, and electron-builder's `copyright` names Goat Hill Electronics LLC. Outside contributions are issues and feedback, plus pull requests for translations and for the copy and design work done by hand, under the same license (`CONTRIBUTING.md`), and the name and mark are covered separately (`TRADEMARKS.md`; unregistered, so ™, never ®).

### Voice

Clean, fun, intuitive, approachable, professional.

The line to walk: **confident about the goat, never cutesy about the engineering.** The goat earns a smile; the ECAD claims stay precise and verifiable. A pun in a heading is fine. A pun in a spec is not. Never write marketing that a hardware engineer would roll their eyes at — the audience builds circuit boards for a living and can smell fluff.

### In-app UI copy

Marketing copy persuades; **UI copy gets out of the way.** The voice above still applies, but in
the app the governing constraint is brevity: a menu item is read in a fraction of a second, mid-
task, by someone who came to do something else. Every word must earn its place, and most don't.

**Rules.**

- **Shortest string that removes the ambiguity.** Not the shortest string — the shortest
  *unambiguous* one. Cut until the next cut would make someone guess.
- **Drop articles, fillers, and politeness.** No "a", "the", "please", "would you like to".
  "to this project" → **"to project"**.
- **Name the artifact literally, in code style** — `.kicad_sym`, `.pretty/`, `sym-lib-table`.
  A file extension is precise, short, and matches what the user will see in the picker. Prose
  descriptions of file types ("a symbol library file") are longer *and* vaguer.
- **Verb first** for anything that acts: "Add…", "Rename", "Reveal in folder".
- **Sentence case**, not Title Case — buttons, headings, panels, dialogs, tooltips, context menus,
  tab titles. A page or view's name is not a proper noun: "Board setup", "Schematic setup",
  "Fabrication outputs" on its button, heading and tab ("Board setup · psu.kicad_pcb"). Product and
  format names keep their own capitals (GoatCAD, KiCad, DigiKey, PCB, ERC).
  **The one exception is the menu bar** (`locales/en/titleBar.yaml`): its items are **Title Case**
  ("Open Project…", "Save As…"). On macOS that tree becomes the native menu bar (`src/main/appMenu.ts`),
  beside items the OS writes itself (Hide, Services, Quit), and Apple's HIG asks for title style
  there; sentence case would mix two styles in one menu. GNOME agrees and Windows accepts it, so one
  spelling serves all three. Context menus are ours on every platform and never sit beside OS items,
  so they stay sentence case. A button that mirrors a menu command (the Welcome tab's "Open project…")
  follows the button rule, not the menu's.
- **American English.** `en` is `en-US`: color, center, behavior, catalog, license (noun), gray,
  canceled. This binds user-facing strings — `locales/en/**` and site copy — not code identifiers,
  which follow whatever the file format dictates (KiCad's own tokens are American already:
  `color`, `center`). Industry abbreviations keep their own form regardless (`Dk`, `Df`).
- **On a command, `…` means a dialog follows** ("Save as…"); a command that acts at once has none. Progress text and input placeholders may trail off with one ("Loading board…", "Search symbols…") — the platforms' convention. Always the one ellipsis character, never three dots `...`.
- **No description or sublabel by default.** A label, option or setting stands alone. Add a line
  under it only when the label cannot carry the meaning and a wrong guess would cost the user
  (a destructive option, a unit or scope that is not obvious). Most of what a description would
  say belongs in the tooltip, or nowhere.
- **Don't restate context the surface already gives.** An item under a "Symbols" header does not
  need the word "symbol" twice.
- **Menu items target ~40 characters.** Past that, ask what the label is doing that a tooltip or
  the dialog itself should do.
- **The overflow goes to the tooltip and the dialog title**, which have room for a sentence. A
  cramped button plus an explanatory tooltip beats a self-documenting button.

**Worked example** — the Libraries add menu:

- Wrong: `Add symbol library (a .kicad_sym file) to this project…` — 52 characters, and "(a … file)"
  explains a filename to someone about to be shown filenames.
- Right: `Add symbol library `` `.kicad_sym` `` to project…` / `Add footprint library `` `.pretty/` `` to all projects…`

The trailing `/` on `.pretty/` is load-bearing: it is how the user learns to look for a folder
rather than a file, and it replaces a whole clause.

### Positioning

GoatCAD stands on its own identity. **KiCad appears only as a compatibility statement, never as the identity.** This rule already governs `WelcomeView.vue` and now governs the site too.

- Right: "Opens your KiCad files directly. No import, no conversion."
- Wrong: "A KiCad alternative", "KiCad, but modern", any framing where GoatCAD is defined relative to KiCad.

KiCad is a powerful community tool that the space owes a lot to. The pitch is what GoatCAD _is_, not what KiCad _isn't_. The compatibility story is a feature — arguably the headline feature — but it is not the identity.

### Local-first and file-based

GoatCAD is **local-first**: a design lives as files on the user's own disk, not in a hosted database. Like the KiCad round-trip, this is a deliberate identity, not a limitation — and it's the same promise the shipped assets already make (no analytics, files you own). Frame it as what it gives the user, never as an attack on cloud tools.

- Right: "Your design, your files, your machine." / "Works offline; collaborate through git when you want to."
- Wrong: framing GoatCAD as a cloud tool or "\<X\>-in-the-browser", or anything implying the design lives on our servers.

**The schematic and board stay separate files — we will not fold them into one custom format.** File separation is what makes hardware version control work (schematic and layout diff and review as independent commits) and it preserves KiCad interop, partial loading of large boards, and multi-board reuse. The continuity that unified tools are praised for — schematic and board never drifting — is a property of the **runtime model**, not the file format: GoatCAD keeps one coherent design across two files in memory (a decades-proven pattern), without a proprietary format. If GoatCAD-only data ever needs a home it goes in a **sidecar** beside the KiCad files (as `.kicad_pro` already does), never a replacement. Combining the files would trade KiCad compatibility for tidiness we can get other ways.

**Collaboration is for review, not co-editing.** Hardware work is mostly single-author and deep-focus, with handoffs and review between people — which is **git's** shape (async, branch, diff), not Google-Docs'. Real-time multiplayer co-editing is explicitly **not** a goal; a board is a spatial artifact where simultaneous edits have no sane merge. The cloud-adjacent features that fit the brand are about *seeing and reviewing*, not editing together: share-to-view links, async comments, visual board diffs (a genuinely missing tool). Viewing and reviewing, yes; simultaneous editing, no.

---

## 3. Visual identity

### Copper accent (`#cca250`)

The accent beside the green. Use it through tokens (`--vscode-accent`, `--accent`), never hardcoded.

### Component styling → DESIGN.md

How elements are sized and styled consistently — the type scale, buttons, form controls, spacing,
radius — lives in the design framework, **[DESIGN.md](./DESIGN.md)**, so it has one home rather than
being restated per surface. The copper accent above is the one palette input those component styles
consume; keep it going through `--vscode-accent`, never hardcoded, so a re-theme stays cheap.
Icons are part of that framework too: DESIGN.md §Icons sets the one line-art family the tool
palettes are drawn in, and bans Unicode characters as icons (they render in whatever font the OS
picks, so the app looked different on each platform).

### Wordmark and brand mark

The **square brand mark** is **Hill 1**: two hills echoing the site's hero, a copper near hill in front of a gray-green far hill, centered on a 64 grid (x 4–60, y 15–49). Both hills are **solid colors that follow the theme**: `#5a6661` / `#cca250` on dark grounds, `#a3b3ac` / `#a8792a` on light ones, where the far hill is the lighter one, as hills fade into haze. They live as `--mark-far` / `--mark-near` in the site's `tokens.css` and `--vscode-mark-*` in the app's `base.css`, and the standalone SVGs switch with a `prefers-color-scheme` rule of their own. Both hills stay opaque, so the mark holds on light grounds. There is no frame, sun or other detail, which would smear below about 48 px. It sits on a **transparent background** (explicitly not solid), sized to ride alongside the product name wherever it is written. Only the OS app icon gets a ground: the PNGs draw the mark at 75% of a forest rounded square (`#26342e` → `#131a17`, 824 px on a 1024 canvas, the macOS grid), because macOS 26 puts any icon that is not a full rounded square on a gray system plate. It lives behind one seam at `web/src/components/art/BrandMark.astro`, with copies of the same geometry in `web/public/brand-mark.svg` (the standalone shareable file), `web/public/favicon.svg` (cropped to the hills' 56-wide square; `favicon.png` (96 px) is rendered from it as the fallback, and is the one Google Search shows, since it takes no SVG), the app's `electron/src/renderer/src/components/shared/BrandMark.vue` (rendered next to the name by `shared/BrandWordmark.vue`), GoatHerd's `develop/src/renderer/src/components/BrandMark.vue` (its GoatCAD-dev-server button icon), the rasterized app icons `electron/build/icon.png` + `electron/resources/icon.png` (1024/512 px renders of the SVG; electron-builder derives `.icns`/`.ico` from `build/icon.png`), and the macOS 26 icon `electron/build/icon.icon` — an Icon Composer bundle with the ground and each hill as its own layer, so the system draws it with Liquid Glass and its Dark/Clear/Tinted styles, where a flat `.icns` is drawn exactly as painted. It is compiled to the committed `electron/build/Assets.car` by `./bin/build-mac-icon` (Xcode 26's `actool`, run locally — packaging only copies the file), and a unit test fails when the bundle changes without a recompile. Change one, change all of them.

### Hero motif

A hill with goats grazing — the `goat-hill` GitHub org made literal.

- **On the site:** layered San Francisco-style hills at golden hour — a twin-peaked far ridge with an antenna tower in silhouette, a sun half-set behind the ridge, backlit fog rolling over the hills. The golden hour is deliberate. Among the goats (a cream lookout, a brown nanny and her kid) stand common through-hole parts at boulder scale, grouped into small scenes laid out in three rows (tower and sun on the far ridge; LED and the lookout's capacitor on the mid hill; pot, goats and buzzer in the foreground), each with one idea that plays out on hover — or on tap on touch screens, via a tiny inline script; no audio: LED + resistor lights up (and the nanny and kid look up at it); the lookout on the electrolytic + decoupling disc wags its tail; a buzzer + driver transistor sends out (drawn) sound waves and startles the nanny and kid; a trimmer pot beside an axial-resistor fence turns the sunset down to night, over the whole hero (stars behind the heading too, via `HeroSky`): the sky turns as one so the sun sets on a slant and the stars wheel in, the moon rises on its own arc, and the goats lie down to sleep; the antenna tower broadcasts; and the nanny and kid themselves greet — the kid turns to its mother, noses touch, tails wag. Placement is by rule, never eyeballed — the art should feel as precise as the tool: parts within a scene sit a fixed gap apart, edge to edge; scenes are spread evenly across the width rather than aligned into columns (pot and capacitor mirrored about the center, the goats in the middle with the buzzer beside them, the LED halfway between the tower and the goats); the tower's braces are computed onto its legs. The tower is drawn after Sutro Tower — legs splayed at the ground, tapering to a narrow waist and flaring to a wide crossarm under three masts (the middle one tallest), tied by a low crossbar, one at the waist and a pale platform above — painted white with red at every joint, the red Sutro's international orange dulled toward the ridge (mixed from `--accent`). Parts are drawn in the goats' style — flat 2D side-view silhouettes, no outlines or gradients, every part in one body tone a step lighter than any hill so it reads wherever it stands — and every warm tone (glow, sun, fog tint) mixes from `--accent`. On phones the scene is simplified, not shrunk: it sits below the text instead of behind it, cropped to its middle (tower to lookout, with a margin from the screen edges) and drawn larger, without the pot scene. The landing page is dark.
- **In the app:** `components/shared/HillScene.vue` is a port of the site's scene for the Welcome tab — same geometry and hover scenes, colors mixed from the theme tokens so it stays muted in both themes, full width after the content and never cropped. Its night falls on the whole tab: the Welcome tab carries a port of `HeroSky` behind the content, meeting the scene through the shared `--scene-night*` / `--scene-starlight` tokens in `base.css`. It stays off the empty editor, which someone reaches mid-work. Geometry and scene changes land on the site first.

---

## 4. Constraints

**Hero art is plain inline SVG + CSS animation.** No Astro-specific constructs, no Vue-specific constructs, no animation library. The motif flows from the site into the app's `HillScene.vue`, and that port is a copy, not a rewrite.

**Hero art lives behind one seam.** On the site, `Hero.astro` knows nothing about the art beyond its slot (`components/art/HeroArt.astro`). Swapping motifs must never require touching layout, copy, or the download CTA. This seam is what keeps changing it cheap — keep it clean.

**Reduced motion is a hard requirement.** Any animation is gated on `prefers-reduced-motion`, in both the app and the site. The app already does this for the trace pulses; match it.

**Speed is a brand attribute, not just an engineering one.** Interaction feedback lands at ~70ms in the app, and the site ships ~0 KB JS on the landing page. A slow surface is off-brand.
