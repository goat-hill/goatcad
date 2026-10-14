# KiCad S-Expression File Format Reference

Local reference for agents working on KiCad file parsing in the GoatCAD project.

**Source**: [KiCad Developer Documentation](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/)

> ## Read this first: this file is not the authority
>
> **The grammar here is a cache, and a cache goes stale.** It has already been wrong once in a way that
> cost real work: its text-effects grammar omitted `(font (color …))`, so an audit run against *this
> file* concluded KiCad had no per-text color — while KiCad's own dialog writes one.
>
> **Nor is dev-docs the authority.** Measured against the 222 libraries KiCad ships, the upstream
> symbol grammar is also missing `exclude_from_sim`, `in_pos_files`,
> `duplicate_pin_numbers_are_jumpers`, `alternate` (876k occurrences), `show_name`,
> `do_not_autoplace` and symbol `text_box`. Upstream documents the format as of some past release; KiCad
> writes the format as of this one.
>
> **The authority is what KiCad writes.** Census the real files before concluding an attribute does not
> exist — `/usr/share/kicad/symbols/*.kicad_sym` (machine-specific path) and the canary test fixture
> (`electron/src/renderer/src/lib/__tests__/fixtures/canary/`):
>
> ```
> cat /usr/share/kicad/symbols/*.kicad_sym | grep -oE '^\s*\(([a-z_0-9]+)' | tr -d ' (' | sort | uniq -c | sort -rn
> ```
>
> Then check the grammar of what you found against dev-docs, and fetch dev-docs directly (it is online
> and reachable) rather than trusting the copy below. **What this file is genuinely for** is the part
> upstream does not have: which versions we target, what our parser tolerates, and the traps we have hit
> (decidegree angles on symbol text, `(color …)` living on the font rather than on effects, the
> `(0 0 0 0)` unset sentinel). Keep adding those; do not keep growing the grammar transcription.

---

## S-Expression Syntax

- Based on Specctra DSN format
- Tokens delimited by `(` and `)` parentheses
- All token names are lowercase with underscores
- Strings are double-quoted, UTF-8 encoded
- Numeric values are decimal (integers and floats)
- Comments: lines starting with `#` (not standard in KiCad files but used in some contexts)
- Whitespace (spaces, tabs, newlines) separates tokens
- All coordinates are in **millimeters**
- Y-axis is **inverted** in board coordinates (positive Y = down)

---

## Footprint File Format (.kicad_mod)

### Top-Level Structure

```sexpr
(footprint "NAME"
  (version YYYYMMDD)
  (generator "PROGRAM")
  (generator_version "VERSION")    ; v8+ only
  (layer "F.Cu")
  (descr "Description text")
  (tags "tag1 tag2")
  (attr smd|thru_hole)

  ;; Properties (v8+ replaces fp_text reference/value)
  (property "Reference" "REF**" ...)
  (property "Value" "VALUE" ...)

  ;; Text (v5/v6 style, replaced by property in v8+)
  (fp_text reference "REF**" ...)
  (fp_text value "VALUE" ...)

  ;; Graphic Items
  (fp_line ...)
  (fp_arc ...)
  (fp_circle ...)
  (fp_rect ...)
  (fp_poly ...)

  ;; Pads
  (pad ...)

  ;; 3D Model
  (model "PATH" ...)
)
```

### Pad Definition

```sexpr
(pad "NUMBER" TYPE SHAPE
  (at X Y [ANGLE])
  (size W H)
  (drill DIAMETER)                          ; simple drill
  (drill oval WIDTH HEIGHT)                 ; oval drill
  (drill DIAMETER (offset X Y))            ; offset drill
  (layers "LAYER1" "LAYER2" ...)
  (roundrect_rratio RATIO)                 ; for roundrect shape
  (chamfer_ratio RATIO)                    ; for chamfer
  (chamfer top_left top_right ...)         ; which corners
  (net NUMBER "NAME")                      ; only in board context
  (uuid "UUID")
)
```

