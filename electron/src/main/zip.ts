/**
 * A tiny, dependency-free ZIP writer for the fab-export package
 * (fabrication-export-workstream.md). Most fabs take a single `.zip` upload,
 * so "Export package" bundles the gerber/drill files into one archive.
 *
 * We deliberately do NOT add an archiver npm module (RULES.md §1: never
 * install). Node's standard library already has everything a `.zip` needs —
 * `zlib.deflateRawSync` for the compressed streams and a hand-assembled
 * container (local headers + central directory + end record). Store-format
 * `.zip` is a stable, ~40-year-old spec; this is the whole of it.
 */

import { deflateRawSync } from 'node:zlib'

export interface ZipInput {
  name: string
  content: string
}

/** CRC-32 (IEEE) lookup table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 as ZIP and PNG define it (IEEE 802.3, reflected). */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Build a deflate-compressed ZIP archive from in-memory text entries. */
export function buildZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.content, 'utf8')
    const crc = crc32(data)
    const compressed = deflateRawSync(data)
    const METHOD_DEFLATE = 8

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(0, 10) // mod time (fixed — keeps output deterministic)
    local.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    nameBuf.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0x21, 14) // mod date
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42) // local header offset
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + compressed.length
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0)
  const centralOffset = offset

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // this disk number
  end.writeUInt16LE(0, 6) // central directory start disk
  end.writeUInt16LE(entries.length, 8) // entries on this disk
  end.writeUInt16LE(entries.length, 10) // total entries
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, ...centrals, end])
}
