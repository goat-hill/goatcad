# Board Setup Workstream

Board Setup is a board's own tab (`goatcad://board-setup/<board>`, opened from the Properties
panel with nothing selected): stackup, constraints,
net classes and the DRC's rule severities, organized around a **manufacturing profile** — pick the fab and tier, start
manufacturable. DRC and the router read this model; they do not own it. Roadmap context:
[MILESTONES.md](./MILESTONES.md) step 2 (profile buttons and CircuitHub's minimums).
Mechanics are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Decisions that govern

- **The data splits where KiCad splits it.** The stackup lives in the `.kicad_pcb`
  `(setup (stackup …))`; design rules and net classes live in the `.kicad_pro`
  (`board.design_settings.rules`, `net_settings`), because net classes are shared with the
  schematic. Stackup edits go through `runCommand` and undo; rule and class edits write the
  `.kicad_pro` directly, preserving every sibling key. A board with no `.kicad_pro` edits its
  stackup freely and has nowhere to persist rules.
- **`zones_allow_external_fillets` sits in `design_settings`, not `rules`.** Written under `rules`
  it round-trips through our reader while KiCad ignores it.
- **A profile is a named constraint configuration**, not an authority: `{stackup catalog + design
  rule minimums + Default net-class seeds}` (`lib/manufacturingProfiles.ts`). Built-ins are
  read-only; editing forks (`deriveProfile`). Each vendor's values name the fab pages they come
  from, marked published, derived or a default no page gives; built-ins are CircuitHub, JLCPCB and
  OSH Park (2- and 4-layer each) and Generic.
- **Which presets a board uses is stored, never inferred.** A board can share a fab's numbers
  without being built there, so the picked profile and stackup are kept by id under GoatCAD's own
  `.kicad_pro` key (`goatcad.board_setup`, which KiCad keeps on save); none stored is Custom, and
  Custom is always pickable without changing a value. The id only names: the board keeps its own
  values, so a preset whose shipped numbers change in an update shows as edited
  (`matchesProfile`, key-driven so a new rule cannot be silently skipped, comparing the
  **Default** class only — adding classes does not take a board off its profile). A hand edit to
  the stackup makes its pick Custom.
- **Users save their own presets.** Save names the section's values as a configuration (rules and
  Default sizes, no build) or a stackup; Remove takes only these. They are app-wide
  (`boardSetupPresets` in the config store, `lib/board/userSetupPresets.ts`), each with a random
  `user:<UUID>` id, so a name removed and saved again never becomes the preset an older board
  recorded.
- **Export profiles are a separate registry** (`lib/exportProfiles.ts`): same manufacturers and
  the same picker, different data.
