import { describe, expect, test } from 'vitest'
import { classifyRemoteError, pickPushRemote } from '../gitRemote'
import { addedFileDiff, repoRelative } from '../gitContent'
import * as path from 'path'

describe('classifyRemoteError', () => {
  test.each([
    ['fatal: No configured push destination.', 'no-remote'],
    ["fatal: 'origin' does not appear to be a git repository", 'no-remote'],
    ['There is no tracking information for the current branch.', 'no-upstream'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ['Host key verification failed.', 'auth'],
    ['fatal: Not possible to fast-forward, aborting.', 'diverged'],
    [
      ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs',
      'rejected'
    ],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", 'network'],
    ['something else entirely', 'other']
  ])('%s → %s', (message, expected) => {
    expect(classifyRemoteError(message)).toBe(expected)
  })
})

describe('pickPushRemote', () => {
  test('prefers origin, else the only remote, else none', () => {
    expect(pickPushRemote(['upstream', 'origin'])).toBe('origin')
    expect(pickPushRemote(['fork'])).toBe('fork')
    expect(pickPushRemote(['a', 'b'])).toBeNull()
    expect(pickPushRemote([])).toBeNull()
  })
})

describe('addedFileDiff', () => {
  test('adds every line, the trailing newline ending the last', () => {
    expect(addedFileDiff('a/b.txt', 'one\ntwo\n')).toBe(
      'diff --git a/a/b.txt b/a/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a/b.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n'
    )
  })

  test('an empty file has no hunk, a binary one says so', () => {
    expect(addedFileDiff('e', '')).not.toContain('@@')
    expect(addedFileDiff('x.png', 'PNG\0data')).toContain('Binary files')
  })
})

describe('repoRelative', () => {
  const root = path.resolve('/repo')
  test('slash-separated inside the repo, null outside it', () => {
    expect(repoRelative(root, path.join(root, 'hw', 'main.kicad_sch'))).toBe('hw/main.kicad_sch')
    expect(repoRelative(root, path.resolve('/elsewhere/x'))).toBeNull()
    expect(repoRelative(root, root)).toBeNull()
  })
})
