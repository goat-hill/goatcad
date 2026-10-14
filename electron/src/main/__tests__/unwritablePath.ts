/**
 * A directory path that cannot be written to, on any platform.
 *
 * A path *inside a regular file* is the portable way to get one: every OS fails
 * it with ENOTDIR, immediately. The two obvious alternatives are both wrong — a
 * merely nonexistent path is created by `mkdirSync(…, { recursive: true })`
 * rather than refused, and a path under `/proc` makes that same call spin
 * forever on Linux instead of failing.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const unwritableDir = (baseDir: string): string => {
  const file = join(baseDir, 'not-a-directory')
  writeFileSync(file, '')
  return join(file, 'nope')
}
