# Backlog

Deferred work with no active workstream — one line each, no history. Work that is next lives in
[MILESTONES.md](./MILESTONES.md) and the `*-workstream.md` docs, not here; the approved KiCad gaps
are in [kicad-parity-workstream.md](./kicad-parity-workstream.md). Delete a line when it is
done or no longer wanted; when an area becomes active, move its lines into a workstream doc.

## All editors
- Box zoom, arrow-key cursor and pan.
- Grid overrides; lines or crosses as well as dots on the board and footprint canvases.
- Polar coordinates and a local origin (Space) with a dx / dy readout.
- Cursor: full-window and 45° crosshairs beside the small one.
- Measure (Ctrl+Shift+M); Import Graphics (Ctrl+Shift+F); Properties (E).
- Select similar: everything sharing the selection's kind and value, footprint or net.
- Visual diff as a read-only diff mode of each editor, in place of the diff tab's own canvases (`BoardDiffViewport.vue`, `VisualDiffView.vue`), so view hotkeys, toolbars and panels come for free.

## Agent interface
- Documents in main or a worker rather than a hidden renderer, so a background workspace costs no Chromium process.
- One document in two views (two windows) without a second copy.

## Design health
- One-click fixes on a drawer row, each also an agent op and tested to clear its finding every time — ERC: a PWR_FLAG on an undriven rail, a no-connect, annotate, update a symbol from its library; DRC: refill, trim a dangling track, widen a track to its class, remove a duplicate via.

## Board
- Create Array (Ctrl+T): KiCad's grid (counts, spacing, row and column offsets, stagger) and
  circular arrays of a selection, copies keeping net and the via's `free` flag. Deferred because an
  agent can place stitching vias and repeated items itself; KiCad's array checks no clearance.
- Fanout that adjusts via size: today a pad the class's via (or the override) doesn't fit is refused
  A step-down through the board's via list, chosen by the caller, would save hand vias in
  tight parts.
- Partial zone refill: fill only the zones an edit changed (the editor's auto-refill, the agent's
  stale set). Teardrops already skip the ones nothing came near (the board worker). The bounding-box test it had missed copper drawings and island removal, which reads
  the whole net's connectivity; a return is checked against a full refill on real boards.
- Teardrops: KiCad's note on a legacy board's pads and vias ("Board contains legacy teardrops",
  pointing at Edit teardrops); a footprint drag hides nothing, where KiCad's router hides the
  teardrops it moves copper under (ours hides them under a route's or drag's preview).
- Barcodes (KiCad 10's `(barcode …)`): parse, draw and measure. KiCad generates the modules (QR,
  Data Matrix, Code 39, Code 128) as it loads a board, so each needs its encoder; until then the
  DRC parity suite sets a barcode's findings aside.
- `boardSync.oracle.e2e.test.ts` (`./bin/test-e2e`) fails KiCad demos (video, vme-wren,
  tiny_tapeout, jetson, royalblue54L_feather) on net names: sync says `/buspci.sch/DQ31` where
  kicad-cli's netlist says `/DQ31`, a net named through a bus member (KiCad's
  `propagate_bus_neighbors`). The demo list predates the cross-sheet fix (`e1261ea8`).

## Symbol editor
- Author an alternate body style (add, name, remove), then a "common to all body styles" row.
- Pin table: stacked-pin grouping, region paste into the grid, hover highlight of a row's pin.
- Cross-symbol fields grid.
- Copy a single symbol between libraries (footprints have `footprint_copy`).
- Generate multi-unit symbols (bank a large MCU by port); `symbolGenerate.ts` writes one unit.
- Against KiCad's Symbol Editor, not yet here: Import Graphics; Add to Schematic; Derive from
  Existing Symbol and Flatten Symbol; Update Symbol Fields and Symbol Pin Maps; Show Datasheet.
- Editing against KiCad: keyboard Move and Swap; push pin length / name size / number size;
  convert and explode stacked pins; next / previous unit and cycle body style actions.
- Pin table columns beyond number, name, type and unit: shape, orientation, X/Y, length, name and
  number size, body style, visibility, alternates, and a pin count.
- View: Show Pin Electrical Type, pin alternate icons, synchronized pins mode (edit a pin across
  units), bounding boxes.

