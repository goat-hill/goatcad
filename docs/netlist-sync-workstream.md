# Schematic ↔ Board Sync Workstream

The bridge that makes a schematic and a board one design. Roadmap context:
[MILESTONES.md](./MILESTONES.md) — the engine, its entries and the board's drift ship; the open
work below is not on the milestone.

## What exists

- **Forward sync** — `lib/board/boardSync.ts`, pure, split into a planner and an applier.
  `planBoardSync` returns `{ add, update, unchanged, orphans, skipped, footprintChanged, nets }`;
  `applyBoardSync` writes it. UUID-keyed, non-destructive on re-sync (placement and routing are
  kept), new footprints staged in rows below the outline, orphans pruned only on request, a part
  that cannot land is skipped with a reason and the rest still applies.
- **Two callers:** the MCP verb `board_sync` (`lib/board/boardAgent.ts`), with `dryRun` for the
  plan, and Update PCB from Schematic… (F8; File on a schematic or board; the board's Properties
  panel with nothing selected), which lists the plan in `UpdatePcbDialog.vue` and applies it
  through the same door. Both refuse a schematic with unannotated parts (`R?`), as KiCad's
  netlist does: parts are keyed by reference, so two would sync as one. Both take KiCad's Replace
  footprints, Delete footprints with no symbols and Update footprint fields (`scopePlan`;
  `replaceFootprints`, `prune`, `updateFields`); re-linking by reference happens only for a
  footprint with no link, and groups, design blocks, locks, removing extra fields and the log's
  filters and Save are out of scope. The dialog names the schematic and board it reads and
  writes, and tables the footprints added, not in the schematic and updated — reference, value,
  footprint and what changes; bookkeeping (sheet names, links, pin types) is applied, not listed. When
  the board's tab is open the sync runs through that board's session (`ctx.editOpenBoard`) and is
  one undo step labeled `commandLabels.boardSync`; with no tab open it lands as text in a new
  dirty tab.
- **Drift** — `lib/board/syncDrift.ts`: DRC's schematic-parity findings, so a board is out of
  date on exactly what KiCad's `--schematic-parity` flags, and bookkeeping an update also
  rewrites (sheet names, pin types) never raises it. The board editor reads the root sheet's live
  design without a tab, again a moment after any schematic changes, and hands its netlist to its
  checks. The Properties panel's Update from schematic, always shown with nothing selected,
  carries the footprints to add, not in the schematic, and to update (green, red, yellow) and
  shows Not annotated when the schematic has unnumbered parts.
- **Netlist export** — File ▸ Export ▸ Netlist… writes KiCad's `.net` from the same parts and
  connectivity (`lib/schematic/netlist.ts`, ARCHITECTURE §3.11).
- **Cross-probe** — `lib/crossProbe.ts`: selecting a part in the schematic, the Components table
  or the board selects and reveals it in the others, across splits and windows.

## Rules that govern the open work

- **Two KiCad files, one design in memory.** No combined format; continuity is a runtime property.
- **Identity is the UUID path, never the reference.** A board footprint's `(path "/<sheet>/<symbol>")`
  is the sheet-instance path with the root sheet's uuid omitted, plus the symbol's uuid.
  Re-annotation never scrambles the mapping.
- **The schematic owns existence and connectivity; the board owns the physical.** No net editing
  from the board.
- **Drift is shown live; apply stays explicit.** No auto-apply.
- **New footprints never arrive in a pile** — staged by sheet, outside the outline.
- **Read the schematic as KiCad's netlist reads it** — the plan, the netlist export and DRC's
  schematic parity share it: a field named like a mandatory one in any case is that field, and
  mandatory fields are trimmed; a pre-20250318 `~` is empty in every field; a field the placed
  symbol lacks is empty, never its library symbol's; a stacked pin (`[6,7,9-11]`) is a node on
  each of its pads, its net named for the smallest.
- **Write KiCad's exact shape** for the link, fields, flags and pad nets (by name in KiCad 10
  files, by number against the `(net N "name")` table before it), so KiCad can re-sync the board.

## Open work

1. **Net renames** — KiCad moves a zone or stitching via onto the new name of the net its pads
   took (`board_netlist_updater.cpp`, `m_oldToNewNets`). The planner does not follow a rename;
   check what a renamed net leaves on zones, vias and tracks.
2. **Locks** — KiCad neither replaces nor deletes a locked footprint without Override locks;
   ours does both.
3. The netlist export still writes a stacked pin as one node, where KiCad writes one per pad.

Out of alpha: the board's drift on the schematic's pill (the board's own pill counts it); bus
netting (a net KiCad joins only through a bus splits here); back-annotation
(reference / value / footprint at most, when it comes); proximity-seeded placement; selective apply.
