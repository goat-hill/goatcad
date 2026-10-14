# GoatCAD

A fast, modern ECAD IDE for KiCad designs — schematic, board layout, and footprint editors in one
cross-platform desktop app, built for strict KiCad file compatibility. Opens your KiCad files
directly: no import, no conversion.

## Repository layout

This repo holds three self-contained npm projects. They share no `node_modules` and no build, and
no one project's install covers the others.

| Path        | What it is                                                                    |
| :---------- | :---------------------------------------------------------------------------- |
| `electron/` | The GoatCAD desktop app (Electron + Vue) — the only thing a release ships. See [electron/README.md](electron/README.md). |
| `web/`      | The marketing site at [goatcad.com](https://goatcad.com) (Astro, deployed to Cloudflare). See [docs/WEB.md](docs/WEB.md). |
| `develop/`  | GoatHerd, the internal app for running parallel development workstreams (Electron + Vue). Never shipped. See [develop/README.md](develop/README.md). |
| `docs/`     | Developer docs, for people and agents alike: workspace rules, architecture, brand, releases, open work. User-facing docs are the site's (`web/src/content/docs/`). |
| `.github/`  | CI, release, and site-deploy workflows.                                       |

Start in the project you're working on — each has its own install and its own commands.

## Working on GoatCAD

GoatCAD is built with coding agents, and the repo is laid out for it: `docs/` is written to be
read by them as much as by people, and most changes happen in a git worktree rather than the main checkout. Two ways in:

- **[Claude Code](https://claude.com/claude-code)** — the terminal agent, on **Claude Opus 5** for
  everyday work or **Claude Fable 5** for the longest-horizon tasks. The repo ships skills it picks
  up automatically (`.claude/skills/`): `land` to merge a worktree, `release` to cut a tag,
  `localize` to clear translation debt, `screenshot-app` and `record-app` to capture a real surface.
- **GoatHerd** (`develop/`) — a GUI for running several of those sessions at once. Each worktree gets
  a sidebar entry with one-click Claude sessions, terminals, and dev servers for the app and the
  site, in real embedded terminals. Use it when more than one workstream is in flight; the terminal
  is fine for one.

## Docs

- **[docs/RULES.md](docs/RULES.md)** — workspace rules: dependency policy, strict TypeScript,
  build/validate/verify commands, UI theme tokens, KiCad and cross-platform constraints. Read first.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the subsystem map and the rules that span files
  (documents and views, selection, undo, the agent op registry, rendering).
- **[docs/BRAND.md](docs/BRAND.md)** — naming, voice, positioning, palette. Read before writing
  user-facing copy or building any visual surface.
- **[docs/RELEASES.md](docs/RELEASES.md)** — how the app is distributed and updated: artifacts,
  channels, the auto-update design, and the release flow. Source of truth for anything a tag touches.
- **[docs/WEB.md](docs/WEB.md)** — the site's structure, stack rationale, and deploy runbook.

## CI

`.github/workflows/ci.yml` runs on every push and PR to `master`, as two independent jobs:

- **build** — format, lint, typecheck, test, and build, in `electron/`.
- **web** — format, `astro check`, and build, in `web/`.

`develop/` has no CI job — GoatHerd is a local tool, checked by running it.

The site deploys separately: `.github/workflows/web-deploy.yml` publishes `web/` to Cloudflare on any
push to `master` that touches it. Release builds are tag-triggered only — nothing is built or
published on a merge to `master`. What a tag sets in motion, and what a human still has to do after
it, is [docs/RELEASES.md](docs/RELEASES.md); cutting one is the `release` skill's job.

## Acknowledgements

We want to give credit to the developers of [KiCad](https://www.kicad.org), whose work greatly
accelerated GoatCAD's development. Much of GoatCAD's initial file handling, routing and design
checking is inspired by KiCad or ported directly from it. GoatCAD is an independent project, not
affiliated with or endorsed by the KiCad project.

GoatCAD is written almost entirely with Claude, an AI model trained on a vast body of open-source
software. Thank you to everyone whose public open-source contributions made that possible.

## License

GoatCAD is free software under the [GNU General Public License, version 3 or later](LICENSE).
Copyright © Goat Hill Electronics LLC and contributors.

- **KiCad.** Where GoatCAD's output must match KiCad's, parts of it follow KiCad's own source,
  Copyright The KiCad Developers, also GPL-3.0-or-later. Those files say so on their first line.
  GoatCAD is not affiliated with or endorsed by the KiCad project.
- **Third-party components** and their licenses are listed in
  `electron/resources/THIRD_PARTY_NOTICES.txt`, which every build carries and Settings ▸ About opens.
- **Programs that talk to GoatCAD.** We do not consider a program that interacts with GoatCAD only
  through its MCP server or its scripting API — over that network interface, as a separate process,
  and without copying GoatCAD's code — to be a work based on GoatCAD. Such programs, including
  plug-ins and services, may be licensed however their authors choose.
- **The name and logo** are trademarks of Goat Hill Electronics LLC and are not covered by the
  GPL; see [TRADEMARKS.md](TRADEMARKS.md).
- **Contributing.** GoatCAD is written almost entirely by AI agents, so issues and in-app feedback
  help most. Pull requests are for translations, plus copy and design work, the few things done by
  hand; they come in under the same license. See [CONTRIBUTING.md](CONTRIBUTING.md).
