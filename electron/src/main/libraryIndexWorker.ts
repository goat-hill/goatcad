import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { parentPort } from 'worker_threads'
import { extractSymbols, extractFootprint } from './libraryIndexExtract'
import { scanRequest, type BuildRequest, type ScanDeps } from './libraryIndexScan'
import type { IndexLibrary, IndexRecord, ModelRecord } from './libraryIndexTypes'

/** Builds full or incremental library indexes off the main thread. */

const port = parentPort
if (!port) throw new Error('libraryIndexWorker must run as a worker thread')

const deps: ScanDeps = {
  readDir: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory()
      }))
    } catch {
      return []
    }
  },
  mtimeMs: (p) => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
}

function build(req: BuildRequest): {
  records: IndexRecord[]
  manifest: Record<string, number>
  libraries: IndexLibrary[]
} {
  const scan = scanRequest(req, deps)
  const records: IndexRecord[] = []

  const total =
    scan.symbolFiles.length +
    scan.footprintFiles.length +
    scan.modelPackages.reduce((n, p) => n + p.files.length, 0)
  let done = 0
  const tick = (): void => {
    done++
    if (done % 500 === 0 || done === total) port!.postMessage({ type: 'progress', done, total })
  }

  for (const { library, file, scope } of scan.symbolFiles) {
    try {
      records.push(...extractSymbols(readFileSync(file, 'utf8'), { library, file, scope }))
    } catch {
      /* skip unreadable symbol lib */
    }
    tick()
  }

  for (const fp of scan.footprintFiles) {
    try {
      records.push(
        extractFootprint(readFileSync(fp.file, 'utf8'), {
          library: fp.library,
          file: fp.file,
          scope: fp.scope,
          name: fp.file.replace(/^.*[\\/]/, '').replace(/\.kicad_mod$/i, '')
        })
      )
    } catch {
      /* skip unreadable footprint */
    }
    tick()
  }

  for (const pkg of scan.modelPackages) {
    for (const name of pkg.files) {
      const file = join(pkg.dir, name)
      const rec: ModelRecord = {
        type: 'model',
        id: file,
        name,
        library: pkg.pkg,
        scope: pkg.scope,
        file
      }
      records.push(rec)
      tick()
    }
  }

  return { records, manifest: scan.manifest, libraries: scan.libraries }
}

port.on('message', (req: BuildRequest) => {
  try {
    port.postMessage({ type: 'done', ...build(req) })
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
