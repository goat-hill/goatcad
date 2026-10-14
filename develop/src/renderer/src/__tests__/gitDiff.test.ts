import { ref, shallowRef } from 'vue'
import { describe, expect, it } from 'vitest'
import { parsePatch } from '../gitDiff'

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ function boot(): void {
   const a = 1
-  const b = 2
+  const b = 3
+  const c = 4
   return a
`

describe('parsePatch', () => {
  it('numbers both sides of a hunk and keeps git’s scope heading', () => {
    const { hunks, binary, lineCount } = parsePatch(PATCH)

    expect(binary).toBe(false)
    expect(lineCount).toBe(5)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({
      oldStart: 10,
      newStart: 10,
      heading: 'function boot(): void {'
    })
    expect(hunks[0].lines).toEqual([
      { type: 'context', oldNo: 10, newNo: 10, text: '  const a = 1' },
      { type: 'del', oldNo: 11, newNo: null, text: '  const b = 2' },
      { type: 'add', oldNo: null, newNo: 11, text: '  const b = 3' },
      { type: 'add', oldNo: null, newNo: 12, text: '  const c = 4' },
      { type: 'context', oldNo: 12, newNo: 13, text: '  return a' }
    ])
  })

  it('does not read the next file’s ---/+++ header as a change', () => {
    const twoFiles =
      PATCH + `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`

    const { hunks } = parsePatch(twoFiles)

    expect(hunks).toHaveLength(2)
    expect(hunks[1].lines).toEqual([
      { type: 'del', oldNo: 1, newNo: null, text: 'x' },
      { type: 'add', oldNo: null, newNo: 1, text: 'y' }
    ])
  })

  it('numbers neither side for the no-trailing-newline marker', () => {
    const { hunks } = parsePatch(`@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n`)

    expect(hunks[0].lines[1]).toEqual({
      type: 'meta',
      oldNo: null,
      newNo: null,
      text: 'No newline at end of file'
    })
    expect(hunks[0].lines[2]).toMatchObject({ type: 'add', newNo: 1 })
  })

  it('flags a binary difference, which carries no hunks', () => {
    const { binary, hunks } = parsePatch(
      `diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`
    )

    expect(binary).toBe(true)
    expect(hunks).toEqual([])
  })

  it('leaves no phantom row for the patch’s trailing newline', () => {
    const { hunks } = parsePatch(`@@ -1,2 +1,2 @@\n-x\n+y\n z\n`)

    expect(hunks[0].lines).toHaveLength(3)
  })
})

// The Git Diff view sends its scope over IPC on every request, and Electron
// serializes with structured clone — which rejects a Proxy. A plain `ref`
// around an object hands out exactly that, so the view holds its scope in a
// shallowRef. This pins the reason, because the symptom is invisible: the
// request throws, and an empty diff looks identical to an unchanged branch.
describe('scope payloads survive the IPC bridge', () => {
  const scope: GitDiffScope = { kind: 'branch' }

  it('refuses a deeply reactive scope, the way ipcRenderer.invoke does', () => {
    expect(() => structuredClone({ scope: ref(scope).value })).toThrow(/could not be cloned/)
  })

  it('clones the raw object a shallowRef hands back', () => {
    expect(structuredClone({ scope: shallowRef(scope).value })).toEqual({
      scope: { kind: 'branch' }
    })
  })
})
