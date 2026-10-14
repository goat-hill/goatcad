/**
 * Sample projects shared across the process boundary: main fetches the catalog
 * and the files (`src/main/sampleProjects.ts`), the renderer's picker shows
 * them. Lives in preload because both tsconfigs see this directory.
 */

/** One sample: a top-level folder of the sample repo holding a `.kicad_pro`. */
export interface SampleProject {
  /** The folder's name in the repo — also what the sample is called. */
  dir: string
  /** The `.kicad_pro`'s file name inside `dir`. */
  projectFile: string
  /** From the repo README's table, when it lists this folder. */
  description: string | null
  /** Sum of the folder's files, for the size shown before downloading. */
  bytes: number
}

export interface SampleCatalog {
  /** The commit the catalog was read at; the download is pinned to it. */
  sha: string
  samples: SampleProject[]
}

/** `offline`: the request never got an answer. `rateLimited`: GitHub's anonymous API quota. */
export type SampleError = 'offline' | 'rateLimited' | 'unavailable'

export type SampleListResult =
  { ok: true; catalog: SampleCatalog } | { ok: false; error: SampleError }

export type SampleOpenResult =
  | { ok: true; projectFilePath: string; path: string; name: string }
  | { ok: false; error: SampleError }
