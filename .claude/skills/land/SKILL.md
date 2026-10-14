---
name: land
description: Commit the current worktree branch, merge it into master in the main checkout, and fast-forward the worktree so work continues — the standard wrap-up for a GoatCAD feature worktree. Use when the user asks to commit/land/merge the worktree's work.
---

# Land the current worktree onto master

The GoatCAD flow: features are built on a branch in a linked worktree under
`.claude/worktrees/<name>`, merged into `master` in the **main checkout** (the
non-worktree clone, derived as `$MAIN` in the preflight below), and the worktree
keeps going on the same branch.
This skill is that wrap-up, end to end. Everything is local — **never push
unless the user explicitly asks** (then: `git -C "$MAIN" push origin master`).

## 0. Preflight (abort = report and stop; fix nothing silently)

```bash
BRANCH=$(git branch --show-current)
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
```

- Must be a linked worktree: `git rev-parse --git-dir` ≠ `--git-common-dir`.
  If they're equal you are *in* the main checkout — this skill doesn't apply.
- Main checkout must be on `master` and clean:
  `git -C "$MAIN" branch --show-current` is `master` and
  `git -C "$MAIN" status --porcelain` is empty. If not, stop and tell the user
  what's parked there — never stash or switch someone's checkout.

## 1. Verify before committing — one gate per surface the change touches

The repo is three independent npm projects, each with its own gate and its own
`node_modules`; the root knows about none of the others. Look at which top-level
dirs the change spans (`git status --short`, which also catches untracked) and
run the gate for **every** surface touched. Always **before** staging — the
formatters rewrite files. If any gate fails, fix and re-run; never land red. npm
is not on `PATH`, but every gate below is a `bin/` wrapper and those source nvm
for you; only a raw `npm` command needs `source "$HOME/.nvm/nvm.sh"` first.

- **`electron/`** — the GoatCAD app. `./electron/bin/pre-cm-checks` (format,
  lint, typecheck, test) then `./electron/bin/pre-merge-checks` (the bundle).
  Skip the first only if every commit being landed already passed it — it is
  what rewrites files, so it must run before staging either way.
- **`web/`** — the Astro marketing site, its own project the root gate does not
  know about. `web/bin/check` then `web/bin/build` (astro check + build —
  exactly what CI's `web` job runs). Format is not gated here.
- **`develop/`** — GoatHerd, the worktree manager. Also its own project the
  root gate does not know about. `./develop/bin/pre-cm-checks` (format, lint,
  typecheck, test) then `./develop/bin/pre-merge-checks` (the bundle) — the
  same pair as `electron/`, and the same rule about running the first before
  staging.

A change spanning two surfaces runs both gates. A change touching none of the
three — root tooling, `docs/` docs, `.claude/skills/` — has nothing to build:
skip straight to staging.

## 2. Commit on the worktree branch

- Review `git status --short` and the diff. Stage the files that belong to the
  work **by name** — not `git add -A`. Stray artifacts (a rogue root
  `package-lock.json`, editor droppings, unrelated `web/` lockfile churn) stay
  out; if something unexpected looks intentional, ask about it rather than
  guessing in either direction.
- Message style matches `git log --oneline`: one short lowercase-ish imperative
  line ("PDF/HTML viewer tabs over a streaming goatcad-media:// protocol"),
  no bullet-list body needed. Keep the standard Claude co-author footer.
- Nothing to commit is fine — skip ahead; the branch may still be ahead of
  master from earlier commits. If `git rev-list --count master..HEAD` is 0
  too, there is nothing to land: say so and stop.

## 3. Merge into master (in the main checkout)

```bash
git -C "$MAIN" merge "$BRANCH"
```

Default merge semantics on purpose: fast-forward when master hasn't moved,
otherwise the usual `Merge branch '<name>'` commit — both shapes exist in the
history.

**On conflict:** `git -C "$MAIN" merge --abort` immediately. Conflicts mean
master advanced (another worktree landed first). Resolve **in the worktree**,
where the dev environment is: `git merge master`, fix conflicts, re-run
`./electron/bin/pre-cm-checks`, commit the resolution, then retry this step — it will
now merge clean. Never leave the main checkout mid-conflict.

## 4. Sync the worktree and confirm

```bash
git merge master   # fast-forwards the branch onto the merge commit
```

Then confirm the invariant before declaring success:
`git rev-parse HEAD master` prints the same hash twice and
`git status --porcelain` is empty in **both** the worktree and `$MAIN`.

Report: the landed commit subject(s), the master hash, and — from
`git -C "$MAIN" status -sb` — how far master is now ahead of `origin/master`
(landing is local; offer a push, don't perform one).
