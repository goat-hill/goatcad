# Web / launch next steps

What goatcad.com and the repo still need for a public launch. Companion to [WEB.md](./WEB.md)
(structure, deploy), [RELEASES.md](./RELEASES.md) (artifacts, channels, updates) and
[BRAND.md](./BRAND.md) (voice — applies to everything below). Section numbers are cited from
`web/`; keep them stable.

**State.** v0.1.x builds publish to R2 and the site's download buttons serve them to everyone.
Auto-update is wired. macOS builds are signed and notarized. Docs cover overview, installation,
getting-started, kicad-compatibility, agents, part-search and git, with a generated sitemap. The landing
page shows real screenshots. No package channel is live, and the repo is not yet public.

## 1. Blockers to a public launch

- **Repo goes public.** The site's GitHub links and its open-source and license claims come back
  with it (WEB.md §3), as does §4's repo readiness.
- **Windows signing.** Unsigned builds get a SmartScreen warning, and signing gates winget. Buy a
  certificate or accept SmartScreen until reputation accrues — the maintainer's call
  (MILESTONES "Open").

## 2. Docs and content

- **Landing page catches up with the app.** It still pitches a KiCad-compatible editor; the core
  features since — the agent integration (MCP server, agent tabs), git in the explorer, live
  DigiKey/Mouser sourcing, design health — belong in the pitch, and "open source" with them once
  the repo is public (§1).
- **A basic docs pass** — agents, part search and git have pages; standard libraries and fab
  export still need one.
- **Install guide** — verify the stated minimums (macOS 12, Windows 10 1809, glibc 2.28), which are
  assumptions, not measurements; say what Windows users see while unsigned.
- **First-board tutorial** — the alpha reference board (MILESTONES), written from the acceptance run.
- **KiCad compatibility page** — the version table is in; still missing what is preserved
  byte-identical and the known gaps. Extend `kicad-compatibility.md`.
- A keyboard-shortcuts page.
- **Blog + RSS/Atom** — release announcements need a home besides GitHub. Same Content Collections
  mechanism as docs.
- **Live demo island** — a board rendered in the browser by the app's own engine as an Astro island
  (WEB.md §1). The strongest converter a CAD tool can have.
- **Motion captures** for the landing page (the `record-app` skill makes them).
  `MediaPlaceholder.astro` is unused and can go.

## 3. Distribution channels

Strategy is RELEASES.md; what is left is execution. Every entry in `web/src/data/channels.ts` is
`live: false` — flipping it is what puts the command on the landing page and the docs.

- **Launch channels:** a Homebrew tap and an AUR `goatcad-bin`. Each wraps the release artifacts,
  needs release-time automation to bump its manifest, and needs the in-app updater suppressed for
  installs it made (RELEASES.md §4.2).
- **Deferred:** winget (until Windows signing), homebrew-cask (until notable), Flathub (its own
  workstream — the system-KiCad-library sandbox), Nix if a user brings it.

## 4. Community and trust

- **Repo readiness for the flip:** a README that sells (screenshots above the fold),
  CONTRIBUTING.md, SECURITY.md, issue templates, seeded `good first issue` labels. None exist yet.
- **One community venue**, linked from nav and footer — GitHub Discussions is the safe start; an
  empty chat server looks worse than none.
- **Public roadmap** — even a pinned issue.
- **FAQ** — is it free, why this license, which KiCad versions, does it replace my flow, who is
  behind it. Feeds FAQPage structured data.
- GitHub star count fetched at build time, once the number flatters.

## 5. Decisions needed

- **Analytics.** `/privacy` says "no analytics", a brand asset. Cloudflare zone-level metrics are
  server-side with no JS or cookies — decide whether they suffice and whether `/privacy` names them.
- **Announcement list.** A newsletter means an external processor and a `/privacy` update; the
  alternative is "watch releases" plus RSS.
- **Pre-launch indexing.** The site is indexable today; add `noindex` until launch, or not.
- **Security headers.** A `_headers` file (CSP, HSTS, X-Frame-Options) — settle the CSP before the
  demo island complicates it.
- **Launch venues and their order** — Show HN, r/PrintedCircuitBoard and r/KiCad (mind BRAND.md's
  framing there), Hackaday, the EEVblog forum. One first impression per venue.
