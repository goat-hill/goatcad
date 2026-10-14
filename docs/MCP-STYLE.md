# MCP text style

How every piece of text and every shape an agent reads from GoatCAD is written: tool summaries, guidance, argument
descriptions, examples, the server instructions (`main/partsMcp.ts`), prompts
(`main/partsMcpPrompts.ts`), error remedies (`DESIGN_REMEDY`, `ops/design.ts`) and the `guidance`
an answer carries. The op rules themselves are in
[agent-api.md](./agent-api.md).

Write it like API reference. Every tool's text is sent with every tool list, and every answer's
text passes through the model's context on every call, so length is a cost paid on each call.

## Tools

- **`summary`** is one sentence that says what the op does, about 100 characters. It names the
  object and the verb. It does not list every field the answer carries.
- **`guidance`** holds only what the summary and schema cannot say:
  - what to read or call first;
  - defaults that change the outcome;
  - what is refused, and why only when the reason tells the caller what to do instead;
  - side effects: an undo step, a dirty tab, a tab opened behind, a file written;
  - units, frames and id formats.

  Aim for under 500 characters, and under 900 for the largest ops. Per-document behavior goes in
  short labelled sentences ("Sheet: … Board: … Footprint: …").
- **Argument descriptions** are a phrase: meaning, format, unit, default. Allowed values that the
  schema's enum already lists are not repeated. A long structured contract (a record's keys) may
  list the keys, with no prose around them.
- **`examples`**: one to three per op, each with a note of a few words. Cover the common call and
  each document the op takes.

## Arguments

The same fact has the same name and shape in every op and on every document: sheet, board, symbol
and footprint.

