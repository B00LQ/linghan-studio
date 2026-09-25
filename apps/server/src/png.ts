/**
 * PNG, in both directions.
 *
 * 服务端只用 Node 内置模块（这是这个产品的部署承诺），而 Node 里没有图像库 —— 于是这个
 * 文件手写两件事：
 *
 * - **编**：占位图驱动要回一张真实尺寸的图（1×1 像素能证明线路通，但画布上看起来像坏了），
 *   手写编码 + zlib 就能做到零依赖。
 * - **解 + 缩小**：资产缩略图。收益是量出来的 —— 这台机器上 159 张 PNG 平均 1.28 MB，
 *   资产窗一屏 60 张要拉 68 MB；缩到 320px 长边之后一屏是几百 KB。
 *
 * 覆盖范围与不覆盖的都写清楚：
 * - **支持**：PNG，8/16 位，灰度 / RGB / 灰度+alpha / RGBA，非隔行。ComfyUI 出的图正好都是这些。
 * - **不支持**：调色板、隔行（Adam7）—— 返回 `undefined`，让调用方退回原图，
 *   而不是给一张错的（缩略图错了比没有更糟：人以为图就是这样）。
 * - **JPEG 完全不支持**：那要一整个基线解码器（哈夫曼 + 反量化 + IDCT），是另一件事。
 */
import { deflateSync, inflateSync } from 'node:zlib'

/** A decoded picture: 8-bit channels, tightly packed. */
export interface Raster {
  width: number
  height: number
  /** 3 = RGB，4 = RGBA。 */
  channels: 3 | 4
  /** 长度 = width * height * channels。 */
  data: Buffer
}

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

/** IHDR payload (13 bytes) for an 8-bit picture. */
function ihdr(width: number, height: number, colorType: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(colorType, 9)
  header.writeUInt8(0, 10)
  header.writeUInt8(0, 11)
  header.writeUInt8(0, 12)
  return header
}

/** Assemble a whole PNG file from already-encoded rows. */
function assemble(width: number, height: number, colorType: number, raw: Buffer): Buffer {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr(width, height, colorType)),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Encode a vertical two-tone gradient PNG.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param base - base RGB color.
 * @returns the encoded PNG bytes.
 */
export function gradientPng(width: number, height: number, base: readonly [number, number, number]): Buffer {
  const raw = Buffer.alloc((1 + width * 3) * height)
  for (let y = 0; y < height; y += 1) {
    const factor = 1 - (y / Math.max(1, height - 1)) * 0.55
    const target = y * (1 + width * 3)
    raw[target] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = target + 1 + x * 3
      raw[offset] = Math.round((base[0] as number) * factor)
      raw[offset + 1] = Math.round((base[1] as number) * factor)
      raw[offset + 2] = Math.round((base[2] as number) * factor)
    }
  }
  return assemble(width, height, 2, raw)
}

/** Channels per colorType (palette, type 3, is deliberately absent). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * Decode a PNG.
 * @param bytes - the whole file.
 * @returns the raster, or undefined when this decoder does not handle that flavour.
 */
export function decodePng(bytes: Buffer): Raster | undefined {
  if (bytes.length < 8 + 25 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined
  let offset = 8
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | undefined
  const parts: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1')
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8] ?? 0,
        color: body[9] ?? 0,
        interlace: body[12] ?? 0,
      }
      // 只做 8/16 位、非隔行、非调色板。别的交给调用方退回原图。
      if (header.depth !== 8 && header.depth !== 16) return undefined
      if (header.interlace !== 0) return undefined
      if (CHANNELS[header.color] === undefined) return undefined
    } else if (type === 'IDAT') {
      parts.push(body)
    } else if (type === 'IEND') {
      break
    }
  }
  if (header === undefined || parts.length === 0) return undefined
  const channels = CHANNELS[header.color] as number
  const sampleBytes = header.depth / 8
  const bpp = Math.max(1, channels * sampleBytes)
  const stride = header.width * bpp
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(parts))
  } catch {
    return undefined
  }
  if (raw.length < (stride + 1) * header.height) return undefined

  // 逐行反滤波（五种滤波器），顺手把通道归一化成 8 位 RGB/RGBA。
  const out: 3 | 4 = channels === 2 || channels === 4 ? 4 : 3
  const data = Buffer.alloc(header.width * header.height * out)
  const previous = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[cursor] ?? 0
    cursor += 1
    raw.copy(line, 0, cursor, cursor + stride)
    cursor += stride
    unfilter(filter, line, previous, bpp, stride)
    for (let x = 0; x < header.width; x += 1) {
      const source = x * bpp
      const target = (y * header.width + x) * out
      // 16 位取**高**字节（PNG 是大端，高字节在前）：缩略图不需要那点精度，
      // 取低字节会得到满屏噪点——8 位量化噪声被当成了亮度。
      const at = (channel: number): number => line[source + channel * sampleBytes] ?? 0
      if (channels === 1 || channels === 2) {
        const gray = at(0)
        data[target] = gray
        data[target + 1] = gray
        data[target + 2] = gray
        if (out === 4) data[target + 3] = channels === 2 ? at(1) : 255
      } else {
        data[target] = at(0)
        data[target + 1] = at(1)
        data[target + 2] = at(2)
        if (out === 4) data[target + 3] = at(3)
      }
    }
    line.copy(previous)
  }
  return { width: header.width, height: header.height, channels: out, data }
}

