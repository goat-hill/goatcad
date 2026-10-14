---
title: Git
description: Commit, push and review visual diffs of schematics and boards from GoatCAD's Git panel.
order: 7
---

The **Git** panel in the activity bar works on the project folder's repository. It uses
the `git` installed on your system; without one, the panel says so.

## Setup

- A folder that is not a repository gets an **Initialize repository** button.
- Remotes are added outside GoatCAD, with `git remote add`.
- Sign-in uses your own SSH key or credential helper. GoatCAD stores no credentials.

## Committing

Changed files are listed under **Staged changes** and **Changes**, with **Stage all**,
**Unstage all** and **Discard changes**. Write a message and click **Commit**, or
**Commit all** when nothing is staged. **Pull** and **Push** sync with the remote; a new
branch shows **Publish branch** instead. The branch picker sits at the foot of the
explorer.

## Diffs

Opening a changed file shows its diff as **Text**, side by side or inline. Schematics and
symbol libraries can also be shown **Visual**: the drawing before and after, or both
overlaid with removals drawn in red. A symbol library's diff can list just the symbols
that changed.
