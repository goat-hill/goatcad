/**
 * Central hotkey and mouse-gesture registry.
 *
 * Every keyboard shortcut in the app is declared here as data and matched
 * through `matchesHotkey`, so a future settings UI can list and rebind them
 * without hunting through per-editor keydown handlers. The handlers themselves
 * stay in the editors — guard logic (typing targets, tool drafts, read-only
 * files, unwind order) is editor state — but the *bindings* live only here.
 *
 * Display strings for toolbar chips and tooltips come from `hotkeyLabel`, so
 * a rebind changes what the UI shows for free.
 *
 * The keymap follows one set of rules across the four editors — which
 * modifier means what, one key per verb everywhere — written down in
 * DESIGN.md §Keyboard. Read it before adding or moving a binding.
 */

export interface HotkeyBinding {
  /**
   * `KeyboardEvent.key`: single letters lowercase (`'z'`), named keys
   * verbatim (`'Home'`, `'Tab'`, `'Delete'`).
   */
  key: string
  /** Accepts Ctrl or Cmd (VS Code-style; Cmd only exists on macOS). */
  ctrlOrCmd?: boolean
  /** Literal Ctrl on every platform; Cmd must NOT be down. */
  ctrl?: boolean
  /**
   * Literal Cmd; Ctrl must NOT be down. macOS-only by construction — nothing
   * else has the key — which is what makes it the way to give macOS a gesture
   * the other platforms cannot have. `ctrlOrCmd` would be wrong there: it also
   * matches Ctrl, and the terminal's Ctrl+C has to stay SIGINT.
   */
  cmd?: boolean
  shift?: boolean
  alt?: boolean
}

export type HotkeyScope =
  | 'app' // window/tab chrome (App.vue, EditorArea.vue)
  | 'editor' // shared by every visual editor
  | 'schematic'
  | 'pcb'
  | 'footprint'
  | 'symbol'
  | 'terminal'
  | 'git' // the Git pane's commit message box

interface HotkeyDef {
  scope: HotkeyScope
  bindings: HotkeyBinding[]
}

