# Schematic Editor Feature Research

Status: **research reference.** Settled decisions and open items live in **[../schematic-editor-workstream.md](../schematic-editor-workstream.md)** — update that doc, not this one.
Researched: 2026-07-15 (triage settled 2026-07-16)
Baseline: comparisons are against **KiCad 10** (released Mar 2026) unless noted — KiCad 9/10 closed several classic gaps (design blocks, sheet-pin sync, netclass rule areas, native variants, hop-overs, live junction preview during drags).

Goal: define the feature set and toolbar/interaction design for GoatCAD's schematic editor. Constraints: KiCad file compatibility (`.kicad_sch`), shared hotkeys with KiCad where sensible for familiarity, but a modern UX — we are not obligated to copy KiCad's _interaction_ model, only its _data_ model.

---

## 1. What KiCad's toolbar tools actually do (and whether they deserve to exist)

Working through the KiCad right-hand toolbar top to bottom, with answers to the open questions.

### Selection / lasso

KiCad's selection tool does click, drag-box (L→R = contained, R→L = touching), and shift/ctrl modifiers. The "lasso" variant hidden under long-press is rarely used; the box-select directionality convention covers most needs.

**Verdict:** one selection tool, always default, Esc always returns to it. Box-select directionality (contained vs. touching) is worth copying — it's shared with Altium and every MCAD tool. Lasso can be a modifier (e.g. hold a key while dragging) or omitted initially; KiCad itself only added lasso in v10, confirming it's not load-bearing. Agree that long-press-to-swap-tools is bad UX; never hide _modes_ behind long-press. Also adopt KiCad 9's **selection filter** idea (choose which object types are selectable) as a phase-2 nicety — but as a small popover, not a docked panel.

### Highlight net

Click a wire/pin and every element of that net highlights across all sheets (and cross-probes to the PCB editor). The user's instinct is right: **this is not an "add" tool, it's an inspection mode** — it lives on the drawing toolbar in KiCad purely because KiCad's architecture makes every cursor behavior a "tool."

