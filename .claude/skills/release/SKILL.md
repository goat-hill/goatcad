---
name: release
description: Cut a GoatCAD release — pick the next version with the user, bump electron/package.json, run the release gates, and push the tag that triggers the draft build. Use when the user asks to cut, tag, or ship a release.
---

# Cut a GoatCAD release

Pushing a `v*.*.*` tag is the whole trigger: `.github/workflows/release.yml`
gates on version-match and i18n, builds the three-OS matrix, uploads every build
to R2 — **including the `latest*.yml` update metadata**, held back until
publishing — and opens a **draft** GitHub release that links to them. See [docs/RELEASES.md](../../../docs/RELEASES.md) §5 for
the flow this skill implements.

**This skill stops at the pushed tag.** Writing release notes and publishing are
the human's, deliberately: publishing is the act that means "these files are
real", and it is what fires `web-release-bump.yml` to repoint the site's
download buttons. Never publish a release on the user's behalf.

Releases are cut from `master` in the **main checkout**, and nowhere else — the
tag must land on the commit master actually has. Running from a worktree or a
feature branch is not a case to handle, it is a case to refuse.

**A release ships `electron/` and nothing else.** The tag packages the app, so
the app is the only thing this skill verifies. Changes under `web/` or
`develop/` in the range are not this skill's business: the site deploys off
master on its own schedule, and `develop/` never ships. Do not run their checks
here and do not let their state gate a tag.

## 0. Preflight (abort = report and stop; fix nothing silently)

```bash
git rev-parse --path-format=absolute --git-dir
git rev-parse --path-format=absolute --git-common-dir
git branch --show-current
git status --porcelain
```

All four are hard gates. Any of them wrong means **stop and report** — do not
`cd` to the main checkout, do not switch branches, do not stash:

- **Must be the main checkout.** If `--git-dir` ≠ `--git-common-dir` you are in
  a linked worktree. Stop. Tell the user to re-run the release from the main
  checkout; if the worktree holds work that should ship, point them at the
  `land` skill first. Never reach over into `$MAIN` from a worktree — a release
  tags the tree you are standing in, so stand in the right one.
- **Must be on `master`.** If `git branch --show-current` is anything else,
  stop. A tag cut from a feature branch names a commit master does not have.
- **Must be clean.** `git status --porcelain` empty. If something is parked
  there, stop and say what.

Everything after this point runs in the current checkout — plain `git`, no
`-C`.

## 1. See what is actually released

```bash
git fetch origin --tags --prune --prune-tags
git tag --sort=-v:refname | head
```

Fetch first — local tags go stale, and a version already taken on the remote is
the one mistake that cannot be undone gracefully. Then gather what the proposal
in §2 needs:

- Current version: `jq -r .version electron/package.json`.
- What is going out: `git log --oneline <last-tag>..master`.
- What is not yet on the remote: `git rev-list --count origin/master..master`.
  Master is often ahead; §4's push sends those commits too, so say how many.

Note that the current `package.json` version may already equal the last tag
(the bump happens here, not in feature work), so the next version is derived
from the tag list, not from `package.json` alone.

## 2. Propose a version — always confirm, never pick silently

Suggest the next version from the tag list and the commit range, then **confirm
with the user using AskUserQuestion** before touching anything. A pushed tag is
public and effectively immutable; this is the one step that must not be
inferred.

Pre-1.0, so the convention is loose by design: patch (`0.0.2` → `0.0.3`) for
fixes and ordinary work, minor (`0.0.x` → `0.1.0`) when a release is worth
pointing at. Nothing is breaking-by-convention below 1.0.

Offer the computed patch bump first, the minor bump second, and let the user
type their own. Summarize the commit range in the question so the choice is
informed rather than a guess at what shipped.

Settle the number **before** §3 runs anything. The gates have to see the tree
that ships, version field included — a bumped `package.json` can move a snapshot
or a version assertion, and finding that out after a green gate run means
running them all again.

## 3. Bump, then run the gates — never tag red