const HOTKEY_DEFS = {
  // --- Window / tab chrome (Ctrl literal: Cmd+Tab is the macOS app switcher)
  'app.cycleTabNext': {
    scope: 'app',
    bindings: [
      { key: 'Tab', ctrl: true },
      { key: 'PageDown', ctrl: true }
    ]
  },
  'app.cycleTabPrev': {
    scope: 'app',
    bindings: [
      { key: 'Tab', ctrl: true, shift: true },
      { key: 'PageUp', ctrl: true }
    ]
  },
  /** Open Folder — the browsing entry point, and the one people press, so it keeps plain Ctrl+O. */
  'app.openFolder': { scope: 'app', bindings: [{ key: 'o', ctrlOrCmd: true }] },
  'app.openProject': { scope: 'app', bindings: [{ key: 'o', ctrlOrCmd: true, shift: true }] },
  'app.quickOpen': { scope: 'app', bindings: [{ key: 'p', ctrlOrCmd: true }] },
  'app.closeTab': { scope: 'app', bindings: [{ key: 'w', ctrlOrCmd: true }] },
  'app.newWindow': { scope: 'app', bindings: [{ key: 'n', ctrlOrCmd: true, shift: true }] },
  /** New Terminal — VS Code's Ctrl/Cmd+` , which no editor tool competes for. */
  'app.newTerminal': { scope: 'app', bindings: [{ key: '`', ctrlOrCmd: true }] },
  /** Send the tab in front across the split, opening the second group if need be. */
  'app.splitTab': { scope: 'app', bindings: [{ key: '\\', ctrlOrCmd: true }] },
  /** Side by side or stacked. */
  // Shift+\ arrives as `|`, and a punctuation binding never tests Shift itself.
  'app.splitDirection': { scope: 'app', bindings: [{ key: '|', ctrlOrCmd: true }] },
  /** Hand the keyboard to the other group. F6 is the platform's pane-cycling key. */
  'app.focusOtherGroup': { scope: 'app', bindings: [{ key: 'F6' }] },
  /** Update PCB from Schematic — KiCad's F8, in either editor. */
  'app.updatePcb': { scope: 'app', bindings: [{ key: 'F8' }] },
  /** New Schematic — the dominant create in an ECAD app, so it takes plain Ctrl+N. */
  'app.newSchematic': { scope: 'app', bindings: [{ key: 'n', ctrlOrCmd: true }] },
  /**
   * Dismiss the topmost in-window modal (DESIGN.md §3 — every one of them, no
   * exceptions). Shares Escape with `editor.cancel` by design: they never
   * compete for a gesture, since a modal covers the editor that would cancel.
   */
  'app.dismiss': { scope: 'app', bindings: [{ key: 'Escape' }] },
  /**
   * Run the topmost in-window modal's call to action (DESIGN.md §Modals)
   * while nothing in the modal has focus (`lib/modalKeys.ts`).
   * Shares Enter with the editors' finish keys as dismiss shares Escape: a
   * modal covers the editor that would finish.
   */
  'app.confirm': { scope: 'app', bindings: [{ key: 'Enter' }] },
  // --- The activity bar, one key per button. VS Code's where it has one
  // (Explorer, Settings, the agent's chat); else Ctrl/Cmd+Alt+letter, the
  // keymap's window-wide slot (DESIGN.md §Keymap).
  /** Show the Explorer pane — VS Code's Ctrl+Shift+E. */
  'app.showExplorer': { scope: 'app', bindings: [{ key: 'e', ctrlOrCmd: true, shift: true }] },
  /** Show the Libraries pane. B for its book; Ctrl+Alt+L locks the screen on several Linux desktops. */
  'app.showLibraries': { scope: 'app', bindings: [{ key: 'b', ctrlOrCmd: true, alt: true }] },
  /** Open Part Search: F for find. */
  'app.openPartSearch': { scope: 'app', bindings: [{ key: 'f', ctrlOrCmd: true, alt: true }] },
  /** Open the agent's tab — VS Code's chat key. */
  'app.openAgent': { scope: 'app', bindings: [{ key: 'i', ctrlOrCmd: true, alt: true }] },
  /** Open Settings — every platform's Ctrl/Cmd+comma. */
  'app.openSettings': { scope: 'app', bindings: [{ key: ',', ctrlOrCmd: true }] },

  // --- Git. Window-wide, so the commit loop runs without the mouse from any
  // tab. Ctrl+Shift+G is VS Code's Source Control key — literal Ctrl on macOS
  // too, as VS Code has it, leaving ⌘⇧G to Find Previous; the rest take
  // Ctrl/Cmd+Alt, which no editor binds (the draw tools own Ctrl+Shift+letter).
  /** Open the Git pane with the commit message focused. */
  'git.focusCommit': { scope: 'app', bindings: [{ key: 'g', ctrl: true, shift: true }] },
  'git.stageAll': { scope: 'app', bindings: [{ key: 'a', ctrlOrCmd: true, alt: true }] },
  'git.push': { scope: 'app', bindings: [{ key: 'p', ctrlOrCmd: true, alt: true }] },
  /** U for update: Ctrl+Alt+L locks the screen on several Linux desktops. */
  'git.pull': { scope: 'app', bindings: [{ key: 'u', ctrlOrCmd: true, alt: true }] },
  /** In the message box: commit the staged changes, or everything when nothing is staged. */
  'git.commit': { scope: 'git', bindings: [{ key: 'Enter', ctrlOrCmd: true }] },

  // --- Shared editor actions
  'editor.save': { scope: 'editor', bindings: [{ key: 's', ctrlOrCmd: true }] },
  /** Open the text editor's find widget (VS Code's Ctrl/Cmd+F). */
  'editor.find': { scope: 'editor', bindings: [{ key: 'f', ctrlOrCmd: true }] },
  'editor.undo': { scope: 'editor', bindings: [{ key: 'z', ctrlOrCmd: true }] },
  'editor.redo': {
    scope: 'editor',
    bindings: [
      { key: 'z', ctrlOrCmd: true, shift: true },
      { key: 'y', ctrlOrCmd: true }
    ]
  },
  'editor.delete': { scope: 'editor', bindings: [{ key: 'Delete' }, { key: 'Backspace' }] },
  'editor.cancel': { scope: 'editor', bindings: [{ key: 'Escape' }] },
  /**
   * Select every item the editor's selection filter allows. Esc is its undo
   * (Unselect All), not KiCad's Ctrl+Shift+A, which stays the arc tool.
   */
  'editor.selectAll': { scope: 'editor', bindings: [{ key: 'a', ctrlOrCmd: true }] },
  /**
   * Zoom to fit content — KiCad's Home. Deliberately not Onshape's `F`,
   * which KiCad users expect to flip a part in the board editor. Ctrl/Cmd+0
   * is the laptop binding: a trackpad has no middle button to double-click,
   * and a Mac keyboard reaches Home only through Fn+Left.
   */
  'editor.fitView': { scope: 'editor', bindings: [{ key: 'Home' }, { key: '0', ctrlOrCmd: true }] },
  /**
   * KiCad's Zoom In / Out at Cursor. `+` beside `=`: the numpad's plus, and
   * Shift+= on layouts where the key prints it.
   */
  'editor.zoomIn': {
    scope: 'editor',
    bindings: [
      { key: '=', ctrlOrCmd: true },
      { key: '+', ctrlOrCmd: true }
    ]
  },
  'editor.zoomOut': { scope: 'editor', bindings: [{ key: '-', ctrlOrCmd: true }] },
  /** KiCad's Center on Cursor. */
  'editor.centerOnCursor': { scope: 'editor', bindings: [{ key: 'F4' }] },
  /** Find next / previous: KiCad's F3, and the macOS convention ⌘G beside it. */
  'editor.findNext': { scope: 'editor', bindings: [{ key: 'F3' }, { key: 'g', cmd: true }] },
  'editor.findPrevious': {
    scope: 'editor',
    bindings: [
      { key: 'F3', shift: true },
      { key: 'g', cmd: true, shift: true }
    ]
  },
  /** KiCad's Switch to Next Grid (finer) and Previous Grid. */
  'editor.gridNext': { scope: 'editor', bindings: [{ key: 'n' }] },
  'editor.gridPrevious': { scope: 'editor', bindings: [{ key: 'n', shift: true }] },
  /** KiCad's fast grids: the editor's own grid, the next finer, and a toggle between them. */
  'editor.gridFast1': { scope: 'editor', bindings: [{ key: '1', alt: true }] },
  'editor.gridFast2': { scope: 'editor', bindings: [{ key: '2', alt: true }] },
  'editor.gridFastCycle': { scope: 'editor', bindings: [{ key: '4', alt: true }] },
  /** KiCad's Switch Units: metric and imperial. */
  'editor.toggleUnits': { scope: 'editor', bindings: [{ key: 'u', ctrlOrCmd: true }] },
  'editor.focusSearch': { scope: 'editor', bindings: [{ key: '/' }] },

  // --- Schematic tools (KiCad bindings; see docs/research/schematic-editor-features.md §2)
  'schematic.tool.symbol': { scope: 'schematic', bindings: [{ key: 'a' }] },
  'schematic.tool.power': { scope: 'schematic', bindings: [{ key: 'p' }] },
  'schematic.tool.wire': { scope: 'schematic', bindings: [{ key: 'w' }] },
  'schematic.tool.label': { scope: 'schematic', bindings: [{ key: 'l' }] },
  'schematic.tool.globalLabel': { scope: 'schematic', bindings: [{ key: 'l', ctrlOrCmd: true }] },
  'schematic.tool.hierarchicalLabel': { scope: 'schematic', bindings: [{ key: 'h' }] },
  'schematic.tool.noConnect': { scope: 'schematic', bindings: [{ key: 'q' }] },
  'schematic.tool.junction': { scope: 'schematic', bindings: [{ key: 'j' }] },
  // Graphics take the Ctrl+Shift draw keys every editor shares, after KiCad's
  // own schematic letters for the two it binds (T, I).
  'schematic.tool.text': {
    scope: 'schematic',
    bindings: [{ key: 't' }, { key: 't', ctrlOrCmd: true, shift: true }]
  },
  'schematic.tool.sheet': { scope: 'schematic', bindings: [{ key: 's' }] },
  // KiCad's Draw Buses (B), Place Wire to Bus Entries (Z) and Draw Lines (I);
  // Shift+Z places the entry's other diagonal.
  'schematic.tool.bus': { scope: 'schematic', bindings: [{ key: 'b' }] },
  'schematic.tool.busEntry': { scope: 'schematic', bindings: [{ key: 'z' }] },
  'schematic.tool.busEntryFlipped': { scope: 'schematic', bindings: [{ key: 'z', shift: true }] },
  'schematic.tool.line': {
    scope: 'schematic',
    bindings: [{ key: 'i' }, { key: 'l', ctrlOrCmd: true, shift: true }]
  },
  'schematic.tool.circle': {
    scope: 'schematic',
    bindings: [{ key: 'c', ctrlOrCmd: true, shift: true }]
  },
  'schematic.tool.arc': {
    scope: 'schematic',
    bindings: [{ key: 'a', ctrlOrCmd: true, shift: true }]
  },
  'schematic.tool.bezier': {
    scope: 'schematic',
    bindings: [{ key: 'b', ctrlOrCmd: true, shift: true }]
  },
  'schematic.tool.ruleArea': {
    scope: 'schematic',
    bindings: [{ key: 'k', ctrlOrCmd: true, shift: true }]
  },
  /** KiCad's Edit Reference / Value / Footprint: here they open the property row. */
  'schematic.editReference': { scope: 'schematic', bindings: [{ key: 'u' }] },
  'schematic.editValue': { scope: 'schematic', bindings: [{ key: 'v' }] },
  'schematic.editFootprint': { scope: 'schematic', bindings: [{ key: 'f' }] },
  'schematic.showDatasheet': { scope: 'schematic', bindings: [{ key: 'd' }] },
  /** KiCad's Edit Library Symbol: the placed part's library symbol, in the symbol editor. */
  'schematic.openInLibraryEditor': {
    scope: 'schematic',
    bindings: [{ key: 'e', ctrlOrCmd: true }]
  },
  /** KiCad's sheet navigation: back / forward through the sheets shown, and by page. */
  'schematic.sheetBack': { scope: 'schematic', bindings: [{ key: 'ArrowLeft', alt: true }] },
  'schematic.sheetForward': { scope: 'schematic', bindings: [{ key: 'ArrowRight', alt: true }] },
  'schematic.previousSheet': { scope: 'schematic', bindings: [{ key: 'PageUp' }] },
  'schematic.nextSheet': { scope: 'schematic', bindings: [{ key: 'PageDown' }] },
  'schematic.rotate': { scope: 'schematic', bindings: [{ key: 'r' }] },
  'schematic.rotateClockwise': { scope: 'schematic', bindings: [{ key: 'r', shift: true }] },
  'schematic.mirrorHorizontal': { scope: 'schematic', bindings: [{ key: 'x' }] },
  'schematic.mirrorVertical': { scope: 'schematic', bindings: [{ key: 'y' }] },
  /** KiCad's Move (wires stay) and Drag (wires follow) on the selection. */
  'schematic.move': { scope: 'schematic', bindings: [{ key: 'm' }] },
  'schematic.drag': { scope: 'schematic', bindings: [{ key: 'g' }] },
  /** KiCad's Highlight Net and Clear Net Highlighting, as the board's. */
  'schematic.highlightNet': { scope: 'schematic', bindings: [{ key: '`' }] },
  'schematic.clearHighlight': { scope: 'schematic', bindings: [{ key: '~' }] },
  'schematic.finishWire': { scope: 'schematic', bindings: [{ key: 'Enter' }] },
  /** KiCad's Leave Sheet (Alt+Backspace) and Navigate Up (Alt+↑): to the parent instance. */
  'schematic.leaveSheet': {
    scope: 'schematic',
    bindings: [
      { key: 'Backspace', alt: true },
      { key: 'ArrowUp', alt: true }
    ]
  },
  /** Mid-draw, `/` toggles the wire elbow posture; idle it focuses search. */
  'schematic.wirePosture': { scope: 'schematic', bindings: [{ key: '/' }] },
  // Clipboard — KiCad's bindings. The clipboard text is KiCad's own, so a copy
  // pastes into KiCad and back (lib/schematic/schematicClipboard.ts).
  'schematic.copy': { scope: 'schematic', bindings: [{ key: 'c', ctrlOrCmd: true }] },
  'schematic.cut': { scope: 'schematic', bindings: [{ key: 'x', ctrlOrCmd: true }] },
  'schematic.paste': { scope: 'schematic', bindings: [{ key: 'v', ctrlOrCmd: true }] },
  'schematic.duplicate': { scope: 'schematic', bindings: [{ key: 'd', ctrlOrCmd: true }] },
  /** Repeat Last Item: KiCad's Insert, with the symbol editor's portable second key. */
  'schematic.repeat': {
    scope: 'schematic',
    bindings: [{ key: 'Insert' }, { key: 'd', ctrlOrCmd: true, shift: true }]
  },

  // --- PCB tools
  'pcb.tool.route': { scope: 'pcb', bindings: [{ key: 'x' }] },
  /** The standalone via tool — KiCad's Ctrl+Shift+X; bare V is the mid-route via. */
  'pcb.tool.via': { scope: 'pcb', bindings: [{ key: 'x', ctrlOrCmd: true, shift: true }] },
  /** Mid-route: drop a via at the tail and carry on on the other layer (KiCad's V). */
  'pcb.routeVia': { scope: 'pcb', bindings: [{ key: 'v' }] },
  // KiCad's: blind/buried via, and the via whose layer is picked from a list (R41, R43).
  'pcb.routeBlindVia': { scope: 'pcb', bindings: [{ key: 'v', alt: true, shift: true }] },
  'pcb.routeViaPickLayer': { scope: 'pcb', bindings: [{ key: '<' }] },
  'pcb.routeBlindViaPickLayer': { scope: 'pcb', bindings: [{ key: '<', alt: true }] },
  'pcb.layerPairNext': { scope: 'pcb', bindings: [{ key: 'v', shift: true }] },
  // KiCad's Route From Other End, Route Selected and its from-the-other-end form (R44, R45).
  'pcb.routeFromOtherEnd': { scope: 'pcb', bindings: [{ key: 'e', ctrlOrCmd: true }] },
  // KiCad's Route Differential Pair (PR1).
  'pcb.routeDiffPair': { scope: 'pcb', bindings: [{ key: '6' }] },
  // KiCad's length tuners: a single track, a pair, a pair's skew (T1, T5).
  'pcb.tuneSingle': { scope: 'pcb', bindings: [{ key: '7' }] },
  'pcb.tunePair': { scope: 'pcb', bindings: [{ key: '8' }] },
  'pcb.tuneSkew': { scope: 'pcb', bindings: [{ key: '9' }] },
  // KiCad's Length Tuning Settings (Ctrl+L), and its Properties key (E) while a tuner is armed (T6).
  'pcb.tuneSettings': { scope: 'pcb', bindings: [{ key: 'l', ctrlOrCmd: true }, { key: 'e' }] },
  // Mid-tune, KiCad's: meander spacing up and down, amplitude up and down (T1).
  'pcb.tuneSpacingIncrease': { scope: 'pcb', bindings: [{ key: '1' }] },
  'pcb.tuneSpacingDecrease': { scope: 'pcb', bindings: [{ key: '2' }] },
  'pcb.tuneAmplitudeIncrease': { scope: 'pcb', bindings: [{ key: '3' }] },
  'pcb.tuneAmplitudeDecrease': { scope: 'pcb', bindings: [{ key: '4' }] },
  'pcb.routeSelected': { scope: 'pcb', bindings: [{ key: 'x', shift: true }] },
  'pcb.routeSelectedFromEnd': { scope: 'pcb', bindings: [{ key: 'e', shift: true }] },
  /** KiCad's Move: the selection picks up at the pointer; a click drops it. */
  'pcb.move': { scope: 'pcb', bindings: [{ key: 'm' }] },
  /**
   * KiCad's Highlight Net: the net under the pointer stays lit until cleared —
   * the same net again, or nothing under the pointer, clears it — and
   * Clear Net Highlighting.
   */
  'pcb.highlightNet': { scope: 'pcb', bindings: [{ key: '`' }] },
  'pcb.clearHighlight': { scope: 'pcb', bindings: [{ key: '~' }] },
  'pcb.rotate': { scope: 'pcb', bindings: [{ key: 'r' }] },
  'pcb.rotateClockwise': { scope: 'pcb', bindings: [{ key: 'r', shift: true }] },
  /** Change side — KiCad's Flip, F. Mid-route F is Attempt Finish instead (PcbEditor orders the checks). */
  'pcb.flip': { scope: 'pcb', bindings: [{ key: 'f' }] },
  /** Enter finishes: runs the open Fanout overlay. */
  'pcb.finish': { scope: 'pcb', bindings: [{ key: 'Enter' }] },
  /** Edit ▸ Fanout…: the Fanout overlay on the selected footprint. KiCad has none; Shift is F's variant. */
  'pcb.fanout': { scope: 'pcb', bindings: [{ key: 'f', shift: true }] },
  'pcb.dragTrack': { scope: 'pcb', bindings: [{ key: 'd' }] },
  /** Drag a track at free angle, whatever the corner mode (KiCad's G). */
  'pcb.dragTrackFree': { scope: 'pcb', bindings: [{ key: 'g' }] },
  /** Mid-route: route the rest of the way to the target (KiCad's Attempt Finish, F). */
  'pcb.finishRoute': { scope: 'pcb', bindings: [{ key: 'f' }] },
  /** Mid-route: lay the head and end the route there (KiCad's End Track). */
  'pcb.endRoute': { scope: 'pcb', bindings: [{ key: 'End' }] },
  'pcb.unrouteLast': { scope: 'pcb', bindings: [{ key: 'Backspace' }] },
  'pcb.layerTop': { scope: 'pcb', bindings: [{ key: 'PageUp' }] },
  'pcb.layerBottom': { scope: 'pcb', bindings: [{ key: 'PageDown' }] },
  'pcb.layerNext': { scope: 'pcb', bindings: [{ key: '+' }] },
  'pcb.layerPrev': { scope: 'pcb', bindings: [{ key: '-' }] },
  /**
   * Step the route's track width and via size (docs/router-behavior.md S5) —
   * KiCad's W / Shift+W and ' / \. Q opens the custom size form at the cursor
   * (S6), as KiCad's Q opens its Custom Track/Via Size dialog.
   */
  'pcb.trackWidthNext': { scope: 'pcb', bindings: [{ key: 'w' }] },
  'pcb.trackWidthPrev': { scope: 'pcb', bindings: [{ key: 'w', shift: true }] },
  'pcb.viaSizeNext': { scope: 'pcb', bindings: [{ key: "'" }] },
  'pcb.viaSizePrev': { scope: 'pcb', bindings: [{ key: '\\' }] },
  'pcb.routeSizes': { scope: 'pcb', bindings: [{ key: 'q' }] },
  /** While routing: every routing key on a card by the hint (router-behavior.md K4). */
  'pcb.routeKeys': { scope: 'pcb', bindings: [{ key: '?' }] },
  /** Mid-route, `/` flips the elbow posture (the schematic wire idiom); idle it focuses search. */
  'pcb.routePosture': { scope: 'pcb', bindings: [{ key: '/' }] },
  /** Recompute zone fills — KiCad's B. */
  'pcb.refillZones': { scope: 'pcb', bindings: [{ key: 'b' }] },
  /** Component bodies over the layout — KiCad's 3D-view key, Alt+3. */
  'pcb.toggleRender': { scope: 'pcb', bindings: [{ key: '3', alt: true }] },
  /**
   * Step the route's corner mode: 45°, rounded 45°, 90°, rounded 90° —
   * KiCad's Track Corner Mode Switch (lib/pcbRouter.ts).
   */
  'pcb.routeCorner': { scope: 'pcb', bindings: [{ key: '/', ctrlOrCmd: true }] },
  /**
   * Cycle the 45°/90°/free line mode of the line, polygon and zone tools —
   * KiCad's Shift+Space (`lib/lineMode.ts`). The matcher treats Shift as
   * carried on punctuation/space keys, so bare Space cycles too; nothing else
   * in the PCB scope binds it.
   */
  'pcb.lineMode': { scope: 'pcb', bindings: [{ key: ' ', shift: true }] },
  /** Lock or unlock the selection — KiCad's L (toggleLock). */
  'pcb.toggleLock': { scope: 'pcb', bindings: [{ key: 'l' }] },
  /** Delete the selected tracks with their whole connection — KiCad's Shift+Del. */
  'pcb.deleteFullTrack': { scope: 'pcb', bindings: [{ key: 'Delete', shift: true }] },
  /** Select / expand the connection — KiCad's U. */
  'pcb.selectConnection': { scope: 'pcb', bindings: [{ key: 'u' }] },
  /** The zone tool — Alt+Z, the keymap's navigation-and-modes slot (KiCad's Ctrl+Shift+Z is redo here). */
  'pcb.tool.zone': { scope: 'pcb', bindings: [{ key: 'z', alt: true }] },
  /** Place a footprint from a library — KiCad's A (Place Footprints). */
  'pcb.tool.footprint': { scope: 'pcb', bindings: [{ key: 'a' }] },
  /** Sketch (outline) tracks on and off — KiCad's K. */
  'pcb.sketchTracks': { scope: 'pcb', bindings: [{ key: 'k' }] },
  /**
   * Cycle the router's collision mode — shove, walkaround, highlight — from any
   * tool, since a track drag reads it too (the collision pill, lib/pcbRouter.ts).
   * KiCad binds no key to it; Alt+letter is the keymap's modes slot, and
   * Altium's Shift+R is rotate here.
   */
  'pcb.cycleRouteMode': { scope: 'pcb', bindings: [{ key: 'r', alt: true }] },
  /** Cycle how inactive layers draw: shown, dimmed, hidden — KiCad's H (high contrast). */
  'pcb.cycleInactiveLayers': { scope: 'pcb', bindings: [{ key: 'h' }] },
  // Graphics tools take KiCad's own pcbnew bindings (Ctrl+Shift+letter);
  // rectangle is unbound there and stays unbound here.
  'pcb.tool.line': { scope: 'pcb', bindings: [{ key: 'l', ctrlOrCmd: true, shift: true }] },
  'pcb.tool.arc': { scope: 'pcb', bindings: [{ key: 'a', ctrlOrCmd: true, shift: true }] },
  'pcb.tool.circle': { scope: 'pcb', bindings: [{ key: 'c', ctrlOrCmd: true, shift: true }] },
  'pcb.tool.polygon': { scope: 'pcb', bindings: [{ key: 'p', ctrlOrCmd: true, shift: true }] },
  'pcb.tool.text': { scope: 'pcb', bindings: [{ key: 't', ctrlOrCmd: true, shift: true }] },
  // Clipboard — KiCad's bindings, through lib/documentClipboard.ts: a board
  // and a footprint paste into each other (lib/board/pcbClipboard.ts).
  'pcb.copy': { scope: 'pcb', bindings: [{ key: 'c', ctrlOrCmd: true }] },
  'pcb.cut': { scope: 'pcb', bindings: [{ key: 'x', ctrlOrCmd: true }] },
  'pcb.paste': { scope: 'pcb', bindings: [{ key: 'v', ctrlOrCmd: true }] },
  'pcb.duplicate': { scope: 'pcb', bindings: [{ key: 'd', ctrlOrCmd: true }] },
  'pcb.tool.bezier': { scope: 'pcb', bindings: [{ key: 'b', ctrlOrCmd: true, shift: true }] },

  // --- Footprint tools
  'footprint.tool.pad': { scope: 'footprint', bindings: [{ key: 'p' }] },
  'footprint.tool.line': {
    scope: 'footprint',
    bindings: [{ key: 'l', ctrlOrCmd: true, shift: true }]
  },
  'footprint.tool.polygon': {
    scope: 'footprint',
    bindings: [{ key: 'p', ctrlOrCmd: true, shift: true }]
  },
  'footprint.tool.text': {
    scope: 'footprint',
    bindings: [{ key: 't', ctrlOrCmd: true, shift: true }]
  },
  // Rectangle is unbound here as on the board (KiCad binds none).
  'footprint.tool.circle': {
    scope: 'footprint',
    bindings: [{ key: 'c', ctrlOrCmd: true, shift: true }]
  },
  'footprint.tool.arc': {
    scope: 'footprint',
    bindings: [{ key: 'a', ctrlOrCmd: true, shift: true }]
  },
  'footprint.tool.bezier': {
    scope: 'footprint',
    bindings: [{ key: 'b', ctrlOrCmd: true, shift: true }]
  },
  /** KiCad's Move, as the board's. */
  'footprint.move': { scope: 'footprint', bindings: [{ key: 'm' }] },
  'footprint.rotate': { scope: 'footprint', bindings: [{ key: 'r' }] },
  'footprint.rotateClockwise': { scope: 'footprint', bindings: [{ key: 'r', shift: true }] },
  /** Change side: mirror left-right onto the other layers (KiCad's F). */
  'footprint.flip': { scope: 'footprint', bindings: [{ key: 'f' }] },
  /** Cycle how inactive layers draw — KiCad's high-contrast H. */
  'footprint.inactiveLayers': { scope: 'footprint', bindings: [{ key: 'h' }] },
  /** Cycle the 45°/90°/free line mode of the line and polygon tools — KiCad's Shift+Space. */
  'footprint.lineMode': { scope: 'footprint', bindings: [{ key: ' ', shift: true }] },
  'footprint.copy': { scope: 'footprint', bindings: [{ key: 'c', ctrlOrCmd: true }] },
  'footprint.cut': { scope: 'footprint', bindings: [{ key: 'x', ctrlOrCmd: true }] },
  'footprint.paste': { scope: 'footprint', bindings: [{ key: 'v', ctrlOrCmd: true }] },
  'footprint.duplicate': { scope: 'footprint', bindings: [{ key: 'd', ctrlOrCmd: true }] },

  // --- Symbol editor (KiCad's symbol-editor bindings)
  'symbol.tool.pin': { scope: 'symbol', bindings: [{ key: 'p' }] },
  'symbol.tool.line': { scope: 'symbol', bindings: [{ key: 'l', ctrlOrCmd: true, shift: true }] },
  'symbol.tool.polygon': {
    scope: 'symbol',
    bindings: [{ key: 'p', ctrlOrCmd: true, shift: true }]
  },
  'symbol.tool.circle': { scope: 'symbol', bindings: [{ key: 'c', ctrlOrCmd: true, shift: true }] },
  'symbol.tool.arc': { scope: 'symbol', bindings: [{ key: 'a', ctrlOrCmd: true, shift: true }] },
  'symbol.tool.bezier': { scope: 'symbol', bindings: [{ key: 'b', ctrlOrCmd: true, shift: true }] },
  'symbol.tool.text': { scope: 'symbol', bindings: [{ key: 't', ctrlOrCmd: true, shift: true }] },
  /** KiCad's Move, as the schematic's. */
  'symbol.move': { scope: 'symbol', bindings: [{ key: 'm' }] },
  'symbol.rotate': { scope: 'symbol', bindings: [{ key: 'r' }] },
  'symbol.rotateClockwise': { scope: 'symbol', bindings: [{ key: 'r', shift: true }] },
  'symbol.mirrorHorizontal': { scope: 'symbol', bindings: [{ key: 'x' }] },
  'symbol.mirrorVertical': { scope: 'symbol', bindings: [{ key: 'y' }] },
  'symbol.duplicate': { scope: 'symbol', bindings: [{ key: 'd', ctrlOrCmd: true }] },
  'symbol.copy': { scope: 'symbol', bindings: [{ key: 'c', ctrlOrCmd: true }] },
  'symbol.cut': { scope: 'symbol', bindings: [{ key: 'x', ctrlOrCmd: true }] },
  'symbol.paste': { scope: 'symbol', bindings: [{ key: 'v', ctrlOrCmd: true }] },
  /**
   * Repeat Last Item. `Insert` is KiCad's, and is listed first so the menus show
   * the key a KiCad user already knows — but **Apple keyboards have no Insert
   * key**, so it cannot be the only one (RULES.md §7). `Ctrl/Cmd+Shift+D` is the
   * portable second: a repeat is a duplicate that knows where to go, so it sits
   * beside `Ctrl+D` in both meaning and muscle memory.
   */
  'symbol.repeat': {
    scope: 'symbol',
    bindings: [{ key: 'Insert' }, { key: 'd', ctrlOrCmd: true, shift: true }]
  },

  // --- Terminal tabs. Ctrl+C and Ctrl+V belong to the program running in the
  // terminal (SIGINT, and a literal ^V), so on Windows/Linux copy and paste take
  // the Shift variants every terminal emulator uses. macOS has no such conflict,
  // and Cmd+C/Cmd+V are listed as well so the platform's own gesture works.
  'terminal.copy': {
    scope: 'terminal',
    bindings: [
      { key: 'c', ctrl: true, shift: true },
      { key: 'c', cmd: true }
    ]
  },
  'terminal.paste': {
    scope: 'terminal',
    bindings: [
      { key: 'v', ctrl: true, shift: true },
      { key: 'v', cmd: true }
    ]
  }
} satisfies Record<string, HotkeyDef>

