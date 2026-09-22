/**
 * Minimal PNG encoder.
 *
 * The placeholder driver needs to return a real image of the requested size —
 * a 1×1 pixel proves the wire but makes the canvas look broken. Encoding a PNG
 * by hand keeps that driver dependency-free: zlib is in the standard library and
 * a solid gradient compresses to a few kilobytes at any resolution.
 */
import { deflateSync } from 'node:zlib'

/** CRC32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** Compute the PNG CRC of one chunk. */
function crc32(type: string, data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of Buffer.concat([Buffer.from(type, 'latin1'), data])) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Wrap one chunk with its length, type, payload, and CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(type, data), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** Base color for a prompt, chosen so different prompts look different. */
export function colorFor(seed: string): readonly [number, number, number] {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const hue = (hash >>> 0) % 360
  const channel = (offset: number): number => {
    const angle = ((hue + offset) * Math.PI) / 180
    return Math.round(96 + 72 * Math.sin(angle))
  }
  return [channel(0), channel(120), channel(240)]
}

/**
 * Encode a vertical two-tone gradient PNG.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param base - base RGB color.
 * @returns the encoded PNG bytes.
 */
export function gradientPng(width: number, height: number, base: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)

  const row = Buffer.alloc(1 + width * 3)
  const raw = Buffer.alloc((1 + width * 3) * height)
  for (let y = 0; y < height; y += 1) {
    const factor = 1 - (y / Math.max(1, height - 1)) * 0.55
    row[0] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3
      row[offset] = Math.round((base[0] as number) * factor)
      row[offset + 1] = Math.round((base[1] as number) * factor)
      row[offset + 2] = Math.round((base[2] as number) * factor)
    }
    row.copy(raw, y * row.length)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
