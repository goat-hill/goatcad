# Workspace rules

What every agent working in `goatcad` must follow, plus the recipes worth remembering. The doc
index is the root [AGENTS.md](../AGENTS.md).

**Projects**, each run from its own directory:
- `electron/`: the GoatCAD app (Electron, Vite, Vue 3). This is the default subject of this doc,
  and `src/**` paths are relative to it.
- `web/`: the marketing site ([WEB.md](./WEB.md)).
- `develop/`: GoatHerd, the app for running parallel agent workstreams (`develop/README.md`).

**"The app" means GoatCAD.** GoatHerd and the site are in scope only when named or pointed at by path.
Reading a sibling project to answer a question is fine; say so.

---

## 1. Agent operating rules

- **Stay in your directory.** Edit only your project or worktree, plus scratch dirs.
- **Never install anything.** No `apt`, `brew` or `npm install <pkg>`.
  - The only exceptions are `bin/deps-sync` and `bin/deps-update`, through the `upgrade-deps` skill, and
    `bin/deps-sync` as the `release` skill's first gate.
  - Adding a package is a request to the maintainer (§4).
- **Never run `npx`** unless the maintainer asks for that exact command. It installs whatever it can't find
  locally. Use the `bin/` wrappers (§3); if none fits, ask for one.
- **No auto-memory.** Durable knowledge goes in the repo:
  - rules and recipes here;
  - systems in ARCHITECTURE.md;
  - open work in `*-workstream.md`;
  - deferred items in BACKLOG.md.
- **One home per fact.** Each fact lives in the one doc that owns its topic; elsewhere, link to it.
- **Docs state the present, briefly.**
  - Replace old text rather than appending history; git keeps the past.
  - Keep a rationale only while it stops someone undoing a non-obvious choice, in one sentence.
  - A `*-workstream.md` is deleted when its work is done. Leftovers go to BACKLOG.md as one line each, and every reference to it is fixed.
- **Review diffs inline.** Read `git diff` yourself. No `/code-review` skill or review subagents: each one is a full priced context for little gain.
- **GoatHerd is the human's cockpit.** A change to agent tooling or workflow should consider the matching GoatHerd change.
- **When a rule blocks you, stop and ask.** Don't invent a workaround.

## 2. Version control

- **Commit on a feature branch** when a subtask is done.
- **Never commit or merge to `master`, and never push, unless asked** (for example through the `land` skill).
- **Never start a workstream that wasn't asked for.** "Commit this" means commit where the work is.
  - Don't create a branch or worktree on your own; that is the maintainer's call.
  - **One exception: worktree subagents.** You may spawn subagents in their own worktrees without
    asking, but only if each worktree symlinks `node_modules` to the parent checkout's before
    anything runs in it: `electron/node_modules`, plus `develop/` or `web/` if the agent touches
    them. A real install costs about 730 MB (`electron/`), 320 MB (`develop/`) or 430 MB (`web/`)
    per worktree. Make the symlink yourself right after the spawn, or make it the first step of
    the agent's prompt. Tell the agent never to install. If you can't symlink, ask first. A new
    worktree may start from `master` rather than your branch. Have the agent check its base and
    `git reset --hard <your branch>` before it edits anything.
- **Landing** follows the `land` skill: run the checks, commit, merge into `master` locally, then
  fast-forward the worktree. Never push.

## 3. Build, check, land

Run from `electron/`. `npm` is not on `PATH`: use the `bin/` wrappers, never `npx`.

- **Tests:**
  - `./bin/test` runs the whole suite (~7 s). It needs `python3` on PATH (the generated Python client is compiled).
  - **No silent skips.** A test whose prerequisite is missing fails and says what to install; it never reports skipped or passed.
  - `./bin/test-file <path or flag>` runs a narrower set, but only for chasing a failure.
- **Gates:**
  - `./bin/pre-cm-checks` (format, lint, typecheck, test; ~13 s) runs before every commit. Run it freely.
  - `./bin/pre-merge-checks` (the bundle; ~8 s) runs only at landing. It is not an "am I done" check.
