# Projects and files

What a window is looking at, and how files are created, renamed and deleted with every reference
kept whole. Mechanics are in ARCHITECTURE.md §3.0 (change bus) and §3.6 (reference registry).
**Source comments cite these section numbers; keep them stable.**

## 1. The model

> The folder is what you can *see*. The project is what you can *change coherently*.

- **Workspace:** the opened folder. It holds the tree, search and the git root, and carries no
  design meaning. It may hold several projects.
- **Project:** a `.kicad_pro` and what it roots: library tiers, sheets, net classes, the board.
- **One window, one active project, or none.** "Will this edit propagate?" always has one answer.

| Context | Reached by | Semantics |
|---|---|---|
| Project | a folder with a `.kicad_pro`; Open Project | full |
| No project | a folder without one; Open File; drag-drop | files edit and save, **isolated** |

**What "isolated" costs:**
- no project-tier libraries;
- renames don't forward;
- no hierarchy;
- no board pairing;
- default settings.

## 2. Surfaces

- **The PROJECT pane** sits below the file explorer.
  - It shows an identity row, then Schematics, PCBs, Symbol Libraries and Footprint Libraries.
  - Its rows render through the explorer's `FileTreeNode`.
- **With no project**, the pane shows the identity row, what a project gives, and one way out: the
  switcher or `Create project…`.
- **Where context shows:** the sidebar carries window context; per-file context belongs on the tab.
- **Gating:** commands that need a project gate on the active project, with a tooltip saying why.

## 3. The active project

- **Detection.** Opening a folder scans for a `.kicad_pro` two levels deep.
  - Exactly one, or exactly one at the root: it is active.
  - Otherwise: **none until the user picks.** Never guess; a wrong guess applies another design's rules.
- **Ownership is by graph, not path.** A project owns the sheet its `sheets` entry names by uuid, and
  that sheet's children. Path is only the tiebreak, for boards and loose libraries.
- **Opening a file never changes the active project.** A file outside it is edited isolated.
- **Recents are project-keyed** (`RecentEntry`). Opening a recent file restores its workspace and project.

## 4. Starting work

- **Create project…** is one dialog. It scaffolds into an empty folder, adopts the loose files
  already in a folder, or opens a project that is there. Adopting writes the chosen schematic's
  uuid into `sheets[0]`.
- **Open Project** re-roots the window on the project's folder. The switcher changes the project without re-rooting.
- **Open Folder** detects the project (§3). **Open File** stays in the File menu only.

## 5. Two windows, one project

- **Main arbitrates committed state:** every commit goes on the change bus, and main rebroadcasts it.
- **A file is open once per app** (`tab:held-elsewhere`). Not yet built: tracking one dirty owner per path in main (§11).

## 6. Templates

Blank files are built as ASTs (`lib/project/templates.ts`) and written by the editors' own
serializer, pinned by golden tests. They are never pasted text.

## 7. Creating, deleting, libraries

### 7.1 Three kinds of create

- **Files:** a new file in a folder.
- **Containers:** a symbol in a `.kicad_sym`, a footprint in a `.pretty`.
- **Registrations:** an existing library made visible.

New Schematic only makes a file; instancing it is the sheet tool's job.

### 7.2 Surfaces

`New ▸`, explorer right-click, the explorer `＋` and the Project pane's rows all render one item tree.
- **The File menu grays** what it can't run, with a reason. **Row menus omit it.**
- **Renaming a `.kicad_mod`** rewrites its footprint name and Value to match.

### 7.3 Naming

- **Inline:** names are edited in the tree, and nothing is written until commit.
- **Collisions** block the commit; never overwrite or auto-suffix.
- **Rejected:** separators, reserved Windows names, leading or trailing dots and spaces, and case-only clashes.

### 7.4 Delete

Delete goes to the OS trash, never `unlink`. The confirm lists the files that reference what is deleted (`planDelete`).