**Verdict:** must-have _capability_, wrong _placement_. Do it as: hover/selection already tints the net (like Flux and modern tools), plus a sticky "highlight net" via a hotkey (KiCad uses `` ` ``) or right-click → Highlight Net. No toolbar mode needed. This also implies we need a real netlist engine early (see §4.1) — highlighting requires computed connectivity, not just drawn geometry.

### Power symbols (separate button from Add Symbol)

The user's suspicion is correct: a KiCad power symbol is just a library symbol whose single pin is an _invisible power-input pin_, which makes its net name **global** — it's effectively a global label wearing a glyph. The separate toolbar button is Add Symbol with a filter to the `power:` library plus a slightly different chooser.

**Verdict:** the _concept_ (a symbol that names a net globally: GND, +3V3) is essential — power distribution by global net name is how every schematic works. The _separate button_ is questionable. Options:

- Fold into the symbol chooser with a "Power" category pinned at top (KiCad's own chooser already does this).
- Better: power symbols are placed so often (a small design places dozens) that a _fast path_ is justified — but as a **hotkey (`P`) + quick-pick of recently used power nets**, not a second toolbar button. Altium treats power ports as their own object type with a dropdown of styles, which users like.

### Wire (`W`)

Core tool. Note KiCad niceties to keep: starts on pin hover with `W` without clicking the toolbar, auto-finishes when landing on a pin, H/V/45 posture toggling (`/` while drawing in KiCad 8+), backspace un-places last segment.

**Verdict:** must-have, and the single most important tool to get _feeling_ right. See §5 for the auto-junction / auto-wire behaviors that should come with it.

### Bus (`B`) and Wire-to-Bus Entry

What buses actually are in KiCad: a bus is a _named bundle_ (`DATA[0..7]` vector buses, or group buses `{SDA SCL}`). Connectivity is resolved **by name**: a wire labeled `DATA3` connected to a bus carrying `DATA[0..7]` joins net `DATA3`. The **bus entry** (the little 45° stub) is a drafting convention — KiCad's own docs admit entries "are graphical only, and are not necessary to form logical connections"; the label makes the connection, the entry just tells KiCad (and the reader) which bus the wire is associated with. You can't connect a pin directly to a bus. Cadence Capture has the _identical_ vestigial model (manual entries, name-only connectivity); Altium makes entries optional and lets wires join buses directly.

The user's read is right: **the separate bus-entry tool is a workaround for the editor not being smart**. A modern editor should auto-insert the entry glyph when you terminate a wire on a bus, and auto-prompt "which member?" with a pick-list of the bus's members (Altium/Allegro both essentially do the pick-list; KiCad has "unfold from bus" on right-click, which is the right idea hidden in a menu).

**Verdict:** buses = nice-to-have (phase 2 — many boards ship without them, but MCU/FPGA work wants them). Bus entry as a _user-facing tool_ = skip; generate entries automatically. We must still _parse and render_ both from day one for KiCad compatibility.

### No-connect flag (`Q`)

Marks a deliberately unused pin so ERC doesn't flag it. Trivial to implement, meaningless without ERC, essential with it.

**Verdict:** must-have (small), ships alongside ERC. Also worth the pro-tool upgrade: right-click a symbol → "No-connect all unconnected pins."

### Junction (`J`)

The dot where wires join. Three things worth knowing:

1. KiCad **auto-inserts junctions** when a wire _ends_ on the middle of another wire (T-junction). The manual tool exists mainly for (a) 4-way `+` crossings, which KiCad deliberately treats as _not connected_ unless a junction is placed, and (b) legacy/cleanup. KiCad 10 added live junction updates during drags and hop-over arcs at unconnected crossings.
2. The "are crossing wires connected?" question is the classic schematic-readability trap. Most style guides ban 4-way junctions outright (use two offset T-junctions). Altium goes further: a "Convert Cross-Junctions" preference automatically turns a would-be 4-way into two offset 3-way junctions, and Flux has no junction tool at all — dots are purely derived.
3. This is the consensus of every modern tool researched: **junctions are output, not input.**

**Verdict:** junctions must exist as _rendered objects_ (they're in the file format) and auto-placement must be right, but a **toolbar button is unnecessary**. Behind-the-fold at most — and adopt Altium's offset-T auto-conversion so the ambiguous 4-way case never arises. Render hop-overs at unconnected crossings (KiCad 10 / Altium "Display Cross-Overs" both landed on this).

### Labels: local / global / hierarchical / netclass directive

Semantics recap:

- **Local label** (`L`): names a net _within one sheet_. Two same-named local labels on the same sheet connect.
- **Global label** (Ctrl+L): connects across _all_ sheets, no hierarchy needed.
- **Hierarchical label** (`H`): a child sheet's "port" — connects only up to a matching **sheet pin** on the parent's sheet symbol.
- **Netclass directive label**: attaches a netclass (routing rules) to a wire — it's a _rule annotation_, not connectivity.

Four visually-similar objects behind one long-press button is the worst discoverability spot in KiCad, and the user is right to call it out. But the _distinction_ is real and pros rely on it (Altium has the same split: net labels / ports / power ports). Local-vs-global scoping prevents the classic "two sheets both used net name `CLK` and merged accidentally" bug.

**Verdict:** must-have (all three connectivity label types; directive labels phase 2 with netclass support). UX: one **Label tool (`L`)** that places a label and lets you switch kind in-place (Tab or a small floating segmented control: Local / Global / Hierarchical), plus dedicated hotkeys matching KiCad for muscle memory. Autocomplete existing net names in the label editor (KiCad does this; it's essential).

### Rule areas in schematic

New in KiCad 9. A drawn region that applies a rule to everything inside — primarily "assign netclass to all nets crossing this area" and ERC/DNP-style exclusions. It's a power-user convenience for bulk netclass assignment (e.g., draw a box around a DDR region → all nets get the `DDR` class).

**Verdict:** add-later (phase 3). Requires netclasses + ERC to mean anything. Parse/render for compatibility.

### Hierarchical sheets / Place sheet pins / Sync sheet pins

How KiCad hierarchy works: a parent schematic contains a **sheet symbol** (a rectangle) pointing at a child `.kicad_sch` file. The child declares its interface with **hierarchical labels**; the parent's sheet symbol exposes matching **sheet pins** on the rectangle's border; wires connect to those pins.

The three tools the user flagged:

- **Draw hierarchical sheet**: draws the rectangle _and_ creates/links the child file. Agree the name is bad — it's "Add child sheet." (Our sidebar already renders the sheet tree; see ARCHITECTURE.md §3.2.)
- **Place sheet pins**: imports the child's hierarchical labels onto the parent's sheet symbol one at a time (you click to place each).
- **Sync sheet pins**: batch-reconciles pins ↔ labels after the child changed (added in KiCad 9 — an implicit admission the manual flow was painful).

The user's instinct is right: **pins-vs-labels is a denormalization the user shouldn't manage**. The pin _placement_ (which edge, what order) is legitimately a user decision — the _existence and names_ of pins should always mirror the child's hierarchical labels automatically. Altium has the identical wart (Sheet Symbol ↔ Sheet Entries, "Synchronize Sheet Entries"); this is our chance to do better: live-sync existence/names/direction, let users only re-arrange placement, and show an inline "interface changed" affordance instead of a menu command. Worth copying from Altium here: auto-generated **port cross-references** (each port/pin annotated with the sheet+location of its counterparts) — KiCad users maintain these by hand.

**Verdict:** hierarchy = must-have (the file format and real designs depend on it; we already parse it). "Place/Sync sheet pins" as user-invoked tools = **skip; replace with automatic sync**.

### Text / Text box / Table / Rectangle / Circle / Arc / Bezier / Line / Image

Annotation graphics. Text and Line (notes, dividers) are common; tables (pin-map documentation) occasional; bezier rare.

**Verdict:** Text = toolbar. Everything else = behind-the-fold in the OnShape-style searchable "insert" affordance the user described. All must round-trip in the file format regardless.

### Interactive delete tool

Click-to-delete cursor mode. Exists because 1980s-lineage EDA tools were built modal; with a decent selection tool (click + Del, drag-box + Del) it's redundant. Even KiCad users mostly don't touch it.

**Verdict:** skip. (Keep `Del`/`Backspace` on selection, of course.)

---

## 2. KiCad hotkeys to adopt (muscle-memory compatibility)

Defaults from KiCad 8/9 eeschema worth honoring (verify against KiCad's Preferences → Hotkeys export before implementing):

| Key                  | Action                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `Esc`                | cancel tool → selection                                                             |
| `A`                  | add symbol                                                                          |
| `P`                  | add power symbol                                                                    |
| `W`                  | wire (starts at cursor)                                                             |
| `B`                  | bus                                                                                 |
| `L` / `Ctrl+L` / `H` | label / global label / hierarchical label                                           |
| `J` / `Q`            | junction / no-connect                                                               |
| `T`                  | text                                                                                |
| `M` / `G`            | move / drag (drag keeps wires attached)                                             |
| `R`, `X`, `Y`        | rotate, mirror-X, mirror-Y (during placement too)                                   |
| `E`                  | edit properties (`V` value, `U` reference, `F` footprint)                           |
| `C`                  | duplicate ("clone")                                                                 |
| `Ins`                | repeat last item (with auto-increment — beloved for resistor arrays / pin labeling) |
| `` ` ``              | highlight net                                                                       |
| `/`                  | toggle wire posture (H/V first) while drawing                                       |
| `Backspace`          | un-place last wire segment while drawing                                            |
| `Ctrl+Z/Y`           | undo/redo (already implemented)                                                     |

Two KiCad idioms that _feel_ like hotkeys and matter as much:

- **Hover-hotkeys**: pressing `R`/`E`/`M`/`V` acts on the item _under the cursor_ without selecting first. Pros live on this.
- **Move vs Drag distinction** (`M` vs `G`): drag maintains wire connectivity. Modern take: make connectivity-preserving drag the _default_ and plain move the modifier.

---

## 3. Pro-tool gap analysis

### 3.1 Altium Designer

What pros actually rely on, and what it teaches us:

**Connectivity & editing (directly relevant to phase 1):**

- **Auto-junctions, done right.** Junctions are compiler-generated at every T-meeting of wires/buses and where wires land on pins. 4-way crossings do _not_ connect; a "Convert Cross-Junctions" preference turns a would-be 4-way into two offset 3-way junctions automatically, and unconnected crossings can render a visual hop/gap. Manual junctions exist but are discouraged. This validates §5.1 — and the offset-T auto-conversion is worth copying outright.
- **Drag-preserves-connectivity as the default.** "Always Drag" is the default preference (hold Ctrl to get a bare move). During the drag, the cursor shows an **OK icon when connectivity is preserved and an Alert icon when the gesture would rewire the circuit** — live connectivity-diff feedback mid-gesture. This is the single most-praised editing behavior vs KiCad's historically fragile wire dragging. Caveat: aggressive auto-connect also causes accidental merges when moved pins align with unrelated wires — the alert mitigates but doesn't eliminate; we should require explicit confirmation or a stronger visual before merging nets on drop.
- **Wire placement modes:** Spacebar toggles corner direction, Shift+Space cycles 90°/45°/any-angle/**auto-wire** (auto-routes between two clicked points avoiding obstacles), Backspace removes last vertex.
- **Tab-to-edit-while-placing:** during any placement, Tab pauses and opens properties; edited values become defaults for subsequent placements (set a resistor value once, place ten). The #1-cited Altium idiom — cheap to build, huge payoff.
- **Shift+F1 during any interactive command** lists every shortcut valid _at that moment_ — discoverable modality. Pairs naturally with our search-overlay plans.
- **Smart Paste (Shift+Ctrl+V):** pastes clipboard _transformed between object types_ — net labels ↔ ports ↔ sheet entries ↔ plain text — plus Paste Array with designator/net auto-increment. Canonical use: paste a datasheet pin table as a column of net labels. Nothing like it in KiCad.
- **Rubber Stamp (Ctrl+R)** repeated-stamp duplicate; Insert-style auto-increment during placement (configurable deltas).

**Structure & scale features (phase 2+):**

- **Signal Harnesses:** bundles of wires + buses + nested harnesses flowing through hierarchy as one line (SPI, RGMII as single objects). Backed by plain-text `.Harness` definition files. KiCad has no equivalent (its importer breaks them). Big pro draw; a candidate for our "beyond KiCad" list — but note anything we author must still round-trip to `.kicad_sch`, so this likely waits for a KiCad-compatible encoding story.
- **Net identifier scope is a project setting** (Automatic / Flat / Hierarchical / Strict-Hierarchical — the latter makes even power ports sheet-local), vs KiCad choosing scope per-label. Strictness as a project policy is a genuinely better model for teams; worth considering as a project-level _lint_ even while the file format keeps per-label semantics.
- **Port cross-references:** auto-generated text on each port showing sheet/grid of counterparts. KiCad users do this by hand. Cheap, high-value documentation feature.
- **Multi-channel design:** `Repeat(CIN,1,8)` on a sheet symbol logically instantiates a child sheet 8 times — drawn once, stepped out at netlist time, with per-channel designator schemes, auto-generated PCB rooms/classes, and copy-one-channel's-placement-to-all on the board. One of the most-cited reasons pros stay on Altium; KiCad's answer (manual sheet clones + layout-replication plugins) is far weaker. Hard with pure-KiCad files (which materialize instances), but our hierarchy code already treats sheet _instances_ as first-class — worth keeping in view.
- **Design reuse:** Device Sheets (validated read-only circuit sheets placed by reference), Snippets (stamp saved circuit chunks), and Reuse Blocks (schematic + routed layout paired). KiCad 9's "design blocks" are a partial answer.
- **Variants:** first-class assembly variants — Fitted / Not-Fitted / alternate-part per variant, propagating to BOM, assembly outputs, even paste-mask suppression. Long cited as a top professional gap in KiCad; **KiCad 10 (Mar 2026) finally shipped native design variants**, so for us this is now a file-format-compatibility requirement rather than a differentiator (§4.3 updated).
- **Constraint directives in the schematic:** Parameter Set directives attach PCB rules/classes to a net; **Blanket** regions apply a directive to every net inside (composable with net classes); Differential Pair directives (with `_P`/`_N` naming) generate PCB diff-pair rules; NoERC markers suppress specific violations at a node; **Compile Mask** regions hide WIP circuitry from validation entirely. The schematic is the _source of truth for constraints_, pushed to layout via ECO. KiCad 9's rule areas + directive labels are a thinner version. Compile Mask ("this region is WIP, don't lint it") is a great idea ERC-day-one.
- **Validation model — a cautionary tale:** Altium used to require a manual "Compile" step; AD20 replaced it with a **dynamic data model updated incrementally on every edit**, red squiggles in-canvas, and a Messages panel. Altium itself abandoned batch compile — strong confirmation for §5.6 (live ERC) and §4.1.7 (early connectivity engine).
- **ECO-based bidirectional sync:** every schematic↔PCB change is previewed as a diff list and approved (Engineering Change Order), vs KiCad's one-shot "Update PCB from Schematic." Also back-annotation of layout changes to schematic.
- **ActiveBOM / sourcing:** a BOM document inside the project with live Octopart-fed part "Solutions" (price breaks, stock, lifecycle), auto-ranked; obsolete/out-of-stock parts get caught at capture time. Combined with DbLib (company parts database driving symbol+footprint+parameters), this is the component-management moat. KiCad 7+ database libraries lack the supply-chain feed. Aligns with GoatCAD's stated partner-integration direction.
- **Cross-probe/cross-select:** continuous probe mode (stay in schematic, keep clicking, PCB follows) and bidirectional selection sync with configurable zoom behavior. We own both editors in-process — should be trivially better than either tool's IPC-based version.

**Altium warts to avoid:**

- Shipping half-baked flagship features (Constraint Manager, Layer Stack Manager both landed buggy) — users notice and it burns trust.
- Poor performance on large designs (complaints vs OrCAD "night and day").
- Opaque binary formats that can't diff/merge in git — KiCad's s-expression text files are a real advantage we inherit; never break diffability.
- Setup ceremony: project options / output jobs / DbLib pipelines make starting a design "quite hard" — keep KiCad's instant-start property.
- Windows-only. (We're cross-platform by construction.)

### 3.2 Cadence (OrCAD Capture / Allegro X System Capture)

**The structural headline: constraints live in the schematic.** Capture embeds the same Constraint Manager spreadsheet used in layout — reusable named rule sets ("Electrical CSets") applied to net classes; differential pairs and delay-matched groups are _schematic-level objects_; the EE encodes performance intent once and layout inherits it. Cadence also has **XNets** (a net extended through series passives — net + AC-coupling cap = one timing entity), a concept KiCad lacks entirely. For GoatCAD: netclass directives (already in the KiCad format) are the thin end of this wedge; a spreadsheet-style constraint view spanning schematic+PCB is a credible long-term differentiator since we own both editors.

**CIS — why big companies mandate Capture.** The schematic editor is linked to a corporate parts database: parametric search inside the editor with symbol+footprint preview, placed parts stamped with corporate part number/procurement fields, and a **Part Manager** dashboard color-coding every part's status (Approved / Temporary / Obsolete). The killer workflow detail: engineers can place a _temporary_ part to keep moving, and the status system makes unresolved parts impossible to miss — librarians resolve them later. Variants are CIS-native (DNI + alternate-part per variant with diff-vs-core BOM reports). Same conclusion as Altium's ActiveBOM/DbLib: **database-driven parts with lifecycle/sourcing status is the moat feature for professional adoption**, and it lives at capture time, not BOM-export time.

**Hierarchy model — a cautionary tale.** Capture separates _instances_ (what you draw) from _occurrences_ (each expansion of a reused hierarchical block), with property inheritance between the layers. It's how Capture does true draw-once-stamp-N reuse (occurrence-mode annotation gives the reused block distinct refdes per copy — the same model as KiCad's per-path `instances` data we already parse). But the duality is a chronic support-ticket generator: editing an occurrence property _silently flips the design's annotation mode_, with a buried menu command to undo it. **Lesson: our sheet-instance model should keep inheritance explicit and visible, never mode-switching.**

**Wiring UX:** auto-junctions on wire-end-meets-wire (parity with modern tools); bus entries still manual and bus↔wire connection is _by name only_ (a wire touching a bus makes no electrical connection — same vestigial model as KiCad, so no one to copy here). Two things worth stealing: **`Place > Auto Wire > Two Points`** (click two pins, the editor routes the wire around obstacles — matches Altium's auto-wire mode) and **NetGroups** — named heterogeneous bundles (wires + buses mixed) instantiated as one graphical object and constrained as a unit; strictly more powerful than KiCad buses, though users report the implementation is flaky (the concept is valued more than the code).

**ECO / back-annotation:** Design Sync is bidirectional with a "changes only" diff report; layout-side **gate swaps, pin swaps, and refdes renames** (e.g., renumbering by board position) flow back to the schematic automatically. Allegro X adds a collaboration server (Pulse) that turns schematic↔layout sync into tracked, versioned events with an "update available" indicator in the other editor. KiCad mostly can't back-annotate; we own both editors in one process, so a diff-previewed bidirectional sync is very achievable and highly differentiating.

**Where Cadence is heading (Allegro X System Capture):** schematic as the "EE cockpit" — docked constraint manager, **Live BOM** with supply-chain data updating as you draw, built-in scriptable schematic audits (beyond ERC: device-selection checks, electrical-overstress/derating analysis), multi-board system diagrams with connector-mating integrity checks, real-time multi-user editing, cloud parts libraries. Confirms the industry direction: capture-time intelligence, not export-time.

**Cadence warts to avoid:** dated modal UI split across separate apps (Capture/CM/PCB Editor as different windows — our single-shell architecture is the antidote); undocumented binary `.DSN` format with lock-file corruption stories (keep text formats diffable); one-way doors (enabling Constraint Manager is irreversible; new versions can't save down — never do either); weak keyboard accelerators (no hotkey to highlight a net!); library creation universally cited as the biggest time sink — symbol/part creation UX deserves real design attention, not an afterthought.

### 3.3 Modern tools (Flux, EasyEDA Pro, LibrePCB, Horizon, atopile/tscircuit)

**Interaction models worth stealing:**

- **Horizon EDA's spacebar menu** is the proven command-palette-in-EDA: press Space → type-to-search every canvas action, plus vim-style multi-key bindings and `?` to list them. Tools are _transient_ (self-terminating or Esc), not persistent toolbar modes. An HN commenter rated Horizon "squarely better than both KiCad and LibrePCB" on feel. This is the strongest validation of our §6 search-overlay plan — and no mainstream tool (KiCad/Altium/EasyEDA) has a global palette unifying commands + parts + nets + sheets. Open niche.
- **Horizon is net-aware by design**: its author's stated motivation was KiCad's "schematic editor not knowing about nets"; Horizon _prompts before merging two nets_. Same conclusion as Altium's alert-icon drag feedback — net merges must never be silent. (Reinforces §4.1.7.)
- **Flux wiring micro-UX**: drawing a wire across multiple pins connects all of them; parallel overlapping segments auto-merge; junction dots are purely automatic (no tool at all); DRC runs continuously in the background with click-to-jump violations. Largely modeless — wires start by dragging from pins, no armed toolbar mode.
- **Flux Copilot**: describe-to-place (prompt → wired subcircuit), datasheet-driven suggestions. Relevant to GoatCAD's stated ML direction; not a phase-1/2 concern but the data model (clean netlist + part metadata) is the prerequisite.

**Part/component model (the part KiCad never solved):**

- HN critique: KiCad has "no coherent/opinionated workflow" for managing the symbol/footprint/3D/datasheet association. EasyEDA Pro's answer is a single **"Device"** object bundling symbol + footprint + 3D + attributes + LCSC part number; Horizon's is Unit/Entity/Part layering; LibrePCB shows live lifecycle/availability/price on parts in-editor.
- **EasyEDA is the sourcing benchmark**: search → live LCSC stock/price → place; the BOM is purchase-ready with real stocked part numbers. LibrePCB does lifecycle/stock/price via a parts API. This plus Altium's ActiveBOM makes sourcing-at-capture-time the clearest "pros expect it, KiCad lacks it" feature.
- **atopile/tscircuit** (code-based EDA): transferable ideas are _parametric part picking_ (declare 10kΩ ±1% 0402 → compiler picks a real stocked part), compile-time validation as editor squiggles (LSP-style), and package-manager-grade circuit reuse; tscircuit does automatic schematic layout by default.

**KiCad's own trajectory — the moving baseline (important):**

- **KiCad 9 (Feb 2025)** shipped: **design blocks** (reusable schematic subcircuits from a library panel), a **sheet-pin ↔ hierarchical-label sync tool** (acknowledging the pain — but still a command, not an invariant), selection filter, **netclass rule areas**, component classes.
- **KiCad 10 (Mar 2026)** shipped: **design variants** (native!), **hop-over arcs at unconnected wire crossings**, **live junction updates + short-circuit warnings during wire drags** (their first net-aware live feedback), schematic grouping, local power symbols, lasso selection, customizable toolbars, pin-table CSV import/export.
- Still missing from KiCad even at v10: live/continuous ERC (still a manual dialog; users bolt CI onto `kicad-cli` instead), custom ERC rules (open request), a coherent part-management model, sourcing integration, multi-channel `Repeat()`.

**ERC landscape:** Flux = continuous background checking; LibrePCB = schematic/board share one netlist so they can't desync; atopile = LSP diagnostics. KiCad/Altium/EasyEDA schematic checks remain on-demand (Altium's _connectivity model_ is live since AD20, but ERC still runs as Validate). Continuous in-canvas ERC remains genuinely differentiating.

### 3.4 Synthesis — ranked opportunities (what pros have that KiCad still lacks, post-v10)

1. **Live, continuous ERC** with in-canvas markers + a Problems-panel view — every vendor's trajectory points here; none of the big three actually ships it. Needs a "WIP mask" escape hatch (Altium's Compile Mask) so unfinished circuitry doesn't scream.
2. **Net-aware editing feedback** — never silently merge or split a net: Altium's OK/Alert drag icons, Horizon's merge confirmation prompt. KiCad 10's drag-time short-circuit warning is a first step; go all the way.
3. **Part model + sourcing at capture time** — one "device" object (symbol+footprint+3D+MPN), live stock/price/lifecycle (EasyEDA/LibrePCB/ActiveBOM/Live BOM all converge here), and Capture's Approved/Temporary/Obsolete part-status states. Fits GoatCAD's stated partner-integration direction. Library/part _creation_ UX is the universally-cited time sink — design it deliberately.
4. **Command palette unifying commands + parts + nets + sheets** (Horizon's spacebar menu, generalized). No mainstream tool has it; cheap for us since it's pure UI.
5. **Bidirectional schematic↔PCB sync with diff preview** (ECO-style), incl. refdes-rename/pin-swap back-annotation — uniquely easy for us because both editors share one process and one AST.
6. **Placement-time power idioms**: Tab-to-edit-while-placing, auto-increment repeat, Smart-Paste-style transforms, auto-wire between two pins, rubber stamp.
7. **Multi-channel / draw-once-stamp-N** (Altium `Repeat()`, Capture occurrence model) — the format's per-instance data supports it; the editors don't. Long-term.
8. **Constraint authoring from the schematic** beyond netclasses (diff pairs, matched groups, spreadsheet view) — long-term, pro-tier.

---

## 4. Features to triage

### 4.1 Must-have (phase 1 — a usable editor)

1. **Selection** (click, box w/ directionality, hover-highlight) — partially exists.
2. **Move/drag with wire connectivity maintained** — drag is table stakes; pure move is the special case.
3. **Wire tool** with auto-junction, pin-snap, posture toggle, auto-complete-on-pin.
4. **Symbol placement** — chooser with search-first UX (this is the biggest single UX win over KiCad's blocking modal; think Figma/OnShape insert), power-symbol fast path, **Tab-to-edit-while-placing** (edited values become defaults for subsequent placements — Altium's #1-cited idiom, cheap to build).
5. **Labels** (local/global/hierarchical) with net-name autocomplete (and pre-fill the last-used name — a documented KiCad micro-gripe).
6. **No-connect flags.**
7. **Real connectivity engine** (geometry → netlist): everything above (highlight, ERC, label semantics, junction auto-placement) sits on it, and it's what makes the editor _net-aware_ — Horizon's author names KiCad's net-blindness as its core flaw. Build it early; it's the schematic editor's equivalent of the PCB editor's net model. Includes the invariant: **never merge/split a net silently** (confirm or clearly signal, per Altium/Horizon).
8. **Annotation (reference numbering) on placement** — KiCad 8+ has this but as an opt-in-flavored preference; make it the unambiguous default and demote batch annotation to a "renumber" utility.
9. **Delete/duplicate/rotate/mirror + Ins-repeat with auto-increment.**
10. **Edit properties inline** (E / double-click; V/U/F fast paths) — properties panel already exists.

### 4.2 Nice-to-have (phase 2)

- Buses (vector + group) with member pick-list ("unfold") and auto bus entries.
- ERC (live, as-you-edit, VS-Code-Problems-panel style — not KiCad's modal batch dialog) + no-connect enforcement + a WIP-region mask (Altium Compile Mask) so unfinished circuitry doesn't drown the panel.
- Netclasses + directive labels (feeds the PCB editor's routing rules).
- Hierarchy authoring UX: create child sheet, auto-synced sheet pins, port cross-references.
- Cross-probe schematic ↔ PCB (we own both editors in one app — this should be a headline feature, not an afterthought). Continuous mode (keep clicking in schematic, PCB follows) per Altium.
- Find/jump (component, net, pin) — folds into the command palette (§3.4.4).
- Command palette (Space or Ctrl+K): commands + placeable objects + jump-to-net/component/sheet. Same affordance as the §6 insert-search; build once.
- Placement power tools: auto-wire between two points, rubber stamp, Smart-Paste-style transforms (start with "paste text column as labels").

### 4.3 Add-later (phase 3)

- Assembly variants — KiCad 10 now has native design variants, so this is _format compatibility_ work (parse/respect/round-trip) rather than invention; ride their data model.
- Rule areas / component classes (KiCad 9 format features).
- Design blocks (KiCad 9) → longer-term multi-channel / draw-once-stamp-N reuse.
- Bidirectional ECO sync with diff preview + back-annotation (refdes renames, swaps) — coordinate with PCB editor roadmap.
- Simulation hooks (SPICE directives round-trip in the format).
- BOM/sourcing intelligence (live availability/pricing/lifecycle at capture time; part-status states à la CIS) — the pro moat feature, and GoatCAD's stated partner-integration direction.

### 4.4 Behind-the-fold (present but not on the toolbar)

Graphic shapes (rect/circle/arc/bezier/line), text box, table, image, junction (manual), bus entry (manual, if ever), rule areas — all reachable via the searchable insert overlay ("press `/` or click search: shows icon+name grid of everything placeable").

### 4.5 Skip (deliberately)

- Interactive delete tool.
- Separate lasso mode (modifier key instead, if at all).
- Manual "Place/Sync sheet pins" commands (replaced by auto-sync).
- Highlight-net as a _toolbar mode_ (it's selection behavior + a hotkey).

---

## 5. Design principles ("what a well-designed editor wouldn't need")

Patterns where KiCad's toolbar exists to compensate for missing smarts; each is a chance to delete a concept:

1. **Auto-junctions everywhere** — junction correctness is the editor's job, not the user's. The only user decision is the 4-way-cross policy; consider banning it for readability.
2. **Bus entries are output, not input** — terminate a wire on a bus → the entry glyph and member-name prompt appear.
3. **Sheet pins mirror hierarchical labels, always** — sync is not a command, it's an invariant. User only arranges pin placement.
4. **One label tool, kind switchable in place** — with scope made _visible_ (distinct glyphs, KiCad-compatible) so global vs local is never a surprise.
5. **Annotate on placement** — batch annotation demoted to a "renumber" utility.
6. **ERC is continuous** — squiggles/markers, not a modal report. (Modern tools and IDEs won this argument years ago.)
7. **Search-to-place beats toolbar archaeology** — main toolbar carries ~6 high-frequency tools; everything else via typed search with icons for discoverability (the OnShape pattern; Horizon's spacebar menu proves it works in an EDA canvas).
8. **Esc is sacred** — always returns to selection; a placed tool stays active for repeat placement until Esc (KiCad behavior, keep it). Tools are _transient_, never silently sticky modes (Horizon's model).
9. **Never change a net silently** — merges and splits get confirmation or unmissable feedback during the gesture (Altium's OK/Alert cursor, Horizon's merge prompt).
10. **No one-way doors, no binary blobs** — every feature must round-trip `.kicad_sch` text and never lock a project into a mode it can't leave (anti-lessons from Cadence CM enablement and `.DSN`).

---

## 6. Decisions & roadmap → workstream doc

The settled interaction decisions and the open items live in **[../schematic-editor-workstream.md](../schematic-editor-workstream.md)**. This file stays frozen as the research reference behind them.

## Appendix: research provenance

Compiled 2026-07-15 from three parallel web-research passes (Altium Designer docs/forums, Cadence OrCAD/Allegro docs + EMA/Parallel Systems notes + EEVblog, and modern-tool sources: Flux docs/blog, Horizon EDA docs, LibrePCB compare page, EasyEDA/LCSC, atopile/tscircuit docs, KiCad 9/10 release notes, kicad.info + HN threads). Claims about vendor features cite their marketing/docs and should be spot-checked in-product before copying interaction details exactly.