/** Undo one row's filter in place (the five filters PNG defines). */
function unfilter(filter: number, line: Buffer, previous: Buffer, bpp: number, stride: number): void {
  for (let i = 0; i < stride; i += 1) {
    const left = i >= bpp ? (line[i - bpp] ?? 0) : 0
    const up = previous[i] ?? 0
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0
    const value = line[i] ?? 0
    if (filter === 1) line[i] = (value + left) & 0xff
    else if (filter === 2) line[i] = (value + up) & 0xff
    else if (filter === 3) line[i] = (value + Math.floor((left + up) / 2)) & 0xff
    else if (filter === 4) {
      // Paeth
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      line[i] = (value + predictor) & 0xff
    }
  }
}

/**
 * Shrink by an integer block average.
 *
 * 整数倍而不是任意比例：块平均是**真正的下采样**（不是丢像素），实现也短。
 * @param raster - source raster.
 * @param maxDim - 长边上限。
 * @returns the smaller raster (the same one when it already fits).
 */
export function downscale(raster: Raster, maxDim: number): Raster {
  const factor = Math.max(1, Math.ceil(Math.max(raster.width, raster.height) / maxDim))
  if (factor === 1) return raster
  const width = Math.max(1, Math.floor(raster.width / factor))
  const height = Math.max(1, Math.floor(raster.height / factor))
  const { channels } = raster
  const data = Buffer.alloc(width * height * channels)
  const area = factor * factor
  const sum = [0, 0, 0, 0]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sum[0] = 0; sum[1] = 0; sum[2] = 0; sum[3] = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = Math.min(raster.height - 1, y * factor + dy)
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = Math.min(raster.width - 1, x * factor + dx)
          const at = (sy * raster.width + sx) * channels
          for (let c = 0; c < channels; c += 1) sum[c] = (sum[c] ?? 0) + (raster.data[at + c] ?? 0)
        }
      }
      const target = (y * width + x) * channels
      for (let c = 0; c < channels; c += 1) data[target + c] = Math.round((sum[c] ?? 0) / area)
    }
  }
  return { width, height, channels, data }
}

/**
 * Encode a raster as PNG (8-bit, non-interlaced).
 *
 * 每行用 **Up 滤波**（减去上一行）再 deflate：对照片这类渐变内容，压缩率明显好过不滤波，
 * 而它只有几行。缩略图是给人一眼看的，不值得为几个百分点做自适应滤波。
 * @param raster - raster to encode.
 * @returns the whole file.
 */
export function encodePng(raster: Raster): Buffer {
  const { width, height, channels } = raster
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1)
    raw[target] = y === 0 ? 0 : 2
    for (let i = 0; i < stride; i += 1) {
      const value = raster.data[y * stride + i] ?? 0
      const up = y === 0 ? 0 : (raster.data[(y - 1) * stride + i] ?? 0)
      raw[target + 1 + i] = (value - up) & 0xff
    }
  }
  return assemble(width, height, channels === 4 ? 6 : 2, raw)
}

/**
 * A picture → a thumbnail.
 * @param bytes - the original file.
 * @param maxDim - 长边上限。
 * @returns PNG bytes of the thumbnail, or undefined when the format is not supported.
 */
export function thumbnail(bytes: Buffer, maxDim = 320): Buffer | undefined {
  const raster = decodePng(bytes)
  if (raster === undefined) return undefined
  return encodePng(downscale(raster, maxDim))
}
