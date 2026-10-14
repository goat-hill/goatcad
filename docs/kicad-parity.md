# Matching KiCad's Checks

How GoatCAD's design checks are held to KiCad's: what each reads, how it is tested, and every
place we knowingly differ. The plan and open work are in
[design-health-workstream.md](./design-health-workstream.md).

## Shared

- **KiCad 10 is the spec.** We match the same rules, limits and severities. We match KiCad's behavior, not its code.
  A difference this doc does not list is a bug.
- **Catalogs.** `lib/board/drcCatalog.ts` and `lib/schematic/ercCatalog.ts` list every KiCad rule
  with its default severity. A rule no check reports is marked "Not yet supported" in setup.
- **Severities** are the project's `rule_severities`, read and written where KiCad keeps them. A graded rule (`pin_to_pin`,
  `lib_symbol_mismatch`) can only be turned off.
- **Exclusions** are KiCad's, honored but never written. They match on rule and item uuids, so they survive
  moves; a position-only exclusion cannot match. We have no waivers of our own.
- **Presentation** is ours: findings show as the pill, the drawer and canvas markers, not a dialog.
- **Testing:** `./bin/test-parity` runs our checks and `kicad-cli` 10.0.7 on KiCad's `demos/` and
  `qa/data/`, read from the pinned checkout. It never runs on CI.
  - **Known differences.** Each suite lists the boards it accepts as differing, with the reason.
    A board on that list counts as passing, and an entry that stops differing fails the run.
  - **Skips.** A board is skipped only if kicad-cli cannot load it, it predates KiCad 6, or it is on the
    `BROKEN` list. Any other board not compared goes in `UNCOMPARED` with its reason.
  - **Time budgets.** Each board has one (`__tests__/parityBudget.ts`). A board over budget is a
    regression, not a budget to raise.

| Suite | Compares | Passing |
|---|---|---|
| Board DRC | `kicad-cli pcb drc`, per rule, findings as a multiset | 246 of 249 |
| Incremental DRC | a check round an edit vs. a whole-board check | 253 of 253 |
| Zone fill | each zone layer to KiCad's refill, within 10 µm | 243 of 252 |
| Gerber | | 245 of 255 |
| ERC | `kicad-cli sch erc`, per violation key | 129 of 145 |
| Footprint | KiCad's board DRC on each library | all but listed cases |

"Passing" includes boards that pass through their known differences. Board DRC and zone fill
are from the last full run; the other rows are from earlier runs.

