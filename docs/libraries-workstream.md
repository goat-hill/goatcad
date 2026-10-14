# Libraries Workstream

Where symbol, footprint and 3D-model libraries come from, how they are indexed, how a person
picks a part, and how a placed part follows its library. Chooser visuals are in
[DESIGN.md §Choosers](./DESIGN.md#choosers); the index's code map is ARCHITECTURE.md §3.5.

## 1. Sources

**Three tiers, flat, not ranked.** Every library joins one searchable list.

| Tier | Symbols | Footprints | Writable |
|---|---|---|---|
| Project | `sym-lib-table` | `fp-lib-table` | yes |
| Global | `symbol-libraries.json` | `libraries.json` | if the path is |
| Standard | detected or downloaded | detected or downloaded | never |

- **A tier decides only two things:**
  - **Clashes:** which copy wins a nickname clash: project, then global, then standard. A copy
    embedded in the open document beats all of them.
  - **Writing:** authoring targets the project tier.
- **The standard tier is resolved on every launch**, never stored as paths. Config holds
  `standardLibraryProvider: 'auto' | 'downloaded'`.
  - `auto` adopts a detected KiCad install, or none.
  - `downloaded` uses the cache, and falls back to `auto` when the cache is gone.
- **The download** is GitLab tarballs of symbols and footprints, pinned to `KICAD_LIB_VERSION`
  (`main/kicadLibraries.ts`). 3D models are never downloaded (several GB); they come only from a
  detected install (`main/modelResolver.ts`).
- **Detection** checks known roots in order:
  - Linux: `/usr/share/kicad`, `/usr/local/share`, then Flatpak. Snap is not supported.
  - macOS: `KiCad.app/Contents/SharedSupport`.
  - Windows: `Program Files\KiCad\<10…6>`.
- **No wizard.** First launch detects silently; the Libraries panel offers Download when nothing is found.

## 2. Index

An in-memory index of every symbol, footprint and model, behind search, choosers, "used by" and
the agent's library reads. It needs no dependency: records, a JSON cache, a linear scan.

- **Records.** Each has type, lib id, name, library, scope and file.
  - Symbols add value, description, keywords, footprint, filters, power and pins.
  - Footprints add pads, `padNumbers` and model paths. A footprint is named by its file stem.
  - Each scope also lists its **libraries**, empty ones included.
- **Associations** are stored forward (symbol → footprint → model) and reversed on load (`footprintUsedBy`,
  `modelUsedBy`). Models match by `<pkg>.3dshapes/<name>`, extension dropped.
- **Scopes:**
  - **System and global** are built in a worker (`libraryIndexWorker.ts`) and cached in `userData/index/`.
  - **Project** is built inline from the project's tables, embedded symbols and placed assignments.
    It is memoized by mtime.
  - Queries union the two; **the project copy wins a lib id clash**.
- **Incremental.** A manifest of `{unit → mtime}` (a `.kicad_sym`, a `.pretty`, a `.3dshapes`)
  is diffed on launch, and only changed units are reparsed. ⟳ rebuilds fully.
  - `INDEX_SCHEMA_VERSION` and `EXTRACTOR_VERSION` each invalidate the whole cache. Bump the
    extractor's when it captures something new.
- **The renderer pulls.** A rebuild marks the index stale, and the next `loadIndex()` refetches,
  so call it where it's used. Derived caches watch the generation counter.
- **By nickname.** `loadLibraryView(projectPath)` answers library › part, project over app. ERC
  and DRC library rules read only this: a library absent from it is missing, and one listed but
  unreadable is unreadable.
- **Cost:** 30–40k records, a few MB per window. Search is a capped, debounced substring scan.

## 3. Chooser

One modal for every "which part?" (`shared/LibraryChooser.vue`). It takes a kind (symbol, power,
footprint), a title, a context and a verb, and returns a lib id.

| Opened from | Kind | Verb |
|---|---|---|
| Schematic `A`, chip, tool search | symbol | Place |
| Schematic `P` | power | Place |
| Change symbol | symbol | Change |
| Footprint row's or Components cell's Browse | footprint, fit to the symbol | Assign |
| PCB `A`, chip, tool search | footprint | Place |

- **Libraries are the tree, as in KiCad.**
  - Pinned groups come first: *In this design*, *Recent*, and *Fits symbol*.
  - Then one group per library, shut until a search opens the best matches.
  - There are no filters.
- **Fits symbol:** the symbol's `ki_fp_filters` match, and its distinct pad numbers equal the
  symbol's pin numbers.
- **Previews** are the real read-only renderers, in fixed slots: symbol, then its footprint in 2D
  and 3D, then details.
  - A footprint previews with the part's reference, not `REF**`.
  - A symbol's footprint is a dropdown: its own, then the design's, then filter matches.
  - **Pin map:** assigning a footprint lists pins with no pad and pads with no pin.
- **Fast.** Lists are built once per index load, on idle (`libraryChooserIndex.ts`).
  - Each keystroke filters once.
  - An open group renders at most 200 rows.
  - Only the highlighted row's preview parses a file.
- **Property-row buttons:**
  - Footprint: Browse and Open.
  - Datasheet, or any link: Open, to the browser or the app's PDF tab.

## 4. Place footprint (PCB)

`A` opens the chooser, and the pick arms the tool.
- **Placing:** the footprint follows the snapped cursor, R turns it, and a click lands it. The tool stays armed.
- **Built** from the library file, as board sync builds one (`boardSync.ts`).
- **Annotated** with the next free reference (`H`, `TP`, `FID`…; `lib/board/footprintPlace.ts`).
- **Board-only:** it is marked `board_only`, so sync and schematic parity leave it alone.
- **Agent op:** `board.place_footprint` runs the same code.

## 5. Placed parts: update, change, edit

The properties panel's **library section** (`LibraryLinkSection.vue`) shows how the selection
stands against its library (`librarySync.ts`) and offers four actions:

| | Schematic | Board |
|---|---|---|
| Refresh | Update from library… | Update from library… |
| Swap | Change symbol… | Change footprint… |
| Pencil | Edit symbol… | Edit footprint… |
| Book | Edit library symbol… | Edit library footprint… |

- **Matching.** A footprint is compared as DRC's library parity compares it. A symbol is compared
  more strictly than ERC's rule (`libSymbolMatches`), so an edited copy never reads as matching.
- **Update and Change are one sheet** (`shared/PartUpdateDialog.vue`), as in KiCad.
  - **Verb:** the button sets it; there is no switch in the sheet.
  - **Part field:** editable, with Browse. Under Update, each part keeps its own until the field is edited.
  - **Scope:** KiCad's. The selection, a reference, value or lib id pattern, or everything.
  - **Reset checklist:** KiCad 10's, every option. Reference and Value are unticked by default.
    What it was left with is kept per kind and verb, as KiCad keeps it
    (`lib/partUpdatePreferences.ts`).
  - **Preview:** each part's outcome is shown before Apply, and the whole run is one undo step.
- **One footprint swap underneath** (`footprintExchange.ts`).
  - It keeps placement, reference, value, fields, and nets by pad number.
  - It reports pads that lose a net.
  - Board-only, DNP and exclude-from-BOM survive.
  - Update, Change, sync and `board.update_footprints` all use it.
- **Change on the board changes the board only**, as KiCad's does. A symbol-owned footprint's
  Footprint field keeps naming the old one, which the preview says; the next Update PCB from
  Schematic puts that one back. The agent refuses the case instead, pointing at the schematic.
- **Edit opens the design's own copy** (`lib/designCopy.ts`), in a tab at
  `design-copy://<kind>/<file>/<id>`. Edits write back to the design file, which holds the undo
  and the save. The library is untouched. Edit library opens the library file.

## 6. Open work

**For launch:**
1. **A missing standard tier** should be said where it bites: the welcome screen, empty
   choosers, and the agent's `list_*_libraries` (MILESTONES step 4).

**After launch:**
- **Chooser:**
  - a `model` kind (the footprint editor's 3D model) and the symbol editor's default footprint;
  - pinning the chooser into the rail, with drag to place;
  - binding a part from Part Search;
  - pad labels in the preview.
- **Symbols:**
  - multi-unit placement (units listed and placed in sequence, "Place remaining units");
  - a body style switch;
  - footprint variants (`…_Pad_Via`) grouped or flat (undecided).
- **Labels:**
  - a source caption in the footprint chooser;
  - the resolved standard-library version.
- **Index:**
  - `footprintUsedBy` doesn't tell suggested from used;
  - user and project 3D models aren't indexed.
- **Packaging and platforms:**
  - `.deb` `Recommends: kicad-symbols, kicad-footprints`;
  - verify the macOS and Windows install roots.
