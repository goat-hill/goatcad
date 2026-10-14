# Schematic Editor Workstream

Decisions that govern the schematic editor and what is still open in it. How it is built is in [ARCHITECTURE.md §3.2](ARCHITECTURE.md); the tool-by-tool research behind the decisions is [research/schematic-editor-features.md](research/schematic-editor-features.md). Section numbers are cited from source — keep §1 and §6 stable.

## 1. Settled decisions

- **Floating toolbar, not a fixed bar.** Tools live in the top-left `.canvas-floating-toolbar`: undo/redo | icon-only tool chips | an inline insert-search box. Tool name and hotkey live in the tooltip. No Save, Fit, Grid or summary text on the bar.
- **Inline insert search** (the Onshape pattern): focused-empty lists every op (icon, name, hotkey) in a panel anchored under the box's left edge; typing filters, ↑/↓/Enter arms. It is the seed of a global command palette.
- **No spacebar bindings** — Space means conflicting things to Altium and KiCad users. `/` focuses the insert search when idle and toggles the wire posture mid-wire.
- **KiCad hotkeys** (`W B Z I L Ctrl+L H Q J T A P S R X Y M G Ins Alt+Backspace`, plus Ctrl/Cmd+C X V D F), registered in `lib/hotkeys.ts`. `W` and `S` act at the snapped cursor the moment the key is pressed; with the pointer off the canvas they arm the tool and wait for a click. Drop tools keep ghost-and-click.
- **Label icon** is an underlined "A" (the net-label visual); the flag glyph is reserved for global/hierarchical labels.
- **Junctions are output, not input**: placed by the wire cleanup; the manual junction tool exists only in the insert search, for joining a crossing.
- **Chooser-first symbol placement**: `A`/`P` open the library chooser ([libraries-workstream.md](./libraries-workstream.md)); picking arms a repeat-placement ghost — the part as it will land (unit, turn, reference, fields), drawn by the sheet's own symbol emitter as if selected, KiCad's look while placing. A placed part is always annotated (`nextReference`), never `R?`.
- **A child sheet is a canvas tool, not a menu create**: two clicks draw the box, a popover names sheet and file, commit writes the child file (not undoable) and inserts the `(sheet)` node (undoable). Deleting a sheet removes the node, never the file.
- **Rotate/mirror moves only the selection** — wires, labels and flags on its pins stay put, as in KiCad. A lone symbol turns about its origin, a group about its grid-snapped middle, a mid-drag turn about the cursor. Sheets do not turn.

## 2. What it does today

- **Placement tools:** wire, bus, bus entry, label (local/global/hierarchical), directive label, no-connect, junction, text, text box, table, line, rectangle, circle, arc, bezier, rule area, image, symbol, power, child sheet and sheet pin. The sheet-pin tool offers the child's hierarchical labels that have no pin yet. Each tool previews the item it will write (`lib/schematic/drawTools.ts`) and commits as one undo step.
- **Drawing and hitting:** everything KiCad keeps on a sheet draws and hits on its real outline — buses and entries, graphics with line styles and hatch fills, text boxes, images, tables, directive labels and rule areas (`lib/engine/schematicHitShapes.ts`).
- **Editing:** select, box-select, and move, rotate, mirror and delete any item (`sheetItemPlacement.ts`), with wires following (§6). Also wire and bus point handles, G/M held drag, sheet resize, and align and distribute (`alignItems.ts`).
- **Clipboard:** copy, cut, paste and duplicate in eeschema's clipboard format, re-annotating what lands (`schematicClipboard.ts`). `Ins` repeats the last item with auto-increment (`schematicRepeat.ts`).
- **Properties panel:** fields (U / V / F jump to Reference, Value, Footprint), a part's unit and body style, text, graphics, sheet name/file/size/page, sheet pins, directive labels and bus width. With nothing selected it shows the sheet on screen: name, page, paper size and title block (`titleBlock.ts`, `sheetPages.ts`).
- **Hierarchy:** hierarchical sheets resolved across open buffers, each sheet shown as one instance. Double-click enters a sheet and Alt+Backspace leaves it; the Go menu adds back / forward (Alt+← / →) and previous / next sheet (PgUp / PgDn) (`sheetNavigation.ts`). Siblings are ordered and new pages allocated as KiCad's navigator does.
- **Design-wide commands:** find and replace across sheets (`schematicFind.ts`), the Annotate dialog, Increment Annotations, and update or change symbols from the library (`symbolUpdate.ts`).
- **Connectivity and checks:** connectivity joins what KiCad 10 joins (`lib/schematic/connectivity.ts`), and the electrical checks feed the health pill with quick fixes (`checks.ts`).
- **Outputs:** netlist export (`netlist.ts`), File ▸ Update PCB from Schematic (F8), a Components tab (the BOM/footprint table), and cross-select with the board (ARCHITECTURE §3.14).
- **View:** a canvas context menu, plus a view rail with fit, net highlight and hidden pins/fields.

