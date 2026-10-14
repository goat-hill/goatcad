# GoatCAD Architecture

The map of the codebase and the rules that span files — what you can't learn by opening one file.
A module's mechanics, numbers and edge cases are in its header comment; open work is in the
`*-workstream.md` docs. Read the section for the system you are touching, then the code it names.

**Shape in one paragraph.** Electron app in `electron/`. **Main** owns the OS, windows, secrets and
every outbound request, and holds no document state. **Renderer** (Vue 3) owns documents, editing,
undo and rendering (Three.js/WebGL). They talk only over the preload bridge (§2). Every design file
is KiCad's own format, read and written byte-identically (`lib/kicad/`). The agent API
(`main/ops/`, §3.11) is served by main but runs design edits in the window, through the same
command layer as the GUI.

## 1. Directory Structure & Component Roles

A monorepo of independent npm projects — no root `package.json`, no root build; each project builds from its own directory. Paths below are relative to `electron/src/` unless they start at the repo root.

**Repo root**
- `electron/` — the GoatCAD ECAD app (electron-vite + Vue 3). Own `package.json`, `electron-builder.yml`, `bin/*` wrappers (run from `electron/`), `scripts/` (screenshot/record/verify-packaged harnesses), `build/` (icons, entitlements, notarize), `wasm/` (sources and build notes for the committed Clipper2 and pdfium wasm — our flat-C-ABI Emscripten builds; each has a README).
- `develop/` — GoatHerd, an internal Electron app for running parallel Claude Code workstreams (worktrees, embedded terminals, hook-driven status). Self-contained; see `develop/README.md`. `.goatherd/` (gitignored) is its per-worktree scratch.
- `web/` — goatcad.com (Astro, Cloudflare). Self-contained; see [WEB.md](./WEB.md).
- `docs/` — these docs; `references/` holds the KiCad format spec, `research/` background studies.
- `.github/workflows/` — CI, release, web deploy ([RELEASES.md](./RELEASES.md)).

**Main process — `main/`** (Node; owns the OS, windows and secrets)
- `index.ts` — entry: app lifecycle, window manager, tab transfer, and most IPC handlers (§2). `appConfig.ts` — the global config store (settings, recents, window sessions). `launchArgs.ts` / `launchChecks.ts` — OS file-open and startup probes. `updater.ts` — self-update ([RELEASES.md](./RELEASES.md)). `appMenu.ts` — the macOS native menu, drawn from the renderer's tree.
- `git*.ts` — git over the system binary, no npm library (§3.4). `projectWatcher.ts` — filesystem half of the project change bus.
- `libraryIndex*.ts`, `kicadLibraries.ts`, `kicadGlobalTables.ts`, `modelResolver.ts` — library index worker and KiCad library/model resolution (§3.5, §3.3).
- `step*.ts`, `datasheet*.ts` (+ `wasm/` pdfium) — worker-thread loaders: STEP tessellation, PDF reading. Pattern: a thin client with lazy spawn over a `worker_threads` entry.
- `parts*.ts` — distributor search (§3.10): `parts.ts` is Electron-free; `partsIpc.ts` is the only Electron plumbing. `partsMcp*.ts`, `mcpEndpoint.ts`, `mcpToken.ts` — the MCP server and its bridge to the window (§3.11).
- `ops/` — the agent operation registry (§3.11): `<domain>/<verb>.ts`, one file per operation; `ops/index.ts` is the only definition of what an agent can do (MCP tools, `/v1` discovery and the Python client in `pythonClient.ts`/`pythonRuntime.ts` all derive from it).
- `terminal*.ts`, `agentActivity.ts`, `agentStatusServer.ts` — terminal tabs and agent launch/status (§3.12). `designWindow.ts` — which window answers an agent's design request (§3.14).
- `mediaProtocol.ts` — `goatcad-media://` (§2). `outboundFetch.ts` — every outbound request, through Chromium's network stack. `zip.ts`, `png.ts` — dependency-free writers.

**Preload — `preload/`**
- `index.ts` — the bridge (`window.api`); `index.d.ts` — its typing. `*Types.d.ts` — every cross-process type (RULES.md §9).

**Shared — `shared/`** (pure TypeScript that main, preload types and the renderer all import; no Node or DOM API, no import from outside it)
- `itemRecords.ts`, `recordRules.ts` — what an agent's item record takes on each document, and what each value must be (§3.11, [agent-api.md](./agent-api.md) Implementation notes).

