/**
 * Sample projects, fetched from the sample repo rather than shipped: a folder
 * pushed there shows up in every installed app without a release.
 *
 * Nothing here runs until the user opens the picker — no request is made on
 * launch or on showing the Welcome page. A sample is extracted into the OS temp
 * directory, so trying one needs no save dialog; it lives as long as the OS
 * keeps temp, which is the point of a sample.
 *
 * No git: the catalog is three plain GETs (the branch head, its tree, its
 * README) and the files are the commit's tarball, unpacked with `tar`.
 */
import * as fs from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import * as tar from 'tar'
import type {
  SampleCatalog,
  SampleError,
  SampleListResult,
  SampleOpenResult,
  SampleProject
} from '../preload/sampleTypes'

export const SAMPLE_REPO = 'goat-hill/goatcad-sample-projects'
const SAMPLE_BRANCH = 'main'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** A folder name we will put on disk as-is: no separators, no leading dot. */
const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA = /^[0-9a-f]{40}$/

interface TreeEntry {
  path: string
  type: string
  size?: number
}

/**
 * The README's project table, `| [`dir/`](dir/) | description |`, as
 * dir → description. Optional by design: a folder missing from the table is
 * still a sample, just an undescribed one.
 */
export function descriptionsFromReadme(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  const row = /^\|\s*\[`?([^`\]/]+)\/?`?\]\([^)]*\)\s*\|\s*(.+?)\s*\|\s*$/
  for (const line of markdown.split(/\r?\n/)) {
    const match = row.exec(line)
    if (match) out.set(match[1], match[2].replace(/`/g, ''))
  }
  return out
}

/**
 * Every top-level folder holding a `.kicad_pro` directly. A folder with several
 * prefers the one named after it, as KiCad's own layout would.
 */
export function samplesFromTree(
  entries: TreeEntry[],
  descriptions: Map<string, string>
): SampleProject[] {
  const projects = new Map<string, string[]>()
  const bytes = new Map<string, number>()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    if (parts.length < 2 || !SAFE_DIR.test(parts[0]) || entry.type !== 'blob') continue
    const dir = parts[0]
    bytes.set(dir, (bytes.get(dir) ?? 0) + (entry.size ?? 0))
    if (parts.length === 2 && parts[1].toLowerCase().endsWith('.kicad_pro')) {
      projects.set(dir, [...(projects.get(dir) ?? []), parts[1]])
    }
  }
  return [...projects.entries()]
    .map(([dir, files]) => ({
      dir,
      projectFile:
        files.find((file) => file.toLowerCase() === `${dir.toLowerCase()}.kicad_pro`) ??
        [...files].sort()[0],
      description: descriptions.get(dir) ?? null,
      bytes: bytes.get(dir) ?? 0
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

class SampleFetchError extends Error {
  constructor(readonly kind: SampleError) {
    super(kind)
  }
}

/** GitHub answers an exhausted anonymous quota with 403 (or 429) and a zero remaining count. */
const errorFor = (response: Response): SampleFetchError =>
  new SampleFetchError(
    (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
      ? 'rateLimited'
      : 'unavailable'
  )

async function request(fetch: Fetch, url: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  } catch {
    throw new SampleFetchError('offline')
  }
  if (!response.ok) throw errorFor(response)
  return response
}

const kindOf = (err: unknown): SampleError =>
  err instanceof SampleFetchError ? err.kind : 'unavailable'

export async function fetchSampleCatalog(fetch: Fetch): Promise<SampleListResult> {
  try {
    const api = `https://api.github.com/repos/${SAMPLE_REPO}`
    const head = (await (await request(fetch, `${api}/commits/${SAMPLE_BRANCH}`)).json()) as {
      sha?: unknown
    }
    if (typeof head.sha !== 'string' || !SHA.test(head.sha))
      return { ok: false, error: 'unavailable' }
    const sha = head.sha
    const tree = (await (await request(fetch, `${api}/git/trees/${sha}?recursive=1`)).json()) as {
      tree?: TreeEntry[]
    }
    let descriptions = new Map<string, string>()
    try {
      const readme = await request(
        fetch,
        `https://raw.githubusercontent.com/${SAMPLE_REPO}/${sha}/README.md`
      )
      descriptions = descriptionsFromReadme(await readme.text())
    } catch {
      // Descriptions are decoration; the list stands without them.
    }
    const catalog: SampleCatalog = { sha, samples: samplesFromTree(tree.tree ?? [], descriptions) }
    return { ok: true, catalog }
  } catch (err) {
    return { ok: false, error: kindOf(err) }
  }
}

/**
 * Unpack one sample into `<root>/<sha>/<dir>` and name its project.
 *
 * Keyed by commit so a sample updated upstream lands beside the old copy
 * rather than over edits made to it; the same commit reopens what is already
 * there. The download unpacks into a staging folder and moves into place in
 * one rename, so a failed or interrupted download never leaves a half-sample
 * that the next attempt would mistake for a finished one.
 */
export async function downloadSample(
  fetch: Fetch,
  sample: SampleProject,
  sha: string,
  root: string
): Promise<SampleOpenResult> {
  if (!SAFE_DIR.test(sample.dir) || !SHA.test(sha)) return { ok: false, error: 'unavailable' }
  const dest = join(root, sha.slice(0, 12), sample.dir)
  const projectFilePath = join(dest, sample.projectFile)
  const opened: SampleOpenResult = { ok: true, projectFilePath, path: dest, name: sample.dir }
  if (fs.existsSync(projectFilePath)) return opened

  fs.mkdirSync(join(root, sha.slice(0, 12)), { recursive: true })
  const staging = fs.mkdtempSync(join(root, '.download-'))
  try {
    const response = await request(
      fetch,
      `https://codeload.github.com/${SAMPLE_REPO}/tar.gz/${sha}`
    )
    if (!response.body) return { ok: false, error: 'unavailable' }
    // Archive paths are `<repo>-<sha>/<dir>/…`; the filter sees them before
    // `strip` drops the first segment.
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      tar.x({ cwd: staging, strip: 1, filter: (path) => path.split('/')[1] === sample.dir })
    )
    if (!fs.existsSync(join(staging, sample.dir, sample.projectFile))) {
      return { ok: false, error: 'unavailable' }
    }
    try {
      fs.renameSync(join(staging, sample.dir), dest)
    } catch (err) {
      // Another window finished the same download first.
      if (!fs.existsSync(projectFilePath)) throw err
    }
    return opened
  } catch (err) {
    return { ok: false, error: kindOf(err) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
