import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  descriptionsFromReadme,
  downloadSample,
  fetchSampleCatalog,
  samplesFromTree
} from '../sampleProjects'

const SHA = 'a'.repeat(40)

describe('descriptionsFromReadme', () => {
  it('reads the project table and drops code ticks', () => {
    const md = [
      '| Project | Description |',
      '|---|---|',
      '| [`bitclock/`](bitclock/) | `canary` — an e-ink desk clock |',
      '| [plain](plain/) | No ticks |'
    ].join('\n')
    expect([...descriptionsFromReadme(md)]).toEqual([
      ['bitclock', 'canary — an e-ink desk clock'],
      ['plain', 'No ticks']
    ])
  })
})

describe('samplesFromTree', () => {
  it('lists top-level folders holding a .kicad_pro, with their size', () => {
    const samples = samplesFromTree(
      [
        { path: 'README.md', type: 'blob', size: 10 },
        { path: 'bitclock', type: 'tree' },
        { path: 'bitclock/canary.kicad_pro', type: 'blob', size: 100 },
        { path: 'bitclock/canary.pretty/x.kicad_mod', type: 'blob', size: 50 },
        { path: 'docs/notes.md', type: 'blob', size: 5 },
        { path: 'deep/nested/x.kicad_pro', type: 'blob', size: 5 },
        { path: '.hidden/x.kicad_pro', type: 'blob', size: 5 }
      ],
      new Map([['bitclock', 'A clock']])
    )
    expect(samples).toEqual([
      { dir: 'bitclock', projectFile: 'canary.kicad_pro', description: 'A clock', bytes: 150 }
    ])
  })

  it('prefers the project named after its folder', () => {
    const [sample] = samplesFromTree(
      [
        { path: 'board/a.kicad_pro', type: 'blob', size: 1 },
        { path: 'board/board.kicad_pro', type: 'blob', size: 1 }
      ],
      new Map()
    )
    expect(sample.projectFile).toBe('board.kicad_pro')
  })
})

const json = (body: unknown): Response => new Response(JSON.stringify(body))

describe('fetchSampleCatalog', () => {
  it('pins the catalog to the branch head and survives a missing README', async () => {
    const result = await fetchSampleCatalog(async (url) => {
      if (url.endsWith('/commits/main')) return json({ sha: SHA })
      if (url.includes(`/git/trees/${SHA}`)) {
        return json({ tree: [{ path: 'b/b.kicad_pro', type: 'blob', size: 3 }] })
      }
      return new Response('', { status: 404 })
    })
    expect(result).toEqual({
      ok: true,
      catalog: {
        sha: SHA,
        samples: [{ dir: 'b', projectFile: 'b.kicad_pro', description: null, bytes: 3 }]
      }
    })
  })

  it('tells offline from rate limited', async () => {
    expect(
      await fetchSampleCatalog(async () => {
        throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
      })
    ).toEqual({ ok: false, error: 'offline' })
    expect(
      await fetchSampleCatalog(
        async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      )
    ).toEqual({ ok: false, error: 'rateLimited' })
  })
})

describe('downloadSample', () => {
  let dir: string
  let archive: Buffer
  const sample = { dir: 'bitclock', projectFile: 'canary.kicad_pro', description: null, bytes: 0 }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'goatcad-samples-'))
    // The shape codeload serves: one `<repo>-<sha>/` folder around the tree.
    const src = join(dir, 'src')
    const top = `goatcad-sample-projects-${SHA}`
    mkdirSync(join(src, top, 'bitclock'), { recursive: true })
    mkdirSync(join(src, top, 'other'), { recursive: true })
    writeFileSync(join(src, top, 'bitclock', 'canary.kicad_pro'), '{}')
    writeFileSync(join(src, top, 'other', 'other.kicad_pro'), '{}')
    writeFileSync(join(src, top, 'README.md'), '#')
    archive = await tar.c({ gzip: true, cwd: src, sync: false }, [top]).concat()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('unpacks only the chosen folder under its commit, and reuses it after', async () => {
    let requests = 0
    const fetch = async (): Promise<Response> => {
      requests++
      return new Response(new Uint8Array(archive))
    }
    const root = join(dir, 'out')
    const result = await downloadSample(fetch, sample, SHA, root)
    const dest = join(root, SHA.slice(0, 12), 'bitclock')
    expect(result).toEqual({
      ok: true,
      projectFilePath: join(dest, 'canary.kicad_pro'),
      path: dest,
      name: 'bitclock'
    })
    expect(readdirSync(join(root, SHA.slice(0, 12)))).toEqual(['bitclock'])
    // No staging folder left behind.
    expect(readdirSync(root)).toEqual([SHA.slice(0, 12)])

    expect(await downloadSample(fetch, sample, SHA, root)).toEqual(result)
    expect(requests).toBe(1)
  })

  it('leaves nothing behind when the download fails', async () => {
    const root = join(dir, 'out')
    const result = await downloadSample(
      async () => new Response('', { status: 500 }),
      sample,
      SHA,
      root
    )
    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(existsSync(join(root, SHA.slice(0, 12), 'bitclock'))).toBe(false)
    expect(readdirSync(root)).toEqual([SHA.slice(0, 12)])
  })

  it('refuses a folder name that is not a plain name', async () => {
    const result = await downloadSample(
      async () => new Response(new Uint8Array(archive)),
      { ...sample, dir: '../escape' },
      SHA,
      join(dir, 'out')
    )
    expect(result).toEqual({ ok: false, error: 'unavailable' })
  })
})
