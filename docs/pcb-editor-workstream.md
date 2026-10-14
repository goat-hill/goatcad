# PCB Editor Workstream

The board layout editor: tools, routing, zones, board graphics, view options and DRC. Roadmap
context: [MILESTONES.md](./MILESTONES.md) step 1 (high-speed design); the rest follows it in that list. What is built is described in [ARCHITECTURE.md](./ARCHITECTURE.md); this doc
holds the rules that govern the open work, then the open work in roadmap order.

## What the editor does today

- **Graphics and outline:** line, arc, rectangle, circle, polygon and text on any layer, click-click
  as in KiCad, never press-drag-release (`lib/board/pcbTools.ts`), with free / 90° / 45° line modes on the chain
  tools (`lib/lineMode.ts`, the route corner mode's setting); a closed `Edge.Cuts` outline tints the
  board area. Grid origin and drill / place file origin are placed by picker tools and reset from
  the tool search.
- **Selection and manipulation:** click, ctrl-multi and box select — a Shift band adds, a
  Ctrl+Shift / Cmd+Shift band or click takes out (Ctrl / Cmd alone is pan); drag-move and `M` move
  (ARCHITECTURE §3.7, One move; a click drops it, `Esc` puts it back), `R` rotate, delete;
  vertex handles on a sole-selected graphic or zone (`lib/board/graphicVertices.ts`); mirror for
  graphics, text and zones; `L` lock / unlock; `U` Select Connection, Select Net and `Shift+Del`
  Delete Full Track (`lib/board/selectConnection.ts`). `F` (and the Side field) flips footprints
  to the other side as KiCad's `FOOTPRINT::Flip` writes them (`lib/board/footprintFlip.ts`); a
  footprint holding a table is not flipped. `R` and `F` take a mixed selection — footprints,
  tracks, vias, zones, graphics, text — as one unit, about KiCad's reference point
  (`lib/board/boardItemTransform.ts`). Selection is the shared model every 2D editor uses
  (`lib/canvasSelection.ts`): Select Other lists what is under the pointer (hold a press, or
  the canvas menu), and a selected item draws in front of everything unselected, its pads and text with
  it — moved into a selected band of layer slots above the board (ARCHITECTURE §3.7), marked by a
  softer color shift and no halo.
- **Highlight Net** (`lib/board/highlightNet.ts`), KiCad's: `` ` `` lights the net under the pointer —
  its copper, the active layer's first, else a zone's fill — through `BoardScene`'s net focus, and
  holds it until `` ` `` on the same net or on nothing, or `~`. A route or drag focuses its own net
  meanwhile; a new zone takes the lit net; the status pill names it; it cross-probes to the
  schematic by name (split-view-workstream.md §6).
- **Fanout** (Edit ▸ Fanout…, `Shift+F`, the right-click menu and the tool search, available only
  while one footprint with SMD pads is selected, as Rotate and Change side are): an overlay in the
  canvas's top-right slot (`components/pcb/FanoutWidget.vue`) that follows the selection. Each pad gets a via by
  the pattern its pads call for — a dogbone for a grid (BGA), a staggered row of vias off each side
  (QFN, QFP, SOIC), a via array in an exposed pad — sized and spaced by Board Setup's rules
  (`lib/board/fanout.ts`, Altium's Fanout and Allegro's Create Fanout; KiCad has none). The
  overlay holds the style, direction and surface rows, and shows the plan for them live, since the
  planner is pure: what will be placed, and every pad that cannot take a via with the gap it
  measured, before anything is written. Enter runs it, Escape closes it. The via is the net
  class's and nothing smaller: a pad it doesn't fit is refused. The stub is the class's width, no
  wider than its pad and, in a row, narrowed to pass its neighbours' vias. Two vias of one net are
  spaced as any two are, and nothing loosens a rule to fit. A pad is skipped when its copper
  already joins the rest of its net (no airwire leaves it, a pour on its layer counting).
  `board.fanout` runs the same planner, with pads, nets and a via override besides.
- **Place Footprint** (`A`, a top-bar chip, the tool search): the library chooser, then the
  footprint on the cursor drawn as a selected footprint, `R` to turn it, a click to land it
  annotated and board-only (`lib/board/footprintPlace.ts`; [libraries-workstream.md](./libraries-workstream.md)
  §6). `board.place_footprint` runs the same placement.
- **Right-click** on the canvas selects what is under the pointer (keeping a selection it is part
  of) and opens the Edit menu's commands for it, each enabled only where it applies, as the
  schematic's does.
- **Routing:** one engine (`lib/board/router/`) serves highlight / avoid / push-and-shove
  (default) with spring-back, track and via drag (`D`, `viaDrag.ts`), and `F` auto-finish: sides decided
  from the route's history and kept (`walkaround.ts`), pushes that walk round what cannot move
  rather than dropping the route to Avoid, vias pushed with their tracks (`shove.ts`), drags
  re-drawn from their pins (`drag.ts`), and one `RouteSession` per trace that the preview and the
  click both ask (`engine.ts`). Routes leave and enter pads along the pad's axes (`padExit.ts`,
  R38), and a route removes the connection it replaces (`routeCommit.ts`, R27). Net-aware snap,
  live clearance (committed through only in Highlight with violations allowed), KiCad's corner modes, per-net width and
  clearance through the Board Setup net-class patterns. Via-while-routing: `V` or a layer key arms
  a via at the head's end, held to clearance on every layer it spans and to keepouts that forbid
  vias (pushing in Push, set at the nearest spot it fits in Avoid; R24); the click places it, a click that lays nothing finishes the route (so
  clicking the via just placed ends a route down to a plane), `Esc` steps back one intent, and the
  route's end hands back the layer it began on (router-behavior.md R21, R24). One trace, with everything it
  displaced, is one undo step. The router mode (Push, Avoid, Highlight, Ignore) governs a
  route and a track drag alike, so it lives in a corner pill beside Grid and Filter, not on the
  route toolbar (`components/pcb/CollisionModeControl.vue`): the pill reads the mode, opens a menu
  of all four, goes gold only for Ignore, and `Alt+R` cycles the others from any tool. It is a user
  preference (`lib/pcbRouter.ts`), kept across sessions as KiCad keeps router settings with the user.
- **Connectivity and ratsnest:** `lib/board/boardConnectivity.ts` clusters copper per net and
  yields MST airwires and an `unrouted` count; airwires follow drags. Nets arrive from the
  schematic through `lib/board/boardSync.ts` ([netlist-sync-workstream.md](./netlist-sync-workstream.md)).
- **DRC:** `lib/board/boardChecks.ts`, all 64 of KiCad's rules over the index, connectivity,
  the stored fills, the layers beyond copper, and — when supplied — the footprint libraries and
  the schematic's netlist, feeding the health pill, `board.check` and the export pre-flight
  ([design-health-workstream.md](./design-health-workstream.md) owns the rules and what is left).
- **Zones:** author, edit every KiCad property, drag outline vertices. `lib/board/zoneFill.ts`
  computes fills (clearances, thermals, islands, KiCad's stored form) over Clipper2. Auto-refill is
  debounced (400 ms), fills every zone, and lands with the edit's undo step; the board's Auto zone
  fill setting (full or off, `lib/board/boardAutomation.ts`) turns it off, and `B` refills on
  demand. An agent's write leaves the fills stale (ARCHITECTURE §3.11), which the open editor
  refills on the same debounce. Outlines draw as hairlines — a boundary, never
  mistaken for a track — and the border hatch is the file's `(hatch …)` style and pitch, drawn by
  the hatch shader and sloped as KiCad slopes it (`zoneHatchRises`: by the first layer's id, so `/`
  on every copper layer). The properties row takes any set of copper layers (a `multiselect`
  cell, written out one by one as KiCad 10 writes them) and the fill mode: solid, or hatched with
  its web width, gap and angle; smoothing and minimum hole area keep what the file says.
- **View:** layers / grid / selection-filter panels; a left rail for zone fills, sketch modes,
  inactive-layer dim (`H`), flip board, the ratsnest toggle and the board-area tint; `K` sketches
  tracks. Every layer a file can declare is listed and drawn (32 copper, 45 user). A dimmed layer
  darkens toward the canvas and stays solid. Labels take the ink that reads on what is under
  them. Per-board view state lives in `.kicad_prl` (ARCHITECTURE §3.15).
- **Clearance outlines** (Settings ▸ Board editor; the app's, as KiCad keeps them in its
  `pcbnew.json` rather than the project). Pads, never or always: every pad on the active layer,
  and a selected item on every visible copper layer, grown by its own clearance as hairlines
  (`lib/board/clearanceOutlines.ts`), a net's touching copper merged into one thin outline per
  layer. Tracks and vias, never, while routing (the route and its via), while routing and
  dragging, or always (every one on the active layer); a route's and a drag's outline, one merged
  shape round its tracks and via, is the class clearance the router keeps.

## Rules that govern the open work

- **The board never lies.** An invalid state is visible the moment it exists — collisions glow
  while the track rubber-bands, an unclosed outline gets no tint. DRC findings and stale zones
  follow the same rule.
- **One geometry kernel.** Clipper2 (`lib/geometry/clip.ts`), the polygonization layer
  (`lib/board/shapeOutline.ts`), the ring predicates (`lib/geometry/polygon.ts`) and one spatial
  index (`lib/board/spatialIndex.ts`) serve fill, routing clearance, ratsnest and DRC. No
  per-feature geometry stack. The index is KiCad's copper: a pad's copper sits at its drill
  offset, and a pad marked `remove_unused_layers` has copper only where it is flashed.
- **Command layer only.** Every mutation goes through `runCommand`; a new mutator joins the
  `markNodeDirty` capture contract and the structural-undo round-trip tests.
- **Refill is the app's job**; `B` is the override, not the workflow.
- **KiCad parity where KiCad is right** (hotkeys, postures, display modes, file fidelity), first
  principles where it is clunky (refill, feedback, modality).
- **Clipboard follows KiCad's domain rule:** board ↔ footprint editor interoperate (board →
  footprint drops tracks, vias and zones and says so; footprint → board lands as a placed
  instance); schematic/symbol never cross into PCB. Paste re-anchors on the cursor, re-assigns
  uuids, and maps clipboard nets onto the target board's net list. `lib/documentClipboard.ts`
  encodes the matrix and `lib/board/pcbClipboard.ts` the conversions. Paste does not float yet: it
  lands with its top-left at the cursor (a grid step off the source without one), since the board
  editors have no floating move.

## Open work, in roadmap order

### A placed footprint's properties (alpha)

KiCad's Footprint Properties dialog, as rows of the footprint's properties group. The group edits
position, rotation, side and locked, the fabrication attributes and the clearance, zone connection
and bridged-mask overrides (the footprint editor's rows, `footprintAttributeFields` /
`footprintOverrideFields`), and shows description and keywords read-only. Reference and value,
and a field's text, are editable on a footprint no symbol owns (`isSymbolOwned`); on one a symbol
owns the schematic owns them. Update from library, Change, Edit and Edit library footprint are
built, in the library section under the table ([libraries-workstream.md](./libraries-workstream.md) §5).

- Later: user fields (add, show, size, layer) and a per-instance 3D model offset
  ([BACKLOG.md](./BACKLOG.md)).
- Text variables in a footprint's text boxes and tables (`${REFERENCE}` in a box) resolve. Today
  they are drawn as written, on the board and in the footprint editor; only the footprint's fields
  and plain texts resolve.

### Editor gaps after alpha

- **Footprint zones on the canvas.** A footprint's rule areas (a module's antenna keepout) are
  read by the filler and DRC, and move with the footprint, but the board does not draw them.
- **Zone vertex insert / delete.**
- **Stale-zone hatch** during the refill window — the debounce is a silent window today.
- **Zone fill off the main thread**, contingent on measuring an 8-layer / 1000-via stress board.
  Jetson measures it now: a whole refill is some 27 s, and after an edit the refill and the
  board-wide checks make the editor stutter. The direction: one worker that keeps its own copy of
  the board, fed each edit, runs refill and the board-wide checks off the main thread. And fill
  freshness as state: a zone is current or stale (an edit, a rule change, a fill not ours on
  load); DRC folds a stale zone's findings into one "zones out of date · Refill" row, and export
  refills first — as Altium and Allegro track stale pours. The same fixture gates the router's
  hull caching and incremental index invalidation.
- **An Objects section beside Layers** — what KiCad's appearance panel keeps apart from the
  physical layers: tracks, vias, pads, zones, footprint text, pad net names, locked items,
  clearance outlines, ratsnest and DRC markers, each with visibility and opacity. The left rail
  keeps the few most used.
- **Locked items shown, quietly.** KiCad shades a locked part's pads magenta at half opacity (its
  locked-item shadow); a lighter mark here — a thin outline, strengthened on hover, on selection
  and when a drag is refused — and a lock badge in the selection chrome.
- **Clearance outlines in context**: beyond the display settings' outlines, what is near the
  cursor while routing or moving, sized by the resolver for this net against that item
  (router-behavior.md F3). An outline follows its copper only once a drag lands.
- **A via's net on hover**, for names too long to fit the via at the zoom a
  label shows.
- **A zone's cutouts**: a zone keeps one outline, so its holes are neither drawn nor left
  unhatched.
- **The footprint editor's labels in two inks**, as the board's now are.
- **Light theme: `In4.Cu` and `B.Cu` read as one blue** (ΔE 6); one of them wants another hue.
- **Lasso select**, beside the band: a freehand outline that takes what lies inside it, for parts
  a rectangle cannot isolate (a diagonal row, an L of passives round a chip).
  It takes the same add / remove modifiers as the band, and the same in-the-shared-selection home;
  every modifier is taken (Shift adds, Ctrl+Shift / Cmd+Shift removes, Ctrl / Cmd pans, Alt moves
  the window on some Linux desktops), so the likely shape is a sticky Box / Lasso choice beside
  the select tool.
- **Dimension authoring** (dimensions render).
- Pending-item properties before a drawn graphic lands.

### Router

- **The router is held to [router-behavior.md](./router-behavior.md)**: every case numbered, the
  tests cite them, and its Status section lists what is not built yet, push latency (Q1) among
  it.
- **Against KiCad's router** (PNS, `pcbnew/router/`): drag, push, vias and layer pairs, the
  settings, the routing runs over a selection, the rounded corner modes, differential pairs and
  length and skew tuning match it, each case in router-behavior.md. Left (its Status): push
  latency (Q1).
  - KiCad is the spec; a case differs only where ours adds what KiCad lacks or answers the same on
    every machine (the counted push budget, Q2), each with its **Differs from KiCad** note. The
    shorter side every frame (R7–R12), a failed push walking round everything (P5), the pair
    router's gateways (PR2–PR6) and the settings and tuner cases are built to KiCad's; what still
    differs is in router-behavior.md's Status.
- **Routing hotkeys users expect** (KiCad's from its `pcb_actions.cpp` / `router_tool.cpp`;
  Altium's from its defaults, unchecked). We have `X`, `Backspace` (mid-route the last click, as
  undo is; off a route Unroute Segment), `/`, `Ctrl+/` (corner mode, KiCad's; Altium
  `Shift+Space`), `Alt+R` (collision mode; Altium `Shift+R`), `F` (attempt finish; no
  ctrl-click), `End` (lay the head and end there), `Q` (custom size), right-click (the router
  menu), `V` (before a route too, R37), the via
  and layer pair keys (`Alt+Shift+V`, `Ctrl+V` mid-route, `<`, `Alt+<`, `Shift+V`; R40–R43),
  `Ctrl+E`, `Shift+X`, `Shift+E` (R44, R45), `+`/`-`, `PgUp`/`PgDn`, held `Shift` (no
  snapping to copper), `D` and `G` (free angle), double-click on a track (its connection, as
  `U`), `U` (repeats widen, as KiCad's), `Shift+Del`, the width and via keys
  (`W`, `'` / `\`, `Q`; S5, S6, S9) and the routing hints (K1–K5). Missing, most used first:
  - Keys for Break Track and the tracks moved to the next / previous copper layer, which are on
    the canvas menu only: KiCad's `Ctrl+=` / `Ctrl+-` are zoom here.

### High-speed routing

In alpha (MILESTONES.md step 1): built on the router, not beside it, so a pair and a tuned track
walk round and push as any route does; each has its cases in router-behavior.md. DRC checks a
pair's gap and uncoupled length and a net's length, skew and via count (`board/netLength.ts`).

1. **Impedance to width** — built. `lib/board/impedance/` ports KiCad 10's transline
   calculations and the tuning-profile page's input assembly, held to its numbers
   (kicad-parity.md, Impedance solver). Board Setup's Tuning profiles page edits KiCad's profiles
   and solves a layer's width and delay only when asked (Solve), reading each row back as an
   impedance (board-setup-workstream.md); agents do the same through `board_update_setup`. The
   router lays the width and gap a net's profile gives the layer it routes (router-behavior.md
   S12, S13).
