---
name: upgrade-deps
description: Upgrade npm dependencies across the workspace's three projects (electron/, develop/, web/) — lockfile-only by default, or one ecosystem group at a time for major bumps that may need code changes. Use when the user asks to update, upgrade, or bump dependencies, or to clear `npm outdated`.
---

# Upgrade dependencies

The repo is three self-contained npm projects with three lockfiles and three
`node_modules`; the root has none. This skill upgrades them, one project at a
time, and runs each project's own gate before anything is committed.

**[docs/RULES.md](../../../docs/RULES.md) §1's "never install anything" is
enforced, not just written down.** `.claude/settings.json` hard-denies
`Bash(npm install)` and `Bash(npm ci)`, and a deny cannot be prompted past — so
this skill does not call npm directly. The installing steps go through two
wrappers that exist in all three projects and do exactly one thing each:

- **`bin/deps-sync`** (`npm ci`) — makes `node_modules` match the committed
  lockfile. No registry resolution, no tracked file changes, idempotent.
- **`bin/deps-update`** (`npm update`) — moves `package-lock.json` forward
  within the ranges `package.json` already declares. Cannot cross a major;
  passes `--save=false` last so `package.json` cannot move.

Major mode needs `npm install <pkg>@<ver>`, which has no wrapper and is denied:
**those installs are the maintainer's to run**, one command at a time, and the
skill hands them over rather than attempting them. Adding a *new* dependency is
§4's ask-the-maintainer regardless of mode. Nothing here runs `npx` (§1), and
nothing touches a fourth directory.

## Arguments

`$ARGUMENTS` selects the mode and the scope; both are optional and order-free.

- mode — `safe` (default) or `major`
- scope — `electron`, `develop`, `web`, or all three (default)

`/upgrade-deps` → safe, all three. `/upgrade-deps major electron` → major bumps
in `electron/` only. Anything unrecognized: stop and ask rather than guess.

npm is not on `PATH`. The `bin/` wrappers source nvm; for the raw `npm`
commands below, source it yourself first: `source "$HOME/.nvm/nvm.sh"`.

## 0. Preflight

- **Clean tree.** `git status --porcelain` must be empty. An upgrade rewrites
  lockfiles; unrelated edits in the same commit are unreviewable. If it's
  dirty, report what's there and stop — never stash (worktrees share the stash
  stack).
- **Not on `master`.** §2: work lands through a branch. If `git branch
  --show-current` is `master`, stop and ask.
- **Sync every in-scope project before measuring anything:**

  ```bash
  ./<project>/bin/deps-sync
  ```

  This is not optional and not a formality. A worktree's `node_modules` is
  copied at creation and then goes stale as the branch advances — at the time
  this skill was written, `electron/` had nine packages behind its own lockfile
  (`eslint` 9.39.5 installed against a 10.8.0 lock) and `develop/` was missing
  `vitest` entirely, so `bin/test` could not run. Until `npm ci` has run,
  `npm outdated`'s **Current** column describes a tree nobody is upgrading and
  every gate result is about the wrong code. `npm ci` changes no tracked file,
  so a diff after it means the lock was genuinely inconsistent — report that,
  it's a separate bug. If `deps-sync` is not on the permission allowlist it will
  prompt; that is the one approval this skill's safe path needs.

## 1. Survey

