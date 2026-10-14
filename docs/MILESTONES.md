# GoatCAD Milestones

What "done" means for the current milestone and what is left, in order. The _how_ lives in the
active `*-workstream.md` docs; deferred items with no active workstream live in
[BACKLOG.md](./BACKLOG.md); what is built is in [ARCHITECTURE.md](./ARCHITECTURE.md). This doc lists
only open work — when an item ships, delete it rather than marking it done.

## Milestone 1 — Alpha: two ways in, one board out

**Acceptance test.** The reference board goes from a blank folder to a fab package CircuitHub
accepts with assembly, without KiCad, by either route — and the routes can be swapped at any stage:

- **By hand** — entirely in the IDE.
- **By agent** — an agent tab driving the MCP server does sourcing, capture, sync and coarse
  placement; the human routes and reviews.

**Scope.**
- **Manufacturers:** CircuitHub, with assembly, and Generic — the same identities in Board Setup
  profiles and export profiles.
- **Parts** come from KiCad's standard libraries (a detected install, else a version-pinned
  download; 3D models detect-only), then an imported `.kicad_sym`/`.kicad_mod`, then authoring, by
  hand or by the agent's generators. The authoring bar is a real 48-pin module.
- **Part numbers:** MPN is the canonical field.
- **Languages:** `en`, `de`, `zh-CN`, `ja`, `fr`, `es`.

**Principle.** Every design operation is both a GUI command and an MCP op over one engine and one
undo layer. An operation reachable from only one side is a bug against this milestone.

**Reference board.** An ESP32-S3 breakout: ESP32-S3-WROOM-1, USB-C (native USB), 3.3 V LDO,
decoupling, EN + BOOT buttons, a user LED, 0.1″ headers. Two layers, ground pour both sides. The
"Design your first board" tutorial is this board. Bitclock's `canary` board, in
`goat-hill/goatcad-sample-projects`, is the agent path's running test design. The reference board
is the golden path we demonstrate, not the bar for correctness: DRC, ERC and the zone filler are
held to KiCad on its demos and QA corpus, so behavior a small breakout never exercises still has
to be right.

## What's left, in order

1. **High-speed design** ([pcb-editor-workstream.md](./pcb-editor-workstream.md#high-speed-routing)).
   Pairs, length and skew tuning and impedance are built: KiCad 10's tuning profiles are edited
   and solved in Board Setup and laid by the router, and interface presets turn a standard's
   budget into a profile, a class and rules. Left: tuning to a delay; the pair's skew while
   routing; the router's push latency (router-behavior.md Q1). The reference board's USB D+/D− is
   the pair the acceptance test routes.
2. **Release tail** — fab export manifest
   ([fabrication-export-workstream.md](./fabrication-export-workstream.md)); CircuitHub's unpublished
   minimums
   ([board-setup-workstream.md](./board-setup-workstream.md)); the `zh-CN`, `ja`, `fr` and `es`
   translations and main-process dialog strings
   ([localization-next-steps.md](./localization-next-steps.md)); Windows signing, package channels,
   public repo, install guide, first-board tutorial and KiCad compatibility page
   ([web-launch-next-steps.md](./web-launch-next-steps.md), [RELEASES.md](./RELEASES.md)); a
   landing page that pitches the broader feature set (agent integration, git, sourcing) and a
   basic docs page per core feature (web-launch-next-steps.md §2).
3. **First-run polish** — the welcome screen nudges whatever setup is still missing: KiCad's
   standard libraries, a DigiKey/Mouser API key, and an agent (Claude or Codex). With no standard
   libraries, the symbol and footprint pickers offer the download in their empty state, and the
   agent's `list_*_libraries` answers say the libraries are missing
   ([libraries-workstream.md](./libraries-workstream.md) §6).

## Open — the maintainer's call

1. Windows code-signing certificate.
2. When to publish the repo under GPL-3.0-or-later (BRAND.md §2), with history that no longer
   carries the sample project's vendor datasheets and models, then restore the site's GitHub
   links and license claims (WEB.md §3). Publish before or with the next release.
