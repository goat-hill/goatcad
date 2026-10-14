import { deflateSync } from 'node:zlib'
import { crc32 } from './zip'

/**
 * A dependency-free PNG encoder for rendered pages: tightly packed BGRA rows
 * in, an opaque 8-bit RGB PNG out. Datasheet pages are white with sparse ink,
 * which deflate handles well without a scanline filter.
 */
export function encodePng(bgra: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    let src = y * width * 4
    for (let x = 0; x < width; x++) {
      const dst = row + 1 + x * 3
      raw[dst] = bgra[src + 2]
      raw[dst + 1] = bgra[src + 1]
      raw[dst + 2] = bgra[src]
      src += 4
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
