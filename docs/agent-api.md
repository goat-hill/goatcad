# Agent API — the operation registry

How an agent drives GoatCAD: the rules every op is designed to.

- **What ships** is the registry itself: `electron/src/main/ops/index.ts` and each op's
  `guidance`. Keep no op catalog in this doc or in ARCHITECTURE.
- **How it is wired** (main vs window doors, the shared command layer) is
  [ARCHITECTURE.md](./ARCHITECTURE.md) §3.11.
- **What real design runs found**, and the verdict on each finding, is
  [agent-runs/](./agent-runs/README.md), one file per run.

## How the API is designed

These are the rules a new op follows. How tool text is worded is
[MCP-STYLE.md](./MCP-STYLE.md).

### Deterministic, not clever

GoatCAD is a tool, so it must be predictable. An op does exactly what its arguments say, and does
it the same way every time. It has no heuristics, guesses, alias tables or "looks like" hints
that nudge an agent toward a better result. Judgment is the agent's: when a rule can't be stated
exactly, the agent applies it, and GoatCAD gives it the facts to decide from. A request that only
makes one run go a little better is a band-aid, not an op.

### Design quality is judged visually

By default an agent judges design quality visually. It renders as it goes and evaluates
placement, readability and routing from the pictures, and it routes with the editor's
interactive router, previewing alternatives rather than computing paths. Autorouters have rarely
produced a compliant, clean board. A model can see and reason, and the interactive router keeps
each route compliant and clean for little effort. So:

- What can be judged by eye, the agent judges from a render. GoatCAD doesn't add facts or
  checks that stand in for looking.
- Routing tools are the GUI's routing, driven by gestures: sessions, previews, Attempt Finish,
  and in a session the pair router and the length tuner (`route_begin`'s `pair` and `tune`,
  router-behavior.md PR7 and T7). GoatCAD has no autorouter.
- Renders are a primary tool. They are fast, complete and honest, and they never leave out
  something they didn't finish drawing.
- The person sees what the agent is looking at (the agent viewport), so the review happens in
  the open.

A project can choose otherwise in its `board-intent.md`. This is the default for current models
and can be revisited as models change.

### One registry, three clients

Each op is one `defineOp` module (`ops/<domain>/<verb>.ts`), registered in `ops/index.ts` in
workflow order. From that one registry we generate:

- the MCP tool, `domain_verb`;
- the HTTP endpoint, `/v1/ops/domain.verb`;
- the Python method, `gc.domain.verb`, in the stdlib-only client the app writes to
  `<userData>/python/goatcad.py` at startup.

Nothing is written twice. `registry.test.ts` holds shipped tools to an additive-only contract
(`mcp-tools-baseline.json`).

### Domains are documents

- **The four documents** are `schematic`, `board`, `symbol` and `footprint`. Each has its own
  `check` and `batch`, and `describe` gives its overview while `get` gives its records.
  `items.*` acts on any document by argument.
- **A `symbol` or `footprint` argument** is either a library id (`Nickname:Name`) or a placed
  part's reference. A reference comes with `sheet` (else the open or root sheet) or `board`, and
  names the design's own copy, as Edit symbol… and Edit footprint… open it. A write to that copy
  is one step on the board, and the library is untouched. The colon tells the two apart.

### Records first, verbs on top

- **Records.** `items.get / query / create / update / delete` act on records, and the record you
  read is the record you write. Move, rotate and flip are fields, not verbs, and removing a placed
  part is `items.delete` on every document.
- **Editor transforms.** `items.transform` is the symbol, footprint and PCB editors' selection
  transforms (rotate, mirror, flip, move, duplicate) and the symbol and footprint editors' anchor
  move: several items about one pivot, or every item, as one step. It is a verb because the pivot
  and the shared offset are not any one record's fields. One op with a `transform` choice, not
  six, since every variant shares the document, the ids and the answer. It runs the editors' own
  code (on a board, `lib/board/boardSelectionEdit.ts`, which the PCB editor calls too), and its
  default pivot is the editor's, never snapped to the person's grid. On a board it sets layout,
  so it takes `viewport`; locked items transform as the editor's selection verbs move them, and a
  duplicated footprint counts up from its own number to the first free reference, as KiCad's Paste Special "unique annotations" does, so its id names one part.
