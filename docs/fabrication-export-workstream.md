# Fabrication Export Workstream

Manufacture mode turns a board into a fab package: Gerber X2, Excellon drill, BOM CSV and
pick-and-place (CPL) CSV, previewed together and written to a folder plus a zip. Roadmap context:
[MILESTONES.md](./MILESTONES.md) step 2 (the manifest); the `export.*` ops are owned by
[agent-api.md](./agent-api.md).
Mechanics are in [ARCHITECTURE.md](./ARCHITECTURE.md). This doc also owns the Gerber viewer's
open work.

## What exists

- **The surface** — `ManufactureView.vue`, a per-board tab (`goatcad://manufacture/<board path>`,
  `lib/tabs.ts`): the left rail selects an output, the right pane configures and previews it, the
  footer exports the package. It opens only from the PCB properties panel's **Fabrication outputs** button.
- **Writers** — `lib/gerber/write.ts` (X2, silk clipped to mask openings and the outline, via
  tenting, custom pads), `lib/gerber/drill.ts` (Excellon, PTH/NPTH merged or split, slots as
  `G85`, tools labeled with KiCad's X2 drill attributes),
  `lib/gerber/fabPackage.ts` (KiCad or Protel names, a minimal `.gbrjob`), `lib/fabBom.ts` +
  `lib/bomCsv.ts`, `lib/fabCpl.ts`, run per file kind by `lib/fabExport.ts`. All pure; only the
  disk write crosses the bridge (`fab:export`, with a dependency-free zip in `main/zip.ts`).
- **Previews** — generated Gerbers render through our own parser (`GerberPreview.vue`); BOM as
  the table it will serialize; CPL as the assembled board seen straight down (`CplPreview.vue` over
  `engine/board3d/cplViewport.ts`: the 3D board through an orthographic camera, dimmed, one side at
  a time with the back turned over) beside the placements listed by side. Parts sit faded until a
  row or a part is hovered or clicked (a click keeps it); the part then shows whole with a pip at
  its centroid, a line along its rotation and its coordinates as the CSV writes them. The position
  file's origin is marked, or pointed to from the edge with its distance when off the view.
- **Export profiles** — `lib/exportProfiles.ts`, the writers' arguments per output with the fab
  pages they come from and a `todo` of what none confirms: JLCPCB, OSH Park (bare boards: Gerbers
  and drills) and Generic (writer defaults, which follow KiCad's). CircuitHub, the launch house, has none
  yet (MILESTONES, What's left #5).
- **Part numbers** — `resolvePartNumber` (`lib/fabBom.ts`) reads the profile's column through an
  alias list per kind (MPN canonical, LCSC an alias family), falling back to the other kind.
- **Pre-flight** — `lib/fabPreflight.ts`, pure `(board, profile, DRC findings, BOM, drill hits) →
  findings` grouped blocking / to review / passed: the outline; the board's DRC errors and
  warnings; zones never filled; drills and hole spacing against the manufacturing profile of the
  export profile's house (the tier matching the board's copper count); part numbers and values.
  The Manufacture tab runs DRC itself on the saved board, with the footprint libraries the board
  editor loads, since it has no editor session, opens on
  the checklist, shows a verdict beside Export, disables Export only while something blocks, and a
  row's **Show on board** opens the board with what it names selected (`reveal-in-document`).

## Decisions that govern

- **Every output comes from the one `.kicad_pcb`**, the BOM included, so an unsynced schematic
  never changes what ships.
- **Generic core, profiles on top.** A profile is data: the writers' arguments per output and
  notes for the person or agent ordering. It is never a second exporter; adding a fab is a new
  profile document.
- **Export profiles are separate from Board Setup profiles** — same manufacturers and UX,
  different data ([board-setup-workstream.md](./board-setup-workstream.md)). Changing the export
  profile never changes design rules.
- **Inform loudly, block rarely.** Only an un-manufacturable state (no closed outline) blocks
  export; everything else is a review item.
- **Files you own:** `./fab/` beside the project plus a zip. No hosted upload.
- **CPL emits standard KiCad centroids and rotations**; per-fab rotation remap tables are out of
  alpha, and the CPL preview says so.
- **A missing geometry engine degrades** to unclipped silk with a layer warning, never a failed
  export.

## The export ops

Three layers (agent-api.md). Code holds the deterministic path; what a fab wants is
data; judging a fab's quirks is the agent's.

1. **Writers, one per file kind, no manufacturer argument** (`export.gerbers`, `export.drill`,
   `export.bom`, `export.positions`; `main/ops/export/`). Their arguments describe the format,
   named after `kicad-cli pcb export` where the two overlap, and the types are
   `preload/fabTypes.d.ts`. A BOM's headers are written as given, never translated.
2. **Profiles as data** (`export.profiles`). A setting a built-in makes cites the fab's page; what
   no page confirms stays at the writer's default and is listed under `todo`.
3. **`export.package`**: a profile (by id, any output replaced) through the pre-flight and the
   writers, zipped as it says. The Manufacture tab's Export runs the same `exportPackage`.

Every export writes the saved file into a folder the call takes (`fab/` beside the board), answers
with paths, sizes and summaries, and is refused while the board's tab has unsaved edits or stale
zones (`lib/fabExportAgent.ts`). A board saved stale with its tab since closed cannot be told apart
yet (pcb-editor-workstream.md, fill freshness).

## Open work

1. **Pre-flight, the rest** — footprints the schematic does not know (no `(path …)`), and an
   export profile whose house differs from the board's setup profile (waits on item 6). And say
   what each row holds the board to, which reads today as DRC repeated: Drill sizes and Hole
   spacing are the export house's limits (JLCPCB's 0.2 mm hole-to-hole beside the board's own
   0.25 mm), Zone fills is zones never filled (no DRC rule), Board outline is DRC's
   `invalid_outline` lifted out because it alone blocks. Proposed, not yet decided with the
   maintainer: name the house in its rows ("JLCPCB drill sizes") and group the page as Design
   rules / what the house can make / Parts. Also a **via-in-pad** row: a via inside a same-net
   SMD pad, held to the house's policy (exposed and thermal pads exempt, a filled or capped via
   exempt). KiCad's DRC has no such rule, so it is the house's check, not DRC's.
