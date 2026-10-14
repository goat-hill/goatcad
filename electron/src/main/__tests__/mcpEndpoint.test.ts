import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unwritableDir } from './unwritablePath'
import {
  buildEndpoint,
  clearEndpoint,
  endpointPath,
  writeEndpoint,
  type McpEndpointFile
} from '../mcpEndpoint'

describe('the published endpoint', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goatcad-endpoint-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const endpoint = (port = 8788): McpEndpointFile =>
    buildEndpoint(port, '/mcp', '0.0.5', 4242, 1_700_000_000_000)

  it('carries the port that was actually taken, not the one that was asked for', () => {
    // The whole reason the file exists: the app falls back deliberately when
    // 8788 is busy, and a client that assumed the default would miss it.
    expect(endpoint(9001).url).toBe('http://127.0.0.1:9001/mcp')
    expect(endpoint(9001).baseUrl).toBe('http://127.0.0.1:9001')
  })

  it('separates the base from the MCP path, since /v1 hangs off the base', () => {
    const written = endpoint()
    expect(written.url.startsWith(written.baseUrl)).toBe(true)
    expect(`${written.baseUrl}/v1/ops`).toBe('http://127.0.0.1:8788/v1/ops')
  })

  it('names the process, so a stale file is cheap to spot', () => {
    expect(endpoint().pid).toBe(4242)
  })

  it('round-trips as JSON a client can read', () => {
    writeEndpoint(dir, endpoint())
    expect(JSON.parse(readFileSync(endpointPath(dir), 'utf8'))).toEqual(endpoint())
  })

  it('is withdrawn on stop, because its presence is a claim to be listening', () => {
    writeEndpoint(dir, endpoint())
    clearEndpoint(dir)
    expect(existsSync(endpointPath(dir))).toBe(false)
  })

  it('never throws, however unwritable the directory is', () => {
    // A client that cannot find us is degraded; an app that will not start is
    // broken. This must not be able to cause the second.
    const blocked = unwritableDir(dir)
    expect(() => writeEndpoint(blocked, endpoint())).not.toThrow()
    expect(() => clearEndpoint(blocked)).not.toThrow()
  })

  it('is a no-op when there was nothing to withdraw', () => {
    expect(() => clearEndpoint(dir)).not.toThrow()
  })
})
