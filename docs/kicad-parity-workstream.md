# KiCad Parity Workstream

The gaps against KiCad 10 that the maintainer approved to build, taken from the schematic doc's
§7, the PCB doc's Against KiCad and [BACKLOG.md](./BACKLOG.md). Each has KiCad's behavior as its
spec and needs no design decision beyond the note beside it. Not a copy of KiCad: an item is here
because it earns its place, and a note says where ours should differ. Hotkeys follow
[DESIGN.md §Keymap](./DESIGN.md#keymap), whose reserved-keys table covers every binding below. The
PCB items already in [pcb-editor-workstream.md](./pcb-editor-workstream.md) (place a single
footprint, zone vertex insert / delete) stay there. Delete a line when it ships.

## Schematic

- Ellipse and elliptical arc tools: the sheet neither parses nor draws `(ellipse)` /
  `(ellipse_arc)` yet (KiCad 10 tokens), so each is parse, render and hit-test, then a tool.

## Symbol editor

- Ellipse and elliptical arc tools.
- Export as SVG.

## PCB

- Selection filter: dimensions and other. Dimensions draw but have no hit test, move or delete;
  nothing the board selects falls under other yet. (Points have their own switch.)
- Footprint-text visibility (references, values, other text) lives in tool search until the
  Objects section beside Layers ([pcb-editor-workstream.md](./pcb-editor-workstream.md)) takes it.

## Footprint editor and PCB

- Table tool, in both editors. A table already parses, draws, selects, moves and deletes; what is
  missing is filling it: KiCad's Draw Table ends in its table dialog, where the cells get their
  text, and neither editor edits a cell yet (a text box's string is a property row; a table's cells
  want a grid editor). Build that, then the tool: two clicks sizing the grid as `tableDraft` does.

## Properties panel

Rows KiCad's properties panel has and ours lacks, read off its `PROPERTY_MANAGER` registrations
(ARCHITECTURE §Properties panel). Every row below needs parsing, a writer, or a decision first;
the rows the model already carried have shipped.

- **Footprint children on a board** are KiCad's three — pads, fields and texts — each a hit level
  under its footprint (`[child, footprint]`, BoardScene `hitCandidates`) that outranks the
  footprint's box. A pad's move, rotate, flip and copy take the footprint and Delete passes over it;
  a field or text moves and turns on its own, Delete hiding a field and removing a text. Left:
  KiCad lets graphics, zones and the rest inside a footprint select only the footprint, and so do
  we — editing them is the footprint editor's.
- **Locked in the schematic.** `SCH_ITEM` gives every item but fields and pins a Locked row; the
  schematic parses no `(locked yes)` yet.
- **Placed footprint:** Reference and Value stay read-only (the schematic owns them; a board-only
  footprint's are in [pcb-editor-workstream.md](./pcb-editor-workstream.md)); its other fields have
  no rows.
- **Pads:** zone connection and thermal relief (spoke width, angle, gap), fabrication property,
  copper-layers mode and pad-to-die length — none parsed.
- **Vias:** tenting rows (in the model, no writer); covering, plugging, filling and capping
  (not parsed); backdrill and post-machining (read for DRC, no rows).
- **Tracks:** Soldermask and its margin override on outer copper (in the model, no writer).
- **Board zones:** hatch minimum hole ratio and smoothing (in the model); copper thieving and
  placement rule areas (not parsed). **Footprint zones:** name, priority, fill and thermal rows.
- **Shapes:** arc Angle and polygon Position (derived; each edit has to rebuild the shape);
  Soldermask on outer-copper shapes; Hatch, Reverse hatch and Cross-hatch fills.
- **Text:** Font and Auto thickness; renaming a field.
- **Tables:** border and separator style and color; position; cells (column width, row height,
  fill, margins) wait on cell editing, with the table tool above.
- **Schematic:** wire and bus Start, End and Length as edits; sheet border and background color and
  its exclude and DNP flags; Exclude from position files on a placed symbol; a selected field's own
  group (Show name, Allow autoplacement); rule-area exclude flags; image width and height.
- **Symbol editor:** Unit as a choice (all units or one) and Body Style, which wait on authoring an
  alternate body style; Private on graphics and text; rectangle corner radius.
- **Not yet anywhere:** dimensions (partly parsed), reference images and groups.
