# Design Health Workstream

How a design's checks reach the person and the agent editing it: ERC, DRC, the symbol checker and
the footprint checker, behind one health pill per editor.

- How each check matches KiCad, its parity tests and deliberate differences: [kicad-parity.md](./kicad-parity.md).
- The code map: ARCHITECTURE §3.16.

## Approach

- **KiCad is the spec.** The same rules, limits and severities, held to `kicad-cli` on KiCad's
  demos and QA corpus. A project reads the same in both apps.
- **List ↔ canvas.** Click a finding and the canvas goes there; fix it and the finding goes. The list
  and the canvas are always visible together, so there are no modals.
- **One pill per pane, bottom right.** Its color is the worst severity and its segments are counts.
  It never shows stale counts as current.
- **A drawer, not a tab.** It lives with its canvas, so a split can show schematic + board + findings.
- **A finding explains itself.** It names the rule and the numbers: "0.15 mm, needs 0.2 mm (netclass 'Power')".
- **One finding shape everywhere.** The pill, the drawer, the agent's `*.check` ops and the export
  pre-flight read the same `CheckResult`. Neither the GUI nor the agent sees a finding the other cannot.
- **Health is correctness, not readiness.** A part with no MPN is a sound schematic. The export
  pre-flight and board sync report what blocks them.
- **Suppression is KiCad's.** Per-rule severities and KiCad's exclusions; no waivers of our own.

## The surface

- **Pill.** Errors, warnings, then editor-specific counts; a check mark when clean. While a refill
  or check is running it shows progress round its border and keeps the last counts.
- **Drawer.** Findings are grouped by rule, errors first, and each row carries its numbers.
  Clicking a row selects and centers the finding's items, ↑/↓ steps through them, and Escape
  closes the drawer. It can be pinned to the rail.
- **Markers.** A pin standing on each error and warning, its glyph inside (`!` error, triangle warning), sized like KiCad's markers. Clicking one
  opens its row. The gear marks all findings, errors only, or none.
- **Limit explainer** (KiCad's Clearance and Constraints Resolution). Select one or two copper
  items and the properties panel shows each clearance and size limit that applies and which rule set it.
  The agent op `board.explain_limits` gives the same answer.

| Editor | Pill shows | When it runs |
|---|---|---|
| Schematic | ERC | every edit, ~130 ms on KiCad's largest demo |
| Board | DRC + drift from the schematic | after an edit's refill, in the board worker |
| Footprint | footprint checker | every edit |
| Symbol | symbol checker (open symbol) | every edit |

## The DRC engine

- **One place decides every limit**, shared by DRC, the router and the zone fill: board setup,
  net classes and the project's custom rules (`.kicad_dru`), in KiCad's order of precedence.
- **One module per rule** (`drc/rules/`) over one shared context.
- **Only around the edit.** After an edit, local checks run only near what changed; checks that
  need the whole board (connectivity, zones) run in full.
  - Tested by checking random edits both ways, around the edit and whole board, on every test board.
  - An agent's edit returns just the findings it added or cleared.
- **In the background.** Zone refill and checks run on a separate thread, so the editor stays smooth.

## Status

- **ERC:** at its launch bar.
- **DRC:** all 64 of KiCad's rules run and every custom-rule function and property is read. The
  board parity suite passes 246 of 249 boards, 19 of them with recorded differences
  ([kicad-parity.md](./kicad-parity.md#board)).

## Left for launch

Nothing. The launch list is built; parity is held by `./bin/test-parity` ([kicad-parity.md](./kicad-parity.md)).