Every mutation goes through the command layer, and the agent's `schematic.*` / `items.*` ops run the same code: each drawing tool's item, the bus and bus entry and the directive label are item kinds an agent creates, reads, restyles and deletes, written by the tool's writer and the properties panel's setters (`sheetGraphicItems.ts`).

## 3. Open — alpha ([MILESTONES.md](./MILESTONES.md))

- Show pin numbers / names and Exclude from position files on a placed symbol (KiCad's Symbol Properties has both; the lib symbol carries `in_pos_files`).

## 4. Open — later

- Tab-to-edit while placing, with sticky values (set a value once, place ten).
- `X`/`Y` mirror while placing a symbol from the chooser (only `R` turns the armed ghost; a floating paste or repeat already takes R/X/Y). The ghost's body fill: it draws as outlines, since fill meshes sit outside the preview batch it moves.
- Hover hotkeys — act on the item under the cursor with nothing selected.
- The live net verdict during a drag reads the dragged sheet only.
- A sheet in a selection that is turned mid-drag is left in place at the drop.
- A global command palette grown from the insert search.
- Bus unfolding (a member pick-list off a bus, with entries placed for you).
- Design variants, design blocks and multi-channel reuse; SPICE directives round-trip.

## 5. Out of alpha

Nothing held back: buses, bus entries and netclass directives, once deferred here, have shipped (§2).

## 6. Wires follow a move

Dragging a wired symbol, sheet, wire, junction or label keeps its wires attached and orthogonal. **Shift** while dragging is a bare move that leaves the wires behind (not Alt — a window-move gesture on some Linux desktops; Ctrl+drag is pan). From the keyboard, KiCad's **G** (drag, wires follow) and **M** (move, wires stay) pick the selection — with none, the item under the pointer — up at the pointer; a click drops it and Escape abandons it (`ViewportEngine.beginHeldDrag`). There is no orthogonal/free-angle preference and no junction toggle.

**A wire's points** (`planVertexDrag`): a selected wire or bus shows a square handle on each point. Dragging one moves that point alone — the segment may go diagonal where it is pulled. An end drags what meets it (the other wire ends, reshaped as off a moved junction; a dot, label or flag carried) unless it sits on a pin or tees onto another wire, which hold the rest in place; Shift leaves everything behind. A wire teed onto the dragged one stays put.

**The rules, in priority order** (`lib/schematic/wireReshape.ts`):

1. **Wires stay orthogonal.** A move never produces a diagonal. A diagonal read from a KiCad file rubber-bands, there being nothing orthogonal to keep.
2. **A wire end's stiffness comes from what it sits on.** On a *pin* (symbol or sheet) it is stiff: the wire keeps leaving along the pin's axis for one grid step. A *global or hierarchical label* is a port the same way — the wire keeps leaving the anchor back along the reading direction for a grid step; a *local label* gets no stub. On a *junction*, a T onto another wire, or a meeting of wires it is hinged: fixed in place, free to bend. *Dangling* it is free: it travels with its segment and any label rides along.
3. **Minimal change.** Walking a run out from the moved point: the delta along the first segment lengthens it; the delta across it slides the run's first existing bend; a wire whose far end is free translates. Only when none of that works is the run redrawn: a stub off the pin, then a straight line, an L (bending at a hinged far end, so a T onto a bus slides along it), or a Z between two pins — unless the pins face each other closer than two stubs, when the stubs are dropped. A wire that already left its pin sideways is slid as it is; a turned pin's wire is redrawn along the new axis. The one invariant: **a leg never runs back through the body it leaves or enters** — it tries the straight line and the two one-corner routes in preference order, and when none keeps the invariant it steps one grid to the side of the stub and runs along the body's flank.
4. **Risers nest.** Several redrawn Zs off one side of a part stagger their risers a grid step apart, the pin leading the motion farthest out.
5. **The result is a function of the final position alone.** `reshapeWires(geometry, movedPoints, {grid})` is pure. The drag preview calls it on every grid step with the cumulative delta from the original sheet, the editor calls it once at the drop, and `items.update` calls it with the delta to its target — all three agree, and dragging back restores the original wires exactly. It takes a map of pin landings rather than a delta so rotate and mirror ride the same code. Do not replace this with per-frame mutation.
6. **Never silently merge or split a net.** Each grid step rebuilds the sheet's connectivity on the previewed geometry (`previewMovedSchematic` + `netChanges`); a Drag group at the head of Properties says what the drop would do (*Joins A and B*, *Breaks A*, *Connects R1.1 to A*), warned for a join or a break, and the previewed wires paint red for a join or a break. The drop still commits.

**Cleanup.** Every command that touches a wire — drag, turn, wire commit, delete, and the agent's counterparts — runs `lib/schematic/wireCleanup.ts` over the **whole sheet** inside the same undo step: zero-length and duplicate wires go, collinear runs join where nothing else connects at the joint, and a junction sits exactly where three things meet, counted by distinct exit directions plus one per pin. Where the edit itself puts a point needing a dot on a wire's interior — a new wire through a pin, a pin or wire end landing mid-wire — the wire is broken there too, as KiCad's `AddJunction` breaks it; a pin that already sat mid-wire is left alone, since KiCad does not connect it. Whole-sheet because a rule that depends on where the last edit happened is one nobody can predict. A manual junction on a crossing is kept. Buses are tidied the same way on their own layer, as KiCad's `SCHEMATIC::CleanUp` takes both: a bus merges only with a bus, a dot on buses counts bus exits, a bus entry's end or a label naming a bus breaks a bus without adding an exit (so an entry tapping a bus takes no dot), and a dot touching a bus draws in the bus's color. Mechanism: ARCHITECTURE §3.11.

**Riders.** Labels and no-connects on a moved pin ride with it. A label or pin pulled off a pin it sat on directly takes a new wire along, arriving along the pin's axis — unless a wire still passes through that pin, in which case no second run is drawn. A flag, junction or wire end pulled off a pin just leaves it. A label at a dangling end rides with the end; a label mid-segment stays on its wire at the nearest point of the new run.

**Buses.** A moved bus is followed as a moved wire is: the buses joined to its ends stretch on their own layer (`busReshape`), a label naming a bus rides one, and a moved bus entry's ends are moved points for the wire and bus it joins. The bus tool finishes on a bus, a sheet pin or a label, as KiCad's `IsTerminalPoint` has it; an open bus end carries a dangling mark (a mark only; ERC's unconnected endpoint is the wire's).

**Mid-wire.** A pin or label on a wire's interior splits the wire under it and both halves follow, meeting at a junction. A wire end T'd onto the interior of a dragged wire rides it. Both are pre-passes in `reshapeWires` that turn the interior touch into wire ends and a moved point.

**Escape** abandons a drag, including a mid-drag turn and a sheet-corner resize (`ViewportEngine.cancelDrag`).

**Cost.** The reshape runs on every grid step (~2 ms on a 425-wire sheet); the net verdict's connectivity rebuild is linear in the sheet (~34 ms there), so it runs coalesced — at once while cheap, after 80 ms of pointer-quiet once a run has cost more than a frame. Nothing the user drags waits on the verdict.

**API.** `items.update` on a symbol reshapes the wires on its pins by default and answers with `wires: { followed, added, removed }` (plus the check delta with `checks: true`); `wires: "leave"` opts out.

## 7. Against KiCad

What Eeschema 10 has that this editor does not, checked against KiCad's toolbars, menus and actions (`eeschema/toolbars_sch_editor.cpp`, `menubar.cpp`, `tools/sch_actions.cpp`). An inventory of differences, not a plan: §3 and §4 are the committed work, and the approved gaps are in [kicad-parity-workstream.md](./kicad-parity-workstream.md). What every canvas lacks (grid and cursor options, measure, Properties) is in [BACKLOG.md](./BACKLOG.md#all-editors), once.

**Same job, another form.** Show hidden pins and fields are on the view rail. Bulk Edit Symbol Fields and Assign Footprints are the Components tab, whose Footprint cell opens the library chooser. Automatic annotation is not a switch: a placed part is always annotated (§1), and Annotate renumbers. Switch to PCB is cross-select and a split view rather than a button.

**Partial.**
- Line modes: wires and buses bend at 90° only (`/` turns the elbow); KiCad also has free and 45° (Shift+Space).
- Sheet pins: the tool offers the child's unmatched hierarchical labels one at a time; there is no Sync All Sheet Pins, and the auto-sync the research doc promises in its place (research §4.5) is not built either.
- Net highlight: hover lights the net under the pointer, and `` ` `` holds it lit by name, on every sheet, until `` ` `` on it or on nothing, or `~`; it cross-probes to the board. KiCad's `` ` `` on the same bus lights its members instead, a bus is not highlighted, and there is no click-to-highlight tool.
- Double-click enters a sheet; KiCad opens any item's properties.
- Find and replace has no results panel.
- Repeat's step and label increment are fixed (KiCad's repeat pitch and increment preferences).
- The hierarchy is the sidebar tree, not a dockable panel (Ctrl+H).

