/**
 * The one prompt this server offers: `init`, which interviews the user and
 * has the agent write `board-intent.md`, plus a short GoatCAD section in the
 * project's `AGENTS.md` that routes every session to it (§5 of the design doc).
 *
 * It is the only prompt on purpose. `suggest_parts` and `design_symbol` were
 * prompts until 2026-09-10 and were retired: a prompt's method reaches the
 * model only when the user invokes it, and the sixth acceptance run never did.
 * The method now lives where every session reads it — the conventions
 * sections `init` writes into the project file (so the user can see and edit
 * what the model is told), and the guidance on the tool that needs it
 * (`symbol_create` carries the datasheet-to-pin-table method;
 * `parts_search` carries the catalogs' quirks; `render_schematic` and
 * `schematic_check` carry the schematic review loop, which is GoatCAD's way of
 * working rather than a project's convention, so it reaches a project `init`
 * never ran in).
 *
 * MCP prompts surface in Claude Code as slash commands, so this reads as
 * instructions to an agent that has already been handed a task.
 */

export interface McpPromptArgument {
  name: string
  description: string
  required?: boolean
}

export interface McpPromptDefinition {
  name: string
  description: string
  arguments: McpPromptArgument[]
  render(args: Record<string, unknown>): string
}

/**
 * Recover the user's request from whatever the client actually passed.
 *
 * **A slash command's arguments do not survive intact.** Claude Code splits the
 * line on whitespace and maps the pieces onto the declared arguments, so
 * `/mcp__goatcad__init a low power temperature logger` arrives as `about: "a"` — the
 * first word, with the rest dropped. Observed, not theorized: it is what
 * happened the first time a prompt on this server was invoked for real.
 *
 * Two defences, because neither is sufficient alone:
 *
 * 1. **Join every string the client sent**, whatever it called the keys. If a
 *    client spreads the line across `need`, `arg1`, `arg2`… this reassembles it;
 *    if it sends one clean string, this is a no-op.
 * 2. **The rendered prompt tells the model to prefer the user's own message.**
 *    The typed line is in the conversation regardless of what survived
 *    argument-mapping, so the text below treats this value as a hint that may be
 *    truncated rather than as the request itself. That is the defence that
 *    actually works, since no amount of server-side care can un-drop a word the
 *    client never sent.
 */
export const joinArguments = (args: Record<string, unknown>): string =>
  Object.values(args)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')
    .trim()

/**
 * The conventions sections `init` writes into `board-intent.md`, by heading.
 * `project_context` reports the ones a project's file lacks.
 */
export const CONVENTIONS_SECTIONS = [
  'Schematic conventions',
  'Footprint conventions',
  'Working on the schematic',
  'Board conventions',
  'Choosing parts'
] as const