2. **Differential pairs** — built (PR1–PR7). Left: the pair's skew shown while it is drawn (the
   Pair route group shows its sizes).
3. **Length and skew tuning** — built (T1–T7). Left: tuning to a delay target (a profile now
   carries each layer's delay, and DRC reads a rule in ps; the tuners still take mm).
4. **Interface presets** — built for USB 2.0 (High and Full Speed), a 50 Ω coplanar RF feed
   (sub-GHz, 2.4 and 5 GHz), MIPI CSI-2, Ethernet MDI and MII/RGMII
   (`lib/board/interfacePresets.ts`, data in `interfacePresetData.ts`). A preset
   turns an interface's budget into plain KiCad for one net class: a tuning profile solved over
   the stackup and named for the class, the class's sizes and profile, and the class's rules in
   `.kicad_dru`, plain KiCad named for the class (`USB skew within pairs`), which applying again
   finds by name and replaces (`rules/druRules.ts`, GoatCAD's one writer of custom rules).
   Nothing of ours is written beside them: no comments or markers, so which preset set a class
   up is not recorded. It is Board Setup's alone: "Set up standard interface…", under the net class table, opens a
   draft there for one of the project's classes, and every piece it would write shows as an added
   or edited row in its own table (the class, its tuning profile, and a read-only Custom rules
   section) until Apply writes them or Discard drops them (`presetDraft.ts`). Agents call
   `board_apply_interface_preset`, which may also take patterns to give a class its nets.
   - **Never inferred.** The nets are the class's, as Assignments and the schematic make them
     (or the patterns an agent gives); the plan lists them. A differential preset refuses nets KiCad would not pair, naming them. Which nets
     are USB is decided before a preset runs, by a person or an agent reading the schematic.
   - **Every number carries its source**, shown beside it in the draft and answered to agents: the
     interface's standard, and where it gives no board number, a chip-agnostic layout guide (TI
     SPRAAR7, AMD UG863, Infineon AN91445), with the page and the place on it. Never a particular
     chip's or module's datasheet; a preset is named for its standard.
   - **The gap is derived, never asked**: a pair's gap, or a coplanar line's gap to its pour
     (which becomes the class's clearance). Many width and gap pairs make the target, so the
     preset fixes the convention: the Default class's clearance, so the halves keep the board's
     spacing, never under the fab's minimum (Constraints), widened until every layer's width is
     one the fab builds. The draft shows the gap and the width as linked fields with the reason beside
     them: a typed gap solves the width, a typed width the gap (agents' `width`). The outer copper is solved unless other layers are
     ticked.
   - **One class per matched group.** A preset sets up one class; an interface whose groups match
     apart (RGMII's TX and RX, each with its clock) is applied once per group's class.
   - **Departing from a standard is a mode of its own, beside the standard's.** USB Full Speed
     has the spec's 90 Ω ±15% and, labeled as not held, a mode that writes only its rules, takes no
     profile and leaves the class at the Default class's sizes: on a thick two-layer board the
     spec's widths outgrow the connector's pads, and 12 Mb/s edges span far more than the trace.
   - **Only confirmed numbers ship.** USB 3, PCIe and HDMI wait for a source that is not one chip
     family's table (SPRAAR7J's Appendix A tables disagree); MIPI DSI for a source naming it; SD,
     eMMC, LVDS and DisplayPort for board numbers beyond an impedance.
   - **A coplanar line is beyond KiCad's profiles**: its widths come from KiCad's calculator's
     grounded coplanar model, and only the outer layers are offered. KiCad's own Solve on such a
     profile would answer a microstrip width.
   - Left: re-applying when the stackup changes is by hand (the plan is deterministic, so applying
     again rewrites the same files); a Custom preset taking typed budgets; DDR byte lanes.

### Fanout

- The op's pads, nets and via override have no place in the overlay yet, and the settings live
  only while the editor is open. Altium keeps them as a Fanout Control rule scoped by package,
  which would let a board carry its own policy for the overlay and the op alike.
- The overlay's plan is text; drawing the planned vias on the canvas before Enter would show
  where each lands.
- Cadence's Pushing Perimeter: the outer rows' vias pushed out past the package rather than left to
  the surface, which frees channels beside the part for its passives.
- Several footprints at once: each plan is checked against the board as it was, so one selection
  fans out one part.

## Out of alpha

Autorouting; arc routing;
Zone Manager, per-pad thermal overrides, custom spoke angles; padstacks and via tenting UI; net
color overrides; align / distribute, select-similar; curved ratsnest;
measure tool; multichannel replication.

## Against KiCad

What Pcbnew 10 has that this editor does not, checked against KiCad's toolbars, menus, actions and appearance panel (`pcbnew/toolbars_pcb_editor.cpp`, `menubar_pcb_editor.cpp`, `tools/pcb_actions.cpp`, `widgets/appearance_controls*`). An inventory of differences, not a plan: the sections above are the committed work, and the approved gaps are in [kicad-parity-workstream.md](./kicad-parity-workstream.md). Items already listed above or under Out of alpha are not repeated. What every canvas lacks (grid and cursor options, polar coordinates, measure, Properties) is in [BACKLOG.md](./BACKLOG.md#all-editors), once.

**Same job, another form.** Update PCB from Schematic is F8 and Tools, not a toolbar button; Switch to Schematic is cross-select and a split view.

**Partial.**
- Rotate and Flip: text boxes, tables and dimensions do not turn or change side; everything else does, as one.
- Rule area: a zone becomes a keepout through its properties row; there is no rule-area tool (Ctrl+Shift+K).
- Zone display is fill on / off; no fractured or triangulated modes.
- Layer presets exist; saved viewports (Alt+Tab), the preset-cycle key (Ctrl+Tab) and bulk layer actions ("show all copper", "hide all but active") do not.
- Track width comes from the net class or the track continued; the size list, chips and keys are router-behavior.md S1–S11.

**Missing — placement.** Image (reference image), barcode; import graphics (Ctrl+Shift+F); zone cutout (Shift+C) and draw similar zone.

**Missing — editing.** Group / ungroup; Move Individually (Ctrl+M), Move Exact (Shift+M), Position Relative (Shift+P); Duplicate and Increment; Select / Grab Unconnected (O / Shift+O); swap layers; the search panel (Ctrl+G); router settings (Ctrl+<), magnetic snap (Shift+S).

**Missing — inspect and tools.** Local ratsnest; Net Inspector; clearance and constraint inspectors; board statistics; Edit Tracks and Vias beyond the selection's Set sizes from rules (by net, class, layer or type, to given sizes), Global Deletions; a canvas preview of Clean up tracks and vias' changes, which the modal's scrim hides.

**Missing — view.** Opacity for tracks, vias, pads, zones and shapes, and per-layer alpha (`{` / `}`); the Objects tab's remaining switches (footprints front / back, values, references, images, anchors, points, colliding courtyards, drawing sheet — the board draws no drawing sheet; the rest is open work above); ratsnest by visible layers only and per-net or per-class ratsnest hiding; a switch for net names on pads and tracks; per-layer color editing; DRC markers on the canvas ([BACKLOG.md](./BACKLOG.md#design-health)).

**Skipped on purpose.** The interactive delete tool and lasso mode, as in the schematic ([schematic-editor-workstream.md §7](./schematic-editor-workstream.md)). Unfill zones (Ctrl+B): fills refill after every edit and the rail hides them, so an unfill lasts one edit.

