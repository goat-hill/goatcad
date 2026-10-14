# GoatCAD

Developer docs live in [`docs/`](docs/), written for people and agents alike. Read the rules first;
open the others when your change touches their surface.

- **[docs/RULES.md](docs/RULES.md)** — workspace rules you must follow: dependencies, TypeScript, build/check/land commands, UI tokens, KiCad compatibility, IPC and security, and the recipes worth remembering. Read before any change. Worktree subagents need no permission if their `node_modules` is symlinked to the parent checkout's (§2); otherwise ask.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the subsystem map and the rules that span files. Read the section for the system you touch.
- **[docs/MILESTONES.md](docs/MILESTONES.md)** — what the current milestone needs and what is left. Open work is in `docs/*-workstream.md`, deferred items in `docs/BACKLOG.md`.
- **[docs/kicad-parity.md](docs/kicad-parity.md)** — how ERC, DRC, the zone fill and the library checkers are held to KiCad, and every deliberate difference. Before changing a checker or the filler.
- **[docs/MCP-STYLE.md](docs/MCP-STYLE.md)** — how MCP text is written: tool summaries, guidance, argument descriptions, answers, remedies. Before writing or changing any of it.
- **[docs/BRAND.md](docs/BRAND.md)** — naming, voice, palette. Before any user-facing copy or visual surface.
- **[docs/DESIGN.md](docs/DESIGN.md)** — how UI elements are sized and styled. Before building or restyling UI.
- **[docs/RELEASES.md](docs/RELEASES.md)** — distribution, auto-update, the release flow. Before touching `electron-builder.yml`, release workflows, or install/update copy.
- **[docs/WEB.md](docs/WEB.md)** — the `web/` site (goatcad.com). Before touching `web/`.