2. **Reproducibility manifest** — a `manufacture.json` in the package naming the profile and app
   version that produced it.
3. **Part-number override and audit** — a per-project "which field is the part number" setting
   for when the alias list finds none or several, and the missing-number finding with a jump to the
   Components table row.
4. **Plot fidelity**, held to `kicad-cli` by `./bin/test-parity` (`gerberExport.parity.test.ts`,
   `PARITY_BOARDS=demos:qa`): every board KiCad loads matches but for the differences its `KNOWN`
   list records, each with its reason. Open, in the order it matters:
   - Blind and buried vias go in the through-hole drill file; KiCad writes a file per span.
   - Barcodes (QR, DataMatrix) are not plotted: they want an encoder, a dependency request or
     our own (RULES.md §4).
   - The `KNOWN` entries marked "cause not yet found": a stored inner-layer fill kicad-cli plots
     less of, a legacy rotated table, bold text-box text a few hundredths off, custom-mode
     padstack mask margins, a leader dimension with empty text, and the Allegro-imported VCU118
     board's silk.
   - `aux_axis_origin` and `pcbplotparams`, which make our Gerbers comparable to a KiCad export
     the user configured; `TO.N` net attributes.
   - Text-box and table text resolves no `${…}` yet; board and footprint text does.
5. **A CircuitHub profile.** CircuitHub imports the KiCad project (`.kicad_pro`, every
   `.kicad_sch`, the `.kicad_pcb`) and generates its own fab data; Gerbers alone are refused
   (docs.circuithub.com, "Files required for import" and "KiCad support"). Its package is the
   project files, plus an optional CSV/TSV BOM keyed on `MPN` or `ManufacturerPartNumber`, so the
   profile is outputs the writers do not have yet. Then the profiles' `todo`: the Gerber netlist
   attributes JLCPCB's guide enables (the writer has no `TO.N` yet, item 4). The Manufacture tab
   does not show a profile's `todo` yet.
6. **Default the export profile to the board's setup vendor.** `exportProfileForVendor` exists;
   `ManufactureView.vue` calls it with no vendor, so the picker always starts on JLCPCB.
   The board's setup profile is where the design's limits live, and layout (`board.fanout`
   included) works to it. Pre-flight should not find limits the board was never set up with:
   0.15 mm drills the CircuitHub setup profile allows must not be flagged against JLCPCB's 0.2 mm.
7. **CPL from the drill/place origin.** `fabCpl.ts` writes sheet coordinates with Y negated
   and no writer reads `auxOrigin`. KiCad's position export
   defaults to that origin; Gerbers' `aux_axis_origin` (item 4) is the same setting.
8. **User export profiles** — `deriveExportProfile` forks and nothing persists the result; shares
   the store Board Setup's user profiles need.
9. **Drill map** — after alpha.

### Gerber viewer

- Show an opened fab set's holes: `lib/gerber/excellon.ts` reads a `.drl`, but the viewer does not
  load one yet (only our own drill output previews, through a synthetic Gerber).
- Open a `.gbrjob` as the set's entry point: exactly the job's files, in the job's layer order.
- Hover readout: D-code, aperture shape and size under the cursor.
- Parser approximations that warn today: macro exposure-off erases the layer rather than the
  flash; `%AB` aperture blocks are skipped; rectangular-aperture draws use round caps.
- Out of alpha: revision diff, measure, net highlight from `TO.N`.

Out of alpha: IPC-2581 / ODB++; JLCPCB rotation remap; panelization, fab and assembly drawings,
variants; hosted ordering; fabs beyond CircuitHub, JLCPCB, OSH Park and Generic.
