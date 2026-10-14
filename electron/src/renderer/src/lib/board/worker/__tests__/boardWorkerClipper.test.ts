import { expect, test, vi } from 'vitest'

test('the board worker has Clipper before it reads a board', async () => {
  // Fresh modules: the suite's setup has loaded Clipper into the shared ones.
  vi.resetModules()
  const clip = await import('../../../geometry/clip')
  const { BoardWorkerEngine } = await import('../boardWorkerEngine')
  expect(clip.clipperLoaded()).toBe(false)
  const engine = new BoardWorkerEngine(() => {})
  await engine.handle({
    type: 'load',
    revision: 1,
    text: '(kicad_pcb (version 20240108))',
    ids: new Int32Array([1])
  })
  expect(clip.clipperLoaded()).toBe(true)
})