export type HotkeyActionId = keyof typeof HOTKEY_DEFS

export const HOTKEYS: Record<HotkeyActionId, HotkeyDef> = HOTKEY_DEFS

/** Narrows an arbitrary string to a known action id. */
export const isHotkeyActionId = (id: string): id is HotkeyActionId => id in HOTKEYS

/**
 * Mouse gestures, collected alongside the hotkeys they mirror. Not
 * user-configurable yet — declared here so the whole input surface is
 * visible in one place when the settings UI arrives.
 */
export const MOUSE_GESTURES = {
  /** All 2D viewports (`ViewportEngine`) and the 3D model viewer (`Viewport3DEngine`). */
  'editor.fitView': 'middle-button double-click',
  /** `ViewportEngine` 2D pan; `Viewport3DEngine` orbits/pans via OrbitControls. */
  'editor.pan': 'middle-button drag, or Ctrl/Cmd + left drag'
} as const

/** Two presses within this window count as a middle-button double-click. */
export const MIDDLE_DOUBLE_CLICK_INTERVAL_MS = 400

const isMac =
  typeof navigator !== 'undefined' && (navigator.platform ?? '').toUpperCase().includes('MAC')

/**
 * The key an event names. macOS's Option composes a character (Option+P is
 * `π`, Option+3 is `£`), so an Alt binding on a letter or digit reads the
 * physical key there instead.
 * Only on macOS: elsewhere Ctrl+Alt is AltGr on many layouts, and a key that
 * composed a character must stay a character.
 */
