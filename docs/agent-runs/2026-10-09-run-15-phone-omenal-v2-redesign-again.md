# Run 15 — phone-omenal v2, the board redesigned again from the schematic (2026-10-09)

**GoatCAD:** `goatherd-dev` ≈ `ac1c1052` (run 14's fixes: one viewport per connection, sessions
that land what was clicked, per-arrival ids, undo and redo, fanout held to the edge, tracks that
follow a move, the large-answer cap). Verdict key and rules: [README.md](./README.md).

**Ask.** Ad hoc: redesign the phone-omenal v2 PCB from scratch using only the schematic, with
GoatCAD's APIs and the editor's router, and record a time-lapse
(`phone-omenal/v2/timelapse/pcb-redesign-timelapse.mp4`). The agent's report is
`phone-omenal/v2/goatcad-mcp-feedback.md`. It isn't run-numbered, and it has no separate "Seen in
the app" section. Items 27 and 28 relay what the person said about the renders and the viewport
label, so they are triaged as the person's requests.

**Reached.** Routed. 40 silk-over-copper and 37 silk-overlap findings before the agent's own
reference-placement script; DRC errors in the stock USB-C footprint's hole clearance (runs 11–14).

**Headline.** Run 15 found two parity misses that the earlier verdicts had wrong. Both were checked
against the local KiCad 10.0.6 source:
- **KiCad's Route Selected finishes only along the selected item's own ratsnest lines**
  (`pcbnew/router/router_tool.cpp:1840-1866`). Ours finishes from a pad to the nearest copper of
  any other cluster of its net, measured from that pad. A pad already joined to its net through a
  big cluster then routes to whichever far island is nearest. That one cause explains all of
  item 10's long, necked detours. The length caps stay declined; following the ratsnest removes
  the cause.