**Types**: `smd`, `thru_hole`, `np_thru_hole`, `connect`
**Shapes**: `rect`, `circle`, `oval`, `roundrect`, `trapezoid`, `custom`

### Graphic Items

**Line** (v7+ with stroke, v6 with width):

```sexpr
;; v7+ style
(fp_line (start X1 Y1) (end X2 Y2)
  (stroke (width W) (type default|solid|dash|dot|dash_dot|dash_dot_dot))
  (layer "LAYER")
  (uuid "UUID"))

;; v6 style
(fp_line (start X1 Y1) (end X2 Y2) (layer LAYER) (width W))
```

**Arc**:

```sexpr
(fp_arc (start X Y) (mid X Y) (end X Y)
  (stroke (width W) (type TYPE))
  (layer "LAYER")
  (uuid "UUID"))
```

**Circle**:

```sexpr
(fp_circle (center X Y) (end X Y)
  (stroke (width W) (type TYPE))
  (layer "LAYER")
  (fill none|solid)
  (uuid "UUID"))
```

**Rectangle**:

```sexpr
(fp_rect (start X1 Y1) (end X2 Y2)
  (stroke (width W) (type TYPE))
  (layer "LAYER")
  (fill none|solid)
  (uuid "UUID"))
```

**Polygon**:

```sexpr
(fp_poly (pts (xy X Y) (xy X Y) ...)
  (stroke (width W) (type TYPE))
  (layer "LAYER")
  (fill none|solid)
  (uuid "UUID"))
```

### Property / Text

**v8+ Property**:

```sexpr
(property "KEY" "VALUE"
  (at X Y [ANGLE])
  (layer "LAYER")
  (hide yes)                              ; optional
  (uuid "UUID")
  (effects (font (size W H) (thickness T))))
```

**v5/v6 fp_text**:

```sexpr
(fp_text reference|value|user "TEXT"
  (at X Y [ANGLE])
  (layer LAYER)
  (effects (font (size W H) (thickness T))))
```

### 3D Model Reference

```sexpr
(model "${KICAD10_3DMODEL_DIR}/Category.3dshapes/Model.step"
  (offset (xyz X Y Z))
  (scale (xyz X Y Z))
  (rotate (xyz X Y Z)))
```

The model path uses environment variables that vary by KiCad version:

- v6: `${KICAD6_3DMODEL_DIR}`
- v7: `${KICAD7_3DMODEL_DIR}`
- v8: `${KICAD8_3DMODEL_DIR}`
- v9: `${KICAD9_3DMODEL_DIR}` or `${KICAD_3DMODEL_DIR}`
- v10: `${KICAD10_3DMODEL_DIR}`