- **The definition is an item.** A footprint's own properties (name, keywords, attributes, the
  local overrides) are the record `footprint`, read and written like any other and never created
  or deleted. An override that inherits reads `null`, and writing `null` inherits again.
- **Verbs.** A verb (`place_symbol`, `place_footprint`, `wire`, `connect`, `sync`) exists only
  when it does one of four things:
  - touches several items atomically;
  - resolves an id the model shouldn't have to compute;
  - enforces an invariant;
  - owes an answer specific to its intent.
- **A drawing tool's item is a record.** Its keys are the properties panel's rows: a create
  writes through the tool's writer, an update through the panel's setters. A run that is routed
  is a verb, so a bus is `schematic.wire` with `bus` (ends at points or sheet pins, drawn as the
  bus tool draws: no dots, no tidy), while what sits on it (a bus entry, a label) is an item.
- **Conveniences.** One that only saves calls belongs in the Python client.
- **Named arguments.** A field gets one only when GoatCAD itself branches on it. The rest stay in
  the `properties` map.
- **Batches.** A document's `batch` is atomic over one snapshot and one undo entry. `dryRun`
  re-parses the `before` state and pushes nothing. Don't build an inverse-command layer for it.

### Ids are read, never recalled

Every id an op accepts is one another op returned. A miss answers `not-found` with
`candidates`. The forms:

| Item | Id |
|---|---|
| Symbol or footprint | its reference |
| One unit of a multi-unit part | the reference and its sub-reference, as KiCad shows it (`U5A`, or per the project's separator and first-id settings, or the library's unit name) |
| Pin | `<ref>.<number or name>` |
| Field | `<ref>#<field>` |
| A symbol definition's own properties (name, power, flags, units) | `symbol`, read and updated, never created or deleted |
| Anything else | its KiCad uuid, or `<kind>@x,y` when the file has none |

A uuid is minted only inside the command that needs it. The renderer's index-based
`SelectionItem` never crosses the wire.

### Writes

- **Same engine and undo as the GUI.** A write goes through the GUI's command layer (on a board,
  the session's `runCommand`). One request is one undo entry, labeled for what changed
  (`locales/en/commandLabels.yaml`), and it leaves the tab dirty.
- **No surprises for the person.**
  - A write is never saved (`project.save` is the one exception).
  - It never changes the active tab or raises the window.
  - A document no tab holds opens behind the active one.
- **Every write answers with `changed` and `revision`.**
- **Checks are asked for.** The checks scale with the design, so a write runs them only with
  `checks: true` (`main/ops/checksArg.ts`; a batch takes it once). The answer then carries the
  delta, one row per rule, itemized up to `DELTA_ITEMS`, so the agent acts and verifies in one
  turn.
- **Undo and redo** are the GUI's Edit ▸ Undo and Redo, one pair per document
  (`schematic`, `board`, `symbol`, `footprint` `.undo` / `.redo`, `ops/history.ts`): the tab's
  own list, the person's steps and every write's, `steps` at a time, all or none. No expected
  revision: an open
  editor's derived steps (a refill joining the step before it, a merged nudge) move a revision
  without a new step, so a guard would refuse safe undos; the labels say whose step it was. On a
  sheet or board an undo is a layout edit and takes `viewport`.
- **Verifying a burst.** A document's `check` answers at a revision, and the same check with
  `since` set to that revision answers with what the burst broke or fixed. `describe({ since })`
  answers only what moved.

### Fast by default, nothing hidden

An agent reaches everything a person does, over the same engine and undo, but not with the same
ergonomics: it works in bursts and can't see the canvas. So:

- **Slow derived work is off by default** and is its own step, so a write costs the same on a
  2-layer board as on a Jetson. Three cases so far:
  - a zone refill, which is `board.refill`;
  - the checks, which are `checks: true` or `*.check`;
  - decoding a 3D model to say where it lands, which is `modelFit: true` on a footprint read.
- **Every side effect is in the answer**, and so is what was left undone. Every write leaves
  every zone fill stale (`stale.fills`), since which zones an edit changes isn't known.
- **A skipped step stays findable.** A check that depends on the skipped step reports stale,
  never passing. Reads report it too, and export either does the step or refuses.
- **The GUI keeps its conveniences** (auto-refill). A person's editor picks up what an agent
  left stale on its own schedule.