**Missing — placement.** Import Graphics (Ctrl+Shift+F); Import Sheet.

**Missing — editing.** Autoplace Fields (O); Select Node / Connection (Alt+3 / Ctrl+4); Swap (Alt+S), Swap Pins, Swap Pin/Unit Labels; lock / unlock; group / ungroup; next / previous net item (Tab / Shift+Tab); Edit Text & Graphics Properties; Edit Symbol Library Links.

**Missing — navigation and cross-tool.** Update Schematic from PCB (back-annotation); Diff Symbol with Library; Copy as Text, Paste Special; Print and Plot; the simulator (out of scope).

**Missing — view.** The page frame and title block on the canvas (the paper only sizes Fit); intersheet references on global labels; the Net Navigator, Search (Ctrl+G) and Design Blocks panels; ERC markers and their show-errors / warnings / exclusions switches ([BACKLOG.md](./BACKLOG.md#design-health)); pin alternate icons, show directive labels, show original pin numbers; selection and highlight thickness, netclass-color highlight, fill selected shapes; the cross-probe choices (center, zoom, flash, highlight nets); auto-start wires on unconnected pins and "mouse drag performs drag".

**Skipped on purpose.** The interactive delete tool, lasso mode, highlight-net as a toolbar mode and manual sheet-pin sync (research §4.5); an annotate-on-place switch (§1); a wire-angle preference and a junction switch (§6).