### 7.5 Libraries: tier and location

Tier (global or project) and location (the URI) are independent.
- **Tier defaults to project.** The URI is written `${KIPRJMOD}`-relative when the library is inside
  the project folder.
- **Add Library defaults to copying into the project**, and shows the URI it will write.
- **Project tables** are KiCad's (`sym-lib-table`, `fp-lib-table`). The global tier is our own JSON in `userData`.
- **KiCad's global tables are imported once**, as a seed, never mirrored (`main/kicadGlobalTables.ts`).
- **New Library is create plus Add**, through one path (`lib/libraryRegistration.ts`).

### 7.6 The command registry

`lib/commands.ts` is one table of `{ id, label, enabledWhen, run }`. Every menu is a view over it.

## 8. Reference integrity

A rename is an edit to a set of files, one of which is the file's own name.

### 8.1 The reference registry

`lib/kicad/references.ts` declares reference kinds and their edges. The one kind built is `sheet.file`.
- **Path refs vs. name refs:** a library nickname's `lib_id`s are name refs, not yet handled (§11).
- **Next kinds:** library-table URIs and `footprint.model`.

### 8.2 Plan, preview, apply, verify

Planned in `lib/project/renamePlan.ts`.
- **Preview:** a rename with referrers is shown first; the preview stands in for undo.
- **Apply:** compute every new content in memory, rename the file, write the referrers, and roll
  back from the pre-images on a failure.
- **Verify:** nothing still resolves to the old path.

### 8.3 Open editors

A dirty referrer is edited in its buffer, never on disk behind it. The buffer is the authoritative
copy for readers too. Tabs follow a rename.

### 8.4 Process split

- **Renderer:** planning and rewriting, since the parsers are there.
- **Main:** filesystem primitives and the project watcher (`main/projectWatcher.ts`), which feeds the same bus.

### 8.5 Undo boundary

- **File operations are outside undo.** History is per document.
- **New Child Schematic:** its sheet insertion is undoable; its file write is not.
- **Recovery:** a preview before, the trash after, git underneath.

## 9. The project change bus

`lib/projectBus.ts` (`preload/projectChangeTypes.d.ts`). File commits and registry changes go on
it; a document edit stays local.
- **Invalidate, don't push:** subscribers reload lazily.
- **Generation counters:** a consumer compares one on next use, so it is correct even without subscribing.
- **One emit point per mutation**, coalesced per tick.
- **Main rebroadcasts** to other windows on the project.

## 10. Where KiCad's encoding falls short

Any change must stay derivable to and from KiCad.
- **Keep:**
  - plain text, one entity per file;
  - sheets as a graph;
  - per-instance references;
  - embedded symbols.
- **Re-encode:**
  - the board tied to its project by filename stem;
  - `${KICAD*_3DMODEL_DIR}` model paths;
  - `.pretty` folders as libraries;
  - stem-less project tables shared by every project in a directory.
- **Drop:** the separate tables. Together they are one registry with scopes (`IndexScope`), and
  the tables are an export format.

## 11. Open

**Windows and tabs:**
- A tab banner for a file outside the active project: "Edits are isolated."
- One dirty owner per path across windows, and reading or writing KiCad's `~name.lck` locks.
- The project name in the title bar, or a muted "no project" chip.

**Undecided:**
- What `New ▸` does in a folder owned by another project: warn, block or allow?
- What a loose file with no workspace opens as: a workspace at its parent, or a tree-less window?

**Creating and renaming:**
- Renaming a library nickname (name refs everywhere).
- Drag-to-move in the tree (a rename).
- A rename-project gesture, which would fix the board's stem coupling.
- The explorer `＋` as a `New ▸` popup.

**Other:**
- A portability lint for project-table rows with absolute URIs.
- Fuller `.kicad_pro` v3 fidelity.
- A `.kicad_pro` scan deeper than two levels, which needs an mtime memo.
