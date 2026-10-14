# GoatCAD Design Framework

How UI elements are sized and styled so the app reads as one product. Enforced UI rules (the 11px
floor, tokens, icons, reduced motion) are in [RULES.md §6](./RULES.md); palette and voice are in
[BRAND.md](./BRAND.md).

---

## 1. The one principle

**A standard element is shared classes, not CSS at the call site.** `<button class="btn-cta btn-lg">`
is a complete button.
- **Shape:** an element is a base plus modifiers, usually a size class and an emphasis class.
- **Tokens:** classes are built from the tokens in `assets/base.css`, mirrored to the site's
  `tokens.css`. Use a raw token only for one-off text no class covers. Never use a raw px or hex.
- **Bespoke layouts** stay bespoke but still go through tokens. Once you are re-creating a standard
  look, adopt the class instead.

---

## 2. Foundations

### Color

- **Use the semantic `--vscode-*` tokens, never a hex.** The palette itself is in BRAND.md.
- **Dark is designed; light is derived.** Each light token keeps its dark hue and chroma, with its
  lightness from one monotonic OKLCH map, so every ordering in dark holds in light.
  - Raised surfaces (menus, inputs) lift toward white.
  - Change a dark token, re-derive its light twin. `theme.test.ts` fails when a token exists in only one theme.

### Type scale

The only text sizes. Use `font-size: var(--text-…)`.

| Token | Size / line | Role |
|---|---|---|
| `--text-caption` | 11 / 1.45 | the floor: hints, badges, eyebrows, table sub-labels |
| `--text-body-sm` | 12 / 1.5 | secondary text, dense panels, form controls, small buttons |
| `--text-body` | 13 / 1.5 | primary text on roomy surfaces; default control text |
| `--text-heading` | 15 / 1.35 | panel, section and dialog titles |
| `--text-display` | 20 / 1.25 | page heroes, large CTAs |

Size to the space, not the floor: a full-pane view uses `--text-body`, a dense table `--text-body-sm`.

### Minimum target size

**24 × 24 px is the floor for anything clickable**: dense surfaces (table rows, property panels)
use 24, roomy ones (dialogs, toolbars) 28. Only icon-only controls need the square (`.btn-icon-*`).
Never shrink a control below the floor with padding.

### Spacing, radius, borders, motion

- **Spacing:** 4px base, ramp `4 · 8 · 12 · 16 · 24`. No 5px or 7px one-offs.
- **Radius:** 4px for controls, 6px for panels and frames, 8px for modals.
- **Borders:** `1px solid var(--vscode-border)`. Focus uses `var(--vscode-input-focus)`.
- **Motion:** feedback lands in ~70 ms. Every animation is gated on `prefers-reduced-motion`.

---

## 3. Components

### Buttons

An emphasis class plus a size class (`assets/main.css`). Disabled is 50% opacity.

| Class | Use |
|---|---|
| `btn-cta` | the one call to action per surface; dark text on copper |
| `btn-outline` | the workhorse |
| `btn-subtle` | tertiary actions; icon buttons inside a framed toolbar |
| `btn-danger` | destroys something; outline at rest, filled on hover; one per surface |
| `btn-sm` / `btn-md` / `btn-lg` | 4·8 / 8·12 / 10·16 px padding, at body-sm / body / heading |
| `btn-icon-sm` / `btn-icon-md` | icon-only, 24 / 28 px square; replaces the size class |
| `btn-panel` | with `btn-outline btn-md`: a full-width panel action, regular weight |
| `btn-cell` | with `btn-outline`: a 24px square row action in a dense table |

- **Panel actions** stack 6px apart, icon then label, with the icon in the label's color. Copper is
  kept for selection and the CTA.
- **A design's own pages** (Board setup, Fabrication outputs; Schematic setup, Components) are
  panel actions at the foot of Properties when nothing is selected. Each is also a File menu item.
- **Icon-only buttons get the outline**, unless the container's frame already says "controls live here".
- **Cell buttons** sit at the right end of a property row's value cell, edge to edge when there are
  several, drawing only their left border.
  - **Browse** opens a library chooser.
  - **Open** opens a file or link and stays enabled on read-only files.
  - Render the cell only on rows with a button, and `colspan` the value cell on rows without (only
    when the group has any action).
- **An action that doesn't apply is disabled in place, never removed.** A disabled control shows no tooltip, so the
  surrounding state must explain why.

### Form controls (`select`, text `input`)