Per in-scope project: `npm outdated` (exits non-zero when anything is
outdated — that's normal, not a failure). Read the columns as:

- **Current ≠ Wanted** → in range. Safe mode's whole scope; lockfile only.
- **Wanted ≠ Latest** → out of range. Major mode's scope; needs a
  `package.json` edit and may need code changes.

Then report **cross-project drift**: where two projects carry different majors
of the same shared tool (`eslint`, `typescript`, `vite`, `vitest`, `electron`,
`prettier`, `playwright-core`, `vue`, `@types/node`, `vue-tsc`). Report it
every run, in both modes, even when the run won't fix it. `electron/` leads —
it is the product; `develop/` and `web/` follow it. Align **majors**, not exact
versions: `web/` is on Astro's release timing and shouldn't be dragged to
`electron/`'s patch cadence.

## 2. Safe mode — lockfile only

Per project, in this order:

```bash
./<project>/bin/deps-update          # package.json is untouched by construction
```

It takes optional package names (`bin/deps-update astro`) when you want to move
one thing rather than everything in range, and `--dry-run` to preview.

Then §4 (allowScripts), then §5 (gate), then §6 (commit). Afterwards
`git diff` may touch **only** `package-lock.json` plus §4's `allowScripts`
block in `package.json`. Any other `package.json` line means something ran with
`--save` and the run is no longer "safe"; back it out.

Two things `npm update` does that look alarming and are not. It rewrites the
lock's own root `version` field to match `package.json` — that is npm fixing a
lock that lagged a release bump, never a version bump of its own. And it can
re-hoist a package that two dependents need at incompatible ranges, so
`node_modules/<pkg>` changes version while a nested copy takes over the old
one; compare *every* copy before calling it a downgrade.

Safe mode is one commit per project. It is a chore, not a decision: run it end
to end and report what moved.

## 3. Major mode — one group per commit

Majors go in **ecosystem groups**, never one package at a time and never all at
once. A group is a set that must move together or the typecheck lies:

| group | packages |
|---|---|
| lint | `eslint`, `eslint-plugin-vue`, `vue-eslint-parser`, `@electron-toolkit/eslint-config-*` |
| types | `typescript`, `vue-tsc`, `@astrojs/check` |
| build | `vite`, `vitest`, `@vitejs/plugin-vue`, `electron-vite` |
| runtime | `electron`, `electron-builder`, `@types/node` |
| 3D | `three`, `@types/three` |
| site | `astro`, `@astrojs/sitemap` |
| deploy | `wrangler` (alone — see §7) |

**Check peers before proposing a group.** `npm view <pkg>@latest peerDependencies`
costs one call and is the difference between a plan and a wasted round-trip:
vite 8 is unreachable for both apps while `electron-vite` peers on `^5 || ^6 ||
^7`, and TypeScript 7 is unreachable for `web/` while `@astrojs/check` peers on
`^5 || ^6`. A group that cannot resolve is not a group to offer.

Present the available groups with their version jumps and **let the maintainer
pick**; don't assume "all of them." Then, for each chosen group, in its own
commit, hand over one command for them to run (there is no wrapper for this and
`npm install` is denied — see the top of this file):

```bash
npm install <pkg>@^<new> <pkg>@^<new> ...   # the whole group in one command
```

**Choose the range; do not inherit it.** An upgrade is the one moment the range
is genuinely up for decision, and copying whatever the file already had just
launders some old bulk edit into a decision nobody made. Ask what the package
actually does with minors: `^` for anything that honors semver, `~` for the
packages that ship breaking changes in a minor — TypeScript above all, whose
minors routinely add errors to code that compiled yesterday. Where the same
package carries different styles in different projects, settle it across all
three rather than preserving the split. Then §4, §5, §6.

**Stop at the first group whose gate fails in a way you cannot fix cleanly.**
A lint rule renamed or a type narrowed is yours to fix in the same commit; a
breaking API that wants a real design decision is the maintainer's. Report the
failure, leave the tree at the last green commit, and ask — do not pin back to
dodge it and do not carry a red group into the next one.

## 4. Refresh `allowScripts` — every install, both modes

`package.json`'s `allowScripts` records which dependencies may run install
scripts, and npm writes those approvals **pinned to a version**
(`"esbuild@0.28.1": true`). Every upgrade of a script-running package
invalidates its pin, and installs then report it as unreviewed. This drifts
silently: `electron/` was approving `electron@39.8.10` while running 43.2.0.

After each install, from the project directory:

```bash
npm approve-scripts --allow-scripts-pending    # read-only: lists what is unreviewed
```

Then split the list in two, and treat the halves differently:

- **A package already named in `allowScripts`, at a new version** — a re-pin of
  something previously reviewed. Mechanical: `npm approve-scripts <pkg>`
  rewrites the pin to the installed version. Do it.
- **A package not in `allowScripts` at all** — a dependency that gained an
  install script, or a new transitive one. **That is a decision, not a chore:
  stop and ask.** Never reach for `--all` (blanket-approves without review) or
  `--dangerously-allow-all-scripts`.

Denials (`false` entries) always win and are left alone. Note that
`--allow-scripts` on the command line is an error during a project install —
the `package.json` field is the only policy surface here.

## 5. Gates — per project, always before committing

Run every gate for the project you changed. Never commit an upgrade that
hasn't built.

- **`electron/`** — `./bin/notices` first (a changed package changes the
  notices the build ships, and the default suite fails until they match), then
  `./bin/pre-cm-checks` **and** `./bin/pre-merge-checks`.
  Both, unlike ordinary feature work: a dependency bump is exactly the case
  where bundling can break while typecheck stays green (a package's exports
  map, a Vite plugin API, an externalized dep). If the group touched
  `dependencies`/`devDependencies` placement, also re-run §7's ship-list check.
- **`develop/`** — `./bin/pre-cm-checks` and `./bin/pre-merge-checks`.
- **`web/`** — `./bin/check` then `./bin/build` (what CI's `web` job runs).

`electron/` and `web/` are in CI on node 24 with `npm ci`, which fails if
`package.json` and `package-lock.json` disagree — so both files ship in the
same commit, always. `develop/` is not in CI; its gate is the only check it
gets.

## 6. Commit

One commit per project per mode, or per group in major mode. Stage by name —
`package.json` and `package-lock.json` for that project, plus any source file
the upgrade forced you to change. Message style matches `git log --oneline`:

```
bump electron/ dependencies within range
move develop/ to eslint 10
```

Landing is `/land`'s job, not this skill's. Report at the end: what moved per
project, what the gates said, any cross-project drift still open, and any group
you stopped on.

## 7. Hazards this workspace actually has

Check these when the relevant package is in the run; they are the reasons a
generic `npm update` is not enough here.

- **`@types/node` tracks the Node major that Electron bundles**, not npm's
  `latest`. Upgrading it past Electron's Node types the main process against an
  API surface that isn't there at runtime. Read Electron's release notes for
  the bundled Node version and match the major.
- **`three` and `@types/three` track the same *minor*, not the same version.**
  DefinitelyTyped patches independently, so `@types/three` legitimately runs
  ahead (0.185.4 against three 0.185.1, whose 0.185.1 *is* the latest). Check
  the minor matches; do not try to force the patch.
- **An `electron` major is not just a bump.** It rebuilds native modules
  (`develop/`'s `node-pty`) through the `postinstall`
  `electron-builder install-app-deps`; it can move the `electron-builder.yml`
  contract; and it touches what
  [RELEASES.md](../../../docs/RELEASES.md) documents about artifacts and
  updates. Read that doc before landing one, and say in the report if the
  mac-signing workflow is implicated.
- **`dependencies` vs `devDependencies` decides the shipped download size**
  (RULES.md §4). If an upgrade moved a package between the two — or you were
  tempted to — re-derive the real ship list after a build:

  ```bash
  grep -roh 'require("[^"]*")' out/main out/preload | sed 's/require("//;s/")//' | grep -v '^node:' | sort -u
  ```

  Plus the four categories that belong in `dependencies` despite never
  appearing there: native `.node` modules, packages read from disk at runtime
  (`occt-import-js` and its `.wasm`), packages that break when bundled
  (`electron-updater`), and anything a child process resolves by name.
- **`wrangler` is the deploy tool, not a library.** A major can change the
  deploy runbook in [WEB.md](../../../docs/WEB.md); `web/bin/build` passing
  proves nothing about `npm run deploy`. Bump it alone, and flag the runbook
  for the maintainer to re-check.
- **`npm update` follows the `latest` dist-tag, so it can walk a package
  backwards.** `electron-builder` publishes 26.15.4-26.16.0 but still tags
  26.15.3 as `latest`, and `npm update` took the tag. Nothing is deprecated —
  it is the publisher's choice. Diff installed versions before and after and
  raise any that went down; the packaging tool moving is a maintainer's call.
- **A `package.json` range above the registry's `latest`** (`@types/tar` sits
  at `^7.0.87` while the `latest` tag is `6.1.13`) is deliberate, not a bug to
  "fix" downward. Leave it and mention it.

## Rollback

Every step is one commit, so the undo is one revert plus a re-sync:

```bash
git revert --no-edit <sha>     # or: git checkout <sha>~1 -- package.json package-lock.json
./<project>/bin/deps-sync
```

Never hand back a tree where `node_modules` disagrees with the committed
lockfile — that is the exact state §0 exists to clean up.
