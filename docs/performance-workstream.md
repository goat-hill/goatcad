# Performance Workstream

Making GoatCAD fast on a complex board: frame rate and operation lag first, then file open time,
then memory. One design, a few core operations, measured well enough to tell a win from noise —
not a benchmark suite yet. Launch is measured separately (`./bin/launch-timing`, ARCHITECTURE.md
§3.1).

## The design and how it is measured

**Jetson AGX Thor baseboard** (KiCad's `demos/jetson-agx-thor-baseboard`): 85 MB board, 1,125
footprints, ~20k segments, 3.2k vias, 131 zones (30k copper items), a 17-sheet KiCad 9 hierarchy.

`./bin/board-timing` (ARCHITECTURE.md §3.1) drives the built app as `launch-timing` does — a
fresh profile, Jetson opened on launch — through open, pan, zoom, hover, a click on the largest
footprint, a route out of its pads and a drag of it, and reads the heap after open and after the
edit; `--profile` writes a CPU profile per operation, and `--record` adds one run to
`perf/board-history.html`, the design named by its board file's git blob hash and refused while
the design's folder has local edits. "Settled" is the renderer main thread under 10% busy for 2 s
(Chromium's `TaskDuration`), not the absence of long tasks: the checks and the refill run in
12 ms slices and never register as one. Headless, llvmpipe draws the frames, so read CPU time and
heap there and frame rate only from `--visible`.

The numbers, before and after each change, are in `electron/perf/board-history.html`; figures in
this doc are approximate and not kept current. On a real
GPU pan, zoom and hover hold 60 fps; what a user waits on is the editor after an edit.

## The board worker

The goal is an editor that stays smooth while the board is loaded, refilled and checked. The
main thread keeps what must answer within a frame: the parsed board and every command on it,
undo, the scene and its drawing, and the interactive router. Everything that follows an edit —
zone refill, whole and incremental DRC, later the serialize — runs in one dedicated worker per
open board. Slicing on the main thread (`lib/cooperate.ts`) cannot do this: a slice and a render
do not fit one frame, single steps run 0.5–0.9 s, and collection pauses land on the same thread.

**What both plans share.**
- **Revisions.** Every command bumps the board's revision. A job runs against one revision, and
  every result carries it; the main thread drops a result older than the board it holds, so a
  late result can never show.
- **Cancel, keep warm.** The worker drives refill and DRC as the generators they already are,
  checking between slices for a newer revision, or a newer job of the same kind, and dropping
  the job when one arrives: one check and one refill run at a time, and a check's inputs
  (rules, libraries, schematic) are kept as each request arrives. A job that throws answers
  empty and says why; only a change the copy cannot follow reloads it. Clipper is loaded before
  the worker reads anything: without it the index, the pads' copper and several rules quietly
  differ. It keeps
  its warm state — index, rule context, last findings, other zones' fills — because that is what
  keeps an edit's follow-up small (an edit's region check is 45–90 ms against 10 s whole). It is
  terminated and respawned from the current board only when a step overruns a deadline without
  yielding, when it crashes, or when its memory grows past a cap.
- **Results.** Fills come back as transferable typed arrays (moved, not copied); findings as
  plain data. The main thread writes fills into the board as the command they complete (as
  `groupWithPrevious` does today) and hands them to the scene. A zone whose fill is pending is
  stale: drawn as such, and folded into one "zones out of date" finding (pcb-editor-workstream.md).
- **Agent ops.** `board.check` and `board.refill` await the worker's answer for the current
  revision instead of running in place.
- **What stays on the main thread, to optimize there:** the command itself and Vue's reaction to
  it (~0.3 s and ~0.6–1 s after a drop today), the parse and migration on open.

**(a) A copy in the worker.** On open the worker is sent the board text and parses its own copy
(~1–2 s on Jetson, off the main thread); the text is dropped once parsed. After each command the
main thread sends the delta at the top level — items added, removed and changed, as their
serialized text, which the serialize cache already holds as slices — tagged with the revision,
and the worker applies it to its copy. Cost: a second copy of the board's model, an estimated
300–450 MB on Jetson and toward a gigabyte on the largest boards (measure it first); and a
second apply path that must track every command exactly, so a test replays seeded edits on both
sides and compares the two boards' serialized text. Needs nothing from Chromium.

**(b) Shared memory.** The geometry refill and DRC read lives in flat typed-array tables in
`SharedArrayBuffer`s: copper items (segments, arcs, vias, pads as columns of coordinates, width,
layers, net), zone outlines and fills as flat coordinate arrays, footprint transforms, and the
spatial index over them. The main thread is the only writer: a command writes changed items as
new rows and tombstones the old, then publishes the revision with `Atomics.store`; the worker
reads the revision when a job starts and ignores rows past it, so it never sees half an edit.
Rows are compacted while the worker is idle. No copy and no delta protocol for geometry; rules
and nets, small and rarely changed, are sent as messages. Costs: the code that reads the
board's objects today — connectivity, the filler, the checks — moves onto the tables, one
subsystem at a time; and the page must be cross-origin isolated, since Chromium exposes
`SharedArrayBuffer` only then: served over a custom scheme (Electron's security guide asks for
one over `file://` anyway) with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and everything the page embeds allowed under it.
A spike proved it (`main/appProtocol.ts`, on with `GOATCAD_ISOLATED=1`): the built app served from
`goatcad-app://` is isolated, a worker file writes into a `SharedArrayBuffer` the page reads, and
Jetson and its fill worker are unchanged. The PDF and HTML viewer frames load as `credentialless`
iframes — a plain iframe under the policy refuses the media document, and with headers on the
media scheme it refuses Chromium's PDF viewer inside. Left before it ships: isolation by default,
the same headers on the Vite dev server, and a pass over the parts view, 3D models and the library
chooser. Workers are bundled files: the page's CSP (`script-src 'self'`) refuses `blob:` ones.

**Order.** (a) is the smooth editor soonest; (b) is the end state, reached by moving (a)'s worker
onto tables subsystem by subsystem once isolation is proven. If isolation is, (a)'s apply path is
designed so its tables replace its copy rather than sit beside it.

## Open work, in order

1. **Board-wide checks after every edit.** The editor stays responsive (both run in the board
   worker), but an edit's findings arrive about half a minute later on Jetson. The refill comes
   first (item 2); then the checks run board-wide, connection width about half of them, copper
   slivers next. Connection width and slivers are local enough to run round the edit's region
   (`drc/incremental.ts`), the rest per changed footprint or text.
2. **Zone refill after an edit.** Every zone is refilled, the larger part of that half minute.
   The cost is Clipper offsets and unions (`minimumWidth`) and the island pass reading the other
   zones' fills. Refilling only the zones an edit touches is in BACKLOG.
3. **The board's format migration on open** — a KiCad 9 board is parsed, migrated and serialized
   synchronously in `formatUpgrade.ts` (`migrateOne`, ~2.5 s of frozen UI on Jetson) before the
   board session parses the result again. Migrate the session's own parse instead, keeping the
   document's text KiCad 10's.
4. **Checks run twice on open** — at HEAD the whole board check ran again once the schematic
   netlist arrived. Confirm whether it still does, and run it once, after both.
5. **Memory.**
   - One character outside Latin-1 (Jetson has two `∅`) makes V8 store the whole text two bytes a
     character: ~170 MB per copy of an 85 MB board.
   - The sheet session's hierarchy keeps every sheet fully parsed (~100 MB on Jetson) where it
     needs only the sheet structure.
   - Main's heap is ~190 MB after open; find what it holds.
6. **Routing into a dense field** — on a real GPU each cursor move pushed into the SoM
   connector's pads takes ~230 ms to its frame (router-behavior.md Q1 asks for the next frame).
7. **Select and drag start** — a click's ~160 ms task and a drag's first ~250 ms are Vue
   reactivity (the Properties panel and the editor's watchers), not drawing. Profile them.

Launch-time items, measured with `./bin/launch-timing`:

- Restore the lazy startup boundary: `App.vue`'s agent and capture imports pull three.js and
  `lib/engine` into the entry chunk, and `lib/kicad/schematic.ts` pulls in the NewStroke font
  (~50–80 ms of parsing).
- Load `electron-updater` at the first update check (10 s in) rather than at launch (~30 ms);
  `tar` and `node-pty` likewise (~5 ms each).
- Clear the application menu before `ready`, as Electron's performance checklist advises (within
  noise when measured).
- Cache decoded NewStroke glyphs by codepoint; `getTextStrokes` re-decodes every character on
  every layout.
- A per-sheet connectivity cache (each sheet's wired pieces keyed by file revision, only the name
  merge redone per edit), if a large design's rebuild outgrows the edit budget. On Jetson's
  17 sheets an edit now waits ~65 ms on it — what is left of a wire edit's ~100 ms on the page,
  since the design checks moved to the schematic check worker (`lib/schematic/worker/`, ~220 ms
  before). The graph stays on the page because hover, the selection's net, the dangling marks
  and the agent's write deltas all read it in place.