- **Size classes:** `.field-md` (6·8 px, body) or `.field-sm` (4·6 px, body-sm). Each carries the
  whole look; there is no bare `.field`. Layout (`min-width`, `flex`, mono) stays local.
- **Spell check is off** (set on the document). Prose fields opt in with `spellcheck="true"`.
- **Text cells trim their ends on commit.** Drawn text opts out (`EditorDescriptor.skipTrim`).
- **Commit and abandon:** blur commits and Escape abandons (RULES.md §6).

### Segmented control

A few fixed, mutually exclusive options: `.segmented` around `.segmented-btn`s, the chosen one
`.active`. Sized like `.btn-sm`.
- **In a property table** (`.dense-toggle`) it fills the value cell: no border, hairline splits, the
  selection in subtle copper.

### Section eyebrows

Uppercase group headers: caption size, uppercase, `letter-spacing: 0.04em`, muted. One shared style.

### Selection nav

The left list of a master-detail view (Settings, Board Setup, Schematic Setup, Manufacture):
`.nav-list` (180px, right border) and `.nav-item` (`.active` gets a copper inset bar). Returning to
the view's tab lands on the item left (`lib/paneMemory.ts`, for the window's life), never back
on the first; a request to show an item (Edit sizes… opening Net Classes) is shown once.

### Panels

Right-bar panels are `CollapsiblePanel.vue`: 1px border, body-size semibold header. Full-pane surfaces
bleed their previews to the edges and inset only text.

### Modals & dialogs

- **Frame:** `shared/Modal.vue`, the platform's modal `<dialog>` (`showModal()`, `closedby="any"`):
  top layer, the window behind it inert, focus kept inside, a `::backdrop` of the scrim with a 4px
  blur. The panel inside (sidebar ground, 1px border, 8px radius, 24px padding) sizes itself.
  Mounting opens it; the owner closes it on `dismiss` by unmounting. Never hand-build an overlay.
- **Title:** the command that opened the dialog, after its glyph at 20px. A dialog never offers to
  switch to another command.
- **Escape closes every modal**, and so does a press that begins and ends outside the panel; a press
  begun inside never does, wherever it is released. Both are the platform's light dismiss, and both
  abandon; neither applies.
- **Enter runs the CTA while nothing inside has focus.** Once a control has focus, Enter belongs to
  it. Choosers and sheets of equal actions have no Enter CTA. It comes from `useModalKeys`
  (`lib/modalKeys.ts`), which listens on `window` and serves only the topmost modal.
- **Nothing a modal opens may teleport to `<body>`**: the top layer is above it, and the window
  behind is inert. A modal that opens a chooser sets itself aside (`hidden`) while it is up.

### Choosers

A modal that answers "which one?" from a library (`shared/LibraryChooser.vue`). Every chooser
follows this anatomy:

- **Size:** 92% of the window, at most 1680px wide. Its splits are shares: list | preview 2 : 3,
  symbol | details | footprint 3 : 1 : 2.
- **Title:** the command that opened it, after its glyph. What the chooser is for follows, muted ("TP8 · TestPoint").
- **Search** has focus on open. Enter takes the best match, ↑/↓ move through the list, →/← open and
  shut groups, and `/` or Ctrl/Cmd+F returns to the search.
- **Results:**
  - Results sit left: pinned groups (In this design, Recent, Fits symbol), then one group per
    library, shut until a search opens them.
  - Rows are 32px: name, then description (muted), then badges.
  - There is no filter bar; a pinned group answers what a filter would.
- **Previews** are view-only pictures with no readouts. Every part has the same slots; an empty one says
  why ("No 3D model").
- **Parts are named one way everywhere:** scope › library › **name** (`shared/PartTrail.vue`), never a path.
- **Layout:** one 6px frame, panes meeting at draggable 1px rules.
- **Footer:** Cancel, then the verb as the CTA ("Assign to 3 parts"), never "OK".

### Menu buttons

A control that opens a menu toggles it. Pass the control as `ContextMenu`'s `anchor`. While open it
shows its hover look, never gold.

### Tables

- **Header:** caption uppercase muted, with 1px row rules.
- **Body text:** `--text-body-sm` in a table inside a larger surface; `--text-body` when the table is the surface.
- **Fonts:** mono for machine values (part numbers, layers, paths, coordinates), proportional for prose.

### Sheets

A table edited in place, ruled like a spreadsheet: `<table class="sheet">`.

- **Grid:** cells are 28px with one grid line in the input-border color. The editor is the cell, with
  no box of its own. A hovered cell shades; the edited cell's line turns accent.