- **KiCad's router snaps to the start point's axes.** Routing sets
  `SetAuxAxes(true, m_startSnapPoint)` (`router_tool.cpp:2107`), and `GRID_HELPER::Align`
  (`common/tool/grid_helper.cpp:461-477`) takes the start's x or y whenever it is nearer than the
  nearest grid line. Run 14 declined start-axis snapping as "a rule the GUI and KiCad don't have".
  That was wrong, and it is why every off-grid pad exit has a jog (item 26, run 14's U3).

The rest are setup and resolution bugs (1–5), a stale-fill blind spot in fanout, and doc gaps.

Verdicts were checked against the code at `ac1c1052`. Paths are relative to `electron/src`; BA =
`renderer/src/lib/board/boardAgent.ts`, RA = `…/routeAgent.ts`, RC = `…/routeController.ts`, AC =
`…/router/autocomplete.ts`, FO = `…/fanout.ts`, BS = `…/boardSetup.ts`.

## What the person said (relayed)

| Finding | Verdict |
|---|---|
| 27. `render_board` frames "don't even look like GoatCAD": KiCad's palette, not the canvas's. | **Palette: not the cause.** The capture applies the app's theme exactly as the canvas does (`engine/boardCapture.ts:133,170`, `BoardScene.ts:829-830`). The canvas palette is KiCad's hues with retuned lightness (`lib/theme.ts:9-62`). **The look: open.** A time-lapse frame shows the real difference: the capture draws every layer at full strength with no active layer (`boardCapture.ts:126-151` passes no display options), so both inner-plane fills at `ZONE_FILL_ALPHA` wash brown over the whole board. The canvas dims non-active layers (`BoardScene.ts:136`, `nonActiveDisplay`). Item 25 is the same complaint. Proposed: render with the canvas's own default display, the one a person sees opening the board, not the person's live view state. |
| 28. The box said "Board redesign" all session; it should say what is happening now. | **open.** The label changes only through `viewport.open` (`agentViewports.ts:282-296`), and the guidance never says to relabel (`main/ops/viewport/open.ts:139-141`). Every render and layout write goes through `framed()` (`agentViewports.ts:333-348`); routing updates through `publishRoute` (BA:2950). Main's `buildRequest` (`main/ops/registry.ts:196-205`) has the op name for every request. Proposed: an optional `label` beside every `viewport` argument, and an automatic second line naming the current op and its subject. |

## Routing

| Finding | Verdict |
|---|---|
| 10. `route_finish` landed 51.6 mm necked to 0.127 mm from L1.2 to a far +3V3 island past the joined C4.1 2 mm away; likewise U3.21 (94 mm), C20.2, SW2, U7.4. Asks `maxLength`, a detour ratio, `allowNeck`, `to`. | Caps: **declined** (runs 13, 14; `length` and `necked` are answered, RA:467-486). The cause is item 11. |
| 11. Finishing from an island next to well-connected copper goes to another island far away. | **bug** (parity). The target is `nearestUnconnectedAnchor` from the start pad over every other cluster (RC:898, AC:43-55, 175-189), and a start is skipped as `joined` only when the whole net is (RC:253-273). KiCad's `RouteSelected` routes each anchor of a ratsnest edge whose end is the item (`router_tool.cpp:1840-1866`) and does nothing for an item with none. Fix: finish along the start's own ratsnest edges (`spanningPairs`, `boardConnectivity.ts`); a pad with none is skipped `joined`. Steered F mid-route is unchanged. |
| 12. A blocked via click in `route_preview` answered `"nothing"`, `blockedBy: null`, no violations. | **bug**, minor, not reproduced. `refuseVia` names violators only with `ref.index >= 0` (`router/engine.ts:581`). In Push mode the pair it hit lives as shove-world copies with `index: -1` (`router/shove.ts:1383,1405`), and marks without an id are dropped (RA:717-721). Keepouts and the board edge are never named either. Fix: map copies to their source id; answer an unnamed blocker by kind (keepout, edge). |
| 13. Via gestures are easy to misuse; asks `{via: {to, at}}`. | **as designed** (R21, R24; one action per gesture, RA:214-226). The new shape: **declined** (the GUI has none). **Doc bug:** `route.step`'s example "click a corner, then arm a via" (`main/ops/route/step.ts:31-33`) leads straight into the end-the-route case. Show `[{at}, {via:{}}, {click:true}]` and say how to drop a via at a point. |
| 14. A routing session belongs to one connection. | **as designed** (the session lives in its connection's viewport, BA:2836-2847, 3158). **Doc gap:** `app.scripting` says nothing (`main/ops/app/scripting.ts:23-24`). |
| 26. Off-grid pads leave kinks; asks the grid from the start pad, or the pad's axis kept. | **bug** (parity), reversing run 14's decline. KiCad's aux axes at the route start (above). Our snap is grid-or-copper only (RA:634-659, GUI `PcbViewport2D.vue:976-990`). Fix in the shared snap, GUI and agent: while routing, a snapped coordinate takes the start point's x or y when it is nearer than the grid line. Jog reporting and smoothing: **declined** (run 14 B3; this removes the cause). |

## Projects and setup

| Finding | Verdict |
|---|---|
| 1. `bom_get` refuses `no-document` with no schematic open in a one-schematic project. | **bug**, logged in run 13 and still open. Every sheet-door request resolves through `resolveAgentSheet` (`App.vue:2858-2873`, `schematic/schematicAgent.ts:421-441`): the active or only open schematic tab, else refused. Board ops fall back to the project's board (BA:679-701). `rootSchematicPath()` (`App.vue:2386-2398`) already picks the sheet named after the project, else the only one. Fix: fall back to it for every schematic op (`App.vue:2858`, `:2125`). |
| 2. A copied board under `backup/manual/` makes every board op `board-ambiguous`. | **bug** (parity). Boards come from a recursive walk of the workspace tree (`App.vue:2369-2380`, `main/index.ts:443-478`). KiCad's project board is `<project>.kicad_pcb`. Fix: with several boards, use the one named after the project and refuse only when none is (BA:693-700, `fabExportAgent.ts:154-160`). Skipping `backup/`: **declined** (a guess about folder names; GoatCAD writes no backups). |
| 3. `profile.active` stays `circuithub-2l-1.6` after applying `circuithub-4l-1.6`. | **bug**, in the GUI too. `active` is recomputed by `identifyProfile` (BS:280-282, `manufacturingProfiles.ts:409-413`), which compares rules and Default only; the two CircuitHub profiles share both (`:303-343`), so 2L always wins. Fix: match the copper count too (`stackupSpecOf(board)`), in BS and `PcbEditor.vue:6462,6503`. |
| 4. A profile `dryRun` doesn't show the constraints and Default class it would replace. | **bug** against the op's own text ("before holds every replaced value"). The profile branch replaces the rules wholesale and Default's four values (BS:757-765) but records only the stackup (BS:748-779). Fix: record the replaced constraints and Default values in `changed` and `before`, on the dry run and the write. |
| 5. `netClasses.matched` lists nets that don't exist. | **bug**. `matchedNets` reads `board.nets` (BS:211-230), and each session re-parse seeds the net list from the previous one (`kicad/board.ts:465-475,888`), so renamed or dropped nets stay for the session. Fix: match only nets something on the board uses, the set `applyBoardSync` builds (`board/boardSync.ts:1303-1317`), as a shared `netsInUse(board)`. |
| 6/24. No way to count items for `items_delete(expect)`; no clear-board. | **not a gap.** `items_query` answers `count` as the total of all matches (BA:1473-1490, `queryPage.ts:62-69`), so `limit: 1` reads it; `items_delete {kind, expect}` deletes a kind. **Doc gap:** the query guidance doesn't say `count` is the total (`main/ops/items/query.ts:49-50`). |
| 9. Check codes take dashes; `courtyards_overlap` is refused. | **as designed** (run 12). The refusal names `courtyards-overlap` (`schematic/checks.ts:906-926`). Accepting both: **declined** (an alias). |

## Edits, footprints and fanout

| Finding | Verdict |
|---|---|
| 8. `items_query(footprint="U3", kind="zone")` is refused; footprint rule areas can't be read. | **open.** The model keeps footprint zones (`kicad/footprint.ts:91,966`), and DRC keepouts and the filler use them (`board/keepouts.ts:77`). The footprint item kinds leave them out (`footprint/footprintItems.ts:58-68`, `main/ops/items/query.ts:206-211`). **check:** the board canvas draws only `board.zones` (`BoardScene.ts:1440,4446,4832`); KiCad draws footprint zones. Fix: a read-only footprint `zone` kind; draw footprint zones on the board if the check confirms. |
| 15. A track to a via made earlier in the same batch: "Name the net: no end is on a pad or via". | **bug**. The batch does apply entries in order (BA:1969-1979). A bare point is an anchor with no net, even when it sits on a pad or via (`boardItems.ts:1669-1703`, `:1675`); only an id string resolves. Fix: a point on a pad's or via's copper on the track's layer takes that item's net, as connectivity would join it; two nets there is refused. The workaround is the via's id from the earlier entry. |
| 16. Deleting a later route's `updated` ids cut an earlier route. Asks `dangling` on deletes. | **Doc gap.** `changed.updated` are existing tracks the landing reshaped (BA:2884-2900); a route's own copper is `arrived[].created` (BA:3474). The guidance doesn't say so (BA:3494-3496). `dangling`: **declined** (`checks: true` answers `track-dangling`, `boardChecks.ts:71`). |
| 17. A footprint record's pad rows have no size or shape. | **open**, small (records first). Rows are `{id, number, net, at, layers}` (`boardItems.ts:723-735`); `items_query`'s pad row has `angle` and `box` (`:597-605`), and `items_get` on a pad has shape and size (`:738-760`). Add `angle` and `box` to the footprint's pad rows. |
| 18. Fanout dry runs per footprint don't add up to the real run. | **open.** `board.fanout` plans one footprint (`main/ops/board/fanout.ts:22,37`, BA:2010-2062), and `board.batch` doesn't take it (`main/ops/board/batch.ts:53`). Fix: fanout as a batch entry, so one batch dry run plans each footprint against the ones before it. A `footprints` list: **declined** (the batch already does it). |
| 19. Fanout skipped pads as `joined` through a stale fill; after a refill they were unconnected. | **bug** against "a skipped step stays findable". Joined reads stored fills (FO:38, 651; `boardConnectivity.ts:155-209`) with no stale check, and the skipped row says only `joined` or `via` (FO:678-696). Fix: a `joined` or `via` row whose join goes through a stale fill says so. `viaEvenIfZoneJoined`: **declined**. |
| 23. `board_undo` takes `viewport` when the step only deleted copper. | **as designed** (run 14: a step can move anything; a delete is a layout edit too). |

## Checks and renders

| Finding | Verdict |
|---|---|
| 20. `hole-clearance` findings have null `measured` and `required`. | **Doc bug.** Both emitters set `measure` (`drc/rules/holeClearance.ts:61-78`, `drawingClearance.ts:166-186`); a finding carries `measure {actual, limit, …}` (`schematic/checks.ts:875-889`). `board.check`'s guidance says "measured vs required" (`main/ops/board/check.ts:17`), and no field has those names. Name the real keys. |
| 21. `board_check(codes)` with zero findings omits `findings`. | **bug**, minor. The clean row is `{code, count: 0, items: [], rule}` (`schematic/checks.ts:958-975`). Add `findings: []`. |
| 22. A "tidy references" op. | **declined** (runs 13, 14). |
| 25. Whole-board renders are muddy; asks a presentation preset. | Preset: **declined** (2D renders take no style options). The look is item 27's fix. |
| 7. A viewport a script opens closes when the script exits. | **as designed. Doc gap:** `app.scripting` doesn't say so, or that a viewport id from MCP works in a script (`main/ops/app/scripting.ts:23-24`; the client's docstring alone says it, `main/ops/pythonRuntime.ts:419-424`). |

## Asks the rules turn down

| Ask | Why not |
|---|---|
| `maxLength`, detour ratio, `allowNeck`, a `to` target for `route.finish`. | Runs 13, 14: heuristics the GUI doesn't have. Following the ratsnest (item 11) removes the cause. |
| `{via: {to, at}}`. | No GUI gesture. The doc fix shows the three-gesture idiom. |
| Ignore a `backup/` folder. | A guess about folder names. The KiCad name rule decides instead. |
| `countOnly`, a `kind: "all"` delete, a clear-board op. | `count` is already the total, and a delete by kind exists. |
| Accept underscore check codes. | An alias; the refusal names the code (run 12). |
| A `dangling` list on deletes. | `checks: true` answers it. |
| Jog reports and smoothing. | KiCad doesn't (run 14 B3); start-axis snapping removes the cause. |
| A reference-placement op. | Runs 13, 14: judgment. |
| A presentation layer preset. | No style options on audits; the default look changes instead (item 27). |
| Undo without a viewport. | Run 14. |

## Earlier verdicts, re-checked

- Run 14's U3 / "snap along the pad's axis": declined on a wrong premise; reopened as item 26.
- Run 13's `bom.get` with only a board open: still a bug (item 1).
- Run 14's per-arrival ids and large-answer cap: used; no friction reported.

## What held

Per the agent:

- `route_preview` with renders for steering buses: the 4-line I2S bus and the SDA layer hop landed
  first try.
- `board_check` with `codes`, and findings that carry item ids.
- `gc.transaction(...)` for one-step placement batches.
- The `fix` text on refusals.

## Decisions (2026-10-09)

The maintainer decided each item on the [review page](https://claude.ai/artifact/6vciCGDVE5AFXLpNaHC8Xt).
Where a decision differs from a verdict above, the decision stands.

| Item | Decision |
|---|---|
| A1, renders (27, 25) | **Discussed, then decided:** `render_board` draws zone fills off by default (outlines only; `fills: true` pours). `layers` or `preset` is required, exactly one. Optional `activeLayer` draws on top, and `dim` sets the other layers' strength. This replaces "2D renders take no style options" for `render_board`. |
| A2, the box label (28) | **Discussed, then decided:** no new UI. Every call that moves the box (renders, layout edits, routing, undo/redo, batches once) takes a required short `action`, shown as the box's label in place of the last. `viewport.open`'s label is the first one. |
| B1, Attempt Finish follows the ratsnest (10, 11) | **Approved.** |
| B2, start-point snap axes (26) | **Approved.** |
| B3, naming a via's blocker (12) | **Declined:** too minor. |
| B4, the via example and scripting lines (13, 14, 7) | **Declined:** too minor. |
| C1, schematic ops default to the root schematic (1) | **Approved.** |
| C2, the board named after the project (2) | **Declined:** too minor. |
| C3, the active profile by copper count (3) | **Approved.** |
| C4, a profile's replaced values (4) | **Declined:** too minor. |
| C5, net-class matches from nets in use (5) | **Approved.** |
| D1, a track end takes the net of the pad or via it is on (15) | **Declined:** too minor. |
| D2, fanout as a batch entry (18) | **Declined:** too minor. |
| D3, fanout on a stale fill (19) | **Declined:** too minor. |
| D4, footprint zones readable, drawn on the board (8) | **Approved.** |
| D5, pad extents in the part's pad rows (17) | **Declined:** what the properties panel shows should be in the API, and the pad's own record (`items_get` on the pad) already has its shape, size and box. Nothing to do. |
| D6, small check and doc fixes (16, 20, 21, 6/24) | **Declined:** poorly explained on the card. |

## Since the run

Built on 2026-10-09 on `goatherd-dev`, in five worktree branches merged together. The merged tree
passes `pre-cm-checks` (409 files, 5741 tests). None of it has been tried in the running app.

| Item | What landed |
|---|---|
| A1, renders | `render_board` requires exactly one of `layers` or `preset`: `front` (F.Cu, F.SilkS, F.Fab, F.CrtYd, Edge.Cuts), `back` (its mirror, viewed from the back unless `side` says otherwise), `copper` (every copper layer and Edge.Cuts), `silk` (silk, fab, courtyard and mask on both sides, Edge.Cuts; pads show as mask openings) and `all`. Zones draw as outlines unless `fills: true` (the canvas's outline-only mode). `activeLayer` draws on top and must be among the drawn layers. `dim` (0–1, default 0.3, the canvas's `DIM_ALPHA_FACTOR`) is refused without it. A capture dims by stroke alpha, not the canvas's darkening composite, so overlapping dimmed strokes read darker than on screen. The live canvas is unchanged. |
| A2, the box label | `action` (≤ 32 characters) is required on `render.board` / `render.schematic`, the sheet and board layout verbs, `board.fanout`, `route.begin` / `finish` / `step` / `preview` and the sheet and board undo and redo. It is required exactly where `viewport` is on `items.*` and the batches (once, on the batch). A successful call sets the box's label; a refused one leaves it. The Python transaction fills it like `viewport`. |
| B1, Attempt Finish | Attempt Finish from a selected item, in the GUI and `route.finish`, routes along each ratsnest line that ends on the item, to that line's far end, re-checked before each route. A start with none is dropped `joined`; `arrived` can hold one row per line. Mid-route F now measures from the head's end, as KiCad's `ROUTER::Finish` does (`pns_router.cpp:498-546`), not from the last click (R23, R46). Where it differs from KiCad: a line's far end is the target, and a layer both ends share is chosen when the start allows it. Route Selected (R44) is unchanged. |
| B2, start-point axes | `alignToStartAxes` (`routeTarget.ts`) is `GRID_HELPER::Align`'s rule, applied with the route's start point when no copper snaps, for the mouse (`PcbViewport2D.vue` route snap) and the agent (`routeAgent.ts`). R47. Drag is not built. |
| C1, the root schematic | `resolveAgentSheet` falls back to `rootSchematicPath()` after the active and the only open schematic tab, including when several are open with none in front. Every sheet argument's text says "else the root sheet". |
| C3, the active profile | `identifyProfile` takes the copper count, in `board.get_setup` and Board Setup. Board Setup also re-identifies when the copper count changes. |
| C5, matched nets | A shared `netsInUse(board)` (`boardSync.ts`) feeds `netClasses.matched`, Board Setup's net coverage and the sync's net-table cleanup. |
| D4, footprint zones | Footprint zones are items (`kind: "zone"`) on a library footprint and on a placed copy, refused on every write. Board `items_query` lists them after the board's zones with the footprint's `reference`; a filter delete counts them but leaves them. The board canvas and `render_board` now draw them under their footprint, and they select and move with it. KiCad's hit box includes them, so a large antenna keep-out makes its footprint clickable across the area. |
| Baseline | `mcp-tools-baseline.json` is regenerated for all 95 tools (pre-release clean break): `action` is required, and the order of `items_query`'s `kind` values changed. |
