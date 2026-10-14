/**
 * A worktree's GoatCAD, as GoatHerd's App and Claude buttons reach it.
 *
 * Each worktree's build runs in that worktree's own profile (`electron/bin/goatcad`),
 * so two worktrees' apps never hand off to each other. Its Claude session is pointed
 * at that profile through `GOATCAD_CONFIG_DIR`, which the Python client the app
 * writes there reads first, so a script drives this worktree's app and not another's.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The worktree's `goatcad` command, or null on a branch from before it existed. */
export const goatcadCommand = (worktree: string): string | null => {
  const command = join(worktree, 'electron', 'bin', 'goatcad')
  return existsSync(command) ? command : null
}

/** The profile `bin/goatcad` runs the worktree's app in (its default, not `--shared-profile`). */
export const goatcadProfileDir = (worktree: string): string =>
  join(worktree, '.goatherd', 'goatcad')