Edit `electron/package.json` first, the `version` field only. The string is bare
— **no `v` prefix**; `release.yml`'s `check-version` job compares
`${GITHUB_REF_NAME#v}` against it and fails the release in seconds on a
mismatch. The `v` belongs only to the tag.

Then run the same checks CI runs, but locally where fixing them is cheap. npm is
not on `PATH`; the `bin/` wrappers source nvm for you. Run from the repo root.

- **Licenses** — `./electron/bin/notices`, first. It rewrites
  `resources/THIRD_PARTY_NOTICES.txt` and the About list
  (`src/renderer/src/lib/licenses.json`) from the installed packages
  and the wasm builds' `*.licenses.txt`, so any dependency change in
  `electron/package.json` or rebuilt Emscripten module since the last release
  reaches the notices the build ships. Run it every release rather than judging
  whether one of those changed: when nothing did, it rewrites the same bytes.
  When it changes anything, the change ships in the release commit (§4).
- **i18n** — `./electron/bin/test-i18n`. This is a release-only gate on purpose:
  an untranslated key falls back to English so it never blocks a feature PR, but
  it does block a release. Failures name the exact missing keys. **If it fails,
  use the `localize` skill to clear the debt** — do not hand-edit locale files
  around it, and do not tag with the gate red on the theory that CI will catch
  it. CI catching it means a tag you have to delete.
- **Build** — `./electron/bin/pre-cm-checks` (format, lint, typecheck, test)
  then `./electron/bin/pre-merge-checks` (the bundle), the same pair the `land`
  skill runs. `release.yml` does not typecheck before packaging, so a type error
  surfaces three times in parallel twenty minutes into the matrix. Fifteen
  seconds here is the cheaper place to find it.

A gate that fails here is a release that stops here. Fix it, re-run, and only
then continue — the bump is uncommitted until §4, so there is nothing to undo.

## 4. Commit, tag, push

**Only once §3's gates are green.** Nothing before this point leaves the
machine, and nothing here runs on a red gate — a pushed commit is recoverable, a
pushed tag is not.

1. Commit the bump, and any notices §3's `bin/notices` rewrote, message
   `Release vX.Y.Z`, with the standard Claude co-author footer.
2. Push in this order — **master first, then the tag** — so the remote already
   has the commit the tag names. A tag that lands first points at nothing the
   remote can see, and `release.yml` starts against a commit GitHub does not
   have:

```bash
git tag "vX.Y.Z"
git push origin master
git push origin "vX.Y.Z"
```

Pushing is in scope for this skill — it is the point of the skill — but only
after §2's confirmation and §3's green gates. If the push is rejected because
master moved, do **not** force anything: pull, re-run §3's gates, and retry.

## 5. Hand off

Report:

- The tag pushed and the commits it covers.
- That `release.yml` is now running, and roughly what it does (gates → three-OS
  matrix → draft release). `gh run watch` if the GitHub CLI is installed;
  otherwise the Actions tab.
- **What the human does next:** wait for the draft, write the notes, publish.
  Publishing fires `web-release-bump.yml`, which promotes the update feed on R2
  — every installed copy then offers the new version (`docs/RELEASES.md`
  §4.1) — rewrites `web/src/data/release.json` to point at the builds and
  redeploys the site.
  Publishing as a **prerelease** leaves the feed and `release.json` alone. The
  draft's links work before anything is published, so a draft is already a way
  to hand someone a build without moving the site's download buttons.

The macOS `.dmg` is signed and notarized by the release job, so it installs
without a Gatekeeper workaround (`docs/RELEASES.md` §7). If that job fails at
**Prepare macOS signing credentials** or **Verify macOS signature and
notarization**, the release cannot ship as-is — the first means a missing or
malformed repository secret, the second means the build came out unsigned or
unnotarized despite a green electron-builder run. Neither is safe to work around
by re-running with the check removed.

**Windows is still unsigned**, so mention that SmartScreen will warn on the
`-setup.exe` ("More info" > "Run anyway"). Drop that note once a Windows
certificate lands.