**Renderer — `renderer/src/`** (Vue; owns documents, editing and undo)
- `main.ts` (bootstrap), `App.vue` (IDE shell, global hotkeys), `i18n.ts` + `locales/` (`en/` is the source of truth; other locales mirror it key-for-key, enforced by test).
- `assets/base.css` — theme tokens and canvas palette ([DESIGN.md](./DESIGN.md)).
- `lib/kicad/` — the file format read and written byte for byte (S-expression tokenizer, AST mappers and mutators, `.kicad_pro`, lib tables, migration). The one folder that may name KiCad, and nothing in it knows an editor (RULES.md §7).
- `lib/schematic/`, `lib/board/`, `lib/symbol/`, `lib/footprint/` — each design kind as a design over `kicad/`: connectivity, checks, tools, clipboard, find, property schemas, and the agent's door (`*Agent.ts`, §3.11). `lib/board/router/` is the interactive router engine, pure TS, and `lib/board/routeController.ts` the route tool's headless state machine over it, which the PCB editor and an agent's routing session both drive; `lib/board/spatialIndex.ts` is the copper index routing, ratsnest, DRC and the zone filler all stand on.
- `lib/document/documentStore.ts` — one document per open tab, independent of any view (§3.13). `lib/history.ts` — the undo/redo history editors' command layers push to. `lib/commands.ts` — menu command metadata (dispatch is in `App.vue`).
- `lib/project/` — files as a project: active-project detection, members, blank-file templates, scaffolding, rename plans. `lib/projectBus.ts` — the project change bus.
- `lib/engine/` — Three.js viewports and batched 2D scenes (`ViewportEngine.ts`, `*Scene.ts`); `lib/engine/board3d/` — the 3D board build, stepwise under `lib/cooperate.ts`'s frame budget (§3.3).
- `lib/geometry/` — 2D polygon kernel (Clipper2 wasm facade `clip.ts`, partitioned booleans `regionClips.ts`, `yStripes.ts` probes). Future zone refill / mask expansion / DRC booleans belong here.
- `lib/gerber/` — vendor-neutral Gerber/Excellon read and write, deliberately not under `kicad/`. The CPL placement transform lives in `lib/schematic/placement.ts`.
- `lib/git/` — diff tabs and commit loop (§3.4).
- `lib/` top level — cross-editor models: tabs and editor groups (`tabs.ts`, `tabFileType.ts`, `editorGroups.ts`, `editorWorkspace.ts`, §3.14), cross-probe (`crossProbe*.ts`), menus and hotkeys (`menu.ts`, `hotkeys.ts` — every binding as data), property tables, selection, find (`canvasFind.ts`), tool search, icons (`icons.ts`, rendered by `components/shared/Icon.vue`), design health (§3.16), file-type routing (`fileTypes.ts`: anything unrecognized gets the info tab, never the text editor).
- Persisted view state (`selectionFilter.ts`, `board3dView.ts`, `pcbView.ts`, `symbolView.ts`, `schematicView.ts`, `panelLayout.ts`, `gridPreferences.ts`) — all one pattern: a store over `config:*`, shared across windows, never in the design file.
- `components/` — `EditorArea.vue` / `EditorGroup.vue` (the workspace and a group's tab strip, §3.14), one `*Editor.vue` coordinator per design kind with its sub-views in the matching folder (`schematic/`, `pcb/`, `symbol/`, `footprint/`), viewer tabs (`*Viewer.vue`), `Sidebar.vue` (activity bar and panes), `TitleBar.vue` (menus and window controls). `components/shared/` holds the editor-agnostic building blocks (PropertyTable, CollapsiblePanel, LayersPanel, HealthPill, CanvasFindWidget, brand marks).

## 2. IPC Channels & Native APIs

Every window is an isolated renderer; anything touching the OS, another window, or a secret goes through main.

**Where channels live.** The source is the list — don't mirror it here. Adding a channel is the three-site change in RULES.md §9:
- **Main** — `main/index.ts` registers most handlers; domain modules register their own from it: `partsIpc.ts` (`parts:*`), `partsMcpIpc.ts` + `partsMcpBridge.ts` (`mcp:*`), `libraryIndex.ts` (`index:*`).
- **Preload** — `preload/index.ts` exposes each as a named `window.api` method (doc comments say what each is for); `preload/index.d.ts` types them. Shared payload types go in `preload/*Types.d.ts`.
- Not channels: `window.api.platform` and `window.api.homeDir` are constants on the bridge — they never change for the life of the process.

**Naming.** `domain:verb-noun`, kebab-case (`fs:read-file`, `git:status`, `dialog:pick-directory`). Main→renderer events are named for what happened (`config:changed`, `tab:add`, `terminal:data`).

**Invoke vs send vs event.**
- `invoke` for anything with an answer. Failures come back as a value (`{ success, error }`, a `state`, a `PartsResult`) rather than a rejection, so the UI can degrade (RULES.md §8).
- `send` when nothing answers or nothing must await: keystrokes (`terminal:input`), notifications, and replies where the renderer is the responder and main holds the promise (`mcp:design-reply`, `window:close-confirmed`).
- Events are either **broadcast** to every window — shared state (`config:changed` after any config or recents write, `parts:credentials-changed`) — or **relayed to the other windows** (`project:notify-change`, `crossprobe:notify`: the sender already handled its own), or **addressed** to one window (`terminal:data` to the session's owner; `mcp:design-request` to the window holding the document).

**Cross-cutting rules.**
- Main never holds document state: dirty flags, the KiCad AST and the undo stack live in the renderer. So main vetoes every window close and asks the renderer (`window:confirm-close` handshake), and agent edits are forwarded to a window rather than done in main.
- Main has no vue-i18n: dialogs take copy already translated by the renderer.
- `config:update` writes only keys allowlisted in `writableConfigPatch` (`main/appConfig.ts`); a missing key is silently dropped and the UI snaps back. Recents and sessions have their own channels.
- Secrets flow one way, into main: no channel returns a stored key (`partsTypes.d.ts`). The renderer CSP stays closed to remote hosts — main fetches remote images; external links open via main, https-only.
- The renderer never names a command to run: `terminal:start` takes a *kind*, and `main/terminalAgents.ts` is the whole vocabulary.
- File deletes go to the OS trash — file operations sit outside undo. Writes refuse to overwrite (`EEXIST`) unless the channel says it saves.
- Validate and allowlist whatever crosses from the renderer (RULES.md §9).

**Beyond IPC — `goatcad-media://`** (`main/mediaProtocol.ts`). PDF and HTML viewer tabs load files through a Range-aware streaming protocol into an iframe, so large files never cross IPC (base64 over `fs:read-file-base64` is for images only). Extensions are allowlisted (no scripts — the second fence behind the HTML iframe's sandbox). The URL encoder in renderer `lib/documentFiles.ts` and the decoder in main change together; a round-trip test pins them.

## 3. Key Design Patterns

### 3.0 App Launch, Global Config & Session Restore

- **Identity**: `APP_NAME`/`APP_ID` in `main/appConfig.ts`; `app.setName` runs before any `getPath('userData')`. A rename touches `appConfig.ts`, `electron-builder.yml` and `bin/reset` together.
- **Config lives in main** (`ConfigStore`, one `config.json` under userData; `./bin/reset` wipes the dir). Renderers never use `localStorage` for app state — they go through `config:*`, so windows can't race, and `config:changed` broadcasts every change to every window. The whole file is broadcast, so **no secret ever goes in it**. Main holds no dirty state and has **no vue-i18n**: the renderer owns unsaved-work state and passes already-translated copy to native dialogs. View preferences (grid, panel sizes, 3D options, selection filter) all follow the same pattern as `lib/selectionFilter.ts`.
- **Library tables**: footprint table in `libraries.json`, the global symbol tier in `symbol-libraries.json`; the project symbol tier is KiCad's own `sym-lib-table` (`lib/kicad/symbolLibraryTable.ts`), and the project shadows global on a nickname clash.
- **File associations** (`electron-builder.yml` ↔ `KICAD_EXTENSIONS` in `main/launchArgs.ts`): register only unambiguously-ECAD types. Never generic ones (images, STEP/WRL). All OS entry paths (argv, `second-instance`, macOS `open-file`) funnel through `parseFileArgs` → `groupOpenTargets`. Opening a file makes its containing directory the project folder.
- **Title bar and menus split by platform, as in VS Code**: Windows/Linux get a frameless window drawn by `TitleBar.vue`, and macOS gets `titleBarStyle: 'hidden'` plus the system menu bar with no wordmark. The menu tree is declared once in `TitleBar.vue` (`SECTION_IDS` feeds both surfaces), serialized by `lib/nativeMenu.ts`, and arranged by `main/appMenu.ts`. **Which menu roles are used is a correctness question**, because a macOS accelerator takes the key before the page does (see the `appMenu.ts` header for which roles are used and why, and `clearApplicationMenu` for Windows/Linux). Commands with a shortcut are replayed as synthetic keydowns, so the menu never does less than the key.
- **Launch precedence**: files and folders from the OS, then the restored session, then a single welcome window. The window pulls its `Partial<WindowSession>` over `window:get-init`. `--background` opens none and quits once it has no window and no agent connection; `help` runs a command instead of the app (`launchArgs.ts` `launchMode`, `commandLine.ts`), before the single-instance lock.
- **Workspaces** (`main/workspaces.ts`): a window belongs to one workspace (a folder and its active project), a tab dragged out joins its source's, and a session groups a workspace's windows (`WindowSession.workspace`). A workspace an agent started with no window is a hidden renderer, left out of the session; Open Folder, Recents, the OS and a restore that name its folder show it rather than open the folder twice (`workspace:open-elsewhere`).
- **Session restore** (`main/index.ts` `captureSession`/`sanitizeSessions`): each renderer reports over `session:update`, but only after its init has been applied. Each report is persisted as it arrives (the config write is debounced), so a restart that closes no window — a dev-mode main rebuild, a crash — reopens the latest state, and `window:get-init` answers from the window's live state (`windowInitFor`), so a renderer reload comes back as the window was, not as it was created. A quit's snapshot is final; windows closing after it do not shrink it. `activeProjectPath` is a preference re-checked against detection (projects.md §3), not a restore.
- **Virtual tabs** (`lib/tabs.ts`, `goatcad://…`): Welcome, Settings, Manufacture (per board, reachable only from the PCB properties panel), Components and Schematic Setup (per design root). They are tabs rather than modals or drawers, so the IDE shell is always mounted. Only one of each opens; opening it again focuses it. These tabs are not files: they are absent from `SAVABLE_TYPES` and from the agent's `fileTabs`. **Child tabs** (`tabParent`): Board Setup, Components, Manufacture, Schematic Setup and design copies belong to one design file's tab. App keeps each after its parent (`nestChildTabs`), which the strip draws as one family; a child closes with its parent, opens it when it arrives alone, and moves windows with it. Board Setup, Components and design copies are views on the parent's document, so their unsaved mark is the parent's; Ctrl+S on any child saves the parent. Sample projects come from the `goat-hill/goatcad-sample-projects` repo at runtime (`main/sampleProjects.ts`), not from the release.
- **Theme**: `data-theme` on the root, with `assets/base.css` as the palette source. `theme.ts` owns the KiCad layer display palettes. Exports keep `KICAD_LAYER_COLORS` unchanged.
- **Fabrication outputs** read everything from the one `.kicad_pcb`, **never the schematic**: a fab package describes the board being made. One writer per file kind (`lib/fabExport.ts`) serves both the Manufacture tab's Export and the `export.*` ops, and `render.gerbers` draws a written set back off-screen (`lib/engine/gerberCapture.ts`, the composite stack that `captureFramed` also draws); an export profile (`lib/exportProfiles.ts`, the *output*) is data over those writers, each setting citing the fab's page, and is deliberately separate from manufacturing profiles (`lib/manufacturingProfiles.ts`, the *design*). Open work is in fabrication-export-workstream.md.
- **KiCad versions (migrate on read, upgrade on save)**: the policy is RULES.md §7. Every design-file read passes through `lib/formatUpgrade.ts`, footprints and symbol libraries migrate in their parsers, and `EditorArea.writeTab` is the one save path. Newer files and files from before KiCad 6 open read-only.
- **Project change bus** (`lib/projectBus.ts`; design in projects.md §9): every committed file change is one typed event. A mutation *describes* what happened, and App's `handleProjectChanges` decides what that invalidates. Subscribers are told to invalidate and are never pushed data. Events coalesce per tick, main rebroadcasts them to other windows, and derived views watch App's `projectRevision`. **The AST notifies no one**, by design. `main/projectWatcher.ts` feeds the same bus from disk. It is deliberately coarse, and on Linux it declines above `MAX_WATCHED_DIRECTORIES` (inotify limit), so the explorer's refresh button and refresh-on-focus stay.
- **Launch checks** (`main/launchChecks.ts`) run off the startup path and can be re-run via `system:run-checks`. Importing KiCad's global tables (`main/kicadGlobalTables.ts`) is a **one-time seed, never a live mirror**.
- **Localization** (`i18n.ts`, `locales/<lang>/*.yaml`; workflow in the `localize` skill): `globalInjection: false`, so every component imports `useI18n()`. Files are YAML so they can carry translator comments. `|` is always a plural separator; plural branches follow CLDR category order (`locales/plurals.ts`). Language names are endonyms. `SUPPORTED_LOCALES` in main mirrors the renderer's list, and a test guards that. Never translated: KiCad layer codes, and BOM field labels persisted into `.kicad_pro`. Shared property labels live in `shared.properties.*`. Pure domain code takes a `label(key)` callback rather than importing vue-i18n. Known gap: main-process dialog titles are English.

### 3.1 Multi-Window Tab Drag & Drop

- A tab drags as `application/goatcad-tab` data. When it is dropped outside any window, `window.api.newWindow` opens it in a new window. When it is dropped on another window's tab bar, main routes `tab:remove` to the source window and `tab:add` to the target.
- Window init is one `Promise.allSettled` round trip. Sidebar work runs afterwards, un-awaited, and `sessionReady` gates the empty-state placeholder.
- **Every editor and viewer is lazy** (`defineAsyncComponent` in `EditorGroup.vue`). They pull in three.js, `lib/engine` and the 2.85 MB NewStroke font. **One static import of an editor, `lib/engine`, or NewStroke-reaching `lib/kicad` code from `App.vue`/`EditorArea.vue`/`EditorGroup.vue` pulls it all back into the startup chunk** (check `npm run build`'s `index-*.js`). The window's `backgroundColor` and the inline `<head>` style keep the frames before mount dark.
- **Launch timing**: `launch:*` performance marks in `main/index.ts`, `renderer/src/main.ts` and `App.vue` (session ready) record each milestone; `./bin/launch-timing` launches the built app with a fresh profile and prints them on one clock with the entry chunk's size. Run it after changing what loads at startup; `--record` runs the standard method and appends the medians to `electron/perf/launch-history.html`, a page that renders its own JSON data block.
- **Board timing**: `board:parsed` (`lib/board/boardSession.ts`) and `board:shown` (`PcbViewport2D.vue`, after the scene's first paint) mark a board's open; `./bin/board-timing` drives the built app through a complex board's open and core gestures and `--record` appends the medians to `electron/perf/board-history.html`, the launch page's shape (docs/performance-workstream.md).

### 3.2 KiCAD Compatibility Viewers

**S-expression core (`lib/kicad/sexpr.ts`) is performance-critical:**
- Nodes stay lean, storing offsets rather than line/col.
- Hot shapes (`fp_line`, `segment`, `pts`) parse into **packed nodes** that materialize on `children` access. Packing happens only when the node re-emits byte-identically; the corpus test in `sexpr.test.ts` proves this. Follow its recipe when adding a shape.
- Large boards parse asynchronously (`parseSExprAsync`) under one never-rewinding progress bar (`lib/boardLoadProgress.ts`).
- Serialization is incremental per top-level child. **Every AST mutator must `markNodeDirty` the top-level node it touches, before writing.** That mark is also the structural-undo capture journal. `board.test.ts` guards both uses.

**Coordinates (`lib/kicad/coordinates.ts`)**: the domain holds **integer nanometers** (`Nm`). Values are read through the nm readers and written through `formatNmAtom`, so previews equal commits bit-for-bit. Angles and counts stay plain numbers. The world, scene and engine side is **mm, y-up floats**, because Float32 GPU buffers can't hold nm. Conversions happen at named seams:
- `placement.ts` on the board side.
- `SchematicScene.enginePoint`/`transformLocal` on the schematic side.
- The `strokeOptionsFrom*Effects` functions for text.
- The viewports' tool-input emits.

**The 2D engine (`lib/engine/`)**:
- **The layer stack**: `ViewportEngine.render()` draws manual clear → grid → composite layers → overlay quad → document → crosshair. **`GridShader` must stay transparent** (it never paints a background), or everything composited beneath it disappears.
- **Batches**: `PrimitiveBatch` holds SDF-instanced strokes and pads in one draw call and uploads only the instance ranges it touched. `LabelBatch` holds the SDF glyph atlas, and `HatchShader` draws procedural hatching — footprint fills and the board's zone border hatch — so a hatch is triangles and never line geometry.
- **Dimming**: a dimmed layer is show mode in a darker color: each instance's color is mixed toward the canvas background in the batch shader (`boardView.ts` `viewDim`, from the slot's `uSlotDim`), a fill's in its material (`BoardScene.paintFill`), with alpha untouched, so it darkens without turning see-through (KiCad's `COLOR4D::Mix`). Nothing is drawn offscreen for it.
- **Overlays**: the overlay layer (the schematic's selection glow, net highlight) is flattened opaque and then composited at one opacity, so its alpha never accumulates.
- **Selection draws in front, as a band** — every editor, bottom to top: the document, the selected items, tool previews, then the chrome. A selected item moves into the band whole, its parts with it (a footprint's pads and text, a symbol's pins and fields), keeping its own internal order; nothing is copied. A part about to be placed (a symbol or footprint on the cursor) draws in the band too, as if selected: the same emitter into the preview batch, lifted whole (schematic), or rendered at an index no board item has and lifted and shifted with the selection (`BoardScene.setFootprintGhost`). The schematic and symbol editors lift by z (`Z.selectedLift`), which their depth buffer resolves, and draw a selection halo at the band's boundary (`ViewportEngine.setLiftSplitZ`); a selected item's fills lift less (`Z.selectedFillLift`), staying under that boundary so the halo shows over its own body, and tint toward the selection color. The PCB editors draw no halo: a selected item is marked by its color shift (`selectionShift`, `selectedBand.ts`) and by being in front. They have a second copy of every layer slot above the document (`LIFTED_SLOT_OFFSET`, `layers.ts`): selecting moves an element's instances into its layer's lifted slot (`LayeredBatch.liftElements`, reading what is lifted from the band itself, so rebuilds and edits cannot leave it stale) and its fill meshes up a band (`selectedBand.ts`), which also takes them out of a dimmed layer's flatten.
- **Selection chrome**: `SelectionChrome.ts` is the base. `VertexHandles.ts` is fixed appearance for every editor, and its shape encodes the role. Handles show only on a sole selection. A graphic primitive (`SymbolGraphic`) has one editing path wherever it lives — a symbol body or a sheet's free graphics (`lib/schematic/sheetGraphicEdit.ts` adapts those): its handles, panel rows and writes come from `lib/symbol/graphicEdit.ts`, `graphicGroups` and `symbolEdit.ts`, never an editor's own copy. `TextAnchors.ts` holds passive crosses. Chrome lives in the document scene because the engine raycasts `scene.children`.
- **Canvas sizing**: `devicePixelSize.ts` sizes drawing buffers from `devicePixelContentBoxSize`, **never `clientWidth × dpr`**.
- **Cursor**: `ViewportEngine.setDrawMode` is the one home for the cursor. A CSS `cursor` on a container is overwritten.
- **Grid**: grid and snapping are laid from `ViewportEngine.setGridOrigin`, while the axes stay on the document origin.
- **Rule: anything that must survive a tab switch lives outside the component.** `EditorArea` keys editors on the tab path, so every tab switch destroys the editor. This is why these live at module scope or in the config store: camera (`lib/engine/cameraStore.ts`), panel sizes (`lib/panelLayout.ts`), grid (`lib/gridPreferences.ts`), the document and its history (`lib/document/documentStore.ts`, §3.13), and the view mode (on the tab).
- **Grid and camera are never written to the design file.**

**Schematics** (`lib/kicad/schematic.ts`, `lib/engine/SchematicScene.ts`, `lib/schematic/`; decisions in schematic-editor-workstream.md):
- **Paint order is KiCad's own** (`SCHEMATIC_PAINT_ORDER` ← `SCH_LAYER_ORDER`, pinned by tests).
- Text angle rules are per item kind (`lib/engine/schematicTextOrientation.ts`), and a placed symbol's field reads through the symbol's frame.
- Rendered text resolves KiCad escapes and markup (`lib/kicad/textMarkup.ts`). Connectivity and ERC compare raw strings.
- Hit-testing prefers small items and tests sheet rectangles last (§3.7).
- Every KiCad rule above is checked against `kicad-cli` output. When touching one, re-probe; don't reason from the file alone.
- **Tools**: pure step modules in `lib/schematic/` (`schematicTools.ts`, `drawTools.ts`, `wireReshape.ts`/`schematicMove.ts`, `sheetItemPlacement.ts`, `annotate.ts`, `alignItems.ts`, `symbolUpdate.ts`, `symbolUnits.ts`, `sheetNavigation.ts`, `schematicFind.ts`, `schematicClipboard.ts`). A **preview and its commit are the same function on the same input**, and each ghost is drawn by the item's own writer. Writers splice only their own nodes, and `kicad-cli sch upgrade` round-trips them clean.
- **Undo**: history belongs to the file, not the mount (§3.13). It is cleared when text arrives that the editor didn't commit. A command may rewrite sibling sheets (`SiblingEdit` → `HistoryEntry.files`, opening a background tab when a sheet has none). Known limit: a batched op must not touch siblings.
- **Hierarchy** (`lib/schematic/hierarchy.ts`, `sheetPages.ts`): identity belongs to the sheet *instance* (a path), not the file. Page order follows KiCad's navigator and `ComparePageNum`.
- **Connectivity** (`lib/schematic/connectivity.ts`) follows KiCad saved-file semantics. A wire's interior connects only to a junction, a label or a sheet pin. Net names are KiCad's: each sheet's subgraph picks its driver (`ResolveDrivers`), then across sheets a label beats a sheet pin and the stronger kind wins at any depth, depth only breaking ties (`propagateToNeighbors`). Pin placement composes rotate → flip → mirror, as `SCH_SYMBOL` does. Buses (`busNames.ts` parses vector, group and alias names) join as nets do; each member is the net of its name on the bus's sheet, and members pair across sheet pins by position (vectors) or name (groups). A sheet pin never merges by name: KiCad joins same-sheet nets by name only where a label or power port names them.
- **Symbols**: the embedded `lib_symbols` plus the symbol library table. The standard tier is listed from the index and parsed per library on first pick. `namespaceSymbolLibrary` rewrites names to `Nickname:Name`. Embedded definitions win a clash, and placement annotates immediately (parts never land as `R?`).
- **Components tab** (`ComponentsTableView.vue` over `shared/ComponentsTable.vue` + `lib/componentsTable.ts`): edits go through the root sheet's session (`EditorWorkspace.openSheetSession`), so every row is editable. Presets live in `.kicad_pro` `schematic.bom_settings`, and `lib/kicad/project.ts` patches one key while preserving its siblings. Design rules live in the same file (`board.design_settings`).

**Editor chrome**:
- **Toolbar**: a floating top-left toolbar holds undo/redo, tool chips and an inline tool search (`shared/ToolbarSearch.vue`, `/` focuses it; not spacebar). It is fitted to the canvas by `lib/canvasToolbar.ts`, and chips tip instantly (`installToolbarTips`). There is **no fixed top toolbar** (settled).
- **View rail**: view controls sit on a left rail (`.toolbar-left-rail`) on every canvas that pans or zooms. View commands are in `lib/viewCommands.ts`.
- **What was removed**: there is no view-source toggle, no 3D chips and no tab-bar view pill. The board and footprint editors switch to their 3D preview with one toggle at the right end of the canvas's top-right slot (`shared/Preview3dToggle.vue`); whether it shows is the tab's (`EditorGroup`). Board Setup is a tab of its own (`goatcad://board-setup/<board>`): the same `PcbEditor` in setup mode on the board's session and document (`tabDocumentPath`, `lib/tabs.ts`), so its stackup edits share the board's undo, dirt and save; it is a child tab of the board's (§ Virtual tabs above). Toolbars live at editor level so they survive the 2D/3D switch. Styles are in `assets/canvasToolbar.css`; the layout is DESIGN.md §Canvas tool palettes.
- **Hotkeys**: all hotkeys are data in `lib/hotkeys.ts` and are matched with `matchesHotkey`. **No editor compares `event.key` to a literal.** The rules are in DESIGN.md §Keymap. `Home` fits the view; `F` does not, because KiCad users expect it to flip.
- **Properties panel**: every editor's right bar is `shared/PropertyTable.vue`, driven by a pure `lib/kicad/*PropertySchema.ts` builder → `PropertyGroup[]` → one `edit(groupType, key, value)`. One key and one value per row. Multi-select shows `MIXED`. The widget owns distance, angle and color parsing (`lib/propertyTable.ts`). `shared/PropertyRow.vue` is a presentation primitive only: the shared thing is the row, never the entity. `shared/PropertyValueEditor.vue` is the value editor with no layout. Colored selects are a custom listbox because the macOS native popup ignores CSS. Styles live in `assets/propertyPanel.css`. The right bar is `CollapsiblePanel` + `ResizeHandle` stacks. Each item kind's rows are KiCad's, read off its `PROPERTY_MANAGER` registrations (`propMgr.AddProperty` and the `Mask`/`OverrideAvailability` that trim them), in KiCad's groups: a row's `section` (`inSection`) puts it under a subheading, basic rows (position, layer, Locked) first. The footprint and PCB schemas key their builders and the editors their edit switch on one item-type map (`FOOTPRINT_ITEM_COLLECTIONS`, `BOARD_ITEM_COLLECTIONS`), so a type made selectable without rows or an edit path does not compile; a selected type a schema has no rows for gets an empty group (`placeholderGroups`), shown as "No properties to edit" — never the root group, never a blank panel. Rows KiCad has and we lack are in [kicad-parity-workstream.md](./kicad-parity-workstream.md#properties-panel).
- **Shared components**: `ContextMenu.vue` + `lib/menu.ts` is the one menu. `FileIcon.vue` is the one file-kind glyph (DESIGN.md §Icons). All other glyphs go through `lib/icons.ts` + `shared/Icon.vue`.

**PCB boards** (`lib/kicad/board.ts`, `lib/engine/BoardScene.ts`, `lib/board/`, `PcbEditor.vue`):
- **Placement rule**: footprint children are stored relative and unrotated, but pad and text angles are **absolute**. `rotateBoardFootprintInAST` rewrites the child angles. Footprint text draws through `footprintTextDrawAngle` on all four surfaces (2D board, footprint editor, 3D silk, Gerber writer).
- **Via tenting** has one resolver (`viaMaskIsOpen`), which feeds the mask Gerber, the silk clip, 3D and 2D.
- **Layer range**: the layer tables cover every layer a file can declare — `F.Cu`, `In1.Cu`–`In30.Cu`, `B.Cu` (`COPPER_LAYERS`) and `User.1`–`User.45` — in the stack, the colors and both theme palettes. Past ten copper layers the inner palette repeats an eight-color cycle: only about a dozen colors both read under pad ink and stand ΔE 30 apart (`theme.ts`, held by `theme.test.ts`).
- **Board drawing** (`BoardScene.ts`): a via's annulus is copper on every layer it passes through, so it joins what it lands on; only its hole sits in the via slot, and so does a pad's hole, as KiCad's hole layers sit above copper. A pad on one copper layer is labelled in that layer's label lane, which rises to the net-name rank while that copper faces the viewer. Pads on several copper layers and vias are labelled in `NETNAMES_PSEUDO_LAYER`, as KiCad's `LAYER_PAD_NETNAMES` and `LAYER_VIA_NETNAMES` are. A label takes whichever ink reads better on everything under it — the copper, and the bore for a drilled pad or a via — each ink its own label batch. A via in a pad of its own net on the facing copper goes unlabelled. Mask openings are pads grown by `padMaskMargin`. Zone outlines are hairlines; the border hatch follows the file's `(hatch …)` — `full` over the outline, `edge` over a band one pitch inside it — sloping by copper stack position.
- **Picking**: a via answers on every layer it passes through, and a footprint wherever it is drawn (footprints rank last, so copper on the active layer still wins the click). Under 'dim', a footprint answers only when one of its pads or drawings is on the active layer, as KiCad's high contrast has it. A drag preview hides the paint and label of what it stands in for.
- **Paint order** starts from `PCB_LAYER_STACK` (`lib/kicad/layers.ts`), which is KiCad's `GAL_LAYER_ORDER`. **Copper draws over silk.** No document geometry writes depth, so what covers what is decided at three levels, each with one owner, and nowhere else:
  1. **Passes** (`ViewportEngine.render`): grid, then the document, then the previews (flattened), then the cursor. A layer is dimmed or lit as a whole, by its slot's uniforms.
  2. **Render order within the document** (`lib/kicad/paintOrder.ts`). Every mesh has a paint address: a layer's slot, a lane (fill, hatch, stroke, label) and a band (document, selected, preview). `PaintOrder` turns an address into a render order for one view, which is the active layer. Its rules are KiCad's `SetTopLayer`: the active layer rises to the top of the document; the via-and-hole slot stays above the topmost copper; and the net-name lane (the facing copper's labels, multi-layer pads' labels and via labels) stays above all of it. The selected band repeats the document above it, and previews sit above both. The overlays (ratsnest, finding markers, selection chrome, origin) have fixed ranks above every band, in one table there.
  3. **Depth within a batch**: a batch holds one slot's lane and is sorted by depth (fill, body, detail, marker, label).

  An address is fixed when geometry is written. Its slot is the layer's place in the stack (mirrored when the view is flipped), never its place in the view. So changing the active layer re-applies render orders to meshes and writes no instance. z carries only the address (slot and depth), and nothing compares z across batches. Nothing sets a document mesh's `renderOrder` except through `PaintOrder`.
- **View state is applied, not built** (`BoardScene.applyView`): the active layer, layer visibility, the non-active display mode and net focus (a live route's or drag's net) change render orders, per-slot visibility and dimming, fill materials and the batch shaders' view uniforms (`boardView.ts`). They never rebuild the scene. Each instance carries its net and the copper its item spans, so the shader applies net focus, a via's fade off the active layer, and hide mode's exception for the focused net. A rebuild is for content and the rarer view options: flip, theme, sketch modes, zone fills, footprint text. Items on hidden layers are built and not drawn.
- `expandLayerToken`: `*.Cu` means every copper layer the board has.
- **Scale on dense boards**: Session and undo: `lib/board/boardSession.ts` holds the session and structural undo; after a command it remaps rather than reparsing, and in the same step propagates nets as KiCad's commit does (`netPropagation.ts`), so every edit — a gesture's or an agent's — leaves copper on the net of what it joins. Scene updates: edits patch the scene in place (`BoardScene.applyBoardEdit`, pinned by `boardSceneIncremental.test.ts`). Zone fills: fill triangulation is cached and moves to a worker pool (`fillWorker.ts`), while the scene build runs cooperatively (`lib/cooperate.ts`). Anchors: scene anchors exist only for elements that own fill meshes, so hits carry a drag pivot. Text: document text is derived lazily; call `flushDocument()` before reading it.
- **Fill engine**: `lib/board/zoneFill.ts` runs on Clipper2 and fills as KiCad fills, since the fills it writes are what KiCad and our DRC read (kicad-parity.md); it takes every clearance from the rule resolver and the copper drawings from `lib/board/boardDrawings.ts`. Zones fill in rank order (`fillOrder`), each meeting the fresh fills of those above it. Large boolean inputs merge in batches first (`geometry/clip.ts`): Clipper's sweep slows sharply on thousands of overlapping clearance rings. Every refill fills every zone but the teardrops no edit came near, and fills are written as packed pts nodes.
- **Teardrops** (`lib/board/teardrop/`): a setting on a pad or via, its zone derived. `runCommand` rebuilds the teardrops of what a command touched after net propagation, in the same step, as KiCad's commit does: what each teardrop belongs to is a map by AST node (`owners.ts`, KiCad's connectivity question), so an edit finds its stale teardrops by what it touched and visits only the tracks at its dirty pads and vias; Edit teardrops (`edit.ts`, the dialog and `board_set_teardrops`) and a refill rebuild them all. Their zones are not items: never picked, listed or written by id, and a finding names the pad or via.
- **Copper spatial index**: `lib/board/spatialIndex.ts` holds tracks, vias and pads and feeds routing, connectivity and DRC. One is built per board object (`boardIndex`), from the last board's where an edit allows, so the editor and the session share it. A padstack's copper differs by layer: an item's `shape` is its front, and `shapeOn(item, layer)` gives it on any layer; whatever asks by layer (DRC, connectivity, the filler) reads it through that. Copper drawings sit beside it (`lib/board/drawingItems.ts`), with ids after the index's, for connectivity and DRC alone: the editor, router and filler do not read them from there. The layers beyond copper (silkscreen, mask, paste, courtyards, the edge) are `lib/board/layerIndex.ts`, built a layer at a time; mask and paste margins have one home, `lib/board/maskExpansion.ts`, which the Gerber writer and the 3D board read too.
- **Board Setup** (`lib/board/boardSetupSchema.ts`): sections that mirror where the data persists. The stackup is on the board's undo stack; rules, classes and tuning profiles go straight to `.kicad_pro` and are off it. The stackup rows are the model; `StackupSpec` is only seed input. Tuning profiles (`lib/board/tuningProfiles.ts`) are read whole into `tuning.definitions`, and what DRC and the router read of them is derived from that list (`tuningSettingsOf`). The impedance solver (`lib/board/impedance/`) is pure and solves only when asked.
- **Known limits**: `pad` is not yet selectable. `remove_unused_layers` is not parsed. A zone keeps one outline, so a cutout in it is neither drawn nor left unhatched. A board paste has no floating move. Manufacture ignores the drill origin.

**Gerber** (`lib/gerber/`, vendor-neutral, so not under `lib/kicad/`): RS-274X/X2 only, and RS-274D is rejected. The export is held to KiCad's own: `gerberExport.parity.test.ts` diffs each layer by painted area (`gerberRegions`) and each hole (`parseExcellon`) against `kicad-cli pcb export gerbers` / `drill`. The display list's order is semantic. Layers render as composite coverage (`ViewportEngine.setCompositeLayers`), so LPC punches holes without revealing lower layers. One tab loads the whole fab set, mapped onto KiCad layer names.

**Footprints** (`lib/kicad/footprint.ts`, `FootprintEditor.vue`): **new operations must go through `runCommand`**; never mutate the AST and emit directly. Transforms port KiCad's `EDIT_TOOL` (`lib/footprint/footprintTransform.ts`). The board and footprint clipboard (`lib/board/pcbClipboard.ts` over `lib/documentClipboard.ts`) follows `PCB_CONTROL::Paste`.

### 3.3 3D Viewports: Viewport3DEngine, the model viewer, and the 3D board

- **`lib/engine/Viewport3DEngine.ts` is content-agnostic** (Z-up mm, renders on demand). It has three consumers: `ModelViewer.vue`, the footprint 3D pane and the board's 3D mode. `setModel` takes ownership and re-frames the camera; `refreshBounds` re-measures a caller-owned group that it mutates. Bounds are measured from visible objects only.
- **STEP tessellates in a main-process worker** (`main/stepWorker.ts`, occt-import-js wasm; the header says why). **VRML is parsed in the renderer** (`lib/engine/modelGeometry.ts`, ×2.54 scale). The shared types live in `src/preload/modelTypes.d.ts`.
- **Model paths** (`main/modelResolver.ts`) expand KiCad env tokens against the detected install. **The extension is a hint**: each candidate is tried as `.step`/`.stp`/`.wrl`. The 3D model set is never downloaded; `kicad3dModelDir` is a manual override.
- **Board 3D** (`lib/engine/board3d/`): the outline is recovered from unordered `Edge.Cuts` edges (`boardOutline.ts`). The build is a staged generator in `BoardScene3D.ts`. View options only flip visibility; only the holes toggle forces a rebuild. `componentModels.ts` places models with KiCad's math, and a back-side part is turned over, not mirrored. Colors come from the stackup (`boardPalette.ts`), silk per side; under mask the face and copper are painted in the mask color, since tan laminate bleeding through the translucent film miscolors every finish. The agent's renders (`modelCapture.ts`, and `boardCapture3D.ts` behind `render_board_3d`) build their own scene on one headless `Viewport3DEngine` per window. Light (`boardLighting.ts`) and framing (`cameraFit.ts`: fit to each drawn object's box, orbit a point on the board's top face, the 2D fit's margins) are shared by the pane and the render.
- **There is no separate 3D component**: 3D is a `mode` of `PcbViewport2D` (one viewport, one scene, one camera). The view mode belongs to the *tab* (the `EditorArea` pill). Known limit: the per-build notices (open outline, omitted drills, failed models) are reported by the builders but **not yet shown**.
- **Assembly overlay** (`boardRenderLayer.ts`, Alt+3 in the layout): the same `BoardScene3D` rendered through `ViewportEngine.camera2D`, so it is pixel-registered with no second viewport. It is built once and kept. Parts without a model extrude their courtyard (`placementBodies.ts`).
- **Footprint 3D pane** (`FootprintViewport3D.vue`): `footprintBoard.ts` wraps the part as a one-part board for the same `BoardScene3D`, so it has no renderer of its own.
- **View options** (`lib/board3dView.ts`) are shared, persisted config in the `selectionFilter.ts` pattern: the layer and component switches, and beside them under its own key the pane's presentation (`board3dPresentation`: projection, lighting, background). The right rail (`Pcb3DPanel.vue`: Layers, Presentation, Export) replaces Properties, Layers and Grid while in 3D.
- **Projection and light**: orbit, fit and flight always move the perspective `camera3D`; an orthographic view is that pose drawn in parallel through a window the size the lens shows at the orbit target (`poseOrthoFromLens`, `cameraFit.ts`). The lighting presets are one function over the board rig (`applyBoardLighting`), shared with the agent's render; the assembly overlay keeps the studio light.
- **Export image** (`lib/board3dExport.ts`) is the pane's own camera, scene and presentation drawn at another size (`ViewportEngine.capture3D`); the agent's `render.board_3d` builds its own scene and owns its camera (`boardCapture3D.ts`). An editor's own exports reach File ▸ Export through `lib/exportActions.ts`, published while its group holds the keyboard.

### 3.4 Git Integration (status + the commit loop)

- **System `git` binary, no git npm library** (dependency policy). Status `main/gitStatus.ts`,
  push/pull `main/gitRemote.ts`, types `preload/gitTypes.d.ts`. Failures are `state` values
  (`not-a-repo`/`no-git`/`error`), never throws across IPC. Paths are repo-root-relative, so a
  project inside a larger repo works; a nested repo (KiCad's `.history`) is dropped.
- **Refresh is event-driven — no polling, no `fs.watch`**: `App.vue` owns `gitStatus` and re-reads on
  project open, the `refreshDirectory` save funnel, window focus, pane show, and after every op.
- **One set of git actions per window** (`lib/git/gitOps.ts`, `GIT_KEY`): pane, diff tabs and
  hotkeys share one busy lock and error line. Commit-all stages the listed files explicitly, never
  `add -A` (would sweep in a nested repo, or stage conflict markers as resolved).
- **Push/pull never prompt** — existing credentials work, anything else fails with a message; pull is
  `--ff-only` so nobody is left mid-merge in a `.kicad_sch`.
- UI in `components/git/`; explorer decorations `lib/gitDecorations.ts`, provided/injected into the
  recursive `FileTreeNode` (the precedent for recursive-tree data).
- **Diff tabs** (`goatcad://diff/<working|staged>/<path>[/<symbol>]`, `DiffView.vue`): the side is in
  the URI because a file can be in both sections; the rest comes from live status, and a tab whose
  side a stage or unstage empties moves to the other (`followedDiffTabs`). A `.kicad_sch`,
  a `.kicad_pcb` or a `.kicad_sym` symbol opens in the **visual diff** (`VisualDiffView.vue`):
  schematic and board items pair by uuid (`lib/git/schematicDiff.ts`, `lib/git/boardDiff.ts`; a
  board draws in its own view-only `BoardDiffViewport.vue`, with the editor's view rail and Layers
  panel, fills off by default and no net names), symbol parts by content
  (`lib/git/symbolLibraryDiff.ts`). Its right rail is the editor's properties table in review
  (`PropertyTable review`; the board's whole `PcbPropertiesPanel`): built from each version and
  merged (`lib/git/propertyDiff.ts`), changed rows old over new. A click on a view-only canvas picks
  (`ViewportEngine.onViewClick`) and `lib/git/diffPick.ts` finds the item in both versions; nothing
  picked is the sheet, board or symbol. Not yet built: history view.

### 3.5 Library Index (search + associations)

Design, scopes, cache and invalidation: **[libraries-workstream.md](./libraries-workstream.md) §2**. Main builds it
(`main/libraryIndex*.ts`); the renderer (`lib/libraryIndex.ts`) loads records once and searches
locally — no IPC per keystroke. Bump `EXTRACTOR_VERSION` on any extraction change or untouched files
never re-index. `resolveKiprjmod` (main) twins the renderer's `resolveLibUri` — keep them in sync.
Every place the app asks for a symbol, power port or footprint opens one chooser over it
(`shared/LibraryChooser.vue`, ranked by `lib/libraryChooser.ts`); a picked file is read and parsed
by `lib/libraryLoad.ts`, which Place Footprint and the agent's board door share
([libraries-workstream.md](./libraries-workstream.md)). The index is the one answer to
"which libraries does this design reach, and what does each hold": the ERC and DRC library rules read
it through `loadLibraryView` (library › part by nickname), never the raw tables, where one row can
name a whole folder of libraries. ERC and the board editor's DRC hold what they derive from it as
a snapshot (`lib/libraryFeed.ts`): re-read on an index rebuild, and, debounced, when the change bus
reports a project library, `.pretty` or table written — only the project layer, the app's memoized.

### 3.6 Reference integrity (rename/delete forwarding)

Design: **[projects.md](./projects.md) §8**. A rename is an edit to a
set of files. Registry of reference kinds: `lib/kicad/references.ts` (span splices keep other bytes
identical, RULES.md §7). Pipeline: `lib/project/renamePlan.ts` (plan → preview → apply → verify, pure
over `RenameIo`, rolls back). `App.vue` orchestrates; a referrer open with unsaved edits is
rewritten **in its buffer**, never on disk behind the editor. Derived project views invalidate off
`App.vue`'s `projectRevision` (bumped at `refreshDirectory`) and read open buffers over disk.

### 3.7 Selection model (what a click lands on)

**Start at the most specific thing under the cursor and walk up to a level this editor allows**
(`lib/selectionResolve.ts`), in every 2D editor.

- **Parts have names, and names are paths** (`symbol:3/pin:7`). Paint is filed under the most
  specific name; a parent means everything under it; a partless thing keeps one name (`wire:12`).
  `lib/engine/keyHierarchy.ts` is shared by `PrimitiveBatch` and `SchematicScene`'s glow journal so
  a halo and a move cover the same strokes. Children are recorded on insert, never found by prefix
  scan (slow on 10⁵ board keys, and `symbol:11` starts with `symbol:1`).
- **A name must never depend on drawing order.** It is built from what the part *is* (unit, style,
  index within that group), so the renderer (`SymbolPartRef`, `lib/kicad/schematic.ts`) and the
  symbol editor (`SymbolPartAddress`, `lib/symbol/symbolEdit.ts`) derive it independently;
  `symbolPreviewPartKey` bridges them, tested both ways — a key matching no paint fails silently.
  Flat cross-unit indices are rejected (a pin added to one unit renumbers the next); fields go by
  property key. So `HistoryEntry` is generic over selection shape (`lib/history.ts`), and the symbol
  editor moves and resizes real geometry (resize hides the element, previews the new shape).
- **One selection model, four scenes** (`lib/canvasSelection.ts`). Each scene answers two
  questions in `HitCandidate` form — what is near a point, ranked, and what a band takes, each level
  carrying its filter kind and lock state — and `useCanvasSelection` does the rest the same in every
  editor: click (replace, or toggle with a modifier), band, the item at the cursor (KiCad's hover
  selection), Select All, the right-click hit and Select Other, all at the engine's `hitRadius()`.
  What differs stays in the scene: ranking (the board by distance then type, the schematic by type
  tier), what a band leaves out (pads, fields), which items lock (none in the schematic or symbol).
- **Edit keys fall back to the item under the pointer** (KiCad's `RequestSelection`): with nothing
  selected, rotate, flip, mirror, delete, copy and the rest act on it and let it go after
  (`lib/hoverSelection.ts`, each editor listing its keys); M and G pick it up (`heldMove`).
- **One move, four editors** (`ViewportEngine` object drags; KiCad's `BestDragOrigin` and
  `BestSnapAnchor`). A mouse drag of the selection, M and G grab the moved items' anchor nearest
  the pointer — each scene lists them: `BoardScene.moveAnchors`, `lib/moveAnchors.ts`,
  `lib/schematic/moveParts.ts`, the symbol viewport's parts — and keep it on the snap target:
  another item's anchor within reach (`snapTargets`, KiCad's magnetic defaults; board and footprint
  only; Shift lets go), else the grid (Ctrl lets go; schematic and symbol on KiCad's grid
  overrides, `roleGrid`), else the pointer. KiCad warps the pointer onto the anchor; a browser
  cannot, so the anchor comes to the pointer. Items KiCad will not move from an anchor, and shapes
  with none, move with the pointer. A turn mid-move is about the anchor; a track drag's cursor
  snaps to copper as a route's does.
- **Select Other lists what a click could have landed on.** Holding a press on an item for
  `HOLD_MS`, or the canvas menu's Select Other, opens `shared/SelectOtherMenu.vue` over the same ranked candidates, each
  resolved as a click would be (`resolveSweep`); one candidate is simply selected. A row is the
  selection while it is focused, 1–9 pick, A takes all, closing restores the selection from before
  the press. A drag moves nothing until the pointer leaves the click slop, so a hold never nudges
  what it pressed (`ViewportEngine`). Only what is already selected drags, as KiCad's default left
  drag has it: a press on an item not selected is a click on it if it stays in the slop, else a band
  from the press. Rows are named from `shared.primitives`, the one singular
  name per primitive every editor's property groups also use.
- **Named is not selectable.** `SELECTABLE_KINDS` is per-editor: a schematic click lands inside a
  symbol only on field text; the symbol editor is the inside of a symbol. Every listed kind must be
  reachable from a scene, or it is a filter checkbox that does nothing.
- **Scenes rank; editors choose.** `hitCandidates` returns containment chains in each scene's own
  ranking (deliberately not unified); a disallowed candidate falls through, so filtering narrows
  and never breaks clicks. The **selection filter** (`lib/selectionFilter.ts`) ANDs with
  `SELECTABLE_KINDS`, persists via `config:*`, stores *excluded* kinds so new kinds default on.
- **An armed tool bypasses all of this** — route/wire tools hit-test geometry directly.
- **Known limits:** pads named but not PCB-selectable; dimensions not hit-testable (add to
  `SELECTABLE_KINDS` only with a hit-test); hit-testing is a linear scan per click — add a spatial
  index when something hit-tests **per mouse move** (board hover, snap-while-routing), not at a size.
- **Why not GPU picking:** no near-miss tolerance (3 px off a trace must still hit), only "topmost"
  (fall-through needs every level), `readPixels` stalls, box select still needs geometry.

### 3.8 Active pane (which surface owns the keyboard)

`lib/activePane.ts`: module-scoped `'canvas' | 'properties'` (one per window; outlives an unmounting
editor). It drives only the Escape handover back to the canvas — shortcuts are gated by
`isTypingTarget()`, and nothing visually marks the active pane. Escape goes one level per press.

### 3.9 Unsaved changes on close

Dirty state lives only in `EditorArea.vue`'s `dirtyPaths` and **never crosses IPC**, so main asks
rather than judges. `requestCloseTab` (×, Ctrl+W) prompts; `closeTab` stays unconditional for closes
the user has no say in (tab moved windows, file deleted). Window close and quit are a handshake
(`main/index.ts`: veto, `window:confirm-close`, `window:close-confirmed`); a dead renderer closes
anyway. The native dialog (`main/unsavedDialog.ts`) gets pre-translated strings — main has no i18n.
Open (`projects.md` §5): a dirty buffer does not travel with a transferred tab.

### 3.10 Distributor part search (DigiKey, Mouser)

Roadmap, API-terms rules and open work: [parts-sourcing-workstream.md](./parts-sourcing-workstream.md).
Agent ops over the same service: §3.11.

- **All of it lives in main.** Three separate reasons: secrets stay out of renderers (RULES.md §9), the renderer CSP stays closed to vendor hosts, and quota, token and cache are process-global (two windows share one day's quota). `parts.ts` is the Electron-free service. `partsIpc.ts` is the Electron skin, the `libraryIndex.ts` split. All outbound HTTP goes through `outboundFetch.ts`, which uses Chromium's stack and is injected into pure modules.
- **A registry, not per-vendor code paths.** `partsProviders.ts` (`PartsProvider`, `PROVIDER_INFO` as data) with `partsDigikey.ts` / `partsMouser.ts`. Settings and the Part Search picker are both views over it. Identity (MPN + manufacturer) and commerce (price and stock) are normalized. **Parameter names are not**: a lossy cross-vendor map gives confidently wrong specs. Normalizers are total, so a renamed field leaves a blank, never throws.
- **Quota is the design constraint.** `search` runs cache → quota → network. `partsRateLimit.ts` refuses locally and persists the day bucket. **No search-as-you-type**, anywhere. Every request has a deadline (`REQUEST_TIMEOUT_MS`).
- **Distributor content is never written to disk** (API terms). `partsCache.ts` is memory-only. Search state lives in the module store `lib/partsSearch.ts`, so results survive the tab unmounting. Only our own usage counter persists, plus whatever the user deliberately writes into their design.
- **Credentials** (`partsCredentials.ts`): `safeStorage` in their own file, **never `config.json`**, which is broadcast whole to renderers (§3.0). No getter on the bridge; the renderer sees only `PartsCredentialStatus`. With no keyring, the save fails rather than falling back to plaintext. `redactSecrets` runs where a failure becomes a renderer error, because Mouser's key travels in a query parameter. Errors are a typed `PartsErrorKind` that the renderer translates, because each kind has a different fix (401 vs 403).
- **Settings ▸ Distributor APIs** (`settings/PartsSettings.vue`) is onboarding first. Saving is instant; checking happens in the status badge. The onboarding copy lives in `parts.yaml` per provider id, and `locales/__tests__/partsProviders.test.ts` holds it to the registry.
- **Part Search is its own tab** (`goatcad://parts`, `PartsView.vue`), not part of Libraries: Libraries searches a local index, Part Search a remote, metered, credential-gated catalog. There are three modes (Universal / DigiKey / Mouser) and one results UI. **Universal** groups by manufacturer part (`partsGroup.ts`), each distributor on its own attributed line, **no merged "cheapest" row** (terms, and misleading), and a failing provider is reported, not dropped. It never sorts or pages a merged sample. Grouping is the GUI's alone: `parts_search` takes one distributor and answers its rows as given, and `parts_compare_mpn` answers at most one row per distributor for an exact MPN, maker names unmapped.
- **Filters edit the request, not the rows** (`lib/partsFilter.ts`, `parts/FilterBar.vue`, `parts/AppliedFilters.vue`). Facets come from each response. A draft/applied split behind Apply keeps it to one request per change. Applied-filter chips are the only reliable way to undo a filter, since facets shrink with the results. A mode shows only filters its API honors. Universal offers only `inStock` / `rohs`, the ones both APIs implement. Parametric facets need a DigiKey category: its whole tree is one memoized call (`parts/CategoryBrowser.vue`).
- **Vendor links** (`parts:open-external`) are https-only, enforced in main: `shell.openExternal` on a provider-supplied `file://` or custom scheme would run code. The app never registers an account for the user; `parts:open-registration` only opens the vendor's page.
- **CAD is a hand-off.** Neither API serves a model file, so `PartCadAvailability` is `handoff`: open the vendor's page.

**The MCP server** (`partsMcpServer.ts`, `partsMcp.ts`, `partsMcpIpc.ts`; op registry in `ops/`, §3.11):
- **Process-wide.** One loopback listener, started at app-ready, so windows and agents share one quota and one OAuth token. The same handlers also listen on a user-only socket (`mcpEndpoint.ts`, `socketPathFor`), and `goatcad-endpoint.json` names both.
- **Four fences.** It binds to `127.0.0.1`, requires the bearer on **every** request (token in `mcpToken.ts`), rejects a browser `Origin`, and caps the body. On Linux and macOS the socket file's 0600 mode stands in for the first two, so a call there needs no token; a Windows pipe takes the token.
- **A connection is a session** (`mcpSessions.ts`): an MCP client's `Mcp-Session-Id`, minted on `initialize`, or the id the Python client sends under the same header. Ops read it as `ctx.connection`. It ends on a DELETE, or when its GET stream (held open, sending nothing but a heartbeat) stays closed for a few seconds. A client that sends no id has no connection. A call acts in the workspace it names (a `workspace` argument, else the `X-GoatCAD-Workspace` header), else the only one open (`workspaces.ts` `resolveWorkspace`, agent-api.md "Workspaces"); a connection's end closes the hidden workspaces it started (`workspaceService.ts` `release`).
- **Nothing is registered by the app.** An in-app agent tab gets the URL, the token and its window's workspace (`GOATCAD_WORKSPACE`) on its command line and in its environment (`partsMcpClients.ts`). Outside the app a client registers the HTTP URL with the token, which answers only while the app runs: nothing starts the app for a client, so the person starts it (with a window, or `--background`) before the session. Settings and `goatcad help agents` print the line and never write a client's config; `help agents` also gives the Python client's path (`commandLine.ts`).
- **Read ids back from the tools.** The agent passes ids a tool returned, never recalled ones: `parts_list_filters` before `parts_search_category`, library nicknames before symbols (`partsMcpLibrary.ts`). `parts_cache_datasheet` takes no URL; it resolves from the distributors' listing for that MPN.
- **Project files** (committed, with provenance in `index.json`):
  - Datasheets go in `<project>/datasheets/` (`partsMcpDatasheet*.ts`).
  - Models go in `<project>/<project>.3dshapes/` (`partsMcpModel*.ts`). The caller supplies the address, so the store records the stated source beside the actual host. Every file is parsed before it is kept.
  - `parts_read_datasheet` reads PDFs via pdfium wasm on a worker (`datasheetReader.ts`, `datasheetLoader.ts`).
- **Design ops go through a window of the caller's workspace, not main** (`partsMcpBridge.ts`). The AST lives in the renderer, dirty buffers never cross IPC (§3.9), and edits must be undoable (RULES.md §8). A write lands as an undoable step on a dirty tab, which is the consent mechanism. It never changes the active tab or focuses the window, and which window has focus never decides where it goes. The per-sheet session and doors are in §3.13 and `lib/schematic/sheetAgent.ts`.

### 3.11 The agent operation registry

`src/main/ops/` is the only definition of what an agent can do. For the op list, read
`ops/index.ts` (in workflow order) and each op's `summary`/`guidance`. Don't keep a catalog here.
The rules a new op must follow and the open work are in
[agent-api.md](./agent-api.md).

**One engine and one undo layer for the GUI and the agent.** An op doesn't reimplement an edit. It
calls the same AST helpers, command layer and checks the editor's own tools use, so an agent's
edit is an ordinary undoable step on a dirty tab. That undoable step is the whole consent story
(RULES.md §8). A second path would drift on exactly the parts that are easy to get wrong, like the
`extends` chain and per-path instances (`sheetAgent.ts` header). The only op that crosses the undo
line is `project.save`. Its answer lists every path it wrote. A field or flag belongs to the part, so
the property panel, the Components table and the agent write it on every unit of the reference
(`componentEdits.ts`, `partUnits.ts`), as KiCad's symbol properties dialog does. An agent names one
unit as KiCad shows it, `U5A` (`unitItemId` in `symbolUnits.ts`, with the project's sub-reference
settings and the library's unit names); `U5` is the part, which a move or delete refuses. Update and Change
symbols run one `updateSymbolsWithWires` (`symbolUpdate.ts`) from the editor's dialog and from
`schematic.update_symbols`, as Update and Change footprints share `footprintExchange.ts`.

**Defined once, generated everywhere.** `defineOp` (`ops/registry.ts`) takes a `domain.verb` name,
an input schema, a summary, guidance, examples, `scope` and `mutates`. MCP `tools/list`/`tools/call`
(`partsMcp.ts`) and the `/v1` discovery and call endpoints (`ops/discovery.ts`, `ops/http.ts`) are
generated from the registry. So is the Python client, which `agentScripting.ts` +
`ops/pythonClient.ts` write to `<userData>/python/` at every startup, so it always matches the
running app, with a worked example for a schematic block and one for a board. A capped list
pages with `offset` pinned to the `revision` it answered (`lib/queryPage.ts`), and the Python client
reads such an op whole and raises `Truncated` on a page it did not ask for (`PYTHON_WHOLE_READS`), and splits a by-id read past its cap into calls of the cap (`PYTHON_CHUNKED_READS`). A session learns
where it is from the MCP handshake's instructions, which carry its path (`partsMcp.ts`); a GoatCAD
terminal already hands a script the token and its workspace. `mcpEndpoint.ts` publishes the address and the socket, and the client
prefers the socket, which needs no token on Linux and macOS. `/v1` sits behind the same fences as `/mcp` (§3.10). An MCP tool's name is the op's with `_` for the dot; there
is no other. `registry.test.ts` holds the shipped tool list additive-only.
The schema DSL is `ops/schema.ts`, in-repo by RULES.md §4. It yields the handler's type, the
published JSON Schema and the validator. Main validates before anything crosses the bridge, and
every object is closed; an item record is held there to `shared/recordRules.ts` too.

**Main or window.** An op that needs only main runs there: the parts catalog, the library index,
the datasheet and model stores, the project files. Everything that touches a document is a
`defineDesignOp`, because the AST, the open buffers and the undo stacks all live in the renderer.
The op builds a typed request (`preload/mcpTypes.d.ts`, a `kind` union). `designRequest` and `run`
are generated from the same `request`, so a batch entry and a direct call can't disagree. An
optional `validate(args, ctx)` runs in main against the index first. It refuses a Footprint id no
library has, and lets everything through when there's no index. `App.vue`'s `handleDesignRequest`
offers the request to each **door** in turn: `lib/symbol/libraryAgent.ts`, `lib/board/boardAgent.ts`,
`lib/fabExportAgent.ts`, `lib/footprint/footprintAgent.ts`, `lib/schematic/schematicSetupAgent.ts`, then App's own verbs
(`project.create`, `workspace.create_file/open_file/close_file/save/update`), then a sheet
(`lib/schematic/sheetAgent.ts`, pure helpers in `schematicAgent.ts` and `schematicItems.ts`; the drawing tools' items in `sheetGraphicItems.ts`). A door
is a kind → handler map. App knows no single operation. Whether a handler needs a project is the
handler's call, not the door's. A sheet door works over a `SheetAgentContext`, so the same handler
serves a mounted editor and a background sheet. A board door writes through the board's session
(`lib/board/boardSession.ts`), opened behind the active tab when none holds it; its items are
`lib/board/boardItems.ts`, over the mutators the editor's own commands call, and a field `<ref>#<field>` reads and writes in board coordinates, as the property table shows it (`boardFields.ts`). A new request kind is a cross-process change (RULES.md §9). A new window failure `kind` needs
rows in `DESIGN_REMEDY` and `DESIGN_CODE` (`ops/design.ts`), or it surfaces as `internal`.

**Errors and guidance.** Every failure uses one envelope (`ops/errors.ts`):
- an eight-way `code` for clients to branch on
- the domain's finer `kind`
- `message`, written for a person
- `fix`, written for the model, naming the next call
- `candidates` on a miss

A door refuses with `{ error, detail, candidates? }` rather than throwing, and App unwraps it into
the envelope. Over HTTP an op failure is 200 with the envelope. Only transport and auth are HTTP
errors. A refusal names what is in the way (the symbol, the pin, the nets it would merge) so the
next call can act on it. `guidance` says what to read first and what gets refused.

**The sheet session.** A design write lands in the tab's document session
(`lib/schematic/sheetSession.ts`) whether or not that tab is in front. The mounted editor is a view
over the session, not a second copy of the sheet. A document no tab holds opens behind the active
one (`App.openFileInBackground`). Only `workspace.open_file` activates a tab, because intent is a verb and
not a side effect of a write. Two signals keep every reader current:
- `openSheetsVersion` (`lib/schematic/openSheets.ts`) is bumped on every buffer write, and
  cross-sheet computeds depend on it.
- There is one set of symbol library tiers per sheet directory (`lib/symbol/symbolSources.ts`). The
  chooser, the mismatch check and the background sessions all share it, so a regenerated library is
  what every door compares against.

**Library writes.** Writes target the window's active `.kicad_pro` (`lib/projectLibraryTarget.ts`).
With no active project the write is refused (`no-active-project`), never resolved by scanning the
workspace. A library file write isn't undoable, so a library with unsaved edits is refused and
replacing an existing entry needs `overwrite`. Footprint item writes go through the footprint
editor's `TextSession`; a placed one — its reference with `board` — through the design-copy session
Edit footprint… opens (`lib/designCopy.ts`), so the write is one step on the board. A placed
symbol's reference reads and writes the copy its sheet embeds the same way; symbol items go
through the symbol editor's session (`lib/symbol/symbolItemsAgent.ts` over `symbolItems.ts`). Each one is applied to a scratch parse first, so a refusal writes nothing
and `footprint.batch` is atomic.

**Helpers do the geometry; the agent supplies the semantics.** `symbol_create` needs a
functional `group` on every pin (`lib/symbol/symbolLayout.ts`). A pin without one is refused, never
defaulted. `footprint_create` takes pads, body and pin 1 as the datasheet prints them and
derives the rest from the project's style (`footprint/footprintGenerate.ts`). It has no style
argument. `footprint.compute_land_pattern` (`footprint/landPattern.ts`) computes pads and never writes them,
so the agent sees every pad before it passes one on.

**3D models are optional everywhere.** A missing model is never a check finding or a refusal, and
GoatCAD names no vendor. The app measures and reports:
- `lib/engine/board3d/modelFacts.ts` reports placement and fit through `placeComponentModel`, the
  same transform the 3D board uses.
- `footprint_cache_model` parses the STEP file before it lands in the project.
- `bom_get`'s `${MODEL}` column is a generated column, refused on write like `${QUANTITY}`.

**Invariants the ops lean on:**
- **Every write reports what it changed, and what it broke when asked.** It answers with
  `changed` and `revision`, and with `checks: true` the check delta (`lib/schematic/checks.ts`,
  which holds few rules, each a real defect, stable across calls); without it no check runs, and
  a document's `*.check({ since })` answers with a burst's delta against an earlier run (`CheckHistory`). `describe({ since })` diffs against remembered projections and returns the whole
  sheet when the revision is gone.
- **Wire-touching writes tidy the sheet.** They run `runCommand(label, mutate, { cleanup: true })`
  (`sheetSession.ts`, running `lib/schematic/wireCleanup.ts`, which is KiCad's `SCHEMATIC::CleanUp`)
  inside the same undo step. The result is identical for a drag in the editor and an
  `items.update`. Wire breaks are edit-local, and cleanup never joins two nets.
- **A write that picks a connection point is refused off the project's connection grid**
  (`offGridPlacement` / `offGridPoints` in `schematicAgent.ts`). `schematic.place_symbol` requires `at`,
  so the agent has to read the sheet before it places anything.
- **`schematic.batch` is atomic by structure, not by rollback code.** `CommandHistory` stores whole
  documents (§3.13), so a half-applied batch can't exist. Its registry leaves out `batch`, and it
  refuses library writes and `annotate`. `board.batch` is atomic by rollback: a board command that
  throws gets its captured node clones put back (`boardSession.runCommand`).
- **A board write never refills.** Every zone is marked stale in the session (which zones an edit
  changes is not known well enough to name fewer), recorded with the command so undo restores
  them. Reads and `board.check` say the fills are stale (`stale.fills`) and leave the fill-reading
  findings out; `board.refill`, or the open editor's own refill, clears them. Both run one refill loop (`lib/board/zoneRefill.ts`). Why: agent-api.md,
  "Equal access, not equal UX".
- **A placed symbol stays a copy.** `symbol-library-mismatch` reports drift, and the fix is remove
  and re-place. Removal prunes unused `lib_symbols` (`pruneUnusedLibSymbols`, `kicad/schematic.ts`)
  so a regenerated symbol can reach the sheet.
- **`render.*` renders off-screen and never uses the editor's scene.** It draws with a capture engine
  per window (`lib/engine/{schematic,footprint,board}Capture.ts` through
  `ViewportEngine.captureFramed`) and leaves out editor chrome; only `render.board` takes display
  options. It answers with a frame in the domain's own millimetres.
- **A routing session is the editor's route tool, headless.** `route.*` (`lib/board/routeAgent.ts`,
  kept in the board door's closure, one per board) drives the same `RouteController` the PCB editor
  does, or with `pair` or `tune` the editor's pair router and tuner, whose steps both share
  (`pairRoute.ts`, `tuneTool.ts`, driven by `routeAgentTools.ts`). It is a log of gestures: a preview replays it into a throwaway run, and a board edited
  under it replays it over the new board (`rebased`). Its pictures are a working view, not an
  audit: its own `BoardWorkScene`, built from the session's board and patched per command, swapped
  into the capture engine with the live view's preview layers (`captureFramed`'s `layers`). Its
  unlanded route is drawn only there, never on the person's canvas.
- **An agent viewport shows the person where an agent works.** Each window keeps its boxes
  (`lib/agentViewports.ts`); main gives each an id unique across windows, sends every request
  naming one to the window holding it, and keeps one per agent connection, closed when the
  connection ends (`main/agentViewportRoutes.ts`, `partsMcpBridge.ts`). Every render and layout
  edit names one (main refuses without it, `ops/viewport/open.ts`), and the board and sheet doors
  move its box through `framed` to what the call drew or changed; a routing session runs in the
  one it names. Both 2D canvases draw the boxes with `shared/AgentViewportOverlay.vue`, one per
  pane showing the document, an off-view box as an edge marker. Only a click on that marker moves
  the camera. Closing a viewport ends the routing in it.
- **The same pipeline serves both the Update PCB dialog and the agent.** Board sync
  (`lib/board/boardSync.ts`, a pure planner and applier) serves `board.sync` and F8's
  `UpdatePcbDialog.vue`. The `.net` export (`lib/schematic/netlist.ts`) reads the same `syncParts`.

**Known limits:**
- Board ops have no export yet. See the workstream's open list.
- Setup writes to the `.kicad_pro` are not undoable, in the GUI or by an agent; an agent's answer
  carries every value it replaced (`lib/board/boardSetup.ts`).
- Custom-pad primitives are merged into one outline for drawing and hit tests
  (`lib/board/padCopper.ts`), front layer only; the spatial index holds every layer's exactly.

### 3.12 Terminal tabs

**A shell is an editor tab (`goatcad://terminal/<kind>/<session id>`), not a bottom panel** — its work
(an agent CLI, a build, git) holds the screen for minutes. It opens in the workspace root (home when
there is no folder).

- **The kind rides in the path** because only the path survives a session record and a cross-window
  move. `shell` opens a new tab on every click (several at once is normal); `claude` and `codex` are
  one per window — a second tab of a conversation is a way to lose the first.
- **The renderer never sends a command line.** `terminal:start` takes a directory and a kind;
  `main/terminalAgents.ts` is the whole vocabulary of what the app spawns (RULES.md §9). An agent
  runs inside a login shell so the user's PATH applies, and whether its CLI exists is asked of that
  same shell (`probeAgentCli`); a missing CLI gets a plain shell plus an install notice.
- **An agent button resumes the folder's conversation** by asking the CLI (`--continue … || fresh`).
  Rejected, will be proposed again: reading `~/.claude`/`~/.codex` transcript stores (private, and
  path-mangled folder names collide), and minting a session id per directory (`/clear` makes it
  stale). **GoatCAD reads nothing under `~/.claude` or `~/.codex`, for any purpose**; the CLI's
  command line is the only contract. The launch also hands the agent the app's MCP server
  (`partsMcpClients.ts`) — nothing is registered anywhere, so nothing goes stale — and every tab
  its window's workspace in `GOATCAD_WORKSPACE`, so an agent or a script started there acts in it.
- **The pty lives in main (`main/terminalSessions.ts`), keyed by the id the tab carries**, so a tab
  switch or a window move never kills it; only the user's close ends one. A mounting view replays
  the scrollback then streams. Output goes to the owning window; `terminal:attach` re-points it —
  that is the whole cross-window mechanism.
- **An agent's dot says working / idle / attention, told by the agent's own hooks**
  (`main/agentActivity.ts` → `main/agentStatusServer.ts`), because no process signal can tell
  thinking from waiting. Codex tabs stay `unknown` (running while alive) — see `agentActivity.ts`.
  A shell tab titles itself from its foreground process (`main/terminalProcess.ts`, one strategy
  per platform).
- **`EditorArea` keeps every open terminal mounted** in a layer over the editor chain — the one
  exception to "only the active body exists"; a remount repaints scrollback and loses scroll.
- **Close asks only when work is under way** (`terminalNeedsCloseConfirm`, `lib/terminalTitle.ts`).
  `requestCloseTab` kills; `closeTab` (a tab moving windows) must not.
- **Agent tabs are restored with the window, shells are not** (`lib/terminalRestore.ts`); a session
  id is unique per app run (`term-<run>-<n>`), which is what makes "still live?" safe to ask.
- Colors are theme tokens (`lib/terminalTheme.ts`); `Ctrl+C` stays SIGINT, so copy is `Ctrl+Shift+C`.

### 3.13 Documents outlive views

Each editor group mounts one editor, for its front tab, and rebuilds it on every switch, so what a
file needs across a switch lives in `lib/document/documentStore.ts`: one `DocumentHandle` per open
tab, keyed by path — text, disk text, a revision that moves on every text change and only then, the
file's undo history, and any parsed model a view left behind. `EditorArea`'s buffer and save paths
read and write documents.

- **Undo history is the document's** (`openHistory`, `commitText`); its revision is what agent
  answers report.
- **Four kinds, one shape**: `lib/schematic/sheetSession.ts`, `lib/board/boardSession.ts` (owns the
  parsed board; its text is derived lazily through a `TextSource`), and the generic
  `lib/document/textSession.ts` for symbol libraries and footprints. One per open document.
- **An agent writes to the open document, not the file under it** (`sheetAgent`, `editOpenBoard`,
  `editOpenLibrary`), so its edit is an undoable step on the tab. Only a file no tab holds is
  written directly.
- **Nothing outside a document may keep its parsed model across an await.** Memory freeing
  (`pin`, `discard`, …) is designed in but not built.
- **Live router sessions index the copper arrays by position.** Anything that inserts or removes
  copper from outside a gesture — an agent edit included — must cancel the live route/drag first.
  The editor does it on every outside change: `RouteController.outsideChange` for a route,
  `dropLiveGestures` for a drag, pair or tune.
- **A tuning pattern is one item over its tracks** (`lib/board/tuningPatterns.ts`): the scene
  picks the pattern for any of them (`BoardScene.hitCandidates`, `boxSelect`), the editor's acted
  selection carries its tracks, and every board command drops a pattern whose tracks are gone.

### 3.14 Split view, shared panels, and cross-select

A window shows one editor group or two. Reasoning and open work:
[split-view-workstream.md](./split-view-workstream.md).

- **A group is a membership over the window's one tab list** (`lib/editorGroups.ts`).
  `App.activeTabPath` is the focused group's front tab, so code reading "the active tab" is unchanged.
- **`EditorArea` is the workspace (path-keyed: sessions, dirty, saves, agent doors); `EditorGroup`
  is the tab in front** and registers a `FrontView` that saves and buffer reads consult first.
- **One group holds the keyboard: use `useGroupKeydown` (`lib/editorWorkspace.ts`) for any new
  editor or viewer — a bare `window` keydown listener runs in both panes.**
- **One set of context panels**: editors `<Teleport>` their rail into `EditorArea`'s
  (`useContextPanels`); it is held at its editor's width while loading (`contextRailWidth`) so a
  load does not flash both panes.
- **Cross-select is a bus event** (`lib/crossProbe.ts`, relayed across windows by main); only a
  user gesture emits. `lib/crossProbeRoute.ts` picks the answering pane. **Anything else that must
  cross panes should take this shape.**
- **A reveal keeps the user's zoom** (`lib/engine/bringIntoView.ts`): in sight → select; out of
  sight → pan (a cut, never a glide); too big → zoom out.
- **Agent requests go to the window of the caller's workspace holding the document** (`main/workspaces.ts`, `main/designWindow.ts`); several windows of one workspace are the normal schematic-and-board case.

### 3.15 View state outlives views — three homes, and which one a setting gets

Ask of each new setting: **what is it a property of?** Wrong toward the app and it breaks with two
documents open; wrong toward the document and it writes a file nobody expected.

- **The app** — main's config store (`config:*`), one small module per setting in the `pcbView.ts`
  shape (`symbolView`, `schematicView`, `footprintView`, `board3dView`, `gridPreferences`,
  `selectionFilter`, `panelLayout`, `layerPresets`, …). Shape in `preload/*ViewTypes.d.ts`, default
  and normalizer in `appConfig.ts`, with a test that they agree.
- **The document** — a board's layer visibility, active layer and inactive-layer mode
  (`lib/board/boardViewStore.ts`), written to the project's `.kicad_prl` in KiCad's own keys
  (`lib/kicad/projectLocal.ts`). The viewport waits on the read (`boardViewReady`, fail-open). The
  active preset is derived, not stored (`matchingPresetId`).
- **The open tab** — zoom and pan (`lib/engine/cameraStore.ts`), in the window session.

### 3.16 Design health: the pill and the findings drawer

Every editor's viewport ends with `HealthPill.vue`; clicking it opens `FindingsDrawer.vue` below the
canvas, or, pinned, the drawer lives in the right rail and the pill is gone (DESIGN.md §Viewport status strips). An editor that times its checks adds a Performance panel tab (`PerformancePanel.vue`), and one with settings for them a gear. The model is `lib/designHealth.ts`, adapting each engine's `CheckResult` — schematic
`SheetSession.checks()` (the view's copy, `backgroundChecks()`, runs the checks that read the sheets alone in one app-wide worker, `lib/schematic/worker/`, sent only the sheet texts it does not hold; the library rules stay on the page), board `boardCheckRun` (`lib/board/boardChecks.ts`, cooperative;
one module per rule in `lib/board/drc/rules/` over one context, `drc/context.ts`; after an edit only round it, `drc/incremental.ts`), `footprintChecks`, `symbolChecks`. Design, locate and open work:
[design-health-workstream.md](./design-health-workstream.md).

- **The pill counts exactly what the `*.check` ops and the export pre-flight do** — same engines, same
  severities, same exclusions, same inputs. The board check takes the footprint libraries
  (`BoardCheckInput.libraries`, loaded by `board/boardLibraries.ts`) and the schematic's netlist
  (`BoardCheckInput.schematic`, the root sheet's live design from `EditorWorkspace.schematicNetlist`)
  as optional inputs; a rule whose input is absent stays quiet, so
  every caller supplies the same ones or none. Keep it that way when adding a rule.
- **Locate uses stable ids (`targets`) that agents never see**; agents read `groupChecks` /
  `compactDelta`. A test per engine holds every rule to a finding whose targets all select.
  A board finding's `items` are the items layer's ids (`boardItemIds` in `boardItems.ts`, read by
  `drc/context.ts`), so each one works in `items.get`; a board's rows also list each finding's
  place, layer and measure (`findingOf`).
- **Severities are the project's, in KiCad's keys** (`rule_severities` in `.kicad_pro`,
  `lib/ruleSeverity.ts`, catalogs `drcCatalog.ts` / `ercCatalog.ts`), so a project ranks the same
  in both apps. Graded rules (`pin_to_pin`, `lib_symbol_mismatch`) can only be turned off. A
  board finding a custom rule decided carries that rule's `(severity …)` (`ruleSeverity`), which
  outranks the project's unless the project turns the check off: a check that resolves a rule
  passes its severity on (`ownSeverity`, or `one`'s last argument).
- **KiCad's exclusions are read, never written** (`lib/kicadExclusions.ts`), matched on rule and
  item uuids (`kicadIds`), not marker position; excluded findings are not counted.
- **Every board limit comes from one resolver** (`lib/board/rules/`): `boardRules(board, settings,
  customRules)` builds the board setup and net classes as KiCad's implicit rules, then the
  project's `.kicad_dru` (`dru.ts`, conditions compiled by `expression.ts`), and
  `ConstraintResolver.evaluate(type, a, b, layer)` answers the value and who set it. DRC, the
  zone filler, the route's sizes (`lib/board/routeSizes.ts`) and the router's clearance per item
  (`lib/board/router/rules.ts`) ask it, through `newItem` for copper not drawn yet; a new check or
  tool asks it too, never `settings.rules` directly, or the checks and the tools that make copper
  will disagree. A net's
  class is `netClassForNet` (`lib/kicad/project.ts`): every matching class by priority, field by
  field, then Default.