## Footprint editor and 3D models
- A pad placement ghost.
- 3D-model link editor (path, offset, scale, rotate); `FootprintPropertiesPanel.vue` defers it.
- `${MODEL}` column in the Components table (`bom_get` has it).
- Delete a cached model; today it is a manual file delete.
- `detail: 'models'` on `footprint_get`; model-file status on `footprint_search` rows.
- `init` guidance for when no manufacturer model exists: borrow a body-matched package, or ask.
- Attach a model on a board footprint instance (after `items_*` reaches the board).
- Note on `footprint_create` when a standard package matches the pitch and pin count.
- Decide on a user-tier house library for generated symbols and footprints (project tier only today).
- Against KiCad's Footprint Editor, not yet here: image and rule area tools; the dimension tools
  (aligned, orthogonal, radial, center, leader); Import Graphics; Load from / Save to Board.
- Editing: Move Exact, Create Array, Position Relative, align / distribute; group.
- Pads: Default Pad Properties (the tool drops a fixed 1.2 × 1.5 mm SMD rect); enumerate /
  renumber, a pad table, copy / apply / push pad settings; explode and recombine, create pad from
  shapes; pad properties beyond number, type, shape, position, angle, size, round drill and
  roundrect ratio — layer set, oval and offset drill, trapezoid delta, chamfer, custom primitives,
  padstack modes, clearance and mask / paste margins, zone connection, thermals, fabrication
  property, pin function and type, die length.
- Footprint Properties beyond name, side, description, keywords, locked, attributes, clearance,
  mask / paste margins and zone connection: private layers, net-tie groups, component class, the
  fields table.
- View: view from bottom, per-object opacity and layer colors; the layers list covers 12 layers,
  so Edge.Cuts, Adhesive, Margin and the User layers cannot be shown, hidden or made active. (No
  grid chip on the rail: the grid's home is the corner pill, DESIGN.md §Icons.)

## Parts (agent)
- Batch MPN lookup on `parts_compare_mpn` (`mpns=[…]`, chunked per distributor).
- `check_bom` sweep: per row, unsourced / no MPN / obsolete or NRND / out of stock.
- Daily quota reserve for the UI in `partsRateLimit.ts`; cap `offset` in `parts_search_category`.
- `parts_search_category` guidance: DigiKey's in-stock filter is product-level, so a row can show zero.

## Project
- Project Setup pane — a GUI editor for `board-intent.md`.
- Serve derived project context (layers, outline, rules, fab profile) from `project_context`.

## 3D board
- Resolve user-defined `${VAR}` model paths from KiCad's `kicad_common.json`.
- Real paste-stencil apertures; paste is the one layer not clipped to true openings.
- Incremental 3D rebuild; every edit is a full rebuild.
- Export the assembled board as a 3D model (glTF/STEP) for renders past `render_board_3d`'s camera and light options.

## Coordinates
- Feed Clipper integer nm directly; `clip.ts` scales mm by 1e6 per boolean.
- nm-native spatial index, so `boardConnectivity`'s `CONNECT_EPSILON` becomes exact.
- `nm()` rounds as `Math.round`; make it KiCad's `KiROUND` (they differ on negative halves), and lint the KiCad-integer modules against bare `Math.round`/`Math.trunc`.
- A `test-parity` suite holding `footprintFlip.ts` to KiCad's own `FOOTPRINT::Flip` through its Python module, over the demos and QA corpus.

## Documents
- One board text, not two: once a board writes new text, the text it was read from stays alive,
  held by `DocumentHandle.diskText` and by every parsed uuid (a sliced string of it). A dirty test
  by version (a saved version, undo entries carrying theirs) plus board parses copying their uuids
  out took Jetson's heap after open from 780 to 636 MB at the same open time; either alone frees
  nothing. Shelved for the QA it needs across every save and dirty path.
- Memory/eviction policy over `DocumentHandle.discard()`: idle, unpinned, largest first, a
  schematic's sheets as a group.
- Tabs carry their document (dirty buffer, undo) between windows.
- Headless reuse of the document and session layer in Node.

## Terminal
- Font-size setting, or a global app zoom.
- PowerShell-safe agent hook command (`$env:` form) for Windows without Git Bash.

## Agent API
- An agent's drag (router-behavior.md D1–D15): `route_begin`'s `drag: {item, at}` beside `pair` and `tune`, `at` moving the grab, a click dropping it, `route_preview` comparing drops; today an agent deletes and reroutes to straighten a jog or slide a bus.
- Parallel routing sessions on one board, for agents routing side by side (a viewport each already works).
- The router in a worker (router-behavior.md Q1): an agent drives it on the person's UI thread, and every capture draws there too.
- Schematic findings say where, as the board's do: a sheet instance path resolved to its sheet file, so `at` is usable. `schematic.check` answers per-rule ids only.
