# Format Migration Workstream

Open every KiCad version, save only the current one (10), migrate an older file on its first save, and
open a newer one read-only. The rule is RULES.md §7; the version table, what changed, what the
migration must do and the equivalence bar are in
[references/kicad-format-spec.md](./references/kicad-format-spec.md#versions-we-read-and-write); how
the app does it is ARCHITECTURE.md ("KiCad versions: migrate on read, upgrade on save").

## Where things stand

Built: every format migrates (`lib/kicad/migrate.ts`) and is held by the parity harness
(`lib/__tests__/formatMigration.parity.test.ts`) on every supported file in KiCad's `qa/data` and
`demos` bar the large designs below; files migrate on read and upgrade on save, project file and
`.kicad_prl` included; newer and pre-KiCad 6 files open read-only with a notice; writers and new-file
templates speak KiCad 10 alone.

The harness runs one comparison at a time, removes what it stages, and skips the directories in its
`SKIPPED` list; the whole corpus takes about six minutes and a few GB at peak (`PARITY_MIGRATION`,
`PARITY_MIGRATION_FORMATS`, `PARITY_REPORT`, `PARITY_JOBS`). Schematics before 20230221 are judged
in two parts, since `sch upgrade` skips the fixups KiCad runs on open: those by netlist, the rest at
file level against KiCad's upgrade of the original with the fixups applied.

## Open work

1. **Large designs** the harness skips (its `SKIPPED` list): KiCad's `issue23020` stress test
   (`qa/data/eeschema/issue23020/`, an 18-sheet 9 MB hierarchy — `kicad-cli` alone passes 8 GB on
   it), and the demos' 85 MB and 70 MB boards and 12–21 MB hierarchies (jetson, vme-wren), qa's 29 MB
   vme-wren and the 48 MB VCU118 board. Discuss with the maintainer before approaching them.
2. **Board-only projects** get no project-file migration: the fill is what KiCad's schematic editor
   writes, and a board's own sections are the board editor's, which no step fills yet.
3. **A pre-KiCad 9 board's `.kicad_prl`** is rewritten in the new layer ids only when the board has
   been viewed this session (its layer table is what the rewrite reads).