- **States:** read-only is dimmed text. Not-applicable is recessed with a dash (`td.sheet-na`).
  A bad value gets an error-colored line (`.bad`).
  An empty cell that inherits shows the value it inherits, muted (`placeholderValue`, an optional
  select's empty option), never words like "From Default"; a color says whose ("Default", "Theme").
- **Alignment:** numbers right (`td.num`), everything else left.
- **Add** is an outline icon button in the header's action column. A new row takes focus in its
  first cell (`lib/useFocusAddedRow.ts`). Row actions sit beside the grid (`.sheet-actions`).

The Properties panel is not a sheet. **A mixed selection shows only the fields every kind shares**
(`intersectGroups`).

### The data surface

What the person came to read (results, details) sits on `--vscode-data-bg`, its values in
`--vscode-data-fg`. The chrome around it stays on the sidebar ground.

### Hotkeys

A shortcut shown to the user is a keycap: `<kbd class="kbd"><span>{{ hotkeyLabel(id) }}</span></kbd>`.
- **Label:** always from `hotkeyLabel()`, never typed.
- **Step keys:** a number key that steps a setting up or down (the tuner's `1`–`4`) carries a
  small `step-up` / `step-down` triangle after its number (`shared/KeyCapKbd.vue`, `KeyCap`), so a
  pair reads as more and less without words.
- **Lists:** a list of shortcuts is a `.shortcut-grid`.
- **Menus** show accelerators as plain muted text instead.

### Keymap

Bindings live in `lib/hotkeys.ts`. KiCad's binding wins where it fits these rules; the platform
wins over KiCad. `hotkeys.test.ts` fails on two live actions sharing a chord, or a draw tool whose
letter differs between editors.

- **One verb, one key, every editor:** R rotate (Shift+R clockwise), F flip, Del delete, Esc cancel.
  A verb an editor lacks leaves its key unbound there.
- **Modifiers:**
  - **Bare key:** this editor's objects and verbs: A symbol, W wire, P pin or pad, X route, M move, G drag.
  - **Shift + key:** the reverse or variant: Shift+R, Shift+N previous grid, Shift+Del whole track.
  - **Ctrl/Cmd + key:** document commands: save, undo, clipboard, duplicate, find, zoom. KiCad's
    Ctrl+L global label, Ctrl+E library editor and Ctrl+U units stay.
  - **Ctrl/Cmd + Shift + letter:** draw tools, one letter everywhere: L line, A arc, C circle,
    P polygon, B bezier, T text, K rule area, H dimension, X via. Ctrl/Cmd+Shift+D is Repeat.
  - **Alt + key:** navigation and view modes: Alt+←/→ back and forward, Alt+↑ up a sheet,
    Alt+1/2/4 grids, Alt+Z zone.
  - **Ctrl/Cmd + Alt + letter:** window-wide actions (Git, Libraries, Part search, agent). No editor binds one.
  - **Named keys:**
    - Esc undoes one step of intent: the last point, then the tool, then the selection.
    - Enter finishes.
    - Backspace drops the last point while drawing, deletes otherwise, and on the board unroutes a
      step at a time.
    - Home fits, Insert repeats, PgUp/PgDn step the layer or sheet.
    - F3 finds next, F4 centers, F6 switches group, F8 updates the PCB.
- **Ctrl means Cmd on macOS** (`ctrlOrCmd`). Literal `ctrl` only where macOS owns the Cmd chord.
- **Nothing only one keyboard has.** Insert, Home and F-keys each get a second binding
  (Ctrl/Cmd+Shift+D, Ctrl/Cmd+0, ⌘G).
- **While moving** (KiCad's): Shift lets go of snapping to other items, Ctrl of the grid.
- **One key, two meanings** only when the states exclude each other (mid-route V via, F finish). The
  test lists each pair.
- **Departures from KiCad:**
  - Esc is Unselect All.
  - Ctrl+Shift+N and Ctrl+Shift+G are New Window and Git.
  - Ctrl+E is the one "open in library editor" command.

**Reserved for approved work not yet built:**

| Action | Keys | Editors |
|---|---|---|
| Open in the library editor | Ctrl/Cmd+E | PCB |

### Hints & captions

Caption size, muted: counts, preview notes, and the rare subtitle under a setting. By default there
is none (BRAND.md §2, In-app UI copy).

### Net class tags

A net class's name, wherever it stands among other words: `shared/NetClassTag.vue`. A rounded tag in
the UI font at body-small, regular weight, a step larger than a status badge so a class stands out from the
words around it; a net's own name beside it stays mono. The class's KiCad PCB color, where it has one,
fills it faintly and rims it more strongly, its text the theme's strongest so it reads on any hue; a class without one
is neutral.
Plain text that cannot be styled (tooltips, DRC messages, MCP) spells it as KiCad does, `netclass 'USB'`.
Board Setup's class table is the one place the name stands alone, as its rows' header.

### Differential pairs

A pair among a list of nets: `shared/DiffPairGroup.vue`. Its two halves, positive first, in one rounded
group rimmed in the input border, behind the pair glyph (`tool-route-pair`) in muted text; each list keeps its
own styling for the halves inside it. Every list of nets that pairs them shows a pair this way.
A control that picks a class shows the classes as tags too (a select with `tags: true`), and one
that may also make a class ends its list with "New class…".

### Layer swatches

A layer's name never stands without its color: wherever one is shown (a table cell, a checkbox, a
select's options and its value, a menu row), a small square of the layer's display color
(`kicadLayerColorsForTheme`, the theme's) sits before the name, which stays mono. Select options
carry it as `SelectOption.color`.

### Status badges

A state, never an action: one or two words (Connected, Checking…). `class="status-badge is-ok"`;
variants `is-neutral`, `is-ok`, `is-error`, `is-pending`.
- **Size:** always caption.
- **Color:** a tinted fill, not colored text alone.
- **`is-pending`** covers both in flight and not yet proven: never paint an outcome you don't have.

### Icons

One registry: `lib/icons.ts`, rendered by `shared/Icon.vue`. Size comes from the container; tint
with `color` (`currentColor`).

- **Never a Unicode character as an icon.** Fonts draw them differently per OS. Text characters stay
  text (`⌘`, `·`, `…`). `unicodeIcons.test.ts` enforces it.
- **Shared glyph classes:**
  - `.disclosure` for anything that expands, at 16px, the one caret size;
  - `.sort-indicator` beside a sorted column header;
  - `.breadcrumb-sep` between breadcrumb steps.
- **Standard glyphs:** `close-sm` removes from a list, `trash` deletes a stored thing, `check` marks the current choice.
- **Three families, each on its own grid**, crisp at the one size it is used. A meaning used in two
  families is drawn twice.

**Activity bar** (`BAR` preset): a 24px grid drawn inside 2–22. It is the quietest family.
- **Weight:** every glyph carries about the same ink. Lines are 2px on whole coordinates, grips 3px,
  compact objects solid, frames outlined. Caps and joins are round.
- **State:** the button owns it, never the glyph.
- **The agent button** is generic sparkles. The tooltip names the product.

**File glyphs** (`shared/FileIcon.vue`): a 16px grid, 1px strokes on `.5`.
- **Draw the thing itself**, not the thing on a page. Only schematic (a sheet) and board keep a body.
- **Hue:** violet for the schematic side, cyan for the board side, one hue per foreign format, neutral for
  plain files. Never gold, green or the accent: those are git status colors.
- **No glyph on folders or library rows.** Their caret says it.
- **Alignment:** a file's glyph sits in its sibling folder's caret column, one indent step under
  the pane header (`--tree-step`, `--tree-inset`).

#### Canvas tool palettes

The editors' floating toolbars, tool searches and view rails (`TOOL` preset).
- **Grid:** 20px, rendered at exactly 20px. 1px strokes on `.5` coordinates, filled edges on whole
  numbers, drawn inside 2–18.
- **Three tones of `currentColor`:** the stroke, `TONE` (50%) for what the tool makes, `FACE` (20%)
  for a shape's body. Construction lines use 0.5 stroke opacity.
- **Draw the object the tool makes, KiCad's way**, so a KiCad user knows each chip without its tooltip.
- **Chips:**
  - `.tool-btn` is a borderless 32px square that shows its box only when hovered or selected.
  - A selected tool is copper; an on toggle (`.toggle-btn`) is lit; a cycling button takes no active state.
  - A value chip shows its glyph and a mono value: the choice, never what it comes to on the item
    in hand (that is the Properties panel's, while the operation runs). Gold means the choice
    overrides the rules.
- **Tooltips:**
  - Name and hotkey from `toolTitle()`: "Arc (Ctrl+Shift+A)". No instructions.
  - They appear at once (`installToolbarTips`).
- **Layout:**
  - Every pan/zoom canvas has a **view rail** down its left: fit first, then camera and display toggles.
  - A top bar hides chips from the end when it doesn't fit (`v-toolbar-fit`). Its room ends at the
    canvas's top-right slot.
  - The **tool search** lists every control except undo, redo and the clipboard.
    - At rest it wears the current tool's icon and name, lit as an active chip, whenever no chip on
      the bar shows that tool (one only the search offers, or one the bar folded away).
    - Sections are Edit then View, grouped under one heading vocabulary. A new control gets its
      search entry and `data-tool-op` in the same change.
- **Separate set:** palette glyphs are their own `tool-*` set, not scaled copies of other glyphs.

### Viewport status strips

Floating pills in both bottom corners (`shared/ViewportStatusBar.vue`), all `.viewport-pill`:
`--vscode-overlay`, 12px blur, 1px border, 6px radius, body-sm on an 18px line, 30px tall, no shadow.

- **Corners:** bottom right is persistent state (coordinates, settings, the health pill). Bottom
  left is hints only: the armed tool's coaching and the keys of the operation in hand. 3D views
  follow the same rule.
- **Readouts of an operation go to Properties, never the corner.** While a route or a drag runs,
  what it comes to (lengths, sizes in force, its limits, what the drop does to the nets) is a group
  at the head of the Properties panel, read-only rows warned as any row is: in place of the
  selection where the operation replaces it (a route), above it where the selection is what moves
  (a drag). The one exception is the tuner's meter, which rides the cursor because it is what the
  hand steers by (router-behavior.md T4).
- **Pills:**
  - One pill per fact. A control is its own pill, never inside a readout.
  - Labels are UI font, values mono (`.viewport-pill-value`). Controls keep button type.
  - Pills whose label changes hold a 112px minimum width (`.steady-width`).
- **A corner control's tooltip is its name**, one locale string. No instructions, hotkey or state.
- **An icon supplies what the label dropped**, never a picture of the label. A readout's glyph is
  from the canvas palette set at its 20px, and its label becomes the hover and the screen reader's
  name (`StatusItem.icon`).
- **Canvas settings** (Grid, Filter, Router mode, Layers) are pills that open a `ViewportPopover`.
  - Its pin moves the panel into the right rail and removes the pill. Where it lives is saved per editor.
  - A one-choice popover is a menu instead and does not pin.
- **Gold reports a setting that would surprise you** (a narrowed filter), never an open popover. A
  click the filter turned away flashes the filter.
- **Coaching** is only for what a tool can't say itself, never "click to place", in the pills' own text color.
- **The health pill** is the last bottom-right control.
  - Error and warning counts each have their own glyph.
  - It reads `Checks` before the first check, then a check mark once clean.
- **Coordinates:**
  - File coordinates; a y-down file negates y.
  - One snapped point, no unit (the grid pill states it).
  - A fixed width, right-aligned, padded with spaces.
  - Precision follows the grid while snap is on.
- **`preview` and `bare` viewports:** a `preview` viewport drops controls and keeps readouts. A `bare` one drops both.
- **Pointer events:** the strip is `pointer-events: none`; controls re-enable their own.

### Canvas chrome: handles and the pointer

Shared by the 2D editors (`lib/engine/SelectionChrome`).

**Handles are drawn in screen pixels, and shape says what grabbing does:**

| Glyph | Means |
| --- | --- |
| **Square** | resize: moves the point it sits on |
| **Diamond** | move: translates the whole item |
| **Cross** | the anchor of a text or field, the point its glyphs lay out from |

Filled circles (junctions) and rings (dangling ends) are taken.

**The pointer states the mode:**
- **Cursors:** crosshair while a tool is armed, grabbing while panning, arrow otherwise. A drawing
  tool may use its own glyph (`iconCursor`).
- **One call sets it:** `ViewportEngine.setDrawMode` owns the cursor. Never style it in a viewport's CSS.

### Loading feedback

- **Under 150 ms** (`PROGRESS_DELAY_MS`, `lib/delayedVisible.ts`): no indicator.
- **Past it:** an indicator stays until the work settles. Use a progress bar with a percent or count
  when progress is measurable, a spinner only when it isn't.
- **One operation, one indicator.** Read → parse → first paint is one bar.
- **The surface behind it holds one background color** from click to first paint.

---

## 4. Adoption

**In code:** the `--text-*` tokens and the `.btn-*`, `.field-*`, `.segmented`, `.nav-*` classes.
**Not yet:** the `--space-*` tokens. The project switcher (`.project-id`) should become `btn-outline btn-md`.

Migrate as you touch a component:
1. Adopt the classes.
2. Use tokens for one-off text.
3. Add a missing class or token to its shared home (`main.css` / `base.css`, mirrored to `tokens.css`).

Never restyle in one sweep.