const eventKey = (e: KeyboardEvent, binding: HotkeyBinding): string => {
  if (isMac && binding.alt && /^[a-z0-9]$/.test(binding.key)) {
    const physical = /^(?:Key|Digit)(.)$/.exec(e.code)
    if (physical) return physical[1].toLowerCase()
  }
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

const matchesBinding = (e: KeyboardEvent, binding: HotkeyBinding): boolean => {
  if (eventKey(e, binding) !== binding.key) return false
  // AltGr arrives as Ctrl+Alt on Windows; it is typing, never a shortcut.
  if (e.getModifierState?.('AltGraph')) return false
  if (binding.ctrlOrCmd) {
    if (!e.ctrlKey && !e.metaKey) return false
  } else if (binding.ctrl) {
    if (!e.ctrlKey || e.metaKey) return false
  } else if (binding.cmd) {
    if (!e.metaKey || e.ctrlKey) return false
  } else if (e.ctrlKey || e.metaKey) {
    return false
  }
  if (e.altKey !== !!binding.alt) return false
  // Punctuation keys already encode Shift on layouts that need it (e.g. `/`
  // is Shift+7 on German keyboards), so Shift is only meaningful for letters
  // and named keys.
  const shiftCarriesKey = binding.key.length === 1 && !/[a-z]/.test(binding.key)
  if (!shiftCarriesKey && e.shiftKey !== !!binding.shift) return false
  return true
}

/** True when the event matches any binding of the action. */
export const matchesHotkey = (e: KeyboardEvent, action: HotkeyActionId): boolean =>
  HOTKEYS[action].bindings.some((binding) => matchesBinding(e, binding))

/** Compact display names for chips/tooltips. */
const KEY_DISPLAY: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

const bindingLabel = (binding: HotkeyBinding): string => {
  const key =
    KEY_DISPLAY[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  if (isMac) {
    return [
      binding.ctrl ? '⌃' : '',
      binding.alt ? '⌥' : '',
      binding.shift ? '⇧' : '',
      binding.ctrlOrCmd || binding.cmd ? '⌘' : '',
      key
    ].join('')
  }
  const parts: string[] = []
  if (binding.ctrlOrCmd || binding.ctrl) parts.push('Ctrl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * Human-readable label of the action's primary binding, platform-styled:
 * `Ctrl+L` on Windows/Linux, `⌘L` (symbols, mac convention) on macOS.
 */
export const hotkeyLabel = (action: HotkeyActionId): string =>
  bindingLabel(HOTKEYS[action].bindings[0])

/** Every binding of the action, primary first, styled as `hotkeyLabel`. */
export const hotkeyLabels = (action: HotkeyActionId): string[] =>
  HOTKEYS[action].bindings.map(bindingLabel)

/**
 * A toolbar button's tooltip: its name, and its hotkey when it has one —
 * "Arc (Ctrl+Shift+A)". The name alone is enough on a tool; what it does on
 * the canvas is the tool's to show, not the tooltip's to explain. `every`
 * lists each binding, for an action whose second key is the one some keyboards
 * need: "Zoom to fit (Home, Ctrl+0)".
 */
export const toolTitle = (label: string, action?: HotkeyActionId, every = false): string =>
  action ? `${label} (${every ? hotkeyLabels(action).join(', ') : hotkeyLabel(action)})` : label

/** Electron's accelerator spelling of the keys that aren't their own name. */
const ACCEL_KEY: Record<string, string> = {
  ' ': 'Space',
  '+': 'Plus',
  '-': 'Minus',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down'
}

/**
 * The action's primary binding as an Electron accelerator (`CmdOrCtrl+S`), for
 * the macOS system menu bar — native menu items render their own shortcut and
 * want this form rather than `hotkeyLabel`'s display text.
 */
export const hotkeyAccelerator = (action: HotkeyActionId): string => {
  const binding = HOTKEYS[action].bindings[0]
  const parts: string[] = []
  if (binding.ctrlOrCmd) parts.push('CmdOrCtrl')
  else if (binding.ctrl) parts.push('Control')
  else if (binding.cmd) parts.push('Command')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(
    ACCEL_KEY[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  )
  return parts.join('+')
}

/**
 * The primary binding as a `KeyboardEvent` init, so a native menu selection can
 * be replayed through the same keydown listeners the shortcut already runs.
 * macOS registers menu accelerators with the system and swallows the key before
 * the page sees it, so without this a menu-driven Save would skip the work the
 * editors hang off their own Ctrl/Cmd+S handlers.
 */
export const hotkeyEventInit = (action: HotkeyActionId): KeyboardEventInit => {
  const binding = HOTKEYS[action].bindings[0]
  return {
    key: binding.key,
    ctrlKey: !!binding.ctrl || (!!binding.ctrlOrCmd && !isMac),
    metaKey: !!binding.cmd || (!!binding.ctrlOrCmd && isMac),
    shiftKey: !!binding.shift,
    altKey: !!binding.alt
  }
}

/** Shared "is the user typing somewhere?" guard for global keydown handlers. */
export const isTypingTarget = (): boolean => {
  const tag = document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Whether a canvas under the pointer may take the keyboard, as KiCad's does on
 * mouse enter (`EDA_DRAW_PANEL_GAL::onEnter`): never from a field being typed
 * in, an open dialog, or while another window is in front.
 */
export const canvasMayTakeKeyboard = (): boolean =>
  document.hasFocus() &&
  !isTypingTarget() &&
  !(document.activeElement as HTMLElement | null)?.isContentEditable &&
  !document.querySelector('[aria-modal="true"]')
