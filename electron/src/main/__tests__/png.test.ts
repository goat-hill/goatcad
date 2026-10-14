import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { encodePng } from '../png'
import { crc32 } from '../zip'

/** Walk the chunks the way a decoder would, so the test holds if the encoder
 *  ever splits IDAT or adds a chunk. */
const chunksOf = (png: Buffer): { type: string; data: Buffer }[] => {
  const out: { type: string; data: Buffer }[] = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const data = png.subarray(at + 8, at + 8 + length)
    expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)))
    out.push({ type, data })
    at += 12 + length
  }
  return out
}

describe('encodePng', () => {
  it('writes a PNG a decoder can read back to the pixels given', () => {
    // 2x1: red then blue, as BGRA.
    const bgra = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255])
    const png = encodePng(bgra, 2, 1)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunks = chunksOf(png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const header = chunks[0].data
    expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([2, 1])
    expect([header[8], header[9]]).toEqual([8, 2]) // 8-bit RGB
    const raw = inflateSync(
      Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
    )
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 0, 255]) // filter byte, red, blue
  })
})