3D models come from the [kicad-packages3D](https://gitlab.com/kicad/libraries/kicad-packages3D) repository.

---

## Canonical Layer Names

### Copper Layers

`F.Cu`, `B.Cu`, `In1.Cu` through `In30.Cu`

### Technical Layers (Front/Back)

`F.SilkS` / `B.SilkS` — Silkscreen
`F.Mask` / `B.Mask` — Solder mask
`F.Paste` / `B.Paste` — Solder paste
`F.Fab` / `B.Fab` — Fabrication
`F.CrtYd` / `B.CrtYd` — Courtyard
`F.Adhes` / `B.Adhes` — Adhesive

### Wildcard Layers

`*.Cu` — All copper layers
`*.Mask` — All mask layers

---

## Versions we read and write

The rule is RULES.md §7: read every version, write only the current one (KiCad 10), migrate an
older file on its first save. This section is the detail behind it.

### What each release writes

The `(version …)` a release stamps, from the `SEXPR_*_FILE_VERSION` history in KiCad's source
(`pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h`, which marks each release's development start, and
`eeschema/sch_file_versions.h`). A footprint (`.kicad_mod`) takes the board's version.

| KiCad | `.kicad_pcb` / `.kicad_mod` | `.kicad_sch` | `.kicad_sym` | Headline change                                                            |
| :---- | :-------------------------- | :----------- | :----------- | :------------------------------------------------------------------------- |
| 6     | 20211014                    | 20211123     | 20211014     | S-expression schematics; uuids; arc formatting                             |
| 7     | 20221018                    | 20230121     | 20220914     | `(stroke …)` on graphics, fonts, text boxes                                |
| 8     | 20240108                    | 20231120     | 20231120     | `(property …)` on footprints, `generator_version`, boolean `(hide yes)` on boards |
| 9     | 20241229                    | 20250114     | 20241209     | tables, embedded files, via stacks, schematic `(hide yes)` (20241004)      |
| 10    | 20260206                    | 20260306     | 20251024     | variants, custom body styles, stacked pins, `~` is literal text (20250318) |

A version between two rows is a development build; it reads as the release that follows it. The floor
is KiCad 6's row (`MIN_FORMAT_VERSION` in `lib/kicad/migrate.ts`): anything older — KiCad 5 boards and
footprints, KiCad 6 development builds — opens read-only, since its migration (old arc geometry, overbar
syntax, instance data) is out of scope. KiCad 5's schematics (`.sch`, `.lib`) are not S-expressions at
all; KiCad imports them.

### Reading

The parser keeps every node it does not understand, so any version parses. Where a later release
changed what the same syntax means, reading branches on the file's version, and **reading is the only
place that does**:

- **Board layer ids** were renumbered in v9 (20241229): before it F.Cu 0, inner layers 1–30, B.Cu 31;
  from it F.Cu 0, B.Cu 2, In*n*.Cu 2*n*+2, and 31 is F.CrtYd. Never infer stack order from an id — use the
  layer table's order (`board/spatialIndex.ts` does) or the name.
- **Net references** are by name from v10 (20251028, netcodes no longer written), by number before.
- **`~`** means empty text before 20250318 and is literal from it.
- **`hide`** is a bare token in schematics before 20241004 and `(hide yes)` from it; boards and
  footprints switched in v8 (20231212). Accept both spellings everywhere.

### Writing: one dialect, and migration on first save

- **Everything we write is v10**: new content, new files (`project/templates.ts`), and every save. No
  writer branches on a file's version; a second dialect is exactly the per-version support we do not
  carry.
- **An older file becomes v10 on its first save.** It is migrated in memory as it is read — editors
  only ever see KiCad 10's — and nothing reaches disk until a save, which writes it even unedited
  (ARCHITECTURE.md, "KiCad versions"). The migration is a
  pure function per file type over the AST. **The bar is equivalence**: pushed through `kicad-cli
  <kind> upgrade --force`, our save and the original produce the same bytes, apart from uuids KiCad
  generates for items that had none — KiCad reads the same design from both. Byte-identical to
  KiCad's own upgrade, so the commit diffs the same whichever app made it, is the goal where it stays
  tractable, not the gate. Checked by `./bin/test-parity` on a corpus (the sample projects, KiCad's
  `qa/data/` and `demos/`).
- **The project file is migrated too.** The CLI never touches `.kicad_pro`; KiCad's GUI fills in every
  section it owns with defaults on its first save (`erc` with `rule_severities` and `pin_map`, the full
  `schematic` section, one `sheets` entry per sheet, the root's real uuid in `top_level_sheets`), and so
  does ours.
- **A current-version file keeps the lossless round-trip**: a save that moved one symbol diffs to that
  symbol.
- **What the migration does is the meaning changes only**: each step in `lib/kicad/migrate.ts` ports
  one of KiCad's parser version gates (the `~` that meant empty, legacy footprint properties, layer
  ids, via protection, instance data and the other open-time fixups, …). KiCad's own upgrade also
  writes defaults out and respells legacy syntax — `show_name`, `(hide yes)`, dropping
  `fields_autoplaced`, reordered library graphics — which KiCad reads either way, so those are not
  steps; a save writes them as our writer spells them. The CLI upgrades per file
  (`kicad-cli sch|pcb|sym|fp upgrade`; `--force` resaves a current file) and never touches
  `.kicad_pro` — the GUI fills that in.

### Files newer than we write

KiCad refuses a schematic or symbol library newer than it writes ("…created with a more recent version
than the one you are running"), and opens a newer board only if every token parses. We parse
everything, so we can do better than refusing: a newer file **opens read-only**, saying which KiCad
wrote it. Saving it would mean either stamping v10 on syntax we do not understand or writing v10
edits under a newer header — both a file neither KiCad nor we can vouch for.

### Mixed and half-upgraded projects

Files in one project need not share a version, and real projects do not: a board saved in KiCad 10's
PCB editor alone is v10 beside v8 schematics, with a `.kicad_pro` that has no `erc` section, a stub
`schematic` section, a single `Root` entry in `sheets` and an all-zero uuid in `top_level_sheets` — the
schematic editor fills those in the first time it saves. Each file is read and migrated on its own
version, and an absent `.kicad_pro` section reads as KiCad's defaults.

### Checks follow KiCad 10

ERC, DRC and the library-parity rules match current KiCad whatever version a file is
(`kicad-parity.md`). `lib_symbol_mismatch` compares a schematic's embedded copies with the
libraries installed, so its findings depend on the installed KiCad version, as KiCad's own do.

---

## Symbol Library File Format (.kicad_sym)

Source: [dev-docs.kicad.org — Symbol Library](https://dev-docs.kicad.org/en/file-formats/sexpr-symbol-lib/)
and the SYMBOL_DEFINITION grammar in the S-expression intro. A `.kicad_sym` file
holds symbol *definitions*; a schematic embeds a copy of the ones it uses in its
`lib_symbols` block (see below).

### Top-Level Structure

```sexpr
(kicad_symbol_lib
  (version YYYYMMDD)
  (generator "PROGRAM")
  (symbol "NAME" ...)          ; one or more symbol definitions
  (symbol "NAME2" ...))
```

### Symbol Definition

```sexpr
(symbol "NAME"
  [(extends "BASE_NAME")]                 ; derived/alias symbol (see below)
  (pin_numbers hide)                      ; optional display flags
  (pin_names (offset 0.254))
  (in_bom yes) (on_board yes)

  ;; Reserved + user properties (see table). Order matters via (id N).
  (property "Reference" "R"  (id 0) (at ...) (effects ...))
  (property "Value"     "R"  (id 1) (at ...) (effects ...))
  (property "Footprint" ""   (id 2) (at ...) (effects ...))
  (property "Datasheet" "~"  (id 3) (at ...) (effects ...))
  (property "ki_fp_filters" "R_* R_0*" (id N) ...)

  ;; Unit sub-symbols: NAME_<unit>_<bodystyle>
  (symbol "NAME_0_1" (rectangle ...))     ; unit 0 = graphics shared by all units
  (symbol "NAME_1_1" (pin ...) (pin ...)))
```

### Reserved Property Fields

The first four properties are mandatory and ordered by `(id N)`; `ki_*` keys are
reserved (users cannot define their own):

| Key | id | Meaning | Empty allowed? |
| :-- | :- | :------ | :------------- |
| `Reference` | 0 | Reference-designator prefix (`R`, `U`, `C`, `#PWR`…) | no |
| `Value` | 1 | Symbol value | no |
| `Footprint` | 2 | Assigned footprint **library identifier** (`Lib:Fp`) | **yes** (generic parts leave it blank) |
| `Datasheet` | 3 | Datasheet URL/path | yes |
| `ki_keywords` | — | Search keywords | reserved |
| `ki_description` | — | Description | reserved |
| `ki_fp_filters` | — | Footprint **filter** patterns | reserved |
| `ki_locked` | — | Locked flag | reserved |

### Footprint Reference — cardinality

- **`Footprint` is a single value** — one footprint library identifier, or empty.
  It is a **reference by lib_id** (`Package_TO_SOT_SMD:SOT-23`), never an embed,
  so **many symbols/components can share one footprint** (many-to-one). In a
  library file the value is a default; each *placed* symbol in a schematic carries
  its own `Footprint` property, so instances of the same symbol may differ.
- **`ki_fp_filters` is a *filter*, not an assignment** — a space-separated set of
  wildcard patterns (e.g. `R_* R_0*`) naming *candidate* footprints the assignment
  tool offers; it assigns nothing. (The value grammar is space-separated wildcards
  in practice; the dev-docs mark the key reserved but do not grammar its value.)

### Units & Body Styles

- Units are child `(symbol "NAME_<unit>_<style>")` tokens. `<unit>` is an integer
  (`0` = graphics common to every unit); `<style>` is the body style, `0` meaning
  common to every style, `1` the standard drawing and `2` the alternate.
- **`<style>` is not limited to 1 and 2.** Through KiCad 9 a symbol could have at
  most one alternate — "the De Morgan equivalent" — and this doc said so. **KiCad
  10 generalized it** to an arbitrary number of named custom body styles (manual
  §10.6; the motivating example is ANSI gate shapes against IEC rectangular ones),
  so a parser must treat the number as open-ended.
- The symbol declares its styles with `(body_styles demorgan)` — 34 occurrences
  across the 223 standard libraries, all `demorgan` so far. **Do not derive the
  style count from it**: `Interface:LTC1519` declares `demorgan` and ships a
  `_3_3` sub-symbol anyway, so the declaration and the geometry can disagree. The
  sub-symbols that exist are the authority.
- A **placed** symbol in a `.kicad_sch` selects its style with `(body_style N)`,
  which KiCad 10 renamed from `(convert N)`. Absence means 1. Both spellings must
  be read; writing the new one puts a token KiCad 9 cannot parse into the file.
- Alternates are rare and confined to discrete logic: 33 of 22,784 standard-library
  symbols carry one, all in `4xxx`, `74xx` and `Video`.
- **Unit sub-symbols cannot carry properties** — so `Footprint`, `Value`, etc. are
  parent-level and **shared across all units**: one physical package per
  component (a quad gate's four units resolve to a single footprint).

### Derived Symbols (`extends`)

```sexpr
(symbol "R_Small" (extends "R") (property "Value" "R_Small" ...))
```

A symbol with `(extends "BASE")` inherits the base's graphics and pins and **may
differ only in its properties**. A common use is a variant that changes just the
default `Footprint` or `Value` over identical graphics. `.kicad_sym` stores
`extends` with a bare base name; a schematic's embedded `lib_symbols` prefixes it
with the nickname (`(extends "Device:R")`), matching the placed lib_id shape.

### Namespacing note

In a `.kicad_sym` library, top-level symbol names are **bare** (`R`, `C`). When a
symbol is placed, the schematic's `lib_symbols` keys the top-level definition by
its full lib_id `Nickname:Name` (`Device:R`) while nested unit sub-symbols stay
bare (`R_0_1`), and any `(extends …)` is rewritten to `Nickname:Base`. The
library nickname comes from the library table, not the file.

---

## Schematic File Format (.kicad_sch)

Modern KiCad schematics are rooted at `(kicad_sch ...)`. They contain an embedded `lib_symbols`
section followed by placed symbols and connectivity graphics:

```sexpr
(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "...")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1" (rectangle ...))
      (symbol "R_1_1" (pin ...))))
  (wire (pts (xy X1 Y1) (xy X2 Y2)) (stroke ...) (uuid "..."))
  (junction (at X Y) ...)
  (label "NET" (at X Y ANGLE) ...)
  (symbol
    (lib_id "Device:R")
    (at X Y ANGLE)
    (unit 1)
    (property "Reference" "R1" (at X Y ANGLE) ...)
    (property "Value" "10k" (at X Y ANGLE) ...)
    (pin "1" (uuid "..."))
    (uuid "..."))
  (sheet_instances ...))
```

Embedded symbol child names conventionally end in `_<unit>_<body-style>`; unit `0` graphics are
shared by every unit. Schematic item positions use absolute sheet coordinates while embedded symbol
geometry and pins use coordinates local to the placement. Symbol properties in a placed symbol also
carry absolute sheet positions and must move with the symbol.

### Schematic Text Effects

All schematic text-bearing objects share the common effects structure. If `face` is omitted or is
`"KiCad Font"`, render with KiCad's NewStroke font. Other face values name TrueType fonts.

```sexpr
(effects
  (font
    (face "KiCad Font")
    (size HEIGHT WIDTH)
    (thickness THICKNESS)
    (bold yes)
    (italic yes)
    (line_spacing RATIO)
    (color R G B A))
  (justify left|right top|bottom)
  (hide yes))
```

`(color R G B A)` (KiCad 7+) sits on the **font**, not on `effects` — unlike a graphic's stroke and
fill colors, which are children of `(stroke …)`/`(fill …)`. R/G/B are 0–255 integers and A is 0.0–1.0,
the same encoding every other `(color …)` uses; absent means "inherit the theme color", and KiCad's
all-zero `(0 0 0 0)` sentinel means the same. It is what the Text Properties dialog's color swatch
writes, and it applies to any text-bearing node.

The text location is an anchor, not always its center. With no `justify`, text is centered on both
axes. `left`/`right` select the anchored horizontal edge and `top`/`bottom` select the vertical edge;
layout occurs in text-local coordinates before the item's rotation is applied. Parsers must tolerate
both atom flags (`hide`, `bold`) and explicit yes/no lists (`(hide yes)`, `(bold yes)`) across KiCad
versions. Free text, symbol properties, pin names/numbers, local/global/hierarchical labels, and
hierarchical sheet properties/pins all use this effects model. Global and hierarchical labels also
carry a connection `shape` such as `input`, `output`, `bidirectional`, `tri_state`, or `passive`.

## Formatting KiCad writes (and we now match)

Round-tripping a file byte-identically is a product invariant (RULES.md §7), and until
2026-08-02 we failed it for every file we did not write ourselves: our serializer used
two-space indents and inlined short lists, so **opening a KiCad file and saving it rewrote
every line**.

`serializeSExpr` is now a **port of KiCad's `Prettify`**
(`common/io/kicad/kicad_io_utils.cpp` — read it before changing any of this; the constants
and the branch order are all there). Its rule set is small, and none of it is per-token:

- **A TAB per nesting level** (`indentChar`, `indentSize` 1). A tab counts as **one column**.
- **Only a `(` starts a new line.** An atom always continues the current line — which is
  why `(loss_tangent 0.02) addsublayer` keeps its trailing atom, the case an
  "atoms first, then sub-lists" model gets wrong.
- **A run of atoms wraps past column 72** (`consecutiveTokenWrapThreshold`), continuing one
  level deeper. This is what breaks a long `(members "…" "…")` in a bus alias.
- **Consecutive `(xy …)` pack onto one line while the column is under 99**
  (`xySpecialCaseColumnLimit`). The test is on the column **before** the point is appended,
  so a line overshoots by up to a whole point — measured output holds 119-character lines
  while breaking others at 102. No "wrap at N" model fits; do not try to fit one.
- **The closing paren takes its own line** when the previous non-whitespace was `)` or the
  list wrapped (`inMultiLineList`) — otherwise it closes inline.
- **A trailing newline ends the file.**
- **A literal TAB inside a quoted string is written raw**, not escaped. We used to escape
  it, which corrupted a `text_box` holding a tab-aligned table.

**Result: 97 of 100 real files round-trip byte-identically** (60 standard symbol libraries,
25 demo schematics, 15 demo boards). The three that do not are files KiCad's own prettifier
would also rewrite:

- `front-panel-io.kicad_sch` — KiCad 7 era (version 20230819), never prettified.
- `RoyalBlue54L-Feather.kicad_pcb` — carries `(curved_edges no)(filter_ratio 0.9)` with no
  separating space, i.e. not prettifier output.
- `tinytapeout-demo.kicad_pcb` — hits a **stateful quirk**: `inMultiLineList` is set by a
  token wrap and is never reset on entering a nested list, so later `)` in the same
  subtree break even where the local rules say they should not. A per-node serializer
  cannot reproduce that without threading the flag across the whole document, and it only
  shows on pathologically long coordinate runs.