- **Sections:** Stackup (what the board is) / Constraints (what the fab can hold; the profile
  picker lives here) / Length-tuning patterns / Tuning profiles / Net Classes (what you draw
  with) / Custom rules (the project's `.kicad_dru`, a rule added, edited as text or removed at a
  time; an edit KiCad would not read is refused with why, since one bad rule drops the file) /
  Design Rules (which DRC rules report,
  and how loudly — KiCad's `rule_severities`, design-health-workstream.md). Constraints carries KiCad's full page —
  all eighteen controls in KiCad's order, grouped; a test pins the card list to
  `DEFAULT_DESIGN_RULES`. Settings are cards with a glyph (`lib/boardSetupGlyphs.ts`), not table
  rows; subtitles only where the answer is a product decision.
- **No live-rendered constraint previews.** Neither KiCad nor Altium draws one; every card already
  carries its diagram. Only Stackup has a preview pane: the build drawn in WebGL
  (`StackupPreview3D.vue`), an exploded stack in the 3D view's materials and light, to scale in
  thickness, with the name in silk on each face and one via through the copper; hovering a layer
  there or its row in the table fades the others. The table holds the numbers, so the drawing
  carries none. Paste is neither drawn nor listed: it is the assembly stencil's, has nothing to edit,
  and stays in the file.
- **The stackup is row-per-layer.** `StackupSpec` is seed input only, applied by a catalog preset;
  live edits go through `updateStackupLayerInAST` so hand edits survive. An agent edits rows the
  same way (`board_update_setup`'s `stackup.layers`, `addDielectric`, `removeLayers`,
  `stackupEdits.ts`), held to the cells each row has in the table; its build keys regenerate. Board thickness is an
  output (the sum). Copper count is 2–32, even only, and the stackup and the board's `(layers …)`
  table are written together. Stackup presets nest inside a profile and are labeled by vendor.
- **Explicit per-net classes come from the schematic.** `netclass_assignments` is rebuilt
  whole from the schematic's directive flags and label `Netclass` fields, bus members included
  (`lib/schematic/netclassAssignments.ts`, KiCad's connection graph), and written when a sheet is
  saved and before Update PCB (`refreshNetclassAssignments`, App.vue). It is read into
  `BoardDesignSettings.assignments`, and `netClassForNet` honors it before the patterns, so the
  router and DRC see the class KiCad sees; Board Setup shows it (a pinned net in the assignments'
  net list) but never edits it. Schematic Setup's Net Classes is Board Setup's page, embedded.
- **Class colors and styling.** Each setup shows its editor's columns, as KiCad's one panel does:
  Board Setup the sizes and `pcb_color` (Default's stays the layer's; it marks the class's tag,
  `NetClassTag`) with KiCad's Import colors from schematic; Schematic Setup `wire_width`,
  `bus_width`, `schematic_color` and `line_style`, empty on a class taking Default's. The
  schematic draws each wire by its net's class at draw time, under its own stroke
  (`classConnectionStyles`); buses take Default's styling.
- **Assignments show their reach** (`lib/board/netClassCoverage.ts`): each pattern's net count,
  nets a second class also takes, a bad expression, and what falls to Default; the selected row's
  nets list beside the table — against the board's nets less `unconnected-(…)`.
- **Tuning profiles** (KiCad 10's, `lib/board/tuningProfiles.ts`): a block per profile over a
  table of its signal layers, rows added as KiCad adds them; a class names its profile in the
  class table. Written whole as KiCad saves them (`patchTuningProfiles`, byte for byte on a KiCad
  file). A width or delay is what was typed or what Solve wrote, never recomputed behind the
  user; a Z column reads each row back. A rename carries the classes naming the profile; a
  removal clears them. Via overrides are read and kept, not yet edited.
- **Net classes:** `Default` cannot be renamed or removed and is hoisted to index 0; renaming a
  class carries its assignment patterns; removing a class removes them; a pattern already dangling
  on read is kept and flagged; priority is preserved, never renumbered. Predefined track and via
  sizes are the route tool's extra sizes, not a rule, listed below the class table as
  Custom sizes (router-behavior.md S4).

## Open work

1. **CircuitHub's unpublished minimums.** The CircuitHub profiles (2- and 4-layer, the default)
   hold its ProtoBoard spec: 0.127 mm trace and gap, 0.15 mm drill, 1 oz, ENIG, black and white.
   Annular ring, copper-to-hole, edge, hole-to-hole and silk are conservative defaults marked
   `(def)`; CircuitHub's design-rules page publishes none. Ask CircuitHub for them.
2. **Prompt to create a `.kicad_pro`** on the first rule edit of a project-less board. Today the
   section shows a note (`boardSetup.noProject`) and the edit lives for the session.
3. **Capability check** — ✓/⚠ against the fab's limits ("0.1 mm drill < JLCPCB minimum"), held
   to the stored profile.

Out of alpha: component classes, a structured custom rules editor (Custom rules edits a rule as its raw text, checked as KiCad reads the file), via overrides in tuning profiles,
blind / buried / microvia configuration, violation severities, text and graphics defaults, text
variables, embedded files, a mask / finish 3D preview, rule areas' net classes and a bus's own
class.