export const INIT_PROJECT_PROMPT: McpPromptDefinition = {
  name: 'init',
  description:
    "Set up or update this board's design context (purpose, assembly, quantity, sourcing, conventions) through a short conversation, recorded in board-intent.md with a pointer in AGENTS.md.",
  arguments: [
    {
      name: 'about',
      description: 'Anything about the project, in your own words.',
      required: false
    }
  ],
  render: (args) => `Set up this board's design context, and write it to \`board-intent.md\` in the
project root.

${joinArguments(args) ? `**What the user said so far:** ${joinArguments(args)}\n\n` : ''}**The user types plain English and nothing else.** They should never be shown a schema or asked to
fill in a field. Have a short conversation, then write the file yourself with your own file tools;
GoatCAD does not write it.

## 1. Read before you ask

Call \`project_context\` first. It says where the project is and whether an intent file exists; if
one does, this is an update: read it and change only what changed.

Then read the project directory. **Do not ask for anything you can read**:

| Already knowable | Where |
|---|---|
| Layer count, stackup, design rules | the \`.kicad_pcb\` and \`.kicad_pro\` |
| Board outline size | the Edge.Cuts layer |
| Parts already placed, and their packages | the schematic and board |
| Which distributors are set up | \`parts_status\` |
| What else the repository holds, and any existing agent instructions | the directory, \`AGENTS.md\`, \`CLAUDE.md\` |

Propose what an existing board implies rather than asking: everything 0402 or larger sets the
package floor, a BGA settles fine-pitch assembly, all through-hole suggests hand assembly.

## 2. In an empty directory, ask two questions — not a questionnaire

Ask only what is expensive to undo and cannot be inferred later:

1. **How will it be assembled** — by hand, reflowed with paste and a hotplate, or by an assembly
   house? This decides every part's package.
2. **Roughly how many** — a handful, dozens, hundreds? This decides which price is honest and
   whether stock is deep enough.

**Default everything else, and say what you defaulted**: minimum passive size from the assembly
method, cut tape or reel from the quantity, lifecycle active-only, RoHS required, distributors from
\`parts_status\`, indoor temperature unless told otherwise. Leave an unknown budget open.

**Never ask for layer count, board size or design rules.** They are unknown on day one and readable
later; they do not belong in this file.

## 3. Read it back as sentences, then write

Confirm in prose, not as a table of fields, naming each guess so the user can correct it in a word:
*"25 boards, reflowed yourself on a hotplate, 0402 floor, DigiKey and Mouser, indoor use. I guessed
the 0402 floor and the indoor part. Schematic and part-selection conventions are standard practice —
say the word if you write values or number parts differently. I'll also add a short GoatCAD section
to AGENTS.md so every session starts knowing this is a GoatCAD project."* Write both files once they
agree.

## 4. The file

YAML frontmatter for what tools read, prose underneath for people, in the user's own words.

\`\`\`
---
goal: <one line>
stage: prototype | pilot | production
scale: { quantity: <n>, anticipated: <n or null> }
budget: { bom_target_usd: <n or null> }
assembly:
  method: hand-solder | hotplate | manual-pnp | pcba | turnkey
  house: <name or null>
  min_passive: "0402"
  fine_pitch_ok: <bool>
  bga_ok: <bool>
sourcing:
  packaging: cut-tape | tape-reel | either
  distributors: [<from parts_status>]
  second_source: required | preferred | dont-care
  lifecycle: active-only | avoid-obsolete | dont-care
  origin: dont-care | prefer-us | avoid-cn
  rohs: required | dont-care
environment:
  temp_range_c: [<min>, <max>]
  supply: <one line>
datasheets:
  path: datasheets/
  committed: true
  extra_paths: []
models:
  path: <project>.3dshapes/
  committed: true
footprints:
  density: nominal        # least | nominal | most — hand-solder → most, everything else → nominal
  pin1_marker: chevron    # chevron | dot | line
committed_parts: []
assumed: [<every field you defaulted rather than were told>]
open_questions: [<what you could not settle>]
---

## Goal

<the user's own description, in their words>

## Schematic conventions

<the list from §7, edited only where the project or the user differs>

## Footprint conventions

<the list from §7>

## Working on the schematic

<the list from §7>

## Board conventions

<the list from §7, layer roles filled in once the board has its stackup>

## Choosing parts

<the list from §7>
\`\`\`

**\`assumed\` lists every field you filled in without being told.** An unlisted default reads later
as a decision.

**\`origin\` cannot be verified**: neither DigiKey nor Mouser exposes manufacturing origin. Record
the preference; never claim a part meets it.

## 5. Datasheets live in the repository

Write the \`datasheets:\` block with the defaults shown, without asking. Datasheets are committed:
a vendor's link dies, and a reviewer needs the revision the board was designed against. Do not add
\`datasheets/\` to \`.gitignore\`. If the user says their datasheets live elsewhere, record it:
\`extra_paths\` for some, or replace \`path\` for all.

## 6. Footprints and models — defaults, not questions

Write the \`footprints:\` block without asking: \`density\` is \`most\` when the assembly method is
\`hand-solder\` and \`nominal\` otherwise, and \`pin1_marker\` is \`chevron\`. Line widths, text
and courtyards are the library's. Write the \`models:\` block with the defaults shown:
\`<project>.3dshapes/\` beside the project file, committed, not in \`.gitignore\`. All four keys go
under \`assumed\`, and the read-back says they were defaulted.

## 7. Schematic, footprint, board and part-selection conventions — fill them in, do not ask about them

Every later agent that edits this project reads these sections first. **Ask nothing.** Write the
five sections below as shown, and say in the read-back that they were defaulted and can be changed
at any time. On an existing design, keep what the sheets already do: if values are written
\`0.1uF\` and \`4k7\`, those are the conventions, and say you took them from the sheet.

Copy the sections as written, editing only what the project or the user contradicts.

\`\`\`
## Schematic conventions

- **Values.** Value carries the value alone, in short form: \`10k\`, \`4.7k\`, \`1M\`, \`100nF\`,
  \`10uF\`, \`22pF\`, \`10uH\`. Ohms have no unit symbol. Tolerance, voltage rating, dielectric and
  package go in their own fields (\`Tolerance\`, \`Voltage\`, \`Footprint\`) or are implied by the MPN —
  never in Value, which is what prints on the sheet.
- **References.** KiCad's letters (R, C, L, D, Q, U, J, Y, SW, TP, FB), numbered in reading order —
  left to right, top to bottom. A multi-sheet design numbers by sheet: R101 on sheet 1, R201 on
  sheet 2.
- **Nets.** UPPER_SNAKE, named for function (\`UART0_TX\`, \`I2C_SDA\`, \`VBAT\`); active-low ends in
  \`_N\`. Rails are spelled as KiCad's power library spells them (\`+3V3\`, \`+5V\`, \`GND\`).
- **Wires and labels.** Wires within a block; labels only between blocks — global for rails,
  hierarchical across sheets. A label sits on the pin's free side with its text reading away from
  the part.
- **Layout.** Signal flows left to right; power at the top, ground at the bottom; connectors at the
  edges. A decoupling capacitor sits one grid step from the pin it serves. Every pin left open on
  purpose carries a no-connect. A \`PWR_FLAG\` where a rail enters from a connector.
- **Sheets.** One sheet while the design is one or two blocks. Beyond that, a root sheet that reads
  as a block diagram and one child sheet per functional block, each with its own power symbols.
  A4 landscape; grow the page rather than crowd it.
- **Text.** Each block gets a title and one line saying what it is for. Notes are concise;
  datasheet rules under a block only when asked.

## Footprint conventions

- A footprint exists in the standard library for nearly every IC package: search by package name
  and pitch (\`footprint_search\`) before drawing one.
- A drawn footprint (\`footprint_create\`) is transcribed from the datasheet's recommended
  land pattern, read as an image, with the datasheet cached first so the revision is on record.
- It is named the way the library names its neighbors — family, manufacturer, part, pins, pitch,
  orientation — so a reader can tell what it is without opening it.
- Its report says what was cut, what was derived, and what could not be read.
- Every footprint carries a 3D model whose file exists, so the finished board renders whole. A
  model is never needed to lay out or order a board: a part still without one is listed as open,
  never treated as a blocker.
- A model comes from, in order: the model a matching standard-library footprint already links
  (read it with \`footprint_get\`, write the same record with \`items_create\`); the
  manufacturer's own STEP file for that part number; anything else is a third-party model, which
  is not a reviewed source — ask the user before using one, and say where it came from. Every
  downloaded model is saved with \`footprint_cache_model\` so it is committed with the project.
- A standard footprint whose model file is missing gets a project copy
  (\`footprint_copy\`), the model attached to the copy, and the part's Footprint pointed
  at it.
- Look at a model before attaching it (\`render_model\`): one part, the right part, upright,
  in millimeters. A file over about 5 MB, or one that shows an assembly, is unusual: look for the
  vendor's simplified version or tell the user. After attaching, read the answer's bounds against
  the body and the datasheet's height, and render the footprint with its model
  (\`render_footprint\`, view model): pin 1 over pad 1, leads on pads, the body on the board.

## Working on the schematic

- Read the conventions above before the first edit, and follow them without being asked.
- Review the drawing as GoatCAD's tools say: each block as \`render_schematic\` describes,
  before the next block; every sheet as \`schematic_check\` describes, before reporting done.
- Before starting the board: a schematic is ready for layout when every part \`bom_get\` lists
  has a footprint, and ready to order when each has an MPN and a cached datasheet. A generic
  passive is placed by value first and gets its footprint here. Fill the BOM before layout, list
  what is still open, and list the parts that still have no model as open
  (\`bom_get\` with the MODEL column) — open, not blocking.
- When the user corrects a convention, update the section above so it sticks for every later
  session.

## Board conventions

- **Layers.** Each copper layer's job is written here once the board has its stackup: which carry
  signals and which are planes (for example In1 an unbroken GND plane, In2 +3V3). Two layers:
  signals on both, a GND pour on both.
- **Routing.** Route with GoatCAD's interactive router, as a person would. Use \`route_finish\`
  first on connections with an obvious path. Use \`route_begin\` and \`route_step\` for the rest,
  trying alternatives with \`route_preview\` before committing. Draw a track with
  \`items_create\` only when its exact path is already decided. Never write a router of your
  own: the editor's handles clearance, shove and pad exits.
- **Order.** Short critical connections first: crystals, differential pairs, decoupling. Then
  power, then the rest. A pad joins its plane by a via at the pad (\`board_fanout\`).
- **Widths and spacing** come from net classes. A net that needs its own gets a class, not a
  one-off width, and \`board_get_setup\` shows that the class's patterns matched it.
- **Review.** After routing a group, render each copper layer on its own, in the group's
  viewport, and look for
  detours, tracks squeezed between pads, and pads boxed in. Last, render the silkscreen
  layers and look for text over pads or copper and labels that read wrong. Run \`board_check\`
  before reporting done.

## Choosing parts

- **Requirements before the catalog.** Write what the part must do — function, the numbers that
  matter, a package the assembly method allows, the build quantity — before searching. A wrong
  premise is free to fix here and expensive later.
- **Generic before specific.** A passive or a commodity part is found by kind and value (a
  category with filters on DigiKey, a short keyword elsewhere), then chosen from what is in
  stock at the build quantity from a maker you would trust — never from a part number you recall.
- **Family before ordering code.** For an IC, search the family name (\`SHT40\`, \`TPS62\`,
  \`STM32G0\`), not a full ordering code, so the catalog shows every variant, the successors, and
  what is actually stocked. The exact suffix is picked from the results.
- **A full MPN confirms; it does not discover.** Look one up (\`parts_compare_mpn\`) only to check
  that a chosen part is real and buyable at quantity, at each distributor.
- **Short queries.** A catalog search matches part and family names, not descriptions. A sentence
  returns nothing; two or three words return the landscape.
- **What makes the pick.** In stock at the build quantity; lifecycle active; a datasheet the tool
  can fetch; stocked by more than one distributor when the project asks for it; price at the
  build quantity, never at one; cut tape when the project builds in cut tape.
- **Every claim from a tool.** A part number comes from a search result, never from memory. A
  specification comes from the distributor's parametric data or the datasheet; anything else is
  marked unverified with what would confirm it. Say what was not checked.
- **A shortlist, not a winner.** Two to four candidates, one recommendation, the trade-off that
  separates them, and what would change the answer. Say which of them the symbol libraries
  already carry; a missing symbol costs one \`symbol_create\`, it is not a reason to pick
  a worse part.
- **Record it.** Bind the MPN on the symbol and cache the datasheet before placing. A part chosen
  for a reason worth remembering goes under \`committed_parts\` with the reason.
\`\`\`

## 8. \`AGENTS.md\` — tell every session it is in a GoatCAD project

Claude Code and Codex load \`AGENTS.md\` from the project root at the start of every session.
Without a GoatCAD section, a session sees \`.kicad_*\` files and edits them by hand. Write a short
one, under the same read-back and agreement as \`board-intent.md\`.

**It routes; it does not hold.** Every session pays for every line. It says three things:

1. This is a GoatCAD project (https://goatcad.com). The design is worked on through the \`goatcad\`
   MCP tools, which edit what is open in the app as undoable steps; the \`.kicad_*\` files are its
   on-disk format, not something to edit by hand. If the tools are not available, ask the user to
   open the project in GoatCAD.
2. The design context lives in \`board-intent.md\`: call \`project_context\` before choosing a
   part, editing a sheet or drawing a footprint. Link it as \`[board-intent.md](board-intent.md)\`:
   \`project_context\` reads that link as this section being present.
3. Where this project keeps its datasheets, 3D models and footprints, and that they are committed.

**Make it this project's.** Name the board and say in a line what it is. Use the real paths: the
\`.pretty\` library \`fp-lib-table\` registers, the models folder, the datasheets folder. Give any
other part of the repository (firmware, an enclosure, a second board) a line saying what it is and
when to read it. Add another line only if a session on any task here would go wrong without it.

**Keep out** anything \`board-intent.md\` or the \`goatcad\` tools say. Link files with plain
markdown links and say when to read them; never an \`@file\` import, which inlines the whole file
into every session. Stay under about 20 lines.

A shape to start from, for a board called \`canary\`:

\`\`\`
# canary (Bitclock) — a GoatCAD project

This board is designed in GoatCAD (https://goatcad.com). Work on it through the \`goatcad\` MCP
tools, which edit the design open in the app as undoable steps; the \`.kicad_*\` files are its
on-disk format, not something to edit by hand. If the \`goatcad\` tools are not available, ask the
user to open this project in GoatCAD.

Design context, constraints and house style live in [board-intent.md](board-intent.md) — call
\`project_context\` before choosing a part, editing a sheet, or drawing a footprint.

- Datasheets in \`datasheets/\`, 3D models in \`canary.3dshapes/\`, footprints in \`canary.pretty/\`
  — all committed.
- When the user corrects a convention, record it in board-intent.md, not here.
\`\`\`

**An existing \`AGENTS.md\` is the user's file: edit it, do not replace it.** Fold the three points
in where they fit, correcting what it already says rather than repeating it; if an earlier \`init\`
wrote it, update what changed. If the project has a \`CLAUDE.md\` and no \`AGENTS.md\`, write
\`AGENTS.md\` and add one line to \`CLAUDE.md\` pointing at it.`
}