- **Other wrappers:**
  - `typecheck`, `lint`, `format`, `build`;
  - `test-i18n` checks translation completeness (pre-release);
  - `test-e2e` needs a Python interpreter;
  - `test-parity` compares against KiCad (see [kicad-parity.md](./kicad-parity.md#running-the-suites)).
  - `launch-timing` and `board-timing` measure performance (`--record` adds a row to `perf/*-history.html`);
  - `reset` gives a fresh-install profile.
  - `./bin/dev` blocks the shell, so it is the maintainer's command.
  - `./bin/goatcad` is this worktree's build as the `goatcad` command, in the worktree's own
    profile (`.goatherd/goatcad/`), beside an installed GoatCAD or another worktree:
    `./bin/goatcad dev` runs the app with HMR, `./bin/goatcad mcp` relays to it, and
    `./bin/goatcad help agents` prints the line that registers it as `goatcad-dev`.
- **Validation loop:**
  1. Run `pre-cm-checks` as you edit.
  2. Stop and ask for review. Say which kind it needs: the diff, the approach, or QA in the app.
     Not everything needs visual QA.
  3. After approval, `pre-merge-checks` runs at landing.
- **A merge or `/land` is the approval, QA included.** Never caveat landed work as unreviewed. Name
  what you couldn't verify once, in the review request. Don't relitigate a decision the maintainer has made.
- **Screenshots are opt-in.** Run `./bin/screenshot` only when asked; the maintainer QAs visual changes.
- **Visual artifacts go in the worktree's `.goatherd/`** (gitignored), where GoatHerd's Workspace tab shows them.
  - Use a `<name>/` folder with a short `review.md` that embeds the images.
  - GoatHerd's markdown renderer handles no tables and no raw HTML.
- **Develop in English only.** New strings go in `locales/en/`; never touch other locales.
  - `test-i18n` covers completeness.
  - Correctness (a malformed message, plurals) stays in `messages.test.ts` in the default suite.
- **Mark every locale key** with `t('ns.key')`, or `tk('ns.key')` when it is translated later.
  - Never a bare `'ns.key'`; `messages.test.ts` fails on one.
  - Choose with `cond ? t('a') : t('b')`, not `t(cond ? 'a' : 'b')`.

## 4. Dependencies

- **Minimal and approved.** Add a package only if it is well trusted, adds real value, and the
  maintainer approves. The maintainer runs the install.
- **Scaffold with official tools** (`npm create …`, `npm install <pkg>`), never hand-written versions
  or skeletons. Name the command; the maintainer runs it.
- **`dependencies` means "must exist unbundled on disk at runtime".** electron-builder ships those.
  - Renderer packages are inlined by Vite, so they are `devDependencies` (`vue`, `three`).
  - Packages that `main` and `preload` import are externalized, so they are `dependencies`. After a
    build, this lists them:
    ```sh
    grep -roh 'require("[^"]*")' out/main out/preload | sed 's/require("//;s/")//' | grep -v '^node:' | sort -u
    ```
  - Also `dependencies`:
    - native `.node` modules;
    - packages that read their assets from disk (`occt-import-js`);
    - packages that break when bundled (`electron-updater`);
    - anything a child process resolves by name.
- **Upgrades** go through the `upgrade-deps` skill. Moving a package between sections needs the
  maintainer to run `npm install`.
- **Licenses:** a package must be GPL-3.0-compatible (BRAND.md §2). After any dependency change
  run `./bin/notices`; the default suite fails until `resources/THIRD_PARTY_NOTICES.txt` and the About
  list beside it (`lib/licenses.json`) are current. A component About should name first goes in `scripts/third-party-notices.mjs`'s `FEATURED`.
- **Typings:** use official type packages, referenced in `src/renderer/src/env.d.ts` when not auto-loaded.

## 5. Code hygiene

- **No personal names, machine-specific paths or secrets** in committed code or docs. A doc may
  cite a local path when a recipe depends on it.
- **American English everywhere:** identifiers, comments, copy, docs, commits.
- **Comments:**
  - Explain why, not what; one line beats a paragraph.
  - A comment that reads like a commit message belongs in the commit.
  - Keep only what stays non-obvious after the change: an external source, an invariant, a trade-off someone would "fix".
- **Cross-reference duplicated constants** at each site. Known pairs:
  - KiCad extensions: `electron-builder.yml` ↔ `src/main/launchArgs.ts`;
  - app identity: `src/main/appConfig.ts` ↔ `electron-builder.yml` ↔ `bin/reset`;
  - palette: `base.css` ↔ `web/src/styles/tokens.css`;
  - brand-mark geometry (BRAND.md).
- **Write externally defined lengths in their unit**: `spacingToMm(6, 'mil')`, never `0.1524`
  or `6 * 0.0254`. The helper routes through integer nm and rounds correctly. This doesn't apply
  to internal tuning numbers.
- **A missing core dependency is an error, never a quiet fallback.** Await an async module (Clipper) before work that needs it;
  calling before then throws. Start the load at launch.
- **Strict TypeScript:** no `any`, no suppressions.
- **Test pure logic** in `__tests__` beside it.
- **Default-suite tests run in milliseconds.** Prove a behavior on the smallest input that shows it.
  Timings and real-board sizes belong in a manual harness or the parity suites, and never assert wall-clock time.

## 6. UI / UX

The enforced floor. The design system is [DESIGN.md](./DESIGN.md).

- **Theme through tokens, never hardcoded.**
- **Icons come from the app's registry, never inline SVG.**
  - GoatCAD: `lib/icons.ts` with `shared/Icon.vue`; file kinds in `FileIcon.vue`.
  - GoatHerd: `src/renderer/src/icons.ts`.
  - Site: `web/src/data/icons.ts`.
  - Only decorative art and the brand mark stay inline.
- **Never a Unicode character as an icon.** Its font differs per OS (DESIGN.md §Icons).
- **11px is the minimum font size; it is a floor, not a default.** Use `var(--text-caption)`, not
  `11px`, so the floor stays greppable. Size to the space: full-pane surfaces use 13px or more.
- **Frameless regions:** the title bar is draggable; its controls are `no-drag`.
- **Reduced motion is required:** gate every animation on `prefers-reduced-motion`.
- **Leaving a field applies it; Escape abandons it.** `PropertyValueEditor` commits on a
  capture-phase document mousedown, before a canvas click changes the selection.
  - **Except a name prompt** (saving a preset): Enter or its confirm button saves, and leaving
    abandons it like Escape (`commitOnEnter`), since clicking away is not consent to create.

## 7. ECAD & KiCad compatibility

- **Preserve KiCad files on round-trip.**
  - Edits go through the parsed AST and leave unknown nodes, formatting and order intact.
  - A save diffs to only what changed.
  - The serializer is a port of KiCad's `Prettify` ([references/kicad-format-spec.md](./references/kicad-format-spec.md)).
  - Verify writer changes against real KiCad files, not fixtures.
- **KiCad's source is a reference, never code to copy.**
  - **Exact output:** where ours must match KiCad's (file bytes, migration, export formats), follow
    its steps and name the source in the file.
  - **First principles:** everything else is designed from scratch and tested against `kicad-cli`.
  - **Vendored:** newstroke is the only exception.
  - **Attribution:** a file that follows KiCad's source carries
    `// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.`
    as its first line (the README's License section).
  - **Nothing of KiCad's in the repo:** no boards, QA tests or reports. The parity suites and
    `board-timing` read a local checkout (`KICAD_SOURCE`).
- **Formats:** `.kicad_sch`, `.kicad_pcb`, `.kicad_sym` and `.kicad_mod`, parsed and written.
- **Read old, write current.**
  - We open KiCad 6 and later, and save only KiCad 10. Writers are never version-aware.
  - An older file is migrated on its first save; opening never changes it.
  - Files newer than 10 or older than 6 open read-only.
  - The bar: KiCad 10 reads our save as the same design ([format-migration-workstream.md](./format-migration-workstream.md)).
- **Cross-platform:** Windows, macOS and Linux, for window events and paths.
- **File associations** are duplicated between build config and source; change every site (§5).

## 8. Performance

- **Rendering is Three.js on WebGL.** The engine is WebGPU-ready, but don't add WebGPU-only paths
  or call the app WebGPU-based.
- **Stay fast on large files:**
  - typed arrays over object soups;
  - virtualize or stream large data;
  - update incrementally rather than reparsing;
  - send heavy work to workers.
- **A closed editor leaves nothing behind.** One stray reference to a closed board is an
  out-of-memory crash after a few reopenings.
  - **Listeners:** remove each from the node it was added to, kept in a field. Never re-derive that node at teardown.
  - **Lazy module stores:** make their reactivity in a detached `effectScope(true)`, with `effect`, not `watch` or `computed`.
  - **Shared GPU resources** (the glyph atlas) are released as each renderer goes.
  - **`dispose()` and `close()`** drop their heavy references.
  - **`WeakMap`** is for caches, not a substitute for teardown.
  - **A store that outlives the editor copies the strings it keeps.** A parsed name is a slice of the whole file's text.
  - **`import()` of a chunk with CSS goes at module scope.** Vite's preload keeps the first call's closure, and the scope it was made in, for the life of the page.
  - **Check with the heap recipe** (§11) when a change holds editor state.
- **Never do unbounded work on the UI thread in one interaction.**
  - Cap what one interaction renders.
  - Filter once per settled query.
  - Debounce or chunk.
  - Model: the Libraries navigator search (`lib/libraryNavSearch.ts`).
- **Mutations go through the undo/redo command layer.**
- **Degrade gracefully.** A missing tool, library or file never crashes a window (model: `src/main/gitStatus.ts`).
- **Persisted state lives in the main-process config store** (`config:*`), never `localStorage`.

## 9. IPC bridge & Electron security

- **A new IPC channel touches three files:**
  - the handler in main (`src/main/index.ts` or its domain module);
  - the bridge in `src/preload/index.ts`;
  - the type in `src/preload/index.d.ts`.

  Shared types go in `preload/*.d.ts`. The renderer reaches Node only through the preload.
- **Arguments must be plain data.** A Vue proxy fails with "An object could not be cloned", a
  rejection that strands spinners. Convert at the call site:
  - spread a flat store;
  - `JSON.parse(JSON.stringify(…))` a nested one;
  - preferably, rebuild from a schema, as `PartsSettings.vue` does.
- **Keep the security baseline:**
  - `contextIsolation` on and `nodeIntegration` off;
  - `sandbox: false` is deliberate;
  - validate and allowlist everything crossing from the renderer (model: `goatcad-media://`);
  - never load remote content into an app window.

## 10. Keep the architecture doc synced

Update [ARCHITECTURE.md](./ARCHITECTURE.md) when you add, move or remove a subsystem, or change a
rule that spans files.
- **Module mechanics** go in the file's header comment; a workstream's design goes in its doc.
- **Size:** keep ARCHITECTURE.md near its current length. Adding a section means trimming another.

## 11. Recipes

**Verify on screen, not in code.** Whether a question is how something looks or behaves, drive
the app or ask for a screenshot.
- **Driving it:** `./bin/screenshot --script probe.mjs` gets Playwright's `page`, so it can assert
  what a PNG cannot show: cursors, computed styles, focus.
  - `--open` resolves from `electron/`, so pass `"$PWD/…"`; a wrong path silently opens nothing.
  - Copy a system KiCad library somewhere writable first; read-only disables the tools.
  - A dev-server engine change needs a hard reload. `ViewportEngine` is built once, in `onMounted`.
  - Under xvfb, frames are software WebGL (~150 ms). Time a no-op beside the real interaction.
- **Recording:** the `record-app` skill makes mp4s and gifs; it is a demo, not a test.
  - Use a sample from a clone of `goat-hill/goatcad-sample-projects` (`$GOATCAD_SAMPLES`, default
    `~/code/goatcad-sample-projects`), copied first, since the app writes to it.
  - Harnesses force `--ozone-platform=x11`, or Wayland ignores xvfb.
  - Board frames are WebGL: click by coordinates, and expect ~3 fps on heavy boards.

**Distributor keys in a harness.** `safeStorage` is unavailable under Playwright. An unpackaged app
falls back to `electron/.env` (`GOATCAD_DEV_DIGIKEY_CLIENT_ID`, `…_SECRET`, `GOATCAD_DEV_MOUSER_API_KEY`).
- **Profile:** use your own `--user-data-dir`.
- **Standalone probe:** call `app.setName('GoatCAD')` before reading real credentials.

**Finding a leak.** `HEAP_FILE=<name> ./bin/screenshot --open <file> --script
scripts/heap-cycle.mjs --timeout 600000` reopens a file and prints the heap each cycle.
- **Reading it:** flat after the second open is healthy; a step every cycle is a leak.
- **Following it:** `HEAP_SNAPSHOT=<path>` writes a snapshot, and `node --max-old-space-size=12000
  scripts/heap-retainers.mjs <path>` prints the chain from a GC root to each live board.
  `--largest=N` follows the biggest objects instead, such as a held file text.
  - The build is minified, so search the source for the property names in the chain.

**Chasing a KiCad difference:** [kicad-parity.md](./kicad-parity.md#chasing-a-difference).