- Names are camelCase (`maxPixels`, `dryRun`), and a name says what the value is, not its type.
- **Which document**: `sheet` (a sheet file; default the project's root sheet, else the only
  open one) or `board` (a board file; default the project's one board). A default never reads
  the tab in front: which tab a person looks at must not decide where an agent writes.
- **Which definition**: `symbol` or `footprint`, a library id `Nickname:Name`, or a placed
  reference with `sheet` or `board` for the design's copy. Every op that reads, writes, checks,
  renders, copies or deletes one takes it this way. Only an op that makes a new one takes `name`
  and `library`.
- **Ops on a document's parts are named for the part**: `schematic.place_symbol`,
  `board.place_footprint`. Removing or editing one is `items.delete` or `items.update`, on every
  document.
- **Positions**: `at: {x, y}` in millimeters, y down, in the document's frame. `angle` in degrees
  counterclockwise, beside `at`. A board item's side is `side: "front" | "back"`; a sheet symbol's
  mirror is `mirror`. Sizes are `{width, height}`; a hole is `drill: {diameter, oval?, offset?}`.
- **A record written is a record read**: `items.update` and `items.create` take the fields in
  `record`, keyed as `items_get` answers them, on every document. Options about how the write is
  done (`wires`, `checks`, `dryRun`) are arguments beside it.
- **Item kinds** have one spelling across documents: `rect`, `circle`, `arc`, `line`, `text`. A
  kind only one document has keeps KiCad's name (`polyline`, `bezier`, `no_connect`).
- **Style** has one set of keys on every item that draws: `width`, `strokeType` (KiCad's names,
  `default` to `dash_dot_dot`) and `strokeColor`; `fill` (KiCad's fill types on a sheet or
  symbol, on or off on a board or footprint) and `fillColor`; text `size`, `bold`, `italic`,
  `justify`, `verticalJustify`, `color`. A color is `"#rrggbb"` or `"#rrggbbaa"` (either case
  written, lowercase read), and `null` returns it to the default. The keys and their rules are
  `src/shared/` ([agent-api.md](./agent-api.md), Implementation notes).
- **Shared options**: `dryRun` (answer what would change, write nothing), `checks` (answer the
  check delta), `since` (a revision; answer only what moved), `codes` (narrow a check), `limit`
  and `offset` (page a list; `revision` pins the pages to one state), `columns` (the keys a record
  answers; default all, its identity always), `maxPixels` (a render's longest edge), `viewport`
  (a `viewport_open` id; required on a 2D render and an edit that sets layout), `action` (what the
  call is doing, at most 32 characters, the box's label; required wherever `viewport` is).
- **Files**: `path` is a file the op reads or adopts, `directory` where it writes.

## Answer shapes

The types are in `preload/mcpTypes.d.ts` ("What a design answer is shaped like"); each door builds
its answers from them.

- **A write** answers `changed: {created, updated, deleted}`, each a list of ids, and `revision`.
  With `checks: true` it adds `checks: {new, resolved}`, one row per rule. What it left undone is
  `stale` (`stale.fills`). Anything else an op owes goes under a key named for it (`placed`,
  `touching`, `labels`); counts that are not ids go in `counts`.
- **A dry run** answers what the write would, plus `dryRun: true`, at the current revision.
- **A placement** answers `placed: {id, reference, libId, at, angle, side | mirror, pins | pads}`;
  a pin or pad row is `{id, number, name?, at, free?, net?}`, `free` being the side a wire
  leaves a sheet pin from.
- **A record** starts with `id` and `kind`. The part a pin, pad or field belongs to is
  `reference`. A link to a library definition is `libId`. A list read carries `count`.
- **Every answer about a document** names it as `sheet` or `board`, `{path, name}`. A read
  answers `revision`. With `since` each list becomes `{created, updated, deleted}`, the last a list of ids.
  Counts go in `counts`.
- **A capped read** answers `truncated: true` beside its `count`, and its `guidance` counts the
  matches by each narrowing argument's values and names the next `offset`.
- **A large answer** (one rule for every op whose lists grow with the design): on MCP, each such
  list holds at most 100 entries (`ANSWER_LIST_MAX`, `ops/answerLists.ts`, `items_query`'s
  default page). The lists are a write's `changed` (on a batch, its entries' too) and the rows an
  op declares in `lists` (fanout's `escapes`, sync's `added`, finish's `arrived`, annotate's
  `renamed`). The object holding a capped list says `truncated: true` and gives the full length
  in its `counts`, under the list's name (`changed.counts.deleted`, `counts.escapes`), and the
  answer's `guidance` names the way to the rest: the same call through the Python client, whose
  `/v1` answers are whole, or `items_query`. Counts are always exact. Doors answer whole; only the
  MCP path caps.
- **An undo or redo** answers the write shape plus `undone` or `redone` (each step's label, in
  the order taken) and `next: {undo, redo}`, the label each list would take next.
- **A check** answers `ok`, `checks` (one row per rule: `code`, `severity`, `rule`, `count`,
  `items`) and `counts: {error, warning}`. A sheet or board check adds `revision`; with `since`,
  `checks` is the delta `{new, resolved}`. A board's rows, in the check and in every delta, add
  `findings`, each `{items, at?, layer?, measure?, detail?}`, capped with `truncated: true`.
- **A batch** answers the write shape plus `results`, one entry per op in order, each that op's
  answer without `revision`, `checks` or `guidance`. A failed entry refuses the whole batch with
  that entry's own kind, its detail starting "Operation N (`op`):".

## Answers and remedies

- An answer's `guidance` says how to read this answer and the likely next call, in one or two
  sentences. It does not repeat the tool's guidance.
- A remedy says what went wrong and the call that fixes it, in one or two sentences.
- Every failure kind a door returns has a row in `DESIGN_REMEDY` and `DESIGN_CODE`
  (`ops/design.ts`). A bad argument is `invalid-args`, a bad record value `invalid-record`, never
  `renderer-failed`. A name that did not resolve is a `*-not-found` or `unknown-*` kind with
  `candidates`.
- The server instructions are the session's orientation: the first call, how the domains fit, and
  the few rules that span ops. Op-level detail stays on the op.

## Wording

- Use the present tense and the imperative ("Read the item first"). State facts; do not persuade.
  Cut "because a model…", "this is the way to…", and stories about why an op exists.
- Refer to other tools by their MCP name (`board_check`). Mention one only when it is the next
  call or the alternative.
- Do not use emphasis capitals ("NOT", "FIRST"), unless one word decides a safety question.
- Use American English and millimeters, as RULES.md §5 requires.
- Say a fact once. If two ops share it, put it on the argument they share or in the server
  instructions.