Test every new option the same way:

- Is the default fast and predictable?
- Is every side effect in the answer?
- Where does a skipped step surface before it can do harm?

The schema states what the default does, so an op's arguments read as its defaults.

### Answers

- **An answer is for deciding; a file is for consuming.** Every token of an answer passes
  through the model's context, so an answer holds ids, counts, findings and summaries.
- **Files.** Anything made for a fab, a person or another tool (a Gerber, a CSV, a model) is
  written to a path the call takes, defaulting beside the project. The answer gives each file's
  path, size and a one-line summary, never its content.
- **Script data.** Data a script loops over goes through the Python client, where answers stay
  in the interpreter (`app.scripting`).
- **Large answers.** A read pages (`limit`, `offset`, pinned to a `revision`). A write cannot be
  read again, so it answers whole and the MCP path caps its growing lists; the Python client is
  served whole over `/v1`, so a script gets every id. The shapes are
  [MCP-STYLE.md](./MCP-STYLE.md)'s "A capped read" and "A large answer".
- **Renders** are the one inline exception, because a vision model reads the picture. They draw
  off-screen at `maxPixels`. The 2D renders are audits with no style options: the caller chooses
  what to frame, not how to draw. `render.board` is the exception, since every layer at full
  strength with every pour filled reads as mud: it takes display options (its guidance).
  `render.board_3d` alone takes a camera, lighting, background,
  and mask and silk colors, because it is also the picture a person shows of the board.
- **Errors are one envelope**:
  - `code`: `unknown-op`, `invalid-args`, `no-document`, `not-found`, `refused`, `conflict`,
    `timeout` or `internal`;
  - `message`, for a person;
  - `fix`, naming the next call, for the model.

  An op failure is HTTP 200 with the envelope and MCP `isError`; only transport and auth are HTTP
  errors.

### Checks

A check is a real defect. Rules are pure, stable across calls, and never fire on half-finished
work.

### Parity with the GUI

Every GUI surface that changes the design or its project, or shows the person something about it,
is an op or an item below. Three things stay GUI-only:

- view state (zoom, the active layer, panel layout);
- window chrome;
- the person's own environment (appearance, keymaps, credentials).

A new GUI surface lands with its op, or with its item here.

A record takes what the GUI's property rows take, under the same rules: a placed part's
reference and value are written on the board only when no schematic symbol owns the part (else
on the sheet, then `board.sync`), a via's type keeps to its layer pair, and a tuning pattern's
rows and ends lay it again, as its handles do.

### Implementation notes

- **Schemas.** The schema DSL is in-repo (`ops/schema.ts`; no dependency, RULES.md §4). Main
  validates before anything crosses the bridge, so a handler checks semantics only. Every object
  is closed: an unknown argument is an error, never ignored.
- **Records.** What each document's items take, by kind, on create and on update, and the KiCad
  vocabularies their values come from are `src/shared/itemRecords.ts`; what each key's value must
  be is `src/shared/recordRules.ts`: one rule for a key that means the same on every document,
  the document's or the kind's own where KiCad's meaning differs. Main holds every create and
  update, and each batch's entries, to them on all four documents (`ops/items/record.ts`, which
  also writes `record`'s description from the tables): a stray key is `not-applicable`, a bad
  value `invalid-record`. An update's kind is known only once its id resolves, so the door checks
  the record again by its kind, and itself checks only what needs the document: a duplicate pin
  number, a locked item, nets joined, a via's layer pair.
- **Design ops are forwarded, not run in main**: [ARCHITECTURE.md](./ARCHITECTURE.md) §3.11
  (doors, new request kinds, failure kinds).
- **Versioning.** Within `/v1`, changes are additive: new ops, new optional arguments, new output
  fields. Until the first public release a rename is a clean break: no alias kept, the baseline
  regenerated. After it, the old name stays a release, marked `deprecated`.
- **Development.** Main-process changes need an app restart. Round-trip every written file
  through `kicad-cli`: the renderer drawing a file correctly is no evidence the file is correct.

## Workspaces

Where an agent acts is the workspace its call names, never the window a person is looking at
(`main/workspaces.ts`). Several agents work in several projects at once, in windows or in the
background, while the person works in another.

