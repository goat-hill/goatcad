import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptingInfo, writePythonClient } from '../agentScripting'
import { registry } from '../ops'
import { unwritableDir } from './unwritablePath'

describe('the client the app writes for itself', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goatcad-scripting-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lands where the snippet says it does', () => {
    // The snippet is what an agent pastes. If it points anywhere but the file
    // that was written, the whole no-install story is a lie.
    writePythonClient(dir)
    const info = scriptingInfo(dir)
    expect(existsSync(info.modulePath)).toBe(true)
    expect(info.snippet).toContain(info.pythonPath)
    expect(info.modulePath.startsWith(info.pythonPath)).toBe(true)
  })

  it('writes a worked example beside the module, pointing at the module', () => {
    writePythonClient(dir)
    const info = scriptingInfo(dir)
    expect(existsSync(info.examplePath)).toBe(true)
    const example = readFileSync(info.examplePath, 'utf8')
    expect(example).toContain(JSON.stringify(info.pythonPath))
    expect(example).toContain('gc.place_beside(')
    expect(example).toContain('gc.schematic.check()')
  })

  it('describes every operation the app actually has', () => {
    writePythonClient(dir)
    expect(scriptingInfo(dir).operationCount).toBe(registry.list().length)
    const source = readFileSync(scriptingInfo(dir).modulePath, 'utf8')
    for (const op of registry.list()) expect(source).toContain(`"${op.name}"`)
  })

  it('leaves the file alone when it would write the same thing', () => {
    // A launch should not touch the mtime of a file somebody may have open in
    // an editor, and rewriting identical bytes is churn with a cost.
    writePythonClient(dir)
    const first = statSync(scriptingInfo(dir).modulePath).mtimeMs
    writePythonClient(dir)
    expect(statSync(scriptingInfo(dir).modulePath).mtimeMs).toBe(first)
  })

  it('rewrites a stale copy rather than trusting it', () => {
    writePythonClient(dir)
    writeFileSync(scriptingInfo(dir).modulePath, '# from an older version\n')
    writePythonClient(dir)
    expect(readFileSync(scriptingInfo(dir).modulePath, 'utf8')).toContain('def connect(')
  })

  it('never throws, however unwritable the directory is', () => {
    // A missing convenience must not be able to stop the app from starting.
    expect(() => writePythonClient(unwritableDir(dir))).not.toThrow()
  })
})