**Failing:**
- **Board DRC:**
  - `issue23053` (two extra `clearance` findings) and `issue8909` (one). Neither is diagnosed, and
    `KNOWN` covers neither (`issue23053`'s entry is for slivers).
  - `vme-wren` is not compared: kicad-cli runs out of its memory cap on a 27 GB machine.
    It should be in `UNCOMPARED` and isn't.
- **Zone fill:** the nine boards under Zone fill below. Three boards were not compared: two copies of
  `vme-wren` (kicad-cli's memory cap) and `fakeboard` (kicad-cli can't load it).

### Running the suites

`./bin/test-parity` from `electron/`. Never on CI. Run it before landing a change to a checker or
to anything a checker reads.

> **Know the cost before you run.** The board DRC suite is about 1 minute with KiCad's reports
> cached. The incremental suite (`boardChecks.incremental.parity.test.ts`) is about 25 minutes and
> loads the machine. Weigh that against what your change can affect.

- **Narrow it.** Without corpus variables only the sample projects run.
  - `PARITY_BOARDS=demos:qa` and `PARITY_SCHEMATICS=demos:qa` select the corpora, or files and directories.
  - `PARITY_FOOTPRINT_LIBS=Connector_USB` limits the libraries.
- **Pins.** `KICAD_SOURCE` must sit at `KICAD_SOURCE_COMMIT`, and `kicad-cli` must be
  `KICAD_CLI_VERSION`, both in `kicadParity.ts`. Another release stops the run
  (`PARITY_ANY_KICAD_VERSION=1` overrides). Bump a pin together with the known-difference lists.
- **One run at a time, other sessions included.** Full-corpus runs have stalled the machine.
- **Limits.**
  - The run is capped by `PARITY_HEAP_MB`, `PARITY_MEMORY_MAX` and `PARITY_CPU_QUOTA`.
  - Each kicad-cli call is capped by `PARITY_KICAD_MEMORY`, `_CPU_QUOTA` and `_TIMEOUT`.
  - The whole run is killed after `PARITY_WALL_MIN` (40) minutes.
  - Lower the caps when the machine is in use.
- **Cache.** Point `PARITY_CACHE` at a directory on disk (not `/tmp`, which is RAM). It keeps
  KiCad's reports, refills and the files kicad-cli gave up on.

## Board

### DRC

- **All 64 of KiCad's rules run.** Custom rules (`.kicad_dru`) read every condition function and
  property KiCad 10 has.
- **One resolver sets every limit** (`lib/board/rules/`): board setup and net classes first, as
  KiCad's implicit rules, then custom rules in file order. A rule file with an error is set aside
  whole, as KiCad does.
- **Findings are reported per layer, edge piece and padstack entry**, as KiCad reports them.
- **Collision is measured in whole nanometers.** At clearance 0, an overlap collides, and so does a
  touch between two hard edges.
- **Copper drawings conduct.** A board graphic on copper has a net; a footprint's graphics and text
  join nothing.
- **Free pads** (`unconnected-(…)`) are claimed by the first track or via that reaches them, in file order.
- **Footprint zones** are checked as the board's own.
- **How the suite compares:**
  - A board runs under its project's rules and severities, with the libraries kicad-cli sees.
  - Where a schematic sits beside the board, the board is also checked against it.
  - Where KiCad names items by memory order (length, skew, via count, creepage), findings are
    compared by net.
  - KiCad stops reporting a rule after 199 findings (499 for clearance and unconnected),
    hard-coded in `drc_engine.cpp`. On a board past that, our extra findings are unchecked;
    the small single-behavior test boards cover those rules instead.
- **Run time:** see the warning above. Of the incremental suite's 25 minutes, 18 go to `vme-wren`,
  `VCU118`, Jetson and `issue22475`.

**Known differences** (`KNOWN` in `boardChecks.parity.test.ts`; 19 boards, the demos' and QA's `vme-wren` counted apart; a board can fall under more than one cause):

| Cause | Boards | Rules |
|---|---|---|
| **Our schematic netlist names nets differently.** Nets named through a bus member are not yet KiCad's; issue22548 leaves one U4 unannotated. | vme-wren, Jetson, video, RoyalBlue54L, issue22548 | `net_conflict` |
| **Deliberate deviations** (below) | vme-wren (QA copy), issue5093, One-Air-Max, Jetson, padstacks_complex, issue22475, VCU118, issue24758, complex_hierarchy, issue21482 | silk, `annular_width`, `clearance`, `track_dangling`, `creepage`, `malformed_courtyard` |
| **KiCad 10.0 bug, fixed upstream.** It reads an oblong NPTH slot as a board edge (KiCad #24799). | stickhub-extra-via, issue23469 | `copper_edge_clearance` |
| **KiCad's report cap.** KiCad stops at 199 findings, in its own walk order. | VCU118 | `silk_over_copper` |
| **Creepage through overlapping cutouts.** KiCad paths round the cutouts' union. | issue24078 | `creepage` |
| **Not diagnosed** | issue23053 (fill wedges read as slivers), VCU118 (one sliver), vme-wren (narrow necks), CM5_MINIMA_3 and Jetson (silk read as crossing the edge) | `copper_sliver`, `connection_width`, `silk_edge_clearance` |

**Deviations** (deliberate; each is exact where KiCad errs, or orders where KiCad uses memory order):

| We | KiCad | Seen on |
|---|---|---|
| Measure an unfilled circle by its stroke | Measures it from its centerline against segments and square rectangles | vme-wren, One-Air-Max, issue5093, Jetson |
| Count an arc inside a round opening as colliding | Misses containment | |
| Count an arc overlapping a sharp rectangle by less than its width as colliding | Reads the overlap as a gap | |
| Join an arc that lies wholly inside a via or round pad to it | Leaves the arc dangling | VCU118 |
| Measure arcs exactly | Rounds a large arc's center, so a gap a hair from its limit can read either way | issue22475 |
| Fail a pad or via layer narrower than its hole on `annular_width` | Passes it (measures by magnitude) | issue24758, complex_hierarchy |
| Measure each padstack layer's ring on that layer's copper | Uses the front size for every layer (10.0.6) | padstacks_complex |
| Report a pad–via hole clearance or hole-to-hole once | Reports it twice | |
| Report a creepage pair once | May repeat it per layer | issue21482 |
| Take outline ends meeting at one point in file order | Takes them in k-d tree order | vme-wren IC10 |
| Treat a touching net-0 item as a short when the other item has a net | Decides by uuid order | |
| Not short two same-number pads when one is on no net | Decides by memory order | |
| Keep the nets of copper that joins two nets with no pad | Takes whichever net it meets first | |
| Name the higher-uuid item on ties in creepage and signal findings | Names whichever its memory order meets first | |
| Count a crossing where a circle meets an edge exactly at a polygon vertex (count may be off by one) | Counts it its own way | |
| Not treat `Margin` as an edge to copper (it is one to silkscreen) | Same for silkscreen | |
| Bore exactly the layers a backdrill passes through | Claims one more layer from B.Cu | |
| Read a unitless property comparison (`A.Orientation == 0`) in mm, degrees or 1/0 | The comparison never holds | |
| Propagate nets on edit; on open, a file keeps its own nets | Propagates them on load | |
| Not hold TrueType text to `text_thickness` | Holds it | |
| Leave a library our parser can't read unjudged | Judges it | |

### Zone fill

`lib/board/zoneFill.ts` follows KiCad's `ZONE_FILLER`, since what it writes is file content KiCad reads.

- **Pours** start from the outline joined with touching same-net zones. Same-net pads connect as
  set (thermal, solid or none). Everything else is cut at the resolver's clearance plus 0.5 µm.
- **Zone priority.** Higher-priority zones fill first: other nets are knocked out by fill plus
  clearance, and the zone's own net is joined.
- **Islands** not connected to a pad are removed.
- **Hatched pours** keep KiCad's grid.
- **Footprint zones** are never refilled.
- **Courtyards** a `physical_clearance` rule keeps the pour from are cut on the layer's side (an inner layer, the footprint's own), shrunk 5 µm as KiCad builds them, then grown by the rule.
- **Not built:**
  - stray Edge.Cuts and Margin items;
  - zones that lost islands at the start of a refill;
  - backdrilled layers.

**Known differences.** Every demo kicad-cli could refill matches. Nine QA boards differ:

| Boards | Why |
|---|---|
| issue24758, issue24835-min, zone_refill_convergence_limit | KiCad's refill rounds |
| issue23467 | 10.0.6 cuts an unplated slot by the copper clearance |
| issue12964, issue23790, issue6039, issue21746, issue5093 | each tests one KiCad fix; not diagnosed |

### Teardrops

`lib/board/teardrop/` builds teardrops as KiCad 10's `TEARDROP_MANAGER` does (`pcbnew/teardrop/`),
since the zones it writes are file content KiCad reads: the anchors on the track and the hull of
the clipped pad, two-segment spans, off-centre entries, curved edges (KiCad's Bézier subdivision),
arcs, the solder-mask companion, the priorities, and every rule for when a pad or via gets none.
A command rebuilds the teardrops of what it touched, as `BOARD_COMMIT::Push` does; a refill
rebuilds them all first, as Fill All Zones does; a board with KiCad 7's teardrops is left alone.

- **Testing:** `teardrops.parity.test.ts` runs pcbnew itself (kicad-cli has no teardrop command)
  under xvfb, with a startup plugin that runs Fill All Zones and saves, over a board of cases:
  round, rectangular, rotated, oval, rounded, chamfered and trapezoid pads, vias, curves,
  off-centre and crossing tracks, two-segment spans, arcs, inner layers and a bare track's mask.
  Linux only; it skips where pcbnew or xvfb-run is missing.
- **Results:** every teardrop pcbnew makes is ours, each point within 5 nm (most exact; 1–3 nm
  where a clipped or curved point rounds differently).

**Deliberate differences:**

| We | KiCad |
|---|---|
| Keep track-to-track's switch as the saved target (`td_ontrackend`), so those teardrops are kept across sessions | Keeps it in memory only: after reopening, edits stop maintaining them |
| Rebuild a track-to-track pair when either track was edited | Skips a pair whose wider track was edited, and rebuilds every untouched pair |
| Rebuild every teardrop after Edit teardrops, filtered or not | Rebuilds only the edited pads' and vias' when filtered |
| Build a custom pad's, or a rounded chamfered pad's, outline exactly (`padCopper.ts`) | Builds it in chords, micrometres inside |
| Refill a teardrop only when an edit's copper came within its reach | Refills every zone |

Track-to-track teardrops are not held to pcbnew: KiCad saves no switch for them, so its Fill All
on a board it opens makes none.

### Impedance solver

`lib/board/impedance/` solves a tuning-profile row as KiCad's Tuning Profiles page does, since
what it writes is file content KiCad reads: the same models (microstrip, coupled microstrip,
stripline, coupled stripline from `common/transline_calculations`), the same inputs from the
stackup, 1 GHz, and the same integer units (widths in nm, truncated; delays in as/mm).

- **Inputs** are KiCad's: F.Cu and B.Cu are microstrip over one reference, inner layers
  stripline between two; the dielectric between is the thickness-weighted mean of its layers;
  a board without a stackup gets KiCad's default build.
- **What it ports** is everything that reaches the width, gap, impedance and delay. KiCad's
  losses and electrical lengths are left out.
- **Coplanar waveguide** has no tuning-profile model in KiCad. It is held to the PCB
  Calculator's (`pcb_calculator/transline/coplanar.cpp`) instead, including that calculator's
  100-step search, which can diverge where KiCad's does.
- **Testing:** the expected values come from KiCad 10.0.6's own sources, compiled unchanged and
  driven with the inputs the page assembles. They cover 2-, 4- and 6-layer builds, mixed
  dielectrics, sublayers and KiCad's refusals. Widths and delays match exactly.
- **Ours:** a pair's impedance is twice its dispersed odd mode (the quantity a solve holds to the
  target), where KiCad's calculator shows twice the static one.

## Schematic

### ERC

- **Coverage.** 43 of KiCad's 44 rules run. `simulation_model_issue` (off by default) does not.
  Schematic Setup leaves out `bus_definition_conflict` and `bus_entry_needed`, since no KiCad check
  raises them.
- **Results.** All 36 demos match, and every QA file kicad-cli can check matches but for the deviations below.
  - 17 QA files are skipped: they predate KiCad 6, or kicad-cli cannot load them.
  - The suite reads the symbol libraries KiCad would see, and compares per violation key.

**Deviations:**

| We | KiCad | Seen on |
|---|---|---|
| Check each no-connect flag in a sheet whose same-named pieces fold together | Checks only the last flag | CM5_MINIMA_3 |
| Report both copies of a duplicated off-grid bus-entry layout | Reports the first | issue21798 |
| Grade `lib_symbol_mismatch`: an error where pins differ from the library, a warning where only the drawing does | One severity for both | |

## Libraries

### Footprint checker

- **Matches `FOOTPRINT::Check*`.** It is tested by running KiCad's board DRC on each library.
- **Listed cases.** The harness (`footprintChecks.parity.test.ts`) lists each case where it
  differs, where KiCad's own geometry errs.

### Symbol checker

- **What it finds** is KiCad's `CheckLibSymbol`. The severities are ours, since KiCad's checker has none.
  - Errors: duplicate pin, invalid power symbol, zero-size shape.
  - Warnings: reference prefix, off-grid pin, hidden power inputs.
- **Grid.** Pins are held to the project's connection grid, never finer than 25 mil.
- **Not parity-tested.** kicad-cli has no symbol check. KiCad's own library comes back with only real defects.

## Chasing a difference

- **Read KiCad's behavior from the release, not the checkout.** The pinned checkout is KiCad's
  development branch; the suites compare against 10.0.7, and DRC and the filler differ between them.
  Fetch a file with `curl -sfL https://gitlab.com/kicad/code/kicad/-/raw/10.0.7/<path>` into the
  scratchpad and read it there. Use the checkout only to find where to look.
- **Read what KiCad reported.** The DRC report cache (`$PARITY_CACHE/drc/<sha1>.json`, its source
  file in `source`) has each finding's detail. `(clearance 0.2000 mm; actual 0.1995 mm)` often
  names the cause.
- **Run our side in seconds.** Write a one-off script, run with
  `node node_modules/jiti/lib/jiti-cli.mjs`, instead of the suite, which takes minutes.
  - DRC: parse, `BoardSpatialIndex.build`, `computeConnectivity`, then `boardChecks` with
    `settingsFor(file)` from `parityBoards.ts`.
  - Fill: parse KiCad's cached refill, call
    `computeZoneFill(board, index, zone, zoneFillOptions(boardRules(...), zone))`, and diff against
    that zone's stored fill.
- **Fill differences** (`zoneFill.parity.test.ts`):
  - **Narrowing:** `PARITY_BOARDS=<file or dir>`.
  - **Report:** `PARITY_REPORT=<file>` lists each zone's deviation and its largest differing pieces.
  - **Dumps:** `PARITY_DUMP=<dir>` writes both fills of each differing zone as JSON (mm, y down).
    Drawn to a PNG (KiCad-only green, ours-only red), a dump finds most causes at a glance.
- **Caches** live under `PARITY_CACHE` (e.g. `~/.cache/goatcad-parity/`, `drc/` and `fill/`). A
  key is the sha1 of the kicad-cli version, the board path and text, then each `.kicad_pro` and
  `.kicad_dru` path and text (`refill` added for fills).
- **Profiling a slow board:** `node --prof` survives a timeout. A killed `--cpu-prof` writes nothing.
