/**
 * The Python client, written by the app into its own config directory.
 *
 * This is the answer to "how does the library get installed", and the answer is
 * that it does not: there is no `pip install`, no bundled resource and no build
 * step. `renderPythonClient` runs here, in main, from the live registry, so the
 * file on disk always describes exactly the app that wrote it — which is a
 * stronger guarantee than a published package could give, since a package and an
 * app are versioned separately and drift.
 *
 * It matters because of what "agent-friendly" has to mean. An agent that has to
 * install something before it can write a loop has a setup step, and a setup
 * step is a thing that fails on somebody's machine. Installing GoatCAD is
 * supposed to be the whole of it.
 *
 * A published package is still worth having later for sandboxes that cannot see
 * the user's home directory — but those cannot reach 127.0.0.1 either, so they
 * are a different problem than this one.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registry } from './ops'
import { renderPythonClient } from './ops/pythonClient'
import { PYTHON_BOARD_EXAMPLE, PYTHON_EXAMPLE } from './ops/pythonRuntime'

/** Directory added to `sys.path`; `goatcad.py` sits inside it. */
export const PYTHON_DIR = 'python'
export const PYTHON_MODULE = 'goatcad.py'
/** A worked example beside the module: one block in the house method. */
export const PYTHON_EXAMPLE_FILE = 'example_block.py'
/** The board's: computed placement and tracks as one step, one refill, one check. */
export const PYTHON_BOARD_EXAMPLE_FILE = 'example_board.py'

export interface ScriptingInfo {
  /** The directory to put on `sys.path`. */
  pythonPath: string
  /** The module file itself. */
  modulePath: string
  /** A worked example: one block end to end, ready to copy. */
  examplePath: string
  /** The board's worked example. */
  boardExamplePath: string
  /** Two lines that make it importable, ready to paste. */
  snippet: string
  operationCount: number
}

export const scriptingInfo = (configDir: string): ScriptingInfo => {
  const pythonPath = join(configDir, PYTHON_DIR)
  return {
    pythonPath,
    modulePath: join(pythonPath, PYTHON_MODULE),
    examplePath: join(pythonPath, PYTHON_EXAMPLE_FILE),
    boardExamplePath: join(pythonPath, PYTHON_BOARD_EXAMPLE_FILE),
    snippet: [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(pythonPath)})`,
      'from goatcad import connect',
      '',
      'gc = connect()',
      'print(gc.schematic.describe())'
    ].join('\n'),
    operationCount: registry.list().length
  }
}

/** The example with the real path baked in, as the snippet has it. */
export const renderPythonExample = (pythonPath: string, example = PYTHON_EXAMPLE): string =>
  example.replace('__PYTHON_PATH__', JSON.stringify(pythonPath))

/**
 * Write the client, if it is not already what we would write.
 *
 * Compared before writing so a launch does not touch the mtime of a file
 * somebody may have open, and so a read-only home directory degrades to "the
 * client is stale" rather than to a failed startup. Never throws for the same
 * reason `writeEndpoint` does not: a missing convenience must not be able to
 * stop the app.
 */
export const writePythonClient = (configDir: string): void => {
  try {
    const info = scriptingInfo(configDir)
    const source = renderPythonClient(registry.list(), configDir)
    let existing: string | null = null
    try {
      existing = readFileSync(info.modulePath, 'utf8')
    } catch {
      // Not there yet, which is the ordinary case on a first run.
    }
    const read = (path: string): string | null => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null // Not there yet, the ordinary case on a first run.
      }
    }
    const files: Array<[string, string]> = [
      [info.examplePath, renderPythonExample(info.pythonPath)],
      [info.boardExamplePath, renderPythonExample(info.pythonPath, PYTHON_BOARD_EXAMPLE)]
    ]
    const stale = files.filter(([path, text]) => read(path) !== text)
    if (existing === source && !stale.length) return
    mkdirSync(info.pythonPath, { recursive: true })
    if (existing !== source) writeFileSync(info.modulePath, source, 'utf8')
    for (const [path, text] of stale) writeFileSync(path, text, 'utf8')
  } catch {
    // A client that cannot be written is a degraded experience, not a fatal one.
  }
}
