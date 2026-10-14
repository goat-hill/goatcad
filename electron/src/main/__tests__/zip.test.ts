import { describe, it, expect } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { buildZip } from '../zip'

/** Minimal ZIP reader (central directory walk) to prove the archive is valid. */
function readZip(buf: Buffer): Record<string, string> {
  const eocd = buf.length - 22 // no archive comment
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50)
  const total = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)
  const entries: Record<string, string> = {}
  for (let i = 0; i < total; i++) {
    expect(buf.readUInt32LE(cd)).toBe(0x02014b50)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const localOff = buf.readUInt32LE(cd + 42)
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8')
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const compSize = buf.readUInt32LE(localOff + 18)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    entries[name] = inflateRawSync(comp).toString('utf8')
    cd += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

describe('buildZip', () => {
  it('produces a valid archive that round-trips through inflate', () => {
    const zip = buildZip([
      { name: 'demo.GTL', content: 'G04 top copper*\nM02*\n' },
      { name: 'demo.drl', content: 'M48\nMETRIC\nM30\n' }
    ])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50) // first local header
    const entries = readZip(zip)
    expect(Object.keys(entries).sort()).toEqual(['demo.GTL', 'demo.drl'])
    expect(entries['demo.GTL']).toBe('G04 top copper*\nM02*\n')
    expect(entries['demo.drl']).toBe('M48\nMETRIC\nM30\n')
  })

  it('is deterministic (no timestamps leak in)', () => {
    const a = buildZip([{ name: 'x.txt', content: 'hello world' }])
    const b = buildZip([{ name: 'x.txt', content: 'hello world' }])
    expect(a.equals(b)).toBe(true)
  })

  it('handles an empty set', () => {
    const zip = buildZip([])
    expect(readZip(zip)).toEqual({})
  })
})