- **The model.** A workspace is a folder, a project in it, both or neither, and zero or more
  windows. A file is open once, in one window of one workspace, so a project is in one workspace.
  A workspace with no window keeps its documents in one hidden renderer; its first window is that
  renderer shown, so undo and unsaved edits carry over.
- **Which workspace a call acts in.** Every op takes an optional `workspace`, added once by
  `defineOp` (`ops/registry.ts`); an op whose own `workspace` names its target keeps it. Else a
  client's `X-GoatCAD-Workspace` header: an agent tab sends its window's (`GOATCAD_WORKSPACE`),
  the Python client the one it connected with. Else the only workspace open. With none open the
  call is refused `no-workspace`, and with several `workspace-required`, listing them: never a
  guess, since one may be the person's own. Nothing is kept per connection, so subagents sharing
  one connection each pass their own.
- **Ids** (`ws_…`, `win_…`) last one app run; after a restart a call naming an old one is refused
  `workspace-not-found` with the open ones.
- **Where in it.** A named document open in a window of the workspace goes to that window; one
  named by a full path that another workspace holds, or lies in, is refused `file-in-workspace`
  with its id. A document no tab holds opens behind the active tab of the workspace's window, as
  before. Several windows: a verb that adds a tab takes `window` (`window-required` otherwise). No
  default reads focus or the tab in front: an unnamed sheet is the root sheet, else the only open
  one.
- **Lifetime.** A workspace with a window is the person's; it stays until they close it.
  `workspace.update`, `workspace.close` and `workspace.close_window` refuse with unsaved edits
  (`discard` drops them). A workspace with no window belongs to the connection that started it:
  when that connection ends it closes, or opens a window when it holds unsaved edits, so work is
  never lost unseen. A background launch quits once it has no window and no connection.
- **Clients.** In-app tabs use the HTTP endpoint with the header. Outside, a client registers
  `goatcad mcp`, which starts the app in the background when it is not running. Python:
  `connect(workspace=…)`.

## The agent viewport

It works on a board or a schematic.

- **Opening and closing.** One concept with two ops:
  - `viewport.open {board | sheet, label}` answers a viewport id; called again with that id, it
    changes the label;
  - `viewport.close {viewport}`.
- **The label says what is happening now.** Every call that moves the box takes a required
  `action` (at most 32 characters: "Route USB_DP", "Check silk"), which replaces the box's label
  once the call succeeds; `viewport.open`'s `label` is only the first. A batch takes it once
  (`ops/viewport/action.ts`). The box keeps one label line; no second line names the op.
- **One per agent connection:** `viewport.open` from a connection that already holds
  one relabels and moves it instead of adding another, answering its id. An op that should move a
  box still takes the `viewport` id. A connection is the MCP session (`Mcp-Session-Id`), or the
  id the Python client makes per `GoatCAD` object; a client that sends neither gets a new
  viewport on every open. Ids are unique across windows, and a call naming one goes to the window
  that holds it.
- **The route head stays off the canvas:** an agent's uncommitted route (head and
  clicked segments) is drawn only in the picture its call answers. Landed copper shows as any
  write does.
- **What it frames.** The box frames the agent's last activity in it: the frame of a render,
  the items a write created, moved or deleted (a deletion where it was), and the area round a
  routing head.
- **Required:** every 2D render and every edit that sets layout takes `viewport` and `action`
  and refuses without them (`invalid-args`), so the person always sees where the agent works and
  what it is doing. Which ops and record keys count is `ops/viewport/open.ts` (`LAYOUT_KEYS`) and
  the ops that use `ops/viewport/action.ts`; `route.step` and `route.preview` act in their
  session's viewport. Strict on purpose; relax it if it costs more than it shows. Routing is an
  activity inside a viewport, not a second API.
- **Ending.** A viewport closes:
  - on `viewport.close`;
  - after 10 minutes idle;
  - when its document closes;
  - when the agent's client disconnects: an MCP DELETE, its held GET stream closing,
    or the Python client's `close()`, which runs at exit;
  - on the person's ×, which also ends routing in it, landing what was clicked (the agent is
    told on its next call).
- **On the canvas.** The shared `agent` icon and the label. A box outside the person's view
  shows as a marker at the view's edge, and clicking the marker moves the view to it.
  Nothing else moves the camera.
